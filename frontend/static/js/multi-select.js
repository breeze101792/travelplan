/* multi-select.js — shared multi-selection, clipboard, context menu,
 * and keyboard-shortcut logic for the board, timeline, and map pages.
 *
 * Usage:
 *   import { createMultiSelect } from '/static/js/multi-select.js';
 *   const ms = createMultiSelect({
 *     staging, settings, ctx,
 *     isSelectable: (item) => boolean,
 *     sortItems: (items) => sortedItems,
 *     refreshOutlines: () => void,
 *     getFocusedDay: () => dayDate | null,
 *     setBlockError: (msg) => void,
 *     clipboardGet, clipboardSet, serializeItem,
 *     createItemsFromClipOp, deleteItemOp,
 *     onSave: () => void,  // Ctrl+S / Cmd+S
 *   });
 *
 *   ms.onKeydown(event)        → keyboard dispatcher
 *   ms.onBeforeUnload(event)   → beforeunload guard
 *   ms.showContextMenu(x, y)   → open right-click menu
 *   ms.isSelected(id)          → check selection membership
 *   ms.selectOnly(id)          → single-select
 *   ms.clearSelection()        → clear all
 */

import { el } from '/static/js/util.js';
import {
  closeContextMenu as closeCtxMenu,
  buildContextMenu,
  positionMenu,
  showToast,
  isTypingTarget,
  onBeforeUnload as beforeUnload,
} from '/static/js/page-utils.js';

