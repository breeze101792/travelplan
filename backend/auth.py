"""Authentication & authorization helpers.

Session-based, no third-party login lib. Passwords hashed with werkzeug (scrypt).
Admin is created on first run via ``/auth/setup``; admin then creates members.
Plans are shared per-plan; :func:`plan_access_required` enforces owner-or-shared.
"""
from __future__ import annotations

import secrets
from functools import wraps
from pathlib import Path

from flask import session, g, request, redirect, url_for, abort, current_app
from werkzeug.security import generate_password_hash, check_password_hash

from .db import get_db, DATA_DIR

SECRET_KEY_FILE = DATA_DIR / "config" / "secret_key"


def ensure_secret_key() -> str:
    """Load (or generate on first run) the session secret under data/config/."""
    DATA_DIR.joinpath("config").mkdir(parents=True, exist_ok=True)
    if SECRET_KEY_FILE.exists():
        return SECRET_KEY_FILE.read_text(encoding="utf-8").strip()
    key = secrets.token_hex(32)
    SECRET_KEY_FILE.write_text(key, encoding="utf-8")
    # Restrict permissions where possible.
    try:
        SECRET_KEY_FILE.chmod(0o600)
    except OSError:
        pass
    return key


# ---------------------------------------------------------------- passwords

# Minimum length enforced on every password set or change (own or admin-set
# on another user). The signup flow uses the same minimum via the helpers
# below. Keep the constant here so the rule is defined in one place.
MIN_PASSWORD_LENGTH = 8


def hash_password(password: str) -> str:
    return generate_password_hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return check_password_hash(password_hash, password)


def validate_password(password: str) -> str | None:
    """Return an error message if the password is invalid, else None."""
    if not password:
        return "Password is required."
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    return None


# ---------------------------------------------------------------- user updates

def update_display_name(user_id: int, display_name: str) -> None:
    """Set a user's display name. Empty values fall back to the username."""
    get_db().execute(
        "UPDATE users SET display_name = ? WHERE id = ?",
        (display_name, user_id),
    )
    get_db().commit()


def update_password(user_id: int, new_password: str) -> None:
    """Replace a user's password (already validated by validate_password)."""
    get_db().execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (hash_password(new_password), user_id),
    )
    get_db().commit()


def update_user(user_id: int, *, display_name=None, password=None) -> None:
    """Apply optional display_name and/or password to a user in one UPDATE.

    Empty/None values for password are a no-op (admin can change just the
    name). Empty string for display_name clears it (login_user falls back
    to username). The caller is responsible for password policy; for the
    self-serve path also require the current password before calling this.
    """
    sets, args = [], []
    if display_name is not None:
        sets.append("display_name = ?"); args.append(display_name)
    if password:
        sets.append("password_hash = ?"); args.append(hash_password(password))
    if not sets:
        return
    args.append(user_id)
    get_db().execute(f"UPDATE users SET {', '.join(sets)} WHERE id = ?", args)
    get_db().commit()


