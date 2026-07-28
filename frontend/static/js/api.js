// api.js — shared fetch wrapper for the TravelPlan JSON API.
// GET responses are cached in IndexedDB so pages work offline.
// Mutations (POST/PATCH/DELETE) invalidate only the cache entries whose
// entity tags match the affected entity type, rather than clearing the
// entire cache (see `tagsForGet` / `tagsForMutation` below).
import { cacheGet, cacheGetMeta, cacheSet, cacheClearByTags } from '/static/js/cache.js';

export class ConflictError extends Error {
  constructor(msg, serverData) {
    super(msg);
    this.name = 'ConflictError';
    this.serverData = serverData;
  }
}

/* Map a GET URL to the entity tags its data depends on. When a mutation
 * affects a given entity type, all cached GET entries tagged with that
 * type are invalidated. */
function tagsForGet(path) {
  if (path === '/api/settings') return ['setting'];
  if (/^\/api\/plans(\?\S*)?$/.test(path)) return ['plan'];
  if (/^\/api\/plans\/\d+$/.test(path)) return ['plan'];
  if (/\/items/.test(path) || /\/attachments/.test(path) || /\/upload/.test(path)) return ['item'];
  if (/\/expenses/.test(path) || /\/settlement/.test(path) || /\/payments/.test(path)) return ['expense'];
  if (/\/members/.test(path)) return ['member'];
  if (/\/rates/.test(path)) return ['rate', 'expense'];
  return [];
}

/* Infer entity tags affected by a mutation from the URL being mutated. */
function tagsForMutation(path) {
  if (/^\/api\/plans(\?\S*)?$/.test(path)) return ['plan'];
  if (/^\/api\/plans\/\d+$/.test(path)) return ['plan'];
  if (/\/transfer/.test(path)) return ['plan', 'member'];
  if (/^\/api\/items\/\d+/.test(path) || /^\/api\/attachments\/\d+/.test(path)) return ['item'];
  if (/^\/api\/expenses\/\d+/.test(path) || /^\/api\/payments\/\d+/.test(path)) return ['expense'];
  if (/\/items/.test(path) || /\/attachments/.test(path) || /\/upload/.test(path)) return ['item'];
  if (/\/expenses/.test(path) || /\/settlement/.test(path) || /\/payments/.test(path)) return ['expense'];
  if (/\/members/.test(path)) return ['member'];
  if (/\/rates/.test(path)) return ['rate', 'expense'];
  return ['*'];
}

/* Extract the latest updated_at from a response body. Mirrors the logic in
 * cache.js so the background refresh can detect changes. */
function extractUpdatedAtFrom(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.plan && data.plan.updated_at) return data.plan.updated_at;
  if (data.item && data.item.updated_at) return data.item.updated_at;
  if (data.expense && data.expense.updated_at) return data.expense.updated_at;
  return null;
}

function redirectLogin() {
  const next = encodeURIComponent(location.pathname + location.search);
  location.href = '/auth/login?next=' + next;
}

async function handle(res) {
  let body = null;
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    body = await res.json().catch(() => null);
  } else {
    body = await res.text().catch(() => null);
  }
  if (!res.ok) {
    if (res.status === 401) {
      redirectLogin();
      throw new Error('unauthorized');
    }
    if (res.status === 409 && body && body.error === 'conflict') {
      throw new ConflictError(body.message || 'conflict', body.current || null);
    }
    const msg = (body && body.error) || (typeof body === 'string' && body) || 'request failed';
    throw new Error(msg);
  }
  return body;
}

/* Subscribers notified when background refresh detects changed data.
 * Pages can register to show a "data updated" indicator. */
let _onDataRefreshed = null;
export function onDataRefreshed(cb) {
  _onDataRefreshed = cb;
}

export async function apiGet(path, { forceRefresh } = {}) {
  if (!forceRefresh) {
    const { data, meta } = await cacheGetMeta(path);
    if (data !== null) {
      fetch(path, { method: 'GET', headers: { 'Accept': 'application/json' } })
        .then(res => {
          if (!res.ok) return null;
          return res.json().then(fresh => {
            const tags = tagsForGet(path);
            cacheSet(path, fresh, tags);
            if (meta && meta.updatedAt) {
              const freshUpdatedAt = extractUpdatedAtFrom(fresh);
              if (freshUpdatedAt && freshUpdatedAt !== meta.updatedAt && _onDataRefreshed) {
                _onDataRefreshed(path, tags);
              }
            }
          });
        })
        .catch(() => {});
      return data;
    }
  }
  try {
    const res = await fetch(path, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    const body = await handle(res);
    cacheSet(path, body, tagsForGet(path));
    return body;
  } catch (e) {
    if (!forceRefresh) {
      const cached = await cacheGet(path);
      if (cached !== null) return cached;
    }
    return null;
  }
}

export async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body == null ? null : JSON.stringify(body),
  });
  const result = await handle(res);
  await cacheClearByTags(tagsForMutation(path));
  return result;
}

export async function apiPatch(path, body) {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body == null ? null : JSON.stringify(body),
  });
  const result = await handle(res);
  await cacheClearByTags(tagsForMutation(path));
  return result;
}

export async function apiDel(path) {
  const res = await fetch(path, {
    method: 'DELETE',
    headers: { 'Accept': 'application/json' },
  });
  const result = await handle(res);
  await cacheClearByTags(tagsForMutation(path));
  return result;
}

// Multipart upload: a single file under the 'file' field plus optional extra fields.
export async function apiUpload(path, file, extraFields = {}) {
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(extraFields)) {
    form.append(key, value);
  }
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Accept': 'application/json' },
    body: form,
  });
  const result = await handle(res);
  await cacheClearByTags(tagsForMutation(path));
  return result;
}