/* page-utils.js — shared utilities for edit pages (board, timeline, map).
 *
 * Centralises patterns that are identical across the three edit views:
 *   - doSave() — unified save-then-refresh
 *   - showToast() — transient notification
 *   - closeContextMenu() — dismiss the right-click menu
 *   - isTypingTarget() — guard for keyboard shortcuts
 *   - onBeforeUnload() — prompt when there are pending changes
 */

import { el } from '/static/js/util.js';

/**
 * Save every pending staging op and then call onSaved.
 * Catches errors so the edit bar can read failedOpIndex/failedError.
 */
export async function doSave(staging, api, onSaved) {
  if (staging.saving) return;
  try {
    await staging.saveAll(api);
    if (onSaved) onSaved();
  } catch (e) {
    /* The edit bar picks up the failure from staging.failedOpIndex
     * the next time it is rendered (which happens via _notify). */
  }
}

/* ---------- toast ---------- */

let _toastsRoot = null;
let _toastsHost = null;
let _toastSeq = 0;

function toastsRoot() {
  const host = (typeof document !== 'undefined' && document.body) || null;
  if (_toastsRoot && _toastsHost === host && _toastsRoot.parentNode) return _toastsRoot;
  const root = el('div', { class: 'toast-stack', 'aria-live': 'polite' });
  if (host) host.appendChild(root);
  _toastsRoot = root;
  _toastsHost = host;
  return root;
}

/**
 * Show a transient toast (top-right, auto-dismiss after 3s).
 * @param {string} text  message body
 * @param {string} [kind]  optional CSS class suffix (e.g. 'warn', 'error')
 */
export function showToast(text, kind) {
  const id = ++_toastSeq;
  const node = el('div', {
    class: 'toast' + (kind ? ' toast-' + kind : ''),
    role: 'status',
    text,
  });
  toastsRoot().appendChild(node);
  setTimeout(() => { if (node.parentNode) node.remove(); }, 3000);
  return id;
}

/* ---------- context menu helpers ---------- */

/** Close a context menu popup, if one is open. */
export function closeContextMenu(contextMenuEl) {
  if (contextMenuEl) {
    if (contextMenuEl.remove) contextMenuEl.remove();
    else if (contextMenuEl.parentNode) contextMenuEl.parentNode.removeChild(contextMenuEl);
  }
  return null;
}

/**
 * Build and position a context-menu <ul> from a list of menu items.
 * Each item can have: label, shortcut, enabled, danger, sep, action.
 *
 * Returns the menu element (caller is responsible for appending it).
 */
export function buildContextMenu(items) {
  const menu = el('ul', { class: 'context-menu', role: 'menu' });
  for (const it of items) {
    if (it.sep) {
      menu.appendChild(el('li', { class: 'context-menu-sep' }));
      continue;
    }
    const li = el('li', {
      class: 'context-menu-item' + (it.danger ? ' is-danger' : ''),
      role: 'menuitem',
    });
    const btn = el('button', { type: 'button', text: it.label });
    btn.disabled = !it.enabled;
    btn.addEventListener('click', (e) => { e.stopPropagation(); it.action(); });
    li.appendChild(btn);
    if (it.shortcut) {
      li.appendChild(el('span', { class: 'context-menu-shortcut', text: it.shortcut }));
    }
    menu.appendChild(li);
  }
  return menu;
}

/** Clamp a position so the menu doesn't overflow the viewport. */
export function positionMenu(menu, x, y) {
  document.body.appendChild(menu);
  let rectW = 200, rectH = 200;
  try {
    const rect = menu.getBoundingClientRect();
    if (rect) { rectW = rect.width || rectW; rectH = rect.height || rectH; }
  } catch (e) { /* shim */ }
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
  const vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
  menu.style.left = Math.max(8, Math.min(x, vw - rectW - 8)) + 'px';
  menu.style.top  = Math.max(8, Math.min(y, vh - rectH - 8)) + 'px';
}

/* ---------- keyboard helpers ---------- */

/**
 * Return true if the event target is an input/textarea/select or
 * content-editable — keyboard shortcuts should be skipped in those cases.
 */
export function isTypingTarget(t) {
  if (!t) return false;
  const tag = (t.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  if (t.matches) return t.matches('input, textarea, select, [contenteditable]');
  return false;
}

/**
 * beforeunload handler — prompts the user if there are pending changes.
 */
export function onBeforeUnload(staging, e) {
  if (staging && staging.hasPending) {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
}

/**
 * Build a stable session id for batched ops (drag, paste, delete) so a
 * single Cancel discards them together. The format matches the
 * convention used by the editor (`sess-` + base36 timestamp + random).
 * Exported here because both itinerary.js (onMove) and timeline.js
 * (multi-drag, paste) need it, and the multi-select module keeps its
 * own copy for internal use. If you're tempted to make a third copy,
 * use this one instead.
 */
export function batchSessionId() {
  return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
