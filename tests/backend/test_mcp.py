"""Tests for backend/mcp_server.py — the MCP tools.

The MCP server reads/writes the SQLite DB directly via its own connection.
These tests point the server's DB_PATH / SETTINGS_PATH at the temp data dir
created by the ``fresh_app`` fixture, then call the tool functions directly
(no stdio transport needed).
"""
from __future__ import annotations

import json
import sqlite3

import pytest

from backend import mcp_server as mcp_mod


@pytest.fixture
def mcp_env(app, monkeypatch):
    """Point the MCP server at the app's temp data dir (admin is user id 1)."""
    data = app._test_tmp / "data"
    monkeypatch.setattr(mcp_mod, "DB_PATH", data / "travelplan.db")
    monkeypatch.setattr(mcp_mod, "SETTINGS_PATH", data / "config" / "settings.json")
    # Ensure a settings file exists (the app's init_db creates the dirs).
    (data / "config").mkdir(parents=True, exist_ok=True)
    settings = {
        "item_types": {
            "transit": {"label": "Transit", "fields": [{"key": "mode", "label": "Type", "required": True},
                                                       {"key": "from", "label": "From", "required": True},
                                                       {"key": "to", "label": "To", "required": True}]},
            "hotel": {"label": "Hotel", "fields": [{"key": "hotel_name", "label": "Hotel name", "required": True},
                                                   {"key": "address", "label": "Address", "required": True}]},
            "note": {"label": "Note", "fields": [{"key": "text", "label": "Note"}]},
        }
    }
    (data / "config" / "settings.json").write_text(json.dumps(settings), encoding="utf-8")
    return app


def _make_plan(app, title="Trip"):
    with app.app_context():
        from backend.db import get_db
        db = get_db()
        cur = db.execute(
            "INSERT INTO plans (title, owner_id, start_date, end_date) VALUES (?, 1, '2026-09-10', '2026-09-12')",
            (title,),
        )
        db.commit()
        assert cur.lastrowid is not None
        return cur.lastrowid


# ---------------------------------------------------------------- read tools

def test_list_plans_empty(mcp_env):
    assert mcp_mod.list_plans() == []


def test_list_plans(mcp_env):
    pid = _make_plan(mcp_env, "Japan 2026")
    plans = mcp_mod.list_plans()
    assert len(plans) == 1
    assert plans[0]["id"] == pid
    assert plans[0]["title"] == "Japan 2026"
    assert plans[0]["status"] == "planning"


def test_get_plan(mcp_env):
    pid = _make_plan(mcp_env)
    got = mcp_mod.get_plan(pid)
    assert got["plan"]["id"] == pid
    assert got["items"] == []
    assert "item_types" in got["settings"]


def test_get_plan_missing(mcp_env):
    with pytest.raises(ValueError):
        mcp_mod.get_plan(9999)


def test_list_items_and_get_item(mcp_env):
    pid = _make_plan(mcp_env)
    created = mcp_mod.create_item(pid, {
        "item_type": "transit", "title": "JL 123",
        "details": {"mode": "Flight", "from": "Tokyo", "to": "Osaka",
                    "when": {"start_at": "2026-09-10T09:00"}},
    })
    items = mcp_mod.list_items(pid)
    assert len(items) == 1
    assert items[0]["id"] == created["id"]
    assert items[0]["item_date"] == "2026-09-10"
    assert items[0]["details"]["mode"] == "Flight"

    one = mcp_mod.get_item(created["id"])
    assert one["title"] == "JL 123"
    assert one["when"]["start_at"] == "2026-09-10T09:00"


def test_get_item_missing(mcp_env):
    with pytest.raises(ValueError):
        mcp_mod.get_item(9999)


# ---------------------------------------------------------------- write tools

def test_create_item(mcp_env):
    pid = _make_plan(mcp_env)
    created = mcp_mod.create_item(pid, {
        "item_type": "hotel",
        "title": "Grand Hotel",
        "details": {"hotel_name": "Grand Hotel", "address": "Tokyo",
                    "when": {"start_at": "2026-09-10T15:00", "end_at": "2026-09-12T11:00"}},
    })
    assert created["id"] > 0
    assert created["item_date"] == "2026-09-10"
    assert created["end_date"] == "2026-09-12"
    assert created["status"] == "planned"


def test_create_item_invalid_type(mcp_env):
    pid = _make_plan(mcp_env)
    with pytest.raises(ValueError):
        mcp_mod.create_item(pid, {"item_type": "spaceship", "title": "x"})


def test_create_item_missing_title(mcp_env):
    pid = _make_plan(mcp_env)
    with pytest.raises(ValueError):
        mcp_mod.create_item(pid, {"item_type": "note", "title": "  "})


def test_create_item_missing_plan(mcp_env):
    with pytest.raises(ValueError):
        mcp_mod.create_item(9999, {"item_type": "note", "title": "x"})


