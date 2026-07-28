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
import re

from flask import Blueprint, request, g, abort, jsonify

from ..auth import (login_required, plan_access, check_plan_access,
                    check_item_access, check_attachment_access)
from ..db import get_db

items_bp = Blueprint("items", __name__)

ITEM_TYPES = {"hotel", "transit", "restaurant",
              "activity", "note"}
STATUSES = {"planned", "confirmed", "done"}

# All items carry a single ``when`` object in ``details``:
#   { "start_at": "YYYY-MM-DDTHH:MM",   # required (when the item is
#     "end_at":   "YYYY-MM-DDTHH:MM" }  # scheduled) — defaulted to
#                                          start_at + 1h by the server
# For hotels the dates are also tracked on the row (item_date + end_date)
# so the spanning-hotel board rendering can run from SQL alone.

_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")
_HHMM_RE = re.compile(r"(\d{1,2}):(\d{2})")


def _date_part(s: str | None) -> str | None:
    if not s:
        return None
    m = _DATE_RE.match(str(s))
    return m.group(1) if m else None


def _parse_dt(s: str | None):
    """Parse 'YYYY-MM-DDTHH:MM' into (date_str, hour, minute) or (None, None, None)."""
    if not s:
        return None, None, None
    d = _date_part(str(s))
    m = _HHMM_RE.search(str(s))
    if not d or not m:
        return None, None, None
    return d, int(m.group(1)), int(m.group(2))


def _add_hour(date: str, hour: int, minute: int) -> str:
    """Return 'YYYY-MM-DDTHH:MM' for the given date + time, +1h.

    Used to default a missing end_at to start_at + 1h. We do not roll
    over midnight (clamp to 23:59) — schedule items shouldn't have a
    midnight-spanning default; the user can adjust if they really
    want a 1-minute item.
    """
    from datetime import datetime, timedelta
    try:
        dt = datetime.strptime(f"{date} {hour:02d}:{minute:02d}", "%Y-%m-%d %H:%M")
    except ValueError:
        return f"{date}T{hour:02d}:{minute:02d}"
    dt = dt + timedelta(hours=1)
    return dt.strftime("%Y-%m-%dT%H:%M")


def _coerce_when(raw) -> dict:
    """Normalize a client-supplied ``when`` object.

    Accepts {start_at, end_at} as 'YYYY-MM-DDTHH:MM' or 'YYYY-MM-DD' (date
    only). Returns a clean dict (empty if nothing was supplied).

    For schedule items (where start_at is set) end_at is defaulted to
    start_at + 1h if the client omitted it. Schedule items always have
    a time window — a single-instant item with no duration is the
    exception (a note with a start timestamp but no end), and the
    editor still writes the default; callers that need an
    "end-less" item can clear the value on read.
    """
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key in ("start_at", "end_at"):
        v = raw.get(key)
        if v is None or v == "":
            continue
        s = str(v).strip()
        if not s:
            continue
        # 'YYYY-MM-DD' alone is allowed (date only); the editor writes
        # 'YYYY-MM-DDTHH:MM'. The end-of-day format gets the time
        # stripped, so we just keep what the user gave.
        out[key] = s
    if "start_at" in out and "end_at" not in out:
        d, h, m = _parse_dt(out["start_at"])
        if d is not None and h is not None and m is not None:
            out["end_at"] = _add_hour(d, h, m)
    return out


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
    # Coerce the unified when object (the editor always sends it). The
    # item_date / end_date columns are derived from it so the day
    # grouping and the spanning-hotel SQL stay consistent.
    when = _coerce_when(details.get("when"))
    item_date = data.get("item_date")
    end_date = data.get("end_date")
    if when.get("start_at"):
        d = _date_part(when["start_at"])
        if d:
            item_date = d
    if when.get("end_at"):
        d = _date_part(when["end_at"])
        if d:
            end_date = d
    if when:
        details["when"] = when
    else:
        details.pop("when", None)
    db = get_db()
    max_key = db.execute(
        "SELECT COALESCE(MAX(sort_key), 0) FROM items WHERE plan_id = ? AND item_date IS ?",
        (plan_id, item_date),
    ).fetchone()[0]
    cur = db.execute(
        """INSERT INTO items
           (plan_id, item_type, title, item_date, end_date, sort_key, status, details, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (plan_id, item_type, title, item_date, end_date,
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
    for k in ("title",):
        if k in data:
            sets.append(f"{k} = ?"); args.append(data[k])
    if data.get("status") in STATUSES:
        sets.append("status = ?"); args.append(data["status"])
    # When the client sends a when object, it is the source of truth —
    # re-derive item_date / end_date from it (and accept the client's
    # explicit date values as a fallback for old callers).
    if "details" in data:
        details = data["details"] or {}
        if isinstance(details, dict) and "when" in details:
            when = _coerce_when(details.get("when"))
            if when:
                details["when"] = when
                d = _date_part(when.get("start_at", ""))
                if d:
                    sets.append("item_date = ?"); args.append(d)
                d = _date_part(when.get("end_at", ""))
                if d:
                    sets.append("end_date = ?"); args.append(d)
            else:
                # Explicitly empty when — clear the field.
                details.pop("when", None)
        sets.append("details = ?"); args.append(json.dumps(details))
    for k in ("item_date", "end_date"):
        if k in data:
            sets.append(f"{k} = ?"); args.append(data[k])
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


@items_bp.route("/api/attachments/<int:att_id>", methods=["PATCH"])
@login_required
def update_attachment(att_id):
    check_attachment_access(att_id, write=True)
    data = request.get_json(force=True, silent=True) or {}
    sets, args = [], []
    if "value" in data:
        v = (data["value"] or "").strip()
        if not (v.startswith("http://") or v.startswith("https://")):
            return jsonify({"error": "link must be http(s)"}), 400
        sets.append("value = ?"); args.append(v)
    if "caption" in data:
        sets.append("caption = ?"); args.append(data["caption"])
    if not sets:
        return jsonify({"error": "no fields to update"}), 400
    args.append(att_id)
    db = get_db()
    db.execute(f"UPDATE attachments SET {', '.join(sets)} WHERE id = ?", args)
    db.commit()
    return jsonify({"attachment": dict(db.execute(
        "SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone())})


@items_bp.route("/api/attachments/<int:att_id>", methods=["DELETE"])
@login_required
def delete_attachment(att_id):
    check_attachment_access(att_id, write=True)
    db = get_db()
    db.execute("DELETE FROM attachments WHERE id = ?", (att_id,))
    db.commit()
    return jsonify({"deleted": att_id})