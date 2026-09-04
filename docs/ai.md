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
  "model": "gpt-4o-mini",
  "searxng_url": "http://localhost:8888"
}
```

`base_url` is any OpenAI-compatible `/chat/completions` endpoint — OpenAI, a
local Ollama (`http://localhost:11434/v1`), a gateway, etc. `api_key` is
optional (omit for local models that need no auth). `searxng_url` is optional:
when set, the in-app chat agent can search the web through that SearXNG
instance (see **Web search** below). If the file is missing or incomplete,
extraction raises `AIConfigError` and the caller reports "AI is not
configured".

### Admin UI

Admins can edit the provider from the **AI Agent** page (`/auth/ai`, linked in
the topbar dropdown). It saves `base_url`, `api_key`, `model`, and
`searxng_url` to `data/config/ai.json`. The API key is shown as a password
field and never exposed to non-admins.

A **Test AI provider** button and a **Test SearXNG** button verify each
endpoint against the values currently in the form (not yet saved). The AI test
hits the provider's `/models` endpoint to confirm the model is available; the
SearXNG test runs a trivial search. Results are shown inline next to each
button. The underlying check is `test_connections(cfg)` in `backend/ai.py`,
exposed as `POST /api/ai/test` (admin-only) with a `service` field
(`"ai"` or `"searxng"`).

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

The prompts instruct the model to **fill every field it can infer** — e.g. a
transit item always gets a `mode` (Flight/Train/Bus/Ferry/Taxi/Rental car),
a hotel gets its address, a restaurant its name/address/party size — plus the
date (`when`) and **geocodes** (real `{label, lat, lng}` coordinates) for each
location. Geocodes are normalized (`_normalize_geocodes` drops entries without
valid numeric lat/lng) and flow into the item editor's Map locations section,
so the map page doesn't need to re-geocode.

Model output is hardened: empty or non-JSON replies are retried (up to
`_MAX_RETRIES`), and each retry appends a corrective user message ("respond
with a single JSON object only") so a model that drifts into prose is steered
back instead of re-sending the same prompt. Markdown-fenced and prose-wrapped
JSON are also parsed out of the reply.

## In-app floating AI chat window

On the plan pages (board / timeline / map) a draggable, resizable **AI Agent**
chat window floats in the corner. It starts **minimized** to a small icon
(bottom-right); click the icon to open it, the **−** button to minimize it
again, and the **🗑** button to clear the conversation. Send text and
optionally attach an image (via the **📎** button or by pasting a screenshot);
the plan's AI assistant replies conversationally (rendered as markdown) and
may suggest itinerary items. Each suggestion is offered as an **Add** button
that opens the item editor pre-filled for review — Apply stages the change
through the normal pending bar, so nothing reaches the server until you click
Save.

The window and its minimized icon are shown only on board / timeline / map;
navigating to any other page hides both.

- **Endpoints** (`backend/blueprints/ai.py`):
  - `POST /api/plans/<id>/ai/chat` — conversational turn. Body `{messages:
    [{role, content}], image?: data-URL}` → `{reply, items, edits}`. Read
    access is enough to chat; adding/editing items still goes through the
    write path.
  - `POST /api/plans/<id>/ai/extract` — single-item extraction (used by the
    MCP server and kept for the old flow). Requires write access.
- **Widget:** `frontend/static/js/ai-agent.js` + `ai-agent.css`, mounted in
  `plan-shell.html` / `plan-shell.js`. Shown only on board / timeline / map.
- **Pre-fill:** `frontend/static/js/ai-extract.js` stages a blank item (or
  patches an existing item for an edit), and opens the editor. Each view
  registers its staging context via `registerAgentContext()`.

### Editing existing items

The chat response can also carry `edits`: an array of changes to existing
items, used when the user asks to change something already in the plan (e.g.
"change the hotel date"). Each edit is `{item_id, title?, details?, when?}`
with only the fields the user wants to change. The plan context sent to the
model includes each item's `id` so it can reference the right one.

Each edit is offered as an **Edit item** button that opens the item editor
pre-filled with the proposed change — Apply stages a PATCH through the normal
pending bar, exactly like the create flow. `_normalize_edit` in `backend/ai.py`
validates each edit (drops any without an `item_id`, strips empty fields).

### Edit gating

The AI agent can only **modify** a plan when the user has write access and the
plan is not archived:

- **Viewer role** or **archived plan** → the chat still works (read-only), but
  suggested items render as plain text instead of **Add** buttons.
- **MCP server** — `create_item` / `update_item` raise `ValueError("plan is
  archived and read-only")` on archived plans; read tools still work.

## Web search

When `searxng_url` is set in `ai.json`, the in-app chat agent can search the
web for up-to-date information (weather, opening hours, prices, events,
transport status, etc.). The chat runs a small **tool-calling loop**:

1. The model is told it may request a search and returns `{"search": "query"}`.
2. The backend calls `web_search(query)` against the SearXNG JSON endpoint
   (`/search?q=...&format=json`), which returns the top hits
   (`{title, url, content}`).
3. The results are appended to the conversation and the model produces the
   final `{reply, items}`.

The loop is bounded (`_MAX_SEARCH_ROUNDS = 3`) so a model that keeps asking to
search cannot loop forever. If no `searxng_url` is configured, the model is not
told it can search and any stray `search` key in its reply is ignored.

- **Core:** `web_search(query, searxng_url=None, max_results=5)` in
  `backend/ai.py` — stdlib-only, raises `AIConfigError` if no SearXNG URL is
  configured and `ValueError` on a transport/parse error.
- **Config:** `searxng_url` in `data/config/ai.json`, editable on the admin
  **AI Agent** page.

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
  save persists config, missing fields rejected; the `/api/ai/test` endpoint:
  admin-only 403, returns connection status, `service` filter).
