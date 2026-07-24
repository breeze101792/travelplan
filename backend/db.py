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

import json
import sqlite3
import threading
from datetime import datetime, timedelta
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
        # Migration: migrate flight/train/transport to transit
        try:
            c = conn.execute("SELECT id, item_type, details FROM items WHERE item_type IN ('flight','train','transport')")
            rows = c.fetchall()
            for row in rows:
                item_id, old_type, raw_details = row
                details = json.loads(raw_details) if raw_details else {}
                if old_type == 'flight':
                    if details.get('airline'):
                        details['provider'] = details.pop('airline')
                    if details.get('flight_no'):
                        details['ref_no'] = details.pop('flight_no')
                    details.pop('airline', None)
                    details.pop('flight_no', None)
                elif old_type == 'train':
                    if details.get('train_no'):
                        details['ref_no'] = details.pop('train_no')
                    details.pop('train_no', None)
                elif old_type == 'transport':
                    if details.get('time') and not details.get('depart_time'):
                        details['depart_time'] = details.pop('time')
                    if details.get('depart_time') and not details.get('arrive_time'):
                        from datetime import datetime, timedelta
                        try:
                            dt = datetime.fromisoformat(details['depart_time'])
                            details['arrive_time'] = (dt + timedelta(hours=1)).isoformat()
                        except Exception:
                            pass
                conn.execute(
                    "UPDATE items SET item_type = 'transit', details = ? WHERE id = ?",
                    (json.dumps(details), item_id),
                )
            conn.commit()
        except Exception:
            pass
        # Migration: move link from details to attachments, rename venue→location,
        # convert legacy time→start_time/end_time, remove qty/price from details
        try:
            c = conn.execute("SELECT id, item_type, details FROM items")
            rows = c.fetchall()
            for row in rows:
                item_id, item_type, raw_details = row
                details = json.loads(raw_details) if raw_details else {}
                changed = False
                # Move link to attachments
                link = details.pop('link', None)
                if link:
                    existing = conn.execute(
                        "SELECT id FROM attachments WHERE item_id = ? AND kind = 'link' AND value = ?",
                        (item_id, link)
                    ).fetchone()
                    if not existing:
                        conn.execute(
                            "INSERT INTO attachments (item_id, kind, value, caption) VALUES (?, 'link', ?, ?)",
                            (item_id, link, details.get('name') or details.get('hotel_name') or '')
                        )
                # Rename venue to location for activity items
                if item_type == 'activity' and 'venue' in details:
                    details['location'] = details.pop('venue')
                    changed = True
                # Convert legacy time to start_time/end_time for restaurant
                if item_type == 'restaurant' and 'time' in details and not details.get('start_time'):
                    details['start_time'] = details.pop('time')
                    changed = True
                # Remove fields that no longer belong in details
                for legacy_field in ('qty', 'price'):
                    if legacy_field in details:
                        del details[legacy_field]
                        changed = True
                if changed:
                    conn.execute(
                        "UPDATE items SET details = ? WHERE id = ?",
                        (json.dumps(details) if details else None, item_id),
                    )
            conn.commit()
        except Exception:
            pass
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