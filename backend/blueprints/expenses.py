"""Expenses blueprint: per-item expense ledger + multi-currency settlement.

API (all plan-scoped routes require owner/shared access; write routes block viewers):
  GET/POST /api/plans/<id>/expenses
  DELETE   /api/expenses/<id>
  GET      /api/plans/<id>/expenses/by-item
  GET/POST /api/plans/<id>/rates
  GET      /api/plans/<id>/settlement
  GET/POST /api/plans/<id>/payments
  DELETE   /api/payments/<id>
"""
from __future__ import annotations

from flask import Blueprint, request, g, abort, jsonify

from ..auth import plan_access, login_required, check_item_access, check_expense_access, check_payment_access
from ..db import get_db
from ..util import parse_amount_to_cents, format_cents, check_version
from .. import expense as ex

expenses_bp = Blueprint("expenses", __name__)

VALID_METHODS = {"EQUAL", "EXACT", "PERCENTAGE", "SHARES"}


def _serialize_expense(eid) -> dict:
    db = get_db()
    e = dict(db.execute("SELECT * FROM expenses WHERE id = ?", (eid,)).fetchone())
    e["payers"] = [dict(r) for r in db.execute(
        "SELECT user_id, paid_cents FROM expense_payers WHERE expense_id = ?", (eid,)).fetchall()]
    e["splits"] = [dict(r) for r in db.execute(
        "SELECT user_id, value_cents, value_denom, owed_cents FROM expense_splits WHERE expense_id = ?",
        (eid,)).fetchall()]
    return e


@expenses_bp.route("/api/plans/<int:plan_id>/expenses")
@plan_access()
def list_expenses(plan_id):
    db = get_db()
    rows = db.execute(
        "SELECT id FROM expenses WHERE plan_id = ? ORDER BY created_at DESC", (plan_id,)).fetchall()
    return jsonify({"expenses": [_serialize_expense(r["id"]) for r in rows]})


@expenses_bp.route("/api/plans/<int:plan_id>/expenses", methods=["POST"])
@plan_access(write=True)
def create_expense(plan_id):
    if g.plan_role == "viewer":
        abort(403)
    data = request.get_json(force=True, silent=True) or {}
    description = (data.get("description") or "").strip()
    currency = (data.get("currency") or g.plan["base_currency"]).upper()
    decimals = int(data.get("decimals", 2 if currency not in ("JPY", "KRW") else 0))
    try:
        total_cents = parse_amount_to_cents(data.get("amount", data.get("total_cents")), decimals)
    except (ValueError, TypeError, ArithmeticError):
        return jsonify({"error": "invalid amount"}), 400
    method = (data.get("split_method") or "EQUAL").upper()
    if method not in VALID_METHODS:
        return jsonify({"error": "invalid split_method"}), 400
    payers = data.get("payers") or []
    if not isinstance(payers, list) or not payers:
        return jsonify({"error": "payers required"}), 400
    try:
        payers = [(int(p["user_id"]), parse_amount_to_cents(p.get("amount", p.get("paid_cents")), decimals))
                  for p in payers]
    except (ValueError, TypeError, KeyError):
        return jsonify({"error": "invalid payers"}), 400

    participants = data.get("participants") or [p[0] for p in payers]
    split_data = data.get("split_data")

    # Normalize split_data per method.
    if method == "EQUAL":
        if not isinstance(participants, list) or not participants:
            return jsonify({"error": "participants required for EQUAL split"}), 400
        sd = [int(u) for u in participants]
    elif method == "EXACT":
        sd = [(int(p["user_id"]), parse_amount_to_cents(p.get("amount", p.get("value_cents")), decimals))
              for p in (split_data or [])]
    elif method == "PERCENTAGE":
        sd = [(int(p["user_id"]), int(round(float(p["percent"]) * 100))) for p in (split_data or [])]
    elif method == "SHARES":
        sd = [(int(p["user_id"]), int(p["shares"])) for p in (split_data or [])]
    else:
        return jsonify({"error": "invalid method"}), 400

    try:
        eid = ex.create_expense(
            plan_id, description, currency, total_cents, method, payers, sd,
            item_id=data.get("item_id"), created_by=g.current_user["id"], decimals=decimals)
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    return jsonify({"expense": _serialize_expense(eid)})


@expenses_bp.route("/api/items/<int:item_id>/expenses")
@login_required
def item_expenses(item_id):
    """Expenses for a specific item."""
    check_item_access(item_id)
    db = get_db()
    rows = db.execute(
        "SELECT id FROM expenses WHERE item_id = ? ORDER BY created_at DESC", (item_id,)).fetchall()
    return jsonify({"expenses": [_serialize_expense(r["id"]) for r in rows]})


