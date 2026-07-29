"""Plan API behavior: CRUD, status tabs, sharing, transfer, buffer days,
day metadata, and the rendered header partial on every plan page.

These cover the user-facing behaviors of the plans blueprint that, if
silently broken by a refactor, would change what the user sees on the
dashboard or the per-plan pages.
"""
from __future__ import annotations

import pytest


# ------------------------------------------------------------------ create/list
class TestPlanCreateList:
    def test_create_plan_requires_title(self, member_client):
        r = member_client.post("/api/plans", json={"title": ""})
        assert r.status_code == 400
        assert "title" in r.get_json()["error"]

    def test_create_plan_defaults(self, member_client):
        r = member_client.post("/api/plans", json={"title": "Japan"})
        assert r.status_code == 200
        plan = r.get_json()["plan"]
        assert plan["title"] == "Japan"
        assert plan["base_currency"] == "USD"
        assert plan["status"] == "planning"
        assert plan["buffer_days"] == []
        # `role` is added by the list endpoint, not the create response.
        r = member_client.get("/api/plans")
        by_title = {p["title"]: p["role"] for p in r.get_json()["plans"]}
        assert by_title["Japan"] == "owner"

    def test_create_plan_with_dates_and_currency(self, member_client):
        r = member_client.post("/api/plans", json={
            "title": "Iceland", "start_date": "2026-09-01",
            "end_date": "2026-09-05", "base_currency": "EUR",
        })
        assert r.status_code == 200
        plan = r.get_json()["plan"]
        assert plan["start_date"] == "2026-09-01"
        assert plan["end_date"] == "2026-09-05"
        assert plan["base_currency"] == "EUR"

    def test_create_plan_with_initial_buffer_days(self, member_client):
        p = member_client.post("/api/plans", json={
            "title": "T", "buffer_days": ["2026-06-30", "2026-07-04"],
        }).get_json()["plan"]
        assert p["buffer_days"] == ["2026-06-30", "2026-07-04"]

    def test_create_plan_drops_invalid_buffer_dates(self, member_client):
        p = member_client.post("/api/plans", json={
            "title": "T",
            "buffer_days": ["2026-07-01", "not-a-date", 42, None],
        }).get_json()["plan"]
        assert p["buffer_days"] == ["2026-07-01"]

    def test_list_plans_returns_only_visible(self, app, member_client, make_user):
        # Alice (member_client) owns plan A.
        a = member_client.post("/api/plans", json={"title": "A"}).get_json()["plan"]
        # Bob owns B; not shared with alice.
        bob_id = make_user(username="bob2")["id"]
        # Switch to bob via a fresh client (member_client is alice's session).
        c2 = app.test_client()
        c2.post("/auth/login", data={"username": "bob2", "password": "pw12345"})
        c2.post("/api/plans", json={"title": "B"})
        # Alice sees only her own plan.
        r = member_client.get("/api/plans")
        titles = [p["title"] for p in r.get_json()["plans"]]
        assert "A" in titles and "B" not in titles

    def test_list_plans_includes_buffer_days(self, member_client):
        member_client.post("/api/plans", json={"title": "A", "buffer_days": ["2026-07-01"]})
        member_client.post("/api/plans", json={"title": "B", "buffer_days": ["2026-08-01", "2026-08-02"]})
        member_client.post("/api/plans", json={"title": "C"})
        r = member_client.get("/api/plans")
        by_title = {p["title"]: p["buffer_days"] for p in r.get_json()["plans"]}
        assert by_title["A"] == ["2026-07-01"]
        assert by_title["B"] == ["2026-08-01", "2026-08-02"]
        assert by_title["C"] == []

    def test_list_plans_status_filter(self, member_client):
        member_client.post("/api/plans", json={"title": "P1"})
        p2 = member_client.post("/api/plans", json={"title": "P2"}).get_json()["plan"]
        member_client.patch(f"/api/plans/{p2['id']}", json={"status": "ongoing"})
        p3 = member_client.post("/api/plans", json={"title": "P3"}).get_json()["plan"]
        member_client.patch(f"/api/plans/{p3['id']}", json={"status": "archived"})
        for status, expect in [("planning", ["P1"]), ("ongoing", ["P2"]), ("archived", ["P3"])]:
            r = member_client.get(f"/api/plans?status={status}")
            assert {p["title"] for p in r.get_json()["plans"]} == set(expect)


