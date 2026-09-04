"""End-to-end tests for the AI agent flow across the web API.

These exercise the full user journey: the user chats with the plan's AI
assistant (via ``POST /api/plans/<id>/ai/chat``), the assistant returns
suggested itinerary items, and the user adds one via the normal items API
(``POST /api/plans/<id>/items``). The upstream LLM call is stubbed by
monkeypatching ``urllib.request.urlopen`` and pointing ``ai.CONFIG_PATH`` at
a temp file, so no network or API key is needed.

Read-only gating is also covered: a viewer may chat but cannot add items,
and an archived plan must block item creation.
"""
from __future__ import annotations

import json

import pytest

from backend import ai as ai_mod


@pytest.fixture
def ai_config(tmp_path, monkeypatch):
    """Point ai.CONFIG_PATH at a temp file and write a valid config."""
    cfg_path = tmp_path / "ai.json"
    monkeypatch.setattr(ai_mod, "CONFIG_PATH", cfg_path)
    cfg_path.write_text(json.dumps({
        "base_url": "https://api.example.com/v1",
        "api_key": "sk-test",
        "model": "test-model",
    }), encoding="utf-8")


@pytest.fixture
def stub_llm(monkeypatch):
    """Stub urlopen to return a canned chat-completions response."""
    def _stub(response_obj):
        class _Resp:
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
            def read(self):
                return json.dumps({
                    "choices": [{"message": {"content": json.dumps(response_obj)}}]
                }).encode("utf-8")
        monkeypatch.setattr(ai_mod.urllib.request, "urlopen", lambda *a, **k: _Resp())
    return _stub


CHAT_RESULT = {
    "reply": "Here's a flight suggestion.",
    "items": [
        {"item_type": "transit", "title": "JL 123 Tokyo to Osaka",
         "details": {"mode": "Flight", "provider": "JAL",
                     "when": {"start_at": "2026-09-10T09:00"}}},
    ],
}


def _make_plan(client, title="Trip"):
    r = client.post("/api/plans", json={"title": title})
    assert r.status_code == 200, r.data
    return r.get_json()["plan"]["id"]


def _archive_plan(app, plan_id):
    with app.app_context():
        from backend.db import get_db
        db = get_db()
        db.execute("UPDATE plans SET status = 'archived' WHERE id = ?", (plan_id,))
        db.commit()


# ---------------------------------------------------------------- full flow

def test_chat_then_add_item_flow(member_client, ai_config, stub_llm):
    """User chats, gets a suggestion, adds it, and it shows up in the plan."""
    pid = _make_plan(member_client)
    stub_llm(CHAT_RESULT)

    # 1. Chat with the assistant.
    r = member_client.post(f"/api/plans/{pid}/ai/chat", json={
        "messages": [{"role": "user", "content": "add a flight"}],
    })
    assert r.status_code == 200, r.data
    data = r.get_json()
    assert data["reply"] == "Here's a flight suggestion."
    assert len(data["items"]) == 1
    suggested = data["items"][0]
    assert suggested["item_type"] == "transit"
    assert suggested["title"] == "JL 123 Tokyo to Osaka"

    # 2. Add the suggested item via the items API.
    r = member_client.post(f"/api/plans/{pid}/items", json={
        "item_type": suggested["item_type"],
        "title": suggested["title"],
        "details": suggested["details"],
    })
    assert r.status_code == 200, r.data
    created = r.get_json()["item"]
    assert created["item_type"] == "transit"
    assert created["item_date"] == "2026-09-10"

    # 3. It appears in list_items and get_plan.
    r = member_client.get(f"/api/plans/{pid}/items")
    assert r.status_code == 200
    items = r.get_json()["items"]
    assert len(items) == 1
    assert items[0]["id"] == created["id"]
    assert items[0]["title"] == "JL 123 Tokyo to Osaka"

    r = member_client.get(f"/api/plans/{pid}")
    assert r.status_code == 200
    assert r.get_json()["plan"]["id"] == pid


# ---------------------------------------------------------------- read-only gating

def test_viewer_can_chat_but_cannot_add(app, member_client, make_plan, make_user,
                                        ai_config, stub_llm):
    """A viewer may chat (read access) but the Add flow is blocked (403)."""
    pid = make_plan()["id"]
    carol_id = make_user(username="carol")["id"]
    member_client.post(f"/api/plans/{pid}/members",
                       json={"user_id": carol_id, "role": "viewer"})

    carol = app.test_client()
    carol.post("/auth/login", data={"username": "carol", "password": "pw12345"})

    # Viewer can chat.
    stub_llm(CHAT_RESULT)
    r = carol.post(f"/api/plans/{pid}/ai/chat", json={
        "messages": [{"role": "user", "content": "add a flight"}],
    })
    assert r.status_code == 200, r.data
    assert len(r.get_json()["items"]) == 1

    # But adding an item is blocked.
    r = carol.post(f"/api/plans/{pid}/items", json={
        "item_type": "transit", "title": "JL 123", "details": {},
    })
    assert r.status_code == 403


