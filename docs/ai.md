# AI agent & MCP

TravelPlan exposes an AI extraction core, a web endpoint for the in-app
floating AI window, and a Model Context Protocol (MCP) server so an external
agent (e.g. opencode) can read a plan's itinerary and help fill in items from
pasted text (flight tickets, hotel confirmations, restaurant bookings).

## AI config

The LLM connection lives in `data/config/ai.json` (gitignored — never commit
an API key). It is read on every call, so edits take effect without a restart.

```json
{
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-...",
  "model": "gpt-4o-mini"
}
```

`base_url` is any OpenAI-compatible `/chat/completions` endpoint — OpenAI, a
local Ollama (`http://localhost:11434/v1`), a gateway, etc. `api_key` is
optional (omit for local models that need no auth). If the file is missing or
incomplete, extraction raises `AIConfigError` and the caller reports "AI is
not configured".

### Admin UI

Admins can edit the provider from the **AI Agent** page (`/auth/ai`, linked in
the topbar dropdown). It saves `base_url`, `api_key`, and `model` to
`data/config/ai.json`. The API key is shown as a password field and never
exposed to non-admins.

## Extraction core — `backend/ai.py`

`extract_item(text, item_type=None, settings=None)` parses raw text into a
structured item:

```python
{
  "item_type": "transit",
  "title": "JL 123 Tokyo to Osaka",
  "details": {"mode": "Flight", "provider": "JAL", "ref_no": "JL123",
              "from": "Tokyo", "to": "Osaka", "when": {...}},
  "when": {"start_at": "2026-09-10T09:00", "end_at": "2026-09-10T10:00"},
  "item_date": "2026-09-10",
  "end_date": "2026-09-10"
}
```

The system prompt is built from `settings.json`'s `item_types` schema, so the
model only returns valid types and field keys. `when` is coerced through the
same `_coerce_when` the web app uses (end_at defaults to start_at + 1h). The
module is stdlib-only so both the Flask app and the MCP server can import it.

## In-app floating AI chat window

On the plan pages (board / timeline / map) a draggable, collapsible **AI
Agent** chat window floats in the corner. Send text and optionally attach an
image; the plan's AI assistant replies conversationally and may suggest
itinerary items. Each suggestion is offered as an **Add** button that opens
the item editor pre-filled for review — Apply stages the change through the
normal pending bar, so nothing reaches the server until you click Save.

- **Endpoints** (`backend/blueprints/ai.py`):
  - `POST /api/plans/<id>/ai/chat` — conversational turn. Body `{messages:
    [{role, content}], image?: data-URL}` → `{reply, items}`. Read access is
    enough to chat; adding items still goes through the write path.
  - `POST /api/plans/<id>/ai/extract` — single-item extraction (used by the
    MCP server and kept for the old flow). Requires write access.
- **Widget:** `frontend/static/js/ai-agent.js` + `ai-agent.css`, mounted in
  `plan-shell.html` / `plan-shell.js`. Shown only on board / timeline / map.
- **Pre-fill:** `frontend/static/js/ai-extract.js` stages a blank item, patches
  it with the suggestion, and opens the editor. Each view registers its
  staging context via `registerAgentContext()`.

### Edit gating

The AI agent can only **modify** a plan when the user has write access and the
plan is not archived:

- **Viewer role** or **archived plan** → the chat still works (read-only), but
  suggested items render as plain text instead of **Add** buttons.
- **MCP server** — `create_item` / `update_item` raise `ValueError("plan is
  archived and read-only")` on archived plans; read tools still work.

## MCP server — `backend/mcp_server.py`

Runs over stdio and reads/writes the SQLite DB directly (no Flask request
context, no auth — it is launched locally by the user's own agent). Launch
with `./mcp.sh` (resolves the per-host venv, installs the `mcp` dependency if
missing, then runs the server).

### Tools

| Tool | Description |
|---|---|
| `list_plans()` | All trips (id, title, dates, status, owner). |
| `get_plan(plan_id)` | Plan + items + settings (item-type schemas). |
| `list_items(plan_id)` | All items in a plan, ordered by day then sort order. |
| `get_item(item_id)` | A single item by id. |
| `extract_item(text, item_type?)` | Parse pasted text into a structured item. |
| `create_item(plan_id, item)` | Insert a typed item into the plan. |
| `update_item(item_id, item)` | Edit an existing item's fields/status/details/when. |

`create_item` / `update_item` mirror the web app's item logic: they coerce
`when`, derive `item_date` / `end_date`, and compute `sort_key` so items land
in the right day. Items created via MCP appear in the web UI on the next
fetch (no SSE live-push from the MCP process).

## Registering with opencode

The project `opencode.json` already declares the server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "travelplan": {
      "type": "local",
      "command": ["./mcp.sh"],
      "enabled": true
    }
  }
}
```

After editing `opencode.json`, quit and restart opencode for the MCP server to
load. Then the agent can, for example: *"I'm on the Japan trip, here's my
flight ticket — add it as a transit item."* It reads the plan, extracts the
fields, and inserts the item.

## Testing

- `tests/backend/test_auth.py` — the admin AI settings page (admin-only 403,
  save persists config, missing fields rejected).
- `tests/backend/test_ai.py` — extraction core + chat with a stubbed `urlopen`
  (valid, invalid type, config-missing, type constraint, title default, chat
  reply/items, invalid-item skipping).
- `tests/backend/test_ai_endpoint.py` — the web endpoints (extract happy path,
  missing text, not-configured, invalid type, login 401, viewer 403; chat
  reply/items, missing messages, not-configured, viewer allowed).
- `tests/backend/test_mcp.py` — all seven tools against a temp data dir
  (create/update round-trip, validation errors, missing rows).
- `frontend/tests/ai-agent.test.mjs` — the chat widget (init, visibility per
  view, chat submit flow, suggestion add, no-context guard).

Run with `./tests/run-tests.sh --backend` (or the two files directly via
pytest) and `bash frontend/tests/run.sh`.
