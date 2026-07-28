# Development notes

Lessons and patterns from working on this codebase. New to the project?
Read the README first, then this file. Already familiar? Skim the headings.

## Tests

`start.sh` no longer runs tests (it just starts the server). All tests live
under `tests/` and run via `tests/run-tests.sh`:

| Suite                  | Command                              | What it covers                              |
| ---                    | ---                                  | ---                                         |
| Backend (pytest)       | `./tests/run-tests.sh --backend`     | auth, plans, items, uploads, expenses, util |
| Frontend (node)       | `bash frontend/tests/run.sh`         | staging engine, board boot, timeline boot, `fmtDate` |
| E2E (Playwright)       | `./tests/run-tests.sh --e2e`         | desktop + iPhone browser flows (login, dashboard, board, expenses, members, settings) |

`tests/backend/` is pytest with shared fixtures (`conftest.py`: fresh temp
data dir per test, `app`/`client`/`admin_client`/`member_client`/`make_user`/
`make_plan`/`db` query helper). ~150 tests covering every blueprint.
`tests/e2e/` is Playwright (Python) driving a real Chromium against a
throwaway Flask server; two device profiles — desktop (1280x800) and
iPhone 14 (390x664, touch). ~40 tests.

The frontend fixture is skipped (exit 0) if `node` is not on `PATH`; set
`NODE=/path/to/node` to force a failure in that case.

## Frontend test fixture: what's there and why

`frontend/tests/` is a zero-dependency test harness — plain node ES
modules, no `npm install`, no build step. The structure:

```
frontend/tests/
  lib/dom-shim.mjs    minimal DOM (elements, classList, events, attribute
                      selectors, dataset as a Proxy, getBoundingClientRect)
  lib/fetch-stub.mjs  route-table fetch replacement that records calls
  lib/t.mjs           assert/eq/summary harness
  loader.mjs          maps browser-absolute /static/… to the real files
  register.mjs        module.register hook for the loader
  itinerary.test.mjs  executes the real initItinerary() under the shim
  staging.test.mjs    unit tests for the staging engine (view, undo/redo,
                      save dispatch, error halt, session discard, id
                      remapping for create+attach+expense)
  timeline.test.mjs   regression fixture for the timeline view (boot,
                      day numbering, bar drag/resize math, multi-select,
                      context menu, buffer days, toolbar, header edit,
                      beforeunload guard)
  util.test.mjs       unit tests for fmtDate (matches server fmt_date byte-for-byte)
  run.sh              runs every *.test.mjs; exits 0 (skip) without node
```

The point of the page-execution tests (`itinerary.test.mjs`,
`timeline.test.mjs`) is to catch the *runtime* bugs a syntax check can't
see — a missing import, a block-scope `const` that escapes its `try`, a
missing DOM method on a shim element. See the lesson below on the
blank-board crash.

## Lessons

### Block-scope `const` inside `try` is invisible outside

A `const` declared inside a `try { ... }` block is block-scoped. Using
it after the block — for example, after a `catch` returns and the
function continues with a value the `try` was supposed to produce —
throws a `ReferenceError` at runtime. A linter or a syntax check won't
catch it; only running the code does.

Concrete example that bit us: in the page boot, a `try { const [,
planRes, memRes, itemsRes, expRes] = await Promise.all([...]); ... }
catch { return; }` was followed by code that used `itemsRes.items`
after the block. The `const` made `itemsRes` invisible, the page threw
on first load, the board rendered blank. The DOM-shim page-execution
test was added specifically so this class of bug fails `start.sh`
before it ships.

Rule of thumb: if a value is created inside a `try` and used after
it, declare it (`let`) **outside** the `try` and assign inside, or
return a tuple from a helper. The DOM-shim test is the safety net.

### `getBoundingClientRect` in the DOM shim

Node has no layout, so tests that read `getBoundingClientRect` need
either an explicit rect on the element or a zero-rect default. If the
shim ever needs to support this, the pattern is: set
`el._rect = { left, top, width, height }` to simulate a laid-out box,
or leave it unset to get `{0,0,0,0}`.

