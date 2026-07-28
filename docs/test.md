# Tests

The test setup as it stands today. If you are adding a test or fixing a
flake, start here.

## What's covered

550 tests, split across three layers. Every layer catches a different
class of bug; you usually want all three to pass before declaring a
change done.

| Layer | Path | Count | What it catches |
| --- | --- | --- | --- |
| Backend | `tests/backend/` | 149 | route handlers, auth, plan/item/expense/upload logic, util, access control. Hits Flask over the test client with a real DB in a temp dir. |
| Frontend node | `frontend/tests/` | 359 | staging engine ops, itinerary/timeline page boot under a DOM shim, `fmtDate` parity with the server. No browser, no npm. |
| E2E browser | `tests/e2e/` | 42 | what the user actually sees: setup, login, dashboard, board, expenses, members, settings, touch long-press on iPhone. Real Chromium via Playwright. |

## Run

```bash
./tests/run-tests.sh                # backend pytest + frontend node (~30s)
./tests/run-tests.sh --e2e          # also run Playwright browser tests (~75s)
./tests/run-tests.sh --backend      # only pytest
./tests/run-tests.sh --frontend     # only node
```

The runner picks the project's venv (`.venv_$(hostname)/bin/python`)
automatically; override with `PYTHON=/path/to/python`. E2E needs a
chromium binary — set `CHROMIUM=/path/to/chrome`. On NixOS the conftest
points at a system chromium automatically.

## Backend: pytest + Flask test client

`tests/backend/conftest.py` provides the shared fixtures:

| Fixture | Purpose |
| --- | --- |
| `fresh_app` | New Flask app + temp data dir per test. No users. |
| `app` | `fresh_app` plus admin + alice + bob seeded. |
| `client` | Bare test client (no session). Log in via `login()` or post to `/auth/login`. |
| `admin_client`, `member_client` | Separate clients pre-logged-in so a test can use both without one clobbering the other's session. |
| `login` | Function that posts to `/auth/login`. Returns the response. |
| `make_user`, `make_plan` | Factories for additional users / plans via the API. |
| `db` | Query helper that opens its own short-lived app context per call so it doesn't deadlock the shared DB lock. |

The `db` fixture is intentionally NOT a live connection — the shared
SQLite connection is serialized via a module-level lock, and an
open `db` connection held across a `client.get()` would deadlock.
Use `db.one(sql, args)` / `db.all(sql, args)` instead.

Tests are organized by blueprint:
- `test_auth.py` — setup, login, logout, settings, members (admin)
- `test_plans.py` — plan CRUD, buffer days, day meta, sharing, transfer, header render, fmt_date
- `test_items.py` — item CRUD, drag/drop, attachments, image upload, access control
- `test_expenses.py` — split methods (EQUAL/EXACT/PERCENTAGE/SHARES), multi-currency settlement, payments, by-item totals

When adding a test:

1. Pick the right file (or create a new `test_<blueprint>.py` if it's a
   new blueprint). Group by behavior, not by method name.
2. Use `fresh_app` if the test creates its own users; `app` if it can
   share the seeded admin/alice/bob.
3. Use `admin_client` / `member_client` for separate sessions; `client`
   + `login` only if you need to re-login mid-test.
4. Prefer asserting on the API JSON (status code + body) over parsing
   HTML. The header-render tests are the exception — they read HTML
   because that's the contract being tested.
5. Use `db.one(sql)` for direct DB assertions; never `with app.app_context():
   db.execute(...)` across a `client` call.

## Frontend node: DOM shim + page execution

`frontend/tests/` is plain node ES modules — no `npm install`, no build.
Each `*.test.mjs` is run directly with `node --import ./register.mjs`.
The harness (`register.mjs` + `lib/loader.mjs` + `lib/dom-shim.mjs` +
`lib/fetch-stub.mjs`) gives the JS modules the globals they expect
(document, window, fetch, sessionStorage, matchMedia, etc.) and routes
`import '/static/js/...'` to the real source files.

