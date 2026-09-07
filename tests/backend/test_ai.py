"""Tests for backend/ai.py — the shared AI extraction core.

The upstream LLM call is stubbed by monkeypatching ``urllib.request.urlopen``
so no network or API key is needed. The config file is pointed at a temp path
per test.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend import ai as ai_mod

SETTINGS = {
    "item_types": {
        "transit": {
            "label": "Transit",
            "fields": [
                {"key": "mode", "label": "Type"},
                {"key": "provider", "label": "Provider / airline"},
                {"key": "ref_no", "label": "Ref / flight no."},
                {"key": "from", "label": "From"},
                {"key": "to", "label": "To"},
            ],
        },
        "hotel": {
            "label": "Hotel",
            "fields": [
                {"key": "hotel_name", "label": "Hotel name"},
                {"key": "address", "label": "Address"},
            ],
        },
        "note": {"label": "Note", "fields": [{"key": "text", "label": "Note"}]},
    }
}


@pytest.fixture
def ai_config(tmp_path, monkeypatch):
    """Point ai.CONFIG_PATH at a temp file and return a writer helper."""
    cfg_path = tmp_path / "ai.json"
    monkeypatch.setattr(ai_mod, "CONFIG_PATH", cfg_path)

    def _write(**overrides):
        cfg = {"base_url": "https://api.example.com/v1", "api_key": "sk-test", "model": "test-model"}
        cfg.update(overrides)
        cfg_path.write_text(json.dumps(cfg), encoding="utf-8")

    return _write


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


@pytest.fixture
def stub_llm_sequence(monkeypatch):
    """Stub urlopen to return a sequence of chat-completions responses.

    Each entry in ``responses`` is either a dict (the model's JSON object,
    wrapped in the standard choices/message envelope) or a special marker
    string: ``"__EMPTY__"`` means the model returned an empty ``content``
    (triggers a retry), and ``"__NONJSON__"`` means the model returned a
    non-JSON ``content`` string (also triggers a retry). The stub is consumed
    in order; the last entry repeats for any further calls.
    """
    def _stub(responses):
        calls = {"n": 0}

        def _envelope(content):
            return json.dumps({
                "choices": [{"message": {"content": content}}]
            }).encode("utf-8")

        class _Resp:
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
            def read(self):
                idx = min(calls["n"], len(responses) - 1)
                calls["n"] += 1
                r = responses[idx]
                if r == "__EMPTY__":
                    return _envelope("")
                if r == "__NONJSON__":
                    return _envelope("this is not json")
                return _envelope(json.dumps(r))

        monkeypatch.setattr(ai_mod.urllib.request, "urlopen", lambda *a, **k: _Resp())
    return _stub


# ---------------------------------------------------------------- config

def test_load_config_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_mod, "CONFIG_PATH", tmp_path / "nope.json")
    with pytest.raises(ai_mod.AIConfigError):
        ai_mod.load_ai_config()


def test_load_config_invalid_json(tmp_path, monkeypatch):
    p = tmp_path / "ai.json"
    p.write_text("not json", encoding="utf-8")
    monkeypatch.setattr(ai_mod, "CONFIG_PATH", p)
    with pytest.raises(ai_mod.AIConfigError):
        ai_mod.load_ai_config()


def test_load_config_missing_fields(tmp_path, monkeypatch):
    p = tmp_path / "ai.json"
    p.write_text(json.dumps({"api_key": "x"}), encoding="utf-8")
    monkeypatch.setattr(ai_mod, "CONFIG_PATH", p)
    with pytest.raises(ai_mod.AIConfigError):
        ai_mod.load_ai_config()


def test_load_config_ok(ai_config):
    ai_config()
    cfg = ai_mod.load_ai_config()
    assert cfg["base_url"] == "https://api.example.com/v1"
    assert cfg["model"] == "test-model"
    assert cfg["api_key"] == "sk-test"


def test_call_uses_v1_when_base_url_lacks_it(ai_config, monkeypatch):
    # base_url without /v1 -> the request URL must be <base>/v1/chat/completions
    ai_config(base_url="http://llm.example.com")
    seen = {}
    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({"choices": [{"message": {"content": "{}"}}]}).encode()
    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        return _Resp()
    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    ai_mod._call_chat_completions(ai_mod.load_ai_config(), [{"role": "user", "content": "x"}])
    assert seen["url"] == "http://llm.example.com/v1/chat/completions"


def test_call_keeps_v1_when_base_url_has_it(ai_config, monkeypatch):
    ai_config(base_url="http://llm.example.com/v1")
    seen = {}
    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({"choices": [{"message": {"content": "{}"}}]}).encode()
    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        return _Resp()
    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    ai_mod._call_chat_completions(ai_mod.load_ai_config(), [{"role": "user", "content": "x"}])
    assert seen["url"] == "http://llm.example.com/v1/chat/completions"


# ---------------------------------------------------------------- retry on empty / non-JSON

def test_call_retries_empty_then_succeeds(ai_config, stub_llm_sequence):
    """An empty model reply on the first attempt(s) is retried and succeeds."""
    ai_config()
    stub_llm_sequence(["__EMPTY__", "__EMPTY__", {"reply": "ok", "items": []}])
    out = ai_mod._call_chat_completions(
        ai_mod.load_ai_config(), [{"role": "user", "content": "hi"}])
    assert out == {"reply": "ok", "items": []}


def test_call_retries_non_json_then_succeeds(ai_config, stub_llm_sequence):
    """A non-JSON model reply on the first attempt is retried and succeeds."""
    ai_config()
    # A non-JSON content string inside the envelope -> json.loads(content) fails.
    stub_llm_sequence(["__NONJSON__", {"reply": "ok", "items": []}])
    out = ai_mod._call_chat_completions(
        ai_mod.load_ai_config(), [{"role": "user", "content": "hi"}])
    assert out == {"reply": "ok", "items": []}


def test_call_raises_clear_valueerror_after_all_retries(ai_config, stub_llm_sequence):
    """When every attempt returns empty, a clear ValueError (not JSONDecodeError) is raised."""
    ai_config()
    stub_llm_sequence(["__EMPTY__", "__EMPTY__", "__EMPTY__"])
    with pytest.raises(ValueError, match="empty response"):
        ai_mod._call_chat_completions(
            ai_mod.load_ai_config(), [{"role": "user", "content": "hi"}])


def test_call_raises_clear_valueerror_on_non_json_after_retries(ai_config, stub_llm_sequence):
    """When every attempt returns non-JSON, a clear ValueError (not JSONDecodeError) is raised."""
    ai_config()
    stub_llm_sequence(["__NONJSON__", "__NONJSON__", "__NONJSON__"])
    with pytest.raises(ValueError, match="non-JSON"):
        ai_mod._call_chat_completions(
            ai_mod.load_ai_config(), [{"role": "user", "content": "hi"}])


def test_call_parses_markdown_fenced_reply(ai_config):
    """Model wraps JSON in a ```json marker ``` fence — still parsed."""
    ai_config()
    fenced = '```json\n{"reply": "hi", "items": []}\n```'
    assert ai_mod._parse_json_content(fenced) == {"reply": "hi", "items": []}


def test_call_extracts_json_object_from_noise(ai_config):
    """Model prefaces/proceeds with prose — the embedded JSON object is extracted."""
    ai_config()
    noisy = 'Sure! Here you go: {"reply": "done", "items": []} ... hope that helps'
    assert ai_mod._parse_json_content(noisy) == {"reply": "done", "items": []}


def test_call_handles_error_body_gracefully(ai_config, monkeypatch):
    """A non-JSON HTTP body (e.g. an HTML error page) retries, then raises a clear ValueError."""
    ai_config()

    class _Resp:
        def __init__(self):
            self.n = 0
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return b"<html>gateway error</html>"

    resp = _Resp()
    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", lambda *a, **k: resp)
    with pytest.raises(ValueError, match="non-JSON"):
        ai_mod._call_chat_completions(ai_mod.load_ai_config(), [{"role": "user", "content": "hi"}])


def test_call_sends_corrective_message_on_retry(ai_config, monkeypatch):
    """On a non-JSON reply the retry appends a corrective user message so the
    model is told to emit JSON only (instead of re-sending the same prompt)."""
    ai_config()
    seen = {"n": 0, "last_messages": None}

    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({
                "choices": [{"message": {"content": "Sure, here's the update!"}}]
            }).encode("utf-8")

    def fake_urlopen(req, timeout):
        body = json.loads(req.data.decode("utf-8"))
        seen["n"] += 1
        seen["last_messages"] = body["messages"]
        return _Resp()

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(ValueError, match="non-JSON"):
        ai_mod._call_chat_completions(ai_mod.load_ai_config(), [{"role": "user", "content": "hi"}])
    # The corrective message was appended on the retry.
    assert seen["n"] == ai_mod._MAX_RETRIES
    last = seen["last_messages"][-1]
    assert last["role"] == "user"
    assert "JSON" in last["content"]


def test_call_recovers_prose_then_json(ai_config, monkeypatch):
    """A prose reply on the first attempt is corrected and the retry returns JSON."""
    ai_config()
    responses = [
        "Sure, I'll update the date for you!",
        json.dumps({"reply": "done", "items": [], "edits": [{"item_id": 3, "when": {"start_at": "2026-09-27T15:00"}}]}),
    ]
    calls = {"n": 0}

    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            idx = min(calls["n"], len(responses) - 1)
            calls["n"] += 1
            return json.dumps({"choices": [{"message": {"content": responses[idx]}}]}).encode("utf-8")

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", lambda *a, **k: _Resp())
    out = ai_mod._call_chat_completions(ai_mod.load_ai_config(), [{"role": "user", "content": "change the date"}])
    assert out["reply"] == "done"
    assert out["edits"][0]["item_id"] == 3


# ---------------------------------------------------------------- extraction

def test_extract_item_valid(ai_config, stub_llm):
    ai_config()
    stub_llm({
        "item_type": "transit",
        "title": "JL 123 Tokyo to Osaka",
        "details": {"mode": "Flight", "provider": "JAL", "ref_no": "JL123",
                    "from": "Tokyo", "to": "Osaka",
                    "when": {"start_at": "2026-09-10T09:00"}},
    })
    out = ai_mod.extract_item("flight ticket text", settings=SETTINGS)
    assert out["item_type"] == "transit"
    assert out["title"] == "JL 123 Tokyo to Osaka"
    assert out["details"]["provider"] == "JAL"
    # when coerced: end_at defaulted to start + 1h
    assert out["when"]["start_at"] == "2026-09-10T09:00"
    assert out["when"]["end_at"] == "2026-09-10T10:00"
    assert out["item_date"] == "2026-09-10"
    assert out["end_date"] == "2026-09-10"


def test_extract_item_invalid_type(ai_config, stub_llm):
    ai_config()
    stub_llm({"item_type": "spaceship", "title": "x", "details": {}})
    with pytest.raises(ValueError):
        ai_mod.extract_item("text", settings=SETTINGS)


def test_extract_item_fills_geocodes(ai_config, stub_llm):
    """The model supplies geocodes; they are normalized into the item."""
    ai_config()
    stub_llm({
        "item_type": "hotel",
        "title": "Beverly Hotels Elements",
        "details": {"hotel_name": "Beverly Hotels Elements",
                    "address": "1 Raffles Place, Singapore"},
        "geocodes": [{"label": "1 Raffles Place, Singapore", "lat": 1.2844, "lng": 103.8512}],
    })
    out = ai_mod.extract_item("hotel text", settings=SETTINGS)
    assert len(out["geocodes"]) == 1
    assert out["geocodes"][0]["label"] == "1 Raffles Place, Singapore"
    assert out["geocodes"][0]["lat"] == 1.2844
    assert out["geocodes"][0]["lng"] == 103.8512


def test_extract_item_geocodes_drops_invalid(ai_config, stub_llm):
    """Invalid geocodes (missing/non-numeric/out-of-range) are dropped."""
    ai_config()
    stub_llm({
        "item_type": "transit",
        "title": "Flight",
        "details": {"mode": "Flight", "from": "Tokyo", "to": "Singapore"},
        "geocodes": [
            {"label": "ok", "lat": 35.68, "lng": 139.65},
            {"label": "no lat", "lng": 103.85},
            {"label": "bad", "lat": "abc", "lng": 103.85},
            {"label": "oob", "lat": 200, "lng": 103.85},
        ],
    })
    out = ai_mod.extract_item("flight text", settings=SETTINGS)
    assert len(out["geocodes"]) == 1
    assert out["geocodes"][0]["label"] == "ok"


def test_extract_item_no_geocodes_returns_empty(ai_config, stub_llm):
    ai_config()
    stub_llm({"item_type": "note", "title": "x", "details": {"text": "hi"}})
    out = ai_mod.extract_item("hi", settings=SETTINGS)
    assert out["geocodes"] == []


def test_extract_item_not_configured(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_mod, "CONFIG_PATH", tmp_path / "missing.json")
    with pytest.raises(ai_mod.AIConfigError):
        ai_mod.extract_item("text", settings=SETTINGS)


def test_extract_item_constrains_type(ai_config, stub_llm):
    ai_config()
    stub_llm({"item_type": "hotel", "title": "H", "details": {"hotel_name": "H"}})
    out = ai_mod.extract_item("text", item_type="hotel", settings=SETTINGS)
    assert out["item_type"] == "hotel"


def test_extract_item_defaults_title(ai_config, stub_llm):
    ai_config()
    stub_llm({"item_type": "note", "details": {"text": "hi"}})
    out = ai_mod.extract_item("hi", settings=SETTINGS)
    assert out["title"] == "(Untitled)"
    assert out["item_type"] == "note"


# ---------------------------------------------------------------- chat

def test_chat_reply_and_items(ai_config, stub_llm):
    ai_config()
    stub_llm({
        "reply": "Here's a flight suggestion.",
        "items": [
            {"item_type": "transit", "title": "JL 123",
             "details": {"mode": "Flight", "when": {"start_at": "2026-09-10T09:00"}}},
        ],
    })
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "add a flight"}], settings=SETTINGS)
    assert out["reply"] == "Here's a flight suggestion."
    assert len(out["items"]) == 1
    assert out["items"][0]["item_type"] == "transit"
    assert out["items"][0]["when"]["start_at"] == "2026-09-10T09:00"
    assert out["items"][0]["when"]["end_at"] == "2026-09-10T10:00"


def test_chat_empty_items(ai_config, stub_llm):
    ai_config()
    stub_llm({"reply": "Sure.", "items": []})
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "hi"}], settings=SETTINGS)
    assert out["reply"] == "Sure."
    assert out["items"] == []


def test_chat_retries_empty_turn(ai_config, stub_llm_sequence):
    """An all-empty turn (no reply/items/edits) is nudged once and retried."""
    ai_config()
    stub_llm_sequence([
        {"reply": "", "items": [], "edits": []},
        {"reply": "Here's a flight suggestion.", "items": [
            {"item_type": "transit", "title": "Flight", "details": {"mode": "Flight"}},
        ]},
    ])
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "add a flight"}], settings=SETTINGS)
    assert out["reply"] == "Here's a flight suggestion."
    assert len(out["items"]) == 1


def test_chat_fallback_when_still_empty(ai_config, stub_llm):
    """If the model keeps returning an all-empty turn, a fallback reply is used."""
    ai_config()
    stub_llm({"reply": "", "items": [], "edits": []})
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "hi"}], settings=SETTINGS)
    assert out["reply"]
    assert out["items"] == []
    assert out["edits"] == []


def test_chat_skips_invalid_items(ai_config, stub_llm):
    ai_config()
    stub_llm({
        "reply": "ok",
        "items": [
            {"item_type": "spaceship", "title": "bad"},
            {"item_type": "note", "title": "good"},
        ],
    })
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "x"}], settings=SETTINGS)
    assert len(out["items"]) == 1
    assert out["items"][0]["title"] == "good"


def test_chat_not_configured(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_mod, "CONFIG_PATH", tmp_path / "missing.json")
    with pytest.raises(ai_mod.AIConfigError):
        ai_mod.chat("Title: Trip", [{"role": "user", "content": "x"}], settings=SETTINGS)


# ---------------------------------------------------------------- chat edits

def test_chat_change_date(ai_config, stub_llm):
    """User asks to change a hotel date; the model returns an edit."""
    ai_config()
    stub_llm({
        "reply": "I've moved your hotel checkout to Sep 30.",
        "items": [],
        "edits": [
            {"item_id": 3, "when": {"start_at": "2026-09-24T15:00", "end_at": "2026-09-30T11:00"}},
        ],
    })
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "change the hotel date"}],
                      settings=SETTINGS)
    assert out["reply"] == "I've moved your hotel checkout to Sep 30."
    assert out["items"] == []
    assert len(out["edits"]) == 1
    ed = out["edits"][0]
    assert ed["item_id"] == 3
    assert ed["when"]["start_at"] == "2026-09-24T15:00"
    assert ed["when"]["end_at"] == "2026-09-30T11:00"


def test_chat_change_title(ai_config, stub_llm):
    ai_config()
    stub_llm({
        "reply": "Renamed the hotel.",
        "items": [],
        "edits": [{"item_id": 3, "title": "Beverly Hills Hotel"}],
    })
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "rename the hotel"}],
                      settings=SETTINGS)
    assert len(out["edits"]) == 1
    assert out["edits"][0]["item_id"] == 3
    assert out["edits"][0]["title"] == "Beverly Hills Hotel"
    assert "when" not in out["edits"][0]


def test_chat_change_details(ai_config, stub_llm):
    ai_config()
    stub_llm({
        "reply": "Updated the room type.",
        "items": [],
        "edits": [{"item_id": 5, "details": {"room_type": "Deluxe King"}}],
    })
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "set room to deluxe king"}],
                      settings=SETTINGS)
    assert len(out["edits"]) == 1
    assert out["edits"][0]["details"]["room_type"] == "Deluxe King"


def test_chat_edit_skips_missing_item_id(ai_config, stub_llm):
    ai_config()
    stub_llm({
        "reply": "ok",
        "items": [],
        "edits": [
            {"title": "no id"},
            {"item_id": 7, "title": "has id"},
        ],
    })
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "x"}], settings=SETTINGS)
    assert len(out["edits"]) == 1
    assert out["edits"][0]["item_id"] == 7


def test_chat_edit_ignores_empty_details(ai_config, stub_llm):
    ai_config()
    stub_llm({
        "reply": "ok",
        "items": [],
        "edits": [{"item_id": 2, "details": {"room_type": "", "when": {}}}],
    })
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "x"}], settings=SETTINGS)
    assert len(out["edits"]) == 1
    ed = out["edits"][0]
    assert "details" not in ed
    assert "when" not in ed


def test_chat_no_edits_by_default(ai_config, stub_llm):
    ai_config()
    stub_llm({"reply": "Sure.", "items": [], "edits": []})
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "hi"}], settings=SETTINGS)
    assert out["edits"] == []


def test_chat_edits_absent_returns_empty(ai_config, stub_llm):
    ai_config()
    stub_llm({"reply": "Sure.", "items": []})
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "hi"}], settings=SETTINGS)
    assert out["edits"] == []


def test_chat_item_includes_geocodes(ai_config, stub_llm):
    """A suggested item carries geocodes for its location."""
    ai_config()
    stub_llm({
        "reply": "Added the hotel.",
        "items": [
            {"item_type": "hotel", "title": "Beverly Hotels Elements",
             "details": {"address": "1 Raffles Place, Singapore"},
             "geocodes": [{"label": "1 Raffles Place, Singapore", "lat": 1.2844, "lng": 103.8512}]},
        ],
    })
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "add a hotel"}], settings=SETTINGS)
    assert len(out["items"]) == 1
    assert out["items"][0]["geocodes"][0]["lat"] == 1.2844


def test_chat_edit_includes_geocodes(ai_config, stub_llm):
    """An edit can carry geocodes for a changed location."""
    ai_config()
    stub_llm({
        "reply": "Moved the hotel.",
        "items": [],
        "edits": [
            {"item_id": 3, "details": {"address": "2 Marina Blvd, Singapore"},
             "geocodes": [{"label": "2 Marina Blvd, Singapore", "lat": 1.2834, "lng": 103.8607}]},
        ],
    })
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "move the hotel"}], settings=SETTINGS)
    assert len(out["edits"]) == 1
    assert out["edits"][0]["geocodes"][0]["lng"] == 103.8607


def test_chat_recovers_prose_then_edit(ai_config, monkeypatch):
    """The exact failure the user hit: the model answers a date-change request
    in prose (non-JSON) on the first attempt. The corrective retry steers it
    back to JSON with a valid edits[] entry, and chat() returns the edit."""
    ai_config()
    responses = [
        "Sure, I've updated the date for you!",
        json.dumps({
            "reply": "Moved your checkout to Sep 27.",
            "items": [],
            "edits": [{"item_id": 3,
                       "when": {"start_at": "2026-09-27T15:00", "end_at": "2026-09-28T11:00"}}],
        }),
    ]
    calls = {"n": 0}

    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            idx = min(calls["n"], len(responses) - 1)
            calls["n"] += 1
            return json.dumps({"choices": [{"message": {"content": responses[idx]}}]}).encode("utf-8")

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", lambda *a, **k: _Resp())
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "change the hotel date"}],
                      settings=SETTINGS)
    assert out["reply"] == "Moved your checkout to Sep 27."
    assert len(out["edits"]) == 1
    assert out["edits"][0]["item_id"] == 3
    assert out["edits"][0]["when"]["end_at"] == "2026-09-28T11:00"


# ---------------------------------------------------------------- web search

def test_web_search_returns_hits(ai_config, monkeypatch):
    ai_config(searxng_url="http://localhost:8888")
    seen = {}

    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({
                "results": [
                    {"title": "Kyoto weather", "url": "https://w.example/kyoto",
                     "content": "Sunny, 24C."},
                    {"title": "No url", "content": "snippet only"},
                    {"title": "", "url": "", "content": "empty"},
                ]
            }).encode("utf-8")

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        return _Resp()

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    out = ai_mod.web_search("kyoto weather")
    assert seen["url"] == "http://localhost:8888/search?q=kyoto%20weather&format=json"
    assert len(out) == 2
    assert out[0]["title"] == "Kyoto weather"
    assert out[0]["url"] == "https://w.example/kyoto"
    assert out[1]["title"] == "No url"


def test_web_search_encodes_query(ai_config, monkeypatch):
    ai_config(searxng_url="http://localhost:8888")
    seen = {}

    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({"results": []}).encode("utf-8")

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        return _Resp()

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    ai_mod.web_search("opening hours & prices")
    assert "opening%20hours%20%26%20prices" in seen["url"]


def test_web_search_not_configured(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_mod, "CONFIG_PATH", tmp_path / "missing.json")
    with pytest.raises(ai_mod.AIConfigError):
        ai_mod.web_search("anything")


def test_web_search_transport_error(ai_config, monkeypatch):
    ai_config(searxng_url="http://localhost:8888")

    def fake_urlopen(req, timeout):
        raise OSError("connection refused")

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(ValueError, match="web search failed"):
        ai_mod.web_search("anything")


# ---------------------------------------------------------------- chat search loop

def test_chat_searches_then_answers(ai_config, monkeypatch):
    """Model requests a search; results are fed back; model answers."""
    ai_config(searxng_url="http://localhost:8888")
    llm_responses = [
        {"search": "kyoto weather"},
        {"reply": "It's sunny in Kyoto.", "items": []},
    ]
    llm_calls = {"n": 0}

    def _envelope(content):
        return json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8")

    class _Resp:
        def __init__(self, body):
            self._body = body
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return self._body

    def fake_urlopen(req, timeout):
        if "/search?" in req.full_url:
            return _Resp(json.dumps({
                "results": [{"title": "Kyoto weather", "url": "https://w.example",
                             "content": "Sunny, 24C."}]
            }).encode("utf-8"))
        idx = min(llm_calls["n"], len(llm_responses) - 1)
        llm_calls["n"] += 1
        return _Resp(_envelope(json.dumps(llm_responses[idx])))

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "what's the weather?"}],
                      settings=SETTINGS)
    assert out["reply"] == "It's sunny in Kyoto."
    assert out["items"] == []


def test_chat_no_search_when_not_configured(ai_config, stub_llm):
    """Without searxng_url the model is not told it can search, and a stray
    'search' key in its reply is ignored."""
    ai_config()  # no searxng_url
    stub_llm({"search": "kyoto weather", "reply": "I don't know.", "items": []})
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "weather?"}], settings=SETTINGS)
    assert out["reply"] == "I don't know."
    assert out["items"] == []


def test_chat_search_returns_no_results(ai_config, monkeypatch):
    """Search returns nothing; the model still answers from knowledge."""
    ai_config(searxng_url="http://localhost:8888")
    llm_responses = [
        {"search": "obscure thing"},
        {"reply": "No results, but here's what I know.", "items": []},
    ]
    llm_calls = {"n": 0}

    def _envelope(content):
        return json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8")

    class _Resp:
        def __init__(self, body):
            self._body = body
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return self._body

    def fake_urlopen(req, timeout):
        if "/search?" in req.full_url:
            return _Resp(json.dumps({"results": []}).encode("utf-8"))
        idx = min(llm_calls["n"], len(llm_responses) - 1)
        llm_calls["n"] += 1
        return _Resp(_envelope(json.dumps(llm_responses[idx])))

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    out = ai_mod.chat("Title: Trip", [{"role": "user", "content": "x"}], settings=SETTINGS)
    assert out["reply"] == "No results, but here's what I know."


# ---------------------------------------------------------------- test_connections

def test_connections_all_ok(ai_config, monkeypatch):
    ai_config(searxng_url="http://localhost:8888")
    seen = {}

    class _Resp:
        def __init__(self, body):
            self._body = body
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return self._body

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        if "/search?" in req.full_url:
            return _Resp(json.dumps({"results": [{"title": "t", "url": "u", "content": "c"}]}).encode())
        return _Resp(json.dumps({"data": [{"id": "test-model"}, {"id": "other"}]}).encode())

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    out = ai_mod.test_connections()
    assert out["ai"]["ok"] is True
    assert "test-model" in out["ai"]["detail"]
    assert out["searxng"]["ok"] is True
    assert "1 result" in out["searxng"]["detail"]


def test_connections_ai_model_missing(ai_config, monkeypatch):
    ai_config(searxng_url="http://localhost:8888")

    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({"data": [{"id": "other-model"}]}).encode()

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", lambda *a, **k: _Resp())
    out = ai_mod.test_connections()
    assert out["ai"]["ok"] is False
    assert "not found" in out["ai"]["detail"]


def test_connections_ai_unreachable(ai_config, monkeypatch):
    ai_config(searxng_url="http://localhost:8888")

    def fake_urlopen(req, timeout):
        if "/search?" in req.full_url:
            class _Resp:
                def __enter__(self): return self
                def __exit__(self, *a): return False
                def read(self):
                    return json.dumps({"results": []}).encode()
            return _Resp()
        raise OSError("connection refused")

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    out = ai_mod.test_connections()
    assert out["ai"]["ok"] is False
    assert "connection failed" in out["ai"]["detail"]
    assert out["searxng"]["ok"] is True


def test_connections_ai_404_falls_back_to_chat(ai_config, monkeypatch):
    # Providers that expose only /chat/completions (no /models) must report ok
    # via a real chat probe instead of a hard 404 failure.
    ai_config(searxng_url="http://localhost:8888")
    calls = []

    def fake_urlopen(req, timeout):
        calls.append(req.full_url)
        if "/search?" in req.full_url:
            class _Resp:
                def __enter__(self): return self
                def __exit__(self, *a): return False
                def read(self):
                    return json.dumps({"results": []}).encode()
            return _Resp()
        if "/models" in req.full_url:
            raise ai_mod.urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)
        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self):
                return b"{}"
        return _Resp()

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    out = ai_mod.test_connections()
    assert out["ai"]["ok"] is True
    assert "responded" in out["ai"]["detail"]
    assert any(u.endswith("/v1/chat/completions") for u in calls)


def test_connections_ai_404_chat_fails(ai_config, monkeypatch):
    # Fallback must also report failure when the chat probe errors out.
    ai_config(searxng_url="http://localhost:8888")

    def fake_urlopen(req, timeout):
        if "/search?" in req.full_url:
            class _Resp:
                def __enter__(self): return self
                def __exit__(self, *a): return False
                def read(self):
                    return json.dumps({"results": []}).encode()
            return _Resp()
        if "/models" in req.full_url:
            raise ai_mod.urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)
        raise ai_mod.urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    out = ai_mod.test_connections()
    assert out["ai"]["ok"] is False
    assert "401" in out["ai"]["detail"]


def test_connections_missing_fields():
    out = ai_mod.test_connections({"base_url": "", "model": "", "searxng_url": ""})
    assert out["ai"]["ok"] is False
    assert out["searxng"]["ok"] is False
    assert "required" in out["ai"]["detail"]
    assert "not configured" in out["searxng"]["detail"]


def test_connections_searxng_unreachable(ai_config, monkeypatch):
    ai_config(searxng_url="http://localhost:8888")

    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({"data": [{"id": "test-model"}]}).encode()

    def fake_urlopen(req, timeout):
        if "/search?" in req.full_url:
            raise OSError("connection refused")
        return _Resp()

    monkeypatch.setattr(ai_mod.urllib.request, "urlopen", fake_urlopen)
    out = ai_mod.test_connections()
    assert out["ai"]["ok"] is True
    assert out["searxng"]["ok"] is False
    assert "web search failed" in out["searxng"]["detail"]
