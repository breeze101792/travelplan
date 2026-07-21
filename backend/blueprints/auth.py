"""Auth blueprint: first-run admin setup, login/logout, self-serve settings,
and the legacy members page (admin user management).

Routes:
  GET/POST /auth/setup                    create the admin (only when none exists)
  GET/POST /auth/login                    log in
  GET     /auth/logout                    log out
  GET/POST /auth/members                  admin: list / create member accounts (legacy)
  POST    /auth/members (action=delete)   admin: remove a member (legacy)
  GET     /auth/settings                  self-serve profile + password (any user)
  POST    /auth/settings/profile          change own display name
  POST    /auth/settings/password         change own password (requires current)
  GET     /api/me                         current session (401 if anonymous)
  GET     /api/members                    admin: all member accounts (for the share dialog)
"""
from __future__ import annotations

import sqlite3

from flask import (Blueprint, render_template, request, redirect, url_for,
                   session, g, abort, jsonify)

from ..auth import (hash_password, verify_password, login_user, logout_user,
                    current_user, login_required, admin_required, admin_exists,
                    validate_password, update_user, refresh_session_display_name)
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
# Self-serve: any logged-in user can change their own display name and
# password here. Admin user management lives on the legacy /auth/members
# page (kept for back-compat and linked from the topbar for admins).

@auth_bp.route("/auth/settings", methods=["GET"])
@login_required
def settings():
    return render_template(
        "settings.html",
        me=current_user(),
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