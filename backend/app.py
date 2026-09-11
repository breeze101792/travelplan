"""Flask application factory for TravelPlan.

Python lives entirely under ``backend/``; HTML/CSS/JS is served from ``frontend/``
(Flask ``template_folder`` and ``static_folder`` point there). All user data and
config lives under ``data/``.
"""
from __future__ import annotations

from pathlib import Path

from flask import Flask

from . import db as db_mod
from .auth import ensure_secret_key

BASE_DIR = Path(__file__).resolve().parent.parent          # travelplan/
FRONTEND_DIR = BASE_DIR / "frontend"


def create_app(config: dict | None = None) -> Flask:
    app = Flask(
        __name__,
        template_folder=str(FRONTEND_DIR / "templates"),
        static_folder=str(FRONTEND_DIR / "static"),
    )

    app.config.update(
        SECRET_KEY=ensure_secret_key(),
        MAX_CONTENT_LENGTH=8 * 1024 * 1024,                 # 8 MB uploads
        UPLOAD_FOLDER=str(BASE_DIR / "data" / "uploads"),
        ALLOWED_IMAGE_EXT={"png", "jpg", "jpeg", "gif", "webp"},
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=7 * 24 * 3600,
    )
    if config:
        app.config.update(config)

    # Ensure schema exists.
    db_mod.init_db()

    app.teardown_appcontext(db_mod.close_db)

    # Blueprints
    from .blueprints.auth import auth_bp
    from .blueprints.plans import plans_bp
    from .blueprints.items import items_bp
    from .blueprints.uploads import uploads_bp
    from .blueprints.expenses import expenses_bp
    from .blueprints.ai import ai_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(plans_bp)
    app.register_blueprint(items_bp)
    app.register_blueprint(uploads_bp)
    app.register_blueprint(expenses_bp)
    app.register_blueprint(ai_bp)

    @app.after_request
    def set_no_cache_for_auth(response):
        from flask import session as sess
        if "user_id" in sess:
            response.headers["Cache-Control"] = (
                "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
            )
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
            response.headers["Surrogate-Control"] = "no-store"
        return response

    @app.errorhandler(401)
    def handle_unauthorized(e):
        from flask import request as req, redirect as redir, url_for as uf, jsonify
        if req.path.startswith("/api/") or req.accept_mimetypes.best == "application/json":
            return jsonify({"error": "unauthorized"}), 401
        return redir(uf("auth.login", next=req.path))

    @app.context_processor
    def inject_user():
        import subprocess
        from .auth import current_user
        from .util import fmt_date
        try:
            static_version = subprocess.check_output(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=str(BASE_DIR), stderr=subprocess.DEVNULL, timeout=2,
            ).decode("ascii", errors="replace").strip()
        except Exception:
            static_version = "0"
        return {
            "current_user": current_user(),
            # Server-side date formatter used by the per-plan header
            # partial so the initial render matches the frontend's
            # fmtDate() output (no "flash" of raw ISO dates).
            "fmt_date": fmt_date,
            # Version string for cache-busting static assets.
            # Changes after every git pull, so browsers fetch fresh JS/CSS.
            "static_version": static_version,
        }

    @app.route("/")
    def index():
        from flask import redirect, url_for, session, request
        from .auth import admin_exists
        # First run: no admin yet -> send the user to create the admin account.
        if not admin_exists():
            return redirect(url_for("auth.setup"))
        # Not signed in -> login. Otherwise -> the trips dashboard.
        if "user_id" not in session:
            return redirect(url_for("auth.login", next=request.path))
        return redirect(url_for("plans.dashboard"))

    return app


# Allow `flask --app backend.app run` and `python -m backend.app`.
app = create_app()


if __name__ == "__main__":
    import os
    debug = os.environ.get("DEBUG", "") == "1"
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5050"))
    app.run(host=host, port=port, debug=debug, use_reloader=debug)