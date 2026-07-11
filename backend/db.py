"""Database access for TravelPlan.

One connection per request, stored on Flask ``g``. WAL mode + foreign keys on.
The DB file lives at ``data/travelplan.db`` (see :func:`db_path`).
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from flask import g, current_app

BASE_DIR = Path(__file__).resolve().parent.parent          # travelplan/
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "travelplan.db"
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def db_path() -> Path:
    """Resolved DB path (overridable via app config ``DB_PATH``)."""
    if current_app and current_app.config.get("DB_PATH"):
        return Path(current_app.config["DB_PATH"])
    return DB_PATH


def get_db() -> sqlite3.Connection:
    """Return a request-scoped SQLite connection (created once per request)."""
    if "db" not in g:
        conn = sqlite3.connect(str(db_path()))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        g.db = conn
    return g.db


def close_db(_exc=None) -> None:
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db() -> None:
    """Create ``data/`` and apply ``schema.sql`` (idempotent — CREATE IF NOT EXISTS)."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "uploads").mkdir(exist_ok=True)
    (DATA_DIR / "config").mkdir(exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
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