- `tests/backend/test_ai.py` — extraction core + chat with a stubbed `urlopen`
  (valid, invalid type, config-missing, type constraint, title default, chat
  reply/items, invalid-item skipping; geocodes: filled, invalid dropped,
  empty when absent, in chat items and edits; chat edits: change date / title /
  details, skip missing item_id, ignore empty details, empty/absent edits;
  retry hardening: empty/non-JSON retried, corrective message appended on
  retry, prose-then-JSON recovery, markdown-fenced/noise parsing, clear
  ValueError after all retries; web search hits/encoding/not-configured/
  transport-error; chat search loop with results and with no results;
  `test_connections` all-ok / model-missing / unreachable / missing-fields /
  searxng-unreachable).
- `tests/backend/test_ai_endpoint.py` — the web endpoints (extract happy path,
  missing text, not-configured, invalid type, login 401, viewer 403; chat
  reply/items, missing messages, not-configured, viewer allowed).
- `tests/backend/test_mcp.py` — all seven tools against a temp data dir
  (create/update round-trip, validation errors, missing rows).
- `tests/backend/test_ai_agent.py` — the full chat→add and chat→edit journeys
  across the web API (create item then edit its date via the normal PATCH
  endpoint), plus read-only gating (viewer can chat but not add; archived plan
  blocks create) and geocode persistence (a suggested item's coordinates are
  written to `item_geocodes`).
- `frontend/tests/ai-extract.test.mjs` — `ai-extract.js` (create patches
  title/details/when/geocodes onto a staged draft; edit patches an existing
  item including geocodes; unknown edit id is a no-op; no geocodes when none
  supplied).
- `frontend/tests/ai-agent.test.mjs` — the chat widget (init + default-minimized,
  per-view visibility, minimize/restore, resize, typing indicator, chat submit
  flow, image attach + paste, suggestion add, edit flow with change-date,
  read-only gating for edits, clear chat, no-context guard).
- `frontend/tests/markdown.test.mjs` — the markdown renderer (headings, bold/
  italic, code, lists, links, paragraphs, XSS safety, edge cases).

Run with `./tests/run-tests.sh --backend` (or the two files directly via
pytest) and `bash frontend/tests/run.sh`.
