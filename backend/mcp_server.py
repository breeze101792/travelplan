"""MCP server for TravelPlan — lets an external agent (e.g. opencode) read
and edit a plan's itinerary over the Model Context Protocol.

Runs over stdio and reads/writes the SQLite DB directly (no Flask request
context, no auth — it is launched locally by the user's own agent). The LLM
extraction logic is shared with the web app via :mod:`backend.ai`.

Run with:  python -m backend.mcp_server   (or via ./mcp.sh)

Tools:
  list_plans()                 -> all trips
  get_plan(plan_id)            -> plan + items + settings
  list_items(plan_id)          -> all items in a plan
  get_item(item_id)            -> a single item
  extract_item(text, item_type?) -> parse pasted text into a structured item
  create_item(plan_id, item)   -> insert a typed item
  update_item(item_id, item)   -> edit an existing item
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from mcp.server.mcpserver import MCPServer

from .ai import extract_item as _ai_extract_item, AIConfigError
from .blueprints.items import _coerce_when, ITEM_TYPES, STATUSES

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "data" / "travelplan.db"
SETTINGS_PATH = BASE_DIR / "data" / "config" / "settings.json"

mcp = MCPServer("travelplan")


# ---------------------------------------------------------------- db helpers

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def _load_settings() -> dict:
    return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))


def _validate_required(item_type: str, title: str, details: dict) -> str | None:
    """Return an error message if a mandatory field is missing, else None.

    Mirrors ``blueprints/items.py::_validate_required`` so the MCP server
    enforces the same required fields (title, the when block, and any
    type-specific ``"required": true`` fields) as the web API.
    """
    if not title or not title.strip():
        return "title required"
    when = details.get("when") or {}
    if not when.get("start_at"):
        return "when.start_at required"
    if not when.get("end_at"):
        return "when.end_at required"
    schema = _load_settings().get("item_types") or {}
    spec = schema.get(item_type) or {}
    for f in (spec.get("fields") or []):
        if not f.get("required"):
            continue
        v = details.get(f.get("key"))
        if v is None or str(v).strip() == "":
            return f"{f.get('key')} required"
    return None


def _ensure_writable(conn: sqlite3.Connection, plan_id: int) -> None:
    """Raise if the plan is archived (read-only) or missing."""
    row = conn.execute("SELECT status FROM plans WHERE id = ?", (plan_id,)).fetchone()
    if row is None:
        raise ValueError(f"no plan with id {plan_id}")
    if row["status"] == "archived":
        raise ValueError("plan is archived and read-only")


def _parse_details(item: dict) -> dict:
    try:
        item["details"] = json.loads(item["details"]) if item.get("details") else {}
    except (TypeError, ValueError):
        item["details"] = {}
    return item


def _item_to_dict(row: sqlite3.Row) -> dict:
    d = _parse_details(dict(row))
    d["when"] = d["details"].get("when") or {}
    return d


def _coerce_item(item: dict) -> dict:
    """Normalize a client-supplied item into the shape the DB expects.

    Mirrors the create/patch logic in ``blueprints/items.py``: coerce the
    unified ``when`` object, derive ``item_date`` / ``end_date`` from it, and
    keep ``details`` as a JSON string.
    """
    details = item.get("details") or {}
    if not isinstance(details, dict):
        details = {}
    when = _coerce_when(details.get("when") if isinstance(details.get("when"), dict) else item.get("when"))
    if when:
        details["when"] = when
    else:
        details.pop("when", None)
    item_date = item.get("item_date")
    end_date = item.get("end_date")
    if when.get("start_at"):
        item_date = when["start_at"][:10]
    if when.get("end_at"):
        end_date = when["end_at"][:10]
    return {
        "item_type": item.get("item_type"),
        "title": (item.get("title") or "").strip(),
        "item_date": item_date,
        "end_date": end_date,
        "status": item.get("status") or "planned",
        "details": details,
    }


# ---------------------------------------------------------------- tools

@mcp.tool()
def list_plans() -> list[dict]:
    """List all travel plans (id, title, dates, status, owner)."""
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT p.id, p.title, p.description, p.start_date, p.end_date,
                      p.status, p.base_currency, u.username AS owner
               FROM plans p JOIN users u ON u.id = p.owner_id
               ORDER BY p.created_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@mcp.tool()
def get_plan(plan_id: int) -> dict:
    """Return a plan with its items and the app settings (item-type schemas)."""
    conn = _connect()
    try:
        plan = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if plan is None:
            raise ValueError(f"no plan with id {plan_id}")
        items = conn.execute(
            "SELECT * FROM items WHERE plan_id = ? ORDER BY item_date, sort_key, id",
            (plan_id,),
        ).fetchall()
        return {
            "plan": dict(plan),
            "items": [_item_to_dict(r) for r in items],
            "settings": _load_settings(),
        }
    finally:
        conn.close()


@mcp.tool()
def list_items(plan_id: int) -> list[dict]:
    """List all itinerary items in a plan, ordered by day then sort order."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM items WHERE plan_id = ? ORDER BY item_date, sort_key, id",
            (plan_id,),
        ).fetchall()
        return [_item_to_dict(r) for r in rows]
    finally:
        conn.close()