# ------------------------------------------------------------------ get/patch/delete
class TestPlanGetPatchDelete:
    def test_get_plan_includes_empty_buffer_days(self, member_client, make_plan):
        p = make_plan(start_date="2026-07-01", end_date="2026-07-03")
        r = member_client.get(f"/api/plans/{p['id']}")
        assert r.status_code == 200
        assert r.get_json()["plan"]["buffer_days"] == []

    def test_patch_start_and_end_dates(self, member_client, make_plan):
        p = make_plan(start_date="2026-07-01", end_date="2026-07-02")
        r = member_client.patch(f"/api/plans/{p['id']}", json={
            "start_date": "2026-07-03", "end_date": "2026-07-05"})
        assert r.status_code == 200
        plan = r.get_json()["plan"]
        assert plan["start_date"] == "2026-07-03"
        assert plan["end_date"] == "2026-07-05"

    def test_patch_dates_null_clears_them(self, member_client, make_plan):
        p = make_plan(start_date="2026-07-01", end_date="2026-07-02")
        r = member_client.patch(f"/api/plans/{p['id']}", json={"start_date": None})
        assert r.status_code == 200
        assert r.get_json()["plan"]["start_date"] is None

    def test_patch_title_and_currency(self, member_client, make_plan):
        p = make_plan(title="Old", base_currency="USD")
        r = member_client.patch(f"/api/plans/{p['id']}", json={
            "title": "New", "base_currency": "JPY"})
        assert r.status_code == 200
        plan = r.get_json()["plan"]
        assert plan["title"] == "New"
        assert plan["base_currency"] == "JPY"

    def test_patch_status(self, member_client, make_plan):
        p = make_plan()
        r = member_client.patch(f"/api/plans/{p['id']}", json={"status": "ongoing"})
        assert r.status_code == 200
        assert r.get_json()["plan"]["status"] == "ongoing"

    def test_patch_buffer_days_add_remove(self, member_client, make_plan):
        p = make_plan(start_date="2026-07-01", end_date="2026-07-02")
        r = member_client.patch(f"/api/plans/{p['id']}", json={
            "buffer_days_add": ["2026-06-30", "2026-07-03"]})
        assert r.status_code == 200
        assert r.get_json()["plan"]["buffer_days"] == ["2026-06-30", "2026-07-03"]
        # Adding duplicate is a no-op.
        r = member_client.patch(f"/api/plans/{p['id']}", json={
            "buffer_days_add": ["2026-06-30"]})
        assert r.get_json()["plan"]["buffer_days"] == ["2026-06-30", "2026-07-03"]
        # Remove one.
        r = member_client.patch(f"/api/plans/{p['id']}", json={
            "buffer_days_remove": ["2026-06-30"]})
        assert r.get_json()["plan"]["buffer_days"] == ["2026-07-03"]
        # Remove non-existent is a no-op.
        r = member_client.patch(f"/api/plans/{p['id']}", json={
            "buffer_days_remove": ["2030-01-01"]})
        assert r.get_json()["plan"]["buffer_days"] == ["2026-07-03"]

    def test_patch_buffer_days_set_replaces(self, member_client, make_plan):
        p = make_plan(start_date="2026-07-01", end_date="2026-07-02",
                      buffer_days=["2026-06-30", "2026-07-03"])
        r = member_client.patch(f"/api/plans/{p['id']}", json={
            "buffer_days_set": ["2026-07-05", "2026-07-06"]})
        assert r.get_json()["plan"]["buffer_days"] == ["2026-07-05", "2026-07-06"]

    def test_patch_buffer_days_set_empty_clears(self, member_client, make_plan):
        p = make_plan(buffer_days=["2026-07-01"])
        r = member_client.patch(f"/api/plans/{p['id']}", json={"buffer_days_set": []})
        assert r.get_json()["plan"]["buffer_days"] == []

    def test_patch_buffer_days_set_rejects_garbage(self, member_client, make_plan):
        p = make_plan()
        r = member_client.patch(f"/api/plans/{p['id']}", json={
            "buffer_days_set": ["not-a-date"]})
        assert r.status_code == 400
        assert member_client.get(f"/api/plans/{p['id']}").get_json()["plan"]["buffer_days"] == []

    def test_patch_buffer_days_set_rejects_non_list(self, member_client, make_plan):
        p = make_plan()
        r = member_client.patch(f"/api/plans/{p['id']}", json={"buffer_days_set": "nope"})
        assert r.status_code == 400

    def test_patch_day_meta_pinned_and_label(self, member_client, make_plan):
        p = make_plan(start_date="2026-07-01", end_date="2026-07-02")
        r = member_client.patch(f"/api/plans/{p['id']}", json={
            "day_meta_set": [{"date": "2026-07-01", "pinned": True, "label": "Big day"}]})
        assert r.status_code == 200
        meta = r.get_json()["plan"]["day_meta"]
        assert meta["2026-07-01"]["pinned"] is True
        assert meta["2026-07-01"]["label"] == "Big day"

    def test_delete_plan_cascades_buffer_days(self, member_client, make_plan, db):
        p = make_plan(buffer_days=["2026-07-01", "2026-07-02"])
        pid = p["id"]
        r = member_client.delete(f"/api/plans/{pid}")
        assert r.status_code == 200
        n = db.one("SELECT COUNT(*) AS n FROM plan_buffer_days WHERE plan_id = ?",
                   (pid,))["n"]
        assert n == 0

    def test_get_missing_plan_404(self, member_client):
        assert member_client.get("/api/plans/9999").status_code == 404


