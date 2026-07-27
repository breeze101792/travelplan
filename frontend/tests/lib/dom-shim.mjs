/* dom-shim.mjs — a minimal DOM good enough to run the page modules
 * (itinerary.js, item-editor.js, plans.js…) under node. It implements only
 * what those modules actually use: element/text nodes, classList, dataset,
 * events, and a small querySelector engine ('#id', '.class', 'tag', and
 * 'ancestor descendant' selectors).
 *
 *   import { installDom } from './lib/dom-shim.mjs';
 *   const doc = installDom({ ids: ['board', 'pending-bar'] });
 *   // ...run the module...
 *   doc.getElementById('board').children.length
 *
 * installDom replaces globalThis.document / window / location and adds
 * URL.createObjectURL stubs. Call it again for a fresh page.
 */

class TextNode {
  constructor(t) { this.nodeType = 3; this._text = String(t); }
  get textContent() { return this._text; }
}

export class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    // dataset proxies to attrs['data-*'] so that setting
    // `node.dataset.userId = '1'` (a) makes `node.dataset.userId` return
    // '1' and (b) makes `node.getAttribute('data-user-id')` return '1',
    // matching the real DOM. Convert camelCase key to data-kebab-case.
    const self = this;
    this.dataset = new Proxy({}, {
      get(_t, key) {
        if (key === '_isDataset') return true;
        const attr = 'data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        return Object.prototype.hasOwnProperty.call(self.attrs, attr) ? self.attrs[attr] : undefined;
      },
      set(_t, key, value) {
        if (key === '_isDataset') return true;
        const attr = 'data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        self.attrs[attr] = String(value);
        return true;
      },
      has(_t, key) {
        if (key === '_isDataset') return true;
        const attr = 'data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        return Object.prototype.hasOwnProperty.call(self.attrs, attr);
      },
    });
    this.style = new Proxy({}, {
      set(t, k, v) { t[k] = String(v); return true; },
      get(t, k) {
        if (k === 'setProperty') return (n, v) => { t[n] = String(v); };
        if (k === 'removeProperty') return (n) => { delete t[n]; return ''; };
        return t[k];
      },
    });
    this.attrs = {};
    this._listeners = {};
    this._text = '';
    this.classList = {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, f) { (f === undefined ? !this._s.has(c) : f) ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    };
    // Common properties (so el() assigns them as props, not attributes).
    this.id = ''; this.className = ''; this.value = ''; this.type = '';
    this.checked = false; this.disabled = false; this.hidden = false;
    this.selected = false; this.placeholder = ''; this.href = '';
    this.target = ''; this.rel = ''; this.src = ''; this.alt = '';
    this.title = ''; this.loading = ''; this.draggable = false;
    this.accept = ''; this.step = ''; this.min = ''; this.max = '';
    this.rows = 0; this.cols = 0; this.htmlFor = '';
    this.offsetTop = 0; this.offsetHeight = 0;
    this.textContent = '';
  }
  get className() { return [...this.classList._s].join(' '); }
  set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._text; }
  appendChild(n) { this.children.push(n); n.parentNode = this; return n; }
  append(...ns) { for (const n of ns) this.appendChild(n && n.nodeType ? n : document.createTextNode(String(n))); }
  replaceChildren() { this.children = []; }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const l = this._listeners[t];
    if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  }
  dispatch(t, ev) {
    const e = Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, ev || {});
    for (const fn of (this._listeners[t] || [])) fn(e);
  }
  click() { this.dispatch('click', { target: this }); }
  focus() {}
  select() {}
  blur() { this.dispatch('blur', { target: this }); }
  querySelector(sel) { return find(this, sel)[0] || null; }
  querySelectorAll(sel) { return find(this, sel); }
  contains(n) { let p = n; while (p) { if (p === this) return true; p = p.parentNode; } return false; }
  closest(sel) { let p = this; while (p) { if (matches(p, sel)) return p; p = p.parentNode; } return null; }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  scrollTo() {}
  scrollIntoView() {}
}

