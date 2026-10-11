/* settlement.test.mjs — unit tests for the pure settlement-row helpers in
 * static/js/settlement.js that decide whether a proposed "who pays whom"
 * transfer is still outstanding, how much to pre-fill, and which per-currency
 * allocations a one-tap settlement payment should record.
 *
 * Run:  node --import ./register.mjs settlement.test.mjs   (from frontend/tests/)
 * or:   ./run.sh                                           (runs everything)
 *
 * The settled rule: a row from F to T is settled once the debtor no longer
 * owes the group (remaining[F] >= 0) or the creditor has nothing left to
 * receive (remaining[T] <= 0). `remaining` is the server's remaining_balances,
 * which already includes recorded payments. No tolerance is applied.
 */
import { eq, summary } from './lib/t.mjs';
import { isTransferSettled, outstandingTransferCents, rowSettleMode, computeAllocations } from '/static/js/settlement.js';

/* ---- isTransferSettled: no / partial / full / overpayment ---- */
{
  // No payment: debtor -1000, creditor +1000 -> still outstanding.
  eq(isTransferSettled(1, 2, { 1: -1000, 2: 1000 }), false,
     'settled: unpaid row is not settled');

  // Partial payment: debtor -400, creditor +400 -> still outstanding.
  eq(isTransferSettled(1, 2, { 1: -400, 2: 400 }), false,
     'settled: partially paid row is not settled');

  // Full payment: both fully cleared, absent from remaining_balances.
  eq(isTransferSettled(1, 2, {}), true,
     'settled: fully paid row is settled');

  // Full payment but the server still reports zero-valued entries.
  eq(isTransferSettled(1, 2, { 1: 0, 2: 0 }), true,
     'settled: zeroed balances are settled');

  // Overpayment: the debtor overpaid and is now a creditor, so the raw
  // proposal direction no longer represents a debt.
  eq(isTransferSettled(1, 2, { 1: 200, 2: -200 }), true,
     'settled: overpaid row is settled (direction flipped)');
}

/* ---- isTransferSettled: one debtor with two creditors ---- */
{
  // Debtor 1 owes 1000 total: 400 to 2 and 600 to 3.
  const after = { 1: -1000, 2: 400, 3: 600 };
  eq(isTransferSettled(1, 2, after), false, 'settled: uncleared creditor 2');
  eq(isTransferSettled(1, 3, after), false, 'settled: uncleared creditor 3');

  // Creditor 2 is cleared; the debtor still owes creditor 3.
  const partial = { 1: -600, 2: 0, 3: 600 };
  eq(isTransferSettled(1, 2, partial), true,
     'settled: cleared creditor row is settled while another remains');
  eq(isTransferSettled(1, 3, partial), false,
     'settled: remaining creditor row stays outstanding');
}

/* ---- outstandingTransferCents ---- */
{
  eq(outstandingTransferCents(1, 2, { 1: -1000, 2: 1000 }), 1000,
     'outstanding: full amount');
  eq(outstandingTransferCents(1, 2, { 1: -400, 2: 400 }), 400,
     'outstanding: partial amount');
  eq(outstandingTransferCents(1, 2, {}), 0,
     'outstanding: cleared -> 0');
  eq(outstandingTransferCents(1, 2, { 1: 200, 2: -200 }), 0,
     'outstanding: overpaid -> 0, never negative');

  // The debtor owes less than this creditor is owed overall, so the pair is
  // capped by the debtor's debt (min of the two magnitudes).
  eq(outstandingTransferCents(1, 2, { 1: -1000, 2: 3000 }), 1000,
     'outstanding: capped by the debtor debt');
}

/* ---- rowSettleMode: settled / per-currency-only / quick ----
 *
 * A row can be outstanding yet have no per-currency parts when the single-mode
 * netting pairs two people who owe each other in no single currency. Such a
 * row must not offer a one-tap Settle: it must route the user to per-currency
 * mode, because a payment with no allocations is defaulted by the server.
 */
{
  eq(rowSettleMode(true, []), 'settled',
     'mode: settled row is settled even with no parts');
  eq(rowSettleMode(false, []), 'per_currency_only',
     'mode: outstanding row with no parts is per-currency only');
  eq(rowSettleMode(false, [{ currency: 'USD', amount_cents: 1000 }]), 'quick',
     'mode: outstanding row with a part is quick');
}

