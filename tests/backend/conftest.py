"""Shared pytest fixtures for the TravelPlan backend.

Each test gets a fresh app backed by a throwaway temp data dir, so DB rows
and sessions never leak between tests. The fixtures below mirror the helper
functions that used to live in each test module's `_fresh_app()`.

Fixtures provided
----------------
fresh_app        a brand-new Flask app + temp data dir (no users)
app              fresh_app + an admin and a member user created
client           app.test_client()
make_user        factory: create a user with a chosen role/password/name
login            logs a user in via the test client (real /auth/login flow)
admin_client     client logged in as admin
member_client    client logged in as the member `alice`
make_plan        factory: create a plan (as the logged-in user) via the API
db               the shared sqlite connection for direct DB assertions
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from backend.app import create_app
from backend import db as db_mod
from backend import auth as auth_mod
from backend.auth import hash_password


@pytest.fixture
def fresh_app():
    """A Flask app whose data dir is a fresh temp directory.

    Patches the module-level DATA_DIR / DB_PATH *before* the app is built
    (init_db reads them at startup) and drops the cached shared connection
    from any prior test, so the new dir's schema is actually seen.
    """
    tmp = Path(tempfile.mkdtemp(prefix="tp_test_"))
    data = tmp / "data"
    uploads = data / "uploads"
    config_dir = data / "config"
    for d in (data, uploads, config_dir):
        d.mkdir(parents=True, exist_ok=True)
    db_path = data / "travelplan.db"

    db_mod.reset_for_tests()
    db_mod.DATA_DIR = data
    db_mod.DB_PATH = db_path
    auth_mod.SECRET_KEY_FILE = config_dir / "secret_key"

    app = create_app({
        "DB_PATH": str(db_path),
        "UPLOAD_FOLDER": str(uploads),
        "TESTING": True,
        "WTF_CSRF_ENABLED": False,
    })
    app._test_tmp = tmp
    yield app
    shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture
def app(fresh_app):
    """Fresh app with one admin and one member already created."""
    _create_user(fresh_app, username="admin", password="pw12345",
                 display_name="Admin", role="admin")
    _create_user(fresh_app, username="alice", password="pw12345",
                 display_name="Alice Wang", role="member")
    _create_user(fresh_app, username="bob", password="pw12345",
                 display_name="Bob Lee", role="member")
    return fresh_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def db(app):
    """Query helper for direct DB assertions.

    The shared SQLite connection is serialized via a module-level lock that's
    held for the duration of a request (released at request teardown). The
    production app registers ``close_db`` as a ``teardown_appcontext`` hook;
    under pytest-flask the app context is shared across requests, so the lock
    is only released when the whole test ends — too late for inline assertions.

    To stay out of the lock entirely, this fixture opens a *separate* sqlite
    connection directly to the temp DB file. It never touches ``get_db()``,
    so it can run before, after, or during a ``client`` request without
    deadlocking.

    Usage::

        def test_x(client, db):
            uid = db.one("SELECT id FROM users WHERE username='alice'")["id"]
            client.post(...)   # safe
            rows = db.all("SELECT ...")
    """
    import sqlite3
    conn = sqlite3.connect(str(app.config["DB_PATH"]), check_same_thread=False)
    conn.row_factory = sqlite3.Row

    class _DB:
        app = app

        def one(self, sql, args=()):
            return conn.execute(sql, args).fetchone()

        def all(self, sql, args=()):
            return conn.execute(sql, args).fetchall()

    yield _DB()
    conn.close()


@pytest.fixture
def make_user(app):
    """Factory: create an arbitrary user (admin or member)."""
    def _make(*, username, password="pw12345", display_name=None,
              role="member"):
        _create_user(app, username=username, password=password,
                     display_name=display_name or username.title(),
                     role=role)
        with app.app_context():
            return db_mod.get_db().execute(
                "SELECT id, username, display_name, role FROM users "
                "WHERE username = ?", (username,)).fetchone()
    return _make


@pytest.fixture
def login(client):
    """Log a user in via the real /auth/login form flow."""
    def _login(username, password="pw12345"):
        return client.post("/auth/login",
                            data={"username": username, "password": password},
                            follow_redirects=False)
    return _login


@pytest.fixture
def admin_client(app):
    """A test client logged in as admin (separate session from `client`)."""
    c = app.test_client()
    c.post("/auth/login", data={"username": "admin", "password": "pw12345"})
    return c


@pytest.fixture
def member_client(app):
    """A test client logged in as the member `alice` (separate session)."""
    c = app.test_client()
    c.post("/auth/login", data={"username": "alice", "password": "pw12345"})
    return c


@pytest.fixture
def make_plan(member_client):
    """Factory: create a plan as alice (the member_client)."""
    def _make(**body):
        body.setdefault("title", "Trip")
        r = member_client.post("/api/plans", json=body)
        assert r.status_code == 200, r.data
        return r.get_json()["plan"]
    return _make


def _create_user(app, *, username, password, display_name, role="member"):
    with app.app_context():
        db_mod.get_db().execute(
            "INSERT INTO users (username, password_hash, display_name, role) "
            "VALUES (?, ?, ?, ?)",
            (username, hash_password(password), display_name, role),
        )
        db_mod.get_db().commit()