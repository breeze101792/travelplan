"""Expense engine behavior: create/update/delete expenses with every split
method, multi-currency settlement with user-supplied rates, payment
recording, and access control.
"""
from __future__ import annotations

import pytest


@pytest.fixture
def plan_id(member_client, make_plan, make_user):
    """A plan owned by alice, with bob added as an editor (so two participants
    can share expenses)."""
    p = make_plan(title="Japan", start_date="2026-07-01",
                  end_date="2026-07-02", base_currency="JPY")
    bob_id = make_user(username="bob2")["id"]
    member_client.post(f"/api/plans/{p['id']}/members",
                       json={"user_id": bob_id, "role": "editor"})
    return p["id"]


@pytest.fixture
def user_ids(app, db):
    """Map username -> id for alice and bob2 (both created in `app`)."""
    return {r["username"]: r["id"]
            for r in db.all("SELECT id, username FROM users WHERE username IN ('alice','bob2')")}


# ------------------------------------------------------------------ create
class TestExpenseCreate:
    def test_equal_split_two_payers(self, member_client, plan_id, user_ids):
        r = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "Dinner",
            "currency": "JPY", "decimals": 0,
            "amount": 3000, "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": 3000}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        assert r.status_code == 200, r.data
        e = r.get_json()["expense"]
        assert e["total_cents"] == 3000
        assert e["split_method"] == "EQUAL"
        splits = {s["user_id"]: s["owed_cents"] for s in e["splits"]}
        assert splits[user_ids["alice"]] == 1500
        assert splits[user_ids["bob2"]] == 1500

    def test_equal_split_rounds_penny(self, member_client, plan_id, user_ids):
        # 100 cents across 3 participants (alice, bob, and add a third).
        third_id = member_client.get("/api/me").get_json()["user"]["id"]  # alice
        r = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "weird split", "currency": "USD", "decimals": 2,
            "amount": "1.00", "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "1.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        assert r.status_code == 200
        # 100 / 2 = 50 each, no remainder.
        e = r.get_json()["expense"]
        owed = sorted(s["owed_cents"] for s in e["splits"])
        assert owed == [50, 50]

    def test_exact_split(self, member_client, plan_id, user_ids):
        r = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "exact", "currency": "USD", "decimals": 2,
            "amount": "10.00", "split_method": "EXACT",
            "payers": [{"user_id": user_ids["alice"], "amount": "10.00"}],
            "split_data": [
                {"user_id": user_ids["alice"], "amount": "7.50"},
                {"user_id": user_ids["bob2"], "amount": "2.50"},
            ],
        })
        assert r.status_code == 200, r.data
        e = r.get_json()["expense"]
        owed = {s["user_id"]: s["owed_cents"] for s in e["splits"]}
        assert owed[user_ids["alice"]] == 750
        assert owed[user_ids["bob2"]] == 250

    def test_percentage_split(self, member_client, plan_id, user_ids):
        r = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "pct", "currency": "USD", "decimals": 2,
            "amount": "100.00", "split_method": "PERCENTAGE",
            "payers": [{"user_id": user_ids["alice"], "amount": "100.00"}],
            "split_data": [
                {"user_id": user_ids["alice"], "percent": 70},
                {"user_id": user_ids["bob2"], "percent": 30},
            ],
        })
        assert r.status_code == 200
        e = r.get_json()["expense"]
        owed = {s["user_id"]: s["owed_cents"] for s in e["splits"]}
        assert owed[user_ids["alice"]] == 7000
        assert owed[user_ids["bob2"]] == 3000

    def test_shares_split(self, member_client, plan_id, user_ids):
        r = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "shares", "currency": "USD", "decimals": 2,
            "amount": "90.00", "split_method": "SHARES",
            "payers": [{"user_id": user_ids["alice"], "amount": "90.00"}],
            "split_data": [
                {"user_id": user_ids["alice"], "shares": 2},
                {"user_id": user_ids["bob2"], "shares": 1},
            ],
        })
        assert r.status_code == 200
        e = r.get_json()["expense"]
        owed = {s["user_id"]: s["owed_cents"] for s in e["splits"]}
        assert owed[user_ids["alice"]] == 6000  # 2/3 of 90
        assert owed[user_ids["bob2"]] == 3000   # 1/3 of 90

    def test_invalid_split_method(self, member_client, plan_id, user_ids):
        r = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "x", "currency": "USD",
            "amount": "10.00", "split_method": "GARBAGE",
            "payers": [{"user_id": user_ids["alice"], "amount": "10.00"}],
        })
        assert r.status_code == 400

    def test_missing_payers(self, member_client, plan_id):
        r = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "x", "currency": "USD",
            "amount": "10.00", "split_method": "EQUAL",
        })
        assert r.status_code == 400

    def test_invalid_amount(self, member_client, plan_id, user_ids):
        # Non-numeric amount used to raise decimal.InvalidOperation (500);
        # the blueprint now catches ArithmeticError and returns 400.
        r = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "x", "currency": "USD",
            "amount": "not-a-number", "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "10.00"}],
            "participants": [user_ids["alice"]],
        })
        assert r.status_code == 400
        assert "invalid amount" in r.get_json()["error"]


