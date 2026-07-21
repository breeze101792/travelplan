/* fetch-stub.mjs — installs a route-table fetch replacement so page modules
 * can run their real API layer (api.js) without a server.
 *
 *   import { installFetch } from './lib/fetch-stub.mjs';
 *   const { calls, restore } = installFetch([
 *     ['GET  /api/plans/1',          () => ({ plan: PLAN })],
 *     ['POST /api/plans/:id/items',  (body, params) => ({ item: {...body, id: 7} })],
 *   ]);
 *   ...
 *   restore();
 *
 * Patterns are "METHOD /path/with/:params". Handlers receive the parsed JSON
 * body (or the raw FormData for uploads) and the path params. Every call is
 * recorded in `calls` as { method, url, body }.
 */

function compile(pattern) {
  const names = [];
  const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => {
    names.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  return { rx, names };
}

function parseBody(body) {
  if (body == null) return {};
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
  return body; // FormData or other
}

export function installFetch(routes) {
  const table = routes.map(([pattern, handler]) => {
    const sp = pattern.indexOf(' ');
    const method = pattern.slice(0, sp).toUpperCase();
    const { rx, names } = compile(pattern.slice(sp + 1));
    return { method, rx, names, handler };
  });
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ method, url, body: opts.body });
    for (const r of table) {
      if (r.method !== method) continue;
      const m = r.rx.exec(url);
      if (!m) continue;
      const params = {};
      r.names.forEach((n, i) => { params[n] = m[i + 1]; });
      const data = await r.handler(parseBody(opts.body), params, calls);
      return jsonResponse(data);
    }
    return notFound(url);
  };
  return { calls, restore() { globalThis.fetch = orig; } };
}

function jsonResponse(data) {
  return {
    ok: true, status: 200,
    headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function notFound(url) {
  return {
    ok: false, status: 404,
    headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
    json: async () => ({ error: `no stub route for ${url}` }),
    text: async () => `no stub route for ${url}`,
  };
}
