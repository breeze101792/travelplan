/* plan-store.test.mjs — unit tests for the shared data singleton.
 *
 * Run:  node --import ./register.mjs plan-store.test.mjs   (from frontend/tests/)
 *
 * Covers fetch, subscribe, refresh, and reset of the PlanStore against a
 * fake API so no IndexedDB or server is needed.
 */
import { assert, eq, summary } from './lib/t.mjs';
import { installFetch } from './lib/fetch-stub.mjs';
import {
  fetchPlan, getState, getPlanId, subscribe, refresh, reset,
} from '/static/js/plan-store.js';

const PLAN = { id: 1, title: 'Japan 2026', start_date: '2026-09-10', end_date: '2026-09-13', updated_at: '2026-07-01T10:00:00' };
const ITEMS = [
  { id: 10, title: 'Hotel A', item_date: '2026-09-10', updated_at: '2026-07-01T10:00:00' },
  { id: 11, title: 'Activity', item_date: '2026-09-11', updated_at: '2026-07-01T10:00:00' },
];
const OWNER = { id: 1, username: 'admin', display_name: 'Admin', role: 'owner' };
const MEMBERS = [];
const EXP_BY_ITEM = [];
const SETTINGS = { base_currency: 'JPY' };

function makeRoutes() {
  let callCount = 0;
  return [
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: { ...PLAN }, role: 'owner' })],
    ['GET /api/plans/1/items', () => ({ items: ITEMS })],
    ['GET /api/plans/1/members', () => ({ owner: OWNER, members: MEMBERS })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: EXP_BY_ITEM })],
    ['GET /api/plans/2', () => ({ plan: { ...PLAN, id: 2, title: 'Paris 2026' }, role: 'viewer' })],
    ['GET /api/plans/2/items', () => ({ items: [] })],
    ['GET /api/plans/2/members', () => ({ owner: OWNER, members: MEMBERS })],
    ['GET /api/plans/2/expenses/by-item', () => ({ items: [] })],
  ];
}

// ---------- tests ----------

{
  const { restore } = installFetch(makeRoutes());

  // Initial state before any fetch
  const s0 = getState();
  eq(s0.status, 'idle', 'initial status is idle');
  eq(s0.plan, null, 'initial plan is null');

  // fetchPlan loads all data
  await fetchPlan(1);
  const s1 = getState();
  eq(s1.status, 'ready', 'status is ready after fetch');
  eq(s1.plan.title, 'Japan 2026', 'plan title loaded');
  eq(s1.items.length, 2, 'items loaded');
  eq(s1.items[0].id, 10, 'first item id');
  eq(s1.members.length, 1, 'owner present in members');
  eq(s1.members[0].role, 'owner', 'member role is owner');
  eq(getPlanId(), 1, 'planId is set');

  restore();
}

{
  const { restore, calls } = installFetch(makeRoutes());

  // fetchPlan is deduped — only one batch of API calls
  reset();
  const p1 = fetchPlan(1);
  const p2 = fetchPlan(1);
  await Promise.all([p1, p2]);
  const itemsCalls = calls.filter(c => c.url.endsWith('/1/items'));
  eq(itemsCalls.length, 1, 'items fetched only once despite 2 calls');
  restore();
}

{
  const { restore } = installFetch(makeRoutes());
  reset();

  // subscribe fires on state change
  let notified = [];
  const unsub = subscribe((s) => { notified.push(s.status); });
  await fetchPlan(1);
  eq(notified.includes('loading'), true, 'subscribe fired for loading');
  eq(notified.includes('ready'), true, 'subscribe fired for ready');
  eq(notified.length >= 2, true, 'at least 2 notifications');

  // unsubscribe stops notifications
  notified = [];
  unsub();
  reset();
  eq(notified.length, 0, 'no notifications after unsubscribe');

  restore();
}

{
  const { restore, calls } = installFetch(makeRoutes());
  reset();

  // refresh re-fetches specific data
  await fetchPlan(1);
  const before = calls.length;
  await refresh(['item']);
  const after = calls.length;
  eq(after > before, true, 'refresh made additional API calls');

  restore();
}

{
  const { restore } = installFetch(makeRoutes());
  reset();

  // Switching plans loads new data
  await fetchPlan(1);
  eq(getPlanId(), 1, 'first plan is 1');
  eq(getState().plan.title, 'Japan 2026', 'first plan data');

  await fetchPlan(2);
  eq(getPlanId(), 2, 'switched to plan 2');
  eq(getState().plan.title, 'Paris 2026', 'second plan data');

  restore();
}

{
  const { restore } = installFetch(makeRoutes());
  reset();

  // reset clears state
  await fetchPlan(1);
  eq(getState().status, 'ready', 'state was ready');
  reset();
  eq(getState().status, 'idle', 'state is idle after reset');
  eq(getState().plan, null, 'plan is null after reset');
  eq(getPlanId(), null, 'planId is null after reset');

  restore();
}

summary('plan-store');