def get_user(user_id: int) -> dict | None:
    row = get_db().execute(
        "SELECT id, username, display_name, role FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------- sessions

def login_user(user_row: dict) -> None:
    session.clear()
    session["user_id"] = user_row["id"]
    session["username"] = user_row["username"]
    session["display_name"] = user_row.get("display_name") or user_row["username"]
    session["role"] = user_row["role"]
    session.permanent = True


def logout_user() -> None:
    session.clear()


def current_user() -> dict | None:
    if "user_id" not in session:
        return None
    return {
        "id": session["user_id"],
        "username": session["username"],
        "display_name": session.get("display_name") or session["username"],
        "role": session["role"],
    }


def refresh_session_display_name() -> None:
    """Re-read the current user's display_name from the DB into the session.

    Call after a self-serve rename so the topbar shows the new name without
    requiring the user to log out and back in. Cheap (single-row lookup).
    """
    if "user_id" not in session:
        return
    row = get_db().execute(
        "SELECT display_name, username FROM users WHERE id = ?",
        (session["user_id"],),
    ).fetchone()
    if row is None:
        return
    session["display_name"] = row["display_name"] or row["username"]


def load_user_record(user_id: int) -> dict | None:
    row = get_db().execute(
        "SELECT id, username, display_name, role FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------- decorators

def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            # JSON endpoints get 401; pages redirect.
            best = request.accept_mimetypes
            if best.best == "application/json" or request.path.startswith("/api/"):
                abort(401)
            return redirect(url_for("auth.login", next=request.path))
        g.current_user = current_user()
        return f(*args, **kwargs)
    return wrapper


def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            if request.path.startswith("/api/"):
                abort(401)
            return redirect(url_for("auth.login", next=request.path))
        if session.get("role") != "admin":
            abort(403)
        g.current_user = current_user()
        return f(*args, **kwargs)
    return wrapper


def check_plan_access(plan_id, *, write: bool = False) -> dict:
    """Resolve access for ``plan_id`` (owner or shared). Sets ``g.plan`` /
    ``g.plan_role`` and returns the plan dict; aborts on missing/no-access."""
    if "user_id" not in session:
        abort(401)
    plan = get_db().execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
    if plan is None:
        abort(404)
    plan = dict(plan)
    uid = session["user_id"]
    cu = current_user()
    # Admin can read any plan but cannot write unless they're the owner
    if cu and cu["role"] == "admin" and plan["owner_id"] != uid:
        if write:
            abort(403)
        g.plan_role = "viewer"
        g.plan = plan
        g.current_user = cu
        return plan
    if plan["owner_id"] == uid:
        role = "owner"
    else:
        share = get_db().execute(
            "SELECT role FROM plan_members WHERE plan_id = ? AND user_id = ?",
            (plan_id, uid),
        ).fetchone()
        if share is None:
            abort(403)
        role = share["role"]  # 'editor' | 'viewer'
    if write and role == "viewer":
        abort(403)
    g.plan = plan
    g.plan_role = role
    g.current_user = cu
    return plan


def check_item_access(item_id, *, write: bool = False) -> dict:
    item = get_db().execute("SELECT plan_id FROM items WHERE id = ?", (item_id,)).fetchone()
    if item is None:
        abort(404)
    return check_plan_access(item["plan_id"], write=write)


def check_attachment_access(att_id, *, write: bool = False) -> dict:
    att = get_db().execute("SELECT item_id FROM attachments WHERE id = ?", (att_id,)).fetchone()
    if att is None:
        abort(404)
    return check_item_access(att["item_id"], write=write)


def check_expense_access(expense_id, *, write: bool = False) -> dict:
    ex = get_db().execute("SELECT plan_id FROM expenses WHERE id = ?", (expense_id,)).fetchone()
    if ex is None:
        abort(404)
    return check_plan_access(ex["plan_id"], write=write)


def check_payment_access(payment_id, *, write: bool = False) -> dict:
    p = get_db().execute("SELECT plan_id FROM payments WHERE id = ?", (payment_id,)).fetchone()
    if p is None:
        abort(404)
    return check_plan_access(p["plan_id"], write=write)


def plan_access(plan_id_arg: str = "plan_id", *, write: bool = False):
    """Decorator for routes that carry ``plan_id`` in the URL (owner or shared).
    Stores the plan row (and the user's role on this plan) on ``g.plan`` / ``g.plan_role``.
    For routes keyed by item/attachment/expense ids, call ``check_item_access`` etc.
    inside the handler instead.
    """
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            plan_id = kwargs.get(plan_id_arg)
            if plan_id is None:
                abort(400)
            check_plan_access(plan_id, write=write)
            return f(*args, **kwargs)
        return wrapper
    return decorator


def admin_exists() -> bool:
    row = get_db().execute("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").fetchone()
    return row is not None