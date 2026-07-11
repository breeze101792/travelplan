"""Uploads blueprint: image upload for items + serving uploaded files.

API:
  POST /api/items/<id>/upload   multipart "file" -> {attachment}
  GET  /uploads/<name>          serve an uploaded image
"""
from __future__ import annotations

import uuid
from pathlib import Path

from flask import (Blueprint, request, current_app, send_from_directory,
                   jsonify, abort)
from werkzeug.utils import secure_filename

from ..auth import login_required, check_item_access
from ..db import get_db

uploads_bp = Blueprint("uploads", __name__)

# first-bytes -> mime, used for content-based type validation (no python-magic)
_IMAGE_SIGNATURES = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"RIFF", "image/webp"),   # webp = RIFF....WEBP
)


def _allowed(filename: str) -> bool:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext in current_app.config["ALLOWED_IMAGE_EXT"]


def _sniff_mime(header: bytes) -> str | None:
    for sig, mime in _IMAGE_SIGNATURES:
        if header.startswith(sig):
            return mime
    return None


@uploads_bp.route("/api/items/<int:item_id>/upload", methods=["POST"])
@login_required
def upload_item_image(item_id):
    check_item_access(item_id, write=True)
    if "file" not in request.files:
        return jsonify({"error": "no file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "no filename"}), 400
    if not _allowed(f.filename):
        return jsonify({"error": "file type not allowed"}), 400

    header = f.read(16)
    f.seek(0)
    if _sniff_mime(header) is None:
        return jsonify({"error": "file does not look like an image"}), 400

    ext = secure_filename(f.filename).rsplit(".", 1)[-1].lower()
    stored = f"{uuid.uuid4().hex}.{ext}"
    upload_dir = Path(current_app.config["UPLOAD_FOLDER"])
    upload_dir.mkdir(parents=True, exist_ok=True)
    f.save(str(upload_dir / stored))

    cur = get_db().execute(
        "INSERT INTO attachments (item_id, kind, value, caption) VALUES (?, 'image', ?, ?)",
        (item_id, stored, f.filename))
    get_db().commit()
    att = dict(get_db().execute(
        "SELECT * FROM attachments WHERE id = ?", (cur.lastrowid,)).fetchone())
    att["url"] = f"/uploads/{stored}"
    return jsonify({"attachment": att})


@uploads_bp.route("/uploads/<path:name>")
def serve_upload(name):
    # prevent traversal: secure_filename strips path separators
    safe = secure_filename(name)
    if not safe or safe != name.split("/")[-1]:
        abort(404)
    return send_from_directory(current_app.config["UPLOAD_FOLDER"], safe)