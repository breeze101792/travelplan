# Quick Settle and cross-currency settlement

## Goal

Settle a trip in one action from the Settlement view, and make a settlement
recorded in one view show up correctly in the other. The payment record keeps
the currency and amount actually paid.

## The bug this fixes

`plan_settlement` has two modes. Single mode converts and nets all balances into
one currency and can produce a row whose debt spans several currencies (bob owes
500 TWD + $50, shown as one "2000 TWD" row). Per-currency mode settles each
currency alone. A payment row stores one currency. Recording a netted row as a
single TWD payment made the engine apply the whole amount to the TWD bucket, so
per-currency showed an overpaid TWD and an untouched USD debt. The modes
disagreed.

## Model

A payment keeps what the user paid (`payments.amount_cents`, `currency`) and
records which currency debts it retires in `payment_allocations`. Payment
effects enter balances through allocations only.

- Per-currency remaining: `R_c = B_c + A_c` (balances plus allocation effects),
  exact integers.
- Single-mode remaining is derived: `convert_to_base(R)` then converted to the
  display currency. One source, two projections, so the modes cannot disagree.
- `proposed_settlement` amounts and `settle_debts()` are unchanged.

## Behaviour

- A **Settle** row has a pre-filled, editable amount (the pair's outstanding
  debt) and records a payment on click.
- A debt cleared is marked **Settled** and loses its button; a partly paid row
  reappears pre-filled with the remainder.
- A single-mode row that spans currencies: one Settle records the real payment
  and the client sends `allocations` splitting it across the debts it clears
  (greedy, in currency order). Both modes clear.
- A row that nets debt between two people who owe each other nothing directly in
  any one currency cannot be settled by one payment. It renders the note
  "This is a net across people, not one debt." and a **Settle per currency**
  button that switches to per-currency mode. This is the only case a one-tap
  settle is withheld, and it is required for ledger correctness.
- Viewers get no button.

## Files

- `backend/schema.sql` — `payment_allocations` table.
- `backend/migrations/007_payment_allocations.py` — create + backfill existing
  payments to one own-currency allocation (idempotent).
- `backend/expense.py` — `_payment_allocations_by_currency`,
  `normalize_allocations`, `_pair_parts` over `R`; single-mode remaining
  derived from `R`; rate validation.
- `backend/blueprints/expenses.py` — POST/PATCH accept optional `allocations`;
  responses and `list_payments` return them; input and rate guards.
- `frontend/static/js/settlement.js` — Settle row, `computeAllocations`,
  `makeValueInDisplay`, `rowSettleMode`; `isTransferSettled`,
  `outstandingTransferCents`.
- `frontend/tests/settlement.test.mjs`, `tests/backend/test_expenses.py`,
  `tests/e2e/test_expenses.py`.

## Money and validation rules

- Allocations are stored in each debt currency's minor units, so later rate
  changes cannot move them.
- `normalize_allocations` values the list in the payment currency via the saved
  rates and folds a positive residual into an own-currency allocation.
  `residual < 0` (allocations exceed the payment) is rejected 400.
- Rate changes: `set_rates` rejects `<= 0`, NaN, and inf with 400. A
  non-positive rate would otherwise make the value bound vacuous (mint debt) or
  divide by zero.
- Bounds: `bool` amounts are rejected; allocation lists are capped; amounts are
  capped. PATCH field parsing is wrapped so bad input returns 400, not 500.

## Accepted limitations

- A currency with no saved rate is excluded from single-mode remaining but
  visible in per-currency mode; it is reported in `missing_currencies`. This
  matches the existing missing-rate handling.
- A PATCH that changes a payment's amount or currency without sending
  `allocations` resets to one own-currency allocation. Intentional; the Edit
  form does not carry the split.
- Concurrency is not addressed: another tab can see a stale row until refresh;
  settlement is not wired to SSE.
- The settled badge is per person, not per pair. A debtor with two creditors
  sees a cleared row marked Settled while the other keeps its button.

## Verification

- Backend: `pytest tests/backend -c pytest.ini` -> 433 passed.
- Frontend: `bash frontend/tests/run.sh` -> 791 passed.
- End-to-end scenario (base TWD, TWD + USD expenses, settle from single mode):
  one payment stored as TWD 2000 with allocations TWD 500 + USD 50; single and
  per-currency remaining both empty.
- E2E browser suite not run on this host (no usable chromium).