def test_create_item_rejects_missing_when(mcp_env):
    """Every item needs a when block with start_at (mirrors the web API)."""
    pid = _make_plan(mcp_env)
    with pytest.raises(ValueError):
        mcp_mod.create_item(pid, {
            "item_type": "note", "title": "N", "details": {},
        })


def test_create_item_rejects_missing_required_type_field(mcp_env):
    """Type-specific mandatory fields (from settings.json) are enforced."""
    pid = _make_plan(mcp_env)
    with pytest.raises(ValueError):
        mcp_mod.create_item(pid, {
            "item_type": "transit", "title": "Flight",
            "details": {"mode": "Flight", "from": "Tokyo",
                        "when": {"start_at": "2026-09-10T09:00"}},
        })


def test_update_item(mcp_env):
    pid = _make_plan(mcp_env)
    created = mcp_mod.create_item(pid, {"item_type": "note", "title": "Old",
                                        "details": {"text": "a", "when": {"start_at": "2026-09-10T09:00"}}})
    updated = mcp_mod.update_item(created["id"], {"title": "New", "status": "confirmed"})
    assert updated["title"] == "New"
    assert updated["status"] == "confirmed"
    assert updated["details"]["text"] == "a"  # untouched field preserved


def test_update_item_changes_when(mcp_env):
    pid = _make_plan(mcp_env)
    created = mcp_mod.create_item(pid, {"item_type": "note", "title": "N",
                                        "details": {"text": "x", "when": {"start_at": "2026-09-10T09:00"}}})
    updated = mcp_mod.update_item(created["id"], {
        "details": {"text": "x", "when": {"start_at": "2026-09-11T08:00"}},
    })
    assert updated["item_date"] == "2026-09-11"
    assert updated["when"]["start_at"] == "2026-09-11T08:00"


def test_update_item_missing(mcp_env):
    with pytest.raises(ValueError):
        mcp_mod.update_item(9999, {"title": "x"})


def test_update_item_rejects_removing_required_field(mcp_env):
    """An update that would leave a mandatory field empty is rejected."""
    pid = _make_plan(mcp_env)
    created = mcp_mod.create_item(pid, {
        "item_type": "transit", "title": "Flight",
        "details": {"mode": "Flight", "from": "Tokyo", "to": "Osaka",
                    "when": {"start_at": "2026-09-10T09:00"}},
    })
    with pytest.raises(ValueError):
        mcp_mod.update_item(created["id"], {
            "details": {"mode": "Flight", "from": "Tokyo", "to": "",
                        "when": {"start_at": "2026-09-10T09:00"}},
        })


def test_required_fields_note_lists_mandatory_fields(mcp_env):
    """The MCP tool descriptions advertise each type's mandatory fields."""
    note = mcp_mod._required_fields_note()
    assert "transit: mode" in note
    assert "from" in note and "to" in note
    assert "hotel: hotel_name" in note
    assert "address" in note
    # Non-required fields (note.text) are excluded --- no "note:" line.
    assert not any(line.startswith("note:") for line in note.split("\n"))


def test_create_then_update_roundtrip(mcp_env):
    pid = _make_plan(mcp_env)
    created = mcp_mod.create_item(pid, {"item_type": "transit", "title": "Flight",
                                        "details": {"mode": "Flight", "from": "Tokyo", "to": "Osaka",
                                                   "when": {"start_at": "2026-09-10T09:00"}}})
    mcp_mod.update_item(created["id"], {"status": "done"})
    got = mcp_mod.get_item(created["id"])
    assert got["status"] == "done"
    assert got["title"] == "Flight"


# ---------------------------------------------------------------- archived gating

def _archive_plan(app, plan_id):
    with app.app_context():
        from backend.db import get_db
        db = get_db()
        db.execute("UPDATE plans SET status = 'archived' WHERE id = ?", (plan_id,))
        db.commit()


def test_create_item_blocked_on_archived(mcp_env):
    pid = _make_plan(mcp_env)
    _archive_plan(mcp_env, pid)
    with pytest.raises(ValueError, match="archived"):
        mcp_mod.create_item(pid, {"item_type": "note", "title": "x"})


def test_update_item_blocked_on_archived(mcp_env):
    pid = _make_plan(mcp_env)
    created = mcp_mod.create_item(pid, {"item_type": "note", "title": "Old",
                                        "details": {"when": {"start_at": "2026-09-10T09:00"}}})
    _archive_plan(mcp_env, pid)
    with pytest.raises(ValueError, match="archived"):
        mcp_mod.update_item(created["id"], {"title": "New"})


def test_read_tools_work_on_archived(mcp_env):
    pid = _make_plan(mcp_env)
    created = mcp_mod.create_item(pid, {"item_type": "note", "title": "Old",
                                        "details": {"when": {"start_at": "2026-09-10T09:00"}}})
    _archive_plan(mcp_env, pid)
    # Reads still work on archived plans.
    assert mcp_mod.get_plan(pid)["plan"]["status"] == "archived"
    assert mcp_mod.get_item(created["id"])["title"] == "Old"
