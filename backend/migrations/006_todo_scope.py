"""006: Add ``plan_todos.scope`` for the project-task list.

Migration 005 introduced ``plan_todos`` with ``assignee_id`` NULL meaning a
global entry. A third list — project tasks anyone on the plan may tick —
also has no assignee, so a NULL assignee can no longer distinguish the two.
This adds an explicit ``scope`` column ('global' | 'project' | 'person') and
rebuilds the index to include it.

Existing rows are backfilled only when the column is actually added: rows
with an assignee become 'person', the rest keep the ALTER's 'global'
default. If ``scope`` already exists (a fresh database gets it from
``schema.sql``), the column and data are left untouched, so a 'project'
row is never reclassified.
"""
from __future__ import annotations

id = "006_todo_scope"


def _has_column(conn, table: str, column: str) -> bool:
    for row in conn.execute(f"PRAGMA table_info({table})").fetchall():
        # row[1] is the column name; works with or without a Row factory.
        if row[1] == column:
            return True
    return False


def run(conn):
    if not _has_column(conn, "plan_todos", "scope"):
        conn.execute(
            "ALTER TABLE plan_todos ADD COLUMN scope TEXT NOT NULL DEFAULT 'global' "
            "CHECK (scope IN ('global', 'project', 'person'))"
        )
        # The ALTER defaulted every existing row to 'global'; an assigned row
        # is a person entry. Done only here so a pre-existing 'project' row is
        # never overwritten.
        conn.execute(
            "UPDATE plan_todos SET scope = 'person' WHERE assignee_id IS NOT NULL"
        )
    # Rebuild the index so it covers the new discriminator.
    conn.execute("DROP INDEX IF EXISTS idx_plan_todos_plan")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_plan_todos_plan "
        "ON plan_todos(plan_id, scope, assignee_id, id)"
    )
