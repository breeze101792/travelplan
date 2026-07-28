"""Database migrations for TravelPlan.

Each migration is a single Python file in this directory, named
``NNN_short_name.py``, exporting a unique ``id`` (string) and a ``run(conn)``
function. ``Migrations`` discovers them at import time, runs any that
haven't been recorded in the ``migrations`` table, and records them on
success.

Why a custom framework? The DB schema is small (single-file ``schema.sql``)
and a heavy framework (alembic, yoyo) would be overkill. The existing
init_db() grew three inline migration blocks; this module gives them
names, idempotency, and an order, and is the right home for any
future migration (e.g. renaming a column, splitting a JSON blob).
"""
from __future__ import annotations

import importlib
import inspect
import pkgutil
import sqlite3
from pathlib import Path
from typing import Callable

import logging
log = logging.getLogger(__name__)

_THIS_DIR = Path(__file__).resolve().parent


def _discover() -> list[tuple[str, Callable[[sqlite3.Connection], None]]]:
    """Return ``[(id, run), ...]`` for every migration module, in order.

    A migration is any module file in this directory whose name matches
    ``NNN_*.py`` (three-digit prefix, dash/underscore-separated). The id
    is the module's ``id`` attribute (defaults to the module name).
    """
    found: list[tuple[int, str, Callable[[sqlite3.Connection], None]]] = []
    for info in pkgutil.iter_modules([str(_THIS_DIR)]):
        name = info.name
        if not (len(name) >= 4 and name[:3].isdigit() and name[3] == "_"):
            continue
        try:
            mod = importlib.import_module(f"{__name__}.{name}")
        except Exception as e:
            log.error("migration: failed to import %s: %s", name, e)
            continue
        if not hasattr(mod, "run"):
            continue
        mig_id = getattr(mod, "id", name)
        if not mig_id or not isinstance(mig_id, str):
            log.error("migration: %s has no valid 'id'", name)
            continue
        run = getattr(mod, "run", None)
        if not callable(run):
            log.error("migration: %s.run is not callable", name)
            continue
        prefix = int(name[:3])
        found.append((prefix, mig_id, run))
    found.sort(key=lambda t: t[0])
    return [(mig_id, run) for _, mig_id, run in found]


def _ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS migrations (
            id          TEXT PRIMARY KEY,
            applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)


def _applied_ids(conn: sqlite3.Connection) -> set[str]:
    # Connections here come in both flavors: a shared connection from
    # db.get_db() (row_factory=sqlite3.Row) and a one-shot connection
    # from a test script. Handle both without forcing a row factory.
    out: set[str] = set()
    for row in conn.execute("SELECT id FROM migrations").fetchall():
        out.add(row[0])
    return out


def run_pending(conn: sqlite3.Connection) -> list[str]:
    """Run any unapplied migrations against ``conn``.

    Returns the list of newly-applied migration ids (in apply order). The
    caller is responsible for committing ``conn`` if a transaction is
    not already active. Each migration's ``run(conn)`` is responsible for
    committing its own work (so a partial failure leaves the DB in a
    recoverable state for the next startup).

    The whole loop is wrapped in a savepoint per-migration so a single
    bad migration can't roll back earlier successful ones, and the
    ``migrations`` row is only written after ``run`` returns without
    throwing.
    """
    _ensure_table(conn)
    applied = _applied_ids(conn)
    migrations = _discover()
    newly_applied: list[str] = []
    for mig_id, run in migrations:
        if mig_id in applied:
            continue
        # Each migration runs in its own savepoint; we record the
        # migration id only if the savepoint commits. This way a failing
        # migration can be fixed and re-run on the next startup.
        try:
            conn.execute("BEGIN")
            run(conn)
        except Exception as e:
            conn.rollback()
            log.error("migration %s failed: %s; will retry on next startup", mig_id, e)
            continue
        # If run() didn't commit, we still want to persist its work + the
        # migration row. We commit on the migration framework's behalf
        # because individual migrations don't need to know about
        # bookkeeping. (If a migration already committed, this commit
        # is a no-op for the data; the new row is recorded.)
        conn.execute(
            "INSERT INTO migrations (id) VALUES (?)", (mig_id,)
        )
        conn.commit()
        newly_applied.append(mig_id)
    return newly_applied
