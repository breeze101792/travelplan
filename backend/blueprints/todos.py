"""Todos blueprint: plan-level checklist with three scopes.

API:
  GET    /api/plans/<id>/todos        list (all roles, viewer included)
  POST   /api/plans/<id>/todos        create (owner/editor)
  PATCH  /api/todos/<id>              edit title/note/assignee (owner/editor)
  POST   /api/todos/<id>/toggle       set done (rules depend on scope)
  DELETE /api/todos/<id>              delete (owner/editor)

``scope`` is the discriminator:
  'project' — trip tasks. Any plan member may toggle one, and ``done_by``
              records who; owner/editor create, edit, and delete.
  'global'  — the shared list. Owner/editor toggle it; a viewer may not.
  'person'  — a member's preparation item (``assignee_id`` set). Only the
              assignee may toggle it, even when their role is viewer.

Scope is set at creation and immutable; a PATCH that changes it, or moves an
entry between unassigned and assigned, is rejected.
"""
from __future__ import annotations

from flask import Blueprint, request, g, abort, jsonify

from ..auth import (login_required, plan_access, check_todo_access,
                    ensure_plan_writable)
from ..db import get_db
from ..util import err
from ..sse import publish_event

todos_bp = Blueprint("todos", __name__)

TODO_TITLE_MAX_LENGTH = 200
TODO_NOTE_MAX_LENGTH = 2000
SCOPES = ("global", "project", "person")


def _serialize_todo(todo_id) -> dict:
    """Return a to-do row with its assignee/actor names as JSON-ready fields."""
    row = get_db().execute(
        """SELECT t.id, t.plan_id, t.title, t.note, t.scope, t.assignee_id, t.done,
                  t.done_by, t.done_at, t.created_by, t.created_at, t.updated_at,
                  COALESCE(u.display_name, u.username) AS assignee_name,
                  COALESCE(d.display_name, d.username) AS done_by_name
           FROM plan_todos t
           LEFT JOIN users u ON u.id = t.assignee_id
           LEFT JOIN users d ON d.id = t.done_by
           WHERE t.id = ?""",
        (todo_id,)).fetchone()
    todo = dict(row)
    todo["done"] = bool(todo["done"])
    return todo


def _json_body() -> dict | None:
    """Return the parsed JSON object, or None if the body is not a JSON object.

    ``get_json`` may return a list/string/None for a malformed or non-object
    body; every handler needs an object, so this centralizes the guard.
    """
    data = request.get_json(force=True, silent=True)
    return data if isinstance(data, dict) else None


def _parse_title(data) -> tuple[str | None, object | None]:
    """Return ``(title, None)`` or ``(None, error_response)``."""
    value = data.get("title")
    if not isinstance(value, str):
        return None, err("title required")
    title = value.strip()
    if not title:
        return None, err("title required")
    if len(title) > TODO_TITLE_MAX_LENGTH:
        return None, err(f"title too long (max {TODO_TITLE_MAX_LENGTH})")
    return title, None


def _parse_note(data) -> tuple[str | None, object | None]:
    """Return ``(note, None)`` or ``(None, error_response)``.

    A missing key, ``None``, or an empty string mean "no note" (stored as
    NULL); a whitespace-only string is stored as given. Non-string values are
    rejected rather than stringified.
    """
    if "note" not in data:
        return None, None
    raw = data.get("note")
    if raw is None:
        return None, None
    if not isinstance(raw, str):
        return None, err("note must be text")
    if len(raw) > TODO_NOTE_MAX_LENGTH:
        return None, err(f"note too long (max {TODO_NOTE_MAX_LENGTH})")
    return (raw or None), None


