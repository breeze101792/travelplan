"""Auth blueprint: first-run admin setup, login/logout, member management (admin).

Routes:
  GET/POST /auth/setup    create the admin (only available when no admin exists)
  GET/POST /auth/login    log in
  GET     /auth/logout    log out
  GET/POST /auth/members  admin: list / create member accounts
  POST    /auth/members/<id>/delete   admin: remove a member
  GET     /api/me         current session (401 if anonymous)
  GET     /api/members    admin: all member accounts (for the share dialog)
"""
from __future__ import annotations

import sqlite3

from flask import (Blueprint, render_template, request, redirect, url_for,
                   session, g, abort, jsonify)

from ..auth import (hash_password, verify_password, login_user, logout_user,
                    current_user, login_required, admin_required, admin_exists)
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
    rows = get_db().execute(
        "SELECT id, username, display_name, role FROM users WHERE role = 'member' ORDER BY username"
    ).fetchall()
    return jsonify({"members": [dict(r) for r in rows]})