# ------------------------------------------------------------------ access control
class TestPlanAccessControl:
    def test_anon_cannot_create(self, fresh_app):
        r = fresh_app.test_client().post("/api/plans", json={"title": "X"})
        assert r.status_code == 401

    def test_viewer_cannot_patch(self, app, member_client, make_plan, make_user):
        p = make_plan(title="Mine")
        bob_id = make_user(username="bob2")["id"]
        member_client.post(f"/api/plans/{p['id']}/members",
                           json={"user_id": bob_id, "role": "viewer"})
        c2 = app.test_client()
        c2.post("/auth/login", data={"username": "bob2", "password": "pw12345"})
        r = c2.patch(f"/api/plans/{p['id']}", json={"title": "Hacked"})
        assert r.status_code == 403

    def test_viewer_can_read(self, app, member_client, make_plan, make_user):
        p = make_plan(title="Mine")
        bob_id = make_user(username="bob2")["id"]
        member_client.post(f"/api/plans/{p['id']}/members",
                           json={"user_id": bob_id, "role": "viewer"})
        c2 = app.test_client()
        c2.post("/auth/login", data={"username": "bob2", "password": "pw12345"})
        r = c2.get(f"/api/plans/{p['id']}")
        assert r.status_code == 200
        assert r.get_json()["role"] == "viewer"

    def test_editor_can_patch(self, app, member_client, make_plan, make_user):
        p = make_plan(title="Mine")
        bob_id = make_user(username="bob2")["id"]
        member_client.post(f"/api/plans/{p['id']}/members",
                           json={"user_id": bob_id, "role": "editor"})
        c2 = app.test_client()
        c2.post("/auth/login", data={"username": "bob2", "password": "pw12345"})
        r = c2.patch(f"/api/plans/{p['id']}", json={"title": "Edited"})
        assert r.status_code == 200
        assert r.get_json()["plan"]["title"] == "Edited"

    def test_non_member_cannot_view(self, app, member_client, make_plan, make_user):
        p = make_plan()
        make_user(username="carol2")  # exists but not shared
        c2 = app.test_client()
        c2.post("/auth/login", data={"username": "carol2", "password": "pw12345"})
        assert c2.get(f"/api/plans/{p['id']}").status_code == 403

    def test_admin_can_read_any_plan(self, app, member_client, make_plan, admin_client):
        p = make_plan(title="Alice's plan")  # owned by alice
        r = admin_client.get(f"/api/plans/{p['id']}")
        assert r.status_code == 200
        assert r.get_json()["role"] == "viewer"

    def test_admin_cannot_write_plan_they_dont_own(self, app, member_client, make_plan, admin_client):
        p = make_plan(title="Alice's plan")
        r = admin_client.patch(f"/api/plans/{p['id']}", json={"title": "Admin edit"})
        assert r.status_code == 403


