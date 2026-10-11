# TravelPlan

A small, self-hostable web app to plan trips with friends: build day-by-day
itineraries out of typed items (hotel, transit, restaurant, activity, note),
attach images/links, drag-and-drop items across days, manage members with
per-plan sharing, and split expenses per item across currencies (you supply
the exchange rates at settlement).

The dashboard organises trips into three tabs (**Planning** / **Ongoing** /
**Archived**) with drag-and-drop between them. Cards support single-click
selection (Ctrl+click to toggle, Shift+click to range-select), double-click
to open a trip, and a modal editor for inline changes. On touch devices,
long-press initiates drag-and-drop (board, map, and dashboard all support
this).

- **Backend:** Python / Flask + stdlib `sqlite3` (no ORM, no separate DB server).
- **Frontend:** vanilla HTML/CSS/JS (ES modules, no build step).
- **Data & config:** everything lives under `data/` (SQLite DB, uploaded images,
  session secret, app settings) — the whole folder is your "database".

## Layout

```
backend/      Python: Flask app factory, DB, auth, expense engine, blueprints
frontend/     HTML/CSS/JS: Jinja2 templates + static JS modules
data/         SQLite DB, uploads, config (secret key + settings.json)
```

Plan pages (all share the `_plan_header.html` partial):

- **Board** (`plan.html`) — day-by-day cards, drag-and-drop reorder
- **Timeline** (`timeline.html`) — 24-hour lanes per day, drag to move/resize
- **Map** (`plan-map.html`) — Leaflet map with item geocodes
- **Navigate** (`navigation.html`) — turn-by-turn directions for transit items
- **Expenses** (`expenses.html`) — per-item ledger + multi-currency settlement
- **To-dos** (`/plans/<id>/todos`) — plan checklist: trip tasks, a shared
  global list, and a per-member preparation list
- **Members** (`plan-members.html`) — share the plan with members, transfer ownership

Each plan has a **To-dos** tab with three lists:

- **Trip tasks** — the project's own tasks (book the rental car, confirm
  the Airbnb). Owner/editor add, edit, and delete them; **any member can
  tick one off**, and the app records who did. This is the list for work
  anyone can pick up.
- **Everyone** — the shared list. Owner/editor add, edit, delete, *and*
  tick; other members only view.
- **Per-user preparation** — entries assigned by owner/editor to a member;
  only that member can tick their own entry, so the check mark is the
  assignee's own confirmation. Owner/editor reassign or delete a stuck
  task rather than ticking it for someone else.

Every member can see all lists and progress. Owner/editor add entries
through a single form at the top of the page, whose "for" select chooses
the list (Trip tasks, Everyone, or a member) — the sections below are
list-only. The to-do list is plan-level; it is separate from the per-item
to-do checklist inside the item editor.

## Run

```bash
./start.sh              # http://0.0.0.0:5050
./start.sh 8080         # listen on a custom port
PORT=9000 ./start.sh    # or set the port via the PORT env var
./start.sh --help       # full usage / help message
```

`start.sh` creates a per-host virtualenv (`.venv_$(hostname)`), installs Flask,
then serves the app. Tests are run separately via `./tests/run-tests.sh`
(see the **Tests** section below). Set the port with a positional arg
(`./start.sh 8080`) or the `PORT` env var (the arg wins); `HOST` defaults
to `0.0.0.0` so friends on the same network can reach your machine at
that port. Debug/auto-reload is **off** by default (the Werkzeug debugger
is unsafe to expose on a shared network) — use `DEBUG=1 ./start.sh` while
developing locally. `./backend/run.sh` still works as an alias for `./start.sh`.

On first run there is no admin yet — open the app and create the admin account
at the setup page. The admin then creates member accounts (for friends) and can
share each plan with chosen members.

Once you're logged in, **Settings** (in the topbar) lets you change your
display name and password. Admins get an extra section for creating, editing,
and deleting member accounts (the older `/auth/members` page is kept for
back-compat).

## Try it with fake data

```bash
./seed.sh            # seed or reset passwords
```

If no admin exists yet, `./seed.sh` wipes and populates a realistic test
dataset. If an admin already exists, it resets all user passwords to
`traveler` without touching any existing data.

Seeds four trips (**Japan 2026** base JPY, **Iceland Ring Road** base EUR,
**Beijing 2026** base CNY, **Tokyo 1-Day Test** base JPY) with full itineraries,
per-day hotels, image + link attachments, expenses in five currencies
(JPY / USD / EUR / ISK / CNY) using all four split methods, exchange rates,
and recorded payments. All seeded accounts use the password **`traveler`**:

| username | role |
|---|---|
| `admin` | admin, owns all four trips |
| `alice` | editor on all four trips |
| `bob` | editor on Japan 2026 |
| `carol` | viewer on Iceland Ring Road |

