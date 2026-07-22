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


if __name__ == "__main__":
    unittest.main()