@expenses_bp.route("/api/expenses/<int:expense_id>", methods=["PATCH"])
@login_required
def update_expense(expense_id):
    """Update an existing expense (full replace body, same schema as create)."""
    check_expense_access(expense_id, write=True)
    data = request.get_json(force=True, silent=True) or {}
    from ..db import get_db
    row = get_db().execute("SELECT * FROM expenses WHERE id = ?", (expense_id,)).fetchone()
    conflict = check_version(dict(row) if row else None, data)
    if conflict:
        return jsonify(conflict), 409
    description = (data.get("description") or "").strip()
    currency = (data.get("currency") or "USD").upper()
    decimals = int(data.get("decimals", 2 if currency not in ("JPY", "KRW") else 0))
    try:
        total_cents = parse_amount_to_cents(data.get("amount", data.get("total_cents")), decimals)
    except (ValueError, TypeError, ArithmeticError):
        return jsonify({"error": "invalid amount"}), 400
    method = (data.get("split_method") or "EQUAL").upper()
    if method not in VALID_METHODS:
        return jsonify({"error": "invalid split_method"}), 400
    payers = data.get("payers") or []
    if not isinstance(payers, list) or not payers:
        return jsonify({"error": "payers required"}), 400
    try:
        payers = [(int(p["user_id"]), parse_amount_to_cents(p.get("amount", p.get("paid_cents")), decimals))
                  for p in payers]
    except (ValueError, TypeError, KeyError):
        return jsonify({"error": "invalid payers"}), 400

    participants = data.get("participants") or [p[0] for p in payers]
    split_data = data.get("split_data")

    if method == "EQUAL":
        if not isinstance(participants, list) or not participants:
            return jsonify({"error": "participants required for EQUAL split"}), 400
        sd = [int(u) for u in participants]
    elif method == "EXACT":
        sd = [(int(p["user_id"]), parse_amount_to_cents(p.get("amount", p.get("value_cents")), decimals))
              for p in (split_data or [])]
    elif method == "PERCENTAGE":
        sd = [(int(p["user_id"]), int(round(float(p["percent"]) * 100))) for p in (split_data or [])]
    elif method == "SHARES":
        sd = [(int(p["user_id"]), int(p["shares"])) for p in (split_data or [])]
    else:
        return jsonify({"error": "invalid method"}), 400

    try:
        ex.update_expense(expense_id, description, currency, total_cents, method, payers, sd,
                          item_id=data.get("item_id"), decimals=decimals)
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    return jsonify({"expense": _serialize_expense(expense_id)})


@expenses_bp.route("/api/expenses/<int:expense_id>", methods=["DELETE"])
@login_required
def delete_expense(expense_id):
    check_expense_access(expense_id, write=True)
    db = get_db()
    db.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
    db.commit()
    return jsonify({"deleted": expense_id})


@expenses_bp.route("/api/plans/<int:plan_id>/expenses/by-item")
@plan_access()
def expenses_by_item(plan_id):
    """Per-item totals: [{item_id, item_title, item_type, expense_count,
       total_by_currency: {currency: cents}, grand_total_base_cents}] using saved rates."""
    db = get_db()
    rates = {r["currency"]: r["rate"] for r in db.execute(
        "SELECT currency, rate FROM plan_rates WHERE plan_id = ?", (plan_id,)).fetchall()}
    base = g.plan["base_currency"]
    rows = db.execute(
        """SELECT i.id AS item_id, i.title, i.item_type, e.currency, e.decimals,
                  SUM(e.total_cents) AS total
           FROM expenses e JOIN items i ON i.id = e.item_id
           WHERE e.plan_id = ? GROUP BY i.id, e.currency ORDER BY i.item_date, i.id""",
        (plan_id,)).fetchall()
    def _base_decimals(cur):
        return 0 if cur in ('JPY', 'KRW') else 2
    items_map: dict[int, dict] = {}
    from decimal import Decimal
    for r in rows:
        cur = r["currency"]
        rate = Decimal(str(rates[cur])) if cur in rates else (Decimal(1) if cur == base else None)
        if rate is not None:
            exp_major = Decimal(r["total"]) / Decimal(10 ** r["decimals"])
            base_major = exp_major * rate
            base_cents = int((base_major * Decimal(10 ** _base_decimals(base))).quantize(Decimal(1)))
        else:
            base_cents = None
        it = items_map.setdefault(r["item_id"], {
            "item_id": r["item_id"], "title": r["title"], "item_type": r["item_type"],
            "total_by_currency": {}, "grand_total_base_cents": 0, "has_missing_rate": False})
        it["total_by_currency"][cur] = it["total_by_currency"].get(cur, 0) + r["total"]
        if base_cents is None:
            it["has_missing_rate"] = True
        else:
            it["grand_total_base_cents"] += base_cents
    return jsonify({"items": list(items_map.values())})


