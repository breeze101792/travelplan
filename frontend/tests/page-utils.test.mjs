/* page-utils.test.mjs — tests for the shared page utilities
 * (lockBodyScroll / unlockBodyScroll / batchSessionId).
 *
 * The body scroll lock is used by every modal in the app (item editor,
 * expense form, geo popup, plan edit, etc.) to stop the underlying page
 * from scrolling when the user interacts with a modal on iOS — and to
 * signal the page's pull-to-refresh handler to stay quiet while a
 * modal is open. The contract is: multiple modals stack (count > 1),
 * the body only unlocks when the last one closes, and `has-open-modal`
 * is on the body classList throughout.
 */
import { assert, eq, summary } from './lib/t.mjs';

/* The page-utils module touches `document` and `window` at import time
 * (the lockBodyScroll / unlockBodyScroll counters live in module
 * scope). We need a DOM shim. */
import { installDom } from './lib/dom-shim.mjs';

let pageUtils;

async function loadPageUtils() {
  /* Dynamic import so the module's top-level body (which sets up the
   * counters) runs against our installed shim, not against whatever
   * Node's global state happens to be. */
  pageUtils = await import('/static/js/page-utils.js');
}

async function fresh() {
  installDom();
  await loadPageUtils();
  // Reset the counter to 0 (other tests in the same file may have left
  // it non-zero; lockBodyScroll treats the first call as saving
  // scrollY, so the order of calls within one test is what matters).
  while (pageUtils.isBodyScrollLocked()) pageUtils.unlockBodyScroll();
}

const TEST = async (name, fn) => {
  try {
    await fresh();
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}  ${e && e.message}`);
    throw e;
  }
};

(async () => {
  console.log('=== page-utils: body scroll lock');

  await TEST('initial state: not locked', () => {
    eq(pageUtils.isBodyScrollLocked(), false, 'starts unlocked');
    // The dom-shim returns undefined for unset style properties; a
    // real browser returns ''. We test for "is hidden set" via the
    // proxy's internal storage below instead.
    eq(document.body.classList.contains('has-open-modal'), false,
       'has-open-modal class not set');
  });

  await TEST('lockBodyScroll: locks body and sets class', () => {
    pageUtils.lockBodyScroll();
    eq(pageUtils.isBodyScrollLocked(), true, 'is locked');
    eq(document.body.style.overflow, 'hidden', 'body overflow is hidden');
    eq(document.body.classList.contains('has-open-modal'), true,
       'has-open-modal class is on body');
  });

  await TEST('lockBodyScroll: stacks; second lock keeps class on', () => {
    pageUtils.lockBodyScroll();
    pageUtils.lockBodyScroll();
    eq(pageUtils.isBodyScrollLocked(), true, 'still locked');
    eq(document.body.classList.contains('has-open-modal'), true,
       'class still on after second lock');
    eq(document.body.style.overflow, 'hidden', 'overflow still hidden');
  });

  await TEST('unlockBodyScroll: one of two leaves us still locked', () => {
    pageUtils.lockBodyScroll();
    pageUtils.lockBodyScroll();
    pageUtils.unlockBodyScroll();
    eq(pageUtils.isBodyScrollLocked(), true, 'still locked after one unlock');
    eq(document.body.classList.contains('has-open-modal'), true,
       'class still on');
  });

  await TEST('unlockBodyScroll: last one clears class and overflow', () => {
    pageUtils.lockBodyScroll();
    pageUtils.lockBodyScroll();
    pageUtils.unlockBodyScroll();
    pageUtils.unlockBodyScroll();
    eq(pageUtils.isBodyScrollLocked(), false, 'unlocked');
    eq(document.body.style.overflow, '', 'overflow restored to empty');
    eq(document.body.classList.contains('has-open-modal'), false,
       'class removed');
  });

  await TEST('unlockBodyScroll: extra call is a no-op (no negative count)', () => {
    // Defensive: if someone calls unlock without a matching lock, we
    // shouldn't go negative. The body class should stay correct.
    pageUtils.unlockBodyScroll();
    pageUtils.unlockBodyScroll();
    eq(pageUtils.isBodyScrollLocked(), false, 'still unlocked');
    eq(document.body.classList.contains('has-open-modal'), false,
       'class still not set');
  });

  await TEST('lock / unlock cycle restores the body to clean state', () => {
    pageUtils.lockBodyScroll();
    pageUtils.unlockBodyScroll();
    eq(document.body.style.overflow, '', 'overflow empty after cycle');
    eq(document.body.classList.contains('has-open-modal'), false,
       'class removed after cycle');
  });

  await TEST('lock / unlock / lock works on second cycle', () => {
    pageUtils.lockBodyScroll();
    pageUtils.unlockBodyScroll();
    pageUtils.lockBodyScroll();
    eq(pageUtils.isBodyScrollLocked(), true, 'second cycle locks');
    eq(document.body.style.overflow, 'hidden', 'overflow hidden again');
    pageUtils.unlockBodyScroll();
    eq(pageUtils.isBodyScrollLocked(), false, 'second cycle unlocks');
  });

  console.log('=== page-utils: batchSessionId');

  await TEST('batchSessionId: stable format and uniqueness', () => {
    const a = pageUtils.batchSessionId();
    const b = pageUtils.batchSessionId();
    assert(typeof a === 'string' && a.startsWith('sess-'),
           'session id starts with sess-');
    assert(a !== b, 'two consecutive ids differ');
    // Suffix after the second dash is a random base36 string (6 chars
    // from `Math.random().toString(36).slice(2, 8)`).
    const suffix = a.split('-')[2];
    eq(suffix.length, 6, 'random suffix is 6 chars');
  });

  summary('page-utils.test.mjs');
})().catch((e) => { console.error(e); process.exit(1); });
