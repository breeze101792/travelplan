"""Tests for the auth self-serve settings page: anonymous redirect, the
display-name and password change forms, and every rejection path for the
password change. Admin user management is covered by the legacy
/auth/members page and is not exercised here (the new settings page is
self-serve only).
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from backend.app import create_app
from backend import db as db_mod


def _fresh_app():
    """A Flask app whose data dir is a fresh temp directory.

    Patches the module-level DATA_DIR / DB_PATH *before* the app is built
    (init_db reads them at startup) and drops the cached shared connection
    from any prior test, so the new dir's schema is actually seen.
    """
    tmp = Path(tempfile.mkdtemp(prefix="tp_auth_test_"))
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


def _create_user(app, *, username, password, display_name, role="member"):
    from backend.auth import hash_password
    with app.app_context():
        db_mod.get_db().execute(
            "INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)",
            (username, hash_password(password), display_name, role),
        )
        db_mod.get_db().commit()


def _login(client, username, password):
    return client.post("/auth/login", data={"username": username, "password": password}, follow_redirects=False)


def _logout(client):
    # /auth/logout is a GET endpoint (the topbar uses <a href>).
    return client.get("/auth/logout", follow_redirects=False)


class AuthSettingsTests(unittest.TestCase):
    def setUp(self):
        # Fresh app + temp data dir per test so state (DB rows, sessions)
        # never leaks between tests. Each test is fully self-contained.
        self.app = _fresh_app()
        self.client = self.app.test_client()
        _create_user(self.app, username="admin", password="password", display_name="Admin", role="admin")
        _create_user(self.app, username="alice", password="password", display_name="Alice Wang", role="member")

    def tearDown(self):
        shutil.rmtree(getattr(self.app, "_test_tmp", None) or "/tmp/__none__", ignore_errors=True)

    # ---- access control ----
    def test_anon_redirected_to_login(self):
        r = self.client.get("/auth/settings")
        self.assertEqual(r.status_code, 302)
        self.assertIn("/auth/login", r.headers["Location"])

    def test_settings_page_renders_for_member(self):
        _login(self.client, "alice", "password")
        r = self.client.get("/auth/settings")
        self.assertEqual(r.status_code, 200)
        self.assertIn(b"Your account", r.data)
        # The page is self-serve only; no member-management UI.
        self.assertNotIn(b"Existing accounts", r.data)
        self.assertNotIn(b"Create member", r.data)

    def test_settings_page_renders_for_admin(self):
        _login(self.client, "admin", "password")
        r = self.client.get("/auth/settings")
        self.assertEqual(r.status_code, 200)
        self.assertIn(b"Your account", r.data)
        # Admins still don't see member management here — that's on /auth/members.
        self.assertNotIn(b"Existing accounts", r.data)
        self.assertNotIn(b"Create member", r.data)
        # A small hint links to the members page instead.
        self.assertIn(b"/auth/members", r.data)

    # ---- self-serve: change own display name ----
    def test_change_own_display_name_updates_session(self):
        _login(self.client, "alice", "password")
        r = self.client.post("/auth/settings/profile",
                             data={"display_name": "Alice (renamed)"},
                             follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        # Page and topbar both reflect the new name.
        r = self.client.get("/auth/settings")
        self.assertIn(b"Alice (renamed)", r.data)
        self.assertIn(b'<span class="me">Alice (renamed)</span>', r.data)
        with self.app.app_context():
            row = db_mod.get_db().execute("SELECT display_name FROM users WHERE username='alice'").fetchone()
            self.assertEqual(row["display_name"], "Alice (renamed)")

    def test_change_own_display_name_rejects_blank(self):
        _login(self.client, "alice", "password")
        r = self.client.post("/auth/settings/profile", data={"display_name": "  "}, follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        self.assertIn("error=", r.headers["Location"])

    # ---- self-serve: change own password ----
    def test_change_own_password_happy_path(self):
        _login(self.client, "alice", "password")
        r = self.client.post("/auth/settings/password", data={
            "current_password": "password",
            "new_password": "newsecret1",
            "confirm_password": "newsecret1",
        }, follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        # Old password rejected, new one accepted.
        _logout(self.client)
        self.assertEqual(_login(self.client, "alice", "password").status_code, 200)
        _logout(self.client)
        self.assertEqual(_login(self.client, "alice", "newsecret1").status_code, 302)

    def test_change_own_password_rejects_wrong_current(self):
        _login(self.client, "alice", "password")
        r = self.client.post("/auth/settings/password", data={
            "current_password": "WRONG",
            "new_password": "newsecret1",
            "confirm_password": "newsecret1",
        }, follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        self.assertIn("error=", r.headers["Location"])
        # Password unchanged.
        _logout(self.client)
        self.assertEqual(_login(self.client, "alice", "password").status_code, 302)

    def test_change_own_password_rejects_short_new(self):
        _login(self.client, "alice", "password")
        r = self.client.post("/auth/settings/password", data={
            "current_password": "password",
            "new_password": "short",
            "confirm_password": "short",
        }, follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        self.assertIn("error=", r.headers["Location"])
        _logout(self.client)
        self.assertEqual(_login(self.client, "alice", "password").status_code, 302)

    def test_change_own_password_rejects_mismatched_confirm(self):
        _login(self.client, "alice", "password")
        r = self.client.post("/auth/settings/password", data={
            "current_password": "password",
            "new_password": "newsecret1",
            "confirm_password": "DIFFERENT",
        }, follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        self.assertIn("error=", r.headers["Location"])
        _logout(self.client)
        self.assertEqual(_login(self.client, "alice", "password").status_code, 302)


if __name__ == "__main__":
    unittest.main()
