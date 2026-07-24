"""Expense-splitting engine (pure logic, no Flask).

All money is integer cents. Split amounts are computed once with largest-remainder
rounding (deterministic by user_id) and cached immutably. Settlement:

    1. per-currency net balances:  paid - owed  per user per currency
    2. user supplies FX rates (currency -> plan base currency)
    3. convert each per-currency balance to base cents (Decimal), net across currencies
    4. greedy min-cash-flow (max-debtor / max-creditor) on the base-currency balances

The app NEVER decides exchange rates; they are user-supplied and saved in
``plan_rates`` so settlement is reproducible.
"""
from __future__ import annotations

import heapq
import json
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterable

from .db import get_db

CENT = Decimal("0.01")

# ---------------------------------------------------------------- split math


def _largest_remainder(amounts: dict[int, Decimal], total_cents: int) -> dict[int, int]:
    """Distribute ``total_cents`` across users by fractional allocation, rounding
    down then distributing the leftover cents to the largest fractional remainders.
    Ties broken by user_id (stable, deterministic)."""
    truncated = {uid: int(v) for uid, v in amounts.items()}
    remainder = total_cents - sum(truncated.values())
    # Distribute leftover cents to the largest fractional remainders; ties by uid asc.
    order = sorted(amounts, key=lambda uid: (float(amounts[uid]) - truncated[uid], uid), reverse=True)
    i = 0
    while remainder > 0:
        truncated[order[i % len(order)]] += 1
        remainder -= 1
        i += 1
    return truncated


def compute_equal_splits(total_cents: int, user_ids: Iterable[int]) -> dict[int, int]:
    ids = sorted(set(user_ids))
    n = len(ids)
    if n == 0:
        return {}
    base = total_cents // n
    out = {uid: base for uid in ids}
    remainder = total_cents - base * n
    for i, uid in enumerate(ids):
        if i < remainder:
            out[uid] += 1
    return out


def compute_exact_splits(total_cents: int, exact: list[tuple[int, int]]) -> dict[int, int]:
    """``exact`` is [(user_id, cents_owed), ...]; sum must equal total_cents."""
    owed = {uid: c for uid, c in exact}
    if sum(owed.values()) != total_cents:
        raise ValueError("EXACT split amounts do not sum to total")
    return owed


def compute_percentage_splits(total_cents: int,
                              percentages: list[tuple[int, int]]) -> dict[int, int]:
    """``percentages`` is [(user_id, basis_points)]; 10000 = 100%."""
    total_bp = sum(bp for _, bp in percentages)
    if total_bp != 10000:
        raise ValueError(f"Percentages must sum to 10000 bp, got {total_bp}")
    amounts = {uid: Decimal(total_cents) * Decimal(bp) / Decimal(10000)
               for uid, bp in percentages}
    return _largest_remainder(amounts, total_cents)


def compute_shares_splits(total_cents: int, shares: list[tuple[int, int]]) -> dict[int, int]:
    """``shares`` is [(user_id, share_count), ...]."""
    total_sh = sum(s for _, s in shares)
    if total_sh <= 0:
        raise ValueError("Total shares must be positive")
    amounts = {uid: Decimal(total_cents) * Decimal(s) / Decimal(total_sh)
               for uid, s in shares}
    return _largest_remainder(amounts, total_cents)


SPLIT_COMPUTERS = {
    "EQUAL": lambda total, data: compute_equal_splits(total, data),
    "EXACT": lambda total, data: compute_exact_splits(total, data),
    "PERCENTAGE": lambda total, data: compute_percentage_splits(total, data),
    "SHARES": lambda total, data: compute_shares_splits(total, data),
}


def compute_splits(total_cents: int, method: str, data) -> dict[int, int]:
    return SPLIT_COMPUTERS[method](total_cents, data)


# ---------------------------------------------------------------- create

