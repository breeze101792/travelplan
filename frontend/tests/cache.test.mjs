/* cache.test.mjs — unit tests for the IndexedDB cache layer.
 *
 * Run:  node --import ./register.mjs cache.test.mjs   (from frontend/tests/)
 *
 * Tests cacheGetMeta, cacheClearByTags, and extractUpdatedAt logic.
 * Uses a fake IndexedDB (the dom-shim provides one) so no real browser needed.
 */
import { assert, eq, summary } from './lib/t.mjs';
import { installDom } from './lib/dom-shim.mjs';
import { installIDB } from './lib/idb-shim.mjs';
import {
  cacheGet, cacheGetMeta, cacheSet, cacheClearByTags, cacheClear,
} from '/static/js/cache.js';

installDom({});
installIDB();

// ---------- cacheSet / cacheGet with tags ----------

{
  await cacheSet('/api/plans/1', { plan: { id: 1, title: 'Test' } }, ['plan']);
  const data = await cacheGet('/api/plans/1');
  eq(data.plan.title, 'Test', 'cacheSet + cacheGet round-trip');
}

{
  await cacheSet('/api/plans/1/items', { items: [{ id: 10 }] }, ['item']);
  const data = await cacheGet('/api/plans/1/items');
  eq(data.items[0].id, 10, 'items cached with item tag');
}

// ---------- cacheGetMeta ----------

{
  await cacheSet('/api/plans/2', { plan: { id: 2, updated_at: '2026-07-01T10:00:00' } }, ['plan']);
  const { data, meta } = await cacheGetMeta('/api/plans/2');
  eq(data.plan.id, 2, 'cacheGetMeta returns data');
  eq(meta.updatedAt, '2026-07-01T10:00:00', 'cacheGetMeta returns updatedAt');
  eq(typeof meta.cachedAt, 'number', 'cacheGetMeta returns cachedAt timestamp');
}

{
  const { data, meta } = await cacheGetMeta('/api/nonexistent');
  eq(data, null, 'cacheGetMeta returns null data for missing key');
  eq(meta, null, 'cacheGetMeta returns null meta for missing key');
}

// ---------- cacheClearByTags ----------

{
  // Store entries with different tags
  await cacheSet('/api/plans/3', { plan: { id: 3 } }, ['plan']);
  await cacheSet('/api/plans/3/items', { items: [] }, ['item']);
  await cacheSet('/api/plans/3/members', { owner: { id: 1 } }, ['member']);

  // Clear only item-tagged entries
  await cacheClearByTags(['item']);

  const plan = await cacheGet('/api/plans/3');
  eq(plan.plan.id, 3, 'plan entry survives after item clear');

  const items = await cacheGet('/api/plans/3/items');
  eq(items, null, 'item entry cleared by tag');

  const members = await cacheGet('/api/plans/3/members');
  eq(members.owner.id, 1, 'member entry survives after item clear');
}

{
  // Clear multiple tags at once
  await cacheSet('/api/plans/4', { plan: { id: 4 } }, ['plan']);
  await cacheSet('/api/plans/4/items', { items: [] }, ['item']);
  await cacheSet('/api/plans/4/members', { owner: { id: 1 } }, ['member']);

  await cacheClearByTags(['plan', 'member']);

  eq(await cacheGet('/api/plans/4'), null, 'plan cleared by tag');
  eq(await cacheGet('/api/plans/4/members'), null, 'member cleared by tag');
  eq((await cacheGet('/api/plans/4/items')).items.length, 0, 'item survives');
}

// ---------- cacheClearByTags with wildcard ----------

{
  await cacheSet('/api/plans/5', { plan: { id: 5 } }, ['plan']);
  await cacheSet('/api/plans/5/items', { items: [] }, ['item']);

  await cacheClearByTags(['*']);

  eq(await cacheGet('/api/plans/5'), null, 'wildcard clears plan');
  eq(await cacheGet('/api/plans/5/items'), null, 'wildcard clears item');
}

// ---------- cacheClear (backward compat) ----------

{
  await cacheSet('/api/plans/6', { plan: { id: 6 } }, ['plan']);
  await cacheClear();
  eq(await cacheGet('/api/plans/6'), null, 'cacheClear still works');
}

// ---------- extractUpdatedAt via cacheSet ----------

{
  // Single entity with updated_at
  await cacheSet('/api/plans/7', { plan: { id: 7, updated_at: '2026-07-02T12:00:00' } }, ['plan']);
  const { meta } = await cacheGetMeta('/api/plans/7');
  eq(meta.updatedAt, '2026-07-02T12:00:00', 'extracts updated_at from plan response');
}

{
  // Collection with items that have updated_at
  await cacheSet('/api/plans/8/items', {
    items: [
      { id: 1, updated_at: '2026-07-01T10:00:00' },
      { id: 2, updated_at: '2026-07-02T12:00:00' },
    ]
  }, ['item']);
  const { meta } = await cacheGetMeta('/api/plans/8/items');
  eq(meta.updatedAt, '2026-07-02T12:00:00', 'extracts max updated_at from items list');
}

{
  // No updated_at in response
  await cacheSet('/api/settings', { base_currency: 'JPY' }, ['setting']);
  const { meta } = await cacheGetMeta('/api/settings');
  eq(meta.updatedAt, null, 'null updated_at when response has none');
}

summary('cache');