@mcp.tool()
def get_item(item_id: int) -> dict:
    """Return a single itinerary item by id."""
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise ValueError(f"no item with id {item_id}")
        return _item_to_dict(row)
    finally:
        conn.close()


@mcp.tool()
def extract_item(text: str, item_type: str | None = None) -> dict:
    """Parse raw text (a flight ticket, hotel confirmation, etc.) into a
    structured itinerary item. Returns {item_type, title, details, when,
    item_date, end_date} ready to pass to create_item."""
    return _ai_extract_item(text, item_type=item_type, settings=_load_settings())


@mcp.tool()
def create_item(plan_id: int, item: dict) -> dict:
    """Insert a new itinerary item into a plan. ``item`` may be the output of
    extract_item or a hand-built object with item_type, title, details, when,
    item_date, end_date, status."""
    conn = _connect()
    try:
        _ensure_writable(conn, plan_id)
        c = _coerce_item(item)
        if c["item_type"] not in ITEM_TYPES:
            raise ValueError(f"invalid item_type: {c['item_type']!r}")
        err = _validate_required(c["item_type"], c["title"], c["details"])
        if err:
            raise ValueError(err)
        if c["status"] not in STATUSES:
            raise ValueError(f"invalid status: {c['status']!r}")
        max_key = conn.execute(
            "SELECT COALESCE(MAX(sort_key), 0) FROM items WHERE plan_id = ? AND item_date IS ?",
            (plan_id, c["item_date"]),
        ).fetchone()[0]
        cur = conn.execute(
            """INSERT INTO items
               (plan_id, item_type, title, item_date, end_date, sort_key, status, details)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (plan_id, c["item_type"], c["title"], c["item_date"], c["end_date"],
             max_key + 1.0, c["status"], json.dumps(c["details"])),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM items WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _item_to_dict(row)
    finally:
        conn.close()


@mcp.tool()
def update_item(item_id: int, item: dict) -> dict:
    """Edit an existing item. Accepts any of: title, status, details, when,
    item_date, end_date. Returns the updated item."""
    conn = _connect()
    try:
        existing = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        if existing is None:
            raise ValueError(f"no item with id {item_id}")
        _ensure_writable(conn, existing["plan_id"])
        existing = _item_to_dict(existing)
        merged = dict(existing)
        merged.update({k: v for k, v in item.items() if v is not None})
        c = _coerce_item(merged)
        if c["item_type"] not in ITEM_TYPES:
            raise ValueError(f"invalid item_type: {c['item_type']!r}")
        err = _validate_required(c["item_type"], c["title"], c["details"])
        if err:
            raise ValueError(err)
        if c["status"] not in STATUSES:
            raise ValueError(f"invalid status: {c['status']!r}")
        conn.execute(
            """UPDATE items SET title = ?, item_date = ?, end_date = ?, status = ?,
                                details = ?, updated_at = datetime('now')
               WHERE id = ?""",
            (c["title"], c["item_date"], c["end_date"], c["status"],
             json.dumps(c["details"]), item_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        return _item_to_dict(row)
    finally:
        conn.close()


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
