"""Tests for the AI web endpoint (backend/blueprints/ai.py).

The upstream LLM call is stubbed by monkeypatching ``urllib.request.urlopen``
and pointing ``ai.CONFIG_PATH`` at a temp file, so no network or API key is
needed. Access control (viewer 403, login 401) is exercised via the fixtures.
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


def _make_plan(client, title="Trip"):
    r = client.post("/api/plans", json={"title": title})
    assert r.status_code == 200, r.data
    return r.get_json()["plan"]["id"]


# ---------------------------------------------------------------- happy path

def test_extract_returns_item(admin_client, ai_config, stub_llm):
    pid = _make_plan(admin_client)
    stub_llm({
        "item_type": "transit",
        "title": "JL 123 Tokyo to Osaka",
        "details": {"mode": "Flight", "provider": "JAL",
                    "when": {"start_at": "2026-09-10T09:00"}},
    })
    r = admin_client.post(f"/api/plans/{pid}/ai/extract", json={"text": "flight ticket"})
    assert r.status_code == 200, r.data
    item = r.get_json()["item"]
    assert item["item_type"] == "transit"
    assert item["title"] == "JL 123 Tokyo to Osaka"
    assert item["when"]["start_at"] == "2026-09-10T09:00"
    assert item["when"]["end_at"] == "2026-09-10T10:00"
    assert item["item_date"] == "2026-09-10"


# ---------------------------------------------------------------- errors

def test_extract_requires_text(admin_client, ai_config):
    pid = _make_plan(admin_client)
    r = admin_client.post(f"/api/plans/{pid}/ai/extract", json={"text": "  "})
    assert r.status_code == 400


def test_extract_not_configured(admin_client, tmp_path, monkeypatch):
    monkeypatch.setattr(ai_mod, "CONFIG_PATH", tmp_path / "missing.json")
    pid = _make_plan(admin_client)
    r = admin_client.post(f"/api/plans/{pid}/ai/extract", json={"text": "hello"})
    assert r.status_code == 503
    assert "not configured" in r.get_json()["error"]


def test_extract_invalid_type(admin_client, ai_config, stub_llm):
    pid = _make_plan(admin_client)
    stub_llm({"item_type": "spaceship", "title": "x", "details": {}})
    r = admin_client.post(f"/api/plans/{pid}/ai/extract", json={"text": "hello"})
    assert r.status_code == 422


# ---------------------------------------------------------------- access

def test_extract_requires_login(client, ai_config):
    r = client.post("/api/plans/1/ai/extract", json={"text": "hello"})
    assert r.status_code == 401


def test_extract_viewer_forbidden(app, member_client, make_plan, make_user, ai_config, stub_llm):
    # carol is a viewer on the plan; create a plan owned by alice, share with
    # carol as viewer, then call as carol.
    pid = make_plan()["id"]
    carol_id = make_user(username="carol")["id"]
    member_client.post(f"/api/plans/{pid}/members",
                       json={"user_id": carol_id, "role": "viewer"})

    carol = app.test_client()
    carol.post("/auth/login", data={"username": "carol", "password": "pw12345"})
    stub_llm({"item_type": "note", "title": "x", "details": {}})
    r = carol.post(f"/api/plans/{pid}/ai/extract", json={"text": "hello"})
    assert r.status_code == 403


# ---------------------------------------------------------------- chat endpoint

def test_chat_returns_reply_and_items(admin_client, ai_config, stub_llm):
    pid = _make_plan(admin_client)
    stub_llm({
        "reply": "Here's a flight.",
        "items": [{"item_type": "transit", "title": "JL 123",
                   "details": {"mode": "Flight", "when": {"start_at": "2026-09-10T09:00"}}}],
    })
    r = admin_client.post(f"/api/plans/{pid}/ai/chat", json={
        "messages": [{"role": "user", "content": "add a flight"}],
    })
    assert r.status_code == 200, r.data
    data = r.get_json()
    assert data["reply"] == "Here's a flight."
    assert len(data["items"]) == 1
    assert data["items"][0]["item_type"] == "transit"


def test_chat_requires_messages(admin_client, ai_config):
    pid = _make_plan(admin_client)
    r = admin_client.post(f"/api/plans/{pid}/ai/chat", json={"messages": []})
    assert r.status_code == 400


def test_chat_context_includes_buffer_days(admin_client, ai_config, monkeypatch):
    """The plan context sent to the LLM lists the plan's buffer days."""
    pid = _make_plan(admin_client)
    admin_client.patch(f"/api/plans/{pid}",
                       json={"buffer_days_add": ["9999-12-31", "9999-12-30"]})

    seen = {}

    class _Resp:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self):
            return json.dumps({
                "choices": [{"message": {"content": json.dumps({"reply": "ok", "items": []})}}]
            }).encode("utf-8")

    def fake_urlopen(req, timeout):
        seen["body"] = json.loads(req.data.decode("utf-8"))
        return _Resp()

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)

    r = admin_client.post(f"/api/plans/{pid}/ai/chat",
                          json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200, r.data

    system = seen["body"]["messages"][0]["content"]
    assert "9999-12-31" in system
    assert "9999-12-30" in system
    assert "Buffer days" in system
    assert "not sure about yet" in system


def test_chat_not_configured(admin_client, tmp_path, monkeypatch):
    monkeypatch.setattr(ai_mod, "CONFIG_PATH", tmp_path / "missing.json")
    pid = _make_plan(admin_client)
    r = admin_client.post(f"/api/plans/{pid}/ai/chat",
                          json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 503


def test_chat_passes_image_through(admin_client, ai_config, monkeypatch):
    """The chat endpoint forwards a data-URL image to the LLM call.

    We stub urlopen to capture the request body and assert the last user
    message carries the image_url part.
    """
    pid = _make_plan(admin_client)
    image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="

    seen = {}

    class _Resp:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self):
            return json.dumps({
                "choices": [{"message": {"content": json.dumps({"reply": "ok", "items": []})}}]
            }).encode("utf-8")

    def fake_urlopen(req, timeout):
        seen["body"] = json.loads(req.data.decode("utf-8"))
        return _Resp()

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)

    r = admin_client.post(f"/api/plans/{pid}/ai/chat", json={
        "messages": [{"role": "user", "content": "what is in this photo?"}],
        "image": image,
    })
    assert r.status_code == 200, r.data

    # The last (user) message should carry the image_url part.
    last = seen["body"]["messages"][-1]
    assert last["role"] == "user"
    parts = last["content"]
    assert isinstance(parts, list)
    assert any(
        p.get("type") == "image_url" and p.get("image_url", {}).get("url") == image
        for p in parts
    )


def test_chat_viewer_allowed(app, member_client, make_plan, make_user, ai_config, stub_llm):
    # Chat is read-only; a viewer may chat (adding items still needs write).
    pid = make_plan()["id"]
    carol_id = make_user(username="carol")["id"]
    member_client.post(f"/api/plans/{pid}/members",
                       json={"user_id": carol_id, "role": "viewer"})
    carol = app.test_client()
    carol.post("/auth/login", data={"username": "carol", "password": "pw12345"})
    stub_llm({"reply": "ok", "items": []})
    r = carol.post(f"/api/plans/{pid}/ai/chat",
                   json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200
