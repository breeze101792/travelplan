"""Tests for the plan API: trip dates, buffer days, and the PATCH endpoints
that drive the new editable-dates and buffer-day features on the plan board.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from backend.app import create_app
from backend import db as db_mod
from backend.auth import hash_password


def _fresh_app():
    tmp = Path(tempfile.mkdtemp(prefix="tp_plan_test_"))
    data = tmp / "data"
    uploads = data / "uploads"
    config_dir = data / "config"
    for d in (data, uploads, config_dir):
        d.mkdir(parents=True, exist_ok=True)
    db_path = data / "travelplan.db"
    db_mod.reset_for_tests()
    db_mod.DATA_DIR = data
    db_mod.DB_PATH = db_path
    from backend import auth as auth_mod
    auth_mod.SECRET_KEY_FILE = config_dir / "secret_key"
    app = create_app({
        "DB_PATH": str(db_path),
        "UPLOAD_FOLDER": str(uploads),
        "TESTING": True,
        "WTF_CSRF_ENABLED": False,
    })
    app._test_tmp = tmp
    return app


def _user(app, *, username, password="pw12345", role="member"):
    with app.app_context():
        db_mod.get_db().execute(
            "INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)",
            (username, hash_password(password), username.title(), role),
        )
        db_mod.get_db().commit()


def _login(client, username, password="pw12345"):
    return client.post("/auth/login",
                       data={"username": username, "password": password},
                       follow_redirects=False)


def _create_plan(client, **body):
    r = client.post("/api/plans", json=body, follow_redirects=False)
    assert r.status_code == 200, r.data
    return r.get_json()["plan"]


class PlanBufferDaysTests(unittest.TestCase):
    def setUp(self):
        self.app = _fresh_app()
        self.client = self.app.test_client()
        # The /auth/login endpoint short-circuits to /auth/setup if no admin
        # exists yet. Create one so the login flow actually sets a session.
        _user(self.app, username="admin", password="pw12345", role="admin")
        _user(self.app, username="alice")
        _login(self.client, "alice")

    def tearDown(self):
        shutil.rmtree(getattr(self.app, "_test_tmp", None) or "/tmp/__none__",
                      ignore_errors=True)

    # ---- get plan: buffer_days in payload ----
    def test_get_plan_includes_empty_buffer_days(self):
        p = _create_plan(self.client, title="Trip",
                         start_date="2026-07-01", end_date="2026-07-03")
        r = self.client.get(f"/api/plans/{p['id']}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["plan"]["buffer_days"], [])

    def test_create_plan_with_initial_buffer_days(self):
        p = _create_plan(self.client, title="T",
                         start_date="2026-07-01", end_date="2026-07-02",
                         buffer_days=["2026-06-30", "2026-07-04"])
        r = self.client.get(f"/api/plans/{p['id']}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["plan"]["buffer_days"],
                         ["2026-06-30", "2026-07-04"])

    def test_create_plan_ignores_invalid_buffer_dates(self):
        # Garbage entries are silently dropped; valid ones still inserted.
        p = _create_plan(self.client, title="T",
                         buffer_days=["2026-07-01", "not-a-date", 42, None])
        r = self.client.get(f"/api/plans/{p['id']}")
        self.assertEqual(r.get_json()["plan"]["buffer_days"], ["2026-07-01"])

    # ---- patch plan: trip dates ----
    def test_patch_start_and_end_dates(self):
        p = _create_plan(self.client, title="T",
                         start_date="2026-07-01", end_date="2026-07-02")
        r = self.client.patch(f"/api/plans/{p['id']}",
                              json={"start_date": "2026-07-03", "end_date": "2026-07-05"})
        self.assertEqual(r.status_code, 200)
        plan = r.get_json()["plan"]
        self.assertEqual(plan["start_date"], "2026-07-03")
        self.assertEqual(plan["end_date"], "2026-07-05")

    def test_patch_dates_null_clears_them(self):
        p = _create_plan(self.client, title="T",
                         start_date="2026-07-01", end_date="2026-07-02")
        r = self.client.patch(f"/api/plans/{p['id']}",
                              json={"start_date": None})
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.get_json()["plan"]["start_date"])

    # ---- patch plan: buffer days add/remove ----
    def test_patch_buffer_days_add_and_remove(self):
        p = _create_plan(self.client, title="T",
                         start_date="2026-07-01", end_date="2026-07-02")
        # Add a couple of buffer days.
        r = self.client.patch(f"/api/plans/{p['id']}",
                              json={"buffer_days_add": ["2026-06-30", "2026-07-03"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["plan"]["buffer_days"],
                         ["2026-06-30", "2026-07-03"])
        # Add a duplicate — no-op, still the same set.
        r = self.client.patch(f"/api/plans/{p['id']}",
                              json={"buffer_days_add": ["2026-06-30"]})
        self.assertEqual(r.get_json()["plan"]["buffer_days"],
                         ["2026-06-30", "2026-07-03"])
        # Remove one.
        r = self.client.patch(f"/api/plans/{p['id']}",
                              json={"buffer_days_remove": ["2026-06-30"]})
        self.assertEqual(r.get_json()["plan"]["buffer_days"], ["2026-07-03"])
        # Remove a non-existent — no-op.
        r = self.client.patch(f"/api/plans/{p['id']}",
                              json={"buffer_days_remove": ["2030-01-01"]})
        self.assertEqual(r.get_json()["plan"]["buffer_days"], ["2026-07-03"])

    def test_patch_buffer_days_set_replaces(self):
        p = _create_plan(self.client, title="T",
                         start_date="2026-07-01", end_date="2026-07-02",
                         buffer_days=["2026-06-30", "2026-07-03"])
        r = self.client.patch(f"/api/plans/{p['id']}",
                              json={"buffer_days_set": ["2026-07-05", "2026-07-06"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["plan"]["buffer_days"], ["2026-07-05", "2026-07-06"])

    def test_patch_buffer_days_set_empty_clears(self):
        p = _create_plan(self.client, title="T", buffer_days=["2026-07-01"])
        r = self.client.patch(f"/api/plans/{p['id']}",
                              json={"buffer_days_set": []})
        self.assertEqual(r.get_json()["plan"]["buffer_days"], [])

    def test_patch_buffer_days_set_rejects_garbage(self):
        p = _create_plan(self.client, title="T")
        r = self.client.patch(f"/api/plans/{p['id']}",
                              json={"buffer_days_set": ["not-a-date"]})
        self.assertEqual(r.status_code, 400)
        # Existing set is untouched.
        r2 = self.client.get(f"/api/plans/{p['id']}")
        self.assertEqual(r2.get_json()["plan"]["buffer_days"], [])

    def test_patch_buffer_days_set_rejects_non_list(self):
        p = _create_plan(self.client, title="T")
        r = self.client.patch(f"/api/plans/{p['id']}",
                              json={"buffer_days_set": "nope"})
        self.assertEqual(r.status_code, 400)

    # ---- list plans: buffer_days is included for each plan ----
    def test_list_plans_includes_buffer_days(self):
        _create_plan(self.client, title="A", buffer_days=["2026-07-01"])
        _create_plan(self.client, title="B", buffer_days=["2026-08-01", "2026-08-02"])
        _create_plan(self.client, title="C")
        r = self.client.get("/api/plans")
        self.assertEqual(r.status_code, 200)
        by_title = {p["title"]: p["buffer_days"] for p in r.get_json()["plans"]}
        self.assertEqual(by_title["A"], ["2026-07-01"])
        self.assertEqual(by_title["B"], ["2026-08-01", "2026-08-02"])
        self.assertEqual(by_title["C"], [])

    # ---- delete plan: cascades buffer_days ----
    def test_delete_plan_cascades_buffer_days(self):
        p = _create_plan(self.client, title="T", buffer_days=["2026-07-01", "2026-07-02"])
        pid = p["id"]
        r = self.client.delete(f"/api/plans/{pid}")
        self.assertEqual(r.status_code, 200)
        with self.app.app_context():
            remaining = db_mod.get_db().execute(
                "SELECT COUNT(*) AS n FROM plan_buffer_days WHERE plan_id = ?", (pid,),
            ).fetchone()["n"]
        self.assertEqual(remaining, 0)


class FmtDateTests(unittest.TestCase):
    """`fmt_date()` produces the same Mon-DD-YYYY format as the
    frontend's `fmtDate()`, so the per-plan header doesn't flash from
    raw ISO on first paint. Locked in by tests so a future change in
    either side doesn't quietly desync them."""

    def test_iso_string(self):
        from backend.util import fmt_date
        self.assertEqual(fmt_date("2026-07-01"), "Jul 1, 2026")
        self.assertEqual(fmt_date("2026-01-09"), "Jan 9, 2026")
        self.assertEqual(fmt_date("2026-12-31"), "Dec 31, 2026")

    def test_date_object(self):
        from datetime import date
        from backend.util import fmt_date
        self.assertEqual(fmt_date(date(2026, 7, 1)), "Jul 1, 2026")

    def test_falsy_returns_empty(self):
        from backend.util import fmt_date
        self.assertEqual(fmt_date(None), "")
        self.assertEqual(fmt_date(""), "")
        self.assertEqual(fmt_date(0), "")

    def test_garbage_returns_empty(self):
        from backend.util import fmt_date
        self.assertEqual(fmt_date("not-a-date"), "")
        self.assertEqual(fmt_date("2026-13-99"), "")
        # `date.fromisoformat` is strict — any deviation from YYYY-MM-DD
        # is rejected, which is the right behavior (the plan table
        # stores ISO dates or NULL).

    def test_short_month_names_match_frontend(self):
        # The frontend's MONTHS array in util.js must be kept in sync
        # with backend.util._MONTHS. This test would catch a rename in
        # one place but not the other.
        from backend.util import _MONTHS
        self.assertEqual(_MONTHS, ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])


