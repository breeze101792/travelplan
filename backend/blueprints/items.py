"""Items blueprint: itinerary item CRUD, drag-and-drop move/reorder, link attachments.

API:
  GET   /api/plans/<id>/items
  POST  /api/plans/<id>/items       create
  PATCH /api/items/<id>             edit fields/status/details
  DELETE /api/items/<id>
  POST  /api/items/<id>/move        {item_date, end_date?, before_id?, after_id?}
  POST  /api/items/<id>/attachments {kind:'link', value, caption?}
  DELETE /api/attachments/<id>
Image upload lives in uploads.py.
"""
from __future__ import annotations

import json

from flask import Blueprint, request, g, abort, jsonify

from ..auth import (login_required, plan_access, check_plan_access,
                    check_item_access, check_attachment_access)
from ..db import get_db

items_bp = Blueprint("items", __name__)

ITEM_TYPES = {"hotel", "transit", "restaurant",
              "activity", "note"}
STATUSES = {"planned", "confirmed", "done"}


def _load_item(item_id) -> dict | None:
    r = get_db().execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
    return dict(r) if r else None


def _load_attachments(item_id) -> list[dict]:
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM attachments WHERE item_id = ? ORDER BY created_at",
        (item_id,)).fetchall()]


def _load_geocodes(item_id) -> list[dict]:
    return [dict(r) for r in get_db().execute(
        "SELECT id, label, lat, lng, sort_order FROM item_geocodes WHERE item_id = ? ORDER BY sort_order, id",
        (item_id,)).fetchall()]


def _save_geocodes(item_id, geocodes):
    if not geocodes:
        return
    db = get_db()
    db.execute("DELETE FROM item_geocodes WHERE item_id = ?", (item_id,))
    for sort_order, g in enumerate(geocodes):
        lat = g.get("lat")
        lng = g.get("lng")
        if lat is None or lng is None:
            continue
        db.execute(
            "INSERT INTO item_geocodes (item_id, label, lat, lng, sort_order) VALUES (?, ?, ?, ?, ?)",
            (item_id, g.get("label", ""), lat, lng, sort_order),
        )
    db.commit()


def _attach(item: dict) -> dict:
    try:
        item["details"] = json.loads(item["details"]) if item.get("details") else {}
    except (TypeError, ValueError):
        item["details"] = {}
    item["attachments"] = _load_attachments(item["id"])
    item["geocodes"] = _load_geocodes(item["id"])
    return item


@items_bp.route("/api/plans/<int:plan_id>/items")
@plan_access()
def list_items(plan_id):
    rows = get_db().execute(
        "SELECT * FROM items WHERE plan_id = ? ORDER BY item_date, sort_key, id",
        (plan_id,)).fetchall()
    return jsonify({"items": [_attach(dict(r)) for r in rows]})


