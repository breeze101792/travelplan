"""Auth blueprint: first-run admin setup, login/logout, member management (admin),
self-serve settings (any logged-in user), and admin user management.

Routes:
  GET/POST /auth/setup                           create the admin (only when none exists)
  GET/POST /auth/login                           log in
  GET     /auth/logout                           log out
  GET/POST /auth/members                         admin: list / create member accounts (legacy)
  POST    /auth/members (action=delete)          admin: remove a member (legacy)
  GET     /auth/settings                         self-serve profile + password + (admin) members
  POST    /auth/settings/profile                 change own display name
  POST    /auth/settings/password                change own password (requires current)
  POST    /auth/settings/admin/create-user       admin: create a member
  POST    /auth/settings/admin/edit-user         admin: edit a user's display name and/or password
  POST    /auth/settings/admin/delete-user       admin: delete a user (with safety checks)
  GET     /api/me                                current session (401 if anonymous)
  GET     /api/members                           admin: all member accounts (for the share dialog)
"""
from __future__ import annotations

import sqlite3

from flask import (Blueprint, render_template, request, redirect, url_for,
                   session, g, abort, jsonify)

from ..auth import (hash_password, verify_password, login_user, logout_user,
                    current_user, login_required, admin_required, admin_exists,
                    validate_password, update_user, refresh_session_display_name,
                    get_user)
from ..db import get_db
from ..util import ok, err

auth_bp = Blueprint("auth", __name__)


@auth_bp.route("/api/me")
def me():
    user = current_user()
    if not user:
        return jsonify({"user": None}), 401
    return jsonify({"user": user})


@auth_bp.route("/auth/setup", methods=["GET", "POST"])
def setup():
    if admin_exists():
        return redirect(url_for("auth.login"))
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        display_name = (request.form.get("display_name") or "").strip()
        if not username or not password:
            return render_template("setup.html", error="Username and password are required.")
        pw_err = validate_password(password)
        if pw_err:
            return render_template("setup.html", error=pw_err)
        db = get_db()
        try:
            db.execute(
                "INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, 'admin')",
                (username, hash_password(password), display_name or username),
            )
            db.commit()
        except sqlite3.IntegrityError:
            return render_template("setup.html", error="That username is taken.")
        return redirect(url_for("auth.login"))
    return render_template("setup.html", error=None)


@auth_bp.route("/auth/login", methods=["GET", "POST"])
def login():
    if "user_id" in session:
        return redirect(url_for("plans.dashboard"))
    # First run: no admin yet -> go set up the admin account instead of login.
    if not admin_exists():
        return redirect(url_for("auth.setup"))
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        row = get_db().execute(
            "SELECT * FROM users WHERE username = ?", (username,)
        ).fetchone()
        if row is None or not verify_password(password, row["password_hash"]):
            return render_template("login.html", error="Invalid username or password.")
        login_user(dict(row))
        nxt = request.form.get("next") or request.args.get("next")
        if nxt and not nxt.startswith("//") and "/" in nxt:
            return redirect(nxt)
        return redirect(url_for("plans.dashboard"))
    return render_template("login.html", error=None)


@auth_bp.route("/auth/logout")
def logout():
    logout_user()
    return redirect(url_for("auth.login"))


@auth_bp.route("/auth/members", methods=["GET", "POST"])
@admin_required
def members():
    db = get_db()
    if request.method == "POST":
        action = request.form.get("action", "create")
        if action == "delete":
            mid = request.form.get("member_id")
            if mid:
                db.execute("DELETE FROM users WHERE id = ? AND role = 'member'", (mid,))
                db.commit()
            return redirect(url_for("auth.members"))
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        display_name = (request.form.get("display_name") or "").strip()
        if not username or not password:
            return render_template("members.html", error="Username and password required.",
                                   members=list_users(db))
        pw_err = validate_password(password)
        if pw_err:
            return render_template("members.html", error=pw_err, members=list_users(db))
        try:
            db.execute(
                "INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, 'member')",
                (username, hash_password(password), display_name or username),
            )
            db.commit()
        except sqlite3.IntegrityError:
            return render_template("members.html", error="That username is taken.",
                                   members=list_users(db))
        return redirect(url_for("auth.members"))
    return render_template("members.html", error=None, members=list_users(db))


def list_users(db):
    return [dict(r) for r in db.execute(
        "SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at"
    ).fetchall()]


@auth_bp.route("/api/members")
@login_required
def api_members():
    # Used by the share dialog: only member accounts can be added as plan
    # collaborators (admins already have owner access to every plan they
    # own and aren't candidates for plan_members entries).
    rows = get_db().execute(
        "SELECT id, username, display_name, role FROM users WHERE role = 'member' ORDER BY username"
    ).fetchall()
    return jsonify({"members": [dict(r) for r in rows]})


# ---------------------------------------------------------------- settings
#
# The /auth/settings page is the primary UI for the user to change their
# own display name and password, and (for admins) to manage all accounts.
# Older /auth/members page is kept for back-compat.

def _all_users():
    return [dict(r) for r in get_db().execute(
        "SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at"
    ).fetchall()]