def create_expense(plan_id: int, description: str, currency: str, total_cents: int,
                   split_method: str, payers: list[tuple[int, int]], split_data,
                   *, item_id: int | None = None, created_by: int | None = None,
                   decimals: int = 2) -> int:
    """Insert an expense + payers + splits in one transaction. Returns expense id.

    ``payers``: [(user_id, paid_cents), ...]; sum must equal total_cents.
    ``split_data`` shape depends on method (see SPLIT_COMPUTERS).
    """
    if total_cents <= 0:
        raise ValueError("total must be positive")
    if sum(p for _, p in payers) != total_cents:
        raise ValueError("payer amounts do not sum to total")

    owed = compute_splits(total_cents, split_method, split_data)
    db = get_db()
    try:
        cur = db.execute(
            """INSERT INTO expenses
               (plan_id, item_id, description, currency, decimals, total_cents,
                split_method, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (plan_id, item_id, description, currency, decimals, total_cents,
             split_method, created_by),
        )
        expense_id = cur.lastrowid
        for uid, paid in payers:
            db.execute(
                "INSERT OR IGNORE INTO expense_payers (expense_id, user_id, paid_cents) VALUES (?, ?, ?)",
                (expense_id, uid, paid),
            )
        for uid, cents in owed.items():
            value_cents = None
            value_denom = None
            if split_method == "EXACT":
                value_cents = cents
            elif split_method == "PERCENTAGE":
                value_denom = next(bp for u, bp in split_data if u == uid)
            elif split_method == "SHARES":
                value_denom = next(s for u, s in split_data if u == uid)
            db.execute(
                """INSERT INTO expense_splits
                   (expense_id, user_id, value_cents, value_denom, owed_cents)
                   VALUES (?, ?, ?, ?, ?)""",
                (expense_id, uid, value_cents, value_denom, cents),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return expense_id


def update_expense(expense_id: int, description: str, currency: str, total_cents: int,
                   split_method: str, payers: list[tuple[int, int]], split_data,
                   *, item_id: int | None = None, decimals: int = 2) -> None:
    """Replace an existing expense's fields, payers, and splits."""
    if total_cents <= 0:
        raise ValueError("total must be positive")
    if sum(p for _, p in payers) != total_cents:
        raise ValueError("payer amounts do not sum to total")
    owed = compute_splits(total_cents, split_method, split_data)
    db = get_db()
    try:
        db.execute(
            """UPDATE expenses SET description=?, currency=?, decimals=?, total_cents=?,
               split_method=?, item_id=? WHERE id=?""",
            (description, currency, decimals, total_cents, split_method, item_id, expense_id),
        )
        db.execute("DELETE FROM expense_payers WHERE expense_id=?", (expense_id,))
        db.execute("DELETE FROM expense_splits WHERE expense_id=?", (expense_id,))
        for uid, paid in payers:
            db.execute(
                "INSERT INTO expense_payers (expense_id, user_id, paid_cents) VALUES (?, ?, ?)",
                (expense_id, uid, paid),
            )
        for uid, cents in owed.items():
            value_cents = None
            value_denom = None
            if split_method == "EXACT":
                value_cents = cents
            elif split_method == "PERCENTAGE":
                value_denom = next(bp for u, bp in split_data if u == uid)
            elif split_method == "SHARES":
                value_denom = next(s for u, s in split_data if u == uid)
            db.execute(
                "INSERT INTO expense_splits (expense_id, user_id, value_cents, value_denom, owed_cents) "
                "VALUES (?, ?, ?, ?, ?)",
                (expense_id, uid, value_cents, value_denom, cents),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise


# ---------------------------------------------------------------- balances

def per_currency_balances(plan_id: int) -> dict[str, dict[int, int]]:
    """Return {currency: {user_id: net_cents}}. Positive = creditor."""
    db = get_db()
    paid = db.execute(
        """SELECT e.currency, ep.user_id, SUM(ep.paid_cents) AS s
           FROM expense_payers ep JOIN expenses e ON e.id = ep.expense_id
           WHERE e.plan_id = ? GROUP BY e.currency, ep.user_id""",
        (plan_id,),
    ).fetchall()
    owed = db.execute(
        """SELECT e.currency, es.user_id, SUM(es.owed_cents) AS s
           FROM expense_splits es JOIN expenses e ON e.id = es.expense_id
           WHERE e.plan_id = ? GROUP BY e.currency, es.user_id""",
        (plan_id,),
    ).fetchall()
    out: dict[str, dict[int, int]] = defaultdict(dict)
    for r in paid:
        out[r["currency"]][r["user_id"]] = out[r["currency"]].get(r["user_id"], 0) + r["s"]
    for r in owed:
        out[r["currency"]][r["user_id"]] = out[r["currency"]].get(r["user_id"], 0) - r["s"]
    return {c: dict(v) for c, v in out.items()}


def currencies_in_plan(plan_id: int) -> list[str]:
    db = get_db()
    rows = db.execute(
        "SELECT DISTINCT currency FROM expenses WHERE plan_id = ?", (plan_id,)
    ).fetchall()
    return sorted(r["currency"] for r in rows)


def settle_debts(net_balances: dict[int, int]) -> list[dict]:
    """Greedy max-debtor/max-creditor. Returns [{from, to, amount_cents}]."""
    debtors, creditors = [], []  # heaps of (-|amt|, uid)
    for uid, bal in net_balances.items():
        if bal < 0:
            heapq.heappush(debtors, (bal, uid))
        elif bal > 0:
            heapq.heappush(creditors, (-bal, uid))
    out = []
    while debtors and creditors:
        d_amt, debtor = heapq.heappop(debtors)          # negative
        neg_c, creditor = heapq.heappop(creditors)      # negative of positive
        d_amt, c_amt = -d_amt, -neg_c
        transfer = min(d_amt, c_amt)
        out.append({"from": debtor, "to": creditor, "amount_cents": transfer})
        d_amt -= transfer
        c_amt -= transfer
        if d_amt > 0:
            heapq.heappush(debtors, (-d_amt, debtor))
        if c_amt > 0:
            heapq.heappush(creditors, (-c_amt, creditor))
    return out


def _currency_decimals(cur: str) -> int:
    return 0 if cur in ('JPY', 'KRW') else 2

def convert_to_base(per_currency: dict[str, dict[int, int]],
                    rates: dict[str, float],
                    base_currency: str) -> tuple[dict[int, int], list[str]]:
    """Convert per-currency balances to base-currency cents (Decimal).

    Returns (base_balances, missing_currencies)."""
    base: dict[int, int] = defaultdict(int)
    missing = []
    base_decimals = _currency_decimals(base_currency)
    for currency, usermap in per_currency.items():
        if currency == base_currency:
            rate = Decimal("1")
        elif currency in rates:
            rate = Decimal(str(rates[currency]))
        else:
            missing.append(currency)
            continue
        exp_decimals = _currency_decimals(currency)
        for uid, cents in usermap.items():
            exp_major = Decimal(cents) / Decimal(10 ** exp_decimals)
            base_major = exp_major * rate
            converted = (base_major * Decimal(10 ** base_decimals)).quantize(CENT, rounding=ROUND_HALF_UP)
            base[uid] += int(converted)
    return dict(base), missing


def recorded_payments_base(plan_id: int, rates: dict[str, float],
                           base_currency: str) -> dict[int, int]:
    """Net effect of recorded payments in base-currency cents per user."""
    db = get_db()
    rows = db.execute(
        "SELECT * FROM payments WHERE plan_id = ?", (plan_id,)
    ).fetchall()
    base_decimals = _currency_decimals(base_currency)
    net: dict[int, int] = defaultdict(int)
    for r in rows:
        if r["currency"] == base_currency:
            rate = Decimal("1")
        else:
            rate = Decimal(str(rates.get(r["currency"], 0)))
        exp_decimals = _currency_decimals(r["currency"])
        exp_major = Decimal(r["amount_cents"]) / Decimal(10 ** exp_decimals)
        base_major = exp_major * rate
        amt = int((base_major * Decimal(10 ** base_decimals)).quantize(CENT, rounding=ROUND_HALF_UP))
        # A recorded payment settles debt: the payer's debt decreases (balance
        # rises toward 0), the payee's credit decreases. balance>0 = creditor.
        net[r["from_user_id"]] += amt
        net[r["to_user_id"]] -= amt
    return dict(net)


def _convert_balances(balances: dict[int, int],
                      from_currency: str,
                      to_currency: str,
                      rates: dict[str, float]) -> dict[int, int]:
    """Convert a {user_id: cents} dict from one currency to another.
    rates[CURR] = amount of base_currency per 1 CURR (major unit)."""
    if to_currency == from_currency or not balances:
        return dict(balances)
    from_dec = _currency_decimals(from_currency)
    to_dec = _currency_decimals(to_currency)
    rate = Decimal(str(rates[to_currency]))
    result = {}
    for uid, cents in balances.items():
        from_major = Decimal(cents) / Decimal(10 ** from_dec)
        to_major = from_major / rate
        converted = int((to_major * Decimal(10 ** to_dec)).quantize(CENT, rounding=ROUND_HALF_UP))
        result[uid] = converted
    return result


def _recorded_payments_by_currency(plan_id: int) -> dict[str, dict[int, int]]:
    """Net effect of recorded payments per currency.
    Returns {currency: {user_id: net_cents}}."""
    db = get_db()
    rows = db.execute(
        "SELECT * FROM payments WHERE plan_id = ?", (plan_id,)
    ).fetchall()
    net: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for r in rows:
        cur = r["currency"]
        net[cur][r["from_user_id"]] += r["amount_cents"]
        net[cur][r["to_user_id"]] -= r["amount_cents"]
    return {cur: dict(v) for cur, v in net.items()}


def _per_currency_settlement(plan_id: int,
                              per_cur: dict[str, dict[int, int]],
                              rates: dict[str, float],
                              currencies: list[str],
                              missing: list[str],
                              users: dict[int, str],
                              base_currency: str) -> dict:
    """Settlement view per original currency (no FX conversion needed)."""
    payment_effects = _recorded_payments_by_currency(plan_id)

    per_currency_result = {}
    for cur in sorted(per_cur.keys()):
        balances = per_cur[cur]
        pay = payment_effects.get(cur, {})

        proposed = settle_debts(balances)

        remaining = {}
        for uid in set(balances) | set(pay):
            v = balances.get(uid, 0) + pay.get(uid, 0)
            if v != 0:
                remaining[uid] = v

        per_currency_result[cur] = {
            "currency": cur,
            "decimals": _currency_decimals(cur),
            "balances": [{"user_id": uid, "username": users.get(uid, str(uid)),
                          "balance_cents": v} for uid, v in sorted(balances.items())],
            "proposed_settlement": [
                {"from": s["from"], "from_name": users.get(s["from"], str(s["from"])),
                 "to": s["to"], "to_name": users.get(s["to"], str(s["to"])),
                 "amount_cents": s["amount_cents"]} for s in proposed
            ],
            "remaining_balances": [{"user_id": uid, "username": users.get(uid, str(uid)),
                                    "balance_cents": v} for uid, v in sorted(remaining.items())],
        }

    return {
        "mode": "per_currency",
        "base_currency": base_currency,
        "settlement_currency": None,
        "currencies_present": currencies,
        "rates": rates,
        "missing_currencies": missing,
        "per_currency": per_currency_result,
    }


def plan_settlement(plan_id: int,
                    mode: str = "single",
                    settlement_currency: str | None = None) -> dict:
    """Full settlement view: balances, who-owes-whom, recorded payments, gaps.

    * ``mode="single"`` (default): convert all balances to a single settlement
      currency (defaults to plan base_currency) and produce one settlement.
    * ``mode="per_currency"``: settle each currency independently without FX
      conversion.
    """
    db = get_db()
    plan = db.execute("SELECT base_currency FROM plans WHERE id = ?", (plan_id,)).fetchone()
    base_currency = plan["base_currency"] if plan else "USD"
    rates = {r["currency"]: r["rate"] for r in db.execute(
        "SELECT currency, rate FROM plan_rates WHERE plan_id = ?", (plan_id,)
    ).fetchall()}

    per_cur = per_currency_balances(plan_id)
    currencies = sorted(set(per_cur.keys()) | set(rates.keys()))
    missing = [c for c in currencies if c != base_currency and c not in rates]

    users = {u["id"]: u["username"] for u in db.execute(
        """SELECT u.id, u.username FROM users u
           JOIN plan_members pm ON pm.user_id = u.id AND pm.plan_id = ?
           UNION
           SELECT u.id, u.username FROM users u
           JOIN plans p ON p.owner_id = u.id AND p.id = ?""",
        (plan_id, plan_id)
    ).fetchall()}

    if mode == "per_currency":
        return _per_currency_settlement(plan_id, per_cur, rates, currencies, missing, users, base_currency)

    # ---- single-currency mode ----
    cur = (settlement_currency or base_currency).upper()
    if cur not in rates and cur != base_currency:
        missing.append(cur)
        cur = base_currency

    base_balances, _ = convert_to_base(per_cur, rates, base_currency)

    if cur == base_currency:
        settle_balances = base_balances
    else:
        settle_balances = _convert_balances(base_balances, base_currency, cur, rates)

    proposed = settle_debts(settle_balances)
    paid_base = recorded_payments_base(plan_id, rates, base_currency)

    if cur != base_currency:
        paid_eff = _convert_balances(paid_base, base_currency, cur, rates)
    else:
        paid_eff = paid_base

    remaining = {uid: settle_balances.get(uid, 0) + paid_eff.get(uid, 0)
                 for uid in set(settle_balances) | set(paid_eff)}
    remaining = {uid: v for uid, v in remaining.items() if v != 0}

    return {
        "mode": "single",
        "settlement_currency": cur,
        "base_currency": base_currency,
        "currencies_present": currencies,
        "rates": rates,
        "missing_currencies": missing,
        "balances_base": [{"user_id": uid, "username": users.get(uid, str(uid)),
                            "balance_cents": v} for uid, v in sorted(settle_balances.items())],
        "proposed_settlement": [
            {"from": s["from"], "from_name": users.get(s["from"], str(s["from"])),
             "to": s["to"], "to_name": users.get(s["to"], str(s["to"])),
             "amount_cents": s["amount_cents"]} for s in proposed
        ],
        "remaining_balances": [{"user_id": uid, "username": users.get(uid, str(uid)),
                                "balance_cents": v} for uid, v in sorted(remaining.items())],
    }


# ---------------------------------------------------------------- self-test

def _self_test() -> None:
    checks = []

    def eq(actual, expected, name):
        checks.append((name, actual == expected))
        if actual != expected:
            print(f"  FAIL {name}: {actual} != {expected}")
        else:
            print(f"  ok   {name}: {actual}")

    eq(list(compute_equal_splits(100, [1, 2, 3]).values()), [34, 33, 33],
       "equal $1.00 / 3 -> [34,33,33] (ids 1,2,3 get remainder)")
    eq(sorted(compute_equal_splits(2, [1, 2, 3]).values()), [0, 1, 1],
       "equal $0.02 / 3 -> two 1s and a 0")
    eq(sorted(compute_percentage_splits(
        10000, [(1, 3333), (2, 3333), (3, 3334)]).values()), [3333, 3333, 3334],
       "percentage 33.33/33.33/33.34 of $100")
    eq(sorted(compute_shares_splits(
        10000, [(1, 2), (2, 1), (3, 1)]).values()), [2500, 2500, 5000],
       "shares [2,1,1] of $100 -> 50/25/25")
    eq(sorted(compute_exact_splits(100, [(1, 30), (2, 70)]).values()), [30, 70],
       "exact 30/70")

    settle = settle_debts({1: 100, 2: -30, 3: -70})
    got = {(s["from"], s["to"]): s["amount_cents"] for s in settle}
    eq(got, {(2, 1): 30, (3, 1): 70}, "settle {A+100,B-30,C-70}")

    settle2 = settle_debts({1: 50, 2: -10, 3: -40})
    got2 = {(s["from"], s["to"]): s["amount_cents"] for s in settle2}
    eq(got2, {(2, 1): 10, (3, 1): 40}, "settle largest-debtor first")

    # multi-currency: $100 USD (10,000 cents) + ¥10000 JPY (minor units),
    # each 50/50, paid by A.  per-currency balances in minor units:
    #   USD {A:+5000, B:-5000},  JPY {A:+5000, B:-5000}
    # rates USD->1.0, JPY->0.0067 -> base(USD)
    #   JPY: ¥5000 × 0.0067 = $33.50 = 3350¢  →  A:5000+3350=8350  B:-5000-3350=-8350
    per_cur = {"USD": {1: 5000, 2: -5000}, "JPY": {1: 5000, 2: -5000}}
    base, missing = convert_to_base(per_cur, {"USD": 1.0, "JPY": 0.0067}, "USD")
    eq(missing, [], "multi-currency no missing rates")
    eq(base, {1: 8350, 2: -8350}, "multi-currency cross-net in USD cents")

    failed = [n for n, ok in checks if not ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} passed")
    if failed:
        raise SystemExit(f"SELF-TEST FAILED: {failed}")


if __name__ == "__main__":
    _self_test()