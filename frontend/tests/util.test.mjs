/* util.test.mjs — unit tests for the small shared helpers in static/js/util.js.
 *
 * Run:  node --import ./register.mjs util.test.mjs   (from frontend/tests/)
 * or:   ./run.sh                                    (runs everything)
 *
 * Focused on `fmtDate` because the server-side `fmt_date` and the client
 * `fmtDate` are now both used to render the same string (the per-plan
 * header). If the two ever drift, the user sees a "flash" of one format
 * replaced by another on first paint. These tests lock the client side in.
 */
import { eq, summary } from './lib/t.mjs';
import { fmtDate } from '/static/js/util.js';

/* ---- fmtDate: matches the server's Mon DD, YYYY format ---- */
{
  // Sanity: basic dates format the way the header expects.
  eq(fmtDate('2026-07-01'), 'Jul 1, 2026',  'fmtDate: July 1');
  eq(fmtDate('2026-01-09'), 'Jan 9, 2026',  'fmtDate: Jan 9 (no leading zero)');
  eq(fmtDate('2026-12-31'), 'Dec 31, 2026', 'fmtDate: Dec 31');

  // Tolerant of falsy input.
  eq(fmtDate(''),    '', 'fmtDate: empty string -> empty');
  eq(fmtDate(null),  '', 'fmtDate: null -> empty');
  eq(fmtDate(undefined), '', 'fmtDate: undefined -> empty');

  // Tolerant of garbage.
  eq(fmtDate('not-a-date'), '', 'fmtDate: garbage -> empty');
  eq(fmtDate('2026-13-01'), '', 'fmtDate: month 13 -> empty');
  eq(fmtDate('2026-00-15'), '', 'fmtDate: month 0 -> empty');
}

/* ---- fmtDate: timezone-independent ---- */
// The OLD implementation used `new Date(iso)` which parses YYYY-MM-DD
// as UTC midnight, so a US user (or any negative-offset timezone)
// would see "Sep 9, 2026" for the "2026-09-10" date (one day behind).
// The NEW implementation parses the components directly, so the output
// is the same regardless of the browser's timezone. The server's
// fmt_date() also parses as a local date, so the two stay in sync.
//
// The test asserts the output matches what the *server* produces
// (year-month-day components, untouched). The old `new Date(iso)`
// approach would produce the wrong day in any negative-offset TZ.
{
  // Run the same string the server would, and assert it comes out
  // as the same day/month. The old code would silently shift to the
  // previous day in any negative-offset timezone.
  eq(fmtDate('2026-09-10'), 'Sep 10, 2026',
     'fmtDate: ISO date components are used verbatim (no UTC shift)');
  eq(fmtDate('2026-01-01'), 'Jan 1, 2026',
     'fmtDate: Jan 1 stays Jan 1 (not Dec 31 of prev year)');
  eq(fmtDate('2026-03-01'), 'Mar 1, 2026',
     'fmtDate: Mar 1 stays Mar 1 (not Feb 28/29)');
}

/* ---- fmtDate: matches Python backend.util.fmt_date() byte-for-byte ---- */
// These cases are also asserted on the Python side (`FmtDateTests` in
// test_plans.py). The point of duplicating them here is to catch a
// future change in *one* of the two implementations: the server test
// would still pass and the client test would still pass in isolation,
// but a header-render integration test would catch the desync.
{
  // Edge cases at month boundaries.
  eq(fmtDate('2026-01-01'), 'Jan 1, 2026',  'fmtDate: Jan 1');
  eq(fmtDate('2026-02-28'), 'Feb 28, 2026', 'fmtDate: Feb 28');
  eq(fmtDate('2026-03-01'), 'Mar 1, 2026',  'fmtDate: Mar 1');
  eq(fmtDate('2026-04-30'), 'Apr 30, 2026', 'fmtDate: Apr 30');
  eq(fmtDate('2026-12-31'), 'Dec 31, 2026', 'fmtDate: Dec 31');

  // Leap year.
  eq(fmtDate('2024-02-29'), 'Feb 29, 2024', 'fmtDate: leap day');
}

summary('util.test.mjs');