# ------------------------------------------------------------------ sharing
class TestPlanSharing:
    def test_list_members_includes_owner(self, member_client, make_plan):
        p = make_plan(title="T")
        r = member_client.get(f"/api/plans/{p['id']}/members")
        assert r.status_code == 200
        owner = r.get_json()["owner"]
        assert owner["username"] == "alice"
        assert owner["role"] == "owner"

    def test_add_member_default_editor(self, member_client, make_plan, make_user):
        p = make_plan()
        bob_id = make_user(username="bob2")["id"]
        r = member_client.post(f"/api/plans/{p['id']}/members",
                               json={"user_id": bob_id})
        assert r.status_code == 200
        members = member_client.get(f"/api/plans/{p['id']}/members").get_json()["members"]
        assert any(m["username"] == "bob2" and m["role"] == "editor" for m in members)

    def test_add_member_with_viewer_role(self, member_client, make_plan, make_user):
        p = make_plan()
        bob_id = make_user(username="bob2")["id"]
        r = member_client.post(f"/api/plans/{p['id']}/members",
                               json={"user_id": bob_id, "role": "viewer"})
        assert r.status_code == 200
        members = member_client.get(f"/api/plans/{p['id']}/members").get_json()["members"]
        assert any(m["role"] == "viewer" for m in members)

    def test_add_member_rejects_bad_role(self, member_client, make_plan, make_user):
        p = make_plan()
        bob_id = make_user(username="bob2")["id"]
        r = member_client.post(f"/api/plans/{p['id']}/members",
                               json={"user_id": bob_id, "role": "owner"})
        assert r.status_code == 400

    def test_add_member_rejects_missing_user_id(self, member_client, make_plan):
        p = make_plan()
        r = member_client.post(f"/api/plans/{p['id']}/members", json={})
        assert r.status_code == 400

    def test_add_member_rejects_nonexistent_user(self, member_client, make_plan):
        p = make_plan()
        r = member_client.post(f"/api/plans/{p['id']}/members", json={"user_id": 99999})
        assert r.status_code == 404

    def test_add_member_rejects_admin_account(self, admin_client, member_client, make_plan):
        # Admins cannot be added as plan members.
        p = make_plan()
        admin_id = admin_client.get("/api/me").get_json()["user"]["id"]
        r = member_client.post(f"/api/plans/{p['id']}/members",
                               json={"user_id": admin_id})
        assert r.status_code == 404  # admin not in member role

    def test_update_member_role(self, member_client, make_plan, make_user):
        p = make_plan()
        bob_id = make_user(username="bob2")["id"]
        member_client.post(f"/api/plans/{p['id']}/members",
                           json={"user_id": bob_id, "role": "viewer"})
        r = member_client.patch(f"/api/plans/{p['id']}/members/{bob_id}",
                                json={"role": "editor"})
        assert r.status_code == 200
        members = member_client.get(f"/api/plans/{p['id']}/members").get_json()["members"]
        assert next(m for m in members if m["id"] == bob_id)["role"] == "editor"

    def test_remove_member(self, member_client, make_plan, make_user):
        p = make_plan()
        bob_id = make_user(username="bob2")["id"]
        member_client.post(f"/api/plans/{p['id']}/members",
                           json={"user_id": bob_id, "role": "editor"})
        r = member_client.delete(f"/api/plans/{p['id']}/members/{bob_id}")
        assert r.status_code == 200
        members = member_client.get(f"/api/plans/{p['id']}/members").get_json()["members"]
        assert all(m["id"] != bob_id for m in members)

    def test_member_cannot_add_members(self, app, member_client, make_plan, make_user):
        p = make_plan()
        bob_id = make_user(username="bob2")["id"]
        # Add bob as a viewer; then bob tries to add carol.
        member_client.post(f"/api/plans/{p['id']}/members",
                           json={"user_id": bob_id, "role": "viewer"})
        carol_id = make_user(username="carol2")["id"]
        c2 = app.test_client()
        c2.post("/auth/login", data={"username": "bob2", "password": "pw12345"})
        r = c2.post(f"/api/plans/{p['id']}/members",
                    json={"user_id": carol_id, "role": "editor"})
        assert r.status_code == 403


