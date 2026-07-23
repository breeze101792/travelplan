# Development notes

Lessons and patterns from working on this codebase. New to the project?
Read the README first, then this file. Already familiar? Skim the headings.

## Tests

`start.sh` runs three test suites before serving, and a failing test in
any of them aborts startup:

| Suite                  | Command                              | What it covers                              |
| ---                    | ---                                  | ---                                         |
| Backend expense engine | `python -m backend.expense`          | the settlement / multi-currency engine      |
| Backend auth           | `python -m backend.tests`            | login + self-serve settings (Flask client)   |
| Frontend fixtures      | `bash frontend/tests/run.sh`         | staging engine + page execution (node)      |

The frontend fixture is skipped (exit 0) if `node` is not on `PATH`; set
`NODE=/path/to/node` to force a failure in that case. Every suite also
prints a short banner (`>> running expense engine self-tests` etc.) so
you can see which gate fired when startup fails.

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
  run.sh              runs every *.test.mjs; exits 0 (skip) without node
```

The point of the page-execution test (`itinerary.test.mjs`) is to
catch the *runtime* bugs a syntax check can't see — a missing import,
a block-scope `const` that escapes its `try`, a missing DOM method on a
shim element. See the lesson below on the blank-board crash.

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
re-runs. The pattern in `backend/tests/_fresh_app()`:

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

- `start.sh` is the source of truth for "does this build?" It runs
  the venv setup, all three test suites, then the server. A failing
  test aborts startup. If `start.sh` works, the codebase is healthy.
- The frontend test fixture needs node (any recent LTS; 20+ works).
  If a machine doesn't have node, `run.sh` skips with exit 0, and
  `start.sh` carries on. Set `NODE=/path/to/node` if you want a
  missing-node failure instead of a skip.
- For per-test debug under node, the `loader.mjs` + `register.mjs`
  pair makes `import '/static/js/...'` resolve to the real files.
  Useful when a test crashes deep in a page module and you want
  `node --import` to load the real source.
