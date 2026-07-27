# Test TODOs

Pre-existing frontend unit tests that need updating to match current app
behavior (not introduced by the new test suite; these were already failing
on `main` before the e2e/backend work):

## frontend/tests/itinerary.test.mjs
- `board renders 3 day sections` — expects 3 day columns, gets 1. The
  `buildDays`/`viewPlan` path under the DOM shim returns only the Undated
  column. Likely the staging view's plan doesn't carry `start_date`/
  `end_date` through to `buildDays`, or the shim's `Intl.DateTimeFormat`
  parse path differs. Investigate `staging.viewPlan()` vs the stubbed
  `GET /api/plans/1` response.

## frontend/tests/timeline.test.mjs
- Several `FAIL`s around hotel bar classes, resize handles, and viewer
  drag. The timeline rendering changed (hotel bars, resize handles) and
  the test expectations weren't updated. The module-load errors
  (`document is not defined`, `sessionStorage is not defined`,
  `getBoundingClientRect`, `style.setProperty`) were fixed by adding
  guards in `plan-header.js` and shims in `dom-shim.mjs`; the remaining
  failures are real expectation drift.

These are orthogonal to the backend + E2E coverage added in `tests/backend/`
and `tests/e2e/`. Fix them when touching the timeline/itinerary rendering
code next.

## Backend bug fixed
- `backend/blueprints/expenses.py` — `parse_amount_to_cents` raises
  `decimal.InvalidOperation` for non-numeric amount strings; the create
  and update expense handlers caught `(ValueError, TypeError)` but not
  `ArithmeticError`. Fixed by catching `(ValueError, TypeError,
  ArithmeticError)` and returning 400. Covered by
  `tests/backend/test_expenses.py::TestExpenseCreate::test_invalid_amount`.

## Frontend cache bug fixed
- `frontend/static/js/api.js` — `apiPost`/`apiPatch`/`apiDel`/`apiUpload`
  now `await cacheClear()` on success. Previously mutations didn't
  invalidate the IndexedDB GET cache, so the dashboard showed stale
  lists after creating/editing/deleting a trip. The E2E tests no longer
  need the `indexedDB.deleteDatabase` workaround (kept in
  `test_iphone_dashboard_renders_cards` and `test_dashboard_board.py`
  where the login fixture pre-caches the pre-test list).