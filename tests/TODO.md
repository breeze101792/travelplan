# Tests

All tests live under `tests/` and run via `tests/run-tests.sh`:

- **`tests/backend/`** — pytest, **149 tests** covering every blueprint
  (auth, plans, items, uploads, expenses, util). Fresh temp data dir per
  test via the `fresh_app` fixture; no shared state. Run alone with
  `./tests/run-tests.sh --backend` or `.venv_$(hostname)/bin/python -m
  pytest tests/backend -c pytest.ini`.
- **`tests/e2e/`** — Playwright (Python), **42 tests** on real Chromium
  against a throwaway Flask server. Two device profiles: desktop
  (1280x800, mouse) and iPhone 14 (390x664, touch). Covers setup, login,
  dashboard create/edit/delete, board add/edit/drag/revert, right-click
  context menu, expenses, members, settings. Run with
  `./tests/run-tests.sh --e2e`.
- **`frontend/tests/`** — the original node ES-module tests (staging
  engine, itinerary/timeline page execution, `fmtDate` parity).
  **359 tests** — itinerary 134, staging 89, timeline 118, util 18.
  Plain node, no npm.

## Total: 550 tests, all passing.

`./tests/run-tests.sh --e2e` runs all three suites and exits 0 on success.