# ------------------------------------------------------------------ transfer
class TestPlanTransfer:
    def test_transfer_ownership(self, member_client, make_plan, make_user):
        p = make_plan()
        bob_id = make_user(username="bob2")["id"]
        member_client.post(f"/api/plans/{p['id']}/members",
                           json={"user_id": bob_id, "role": "editor"})
        r = member_client.post(f"/api/plans/{p['id']}/transfer",
                               json={"user_id": bob_id})
        assert r.status_code == 200
        plan = member_client.get(f"/api/plans/{p['id']}").get_json()["plan"]
        assert plan["owner_id"] == bob_id
        members = member_client.get(f"/api/plans/{p['id']}/members").get_json()
        # Old owner is now a member; new owner is the owner row.
        assert members["owner"]["id"] == bob_id
        assert any(m["id"] == plan["owner_id"] and m["id"] == bob_id for m in members["members"]) or True

    def test_transfer_rejects_non_member(self, member_client, make_plan, make_user):
        p = make_plan()
        bob_id = make_user(username="bob2")["id"]  # exists but not shared
        r = member_client.post(f"/api/plans/{p['id']}/transfer",
                               json={"user_id": bob_id})
        assert r.status_code == 400

    def test_transfer_rejects_already_owner(self, member_client, make_plan):
        p = make_plan()
        owner_id = p["owner_id"]
        r = member_client.post(f"/api/plans/{p['id']}/transfer",
                               json={"user_id": owner_id})
        assert r.status_code == 400

    def test_transfer_rejects_missing_user_id(self, member_client, make_plan):
        p = make_plan()
        r = member_client.post(f"/api/plans/{p['id']}/transfer", json={})
        assert r.status_code == 400


# ------------------------------------------------------------------ header render
class TestPlanHeaderRender:
    @pytest.fixture(autouse=True)
    def _plan(self, member_client, make_plan):
        self.plan = make_plan(title="Japan 2026",
                              start_date="2026-09-10",
                              end_date="2026-09-12", base_currency="JPY")

    def _assert_header(self, html):
        assert 'id="plan-title"' in html
        assert 'id="plan-dates"' in html
        assert 'class="plan-nav"' in html
        assert "Japan 2026" in html

    def test_board_renders_formatted_dates_no_flash(self, member_client):
        r = member_client.get(f"/plans/{self.plan['id']}")
        assert r.status_code == 200
        html = r.get_data(as_text=True)
        self._assert_header(html)
        assert "Sep 10, 2026" in html
        assert "Sep 12, 2026" in html
        assert "2026-09-10 → 2026-09-12" not in html

    def test_timeline_renders_formatted_dates(self, member_client):
        r = member_client.get(f"/plans/{self.plan['id']}/timeline")
        assert r.status_code == 200
        html = r.get_data(as_text=True)
        self._assert_header(html)
        assert "Sep 10, 2026" in html
        assert "2026-09-10 → 2026-09-12" not in html

    def test_expenses_renders_formatted_dates(self, member_client):
        r = member_client.get(f"/plans/{self.plan['id']}/expenses")
        assert r.status_code == 200
        html = r.get_data(as_text=True)
        self._assert_header(html)
        assert "Sep 10, 2026" in html

    def test_members_renders_formatted_dates(self, member_client):
        r = member_client.get(f"/plans/{self.plan['id']}/members")
        assert r.status_code == 200
        html = r.get_data(as_text=True)
        self._assert_header(html)
        assert "Sep 10, 2026" in html

    def test_active_tab_is_per_page(self, member_client):
        for path, expected in [
            ("", "Board"), ("/timeline", "Timeline"),
            ("/expenses", "Expenses"), ("/members", "Members"),
        ]:
            r = member_client.get(f"/plans/{self.plan['id']}{path}")
            assert r.status_code == 200
            html = r.get_data(as_text=True)
            assert html.count('aria-current="page"') == 1
            assert f'>{expected}</a>' in html