def _parse_assignee(data) -> tuple[int | None, object | None]:
    """Return ``(assignee_id, None)`` or ``(None, error_response)``.

    ``None`` (or an absent key) means no assignee (global/project). Only an
    integer id in SQLite's signed 64-bit range is accepted; a bool is not an
    id, and an out-of-range int is rejected here rather than crashing the
    SQLite bind.
    """
    if "assignee_id" not in data or data.get("assignee_id") is None:
        return None, None
    value = data.get("assignee_id")
    if isinstance(value, bool) or not isinstance(value, int):
        return None, err("assignee_id must be an integer")
    if not (-(2 ** 63) <= value <= 2 ** 63 - 1):
        return None, err("assignee_id out of range")
    return value, None


def _parse_scope(data, assignee_id) -> tuple[str | None, object | None]:
    """Return ``(scope, None)`` or ``(None, error_response)``.

    ``scope`` is explicit when supplied; otherwise it is inferred for
    backward compatibility: an assignee means a ``person`` entry, none means
    ``global``. A ``person`` entry must have an assignee; ``global`` and
    ``project`` entries must not.
    """
    scope = data.get("scope")
    if scope is None:
        scope = "person" if assignee_id is not None else "global"
    if scope not in SCOPES:
        return None, err("scope must be global, project, or person")
    if scope == "person" and assignee_id is None:
        return None, err("person entries require an assignee")
    if scope != "person" and assignee_id is not None:
        return None, err("only person entries may have an assignee")
    return scope, None


def _validate_assignee(plan_id: int, assignee_id: int) -> str | None:
    """Return an error message if ``assignee_id`` is not a plan member, else None.

    ``None`` (a global entry) is always valid. Otherwise the id must be the
    plan owner or a current ``plan_members`` row for this plan.
    """
    if assignee_id is None:
        return None
    row = get_db().execute(
        """SELECT 1 WHERE ? = (SELECT owner_id FROM plans WHERE id = ?)
              OR EXISTS (SELECT 1 FROM plan_members WHERE plan_id = ? AND user_id = ?)""",
        (assignee_id, plan_id, plan_id, assignee_id),
    ).fetchone()
    if row is None:
        return "assignee must be a member of this plan"
    return None


@todos_bp.route("/api/plans/<int:plan_id>/todos")
@plan_access()
def list_todos(plan_id):
    # Project tasks first, then the global list, then per-person sections.
    rows = get_db().execute(
        """SELECT id FROM plan_todos WHERE plan_id = ?
           ORDER BY CASE scope WHEN 'project' THEN 0 WHEN 'global' THEN 1 ELSE 2 END,
                    assignee_id, id""",
        (plan_id,)).fetchall()
    return jsonify({"todos": [_serialize_todo(r["id"]) for r in rows]})


