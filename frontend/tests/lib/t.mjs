/* t.mjs — minimal test harness shared by the frontend test fixtures.
 *
 *   import { assert, eq, summary } from './lib/t.mjs';
 *   assert(x === y, 'thing works');
 *   summary('staging');          // prints totals, exits 1 on any failure
 */
let _pass = 0, _fail = 0;

export function assert(cond, msg) {
  if (cond) { _pass++; console.log('  ok   ' + msg); }
  else { _fail++; console.error('  FAIL ' + msg); }
}

export function eq(a, b, msg) {
  assert(a === b, `${msg}  (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

export function summary(label) {
  console.log(`\n${label}: ${_pass} passed, ${_fail} failed`);
  if (_fail) process.exit(1);
}
