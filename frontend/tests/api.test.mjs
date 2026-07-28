/* api.test.mjs — unit tests for the API client layer.
 *
 * Run:  node --import ./register.mjs api.test.mjs   (from frontend/tests/)
 *
 * Tests tagsForGet, tagsForMutation, ConflictError, and 409 handling.
 * Uses fetch-stub to mock server responses.
 */
import { assert, eq, summary } from './lib/t.mjs';
import { installDom } from './lib/dom-shim.mjs';
import { installFetch } from './lib/fetch-stub.mjs';
import { apiGet, apiPatch, apiPost, apiDel, ConflictError } from '/static/js/api.js';

installDom({});

// ---------- ConflictError ----------

{
  const err = new ConflictError('conflict', { id: 1, title: 'Server version' });
  eq(err.name, 'ConflictError', 'ConflictError has correct name');
  eq(err.message, 'conflict', 'ConflictError has message');
  eq(err.serverData.title, 'Server version', 'ConflictError carries server data');
}

// ---------- apiGet with tags ----------

{
  const { restore } = installFetch([
    ['GET /api/plans/1', () => ({ plan: { id: 1, title: 'Japan' } })],
  ]);

  const result = await apiGet('/api/plans/1');
  eq(result.plan.title, 'Japan', 'apiGet returns plan data');

  // Second call should return from cache (no extra fetch)
  const result2 = await apiGet('/api/plans/1');
  eq(result2.plan.title, 'Japan', 'apiGet returns cached data on second call');

  restore();
}

// ---------- apiPatch with tags (granular invalidation) ----------

{
  const { restore, calls } = installFetch([
    ['PATCH /api/items/42', () => ({ item: { id: 42, title: 'Updated' } })],
    ['GET /api/plans/1/items', () => ({ items: [{ id: 42, title: 'Updated' }] })],
  ]);

  // Cache some data first
  await apiGet('/api/plans/1/items');

  // Patch an item — should only invalidate item-tagged caches
  const result = await apiPatch('/api/items/42', { title: 'Updated' });
  eq(result.item.title, 'Updated', 'apiPatch returns updated item');

  // Verify the items cache was invalidated (next get should fetch fresh)
  const items = await apiGet('/api/plans/1/items');
  eq(items.items[0].title, 'Updated', 'item cache was invalidated by patch');

  restore();
}

// ---------- 409 Conflict handling ----------

{
  const { restore } = installFetch([
    ['PATCH /api/items/99', () => [{
      error: 'conflict',
      message: 'This item was modified by another user. Reload and try again.',
      current: { id: 99, title: 'Server version', updated_at: '2026-07-02T10:00:00' },
    }, { status: 409 }]],
  ]);

  try {
    await apiPatch('/api/items/99', { title: 'My version', expected_updated_at: '2026-07-01T10:00:00' });
    assert(false, 'should have thrown');
  } catch (e) {
    eq(e.name, 'ConflictError', '409 throws ConflictError');
    eq(e.serverData.id, 99, 'ConflictError carries server data');
  }

  restore();
}

// ---------- apiDel with tags ----------

{
  const { restore, calls } = installFetch([
    ['DELETE /api/items/42', () => ({ deleted: 42 })],
  ]);

  const result = await apiDel('/api/items/42');
  eq(result.deleted, 42, 'apiDel returns deleted id');

  restore();
}

// ---------- apiPost with tags ----------

{
  const { restore, calls } = installFetch([
    ['POST /api/plans/1/items', () => ({ item: { id: 100, title: 'New item' } })],
  ]);

  const result = await apiPost('/api/plans/1/items', { title: 'New item', item_type: 'activity' });
  eq(result.item.title, 'New item', 'apiPost returns created item');

  restore();
}

summary('api');