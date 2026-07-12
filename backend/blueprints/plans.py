"""Plans blueprint: dashboard + plan pages + plan CRUD/sharing API.

HTML pages: GET /            dashboard
            GET /plans/<id>   plan board
            GET /plans/<id>/expenses
            GET /plans/<id>/share
API:        GET/POST /api/plans
            GET/PATCH/DELETE /api/plans/<id>
            GET /api/plans/<id>/members
            POST /api/plans/<id>/members          add share
            DELETE /api/plans/<id>/members/<uid>  remove share
"""
from __future__ import annotations

from flask import (Blueprint, render_template, request, redirect, url_for,
                   g, abort, jsonify, current_app)

from ..auth import login_required, admin_required, plan_access
from ..db import get_db
from ..util import ok, err
from pathlib import Path
import json

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


@plans_bp.route("/plans/<int:plan_id>/share")
@plan_access()
def share_page(plan_id):
    if g.plan_role != "owner":
        abort(403)
    return render_template("share.html", plan=g.plan, plan_role=g.plan_role)


# ------------------------------------------------------------------ API

def _row_to_plan(r):
    d = dict(r)
    return d


@plans_bp.route("/api/plans")
@login_required
def api_list_plans():
    uid = g.current_user["id"]
    db = get_db()
    rows = db.execute(
        """SELECT p.*, (p.owner_id = ?) AS is_owner,
                  pm.role AS share_role
           FROM plans p
           LEFT JOIN plan_members pm ON pm.plan_id = p.id AND pm.user_id = ?
           WHERE p.owner_id = ? OR pm.user_id = ?
           ORDER BY p.created_at DESC""",
        (uid, uid, uid, uid),
    ).fetchall()
    plans = []
    for r in rows:
        p = dict(r)
        p["role"] = "owner" if p["is_owner"] else p["share_role"]
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
    db.commit()
    return jsonify({"plan": dict(db.execute(
        "SELECT * FROM plans WHERE id = ?", (cur.lastrowid,)).fetchone())})


@plans_bp.route("/api/plans/<int:plan_id>")
@plan_access()
def api_get_plan(plan_id):
    return jsonify({"plan": g.plan, "role": g.plan_role})


@plans_bp.route("/api/plans/<int:plan_id>", methods=["PATCH"])
@plan_access(write=True)
def api_update_plan(plan_id):
    if g.plan_role == "viewer":
        abort(403)
    data = request.get_json(force=True, silent=True) or {}
    allowed = ("title", "description", "start_date", "end_date", "base_currency", "cover_image")
    sets = []
    args = []
    for k in allowed:
        if k in data:
            sets.append(f"{k} = ?")
            args.append(data[k])
    if sets:
        sets.append("updated_at = datetime('now')")
        args.append(plan_id)
        db = get_db()
        db.execute(f"UPDATE plans SET {', '.join(sets)} WHERE id = ?", args)
        db.commit()
    return jsonify({"plan": dict(db_exec_plan(plan_id))})


@plans_bp.route("/api/plans/<int:plan_id>", methods=["DELETE"])
@plan_access()
def api_delete_plan(plan_id):
    if g.plan_role != "owner":
        abort(403)
    db = get_db()
    db.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
    db.commit()
    return jsonify({"deleted": plan_id})


def db_exec_plan(plan_id):
    return get_db().execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()


# ------------------------------------------------------------------ sharing

@plans_bp.route("/api/plans/<int:plan_id>/members")
@plan_access()
def api_list_members(plan_id):
    db = get_db()
    owner = dict(db.execute(
        "SELECT id, username, display_name FROM users WHERE id = ?",
        (g.plan["owner_id"],)).fetchone())
    owner["role"] = "owner"
    shared = [dict(r) for r in db.execute(
        """SELECT u.id, u.username, u.display_name, pm.role
           FROM plan_members pm JOIN users u ON u.id = pm.user_id
           WHERE pm.plan_id = ? ORDER BY u.username""",
        (plan_id,)).fetchall()]
    return jsonify({"owner": owner, "members": shared})


@plans_bp.route("/api/plans/<int:plan_id>/members", methods=["POST"])
@plan_access()
def api_add_member(plan_id):
    if g.plan_role != "owner":
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
    if g.plan_role != "owner":
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
    if g.plan_role != "owner":
        abort(403)
    db = get_db()
    db.execute("DELETE FROM plan_members WHERE plan_id = ? AND user_id = ?", (plan_id, user_id))
    db.commit()
    return jsonify({"ok": True})