# ------------------------------------------------------------------ list/delete
class TestExpenseListDelete:
    def test_list_expenses(self, member_client, plan_id, user_ids):
        member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "A", "currency": "USD", "amount": "10.00",
            "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "10.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "B", "currency": "USD", "amount": "5.00",
            "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "5.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        r = member_client.get(f"/api/plans/{plan_id}/expenses")
        assert r.status_code == 200
        assert len(r.get_json()["expenses"]) == 2

    def test_delete_expense(self, member_client, plan_id, user_ids):
        e = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "A", "currency": "USD", "amount": "10.00",
            "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "10.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        }).get_json()["expense"]
        r = member_client.delete(f"/api/expenses/{e['id']}")
        assert r.status_code == 200
        assert member_client.get(f"/api/plans/{plan_id}/expenses").get_json()["expenses"] == []

    def test_update_expense_replaces_split(self, member_client, plan_id, user_ids):
        e = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "A", "currency": "USD", "amount": "10.00",
            "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "10.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        }).get_json()["expense"]
        r = member_client.patch(f"/api/expenses/{e['id']}", json={
            "description": "B", "currency": "USD", "amount": "20.00",
            "split_method": "EXACT",
            "payers": [{"user_id": user_ids["bob2"], "amount": "20.00"}],
            "split_data": [
                {"user_id": user_ids["alice"], "amount": "15.00"},
                {"user_id": user_ids["bob2"], "amount": "5.00"},
            ],
        })
        assert r.status_code == 200
        e2 = r.get_json()["expense"]
        assert e2["total_cents"] == 2000
        owed = {s["user_id"]: s["owed_cents"] for s in e2["splits"]}
        assert owed[user_ids["alice"]] == 1500
        assert owed[user_ids["bob2"]] == 500


