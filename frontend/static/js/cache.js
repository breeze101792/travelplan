const DB_NAME = 'travelplan-cache';
const DB_VERSION = 2;
const STORE = 'responses';

let _db = null;

function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('tags', 'tags', { multiEntry: true });
      } else {
        const tx = req.transaction;
        const store = tx.objectStore(STORE);
        if (!store.indexNames.contains('tags')) {
          store.createIndex('tags', 'tags', { multiEntry: true });
        }
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGet(key) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.get(key);
    return new Promise((resolve) => {
      req.onsuccess = () => {
        const entry = req.result;
        if (!entry) { resolve(null); return; }
        resolve(entry.data);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cacheGetMeta(key) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.get(key);
    return new Promise((resolve) => {
      req.onsuccess = () => {
        const entry = req.result;
        if (!entry) { resolve({ data: null, meta: null }); return; }
        resolve({ data: entry.data, meta: { updatedAt: entry.updatedAt, cachedAt: entry.cachedAt } });
      };
      req.onerror = () => resolve({ data: null, meta: null });
    });
  } catch {
    return { data: null, meta: null };
  }
}

/* Extract the latest updated_at from a response body across known shapes:
 *   { plan: { updated_at, ... } }
 *   { items: [{ updated_at, ... }, ...] }
 *   { expenses: [{ ... }] }  (no top-level updated_at on lists)
 *   { item: { updated_at, ... } }
 */
function extractUpdatedAt(data) {
  if (!data || typeof data !== 'object') return null;
  // Single entity responses
  if (data.plan && data.plan.updated_at) return data.plan.updated_at;
  if (data.item && data.item.updated_at) return data.item.updated_at;
  if (data.expense && data.expense.updated_at) return data.expense.updated_at;
  if (data.attachment && data.attachment.created_at) return data.attachment.created_at;
  // Collection responses: use the max updated_at among items
  if (data.items && Array.isArray(data.items)) {
    const max = data.items.reduce((latest, it) => {
      return it.updated_at && (!latest || it.updated_at > latest) ? it.updated_at : latest;
    }, null);
    if (max) return max;
  }
  if (data.expenses && Array.isArray(data.expenses)) {
    const max = data.expenses.reduce((latest, it) => {
      return it.updated_at && (!latest || it.updated_at > latest) ? it.updated_at : latest;
    }, null);
    if (max) return max;
  }
  return null;
}

export async function cacheSet(key, data, tags) {
  try {
    const updatedAt = extractUpdatedAt(data);
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put({ key, data, tags: tags || [], updatedAt, cachedAt: Date.now() });
  } catch {
    // non-fatal
  }
}

export async function cacheDel(key) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.delete(key);
  } catch {
    // non-fatal
  }
}

export async function cacheClear() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
  } catch {
    // non-fatal
  }
}

export async function cacheClearByTags(tags) {
  if (!tags || tags.length === 0) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    if (tags.includes('*')) {
      store.clear();
      return;
    }
    const index = store.index('tags');
    const seen = new Set();
    for (const tag of tags) {
      const req = index.openCursor(IDBKeyRange.only(tag));
      await new Promise((resolve, reject) => {
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            if (!seen.has(cursor.value.key)) {
              seen.add(cursor.value.key);
              cursor.delete();
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => reject(req.error);
      });
    }
  } catch {
    // non-fatal
  }
}