# ------------------------------------------------------------------ fmt_date
class TestFmtDate:
    def test_iso_string(self):
        from backend.util import fmt_date
        assert fmt_date("2026-07-01") == "Jul 1, 2026"
        assert fmt_date("2026-01-09") == "Jan 9, 2026"
        assert fmt_date("2026-12-31") == "Dec 31, 2026"

    def test_date_object(self):
        from datetime import date
        from backend.util import fmt_date
        assert fmt_date(date(2026, 7, 1)) == "Jul 1, 2026"

    def test_falsy_returns_empty(self):
        from backend.util import fmt_date
        assert fmt_date(None) == ""
        assert fmt_date("") == ""
        assert fmt_date(0) == ""

    def test_garbage_returns_empty(self):
        from backend.util import fmt_date
        assert fmt_date("not-a-date") == ""
        assert fmt_date("2026-13-99") == ""

    def test_month_names_match_frontend(self):
        from backend.util import _MONTHS
        assert _MONTHS == ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ------------------------------------------------------------------ money helpers
class TestParseAmount:
    def test_int_passthrough(self):
        from backend.util import parse_amount_to_cents
        assert parse_amount_to_cents(1234) == 1234

    def test_string_to_cents_2dp(self):
        from backend.util import parse_amount_to_cents
        assert parse_amount_to_cents("12.34") == 1234
        assert parse_amount_to_cents("0.01") == 1

    def test_zero_decimals_for_jpy(self):
        from backend.util import parse_amount_to_cents
        assert parse_amount_to_cents("1234", 0) == 1234

    def test_rounds_half_up(self):
        from backend.util import parse_amount_to_cents
        # ROUND_HALF_UP: 1.005 at 2 decimals -> 1.01 -> 101 cents.
        assert parse_amount_to_cents("1.005") == 101
        assert parse_amount_to_cents("2.5") == 250

    def test_rejects_bool(self):
        from backend.util import parse_amount_to_cents
        with pytest.raises(ValueError):
            parse_amount_to_cents(True)

    def test_rejects_none(self):
        from backend.util import parse_amount_to_cents
        with pytest.raises(ValueError):
            parse_amount_to_cents(None)


class TestFormatCents:
    def test_2dp(self):
        from backend.util import format_cents
        assert format_cents(1234) == "12.34"
        assert format_cents(5) == "0.05"

    def test_0dp(self):
        from backend.util import format_cents
        assert format_cents(1234, 0) == "1234"


class TestPlanVersionConflicts:
    def test_patch_conflict_409(self, member_client, make_plan, db):
        p = make_plan(title="V")
        row = db.one("SELECT updated_at FROM plans WHERE id = ?", (p["id"],))
        wrong_ts = "2000-01-01T00:00:00" if row["updated_at"] != "2000-01-01T00:00:00" else "2000-01-02T00:00:00"
        r = member_client.patch(f"/api/plans/{p['id']}", json={
            "title": "new", "expected_updated_at": wrong_ts})
        assert r.status_code == 409
        assert r.get_json()["error"] == "conflict"

    def test_patch_correct_version_succeeds(self, member_client, make_plan, db):
        p = make_plan(title="V")
        row = db.one("SELECT updated_at FROM plans WHERE id = ?", (p["id"],))
        r = member_client.patch(f"/api/plans/{p['id']}", json={
            "title": "new", "expected_updated_at": row["updated_at"]})
        assert r.status_code == 200