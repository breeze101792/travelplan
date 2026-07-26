"""Plans blueprint: dashboard + plan pages + plan CRUD/sharing API.

HTML pages: GET /            dashboard
            GET /plans/<id>   plan board
            GET /plans/<id>/expenses
            GET /plans/<id>/members
API:        GET/POST /api/plans
            GET/PATCH/DELETE /api/plans/<id>
            GET /api/plans/<id>/members
            POST /api/plans/<id>/members          add share
            DELETE /api/plans/<id>/members/<uid>  remove share
"""
from __future__ import annotations
import time as time_mod

from flask import (Blueprint, render_template, request, redirect, url_for,
                   g, abort, jsonify, current_app)

from ..auth import login_required, admin_required, plan_access
from ..db import get_db
from ..util import ok, err
from pathlib import Path
import json
import urllib.request, urllib.parse

plans_bp = Blueprint("plans", __name__)

_SETTINGS_CACHE: dict | None = None


@plans_bp.route("/api/settings")
@login_required
def api_settings():
    """Return data/config/settings.json (item-type field templates, currencies)."""
    global _SETTINGS_CACHE
    if _SETTINGS_CACHE is None:
        path = Path(__file__).resolve().parent.parent.parent / "data" / "config" / "settings.json"
        _SETTINGS_CACHE = json.loads(path.read_text(encoding="utf-8"))
    return jsonify(_SETTINGS_CACHE)


# ------------------------------------------------------------------ pages

@plans_bp.route("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html")


@plans_bp.route("/plans/<int:plan_id>")
@plan_access()
def view_plan(plan_id):
    return render_template("plan.html", plan=g.plan, plan_role=g.plan_role)


@plans_bp.route("/plans/<int:plan_id>/expenses")
@plan_access()
def expenses_page(plan_id):
    return render_template("expenses.html", plan=g.plan, plan_role=g.plan_role)


@plans_bp.route("/plans/<int:plan_id>/timeline")
@plan_access()
def timeline_page(plan_id):
    return render_template("timeline.html", plan=g.plan, plan_role=g.plan_role)


@plans_bp.route("/plans/<int:plan_id>/members")
@plan_access()
def members_page(plan_id):
    return render_template("plan-members.html", plan=g.plan, plan_role=g.plan_role)


@plans_bp.route("/plans/<int:plan_id>/map")
@plan_access()
def map_page(plan_id):
    return render_template("plan-map.html", plan=g.plan, plan_role=g.plan_role)


@plans_bp.route("/plans/<int:plan_id>/navigation")
@plan_access()
def plan_navigation(plan_id):
    return render_template("navigation.html", plan=g.plan, plan_role=g.plan_role)


@plans_bp.route("/plans/<int:plan_id>/overview")
@plan_access()
def overview_page(plan_id):
    return render_template("overview.html", plan=g.plan, plan_role=g.plan_role)


# ------------------------------------------------------------------ API

def _row_to_plan(r):
    d = dict(r)
    return d


@plans_bp.route("/api/plans")
@login_required
def api_list_plans():
    uid = g.current_user["id"]
    role = g.current_user["role"]
    db = get_db()
    status_filter = request.args.get("status")
    if role == "admin":
        where = ""
        args = [uid, uid]
    else:
        where = "WHERE (p.owner_id = ? OR pm.user_id = ?)"
        args = [uid, uid, uid, uid]
    if status_filter in ("planning", "ongoing", "archived"):
        where += " AND p.status = ?" if where else "WHERE p.status = ?"
        args.append(status_filter)
    rows = db.execute(
        f"""SELECT p.*, (p.owner_id = ?) AS is_owner,
                   pm.role AS share_role
            FROM plans p
            LEFT JOIN plan_members pm ON pm.plan_id = p.id AND pm.user_id = ?
            {where}
            ORDER BY p.created_at DESC""",
        args,
    ).fetchall()
    plan_ids = [r["id"] for r in rows]
    buf_map = {}
    if plan_ids:
        placeholders = ",".join("?" * len(plan_ids))
        for r in db.execute(
            f"SELECT plan_id, date FROM plan_buffer_days WHERE plan_id IN ({placeholders}) ORDER BY date",
            plan_ids,
        ).fetchall():
            buf_map.setdefault(r["plan_id"], []).append(r["date"])
    plans = []
    for r in rows:
        p = dict(r)
        if p["is_owner"]:
            p["role"] = "owner"
        elif p["share_role"]:
            p["role"] = p["share_role"]
        else:
            p["role"] = "viewer"  # admin reading a plan they don't own
        p["buffer_days"] = buf_map.get(p["id"], [])
        plans.append(p)
    return jsonify({"plans": plans})