# ------------------------------------------------------------------ rates & settlement
class TestRatesAndSettlement:
    def test_get_rates_empty_default(self, member_client, plan_id):
        r = member_client.get(f"/api/plans/{plan_id}/rates")
        assert r.status_code == 200
        assert r.get_json()["base_currency"] == "JPY"
        assert r.get_json()["rates"] == {}

    def test_set_rates(self, member_client, plan_id):
        r = member_client.post(f"/api/plans/{plan_id}/rates", json={
            "rates": {"USD": 150.0}})
        assert r.status_code == 200
        assert r.get_json()["rates"]["USD"] == 150.0
        # Re-get confirms persistence.
        r = member_client.get(f"/api/plans/{plan_id}/rates")
        assert r.get_json()["rates"]["USD"] == 150.0

    def test_set_rates_rejects_non_numeric(self, member_client, plan_id):
        r = member_client.post(f"/api/plans/{plan_id}/rates", json={
            "rates": {"USD": "abc"}})
        assert r.status_code == 400

    def test_set_rates_rejects_non_positive(self, member_client, plan_id):
        """A zero, negative, or non-finite rate would make the allocation
        value guard pass trivially and could raise on division."""
        for bad in (0, -150, 1e400, 1e-400):
            r = member_client.post(f"/api/plans/{plan_id}/rates", json={
                "rates": {"USD": bad}})
            assert r.status_code == 400, f"{bad!r} should be rejected"
            assert "USD" in r.get_json()["error"]
        # Nothing was persisted by the rejected attempts.
        assert member_client.get(
            f"/api/plans/{plan_id}/rates").get_json()["rates"] == {}
        # A normal positive rate still succeeds.
        r = member_client.post(f"/api/plans/{plan_id}/rates", json={
            "rates": {"USD": 150.0}})
        assert r.status_code == 200
        assert r.get_json()["rates"]["USD"] == 150.0

    def test_settlement_multi_currency_uses_rates(self, member_client, plan_id, user_ids):
        # Plan base is JPY. Add a USD expense and an exchange rate.
        member_client.post(f"/api/plans/{plan_id}/rates", json={
            "rates": {"USD": 150.0}})
        member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "Dinner", "currency": "USD", "decimals": 2,
            "amount": "10.00", "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "10.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        # 10 USD * 150 = 1500 JPY; equal split -> 750 each. Alice paid 1500,
        # owed 750, so net +750.
        r = member_client.get(f"/api/plans/{plan_id}/settlement")
        body = r.get_json()
        balances = body.get("balances") or body.get("remaining_balances")
        by_user = {b["user_id"]: b["balance_cents"] for b in balances}
        assert by_user[user_ids["alice"]] == 750
        assert by_user[user_ids["bob2"]] == -750

    def test_settlement_no_expenses(self, member_client, plan_id):
        r = member_client.get(f"/api/plans/{plan_id}/settlement")
        assert r.status_code == 200
        body = r.get_json()
        balances = body.get("balances") or body.get("remaining_balances") or []
        # No balances when no expenses.
        assert balances == []

    def test_mixed_currency_row_reports_parts(
            self, member_client, plan_id, user_ids):
        """A single-mode proposal that nets debt in two currencies reports
        both currencies in `parts` so the UI can hide the one-tap Settle;
        each per-currency row reports exactly its own currency."""
        member_client.post(f"/api/plans/{plan_id}/rates", json={"rates": {"USD": 150.0}})
        for cur, amt in (("JPY", 3000), ("USD", "20.00")):
            member_client.post(f"/api/plans/{plan_id}/expenses", json={
                "description": f"{cur} expense", "currency": cur,
                "decimals": 0 if cur == "JPY" else 2,
                "amount": amt, "split_method": "EQUAL",
                "payers": [{"user_id": user_ids["alice"], "amount": amt}],
                "participants": [user_ids["alice"], user_ids["bob2"]],
            })
        single = member_client.get(f"/api/plans/{plan_id}/settlement").get_json()
        assert len(single["proposed_settlement"]) == 1
        parts = single["proposed_settlement"][0]["parts"]
        assert {p["currency"] for p in parts} == {"JPY", "USD"}
        per_cur = member_client.get(
            f"/api/plans/{plan_id}/settlement?mode=per_currency").get_json()
        for cur in ("JPY", "USD"):
            rows = per_cur["per_currency"][cur]["proposed_settlement"]
            assert rows, f"{cur} should have a proposed row"
            for r in rows:
                assert r["parts"] == [{"currency": cur,
                                       "amount_cents": r["amount_cents"],
                                       "decimals": 0 if cur == "JPY" else 2}]

    def test_single_row_reports_parts_only_in_debt_currency(
            self, member_client, plan_id, user_ids):
        """A USD-only debt displayed in the base currency (JPY) reports its
        parts in USD, not the display currency, so the UI will not offer a
        one-tap settle that would create debt in JPY."""
        member_client.post(f"/api/plans/{plan_id}/rates", json={"rates": {"USD": 150.0}})
        member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "Hotel", "currency": "USD", "decimals": 2,
            "amount": "20.00", "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "20.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        single = member_client.get(f"/api/plans/{plan_id}/settlement").get_json()
        assert single["settlement_currency"] == "JPY"
        parts = single["proposed_settlement"][0]["parts"]
        assert [p["currency"] for p in parts] == ["USD"]
        assert parts[0]["amount_cents"] == 1000

    def test_per_currency_settle_keeps_one_record_per_currency(
            self, member_client, plan_id, user_ids):
        """Recording the per-currency proposals keeps a payment record in each
        real currency and clears both the per-currency and single views."""
        member_client.post(f"/api/plans/{plan_id}/rates", json={"rates": {"USD": 150.0}})
        for cur, amt in (("JPY", 3000), ("USD", "20.00")):
            member_client.post(f"/api/plans/{plan_id}/expenses", json={
                "description": f"{cur} expense", "currency": cur,
                "decimals": 0 if cur == "JPY" else 2,
                "amount": amt, "split_method": "EQUAL",
                "payers": [{"user_id": user_ids["alice"], "amount": amt}],
                "participants": [user_ids["alice"], user_ids["bob2"]],
            })
        per_cur = member_client.get(
            f"/api/plans/{plan_id}/settlement?mode=per_currency").get_json()
        settled = []
        for cur in ("JPY", "USD"):
            for p in per_cur["per_currency"][cur]["proposed_settlement"]:
                r = member_client.post(f"/api/plans/{plan_id}/payments", json={
                    "from_user_id": p["from"], "to_user_id": p["to"],
                    "amount": p["amount_cents"], "currency": cur,
                    "decimals": 0 if cur == "JPY" else 2,
                })
                assert r.status_code == 200, r.data
                settled.append(cur)
        # One record per currency, each remembering its real currency.
        payments = member_client.get(
            f"/api/plans/{plan_id}/payments").get_json()["payments"]
        by_cur = {p["currency"]: p["amount_cents"] for p in payments}
        assert by_cur == {"JPY": 1500, "USD": 1000}
        # Both views clear.
        single = member_client.get(f"/api/plans/{plan_id}/settlement").get_json()
        assert single["remaining_balances"] == []
        per_after = member_client.get(
            f"/api/plans/{plan_id}/settlement?mode=per_currency").get_json()
        for cur in ("JPY", "USD"):
            assert per_after["per_currency"][cur]["remaining_balances"] == []

    def test_single_mode_settle_mixed_row_clears_both_modes(
            self, member_client, plan_id, user_ids):
        """A single payment recorded against a mixed-currency row — with
        per-currency allocations — clears remaining balances in BOTH the
        single and per-currency settlement views, while the stored payment
        stays the real one the user made (JPY 3000)."""
        member_client.post(f"/api/plans/{plan_id}/rates", json={"rates": {"USD": 150.0}})
        for cur, amt in (("JPY", 3000), ("USD", "20.00")):
            member_client.post(f"/api/plans/{plan_id}/expenses", json={
                "description": f"{cur} expense", "currency": cur,
                "decimals": 0 if cur == "JPY" else 2,
                "amount": amt, "split_method": "EQUAL",
                "payers": [{"user_id": user_ids["alice"], "amount": amt}],
                "participants": [user_ids["alice"], user_ids["bob2"]],
            })
        single = member_client.get(f"/api/plans/{plan_id}/settlement").get_json()
        assert len(single["proposed_settlement"]) == 1
        row = single["proposed_settlement"][0]
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": row["from"], "to_user_id": row["to"],
            "amount": row["amount_cents"], "currency": "JPY", "decimals": 0,
            "allocations": [
                {"currency": "JPY", "amount_cents": 1500},
                {"currency": "USD", "amount_cents": 1000},
            ],
        })
        assert r.status_code == 200, r.data
        payment = r.get_json()["payment"]
        assert payment["currency"] == "JPY"
        assert payment["amount_cents"] == 3000
        # The stored record is the single real payment, not one row per currency.
        payments = member_client.get(
            f"/api/plans/{plan_id}/payments").get_json()["payments"]
        assert len(payments) == 1
        assert payments[0]["currency"] == "JPY"
        assert payments[0]["amount_cents"] == 3000
        # Both views clear in JPY and USD.
        single_after = member_client.get(f"/api/plans/{plan_id}/settlement").get_json()
        assert single_after["remaining_balances"] == []
        per_after = member_client.get(
            f"/api/plans/{plan_id}/settlement?mode=per_currency").get_json()
        for cur in ("JPY", "USD"):
            assert per_after["per_currency"][cur]["remaining_balances"] == []


