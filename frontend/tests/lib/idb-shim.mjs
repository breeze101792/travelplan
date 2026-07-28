/* idb-shim.mjs — minimal IndexedDB mock for Node tests.
 *
 * Supports the subset of IndexedDB used by cache.js:
 *   indexedDB.open(name, version)
 *   createObjectStore / createIndex (multiEntry)
 *   store.get / put / delete / clear / index / openCursor
 *   transaction(store, mode) -> objectStore(name)
 *
 * Does NOT support: getAll, count, compound keys, key ranges beyond IDBKeyRange.only.
 */
import { EventEmitter } from 'events';

class IDBRequest extends EventEmitter {
  constructor() {
    super();
    this.result = null;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
  _resolve(val) { this.result = val; if (this.onsuccess) this.onsuccess({ target: this }); }
  _reject(err) { this.error = err; if (this.onerror) this.onerror({ target: this }); }
}

class IDBCursor {
  constructor(store, key, matchingKeys, request) {
    this._store = store;
    this._key = key;
    this._matchingKeys = matchingKeys || [];
    this._idx = 0;
    this._request = request;
    this._done = this._matchingKeys.length === 0;
    this.value = this._done ? null : store._data.get(this._matchingKeys[0]);
    this.key = this._done ? null : this._matchingKeys[0];
  }
  continue() {
    this._idx++;
    if (this._idx >= this._matchingKeys.length) {
      this._request._resolve(null);
      return;
    }
    this._key = this._matchingKeys[this._idx];
    this.value = this._store._data.get(this._matchingKeys[this._idx]);
    this.key = this._matchingKeys[this._idx];
    this._request._resolve(this);
  }
  delete() {
    this._store._data.delete(this._key);
  }
}

class IDBIndex {
  constructor(store, name) {
    this._store = store;
    this._name = name;
  }
  openCursor(range) {
    const req = new IDBRequest();
    const entries = [...this._store._data.entries()];
    const matching = [];
    for (const [key, val] of entries) {
      const tags = val.tags || [];
      if (range) {
        if (tags.includes(range.lower)) matching.push(key);
      } else {
        matching.push(key);
      }
    }
    matching.sort();
    if (matching.length === 0) {
      setTimeout(() => req._resolve(null), 0);
    } else {
      const cursor = new IDBCursor(this._store, matching[0], matching, req);
      setTimeout(() => req._resolve(cursor), 0);
    }
    return req;
  }
}

class IDBObjectStore {
  constructor(name, data) {
    this._name = name;
    this._data = data;
    this._indexes = {};
  }
  createIndex(name, keyPath, opts) {
    const idx = new IDBIndex(this, name);
    this._indexes[name] = idx;
    return idx;
  }
  index(name) { return this._indexes[name]; }
  get indexNames() {
    const names = new Set(Object.keys(this._indexes));
    return { contains: (n) => names.has(n), has: (n) => names.has(n) };
  }
  get(key) {
    const req = new IDBRequest();
    const val = this._data.get(key);
    setTimeout(() => req._resolve(val !== undefined ? val : null), 0);
    return req;
  }
  put(val) {
    const req = new IDBRequest();
    this._data.set(val.key, val);
    setTimeout(() => req._resolve(val.key), 0);
    return req;
  }
  delete(key) {
    const req = new IDBRequest();
    this._data.delete(key);
    setTimeout(() => req._resolve(), 0);
    return req;
  }
  clear() {
    const req = new IDBRequest();
    this._data.clear();
    setTimeout(() => req._resolve(), 0);
    return req;
  }
}

class IDBTransaction {
  constructor(storeNames, mode, db) {
    this._mode = mode;
    this._db = db;
  }
  objectStore(name) {
    return this._db._stores[name] || new IDBObjectStore(name, this._db._data);
  }
}

class IDBDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this._names = new Set();
    this._data = new Map();
    this._stores = {};
  }
  get objectStoreNames() {
    return { contains: (n) => this._names.has(n), has: (n) => this._names.has(n), forEach: (fn) => this._names.forEach(fn) };
  }
  createObjectStore(name, opts) {
    this._names.add(name);
    const store = new IDBObjectStore(name, this._data);
    this._stores[name] = store;
    return store;
  }
  transaction(storeNames, mode) {
    return new IDBTransaction(storeNames, mode, this);
  }
  close() {}
}

class IDBFactory {
  constructor() {
    this._dbs = new Map();
  }
  open(name, version) {
    const req = new IDBRequest();
    let db = this._dbs.get(name);
    const isNew = !db;
    if (isNew) {
      db = new IDBDatabase(name, version);
      this._dbs.set(name, db);
    }
    setTimeout(() => {
      if (isNew && req.onupgradeneeded) {
        req.result = db;
        const tx = { objectStore: (n) => new IDBObjectStore(n, db._data) };
        req.onupgradeneeded({ target: { result: db, transaction: tx } });
      }
      req._resolve(db);
    }, 0);
    return req;
  }
}

export function installIDB() {
  if (globalThis.indexedDB) return;
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = { only: (v) => ({ lower: v, upper: v }) };
}