## Expenses & multi-currency

Each expense keeps its own currency. When you open a plan's **Settlement** view,
the app lists every currency that appears in the trip and asks you to enter an
exchange rate from each to the plan's *base currency*. The app never fetches or
assumes rates — you provide them, they are saved, and settlement is computed in
the base currency using a greedy min-cash-flow ("who owes whom") algorithm.

Each "who pays whom" row has a **Settle** button: the proposed amount is
pre-filled and editable, so a payment that is not the exact proposed number can
be recorded in one action. A row whose debt is gone is marked **Settled** and
loses its button; a partly paid row re-appears pre-filled with what is still
outstanding. Recorded quick settles show up in the Payments list below.

Settlement can be viewed in **Single currency** (all balances converted to one
currency and netted into a single "who pays whom") or **Per currency** (each
currency settled on its own). A payment always keeps the currency and amount
you actually paid, and records which currency debts it settles, so settling
from one mode is reflected in the other. When a single-currency row nets debt
across several currencies, one Settle records your real payment and the app
splits it across the debts it clears. One rare case cannot be settled by a
single payment: a row that nets debt between two people who owe each other
nothing directly in any one currency. That row says so and offers **Settle per
currency**, which switches to the per-currency view.

## AI agent & MCP

TravelPlan ships an AI extraction core (`backend/ai.py`), an in-app floating
**AI Agent** chat window on the board / timeline / map pages, and a Model
Context Protocol server (`backend/mcp_server.py`, launched via `./mcp.sh`) so
an external agent — e.g. opencode — can read a plan's itinerary and help fill
in items from pasted text (flight tickets, hotel confirmations, bookings).

The chat window takes text and images, answers questions, and suggests
itinerary items you can add via `POST /api/plans/<id>/ai/chat`. The MCP server
exposes seven tools: `list_plans`, `get_plan`, `list_items`, `get_item`,
`extract_item`, `create_item`, `update_item`. It reads/writes the SQLite DB
directly over stdio and is registered in the project's `opencode.json`. The
LLM connection (any OpenAI-compatible endpoint) is configured in
`data/config/ai.json` (gitignored). See `docs/ai.md` for the config format,
tool list, and opencode setup.

## Development

```bash
.venv_$(hostname)/bin/python -m flask --app backend.app run --debug
./tests/run-tests.sh                # backend pytest + frontend node tests
./tests/run-tests.sh --e2e          # also run Playwright browser tests (slow)
```

`start.sh` no longer runs the tests (it just starts the server). Tests live
under `tests/` and are run separately via `tests/run-tests.sh`. The backend
and frontend node suites pass; the e2e suite has some pre-existing failures
in other files noted below. See `docs/test.md` for the full guide (fixture
catalog, how to add a test in each layer, debugging gotchas).

- **`tests/backend/`** — pytest, **433 tests** covering every blueprint
  (auth, plans, items, uploads, expenses, todos, util). Fresh temp data dir
  per test; no shared state. Run alone with `./tests/run-tests.sh --backend`
  or `.venv_$(hostname)/bin/python -m pytest tests/backend -c pytest.ini`.
- **`tests/e2e/`** — Playwright (Python) browser tests, **96 tests** on a
  real Chromium against a throwaway Flask server. Two device profiles:
  desktop (1280x800, mouse) and iPhone 14 (390x664, touch). Covers setup,
  login, dashboard create/edit/delete, board add/edit/drag/revert items,
  right-click context menu, map sidebar, navigation day bar + swipe,
  timeline day columns + quick-add, expenses, todos, members, settings.
  Needs `playwright` installed (`pip install playwright`) and a chromium
  binary; on NixOS set `CHROMIUM=/nix/store/.../bin/chromium` (the
  conftest tries a default path). Run with `./tests/run-tests.sh --e2e`.
- **`frontend/tests/`** — the original node ES-module tests, **791 tests**
  (itinerary, timeline, staging, navigation, map, page-utils, util, api,
  cache, guard, markdown, ai, plan-store, todos, settlement). Plain node, no npm.
  Skipped automatically when node is not installed.

**Known baseline failures.** The backend and frontend node suites are green
on this tree. The e2e suite still has pre-existing failures in other files
from stale item-creation helpers and timeouts; `tests/e2e/test_todos.py`
is green. New work must not add to these; see `docs/test.md`.

The frontend fixtures under `frontend/tests/` run the staging engine's unit
tests, execute `initItinerary()`, `initTimeline()`, `initNavigation()`, and
`initMap()` against a DOM shim + stubbed fetch, and verify `fmtDate()`
matches the server's `fmt_date()` (no browser, no npm install — plain node
ES modules). The map page's Leaflet dependency is replaced with a minimal
stub (`lib/map-shim.mjs`).