The shim is **not** jsdom — it's hand-rolled and minimal. When a new
module reads a global the shim doesn't implement yet, the symptom is
`ReferenceError` at module load. Fix it in `lib/dom-shim.mjs`.

`resetSettingsCache()` (exported from `static/js/util.js`) must be
called between boots in a test that re-installs fetch with a different
`/api/settings` response — otherwise the second boot sees the cached
settings from the first.

When adding a test:

1. Re-use the `boot(role)` helper where possible. It calls
   `installDom` (fresh DOM), installs the stub fetch, resets the
   settings cache, then boots `initItinerary` or `initTimeline`.
2. For a custom fixture (different plan/items/settings), copy the
   `installDom` + `installFetch` + `resetSettingsCache` + `initItinerary`
   sequence. Re-fetch card elements after re-renders — `click()` /
   `dispatch()` can detach the node you held a reference to.
3. Editor opens on **double-click**, not single-click. A single click
   selects. Use `card.dispatch('dblclick', { detail: 2 })`.
4. Hotel span bars carry `tl-item-hotel`; check-in/out event bars
   don't. Buffer days sort by date (9999-12-31 sentinel → end of list).
5. Style values live in the `style` *attribute*, not the `style` proxy:
   `el.getAttribute('style')` and regex out the property.

## E2E: Playwright (Python)

`tests/e2e/conftest.py` launches a real Flask server on a random port
(temp data dir, seeded admin + alice + bob) and exposes two browser
contexts:

| Fixture | Purpose |
| --- | --- |
| `server` (session) | Flask server base URL + admin/alice/bob creds. |
| `desktop` | Chromium 1280x800, mouse, pre-logged-in as admin. |
| `iphone` | Playwright's `iPhone 14` device profile (390x664, touch). |
| `fresh_page` | Desktop page with no session (for login/setup tests). |

Browser tests are **slow** (~75s for the full suite). Run them with
`--e2e`, not by default.

Two gotchas worth knowing:

- **IndexedDB cache**: the dashboard caches GET responses in
  IndexedDB. `apiPost`/`apiPatch`/`apiDel` clear the cache, so
  mutations re-render fresh. But the `login` fixture pre-loads
  `/dashboard` once and caches the (pre-test) plan list. If a test
  creates a plan via the API then navigates to `/dashboard`, the
  page may show stale data. Use `_clear_cache(page)` (the helper
  in `test_dashboard_board.py`) or just reload after the first
  dashboard render.
- **Default tabs**: the dashboard defaults to the "ongoing" tab
  when any ongoing plan exists. Tests that create a "planning" plan
  must click `.tab-btn[data-tab=planning]` before asserting cards.

When adding an E2E test:

1. Prefer the `desktop` / `iphone` fixtures (already logged in).
   Use `fresh_page` only when testing login/setup.
2. For setup that needs a plan / items, use `_create_plan_api` /
   `_api_client` (urllib-based) — much faster than driving the UI
   for prerequisites.
3. The board's editor opens on double-click (desktop) and
   double-tap (touch). Single-click selects.
4. Selectors: `button[type=submit]` (not `text=Sign in`, which also
   matches the page tagline), `.day` for day columns, `.card.item`
   for item cards, `.pb-btn` for pending-bar buttons.

## How a fix moves through all three layers

When you change behavior, update the layer that's affected *first* and
work outward:

- **Pure backend change** (route handler, validation): add/extend a
  pytest test in `tests/backend/`. If the change is user-visible, add
  an E2E test that drives the UI.
- **Pure frontend JS change** (staging engine, util): add a node test
  in `frontend/tests/`. If the change is a page boot path or a DOM
  interaction, that test will already be in the existing
  itinerary/timeline files.
- **UI behavior change** (new button, different click handler): update
  the relevant node test for the page-level invariant and add an E2E
  test for the user flow.

Don't skip a layer. The pytest tests catch the route logic; the node
tests catch the JS engine; the E2E tests catch wiring bugs (selector
drift, async races, cache invalidation). All three together is what
keeps "I modified one thing and broke another" from reaching the user.