@items_bp.route("/api/plans/<int:plan_id>/items", methods=["POST"])
@plan_access(write=True)
def create_item(plan_id):
    data = request.get_json(force=True, silent=True) or {}
    item_type = data.get("item_type")
    if item_type not in ITEM_TYPES:
        return jsonify({"error": "invalid item_type"}), 400
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title required"}), 400
    details = data.get("details") or {}
    db = get_db()
    max_key = db.execute(
        "SELECT COALESCE(MAX(sort_key), 0) FROM items WHERE plan_id = ? AND item_date IS ?",
        (plan_id, data.get("item_date")),
    ).fetchone()[0]
    cur = db.execute(
        """INSERT INTO items
           (plan_id, item_type, title, item_date, end_date, sort_key, status, details, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (plan_id, item_type, title, data.get("item_date"), data.get("end_date"),
         max_key + 1.0, data.get("status") or "planned",
         json.dumps(details), g.current_user["id"]),
    )
    db.commit()
    _save_geocodes(cur.lastrowid, data.get("geocodes"))
    return jsonify({"item": _attach(_load_item(cur.lastrowid))})


@items_bp.route("/api/items/<int:item_id>", methods=["PATCH", "DELETE"])
@login_required
def mutate_item(item_id):
    write = request.method != "GET"
    check_item_access(item_id, write=True)
    item = _load_item(item_id)
    if not item:
        abort(404)
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM items WHERE id = ?", (item_id,))
        db.commit()
        return jsonify({"deleted": item_id})
    data = request.get_json(force=True, silent=True) or {}
    sets, args = [], []
    for k in ("title", "item_date", "end_date"):
        if k in data:
            sets.append(f"{k} = ?"); args.append(data[k])
    if data.get("status") in STATUSES:
        sets.append("status = ?"); args.append(data["status"])
    if "details" in data:
        sets.append("details = ?"); args.append(json.dumps(data["details"] or {}))
    if sets:
        sets.append("updated_at = datetime('now')")
        args.append(item_id)
        db.execute(f"UPDATE items SET {', '.join(sets)} WHERE id = ?", args)
        db.commit()
    if "geocodes" in data:
        _save_geocodes(item_id, data["geocodes"] or [])
    return jsonify({"item": _attach(_load_item(item_id))})


@items_bp.route("/api/items/<int:item_id>/move", methods=["POST"])
@login_required
def move_item(item_id):
    """Drag-and-drop reorder/move. Body: {item_date, end_date?, before_id?, after_id?}.
    Computes a fractional sort_key between the item's neighbors in the target day."""
    check_item_access(item_id, write=True)
    item = _load_item(item_id)
    if not item:
        abort(404)
    data = request.get_json(force=True, silent=True) or {}
    item_date = data.get("item_date", item["item_date"])
    end_date = data.get("end_date", item["end_date"])
    before_id = data.get("before_id")
    after_id = data.get("after_id")
    db = get_db()
    key_before = 0.0
    key_after = None
    if after_id:
        r = db.execute("SELECT sort_key FROM items WHERE id = ? AND item_date IS ?",
                       (after_id, item_date)).fetchone()
        key_before = r["sort_key"] if r else 0.0
    if before_id:
        r = db.execute("SELECT sort_key FROM items WHERE id = ? AND item_date IS ?",
                       (before_id, item_date)).fetchone()
        key_after = r["sort_key"] if r else None
    if key_after is None:
        m = db.execute(
            "SELECT COALESCE(MAX(sort_key), 0) FROM items "
            "WHERE plan_id = ? AND item_date IS ? AND id != ?",
            (item["plan_id"], item_date, item_id)).fetchone()[0]
        new_key = m + 1.0
    else:
        new_key = (key_before + key_after) / 2.0
    db.execute(
        "UPDATE items SET item_date = ?, end_date = ?, sort_key = ?, updated_at = datetime('now') WHERE id = ?",
        (item_date, end_date, new_key, item_id))
    db.commit()
    return jsonify({"item": _attach(_load_item(item_id))})


@items_bp.route("/api/items/<int:item_id>/attachments", methods=["POST"])
@login_required
def add_link_attachment(item_id):
    check_item_access(item_id, write=True)
    item = _load_item(item_id)
    if not item:
        abort(404)
    data = request.get_json(force=True, silent=True) or {}
    kind = data.get("kind")
    value = (data.get("value") or "").strip()
    if kind not in ("image", "link") or not value:
        return jsonify({"error": "kind and value required"}), 400
    if kind == "link" and not (value.startswith("http://") or value.startswith("https://")):
        return jsonify({"error": "link must be http(s)"}), 400
    cur = get_db().execute(
        "INSERT INTO attachments (item_id, kind, value, caption) VALUES (?, ?, ?, ?)",
        (item_id, kind, value, data.get("caption")))
    get_db().commit()
    return jsonify({"attachment": dict(get_db().execute(
        "SELECT * FROM attachments WHERE id = ?", (cur.lastrowid,)).fetchone())})


@items_bp.route("/api/attachments/<int:att_id>", methods=["DELETE"])
@login_required
def delete_attachment(att_id):
    check_attachment_access(att_id, write=True)
    db = get_db()
    db.execute("DELETE FROM attachments WHERE id = ?", (att_id,))
    db.commit()
    return jsonify({"deleted": att_id})