@plans_bp.route("/api/plans", methods=["POST"])
@login_required
def api_create_plan():
    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return err("title required")
    uid = g.current_user["id"]
    db = get_db()
    cur = db.execute(
        """INSERT INTO plans (title, description, owner_id, start_date, end_date, base_currency)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (title, data.get("description") or "", uid,
         data.get("start_date"), data.get("end_date"),
         data.get("base_currency") or "USD"),
    )
    plan_id = cur.lastrowid
    for d in (data.get("buffer_days") or []):
        if isinstance(d, str) and len(d) == 10 and d[4] == "-" and d[7] == "-":
            db.execute(
                "INSERT OR IGNORE INTO plan_buffer_days (plan_id, date) VALUES (?, ?)",
                (plan_id, d),
            )
    db.commit()
    return jsonify({"plan": _plan_with_buffer_days(plan_id)})


def _plan_with_buffer_days(plan_id):
    """Return the plan row joined with its buffer_days and day_meta."""
    db = get_db()
    row = db.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
    if row is None:
        return None
    plan = dict(row)
    buf = db.execute(
        "SELECT date FROM plan_buffer_days WHERE plan_id = ? ORDER BY date",
        (plan_id,),
    ).fetchall()
    plan["buffer_days"] = [r["date"] for r in buf]
    meta_rows = db.execute(
        "SELECT date, pinned, label FROM plan_day_meta WHERE plan_id = ?",
        (plan_id,),
    ).fetchall()
    plan["day_meta"] = {}
    for r in meta_rows:
        entry = {}
        if r["pinned"]:
            entry["pinned"] = True
        if r["label"]:
            entry["label"] = r["label"]
        plan["day_meta"][r["date"]] = entry
    return plan


@plans_bp.route("/api/plans/<int:plan_id>")
@plan_access()
def api_get_plan(plan_id):
    return jsonify({"plan": _plan_with_buffer_days(plan_id), "role": g.plan_role})


@plans_bp.route("/api/plans/<int:plan_id>", methods=["PATCH"])
@plan_access(write=True)
def api_update_plan(plan_id):
    if g.plan_role == "viewer":
        abort(403)
    data = request.get_json(force=True, silent=True) or {}
    allowed = ("title", "description", "start_date", "end_date", "base_currency", "cover_image", "status")
    sets = []
    args = []
    for k in allowed:
        if k in data:
            sets.append(f"{k} = ?")
            args.append(data[k])

    # Buffer-day edits: pass a list of dates to set, or {add: [...], remove: [...]}
    # to mutate the current set. The simple "set" form is convenient for the
    # initial buffer toggle (single day); the add/remove form is cheaper when
    # bulk-toggling.
    buf_set = data.get("buffer_days_set")
    buf_add = data.get("buffer_days_add") or []
    buf_remove = data.get("buffer_days_remove") or []

    db = get_db()
    if sets:
        sets.append("updated_at = datetime('now')")
        args.append(plan_id)
        db.execute(f"UPDATE plans SET {', '.join(sets)} WHERE id = ?", args)
    if buf_set is not None or buf_add or buf_remove:
        if buf_set is not None:
            # Replace the whole set. Validate as a list of ISO date strings.
            if not isinstance(buf_set, list):
                return err("buffer_days_set must be a list of dates", 400)
            for d in buf_set:
                if not (isinstance(d, str) and len(d) == 10 and d[4] == "-" and d[7] == "-"):
                    return err(f"invalid buffer date: {d!r}", 400)
            db.execute("DELETE FROM plan_buffer_days WHERE plan_id = ?", (plan_id,))
            for d in buf_set:
                db.execute(
                    "INSERT OR IGNORE INTO plan_buffer_days (plan_id, date) VALUES (?, ?)",
                    (plan_id, d),
                )
        else:
            for d in buf_add:
                if not (isinstance(d, str) and len(d) == 10 and d[4] == "-" and d[7] == "-"):
                    return err(f"invalid buffer date: {d!r}", 400)
                db.execute(
                    "INSERT OR IGNORE INTO plan_buffer_days (plan_id, date) VALUES (?, ?)",
                    (plan_id, d),
                )
            for d in buf_remove:
                if not (isinstance(d, str) and len(d) == 10 and d[4] == "-" and d[7] == "-"):
                    return err(f"invalid buffer date: {d!r}", 400)
                db.execute(
                    "DELETE FROM plan_buffer_days WHERE plan_id = ? AND date = ?",
                    (plan_id, d),
                )

    # Day metadata (pins, custom labels)
    day_meta_set = data.get("day_meta_set") or []
    if day_meta_set:
        if not isinstance(day_meta_set, list):
            return err("day_meta_set must be a list of objects", 400)
        for entry in day_meta_set:
            date = entry.get("date")
            if not date:
                continue
            pinned = 1 if entry.get("pinned") else 0
            label = entry.get("label")
            existing = db.execute(
                "SELECT 1 FROM plan_day_meta WHERE plan_id = ? AND date = ?",
                (plan_id, date),
            ).fetchone()
            if existing:
                db.execute(
                    "UPDATE plan_day_meta SET pinned = ?, label = ? WHERE plan_id = ? AND date = ?",
                    (pinned, label, plan_id, date),
                )
            else:
                db.execute(
                    "INSERT INTO plan_day_meta (plan_id, date, pinned, label) VALUES (?, ?, ?, ?)",
                    (plan_id, date, pinned, label),
                )
    db.commit()
    return jsonify({"plan": _plan_with_buffer_days(plan_id)})


@plans_bp.route("/api/plans/<int:plan_id>", methods=["DELETE"])
@plan_access()
def api_delete_plan(plan_id):
    if g.plan_role != "owner":
        abort(403)
    db = get_db()
    db.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
    db.commit()
    return jsonify({"deleted": plan_id})


# ------------------------------------------------------------------ sharing

def _can_manage_members():
    """Return True if the current user can manage this plan's members
    (owner or admin)."""
    return g.plan_role == "owner" or (g.current_user and g.current_user["role"] == "admin")


@plans_bp.route("/api/plans/<int:plan_id>/members")
@plan_access()
def api_list_members(plan_id):
    db = get_db()
    owner = dict(db.execute(
        "SELECT id, username, display_name FROM users WHERE id = ?",
        (g.plan["owner_id"],)).fetchone())
    owner["role"] = "owner"
    # Exclude admin users from the shared member list — admins are never
    # plan participants (they see every plan via a separate privilege).
    shared = [dict(r) for r in db.execute(
        """SELECT u.id, u.username, u.display_name, pm.role
           FROM plan_members pm JOIN users u ON u.id = pm.user_id
           WHERE pm.plan_id = ? AND u.role = 'member'
           ORDER BY u.username""",
        (plan_id,)).fetchall()]
    return jsonify({"owner": owner, "members": shared})


@plans_bp.route("/api/plans/<int:plan_id>/members", methods=["POST"])
@plan_access()
def api_add_member(plan_id):
    if not _can_manage_members():
        abort(403)
    data = request.get_json(force=True, silent=True) or {}
    user_id = data.get("user_id")
    role = data.get("role") or "editor"
    if role not in ("editor", "viewer"):
        return err("role must be editor or viewer", 400)
    if not user_id:
        return err("user_id required", 400)
    db = get_db()
    if not db.execute("SELECT 1 FROM users WHERE id = ? AND role = 'member'", (user_id,)).fetchone():
        return err("no such member", 404)
    db.execute(
        "INSERT OR IGNORE INTO plan_members (plan_id, user_id, role) VALUES (?, ?, ?)",
        (plan_id, user_id, role),
    )
    db.commit()
    return jsonify({"ok": True})


@plans_bp.route("/api/plans/<int:plan_id>/members/<int:user_id>", methods=["PATCH"])
@plan_access()
def api_update_member_role(plan_id, user_id):
    if not _can_manage_members():
        abort(403)
    data = request.get_json(force=True, silent=True) or {}
    role = data.get("role")
    if role not in ("editor", "viewer"):
        return err("role must be editor or viewer", 400)
    db = get_db()
    db.execute("UPDATE plan_members SET role = ? WHERE plan_id = ? AND user_id = ?",
               (role, plan_id, user_id))
    db.commit()
    return jsonify({"ok": True})


@plans_bp.route("/api/plans/<int:plan_id>/members/<int:user_id>", methods=["DELETE"])
@plan_access()
def api_remove_member(plan_id, user_id):
    if not _can_manage_members():
        abort(403)
    db = get_db()
    db.execute("DELETE FROM plan_members WHERE plan_id = ? AND user_id = ?", (plan_id, user_id))
    db.commit()
    return jsonify({"ok": True})


@plans_bp.route("/api/plans/<int:plan_id>/transfer", methods=["POST"])
@plan_access()
def api_transfer_ownership(plan_id):
    if g.plan_role != "owner" and (not g.current_user or g.current_user["role"] != "admin"):
        abort(403)
    data = request.get_json(force=True, silent=True) or {}
    new_owner_id = data.get("user_id")
    if not new_owner_id:
        return err("user_id required", 400)
    if new_owner_id == g.plan["owner_id"]:
        return err("user is already the owner", 400)
    db = get_db()
    target = db.execute("SELECT id FROM users WHERE id = ?", (new_owner_id,)).fetchone()
    if not target:
        return err("user not found", 404)
    member = db.execute(
        "SELECT 1 FROM plan_members WHERE plan_id = ? AND user_id = ?",
        (plan_id, new_owner_id),
    ).fetchone()
    if not member:
        return err("user is not a member of this plan", 400)
    old_owner_id = g.plan["owner_id"]
    db.execute("UPDATE plans SET owner_id = ? WHERE id = ?", (new_owner_id, plan_id))
    db.execute(
        "INSERT OR IGNORE INTO plan_members (plan_id, user_id, role) VALUES (?, ?, 'editor')",
        (plan_id, old_owner_id),
    )
    db.execute("DELETE FROM plan_members WHERE plan_id = ? AND user_id = ?", (plan_id, new_owner_id))
    db.commit()
    return jsonify({"ok": True})


# ------------------------------------------------------------------ geocode

_GEOCODE_LAST: float = 0
_GEOCODE_MEMO: dict[str, dict | None] = {}

def _geocode_photon(q):
    """Try Photon (komoot) geocoder — no API key needed, generous rate limit."""
    url = "https://photon.komoot.io/api/?limit=1&q=" + urllib.parse.quote(q)
    req = urllib.request.Request(url, headers={"User-Agent": "TravelPlan/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())
    features = data.get("features") or []
    if not features:
        return None
    geom = features[0].get("geometry") or {}
    coords = geom.get("coordinates")
    if not coords or len(coords) < 2:
        return None
    return {"lat": coords[1], "lng": coords[0]}


def _geocode(q, db):
    """Memoized geocode: check DB (item_geocodes lookup cache), then API, then store."""
    # In-memory memo (per request)
    if q in _GEOCODE_MEMO:
        return _GEOCODE_MEMO[q]
    global _GEOCODE_LAST
    elapsed = time_mod.time() - _GEOCODE_LAST
    if elapsed < 0.5:
        time_mod.sleep(0.5 - elapsed)
    result = None
    try:
        result = _geocode_photon(q)
    except Exception:
        pass
    _GEOCODE_LAST = time_mod.time()
    _GEOCODE_MEMO[q] = result
    return result


def _item_location_queries(item):
    """Server-side equivalent of map.js extractLocationQueries."""
    d = {}
    try:
        d = json.loads(item["details"]) if isinstance(item.get("details"), str) else (item.get("details") or {})
    except (TypeError, ValueError):
        d = {}
    t = item["item_type"]
    queries = []
    if t == "hotel" and d.get("address"):
        queries.append(("ADDR", d["address"], d["address"]))
    elif t == "restaurant" and d.get("address"):
        queries.append(("ADDR", d["address"], d["address"]))
    elif t == "activity":
        if d.get("location"):
            queries.append(("LOC", d["location"], d["location"]))
        elif d.get("address"):
            queries.append(("ADDR", d["address"], d["address"]))
    if t == "transit":
        if d.get("from"):
            queries.append(("FROM", d["from"], "From " + d["from"]))
        if d.get("to"):
            queries.append(("TO", d["to"], "To " + d["to"]))
    if item.get("title"):
        queries.append(("TITLE", item["title"], item["title"]))
    return queries


@plans_bp.route("/api/plans/<int:plan_id>/geocode-items")
@plan_access()
def api_geocode_items(plan_id):
    """Geocode all items in the plan that lack persisted coordinates.
    Runs server-side, stores results in item_geocodes table, returns
    the updated items list (same shape as GET /api/plans/<id>/items)."""
    db = get_db()
    rows = db.execute(
        "SELECT * FROM items WHERE plan_id = ? ORDER BY item_date, sort_key, id",
        (plan_id,)).fetchall()

    # Wipe old geocodes and re-compute fresh ones
    db.execute("DELETE FROM item_geocodes WHERE item_id IN (SELECT id FROM items WHERE plan_id = ?)",
               (plan_id,))

    inserted = 0
    for r in rows:
        item = dict(r)
        queries = _item_location_queries(item)
        for sort_order, (qtype, q_raw, q_label) in enumerate(queries):
            coord = _geocode(q_raw, db)
            if coord:
                db.execute(
                    "INSERT INTO item_geocodes (item_id, label, lat, lng, sort_order) VALUES (?, ?, ?, ?, ?)",
                    (item["id"], q_label, coord["lat"], coord["lng"], sort_order),
                )
                inserted += 1

    db.commit()

    # Return all items with fresh geocodes
    from .items import _attach
    items = [dict(r) for r in db.execute(
        "SELECT * FROM items WHERE plan_id = ? ORDER BY item_date, sort_key, id",
        (plan_id,)).fetchall()]
    return jsonify({"items": [_attach(i) for i in items], "geocoded": inserted})