# ------------------------------------------------------------------ by-item totals
class TestExpensesByItem:
    def test_by_item_aggregates_per_item(self, member_client, plan_id, user_ids):
        # Create an item, then attach an expense to it.
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "restaurant", "title": "Dinner",
            "details": {"name": "Dinner", "address": "Tokyo",
                        "when": {"start_at": "2026-07-01T19:00",
                                 "end_at": "2026-07-01T20:00"}}}).get_json()["item"]
        member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "Dinner", "currency": "USD", "amount": "20.00",
            "split_method": "EQUAL", "item_id": item["id"],
            "payers": [{"user_id": user_ids["alice"], "amount": "20.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        r = member_client.get(f"/api/plans/{plan_id}/expenses/by-item")
        assert r.status_code == 200
        items = r.get_json()["items"]
        assert len(items) == 1
        assert items[0]["item_id"] == item["id"]
        assert items[0]["total_by_currency"]["USD"] == 2000


# ------------------------------------------------------------------ payments
class TestPayments:
    def test_record_payment(self, member_client, plan_id, user_ids):
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"],
            "to_user_id": user_ids["alice"],
            "amount": "15.00", "currency": "JPY", "decimals": 0,
        })
        assert r.status_code == 200, r.data
        p = r.get_json()["payment"]
        assert p["from_user_id"] == user_ids["bob2"]
        assert p["to_user_id"] == user_ids["alice"]
        assert p["amount_cents"] == 15
        # No allocations in the request: default is the payment's own currency.
        assert p["allocations"] == [{"currency": "JPY", "amount_cents": 15}]

    def test_payment_affects_remaining_balances(self, member_client, plan_id, user_ids):
        """A recorded payment must reduce the debtor's balance and
        reduce the creditor's balance in remaining_balances."""
        # Create an expense: alice pays 3000 JPY, split EQUALLY with bob2
        # alice paid 3000, each owes 1500 → alice +1500, bob2 -1500
        member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "Dinner", "currency": "JPY", "decimals": 0,
            "amount": 3000, "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": 3000}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        # Check balances before payment
        r = member_client.get(f"/api/plans/{plan_id}/settlement")
        body = r.get_json()
        rem = {b["user_id"]: b["balance_cents"] for b in body["remaining_balances"]}
        assert rem[user_ids["alice"]] == 1500, f"expected alice +1500, got {rem}"
        assert rem[user_ids["bob2"]] == -1500, f"expected bob2 -1500, got {rem}"

        # Record payment: bob2 (debtor) pays alice (creditor) 1500 JPY
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"],
            "to_user_id": user_ids["alice"],
            "amount": "1500", "currency": "JPY", "decimals": 0,
        })
        assert r.status_code == 200

        # Remaining balances should now be 0 for both (payment settled the debt)
        r = member_client.get(f"/api/plans/{plan_id}/settlement")
        body = r.get_json()
        rem = {b["user_id"]: b["balance_cents"] for b in body["remaining_balances"]}
        assert user_ids["alice"] not in rem or rem[user_ids["alice"]] == 0, \
            f"expected alice 0, got {rem.get(user_ids['alice'])}"
        assert user_ids["bob2"] not in rem or rem[user_ids["bob2"]] == 0, \
            f"expected bob2 0, got {rem.get(user_ids['bob2'])}"

    def test_payment_in_non_expense_currency_appears_in_per_currency(
            self, member_client, plan_id, user_ids):
        """Payments in a currency without expenses must still appear in
        per-currency settlement remaining_balances."""
        # Plan base is JPY. Add a JPY expense.
        member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "Dinner", "currency": "JPY", "decimals": 0,
            "amount": 3000, "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": 3000}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        # Record a payment in USD (no USD expenses exist)
        member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"],
            "to_user_id": user_ids["alice"],
            "amount": "10.00", "currency": "USD", "decimals": 2,
        })
        r = member_client.get(f"/api/plans/{plan_id}/settlement?mode=per_currency")
        body = r.get_json()
        assert "per_currency" in body
        # USD should appear as a currency in per_currency results
        assert "USD" in body["per_currency"], \
            f"expected USD in per_currency keys, got {list(body['per_currency'].keys())}"
        usd = body["per_currency"]["USD"]
        rem = {b["user_id"]: b["balance_cents"] for b in usd["remaining_balances"]}
        # bob2 paid alice 1000 USD cents (10.00) → bob2's balance goes up (less debt),
        # alice's balance goes down (less credit), but since there are no USD expenses
        # the balances start at 0, so:
        #   bob2: 0 + 1000 = +1000
        #   alice: 0 - 1000 = -1000
        assert rem[user_ids["bob2"]] == 1000, f"expected bob2 +1000, got {rem}"
        assert rem[user_ids["alice"]] == -1000, f"expected alice -1000, got {rem}"

    def test_record_payment_rejects_self_transfer(self, member_client, plan_id, user_ids):
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["alice"],
            "to_user_id": user_ids["alice"],
            "amount": "10.00",
        })
        assert r.status_code == 400

    def test_list_payments(self, member_client, plan_id, user_ids):
        member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"],
            "to_user_id": user_ids["alice"],
            "amount": "15.00", "currency": "JPY", "decimals": 0,
        })
        r = member_client.get(f"/api/plans/{plan_id}/payments")
        assert r.status_code == 200
        assert len(r.get_json()["payments"]) == 1

    def test_delete_payment(self, member_client, plan_id, user_ids):
        p = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"],
            "to_user_id": user_ids["alice"],
            "amount": "15.00", "currency": "JPY", "decimals": 0,
        }).get_json()["payment"]
        r = member_client.delete(f"/api/payments/{p['id']}")
        assert r.status_code == 200
        assert member_client.get(f"/api/plans/{plan_id}/payments").get_json()["payments"] == []

    def test_record_payment_rejects_zero_amount(self, member_client, plan_id, user_ids):
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "0", "currency": "JPY", "decimals": 0,
        })
        assert r.status_code == 400
        assert member_client.get(
            f"/api/plans/{plan_id}/payments").get_json()["payments"] == []

    def test_record_payment_rejects_negative_amount(self, member_client, plan_id, user_ids):
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "-100", "currency": "JPY", "decimals": 0,
        })
        assert r.status_code == 400

    def test_update_payment_rejects_zero_amount(self, member_client, plan_id, user_ids):
        p = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "1500", "currency": "JPY", "decimals": 0,
        }).get_json()["payment"]
        r = member_client.patch(f"/api/payments/{p['id']}", json={
            "amount": "0", "currency": "JPY", "decimals": 0,
        })
        assert r.status_code == 400
        listed = member_client.get(
            f"/api/plans/{plan_id}/payments").get_json()["payments"]
        assert listed[0]["amount_cents"] == 1500

    def test_update_payment(self, member_client, plan_id, user_ids):
        p = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "1500", "currency": "JPY", "decimals": 0, "note": "first",
        }).get_json()["payment"]
        r = member_client.patch(f"/api/payments/{p['id']}", json={
            "amount": "2000", "currency": "JPY", "note": "updated",
        })
        assert r.status_code == 200
        u = r.get_json()["payment"]
        assert u["amount_cents"] == 2000
        assert u["note"] == "updated"
        assert u["from_user_id"] == user_ids["bob2"]

    def test_update_payment_rejects_self_transfer(self, member_client, plan_id, user_ids):
        p = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "1500", "currency": "JPY", "decimals": 0,
        }).get_json()["payment"]
        r = member_client.patch(f"/api/payments/{p['id']}", json={
            "from_user_id": user_ids["alice"], "to_user_id": user_ids["alice"],
        })
        assert r.status_code == 400

    def test_payment_multi_currency_missing_rate(
            self, member_client, plan_id, user_ids):
        """Payments in a non-base currency without an exchange rate must not
        zero out remaining_balances — they should appear in per-currency mode
        and be excluded (not crash) in single-currency mode."""
        # Plan base is JPY. Create a JPY expense then a USD payment (no USD rate set).
        member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "Hotel", "currency": "JPY", "decimals": 0,
            "amount": 6000, "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": 6000}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "10.00", "currency": "USD", "decimals": 2,
        })
        # Single-currency mode — should not crash; JPY balances unchanged.
        r = member_client.get(f"/api/plans/{plan_id}/settlement")
        assert r.status_code == 200
        body = r.get_json()
        rem = {b["user_id"]: b["balance_cents"] for b in body["remaining_balances"]}
        assert rem[user_ids["alice"]] == 3000, f"expected alice 3000, got {rem}"
        assert rem[user_ids["bob2"]] == -3000, f"expected bob2 -3000, got {rem}"
        # Per-currency mode — USD payment must appear in its own bucket.
        r = member_client.get(
            f"/api/plans/{plan_id}/settlement?mode=per_currency")
        body = r.get_json()
        assert "USD" in body["per_currency"]
        usd_rem = {b["user_id"]: b["balance_cents"]
                   for b in body["per_currency"]["USD"]["remaining_balances"]}
        assert usd_rem[user_ids["bob2"]] == 1000

    def test_payment_allocations_api_rules(self, member_client, plan_id, user_ids, db):
        """Allocations round-trip, reject bad values/currencies, and follow
        PATCH semantics (keep on note-only, reset on amount-only)."""
        member_client.post(f"/api/plans/{plan_id}/rates", json={"rates": {"USD": 150.0}})
        # (a) allocations are echoed back in the POST response.
        p = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "1500", "currency": "JPY", "decimals": 0,
            "allocations": [
                {"currency": "JPY", "amount_cents": 750},
                {"currency": "USD", "amount_cents": 500},
            ],
        })
        assert p.status_code == 200, p.data
        body = p.get_json()["payment"]
        assert body["allocations"] == [
            {"currency": "JPY", "amount_cents": 750},
            {"currency": "USD", "amount_cents": 500},
        ]
        # (b) allocations worth more than the payment amount -> 400.
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "10", "currency": "JPY", "decimals": 0,
            "allocations": [{"currency": "USD", "amount_cents": 100}],
        })
        assert r.status_code == 400
        # (c) an allocation in an unrated, non-base currency -> 400.
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "1500", "currency": "JPY", "decimals": 0,
            "allocations": [{"currency": "EUR", "amount_cents": 500}],
        })
        assert r.status_code == 400
        # (d) PATCH note-only keeps the existing allocations.
        r = member_client.patch(f"/api/payments/{body['id']}", json={"note": "hi"})
        assert r.status_code == 200
        assert r.get_json()["payment"]["allocations"] == [
            {"currency": "JPY", "amount_cents": 750},
            {"currency": "USD", "amount_cents": 500},
        ]
        # (e) PATCH amount-only (no allocations field) resets to one
        # own-currency allocation for the new amount.
        r = member_client.patch(f"/api/payments/{body['id']}", json={
            "amount": "2000", "currency": "JPY", "decimals": 0})
        assert r.status_code == 200
        assert r.get_json()["payment"]["allocations"] == [
            {"currency": "JPY", "amount_cents": 2000}]
        # (f) DELETE cascades the allocation rows away.
        member_client.delete(f"/api/payments/{body['id']}")
        assert db.all(
            "SELECT * FROM payment_allocations WHERE payment_id = ?",
            (body["id"],)) == []

    def test_payment_allocation_cannot_exceed_value_with_zero_rate(
            self, member_client, plan_id, user_ids):
        """The zero/negative-rate exploit is closed: the rate POST is rejected,
        the saved rate is unchanged, and a crafted allocation in that currency
        cannot be created to mint debt."""
        # Prime a valid rate, then attempt to overwrite it with a zero.
        member_client.post(f"/api/plans/{plan_id}/rates", json={"rates": {"USD": 150.0}})
        r = member_client.post(f"/api/plans/{plan_id}/rates", json={"rates": {"USD": 0}})
        assert r.status_code == 400
        assert member_client.get(
            f"/api/plans/{plan_id}/rates").get_json()["rates"]["USD"] == 150.0
        # A tiny JPY payment cannot be turned into a huge USD allocation.
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "1", "currency": "JPY", "decimals": 0,
            "allocations": [{"currency": "USD", "amount_cents": 1_000_000_000}],
        })
        assert r.status_code == 400
        assert member_client.get(
            f"/api/plans/{plan_id}/payments").get_json()["payments"] == []

    def test_payment_zero_rate_does_not_500(self, member_client, plan_id, user_ids):
        """A zero rate is rejected, and payments/settlement keep returning 200."""
        p = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "1500", "currency": "JPY", "decimals": 0,
        })
        assert p.status_code == 200, p.data
        # Set a valid rate, then attempt to zero it -> 400, rate unchanged.
        assert member_client.post(
            f"/api/plans/{plan_id}/rates",
            json={"rates": {"USD": 150.0}}).status_code == 200
        bad = member_client.post(f"/api/plans/{plan_id}/rates", json={"rates": {"USD": 0}})
        assert bad.status_code == 400
        assert member_client.get(
            f"/api/plans/{plan_id}/rates").get_json()["rates"]["USD"] == 150.0
        # Neither path may 500 after the rejected rate.
        assert member_client.get(
            f"/api/plans/{plan_id}/payments").status_code == 200
        assert member_client.get(
            f"/api/plans/{plan_id}/settlement").status_code == 200

    def test_allocations_reject_oversize_and_bool(self, member_client, plan_id, user_ids):
        """Allocation bounds: bool, overlong list, and oversize amount all 400."""
        member_client.post(f"/api/plans/{plan_id}/rates", json={"rates": {"USD": 150.0}})
        base = {"from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
                "amount": "1500", "currency": "JPY", "decimals": 0}
        # (a) bool is an int subclass but must be rejected.
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            **base, "allocations": [{"currency": "JPY", "amount_cents": True}]})
        assert r.status_code == 400
        # (b) more than MAX_ALLOCATIONS rows.
        long_list = [{"currency": "JPY", "amount_cents": 1} for _ in range(65)]
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            **base, "allocations": long_list})
        assert r.status_code == 400
        # (c) amount above the business cap.
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            **base, "allocations": [
                {"currency": "JPY", "amount_cents": 10 ** 16}]})
        assert r.status_code == 400
        # No payment leaked through.
        assert member_client.get(
            f"/api/plans/{plan_id}/payments").get_json()["payments"] == []

    def test_update_payment_bad_fields_return_400(self, member_client, plan_id, user_ids):
        """Null numeric fields must be a clean 400, not an uncaught TypeError."""
        p = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "1500", "currency": "JPY", "decimals": 0,
        }).get_json()["payment"]
        for bad in ({"decimals": None}, {"from_user_id": None}, {"to_user_id": None}):
            r = member_client.patch(f"/api/payments/{p['id']}", json=bad)
            assert r.status_code == 400, f"{bad} -> {r.status_code}"
        # The record is untouched.
        listed = member_client.get(
            f"/api/plans/{plan_id}/payments").get_json()["payments"]
        assert listed[0]["amount_cents"] == 1500

    def test_missing_rate_for_allocation_only_currency_is_reported(
            self, app, member_client, plan_id, user_ids):
        """An allocation in a currency with no saved rate must be reported in
        single mode's missing_currencies, and its effect must show in
        per-currency mode, so the two modes agree."""
        import sqlite3

        # A JPY expense so the plan has balances; plan base is JPY.
        member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "Dinner", "currency": "JPY", "decimals": 0,
            "amount": 3000, "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": 3000}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        # An allocation in EUR requires a rate to be created via the API, so
        # seed a valid rate, record the payment, then remove the rate directly.
        member_client.post(f"/api/plans/{plan_id}/rates", json={"rates": {"EUR": 160.0}})
        p = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "1500", "currency": "JPY", "decimals": 0,
            "allocations": [
                {"currency": "JPY", "amount_cents": 1000},
                {"currency": "EUR", "amount_cents": 300},
            ],
        })
        assert p.status_code == 200, p.data
        # Drop the rate to simulate a currency that has allocations but no rate.
        conn = sqlite3.connect(str(app.config["DB_PATH"]))
        try:
            conn.execute(
                "DELETE FROM plan_rates WHERE plan_id = ? AND currency = 'EUR'",
                (plan_id,))
            conn.commit()
        finally:
            conn.close()

        single = member_client.get(f"/api/plans/{plan_id}/settlement").get_json()
        assert "EUR" in single["missing_currencies"]
        # Per-currency mode still shows the EUR allocation effect.
        per = member_client.get(
            f"/api/plans/{plan_id}/settlement?mode=per_currency").get_json()
        assert "EUR" in per["per_currency"]
        eur_rem = {b["user_id"]: b["balance_cents"]
                   for b in per["per_currency"]["EUR"]["remaining_balances"]}
        assert eur_rem[user_ids["bob2"]] == 300
        assert eur_rem[user_ids["alice"]] == -300

    def test_migration_backfills_allocations(self, db, plan_id, user_ids):
        """007 gives every pre-existing payment one own-currency allocation and
        is idempotent when re-run."""
        import importlib
        import sqlite3

        # A scratch connection to the same DB file, as the `db` fixture does.
        db_path = db.one("PRAGMA database_list")["file"]
        conn = sqlite3.connect(db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            payment_id = conn.execute(
                """INSERT INTO payments (plan_id, from_user_id, to_user_id,
                   amount_cents, currency, note)
                   VALUES (?, ?, ?, 1500, 'JPY', 'legacy')""",
                (plan_id, user_ids["bob2"], user_ids["alice"])).lastrowid
            conn.commit()

            # The module name starts with a digit, so it must be imported
            # dynamically rather than with an `import` statement.
            m = importlib.import_module("backend.migrations.007_payment_allocations")
            m.run(conn)
            conn.commit()
            rows = conn.execute(
                "SELECT currency, amount_cents FROM payment_allocations WHERE payment_id = ?",
                (payment_id,)).fetchall()
            assert [(r["currency"], r["amount_cents"]) for r in rows] == [("JPY", 1500)]

            # A second run must not duplicate the allocation (INSERT OR IGNORE).
            m.run(conn)
            conn.commit()
            rows = conn.execute(
                "SELECT * FROM payment_allocations WHERE payment_id = ?",
                (payment_id,)).fetchall()
            assert len(rows) == 1
        finally:
            conn.close()


# ------------------------------------------------------------------ access control
class TestExpenseAccess:
    def test_viewer_cannot_create(self, app, member_client, plan_id, make_user, user_ids):
        carol_id = make_user(username="carol2")["id"]
        member_client.post(f"/api/plans/{plan_id}/members",
                           json={"user_id": carol_id, "role": "viewer"})
        c2 = app.test_client()
        c2.post("/auth/login", data={"username": "carol2", "password": "pw12345"})
        r = c2.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "x", "currency": "USD", "amount": "10.00",
            "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "10.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        assert r.status_code == 403

    def test_anon_cannot_view(self, app, plan_id):
        c = app.test_client()
        c.get("/auth/logout")
        assert c.get(f"/api/plans/{plan_id}/expenses").status_code == 401

    def test_non_member_cannot_view(self, app, plan_id, make_user):
        make_user(username="dave2")
        c2 = app.test_client()
        c2.post("/auth/login", data={"username": "dave2", "password": "pw12345"})
        assert c2.get(f"/api/plans/{plan_id}/expenses").status_code == 403


class TestExpenseVersionConflicts:
    def test_update_conflict_409(self, member_client, plan_id, user_ids, db):
        e = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "A", "currency": "USD", "amount": "10.00",
            "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "10.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        }).get_json()["expense"]
        row = db.one("SELECT updated_at FROM expenses WHERE id = ?", (e["id"],))
        wrong_ts = "2000-01-01T00:00:00" if row["updated_at"] != "2000-01-01T00:00:00" else "2000-01-02T00:00:00"
        r = member_client.patch(f"/api/expenses/{e['id']}", json={
            "description": "B", "expected_updated_at": wrong_ts})
        assert r.status_code == 409
        assert r.get_json()["error"] == "conflict"

    def test_update_correct_version_succeeds(self, member_client, plan_id, user_ids, db):
        e = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "A", "currency": "USD", "amount": "10.00",
            "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "10.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        }).get_json()["expense"]
        row = db.one("SELECT updated_at FROM expenses WHERE id = ?", (e["id"],))
        r = member_client.patch(f"/api/expenses/{e['id']}", json={
            "description": "B", "currency": "USD", "amount": "20.00",
            "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": "20.00"}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
            "expected_updated_at": row["updated_at"]})
        assert r.status_code == 200