/* ---- computeAllocations: which per-currency debts a payment settles ----
 *
 * Stub valueInDisplay models a display currency of TWD where 1 USD = 30 TWD
 * and 1 TWD = 1 TWD. It returns display minor units for an amount in a
 * part's own minor units; unknown currencies return Infinity (missing rate).
 */
const RATE_USD_TWD = 30;
const DISPLAY_DEC = 2;
function valueInDisplay(currency, amountCents, decimals) {
  if (currency === 'TWD') return amountCents;
  if (currency === 'USD') {
    const dec = decimals != null ? decimals : 2;
    return Math.round(amountCents * RATE_USD_TWD * (10 ** DISPLAY_DEC) / (10 ** dec));
  }
  return Infinity;
}

{
  // No per-currency breakdown -> let the server default (payment currency).
  eq(JSON.stringify(computeAllocations([], 100000, valueInDisplay)), '[]',
     'allocations: empty parts -> []');

  // One part already in the display currency -> server default is exact.
  eq(JSON.stringify(computeAllocations(
      [{ currency: 'TWD', amount_cents: 5000, decimals: 2 }],
      5000, valueInDisplay)), '[]',
     'allocations: single part in the display currency -> []');
}

{
  // Mixed parts fully covered by the paid amount -> every part allocated.
  const parts = [
    { currency: 'TWD', amount_cents: 5000, decimals: 2 },
    { currency: 'USD', amount_cents: 5000, decimals: 2 },
  ];
  // TWD 50.00 + USD 50.00 (= TWD 1500.00); paid TWD 2000.00 covers both.
  eq(JSON.stringify(computeAllocations(parts, 200000, valueInDisplay)),
     JSON.stringify([
       { currency: 'TWD', amount_cents: 5000 },
       { currency: 'USD', amount_cents: 5000 },
     ]),
     'allocations: mixed parts fully covered -> all parts');
}

{
  // Mixed parts with a smaller paid amount -> greedy: first part full, second
  // partial computed by proportion. Paid TWD 1000.00; TWD 50.00 full leaves
  // TWD 950.00, which buys round(5000 * 95000 / 150000) = 3167 USD cents.
  const parts = [
    { currency: 'TWD', amount_cents: 5000, decimals: 2 },
    { currency: 'USD', amount_cents: 5000, decimals: 2 },
  ];
  eq(JSON.stringify(computeAllocations(parts, 100000, valueInDisplay)),
     JSON.stringify([
       { currency: 'TWD', amount_cents: 5000 },
       { currency: 'USD', amount_cents: 3167 },
     ]),
     'allocations: smaller paid amount -> first full, second partial');
}

{
  // A part whose full value exceeds the remaining budget is not over-allocated.
  const parts = [{ currency: 'USD', amount_cents: 5000, decimals: 2 }];
  const out = computeAllocations(parts, 1000, valueInDisplay);
  eq(JSON.stringify(out), JSON.stringify([{ currency: 'USD', amount_cents: 33 }]),
     'allocations: over-budget part gets a partial, not the full amount');
  eq(out[0].amount_cents <= parts[0].amount_cents, true,
     'allocations: partial never exceeds the part');
}

{
  // A currency with a missing rate (Infinity) is skipped, not thrown on, and
  // the remaining budget still settles the valued currency.
  const parts = [
    { currency: 'EUR', amount_cents: 1000, decimals: 2 },
    { currency: 'TWD', amount_cents: 5000, decimals: 2 },
  ];
  let out;
  try { out = computeAllocations(parts, 100000, valueInDisplay); }
  catch (e) { out = 'threw: ' + e.message; }
  eq(JSON.stringify(out), JSON.stringify([{ currency: 'TWD', amount_cents: 5000 }]),
     'allocations: missing rate currency is skipped safely');
}

summary('settlement.test.mjs');
