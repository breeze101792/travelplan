"""005: Add the plan_todos table (plan-level checklist).

The to-do list is plan-level (not per itinerary item): a single table holds
both group entries (``assignee_id`` NULL) and per-member preparation items
(``assignee_id`` set). Toggling an assigned entry is restricted to its
assignee; owner/editor manage creation and assignment.

The DDL mirrors ``schema.sql`` exactly. Fresh databases get the table from
schema.sql; existing databases reach the same state through this migration.
Both paths are idempotent (``IF NOT EXISTS``).
"""
from __future__ import annotations

id = "005_plan_todos"


def run(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS plan_todos (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id     INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
          title       TEXT NOT NULL,
          note        TEXT,
          assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          done        INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
          done_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
          done_at     TEXT,
          created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    # No scope column yet — migration 006 adds it and rebuilds this index.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_plan_todos_plan "
        "ON plan_todos(plan_id, assignee_id, id)"
    )
