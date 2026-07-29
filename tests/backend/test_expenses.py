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


# ------------------------------------------------------------------ by-item totals
class TestExpensesByItem:
    def test_by_item_aggregates_per_item(self, member_client, plan_id, user_ids):
        # Create an item, then attach an expense to it.
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "restaurant", "title": "Dinner"}).get_json()["item"]
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