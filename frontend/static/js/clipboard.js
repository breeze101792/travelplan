/* clipboard.js — small sessionStorage-backed clipboard for the plan board.
 *
 * Used by the multi-select context menu and the ⌘X / ⌘C / ⌘V shortcuts.
 * The clipboard is per-tab (sessionStorage) — clearing the tab clears the
 * clipboard, navigating away keeps it. Survives navigating between the
 * board and the dashboard within the same tab.
 *
 * Payload shape (JSON-serializable, no file blobs):
 *   {
 *     action: 'cut' | 'copy',
 *     items: [
 *       { item_type, title, details, status, item_date, end_date, links: [...] }
 *     ]
 *   }
 *
 * We don't carry the original item ids in the payload (they may be local
 * "draft" ids that get remapped on save). Cut is tracked via `action` and
 * a server id map; the staging engine itself records the source ids in
 * the delete ops it stages.
 */
const KEY = 'tp.clipboard.v1';

/* Feature-detect sessionStorage. The dom-shim and older browsers may not
 * have it; in that case we fall back to an in-memory variable on
 * globalThis so the page still works (just doesn't persist across
 * navigations). */
const memStore = (typeof globalThis !== 'undefined') ? (globalThis.__tpClipboardMem ||= {}) : {};

function store() {
  if (typeof sessionStorage !== 'undefined') return sessionStorage;
  return {
    getItem(k) { return k in memStore ? memStore[k] : null; },
    setItem(k, v) { memStore[k] = String(v); },
    removeItem(k) { delete memStore[k]; },
  };
}

function read() {
  try {
    const raw = store().getItem(KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.items) || obj.items.length === 0) return null;
    return obj;
  } catch (e) {
    return null;
  }
}

function write(obj) {
  try {
    if (!obj) { store().removeItem(KEY); return; }
    store().setItem(KEY, JSON.stringify(obj));
  } catch (e) { /* ignore quota errors */ }
}

export function clipboardGet() { return read(); }

export function clipboardIsEmpty() { return !read(); }

/* Serialize an item into a portable clipboard entry. Image attachments
 * (kind='image') are dropped — they reference server files that don't
 * transfer with a copy. Link attachments are kept. Extra fields on the
 * source (e.g. a `_srcId` tag for cut) are kept verbatim so the consumer
 * can read them. */
export function serializeItem(item) {
  const out = {
    item_type: item.item_type,
    title: item.title,
    details: item.details ? Object.assign({}, item.details) : {},
    status: item.status || 'planned',
    item_date: item.item_date || null,
    end_date: item.end_date || null,
    links: (item.attachments || [])
      .filter(a => a.kind === 'link')
      .map(a => ({ value: a.value, caption: a.caption || '' })),
  };
  if (item._srcId != null) out._srcId = item._srcId;
  return out;
}

export function clipboardSet({ items, action }) {
  if (!items || !items.length) { write(null); return; }
  write({ action: action || 'copy', items: items.map(serializeItem) });
}

export function clipboardClear() { write(null); }
