// plan-store.js — shared singleton that owns all plan data across views.
// Pages import this module; the same instance is reused within a page load.
// Coordinates via api.js's cache layer and background refresh notifications.

import { apiGet, onDataRefreshed } from '/static/js/api.js';

let _instance = null;
let _subscribers = new Set();
let _planId = null;
let _state = {
  plan: null,
  items: null,
  members: null,
  expensesByItem: null,
  settings: null,
  status: 'idle',
};
let _fetchPromise = null;
let _eventSource = null;
let _pollTimer = null;

function notify() {
  for (const cb of _subscribers) cb(_state);
}

export function subscribe(cb) {
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}

export function getState() {
  return _state;
}

export function getPlanId() {
  return _planId;
}

function update(partial) {
  Object.assign(_state, partial);
  notify();
}

/* Fetch all data for a plan. Returns a promise that resolves once cached
 * data is available; background refreshes update the store asynchronously.
 * Multiple calls return the same promise (deduped). */
export async function fetchPlan(planId) {
  if (_planId === planId && _fetchPromise) return _fetchPromise;
  _planId = planId;
  update({ status: 'loading' });

  _fetchPromise = (async () => {
    try {
      const [settings, plan, items, members, expByItem] = await Promise.all([
        apiGet('/api/settings').catch(() => null),
        apiGet(`/api/plans/${planId}`).catch(() => null),
        apiGet(`/api/plans/${planId}/items`).catch(() => null),
        apiGet(`/api/plans/${planId}/members`).catch(() => null),
        apiGet(`/api/plans/${planId}/expenses/by-item`).catch(() => ({ items: [] })),
      ]);
      update({
        settings: settings || _state.settings,
        plan: plan ? plan.plan : _state.plan,
        items: items ? items.items : _state.items,
        members: members ? [members.owner, ...(members.members || [])] : _state.members,
        expensesByItem: expByItem ? expByItem.items || [] : _state.expensesByItem,
        status: 'ready',
        error: null,
      });
      connectSSE(planId);
    } catch (e) {
      update({ status: 'error', error: e.message });
    }
  })();

  return _fetchPromise;
}

/* Map SSE event types to entity tags for selective refresh. */
function tagsForEvent(event) {
  const t = event.type || '';
  if (t.startsWith('plan.')) return ['plan'];
  if (t.startsWith('item.')) return ['item'];
  if (t.startsWith('expense.')) return ['expense'];
  if (t.startsWith('member.')) return ['member'];
  if (t.startsWith('rate.')) return ['rate', 'expense'];
  return ['*'];
}

/* Connect to the SSE stream for the current plan. On receiving an event,
 * refresh the affected entity types in the background. */
function connectSSE(planId) {
  disconnectSSE();
  try {
    _eventSource = new EventSource(`/api/plans/${planId}/events`);
    _eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (_state.status === 'ready') {
          refresh(tagsForEvent(event));
        }
      } catch {
        // ignore malformed events
      }
    };
    _eventSource.onerror = () => {
      // SSE connection dropped — fall back to polling
      disconnectSSE();
      startPolling(planId);
    };
  } catch {
    // EventSource not supported — fall back to polling
    startPolling(planId);
  }
}

function disconnectSSE() {
  if (_eventSource) {
    _eventSource.close();
    _eventSource = null;
  }
}

/* Periodic polling fallback when SSE is unavailable. */
function startPolling(planId) {
  stopPolling();
  _pollTimer = setInterval(() => {
    if (_state.status === 'ready') {
      refresh(['plan', 'item', 'expense']);
    }
  }, 30000);
}

function stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

/* Re-fetch specific data types (by entity tag) in the background.
 * Used when the store knows its data may be stale. */
export async function refresh(tags) {
  if (!_planId) return;
  const fetches = [];
  if (!tags || tags.includes('plan')) fetches.push(
    apiGet(`/api/plans/${_planId}`, { forceRefresh: true }).then(r => {
      if (r) update({ plan: r.plan });
    }).catch(() => {})
  );
  if (!tags || tags.includes('item')) fetches.push(
    apiGet(`/api/plans/${_planId}/items`, { forceRefresh: true }).then(r => {
      if (r) update({ items: r.items });
    }).catch(() => {})
  );
  if (!tags || tags.includes('member')) fetches.push(
    apiGet(`/api/plans/${_planId}/members`, { forceRefresh: true }).then(r => {
      if (r) update({ members: [r.owner, ...(r.members || [])] });
    }).catch(() => {})
  );
  if (!tags || tags.includes('expense')) fetches.push(
    apiGet(`/api/plans/${_planId}/expenses/by-item`, { forceRefresh: true }).then(r => {
      if (r) update({ expensesByItem: r.items || [] });
    }).catch(() => {})
  );
  await Promise.all(fetches);
}

/* Wire up background refresh detection from the api.js cache layer.
 * When a stale-while-revalidate fetch detects changed data, the store
 * re-fetches the affected entity types to stay current. */
onDataRefreshed((_path, tags) => {
  if (_state.status === 'ready') {
    refresh(tags);
  }
});

/* Reset to initial state — useful for tests or switching plans. */
export function reset() {
  disconnectSSE();
  stopPolling();
  _planId = null;
  _state = { plan: null, items: null, members: null, expensesByItem: null, settings: null, status: 'idle' };
  _fetchPromise = null;
  notify();
}