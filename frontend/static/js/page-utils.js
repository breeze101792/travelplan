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

/* ---------- grab-to-scroll (click-and-drag to pan) ---------- */

/**
 * Enable click-and-drag horizontal scrolling on a container.
 * The user can grab empty space and drag to pan — works like Figma,
 * Trello, or Google Maps.
 *
 * - Skips interactive elements (buttons, links, inputs, draggable items).
 * - Starts only after a 5px threshold to avoid interfering with clicks.
 * - Suppresses the click event that would otherwise fire after a drag.
 */
export function enableGrabScroll(container) {
  let state = null;

  container.addEventListener('mousedown', (down) => {
    if (down.button !== 0) return;
    if (down.target.closest('button, a, input, select, textarea, [draggable], .tl-item, .card.item, .day-header, .add-summary')) return;

    state = {
      startX: down.clientX,
      startY: down.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      moved: false,
    };

    const onMove = (move) => {
      if (!state) return;
      const dx = move.clientX - state.startX;
      const dy = move.clientY - state.startY;
      if (!state.moved) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        state.moved = true;
        container.style.cursor = 'grabbing';
        container.style.userSelect = 'none';
        // Prevent text selection and other browser defaults during drag.
        document.body.style.pointerEvents = 'none';
      }
      container.scrollLeft = state.scrollLeft - dx;
      container.scrollTop = state.scrollTop - dy;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (state && state.moved) {
        container.style.cursor = '';
        container.style.userSelect = '';
        document.body.style.pointerEvents = '';
        // Suppress the click that would fire after a drag.
        const abort = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
        container.addEventListener('click', abort, { capture: true, once: true });
      }
      state = null;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/* ---------- body scroll lock for modals ----------
 *
 * A modal that's `position: fixed` doesn't actually stop the page
 * behind it from scrolling on iOS Safari — overscroll on the modal
 * content gets routed to the page (and the page's pull-to-refresh).
 * Two fixes work together:
 *   1. CSS `overscroll-behavior: contain` on the modal backdrop and
 *      body. (Added in base.css and item-editor.css.)
 *   2. While any modal is open, lock `<body>` scroll by setting
 *      `overflow: hidden` and remember the previous scrollY so we can
 *      restore it on close. (Locking prevents the page from being
 *      scrolled by a wheel/touch event that leaks through during the
 *      brief moment before the browser applies overscroll-behavior.)
 *
 * The count lets multiple modals stack: the first opens, the second
 * opens (count=2), the first closes (count=1, body stays locked), the
 * second closes (count=0, body unlocks). The body class
 * `has-open-modal` is what pulltorefresh.js and any other module
 * reads to decide "leave the page alone".
 */
let _modalCount = 0;
let _savedScrollY = 0;

export function lockBodyScroll() {
  if (typeof document === 'undefined') return;
  if (_modalCount === 0) {
    _savedScrollY = window.scrollY || 0;
    document.body.style.overflow = 'hidden';
    // Fixed-position elements (topbar, plan-nav) stay in place because
    // the page itself no longer scrolls; this also keeps the page's
    // scroll position frozen so closing the modal doesn't drop the
    // user back at the top.
  }
  _modalCount++;
  document.body.classList.add('has-open-modal');
}

export function unlockBodyScroll() {
  if (typeof document === 'undefined') return;
  if (_modalCount <= 0) {
    // Defensive: someone called unlock without a matching lock.
    // Don't go negative; just leave the class alone.
    return;
  }
  _modalCount--;
  if (_modalCount === 0) {
    document.body.classList.remove('has-open-modal');
    document.body.style.overflow = '';
    if (_savedScrollY && window.scrollTo) {
      // Restore the exact scroll position the user was at. The page
      // was frozen at _savedScrollY, so this is a no-op for most
      // browsers, but on some Android builds the locked scrollY can
      // drift during the modal's lifetime.
      window.scrollTo(0, _savedScrollY);
    }
    _savedScrollY = 0;
  }
}

/** Test helper / query — true if any modal is currently locking scroll. */
export function isBodyScrollLocked() {
  return _modalCount > 0;
}