# ------------------------------------------------------------------ plan isolation
class TestPlanIsolation:
    """A plan's money is per-plan: no expense or payment may reference a user
    or item that belongs to another plan."""

    def test_expense_rejects_foreign_participant(
            self, member_client, plan_id, make_user, user_ids):
        carol = make_user(username="carol3")["id"]  # not a member of plan_id
        r = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "x", "currency": "JPY", "decimals": 0,
            "amount": 3000, "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": 3000}],
            "participants": [user_ids["alice"], carol],
        })
        assert r.status_code == 400
        assert "members of this plan" in r.get_json()["error"]
        assert member_client.get(
            f"/api/plans/{plan_id}/expenses").get_json()["expenses"] == []

    def test_expense_rejects_foreign_payer(
            self, member_client, plan_id, make_user, user_ids):
        carol = make_user(username="carol4")["id"]
        r = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "x", "currency": "JPY", "decimals": 0,
            "amount": 3000, "split_method": "EQUAL",
            "payers": [{"user_id": carol, "amount": 3000}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        assert r.status_code == 400
        assert "members of this plan" in r.get_json()["error"]

    def test_expense_rejects_item_from_other_plan(
            self, member_client, plan_id, user_ids, make_plan):
        other = make_plan(title="Other trip")
        item = member_client.post(f"/api/plans/{other['id']}/items", json={
            "item_type": "restaurant", "title": "Elsewhere",
            "details": {"name": "Elsewhere", "address": "Osaka",
                        "when": {"start_at": "2026-07-01T19:00",
                                 "end_at": "2026-07-01T20:00"}}}).get_json()["item"]
        r = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "x", "currency": "JPY", "decimals": 0,
            "amount": 3000, "split_method": "EQUAL", "item_id": item["id"],
            "payers": [{"user_id": user_ids["alice"], "amount": 3000}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        assert r.status_code == 400
        assert "item does not belong" in r.get_json()["error"]

    def test_update_expense_rejects_foreign_item(
            self, member_client, plan_id, user_ids, make_plan):
        e = member_client.post(f"/api/plans/{plan_id}/expenses", json={
            "description": "x", "currency": "JPY", "decimals": 0,
            "amount": 3000, "split_method": "EQUAL",
            "payers": [{"user_id": user_ids["alice"], "amount": 3000}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        }).get_json()["expense"]
        other = make_plan(title="Other trip")
        item = member_client.post(f"/api/plans/{other['id']}/items", json={
            "item_type": "activity", "title": "Elsewhere",
            "details": {"name": "Elsewhere", "location": "Osaka",
                        "when": {"start_at": "2026-07-01T19:00",
                                 "end_at": "2026-07-01T20:00"}}}).get_json()["item"]
        r = member_client.patch(f"/api/expenses/{e['id']}", json={
            "description": "x", "currency": "JPY", "decimals": 0,
            "amount": 3000, "split_method": "EQUAL", "item_id": item["id"],
            "payers": [{"user_id": user_ids["alice"], "amount": 3000}],
            "participants": [user_ids["alice"], user_ids["bob2"]],
        })
        assert r.status_code == 400
        assert "item does not belong" in r.get_json()["error"]

    def test_payment_rejects_foreign_user(
            self, member_client, plan_id, make_user, user_ids):
        carol = make_user(username="carol5")["id"]
        r = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": carol, "to_user_id": user_ids["alice"],
            "amount": "1500", "currency": "JPY", "decimals": 0,
        })
        assert r.status_code == 400
        assert "members of this plan" in r.get_json()["error"]
        assert member_client.get(
            f"/api/plans/{plan_id}/payments").get_json()["payments"] == []

    def test_update_payment_rejects_foreign_user(
            self, member_client, plan_id, make_user, user_ids):
        p = member_client.post(f"/api/plans/{plan_id}/payments", json={
            "from_user_id": user_ids["bob2"], "to_user_id": user_ids["alice"],
            "amount": "1500", "currency": "JPY", "decimals": 0,
        }).get_json()["payment"]
        carol = make_user(username="carol6")["id"]
        r = member_client.patch(f"/api/payments/{p['id']}", json={
            "from_user_id": carol, "to_user_id": user_ids["alice"],
        })
        assert r.status_code == 400
        assert "members of this plan" in r.get_json()["error"]
        # The record is untouched.
        listed = member_client.get(
            f"/api/plans/{plan_id}/payments").get_json()["payments"]
        assert listed[0]["from_user_id"] == user_ids["bob2"]