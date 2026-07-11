// api.js — shared fetch wrapper for the TravelPlan JSON API.
// All functions return parsed JSON on success and throw Error(message) on non-2xx.
// On 401, the user is redirected to the login page with a `next` parameter.

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
      // Throw so callers stop executing; redirect is in flight.
      throw new Error('unauthorized');
    }
    const msg = (body && body.error) || (typeof body === 'string' && body) || 'request failed';
    throw new Error(msg);
  }
  return body;
}

export async function apiGet(path) {
  const res = await fetch(path, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  return handle(res);
}

export async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body == null ? null : JSON.stringify(body),
  });
  return handle(res);
}

export async function apiPatch(path, body) {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body == null ? null : JSON.stringify(body),
  });
  return handle(res);
}

export async function apiDel(path) {
  const res = await fetch(path, {
    method: 'DELETE',
    headers: { 'Accept': 'application/json' },
  });
  return handle(res);
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