function matchAttr(node, sel) {
  // Parse a (compound) selector into tag + any number of attribute groups.
  // Supports: [attr] [attr="v"] [attr='v'] [attr~=v] [attr|=v] [attr^=v]
  // [attr$=v] [attr*=v], and the same prefixed by a tag (e.g.
  // 'button[data-action="x"][data-user-id="1"]'). Returns null if the
  // string doesn't look like a tag+attrs compound.
  const m = sel.match(/^([a-zA-Z][a-zA-Z0-9]*)?((?:\[[^\]]+\])+)$/);
  if (!m) return null;
  const [, tagPart, attrsPart] = m;
  if (tagPart && node.tagName !== tagPart.toUpperCase()) return false;
  const attrRe = /\[([a-zA-Z0-9_-]+)(?:([~|^$*]?=)(?:"([^"]*)"|'([^']*)'))?\]/g;
  let am;
  while ((am = attrRe.exec(attrsPart)) !== null) {
    const attr = am[1];
    const op = am[2] || null;
    const expected = am[3] != null ? am[3] : (am[4] != null ? am[4] : null);
    const dsKey = attr.startsWith('data-')
      ? attr.slice(5).replace(/-(.)/g, (_, c) => c.toUpperCase())
      : attr.replace(/-(.)/g, (_, c) => c.toUpperCase());
    let actual;
    if (node.dataset && (dsKey in node.dataset)) actual = node.dataset[dsKey];
    else if (node.attrs && attr in node.attrs) actual = node.attrs[attr];
    let ok;
    if (op == null) ok = actual != null;
    else if (expected == null) ok = false;
    else if (op === '=') ok = actual === expected;
    else if (op === '^=') ok = typeof actual === 'string' && actual.startsWith(expected);
    else if (op === '$=') ok = typeof actual === 'string' && actual.endsWith(expected);
    else if (op === '*=') ok = typeof actual === 'string' && actual.includes(expected);
    else if (op === '~=') ok = typeof actual === 'string' && actual.split(/\s+/).includes(expected);
    else if (op === '|=') ok = typeof actual === 'string' && (actual === expected || actual.startsWith(expected + '-'));
    else ok = false;
    if (!ok) return false;
  }
  return true;
}

function matchSimple(node, sel) {
  // Attribute selector? delegate.
  if (sel.startsWith('[')) return matchAttr(node, sel);
  // Compound with tag + attribute (e.g. 'button[data-action="x"]').
  if (sel.includes('[')) {
    const r = matchAttr(node, sel);
    if (r != null) return r;
  }
  // Tag + class/id compounds.
  let rest = sel;
  let tag = null;
  const tagM = rest.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (tagM) { tag = tagM[0].toUpperCase(); rest = rest.slice(tagM[0].length); }
  if (tag && node.tagName !== tag) return false;
  for (const tok of rest.match(/[.#][^.#]+/g) || []) {
    if (tok.startsWith('#')) { if (node.id !== tok.slice(1)) return false; }
    else if (!node.classList || !node.classList.contains(tok.slice(1))) return false;
  }
  return !!tag || (rest.match(/[.#]/) != null) || sel.startsWith('.') || sel.startsWith('#');
}
function matchesParts(node, parts) {
  if (!node || node.nodeType !== 1) return false;
  if (!matchSimple(node, parts[parts.length - 1])) return false;
  if (parts.length === 1) return true;
  const rest = parts.slice(0, -1);
  let p = node.parentNode;
  while (p) { if (matchesParts(p, rest)) return true; p = p.parentNode; }
  return false;
}
function matches(node, sel) {
  return matchesParts(node, sel.trim().split(/\s+/));
}
function find(root, sel) {
  const out = [];
  (function walk(n) {
    for (const c of (n.children || [])) { if (matches(c, sel)) out.push(c); walk(c); }
  })(root);
  return out;
}

/**
 * Install a fresh fake page. `ids` are pre-created <div> elements the module
 * under test looks up (e.g. 'board', 'pending-bar', 'plan-title').
 * Returns the document shim.
 */
export function installDom({ ids = [] } = {}) {
  const documentShim = {
    body: null,
    _listeners: {},
    createElement: (t) => new El(t),
    createTextNode: (t) => new TextNode(t),
    getElementById(id) { return find(this.body, '#' + id)[0] || null; },
    querySelector(sel) { return this.body.querySelector(sel); },
    querySelectorAll(sel) { return this.body.querySelectorAll(sel); },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const l = this._listeners[t];
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    },
    dispatch(t, ev) {
      const e = Object.assign({ target: this.body, preventDefault() {}, stopPropagation() {} }, ev || {});
      for (const fn of (this._listeners[t] || [])) fn(e);
    },
  };
  documentShim.body = new El('body');
  for (const id of ids) {
    const n = new El('div'); n.id = id;
    documentShim.body.appendChild(n);
  }
  globalThis.document = documentShim;
  globalThis.window = {
    _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const l = this._listeners[t];
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    },
    dispatch(t, ev) {
      const e = Object.assign({ preventDefault() {} }, ev || {});
      for (const fn of (this._listeners[t] || [])) fn(e);
      return e;
    },
    matchMedia(q) {
      return { matches: false, media: q, addEventListener() {},
               removeEventListener() {}, addListener() {}, removeListener() {} };
    },
    innerWidth: 1024, innerHeight: 768,
  };
  globalThis.location = { href: 'http://test/plans/1', pathname: '/plans/1', search: '' };
  let blobN = 0;
  globalThis.URL.createObjectURL = () => `blob:mock-${++blobN}`;
  globalThis.URL.revokeObjectURL = () => {};
  // Minimal sessionStorage / matchMedia shims — plan-header.js reads
  // sessionStorage at module load (for the pinned-days map) and calls
  // matchMedia for the draggable-on-wide-screens check.
  const _store = {};
  globalThis.sessionStorage = {
    getItem: (k) => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: (k) => { delete _store[k]; },
    clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
  };
  globalThis.localStorage = globalThis.sessionStorage;
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });
  return documentShim;
}
