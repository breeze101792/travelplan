"""Database access for TravelPlan.

A single shared SQLite connection is reused across requests (created lazily on
first use). Opening a fresh connection per request was the bottleneck on slow
disks: the first query on a brand-new WAL connection pays ~30ms to set up the
WAL shared-memory index, so every API request cost ~33ms instead of ~1ms. A
reused connection answers in ~1ms.

Because the connection is shared across request threads, access is serialized
with a lock held for the duration of each request (acquired in :func:`get_db`,
released in :func:`close_db`). For a low-traffic friends app this is fine and
keeps the connection (and its WAL index) warm. On teardown we rollback so a
request that died mid-write can't leak an open transaction onto the next one
(rollback is a no-op when the request already committed).
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from flask import g, current_app

BASE_DIR = Path(__file__).resolve().parent.parent          # travelplan/
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "travelplan.db"
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"

_lock = threading.Lock()        # serializes access to the shared connection
_conn: sqlite3.Connection | None = None


def db_path() -> Path:
    """Resolved DB path (overridable via app config ``DB_PATH``)."""
    if current_app and current_app.config.get("DB_PATH"):
        return Path(current_app.config["DB_PATH"])
    return DB_PATH


def get_db() -> sqlite3.Connection:
    """Return the shared SQLite connection, holding the DB lock for this request.

    The lock is acquired on the first ``get_db()`` of a request (marked by
    ``g.db``) and released in :func:`close_db` at request teardown. The
    connection itself is created once, under the lock.
    """
    global _conn
    if "db" not in g:
        _lock.acquire()
        try:
            if _conn is None:
                _conn = sqlite3.connect(str(db_path()), check_same_thread=False)
                _conn.row_factory = sqlite3.Row
                # foreign_keys is per-connection and cheap. WAL is a persistent
                # property of the DB file (set once in init_db), not re-set here.
                _conn.execute("PRAGMA foreign_keys=ON;")
            g.db = _conn
        except BaseException:
            _lock.release()
            raise
    return g.db


def close_db(_exc=None) -> None:
    """Release the DB lock held by this request and discard any open txn."""
    if g.pop("db", None) is not None:
        try:
            if _conn is not None:
                _conn.rollback()   # no-op when the request already committed
        except Exception:
            pass
        _lock.release()


def reset_for_tests() -> None:
    """Test helper: close and forget the shared connection.

    The production app keeps a single shared SQLite connection for the
    lifetime of the process (it holds the warm WAL index, see get_db).
    Tests that create a fresh data dir per case must drop the cached
    connection first, otherwise the new dir's schema is never seen.
    """
    global _conn
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None


def init_db() -> None:
    """Create ``data/`` and apply ``schema.sql`` (idempotent — CREATE IF NOT EXISTS).

    Also sets WAL journal mode once here; it persists in the DB file, so the
    shared connection in :func:`get_db` does not need to re-set it."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "uploads").mkdir(exist_ok=True)
    (DATA_DIR / "config").mkdir(exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        # Migration: add status column to plans if missing
        try:
            conn.execute("ALTER TABLE plans ADD COLUMN status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','ongoing','archived'))")
        except Exception:
            pass
        conn.commit()
    finally:
        conn.close()


def query_all(sql: str, args=()):
    return [dict(r) for r in get_db().execute(sql, args).fetchall()]


def query_one(sql: str, args=()):
    r = get_db().execute(sql, args).fetchone()
    return dict(r) if r is not None else None


def execute(sql: str, args=()) -> int:
    """Execute a statement and return lastrowid."""
    cur = get_db().execute(sql, args)
    get_db().commit()
    return cur.lastrowid