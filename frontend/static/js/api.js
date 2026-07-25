// api.js — shared fetch wrapper for the TravelPlan JSON API.
// GET responses are cached in IndexedDB so pages work offline.
// Mutations (POST/PATCH/DELETE) clear the cache on success.
import { cacheGet, cacheSet, cacheClear } from '/static/js/cache.js';

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
    const msg = (body && body.error) || (typeof body === 'string' && body) || 'request failed';
    throw new Error(msg);
  }
  return body;
}

export async function apiGet(path) {
  const cached = await cacheGet(path);
  if (cached !== null) {
    fetch(path, { method: 'GET', headers: { 'Accept': 'application/json' } })
      .then(res => { if (res.ok) return res.json().then(data => cacheSet(path, data)); })
      .catch(() => {});
    return cached;
  }
  const res = await fetch(path, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  const body = await handle(res);
  cacheSet(path, body);
  return body;
}

export async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body == null ? null : JSON.stringify(body),
  });
  const result = await handle(res);
  cacheClear();
  return result;
}

export async function apiPatch(path, body) {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body == null ? null : JSON.stringify(body),
  });
  const result = await handle(res);
  cacheClear();
  return result;
}

export async function apiDel(path) {
  const res = await fetch(path, {
    method: 'DELETE',
    headers: { 'Accept': 'application/json' },
  });
  const result = await handle(res);
  cacheClear();
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
  return handle(res);
}