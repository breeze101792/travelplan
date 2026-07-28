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
- **Members** (`plan-members.html`) — share the plan with members, transfer ownership

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

## Development

```bash
.venv_$(hostname)/bin/python -m flask --app backend.app run --debug
./tests/run-tests.sh                # backend pytest + frontend node tests
./tests/run-tests.sh --e2e          # also run Playwright browser tests (slow)
```

`start.sh` no longer runs the tests (it just starts the server). Tests live
under `tests/` and are run separately via `tests/run-tests.sh`. **550 tests
total, all passing.** See `docs/test.md` for the full guide (fixture
catalog, how to add a test in each layer, debugging gotchas).

- **`tests/backend/`** — pytest, **149 tests** covering every blueprint
  (auth, plans, items, uploads, expenses, util). Fresh temp data dir per
  test; no shared state. Run alone with `./tests/run-tests.sh --backend`
  or `.venv_$(hostname)/bin/python -m pytest tests/backend -c pytest.ini`.
- **`tests/e2e/`** — Playwright (Python) browser tests, **42 tests** on a
  real Chromium against a throwaway Flask server. Two device profiles:
  desktop (1280x800, mouse) and iPhone 14 (390x664, touch). Covers setup,
  login, dashboard create/edit/delete, board add/edit/drag/revert items,
  right-click context menu, expenses, members, settings. Needs `playwright`
  installed (`pip install playwright`) and a chromium binary; on NixOS set
  `CHROMIUM=/nix/store/.../bin/chromium` (the conftest tries a default
  path). Run with `./tests/run-tests.sh --e2e`.
- **`frontend/tests/`** — the original node ES-module tests, **359 tests**
  (itinerary 134, staging 89, timeline 118, util 18). Plain node, no npm.
  Skipped automatically when node is not installed.

The frontend fixtures under `frontend/tests/` run the staging engine's unit
tests, execute `initItinerary()` and `initTimeline()` against a DOM shim +
stubbed fetch, and verify `fmtDate()` matches the server's `fmt_date()`
(no browser, no npm install — plain node ES modules).