@expenses_bp.route("/api/plans/<int:plan_id>/rates")
@plan_access()
def get_rates(plan_id):
    db = get_db()
    rates = {r["currency"]: r["rate"] for r in db.execute(
        "SELECT currency, rate FROM plan_rates WHERE plan_id = ?", (plan_id,)).fetchall()}
    return jsonify({"base_currency": g.plan["base_currency"], "rates": rates})


@expenses_bp.route("/api/plans/<int:plan_id>/rates", methods=["POST"])
@plan_access(write=True)
def set_rates(plan_id):
    if g.plan_role == "viewer":
        abort(403)
    data = request.get_json(force=True, silent=True) or {}
    rates = data.get("rates") or {}
    if not isinstance(rates, dict):
        return jsonify({"error": "rates must be a map"}), 400
    db = get_db()
    for cur, rate in rates.items():
        try:
            r = float(rate)
        except (ValueError, TypeError):
            return jsonify({"error": f"invalid rate for {cur}"}), 400
        db.execute(
            """INSERT INTO plan_rates (plan_id, currency, rate, updated_at)
               VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(plan_id, currency) DO UPDATE SET rate=excluded.rate, updated_at=datetime('now')""",
            (plan_id, cur.upper(), r))
    db.commit()
    return jsonify({"base_currency": g.plan["base_currency"], "rates": rates})


@expenses_bp.route("/api/plans/<int:plan_id>/settlement")
@plan_access()
def settlement(plan_id):
    mode = request.args.get("mode", "single")
    currency = request.args.get("currency") or None
    return jsonify(ex.plan_settlement(plan_id, mode=mode, settlement_currency=currency))


@expenses_bp.route("/api/plans/<int:plan_id>/payments")
@plan_access()
def list_payments(plan_id):
    db = get_db()
    rows = [dict(r) for r in db.execute(
        """SELECT p.*, u1.username AS from_name, u2.username AS to_name
           FROM payments p
           JOIN users u1 ON u1.id = p.from_user_id
           JOIN users u2 ON u2.id = p.to_user_id
           WHERE p.plan_id = ? ORDER BY p.created_at DESC""", (plan_id,)).fetchall()]
    return jsonify({"payments": rows})


@expenses_bp.route("/api/plans/<int:plan_id>/payments", methods=["POST"])
@plan_access(write=True)
def record_payment(plan_id):
    if g.plan_role == "viewer":
        abort(403)
    data = request.get_json(force=True, silent=True) or {}
    try:
        from_user = int(data["from_user_id"])
        to_user = int(data["to_user_id"])
        if from_user == to_user:
            return jsonify({"error": "from and to must differ"}), 400
        currency = (data.get("currency") or g.plan["base_currency"]).upper()
        decimals = int(data.get("decimals", 2 if currency not in ("JPY", "KRW") else 0))
        amount = parse_amount_to_cents(data.get("amount", data.get("amount_cents")), decimals)
    except (KeyError, ValueError, TypeError) as e:
        return jsonify({"error": f"invalid payment: {e}"}), 400
    cur = get_db().execute(
        """INSERT INTO payments (plan_id, from_user_id, to_user_id, amount_cents, currency, note)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (plan_id, from_user, to_user, amount, currency, data.get("note")))
    get_db().commit()
    return jsonify({"payment": dict(get_db().execute(
        "SELECT * FROM payments WHERE id = ?", (cur.lastrowid,)).fetchone())})


@expenses_bp.route("/api/payments/<int:payment_id>", methods=["PATCH"])
@login_required
def update_payment(payment_id):
    check_payment_access(payment_id, write=True)
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()
    row = dict(db.execute("SELECT * FROM payments WHERE id = ?", (payment_id,)).fetchone())
    from_user = int(data.get("from_user_id", row["from_user_id"]))
    to_user = int(data.get("to_user_id", row["to_user_id"]))
    if from_user == to_user:
        return jsonify({"error": "from and to must differ"}), 400
    currency = (data.get("currency") or row["currency"]).upper()
    decimals = int(data.get("decimals", 2 if currency not in ("JPY", "KRW") else 0))
    amount = parse_amount_to_cents(
        data.get("amount", data.get("amount_cents", row["amount_cents"])), decimals)
    note = data.get("note") if "note" in data else row["note"]
    db.execute(
        """UPDATE payments SET from_user_id=?, to_user_id=?, amount_cents=?, currency=?, note=?
           WHERE id=?""",
        (from_user, to_user, amount, currency, note, payment_id))
    db.commit()
    return jsonify({"payment": dict(db.execute(
        "SELECT * FROM payments WHERE id = ?", (payment_id,)).fetchone())})


@expenses_bp.route("/api/payments/<int:payment_id>", methods=["DELETE"])
@login_required
def delete_payment(payment_id):
    check_payment_access(payment_id, write=True)
    db = get_db()
    db.execute("DELETE FROM payments WHERE id = ?", (payment_id,))
    db.commit()
    return jsonify({"deleted": payment_id})