export function createMultiSelect({
  staging, settings, ctx,
  isSelectable,
  sortItems,
  refreshOutlines,
  getFocusedDay,
  setBlockError,
  clipboardGet, clipboardSet, serializeItem,
  createItemsFromClipOp, deleteItemOp,
  onSave,
}) {
  let selection = new Set();
  let lastSelectedId = null;
  let contextMenuEl = null;

  /* ---------- core helpers ---------- */

  function isSelected(id) { return selection.has(String(id)); }

  function clearSelection() {
    if (selection.size === 0) return;
    selection = new Set();
    lastSelectedId = null;
    refreshOutlines();
  }

  function selectOnly(id) {
    selection = new Set([String(id)]);
    lastSelectedId = String(id);
    refreshOutlines();
  }

  function toggleSelect(id) {
    id = String(id);
    if (selection.has(id)) {
      selection.delete(id);
      if (lastSelectedId === id) lastSelectedId = null;
    } else {
      selection.add(id);
      lastSelectedId = id;
    }
    refreshOutlines();
  }

  function selectRangeAcrossDays(from, to) {
    if (!from || !to) { selectOnly(to || from); return; }
    const all = staging.viewItems();
    const ordered = sortItems(all);
    const ids = ordered.map(it => String(it.id));
    const a = ids.indexOf(String(from));
    const b = ids.indexOf(String(to));
    if (a < 0 || b < 0) { selectOnly(to); return; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const next = new Set(selection);
    for (let i = lo; i <= hi; i++) {
      const it = ordered[i];
      if (isSelectable(it)) next.add(String(it.id));
    }
    selection = next;
    lastSelectedId = String(to);
    refreshOutlines();
  }

  function selectedItems() {
    const all = staging.viewItems();
    return all.filter(i => isSelectable(i) && selection.has(String(i.id)));
  }

  function batchSessionId() {
    return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- clipboard actions ---------- */

  function copySelection() {
    const items = selectedItems();
    if (!items.length) return;
    clipboardSet({ items, action: 'copy' });
    if (setBlockError) setBlockError(null);
  }

  function cutSelection() {
    const items = selectedItems();
    if (!items.length) return;
    const stamped = items.map(it => Object.assign(serializeItem(it), { _srcId: it.id }));
    clipboardSet({ items: stamped, action: 'cut' });
    if (setBlockError) setBlockError(null);
  }

  function pasteFromClipboard() {
    const clip = clipboardGet();
    if (!clip || !clip.items.length) return;
    const target = getFocusedDay ? getFocusedDay() : null;
    if (!target) return;
    const sessionId = batchSessionId();
    staging.add(createItemsFromClipOp({
      planId: ctx.planId,
      item_date: target,
      items: clip.items,
      sessionId,
    }));
    if (clip.action === 'cut') {
      for (const src of clip.items) {
        if (src._srcId != null) {
          staging.add(deleteItemOp({ itemId: src._srcId, label: 'Cut', sessionId }));
        }
      }
    }
  }

  function duplicateSelection() {
    const items = selectedItems();
    if (!items.length) return;
    const target = getFocusedDay ? getFocusedDay() : null;
    if (!target) return;
    const sessionId = batchSessionId();
    staging.add(createItemsFromClipOp({
      planId: ctx.planId,
      item_date: target,
      items: items.map(i => Object.assign(serializeItem(i), { _srcId: i.id })),
      sessionId,
    }));
  }

  function deleteSelection() {
    const items = selectedItems();
    if (!items.length) return;
    const sessionId = batchSessionId();
    for (const i of items) {
      staging.add(deleteItemOp({
        itemId: i.id,
        label: items.length === 1 ? `Delete ${i.title || 'item'}` : `Delete ${items.length} items`,
        sessionId,
      }));
    }
    clearSelection();
  }

  /* ---------- context menu ---------- */

  function closeContextMenuLocal() {
    contextMenuEl = closeCtxMenu(contextMenuEl);
  }

  function showContextMenu(x, y) {
    closeContextMenuLocal();
    const sel = selectedItems();
    const clip = clipboardGet();
    const focused = getFocusedDay ? getFocusedDay() : null;
    const items = [
      { label: 'Cut',       shortcut: '\u2318X', enabled: sel.length > 0,
        action: () => { cutSelection(); closeContextMenuLocal(); } },
      { label: 'Copy',      shortcut: '\u2318C', enabled: sel.length > 0,
        action: () => { copySelection(); closeContextMenuLocal(); } },
      { label: 'Paste',     shortcut: '\u2318V', enabled: !!(clip && clip.items.length) && !!focused,
        action: () => { pasteFromClipboard(); closeContextMenuLocal(); } },
      { label: 'Duplicate', shortcut: '\u2318D', enabled: sel.length > 0 && !!focused,
        action: () => { duplicateSelection(); closeContextMenuLocal(); } },
      { sep: true },
      { label: 'Delete',    shortcut: 'Del', enabled: sel.length > 0, danger: true,
        action: () => { deleteSelection(); closeContextMenuLocal(); } },
    ];
    const menu = buildContextMenu(items);
    positionMenu(menu, x, y);
    contextMenuEl = menu;
  }

  /* ---------- keyboard ---------- */

  function onKeydown(e) {
    if (isTypingTarget(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); staging.undo(); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); staging.redo(); return; }
      if (k === 's') { e.preventDefault(); if (onSave) onSave(); return; }
      if (k === 'c') { e.preventDefault(); copySelection(); return; }
      if (k === 'x') { e.preventDefault(); cutSelection(); return; }
      if (k === 'v') { e.preventDefault(); pasteFromClipboard(); return; }
      if (k === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (k === 'a') {
        e.preventDefault();
        const all = staging.viewItems();
        const newSel = new Set();
        for (const it of all) {
          if (isSelectable(it)) newSel.add(String(it.id));
        }
        selection = newSel;
        lastSelectedId = null;
        refreshOutlines();
        return;
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selection.size) { e.preventDefault(); deleteSelection(); return; }
    }
    if (e.key === 'Escape') {
      if (contextMenuEl) { closeContextMenuLocal(); return; }
      if (selection.size) { clearSelection(); return; }
    }
  }

  function onBeforeUnload(e) {
    return beforeUnload(staging, e);
  }

  /* ---------- select all shortcut (for external use) ---------- */

  function selectAll() {
    const all = staging.viewItems();
    const newSel = new Set();
    for (const it of all) {
      if (isSelectable(it)) newSel.add(String(it.id));
    }
    selection = newSel;
    lastSelectedId = null;
    refreshOutlines();
  }

  /* ---------- public API ---------- */

  return {
    /* state (read-only views) */
    get hasSelection() { return selection.size > 0; },
    get count() { return selection.size; },
    get lastSelectedId() { return lastSelectedId; },
    getLastItemInSelection() {
      if (!selection.size) return null;
      return [...selection][selection.size - 1];
    },

    /* core */
    isSelected,
    clearSelection,
    selectOnly,
    toggleSelect,
    selectRangeAcrossDays,
    selectedItems,
    batchSessionId,
    selectAll,

    /* clipboard */
    copySelection,
    cutSelection,
    pasteFromClipboard,
    duplicateSelection,
    deleteSelection,

    /* context menu */
    closeContextMenu: closeContextMenuLocal,
    showContextMenu,

    /* keyboard & lifecycle */
    onKeydown,
    onBeforeUnload,
  };
}