@auth_bp.route("/auth/settings", methods=["GET"])
@login_required
def settings():
    me = current_user()
    return render_template(
        "settings.html",
        me=me,
        is_admin=(me["role"] == "admin"),
        users=_all_users() if me["role"] == "admin" else [],
        error=request.args.get("error"),
        info=request.args.get("info"),
    )


@auth_bp.route("/auth/settings/profile", methods=["POST"])
@login_required
def settings_profile():
    display_name = (request.form.get("display_name") or "").strip()
    if not display_name:
        return redirect(url_for("auth.settings", error="Display name is required."))
    update_user(user_id=current_user()["id"], display_name=display_name)
    refresh_session_display_name()                  # update the topbar immediately
    return redirect(url_for("auth.settings", info="Display name updated."))


@auth_bp.route("/auth/settings/password", methods=["POST"])
@login_required
def settings_password():
    current_pw = request.form.get("current_password") or ""
    new_pw = request.form.get("new_password") or ""
    confirm = request.form.get("confirm_password") or ""
    # Reject obviously-bad input first; do NOT reveal whether the current
    # password was correct vs the new password was weak (avoid a user-enum
    # vector and a password-policy oracle).
    pw_err = validate_password(new_pw)
    if pw_err:
        return redirect(url_for("auth.settings", error=pw_err))
    if new_pw != confirm:
        return redirect(url_for("auth.settings", error="New password and confirmation do not match."))
    row = get_db().execute("SELECT password_hash FROM users WHERE id = ?",
                           (current_user()["id"],)).fetchone()
    if row is None or not verify_password(current_pw, row["password_hash"]):
        return redirect(url_for("auth.settings", error="Current password is incorrect."))
    update_user(user_id=current_user()["id"], password=new_pw)
    return redirect(url_for("auth.settings", info="Password updated."))


@auth_bp.route("/auth/settings/admin/create-user", methods=["POST"])
@admin_required
def settings_create_user():
    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""
    display_name = (request.form.get("display_name") or "").strip()
    if not username or not password:
        return redirect(url_for("auth.settings", error="Username and password are required."))
    pw_err = validate_password(password)
    if pw_err:
        return redirect(url_for("auth.settings", error=pw_err))
    db = get_db()
    try:
        db.execute(
            "INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, 'member')",
            (username, hash_password(password), display_name or username),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return redirect(url_for("auth.settings", error="That username is taken."))
    return redirect(url_for("auth.settings", info=f"Created member “{username}”."))


@auth_bp.route("/auth/settings/admin/edit-user", methods=["POST"])
@admin_required
def settings_edit_user():
    try:
        user_id = int(request.form.get("user_id") or 0)
    except ValueError:
        return redirect(url_for("auth.settings", error="Invalid user."))
    target = get_user(user_id)
    if target is None:
        return redirect(url_for("auth.settings", error="User not found."))
    display_name = request.form.get("display_name")
    new_pw = request.form.get("new_password") or ""
    if display_name is not None:
        display_name = display_name.strip()
    if new_pw:
        pw_err = validate_password(new_pw)
        if pw_err:
            return redirect(url_for("auth.settings", error=pw_err))
    # No-op if both fields are blank.
    if (display_name is None or display_name == "") and not new_pw:
        return redirect(url_for("auth.settings", info="No changes to save."))
    update_user(user_id=user_id, display_name=display_name, password=new_pw or None)
    # If the admin edited their own display name, refresh the topbar.
    if user_id == current_user()["id"]:
        refresh_session_display_name()
    return redirect(url_for("auth.settings", info=f"Updated “{target['username']}”."))


@auth_bp.route("/auth/settings/admin/delete-user", methods=["POST"])
@admin_required
def settings_delete_user():
    try:
        user_id = int(request.form.get("user_id") or 0)
    except ValueError:
        return redirect(url_for("auth.settings", error="Invalid user."))
    if user_id == current_user()["id"]:
        return redirect(url_for("auth.settings", error="You can't delete your own account here."))
    target = get_user(user_id)
    if target is None:
        return redirect(url_for("auth.settings", error="User not found."))
    # The self-delete check above already prevents an admin from reducing
    # the admin count to zero (admins cannot delete themselves), so an
    # explicit "last admin" check would be unreachable. The safety here is
    # therefore the self-delete guard plus the ownership/share guard below
    # (a user with plans or shares can't be silently deleted).
    # plan_members / items / expenses have ON DELETE CASCADE? (no — we don't
    # define any). To avoid orphaning plan ownership or shares, refuse to
    # delete a user who owns plans or has plan_members rows.
    owns = get_db().execute("SELECT COUNT(*) AS c FROM plans WHERE owner_id = ?", (user_id,)).fetchone()["c"]
    shared = get_db().execute("SELECT COUNT(*) AS c FROM plan_members WHERE user_id = ?", (user_id,)).fetchone()["c"]
    if owns or shared:
        return redirect(url_for("auth.settings",
            error=f"Refusing to delete: {target['username']} owns {owns} plan(s) and is shared on {shared}. Reassign or delete those first."))
    get_db().execute("DELETE FROM users WHERE id = ?", (user_id,))
    get_db().commit()
    return redirect(url_for("auth.settings", info=f"Deleted “{target['username']}”."))