@todos_bp.route("/api/plans/<int:plan_id>/todos", methods=["POST"])
@plan_access(write=True)
def create_todo(plan_id):
    ensure_plan_writable(plan_id)
    data = _json_body()
    if data is None:
        return err("JSON object required")
    title, title_err = _parse_title(data)
    if title_err:
        return title_err
    note, note_err = _parse_note(data)
    if note_err:
        return note_err
    assignee_id, assignee_err = _parse_assignee(data)
    if assignee_err:
        return assignee_err
    scope, scope_err = _parse_scope(data, assignee_id)
    if scope_err:
        return scope_err
    if assignee_id is not None:
        validation_err = _validate_assignee(plan_id, assignee_id)
        if validation_err:
            return err(validation_err)
    db = get_db()
    cur = db.execute(
        """INSERT INTO plan_todos (plan_id, title, note, scope, assignee_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (plan_id, title, note, scope, assignee_id, g.current_user["id"]),
    )
    db.commit()
    publish_event(plan_id, {"type": "todo.created", "entity_id": cur.lastrowid})
    return jsonify({"todo": _serialize_todo(cur.lastrowid)})


@todos_bp.route("/api/todos/<int:todo_id>", methods=["PATCH"])
@login_required
def update_todo(todo_id):
    check_todo_access(todo_id, write=True)
    db = get_db()
    row = db.execute("SELECT * FROM plan_todos WHERE id = ?", (todo_id,)).fetchone()
    if row is None:
        abort(404)
    ensure_plan_writable(row["plan_id"])
    data = _json_body()
    if data is None:
        return err("JSON object required")
    if "done" in data:
        return err("use /toggle to change done")
    sets, args = [], []
    if "title" in data:
        title, title_err = _parse_title(data)
        if title_err:
            return title_err
        sets.append("title = ?"); args.append(title)
    if "note" in data:
        note, note_err = _parse_note(data)
        if note_err:
            return note_err
        sets.append("note = ?"); args.append(note)
    if "scope" in data:
        new_scope = data.get("scope")
        if new_scope not in SCOPES:
            return err("scope must be global, project, or person")
        if new_scope != row["scope"]:
            return err("cannot change an entry's scope; delete and recreate")
    if "assignee_id" in data:
        new_assignee, assignee_err = _parse_assignee(data)
        if assignee_err:
            return assignee_err
        if row["scope"] != "person" or new_assignee is None:
            # An unassigned <-> assigned move is a scope change, not an edit.
            return err("cannot change between global, project, and assigned; "
                       "delete and recreate")
        validation_err = _validate_assignee(row["plan_id"], new_assignee)
        if validation_err:
            return err(validation_err)
        sets.append("assignee_id = ?"); args.append(new_assignee)
    if not sets:
        return jsonify({"todo": _serialize_todo(todo_id)})
    sets.append("updated_at = datetime('now')")
    args.append(todo_id)
    db.execute(f"UPDATE plan_todos SET {', '.join(sets)} WHERE id = ?", args)
    db.commit()
    publish_event(row["plan_id"], {"type": "todo.updated", "entity_id": todo_id})
    return jsonify({"todo": _serialize_todo(todo_id)})


@todos_bp.route("/api/todos/<int:todo_id>/toggle", methods=["POST"])
@login_required
def toggle_todo(todo_id):
    check_todo_access(todo_id, write=False)
    db = get_db()
    row = db.execute("SELECT * FROM plan_todos WHERE id = ?", (todo_id,)).fetchone()
    if row is None:
        abort(404)
    ensure_plan_writable(row["plan_id"])
    if row["scope"] == "project":
        # Project task: anyone on the plan may tick it off. The check mark
        # records who did it. Nothing to gate here beyond plan access.
        pass
    elif row["scope"] == "global":
        # Global entry: owner/editor manage it; a viewer may not.
        if g.plan_role == "viewer":
            abort(403)
    else:
        # Person entry: only the assignee may toggle, whatever their role.
        if row["assignee_id"] != g.current_user["id"]:
            abort(403)
    data = _json_body()
    if data is None:
        return err("JSON object required")
    done = data.get("done")
    if not isinstance(done, bool):
        return err("done required (boolean)")
    done_int = 1 if done else 0
    done_by = g.current_user["id"] if done else None
    db.execute(
        """UPDATE plan_todos
           SET done = ?, done_by = ?,
               done_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
               updated_at = datetime('now')
           WHERE id = ?""",
        (done_int, done_by, done_int, todo_id),
    )
    db.commit()
    publish_event(row["plan_id"], {"type": "todo.updated", "entity_id": todo_id})
    return jsonify({"todo": _serialize_todo(todo_id)})


@todos_bp.route("/api/todos/<int:todo_id>", methods=["DELETE"])
@login_required
def delete_todo(todo_id):
    check_todo_access(todo_id, write=True)
    db = get_db()
    row = db.execute("SELECT plan_id FROM plan_todos WHERE id = ?", (todo_id,)).fetchone()
    if row is None:
        abort(404)
    ensure_plan_writable(row["plan_id"])
    db.execute("DELETE FROM plan_todos WHERE id = ?", (todo_id,))
    db.commit()
    publish_event(row["plan_id"], {"type": "todo.deleted", "entity_id": todo_id})
    return jsonify({"deleted": todo_id})
