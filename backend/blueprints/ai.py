"""AI blueprint: web endpoints for the in-app AI assistant.

The floating chat window on the plan pages calls these endpoints to talk to
the plan's AI assistant and to turn pasted text into a structured item. The
logic is shared with the MCP server via :mod:`backend.ai`.

API:
  POST /api/plans/<id>/ai/extract   {text, item_type?} -> {item}
  POST /api/plans/<id>/ai/chat     {messages, image?} -> {reply, items}
"""
from __future__ import annotations

from flask import Blueprint, request, jsonify

from ..auth import plan_access
from ..ai import extract_item, chat, AIConfigError
from ..db import get_db

ai_bp = Blueprint("ai", __name__)


def _plan_context(plan_id: int) -> str:
    """Build a short text summary of the plan for the AI's context."""
    plan = get_db().execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
    if plan is None:
        return ""
    plan = dict(plan)
    items = get_db().execute(
        "SELECT id, item_type, title, item_date, end_date FROM items "
        "WHERE plan_id = ? ORDER BY item_date, sort_key, id",
        (plan_id,),
    ).fetchall()
    lines = [
        f"Title: {plan.get('title')}",
        f"Dates: {plan.get('start_date')} to {plan.get('end_date')}",
        f"Base currency: {plan.get('base_currency')}",
        "Items (id, date, type, title):",
    ]
    for it in items:
        it = dict(it)
        lines.append(f"- id {it['id']}: {it['item_date']} {it['item_type']}: {it['title']}")
    return "\n".join(lines)


@ai_bp.route("/api/plans/<int:plan_id>/ai/extract", methods=["POST"])
@plan_access(write=True)
def api_ai_extract(plan_id):
    """Parse pasted text into a structured itinerary item.

    Requires write access (viewers get 403). Returns the item shaped like
    the item editor's snapshot: {item_type, title, details, when, item_date,
    end_date}. The client opens the item editor pre-filled from this.
    """
    data = request.get_json(force=True, silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text required"}), 400
    try:
        item = extract_item(text, item_type=data.get("item_type"))
    except AIConfigError:
        return jsonify({"error": "AI is not configured"}), 503
    except ValueError as e:
        return jsonify({"error": str(e)}), 422
    return jsonify({"item": item})


@ai_bp.route("/api/plans/<int:plan_id>/ai/chat", methods=["POST"])
@plan_access()
def api_ai_chat(plan_id):
    """Run a conversational turn with the plan's AI assistant.

    Body: {messages: [{role, content}], image?: data-URL}. Returns
    {reply, items} where items are suggested itinerary items the client can
    offer to add. Read access is enough to chat; adding items still goes
    through the normal write path.
    """
    data = request.get_json(force=True, silent=True) or {}
    messages = data.get("messages") or []
    if not isinstance(messages, list) or not messages:
        return jsonify({"error": "messages required"}), 400
    image = data.get("image")
    if image and not isinstance(image, str):
        return jsonify({"error": "image must be a data URL"}), 400
    try:
        result = chat(_plan_context(plan_id), messages, image_url=image)
    except AIConfigError:
        return jsonify({"error": "AI is not configured"}), 503
    except ValueError as e:
        return jsonify({"error": str(e)}), 422
    return jsonify(result)