def test_archived_plan_blocks_item_create(app, member_client, make_plan, ai_config):
    """An archived plan is read-only: item creation is blocked (403)."""
    pid = make_plan()["id"]
    _archive_plan(app, pid)

    r = member_client.post(f"/api/plans/{pid}/items", json={
        "item_type": "note", "title": "x", "details": {},
    })
    assert r.status_code == 403


# ---------------------------------------------------------------- edit flow

def test_chat_then_edit_item_flow(member_client, ai_config, stub_llm):
    """User asks to change a date; the agent returns an edit; the user applies
    it via the normal PATCH endpoint and the change sticks."""
    pid = _make_plan(member_client)

    # Create a hotel item first.
    r = member_client.post(f"/api/plans/{pid}/items", json={
        "item_type": "hotel", "title": "Beverly Hotels Elements",
        "details": {"when": {"start_at": "2026-09-24T15:00", "end_at": "2026-09-29T11:00"}},
    })
    assert r.status_code == 200, r.data
    item = r.get_json()["item"]
    item_id = item["id"]
    assert item["item_date"] == "2026-09-24"
    assert item["end_date"] == "2026-09-29"

    # Chat: the agent proposes an edit to that item.
    stub_llm({
        "reply": "I've moved your checkout to Sep 30.",
        "items": [],
        "edits": [{"item_id": item_id,
                   "when": {"start_at": "2026-09-24T15:00", "end_at": "2026-09-30T11:00"}}],
    })
    r = member_client.post(f"/api/plans/{pid}/ai/chat", json={
        "messages": [{"role": "user", "content": "change the hotel date"}],
    })
    assert r.status_code == 200, r.data
    data = r.get_json()
    assert len(data["edits"]) == 1
    edit = data["edits"][0]
    assert edit["item_id"] == item_id
    assert edit["when"]["end_at"] == "2026-09-30T11:00"

    # Apply the edit via the normal PATCH endpoint.
    r = member_client.patch(f"/api/items/{item_id}", json={
        "details": {"when": edit["when"]},
    })
    assert r.status_code == 200, r.data
    updated = r.get_json()["item"]
    assert updated["end_date"] == "2026-09-30"

    # The change is persisted.
    r = member_client.get(f"/api/plans/{pid}/items")
    items = r.get_json()["items"]
    assert items[0]["end_date"] == "2026-09-30"


# ---------------------------------------------------------------- geocode flow

def test_chat_then_add_item_persists_geocodes(member_client, ai_config, stub_llm):
    """A suggested item with geocodes is added via the items API and the
    coordinates are persisted to item_geocodes, so the map page can show it
    without re-geocoding."""
    pid = _make_plan(member_client)

    stub_llm({
        "reply": "Added the hotel.",
        "items": [
            {"item_type": "hotel", "title": "Beverly Hotels Elements",
             "details": {"address": "1 Raffles Place, Singapore"},
             "geocodes": [{"label": "1 Raffles Place, Singapore",
                           "lat": 1.2844, "lng": 103.8512}]},
        ],
    })
    r = member_client.post(f"/api/plans/{pid}/ai/chat", json={
        "messages": [{"role": "user", "content": "add a hotel"}],
    })
    assert r.status_code == 200, r.data
    suggested = r.get_json()["items"][0]
    assert len(suggested["geocodes"]) == 1
    assert suggested["geocodes"][0]["lat"] == 1.2844

    # Add the suggested item (with its geocodes) via the items API.
    r = member_client.post(f"/api/plans/{pid}/items", json={
        "item_type": suggested["item_type"],
        "title": suggested["title"],
        "details": suggested["details"],
        "geocodes": suggested["geocodes"],
    })
    assert r.status_code == 200, r.data
    created = r.get_json()["item"]
    assert len(created["geocodes"]) == 1
    assert created["geocodes"][0]["lat"] == 1.2844
    assert created["geocodes"][0]["lng"] == 103.8512

    # Persisted in the DB (not just in the response).
    with member_client.application.app_context():
        from backend.db import get_db
        db = get_db()
        rows = db.execute(
            "SELECT label, lat, lng FROM item_geocodes WHERE item_id = ?",
            (created["id"],)).fetchall()
    assert len(rows) == 1
    assert rows[0]["label"] == "1 Raffles Place, Singapore"
    assert rows[0]["lat"] == 1.2844
    assert rows[0]["lng"] == 103.8512