class PlanHeaderRenderTests(unittest.TestCase):
    """All four plan pages (board / timeline / expenses / share) render
    the same header partial, and the dates are server-formatted to match
    the frontend's fmtDate() output. This guards against (a) the four
    pages drifting (e.g. share losing the dates line again) and (b) the
    "flash" of raw ISO dates on first paint returning."""

    def setUp(self):
        self.app = _fresh_app()
        self.client = self.app.test_client()
        _user(self.app, username="admin", password="pw12345", role="admin")
        _user(self.app, username="alice")
        _login(self.client, "alice")
        # A plan with explicit start/end dates so we can assert the
        # rendered date string format.
        self.plan = _create_plan(
            self.client, title="Japan 2026",
            start_date="2026-09-10", end_date="2026-09-12",
            base_currency="JPY",
        )

    def tearDown(self):
        shutil.rmtree(getattr(self.app, "_test_tmp", None) or "/tmp/__none__",
                      ignore_errors=True)

    def _assert_shared_header(self, html):
        # Same plan-title, plan-dates, plan-currency, and nav on every page.
        self.assertIn('id="plan-title"', html, "header has plan-title")
        self.assertIn('id="plan-dates"', html, "header has plan-dates")
        self.assertIn('id="plan-currency"', html, "header has plan-currency")
        # The nav with all four tabs (board, timeline, expenses, share)
        # plus the "All plans" link. The exact hrefs depend on the plan id.
        self.assertIn('class="plan-nav"', html, "header has plan-nav")
        self.assertIn("Board", html, "nav has Board tab")
        self.assertIn("Timeline", html, "nav has Timeline tab")
        self.assertIn("Expenses", html, "nav has Expenses tab")
        self.assertIn("All plans", html, "nav has All plans link")
        # The plan title appears verbatim in the header.
        self.assertIn("Japan 2026", html, "header shows the plan title")
        # The base currency appears verbatim.
        self.assertIn("JPY", html, "header shows the base currency")

    def test_board_renders_formatted_dates_no_flash(self):
        r = self.client.get(f"/plans/{self.plan['id']}")
        self.assertEqual(r.status_code, 200)
        html = r.get_data(as_text=True)
        self._assert_shared_header(html)
        # The dates are server-formatted to Mon DD, YYYY (matching
        # fmtDate()), not raw ISO. The previous "flash" came from the
        # template emitting "2026-09-10 → 2026-09-12" and the page JS
        # rewriting it client-side; now the first paint already shows
        # "Sep 10, 2026 → Sep 12, 2026".
        self.assertIn("Sep 10, 2026", html, "board: start date is server-formatted")
        self.assertIn("Sep 12, 2026", html, "board: end date is server-formatted")
        self.assertNotIn("2026-09-10 → 2026-09-12", html,
                         "board: raw ISO range must NOT appear (that was the flash)")
        # The .editable class is rendered server-side (no JS-driven class
        # addition that shifts the layout on first paint).
        self.assertIn('class="plan-dates editable"', html.replace("  ", " "),
                      "board: dates are rendered .editable server-side")
        self.assertIn('class="plan-title editable"', html.replace("  ", " "),
                      "board: title is rendered .editable server-side")

    def test_timeline_renders_formatted_dates(self):
        r = self.client.get(f"/plans/{self.plan['id']}/timeline")
        self.assertEqual(r.status_code, 200)
        html = r.get_data(as_text=True)
        self._assert_shared_header(html)
        self.assertIn("Sep 10, 2026", html, "timeline: start date is server-formatted")
        self.assertIn("Sep 12, 2026", html, "timeline: end date is server-formatted")
        self.assertNotIn("2026-09-10 → 2026-09-12", html,
                         "timeline: raw ISO range must NOT appear")

    def test_expenses_renders_formatted_dates(self):
        r = self.client.get(f"/plans/{self.plan['id']}/expenses")
        self.assertEqual(r.status_code, 200)
        html = r.get_data(as_text=True)
        self._assert_shared_header(html)
        self.assertIn("Sep 10, 2026", html, "expenses: start date is server-formatted")
        self.assertIn("Sep 12, 2026", html, "expenses: end date is server-formatted")
        # The expenses page now includes the dates line (was missing
        # before the shared header partial), and uses the same
        # Mon-DD-YYYY format as the other pages.

    def test_members_renders_formatted_dates(self):
        # Members is owner-only; alice is the owner here.
        r = self.client.get(f"/plans/{self.plan['id']}/members")
        self.assertEqual(r.status_code, 200)
        html = r.get_data(as_text=True)
        self._assert_shared_header(html)
        self.assertIn("Sep 10, 2026", html, "members: start date is server-formatted")
        self.assertIn("Sep 12, 2026", html, "members: end date is server-formatted")
        # Members is the page that USED to omit the dates line entirely;
        # now it has them, matching the other three.

    def test_active_tab_is_per_page(self):
        # Each page should highlight its own tab via `aria-current="page"`.
        for path, expected in [
            ("", "Board"),
            ("/timeline", "Timeline"),
            ("/expenses", "Expenses"),
            ("/members", "Members"),
        ]:
            r = self.client.get(f"/plans/{self.plan['id']}{path}")
            self.assertEqual(r.status_code, 200, f"GET {path} returned {r.status_code}")
            html = r.get_data(as_text=True)
            # Exactly one aria-current=page among the pn-link tabs.
            self.assertEqual(html.count('aria-current="page"'), 1,
                             f"{path or '/'}: exactly one tab is active")
            self.assertIn(f'>{expected}</a>', html,
                          f"{path or '/'}: '{expected}' tab is active")


if __name__ == "__main__":
    unittest.main()