### Per-test fresh data dir + `db.reset_for_tests()`

`backend/db.py` keeps a single shared SQLite connection for WAL
performance (the connection holds the warm WAL index). Tests that
point the app at a new temp data dir must call `db.reset_for_tests()`
first to drop the cached connection, otherwise `init_db()` creates the
schema in the new file but `get_db()` reuses the old connection —
queries return empty / stale data and `UNIQUE` constraints fire on
re-runs. The pattern lives in `tests/backend/conftest.py`'s
`fresh_app` fixture:

```python
db_mod.reset_for_tests()
db_mod.DATA_DIR = data
db_mod.DB_PATH = data / "travelplan.db"
app = create_app({...})
```

### `/auth/logout` is GET-only

The topbar uses `<a href="/auth/logout">`, so the route is `GET`. A test
that does `client.post("/auth/logout", ...)` gets a 405 and — critically
— the session is **not** cleared. The next `_login(...)` then sees the
leftover session, the login route short-circuits to the dashboard
(`if "user_id" in session: redirect`), and the test silently passes
without actually re-checking the password. Always use a `client.get`
helper for logout in tests:

```python
def _logout(client):
    return client.get("/auth/logout", follow_redirects=False)
```

### `.modal` (base) silently caps a `.modal.item-editor` (board) override

The item-editor markup carries **both** `class="modal"` (from
`base.css`) and `class="item-editor"`. `base.css`'s `.modal` sets
`width: 100%; max-width: 540px` for the small generic dialogs
(settlement, confirm-delete). `board.css`'s `.modal.item-editor`
(higher specificity) sets `width: min(80vw, 1600px)`. The width
override wins, but `max-width: 540px` from `.modal` is a **separate
property** and stays applied — the visible width is capped at 540px
regardless of what `width` says. Result: a wide-editor CSS that
*looks* right but renders phone-sized in practice.

Rule of thumb: when a higher-specificity rule "should" override a
lower-specificity one, check every property on the lower rule that
constrains the element. `width` won, `max-width` didn't. Override
both. (The fix is in `board.css` `.modal.item-editor` with explicit
`max-width: min(90vw, 1800px)` plus `padding` and `margin` so the
wide layout is fully self-styled.)

### `/auth/settings` is self-serve only

Don't put admin user management on the settings page. The legacy
`/auth/members` page is already the admin's home for create / edit /
delete accounts; the settings page should be strictly "change my own
display name and password." A small hint in the subhead ("Admins:
manage member accounts on the Members page") is enough. Removing
duplication means fewer pages to keep in sync and a clearer mental
model for users.

When trimming a feature from a multi-purpose page, remove the JS and
tests that existed *only* for the removed section. The settings page
shipped with an inline Edit/Cancel pattern (a `settings.js` module +
a `settings.test.mjs`); both were deleted when the admin section
left, since the pattern only existed for the admin member table.
Net -407 lines.

### Working on `main` directly (no feature branch)

When a change is small, focused, and the user wants to keep moving
without the branch/merge dance, commit straight to `main` and
fast-forward merges. The `git got` comment in the session was
"we got git" — meaning the VCS handles history, so a tight linear
history on `main` is fine; no need for a `feature/*` branch for every
change. For larger multi-commit work a branch is still useful, but
default to `main` unless the change is big enough to need isolation.

## Workflow tips

- `./tests/run-tests.sh --e2e` is the source of truth for "does this
  build?" It runs the backend pytest suite, the frontend node tests, and
  the Playwright browser tests. A failing test exits non-zero. If the
  runner is green, the codebase is healthy. `start.sh` just starts the
  server (no test gate).
- The frontend test fixture needs node (any recent LTS; 20+ works).
  If a machine doesn't have node, `run.sh` skips with exit 0, and
  `start.sh` carries on. Set `NODE=/path/to/node` if you want a
  missing-node failure instead of a skip.
- For per-test debug under node, the `loader.mjs` + `register.mjs`
  pair makes `import '/static/js/...'` resolve to the real files.
  Useful when a test crashes deep in a page module and you want
  `node --import` to load the real source.
