/* itinerary.js — renders the plan board (day columns + item cards) and wires
 * the pending-changes bar. All mutations on the page go through the Staging
 * engine; nothing reaches the server until the user clicks Save in the bar.
 *
 * Page contract: window.__CONTEXT__ = { planId, role }.
 *
 * The header (title + dates) and the add-toolbar (range controls,
 * + Buffer day, Quick add) are shared with the timeline in
 * static/js/plan-header.js — both pages render the same chrome.
 */
import { apiGet } from '/static/js/api.js';
import { el, clear, money, statusBadge, loadSettings } from '/static/js/util.js';
import { enableDragDrop } from '/static/js/dragdrop.js';
import { openItemEditor } from '/static/js/item-editor.js';
import {
  Staging, createBlankItemOp, createItemsFromClipOp, saveItemOp, updateItemOp,
  moveItemOp, deleteItemOp,
  uploadImageOp, addLinkOp, deleteAttachmentOp, addExpenseOp,
} from '/static/js/staging.js';
import {
  clipboardGet, clipboardSet, serializeItem,
} from '/static/js/clipboard.js';
import {
  buildDays, isoOf, wirePlanHeader, renderPlanToolbar, makeDayActions,
} from '/static/js/plan-header.js';

/* JPY/KRW have 0 minor units; everything else uses 2. Matches backend. */
function decimalsFor(cur) {
  return (cur === 'JPY' || cur === 'KRW') ? 0 : 2;
}

/* Days a single item appears on. Spanning types (hotel) cover [item_date, end_date);
 * end_date is the checkout day and is exclusive. Single-date items appear once. */
function itemDays(item, settings) {
  const ti = settings.item_types[item.item_type];
  if (ti && ti.spans_days && item.end_date && item.item_date) {
    const out = [];
    let d = new Date(item.item_date + 'T00:00:00');
    const end = new Date(item.end_date + 'T00:00:00');
    while (d < end) { out.push(isoOf(d)); d.setDate(d.getDate() + 1); }
    return out;
  }
  return [item.item_date || ''];
}

/* True if the item type spans multiple days (e.g. hotel). Such items are
 * treated as the "home base" for the night and are pinned to the bottom of
 * every day they cover, regardless of their sort_key. */
function isSpanningItem(item, settings) {
  const ti = settings.item_types[item.item_type];
  return !!(ti && ti.spans_days && item.end_date && item.item_date && item.end_date > item.item_date);
}

/* Group items into day buckets, preserving API sort order (item_date, sort_key, id).
 * Spanning items (hotels) are always placed last in each day's bucket. */
function groupByDay(items, days, settings) {
  const map = new Map(days.map(d => [d.date, []]));
  for (const item of items) {
    for (const dd of itemDays(item, settings)) {
      if (map.has(dd)) map.get(dd).push(item);
    }
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.sort_key - b.sort_key) || (a.id - b.id));
    // Pin spanning items (e.g. hotels) to the bottom of the day — they
    // represent the home/last destination for the night.
    const spanning = arr.filter(it => isSpanningItem(it, settings));
    if (spanning.length) {
      const spans = new Set(spanning.map(it => it.id));
      const regular = arr.filter(it => !spans.has(it.id));
      arr.length = 0;
      arr.push(...regular, ...spanning);
    }
  }
  return map;
}

function firstImage(item) {
  return (item.attachments || []).find(a => a.kind === 'image');
}

/* A few human-readable detail lines for a card. The first line is a
 * special-cased "time range" for any item that has both `start_time` and
 * `end_time` (every timed type now does, including restaurant and
 * transport — see timeline.js TIME_FIELDS). We render them as one
 * "19:00 → 20:00" line instead of two separate "Start: ..." and "End:
 * ..." lines, which is what the user actually wants to see on the card.
 * Other fields fall through to the type-defined labels. */
function detailLines(item, settings) {
  const ti = settings.item_types[item.item_type];
  const d = item.details || {};
  const lines = [];
  if (d.from && d.to) lines.push(`${d.from} → ${d.to}`);
  // Time range line: combine depart_time + arrive_time (transit) or
  // start_time + end_time (everything else). Legacy `time` is shown
  // alone since it has no end.
  const startV = d.depart_time || d.start_time || d.time;
  const endV = d.arrive_time || d.end_time;
  if (startV && endV) {
    // Strip the date prefix — "2026-09-11T19:00" → "19:00". The day
    // column already shows the date.
    const s = String(startV).replace(/^[^T]+T/, '');
    const e = String(endV).replace(/^[^T]+T/, '');
    lines.push(`${s} → ${e}`);
  } else if (startV) {
    const s = String(startV).replace(/^[^T]+T/, '');
    lines.push(s);
  }
  const fields = ti ? ti.fields : [];
  for (const f of fields) {
    if (f.key === 'from' || f.key === 'to') continue;
    // Skip start_time/end_time/time/depart_time/arrive_time — already
    // covered above (or they're the only time field, shown as a single value).
    if (f.key === 'start_time' || f.key === 'end_time' || f.key === 'time' ||
        f.key === 'depart_time' || f.key === 'arrive_time') continue;
    // Skip price/currency/link — handled by the expense form and
    // "Add link" on the right panel of the editor.
    if (f.key === 'price' || f.key === 'currency' || f.key === 'link') continue;
    const v = d[f.key];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      lines.push(`${f.label}: ${v}`);
    }
    if (lines.length >= 4) break;
  }
  return lines;
}

export async function initItinerary(ctx) {
  // Boot fetches fire in parallel.
  let settings, plan, allMembers, days, base;
  let itemsRes, expRes;                 // hoisted: used after the try block
  let focusedDay = '';
  let expenseByItem = new Map();
  let staging;
  let blockError = null;          // transient user-facing error for blocked actions
  // Multi-select state. `selection` is a Set of item ids (numbers for
  // server-saved items, string local ids for drafts). Spanning items
  // (hotels) are not selectable — they're a different kind of day-object.
  // `lastSelectedId` is the anchor for shift-click range selection
  // (within the same day only).
  let selection = new Set();
  let lastSelectedId = null;
  // When the item editor is dismissed by a backdrop click, the click also
  // reaches the document-level handler. We don't want that to wipe the
  // multi-select (the user only wanted to close the editor, not exit
  // multi-select). The editor sets this flag right before it closes; the
  // next document click consumes it and skips the clear.
  let suppressClearOnce = false;

  try {
    let planRes, memRes;
    [, planRes, memRes, itemsRes, expRes] = await Promise.all([
      loadSettings().then((s) => { settings = s; }),
      apiGet(`/api/plans/${ctx.planId}`),
      apiGet(`/api/plans/${ctx.planId}/members`),
      apiGet(`/api/plans/${ctx.planId}/items`),
      apiGet(`/api/plans/${ctx.planId}/expenses/by-item`).catch(() => ({ items: [] })),
    ]);
    plan = planRes.plan;
    allMembers = [memRes.owner, ...memRes.members];
    days = buildDays(plan);
    base = plan.base_currency;
    focusedDay = days.length ? days[0].date : '';
    expenseByItem = new Map((expRes.items || []).map(
      (x) => [x.item_id, { total: x.grand_total_base_cents, missing: x.has_missing_rate }]
    ));
  } catch (e) {
    const board = document.getElementById('board');
    if (board) { clear(board); board.appendChild(el('p', { class: 'muted', text: 'Failed to load: ' + e.message })); }
    return;
  }

  // Staging holds the local pending changes. Base = last server-confirmed
  // state. Subscribing to changes triggers a board re-render.
  staging = new Staging({
    baseItems: itemsRes.items,
    basePlan: plan,
    onChange: () => render(),
  });
  staging.subscribe(() => renderPendingBar());

  // expenseByItem is read-only display state; not part of staging base. After
  // a successful save the server is the source of truth, so we re-fetch.
  async function refreshExpenseTotals() {
    try {
      const expRes = await apiGet(`/api/plans/${ctx.planId}/expenses/by-item`).catch(() => ({ items: [] }));
      expenseByItem = new Map(
        (expRes.items || []).map(x => [x.item_id, { total: x.grand_total_base_cents, missing: x.has_missing_rate }])
      );
    } catch (e) { /* non-fatal */ }
  }

  /* ----- rendering ----- */

  function render() {
    const board = document.getElementById('board');
    if (!board) return;
    clear(board);
    // Re-derive the day columns from the latest staged plan (handles date
    // edits and buffer-day toggles in the same render pass).
    days = buildDays(staging.viewPlan());
    const items = staging.viewItems();
    const grouped = groupByDay(items, days, settings);
    for (const day of days) {
      const sec = el('section', {
        class: 'day' + (day.is_buffer ? ' day-buffer' : ''),
        dataset: { date: day.date, buffer: day.is_buffer ? '1' : '0' },
      });
      sec.addEventListener('click', () => setFocusedDay(day.date));
      const titleRow = el('div', { class: 'day-title-row' }, [
        el('h3', {
          class: 'day-title',
          text: day.label,
        }),
        makeDayActions(day, { ctx, staging, setBlockError, onChange: () => { render(); } }),
      ]);
      sec.appendChild(titleRow);
      const itemsBox = el('div', { class: 'day-items', dataset: { date: day.date } });
      for (const item of grouped.get(day.date)) {
        itemsBox.appendChild(renderCard(item, day.date));
      }
      sec.appendChild(itemsBox);
      const bar = makeAddBar(day.date);
      if (bar) sec.appendChild(bar);
      board.appendChild(sec);
    }
    // Repaint the plan title and dates — the shared header module owns
    // those, including "don't steal focus from an open editor" logic.
    renderHeaderChrome();
    // The toolbar's +/- controls depend on the current range and
    // need to be repainted whenever the view changes.
    renderToolbar();
  }

  function renderCard(item, dayDate) {
    const ti = settings.item_types[item.item_type] || { label: item.item_type };
    const card = el('article', {
      class: `card item ${item.item_type} status-${item.status}` + (isSelectable(item) && isSelected(item.id) ? ' card-selected' : ''),
      dataset: { itemId: String(item.id), date: dayDate, end: item.end_date || '',
                 type: item.item_type, spans: isSpanningItem(item, settings) ? '1' : '0' },
    });
    if (ctx.role !== 'viewer') card.draggable = true;
    if (item.isLocal) card.classList.add('is-local');

    card.appendChild(el('div', { class: 'card-head' }, [
      el('span', { class: 'card-type', text: ti.label }),
      (item.details && item.details.is_backup)
        ? el('span', { class: 'card-badge card-badge-alt', text: 'alt', title: 'Backup / alternative plan — shown after the main item on the timeline' })
        : null,
      statusBadge(item.status),
    ]));
    card.appendChild(el('h4', { class: 'card-title', text: item.title }));

    const lines = detailLines(item, settings);
    if (lines.length) {
      const dl = el('ul', { class: 'card-details' });
      for (const ln of lines) dl.appendChild(el('li', { text: ln }));
      card.appendChild(dl);
    }

    const img = firstImage(item);
    if (img) {
      // Local attachments carry a blob: preview URL; server attachments a
      // filename under /uploads/.
      const src = img.isLocal ? img.value : `/uploads/${img.value}`;
      const im = el('img', { class: 'card-thumb', src, alt: '' });
      im.loading = 'lazy';
      card.appendChild(im);
    }

    const ex = expenseByItem.get(item.id);
    if (ex && !item.isLocal) {
      // Don't show expense totals for unsaved items (the server has no
      // totals for them). They'll appear after Save + a fresh load.
      card.appendChild(el('div', {
        class: 'card-expense',
        text: ex.missing ? '—' : money(ex.total, decimalsFor(base), base),
        title: ex.missing ? 'Missing currency conversion rate' : 'Total in base currency',
      }));
    }

    const linkUrl = item.details && item.details.link;
    if (linkUrl) {
      card.appendChild(el('a', {
        class: 'card-link-btn', href: linkUrl, target: '_blank', rel: 'noopener',
        title: 'Open link', html: '🔗',
        onclick: (e) => e.stopPropagation(),
      }));
    }

    card.addEventListener('click', (e) => {
      if (e.button != null && e.button !== 0) return;
      if (e.detail > 1) return;
      handleCardClick(item, e);
    });
    card.addEventListener('dblclick', (e) => {
      if (e.button != null && e.button !== 0) return;
      if (ctx.role !== 'viewer') openEditorFor(item);
    });
    card.addEventListener('contextmenu', (e) => {
      if (ctx.role === 'viewer') return;
      e.preventDefault();
      if (isSelectable(item) && !isSelected(item.id)) {
        selection.add(String(item.id));
        lastSelectedId = String(item.id);
        refreshCardOutlines();
      }
      showContextMenu(e.clientX, e.clientY);
    });
    return card;
  }

  function makeAddBar(dayDate) {
    if (ctx.role === 'viewer') return null;
    const det = el('details', { class: 'add-bar' });
    det.appendChild(el('summary', { class: 'add-summary', text: '+ Add item' }));
    const menu = el('div', { class: 'add-menu' });
    for (const [type, ti] of Object.entries(settings.item_types)) {
      const b = el('button', { class: 'add-type', text: ti.label, title: `Add ${ti.label}` });
      b.type = 'button';
      b.addEventListener('click', () => { det.removeAttribute('open'); createItem(type, dayDate); });
      menu.appendChild(b);
    }
    det.appendChild(menu);
    return det;
  }

  /* ----- plan-level chrome (header + toolbar) -----
   * Both the board and the timeline render the same plan-level chrome,
   * so the wiring lives in plan-header.js. The board still owns the
   * pending-bar (`setBlockError` + `renderPendingBar`) — the shared
   * module just calls back into us when it wants to surface a blocked
   * action (trim a day with items, sweep a buffer).
   */
  function setBlockError(msg) {
    blockError = msg;
    renderPendingBar();
  }

  const headerCtl = wirePlanHeader({
    plan, staging, ctx,
    onChange: () => { render(); },
  });
  // Wire the page's setBlockError into the shared header. The shared
  // module's default is a no-op (console.warn) — we want the pending
  // bar to show the block message instead. The setter swaps the
  // closure the dates-edit listener calls, so this works even though
  // the listener was wired before this call.
  headerCtl.setBlockError(setBlockError);

  function renderHeaderChrome() { headerCtl.repaint(); }

  function renderToolbar() {
    renderPlanToolbar({
      days, settings, staging, ctx,
      setBlockError,
      getFocusedDay: () => focusedDay,
      setFocusedDay,
      onCreateItem: (type, date) => createItem(type, date),
      onChange: () => { render(); },
    });
  }

  /* ----- multi-select -----
   * Spanning items (hotels) are not selectable — they live across days,
   * are pinned to the bottom, and selecting them for cut/copy/duplicate
   * would require special handling that's not worth the complexity. The
   * user can still open them with a regular click. */
  function isSelectable(item) {
    if (!item) return false;
    return !isSpanningItem(item, settings);
  }

  function isSelected(id) { return selection.has(String(id)); }

  function clearSelection() {
    if (selection.size === 0) return;
    selection = new Set();
    lastSelectedId = null;
    refreshCardOutlines();
  }

  function selectOnly(id) {
    selection = new Set([String(id)]);
    lastSelectedId = String(id);
    refreshCardOutlines();
  }

  function toggleSelect(id) {
    id = String(id);
    if (selection.has(id)) {
      selection.delete(id);
      // lastSelectedId stays where it was so further shift-clicks anchor
      // sensibly; clear it only if we just removed it.
      if (lastSelectedId === id) lastSelectedId = null;
    } else {
      selection.add(id);
      lastSelectedId = id;
    }
    refreshCardOutlines();
  }

  /* Select a contiguous range of selectable items in the same day, from
   * `from` to `to` (inclusive). Spanning items (hotels) are skipped in
   * the range — they break the chain. */
  function selectRangeInDay(items, dayDate, from, to) {
    if (!from || !to) { selectOnly(to || from); return; }
    const ids = items
      .filter(it => it.item_date === dayDate && isSelectable(it))
      .map(it => String(it.id));
    const a = ids.indexOf(String(from));
    const b = ids.indexOf(String(to));
    if (a < 0 || b < 0) { selectOnly(to); return; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const next = new Set(selection);
    for (let i = lo; i <= hi; i++) next.add(ids[i]);
    selection = next;
    lastSelectedId = String(to);
    refreshCardOutlines();
  }

  /* Multi-day range select. The board lays items out in day-then-position
   * order; we slice that sequence from the `from` anchor to the `to`
   * anchor (inclusive) and add every selectable (non-spanning) item in
   * between. Items on intermediate days are included automatically;
   * hotels (spanning) are skipped — they don't participate in multi-
   * select. Either anchor may be on any day; direction is figured out
   * by their position in the board sequence. */
  function selectRangeAcrossDays(from, to) {
    if (!from || !to) { selectOnly(to || from); return; }
    const all = staging.viewItems();
    // Walk in board order: sort by (day, sort_key, id) so the sequence
    // matches what the user sees on the screen. ISO date strings compare
    // correctly as plain strings (YYYY-MM-DD), so we use a direct <
    // instead of localeCompare to stay locale-independent.
    const ordered = all.slice().sort((a, b) => {
      if (a.item_date !== b.item_date) {
        return (a.item_date < b.item_date) ? -1 : 1;
      }
      if (a.sort_key !== b.sort_key) return a.sort_key - b.sort_key;
      return a.id - b.id;
    });
    const ids = ordered.map(it => String(it.id));
    const a = ids.indexOf(String(from));
    const b = ids.indexOf(String(to));
    if (a < 0 || b < 0) { selectOnly(to); return; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const idSet = new Set(ids.slice(lo, hi + 1));
    const next = new Set(selection);
    // Add every selectable item in the slice. We compute against the
    // *ordered* list so the result matches the visible sequence (the
    // user's mental model); the `isSelectable` filter drops hotels.
    for (let i = lo; i <= hi; i++) {
      const it = ordered[i];
      if (isSelectable(it)) next.add(String(it.id));
    }
    selection = next;
    lastSelectedId = String(to);
    refreshCardOutlines();
    // Reference idSet so eslint doesn't flag the unused variable — the
    // explicit Set is a debugging aid if the logic ever needs to inspect
    // the raw range.
    void idSet;
  }

  /* Update the .card-selected class on every card without re-rendering
   * the whole board. Cheap and doesn't disturb the focus or scroll.
   * Spanning items (hotels, etc.) never get the outline — they're a
   * different kind of object and can't be part of a multi-select, even
   * if they happen to be in the selection set (a transient state). */
  function refreshCardOutlines() {
    const board = document.getElementById('board');
    if (!board) return;
    for (const c of board.querySelectorAll('.card.item')) {
      const inSel = selection.has(c.dataset.itemId);
      const isSpanning = c.dataset.spans === '1';
      if (inSel && !isSpanning) c.classList.add('card-selected');
      else c.classList.remove('card-selected');
    }
  }

  /* Resolve a click event into a selection action and apply it.
   *
   * Click model:
   *   - Plain click          → open the item editor.
   *   - Cmd / Ctrl + click   → toggle that one item in the multi-select
   *                            (no editor). Spanning items (hotels) are
   *                            rejected with a brief toast.
   *   - Shift + click        → range select. If the anchor and the
   *                            target are on the same day, we range
   *                            within that day. If they're on different
   *                            days, the range walks the board sequence
   *                            from the anchor to the target and adds
   *                            every selectable (non-spanning) item in
   *                            between, including items on intermediate
   *                            days. Spanning items are skipped — they
   *                            can't be part of a multi-select.
   * - Plain click on a hotel → do nothing (double-click to open the editor).
   *   - Shift + click on a hotel → rejected with the same toast as
   *                            Cmd+click on a hotel.
   */
  function handleCardClick(item, ev) {
    if (ev.metaKey || ev.ctrlKey) {
      if (!isSelectable(item)) {
        showToast('Spanning items (e.g. hotels) can\'t be multi-selected. Drag or open the editor to change dates.', 'warn');
        return;
      }
      toggleSelect(item.id);
      return;
    }
    if (ev.shiftKey) {
      if (!isSelectable(item)) {
        showToast('Spanning items (e.g. hotels) can\'t be multi-selected. Drag or open the editor to change dates.', 'warn');
        return;
      }
      const from = lastSelectedId || (selection.size ? [...selection][selection.size - 1] : null);
      const target = item;
      const allItems = staging.viewItems();
      const fromItem = from ? allItems.find(i => String(i.id) === String(from)) : null;
      if (fromItem && fromItem.item_date === target.item_date) {
        selectRangeInDay(allItems, target.item_date, from, target.id);
      } else {
        selectRangeAcrossDays(from, target.id);
      }
      return;
    }
    // Plain click: select only this item.
    if (isSelectable(item)) selectOnly(item.id);
  }

  /* Items in the current selection as objects (from the staged view).
   * Spanning items are filtered out — the user can't have selected one. */
  function selectedItems() {
    const all = staging.viewItems();
    return all.filter(i => isSelectable(i) && selection.has(String(i.id)));
  }

  /* Build a stable session id for batched paste/duplicate/delete ops so
   * Cancel discards them together. */
  function batchSessionId() {
    return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* Cut / copy / paste / duplicate / delete are the multi-select actions.
   * They run on the current selection (or no-op if empty). */

  function copySelection() {
    const items = selectedItems();
    if (!items.length) return;
    clipboardSet({ items, action: 'copy' });
    setBlockError(null);
  }

  function cutSelection() {
    const items = selectedItems();
    if (!items.length) return;
    // Stamp each clipboard entry with the source item's id so the
    // later paste can stage a delete of the originals.
    const stamped = items.map((it, i) => Object.assign(serializeItem(it), { _srcId: it.id }));
    clipboardSet({ items: stamped, action: 'cut' });
    setBlockError(null);
  }

  /* Paste from the clipboard onto the focused day. For each clipboard
   * item, stage a CREATE_BLANK_ITEM with the saved content. We use the
   * same create-blank op so that subsequent SAVE_ITEM (opened by the
   * editor flow) can take over. But the user doesn't want to be popped
   * into an editor for every pasted item — we instead stage a custom
   * "create from clipboard" sequence that does the POST immediately and
   * then attaches the link attachments. */
  function pasteFromClipboard() {
    const clip = clipboardGet();
    if (!clip || !clip.items.length) return;
    if (!focusedDay) return;
    const sessionId = batchSessionId();
    // Stage a save of all the clipboard items as a single op. We do it as
    // one big op so the user can undo the paste in one click. The op
    // creates each item via POST and attaches the links.
    staging.add(createItemsFromClipOp({
      planId: ctx.planId,
      item_date: focusedDay,
      items: clip.items,
      sessionId,
    }));
    // If the original action was 'cut', also stage a delete for the
    // original items (sharing the same sessionId so cancel discards both).
    if (clip.action === 'cut') {
      for (const src of clip.items) {
        if (src._srcId != null) {
          staging.add(deleteItemOp({ itemId: src._srcId, label: 'Cut', sessionId }));
        }
      }
      // The clipboard should be cleared after a successful cut-paste so
      // a second paste doesn't re-delete. We do that on save; for now
      // leave it — undo restores the originals and the cut marker too.
    }
  }

  function duplicateSelection() {
    const items = selectedItems();
    if (!items.length) return;
    if (!focusedDay) return;
    const sessionId = batchSessionId();
    staging.add(createItemsFromClipOp({
      planId: ctx.planId,
      item_date: focusedDay,
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

  /* The cut/copy/paste/duplicate/delete actions above all work on the
   * current selection. Paste targets the focused day; the user can
   * change the focused day by clicking on a different day column first
   * (see setFocusedDay). */

  /* ----- right-click context menu ----- */

  /* Transient toast: appears in the top-right for ~3s, then fades out.
   * Used for the "hotels can't be multi-selected" warning and similar
   * non-blocking nudges. Multiple toasts stack vertically. */
  const toastsEl = (() => {
    const root = el('div', { class: 'toast-stack', 'aria-live': 'polite' });
    document.body.appendChild(root);
    return root;
  })();
  let toastSeq = 0;
  function showToast(text, kind) {
    const id = ++toastSeq;
    const node = el('div', { class: 'toast' + (kind ? ' toast-' + kind : ''), role: 'status', text });
    toastsEl.appendChild(node);
    // Auto-dismiss after 3s. The shim doesn't run timers for the test
    // (tests don't wait for them), so this is purely a real-browser
    // behavior.
    setTimeout(() => { if (node.parentNode) node.remove(); }, 3000);
    return id;
  }

  let contextMenuEl = null;
  function closeContextMenu() {
    if (contextMenuEl) {
      if (contextMenuEl.remove) contextMenuEl.remove();
      else if (contextMenuEl.parentNode) contextMenuEl.parentNode.removeChild(contextMenuEl);
    }
    contextMenuEl = null;
  }
  function showContextMenu(x, y) {
    closeContextMenu();
    const menu = el('ul', { class: 'context-menu', role: 'menu' });
    const sel = selectedItems();
    const clip = clipboardGet();
    const items = [
      { label: 'Cut',         shortcut: '⌘X', enabled: sel.length > 0, action: () => { cutSelection(); closeContextMenu(); } },
      { label: 'Copy',        shortcut: '⌘C', enabled: sel.length > 0, action: () => { copySelection(); closeContextMenu(); } },
      { label: 'Paste',       shortcut: '⌘V', enabled: !!(clip && clip.items.length) && !!focusedDay,
        action: () => { pasteFromClipboard(); closeContextMenu(); } },
      { label: 'Duplicate',   shortcut: '⌘D', enabled: sel.length > 0 && !!focusedDay,
        action: () => { duplicateSelection(); closeContextMenu(); } },
      { sep: true },
      { label: 'Delete',      shortcut: 'Del', enabled: sel.length > 0, danger: true,
        action: () => { deleteSelection(); closeContextMenu(); } },
    ];
    for (const it of items) {
      if (it.sep) { menu.appendChild(el('li', { class: 'context-menu-sep' })); continue; }
      const li = el('li', { class: 'context-menu-item' + (it.danger ? ' is-danger' : ''), role: 'menuitem' });
      const btn = el('button', { type: 'button', text: it.label });
      btn.disabled = !it.enabled;
      btn.addEventListener('click', (e) => { e.stopPropagation(); it.action(); });
      li.appendChild(btn);
      if (it.shortcut) li.appendChild(el('span', { class: 'context-menu-shortcut', text: it.shortcut }));
      menu.appendChild(li);
    }
    document.body.appendChild(menu);
    // Position: clamp to viewport so the menu never falls off-screen.
    // The shim doesn't implement getBoundingClientRect or window.innerWidth
    // — fall back to the requested coordinates so the test still works.
    let rectW = 200, rectH = 200;
    try {
      const rect = menu.getBoundingClientRect();
      if (rect) { rectW = rect.width || rectW; rectH = rect.height || rectH; }
    } catch (e) { /* shim: use defaults */ }
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
    const px = Math.min(x, vw - rectW - 8);
    const py = Math.min(y, vh - rectH - 8);
    menu.style.left = `${Math.max(8, px)}px`;
    menu.style.top  = `${Math.max(8, py)}px`;
    contextMenuEl = menu;
  }

  /* ----- pending-changes bar ----- */

  function renderPendingBar() {
    const bar = document.getElementById('pending-bar');
    if (!bar) return;
    clear(bar);
    if (ctx.role === 'viewer') { bar.hidden = true; return; }

    const hasPending = staging.hasPending;
    const failed = staging.failedOpIndex >= 0;
    if (!hasPending && !failed && !blockError) { bar.hidden = true; return; }
    const lastLabel = hasPending
      ? staging.ops[staging.pointer - 1].label
      : 'All changes saved';
    const canUndo = staging.canUndo;
    const canRedo = staging.canRedo;
    const canSave = hasPending && !staging.saving;
    const failedOp = failed ? staging.ops[staging.failedOpIndex] : null;
    const failedLabel = failedOp ? ` (failed: ${failedOp.label})` : '';

    // Type picker for the Add button. Opens on click; selecting a type
    // stages a blank item and opens the editor for it.
    const addDet = el('details', { class: 'pb-add' });
    addDet.appendChild(el('summary', { class: 'pb-btn pb-add-btn', text: '+ Add' }));
    const addMenu = el('div', { class: 'pb-add-menu' });
    for (const [type, ti] of Object.entries(settings.item_types)) {
      const b = el('button', { type: 'button', class: 'add-type', text: ti.label });
      b.addEventListener('click', () => { addDet.removeAttribute('open'); createItem(type, focusedDay); });
      addMenu.appendChild(b);
    }
    addDet.appendChild(addMenu);

    const undoBtn = el('button', {
      type: 'button', class: 'pb-btn',
      text: '↶ Revert',
      title: 'Undo the last pending change (Ctrl/Cmd+Z)',
      disabled: !canUndo,
      onclick: () => { staging.undo(); },
    });
    const redoBtn = el('button', {
      type: 'button', class: 'pb-btn',
      text: '↷ Redo',
      title: 'Redo the last undone change (Ctrl/Cmd+Shift+Z)',
      disabled: !canRedo,
      onclick: () => { staging.redo(); },
    });
    const saveBtn = el('button', {
      type: 'button', class: 'pb-btn pb-save',
      text: staging.saving ? 'Saving…' : 'Save',
      title: 'Commit all pending changes to the server (Ctrl/Cmd+S)',
      disabled: !canSave,
      onclick: () => doSave(),
    });

    const status = el('span', {
      class: 'pb-status' + (failed ? ' pb-failed' : '') + (blockError ? ' pb-blocked' : ''),
      text: blockError
        ? blockError
        : staging.saving
          ? 'Saving changes…'
          : failed
            ? `Save failed: ${staging.failedError}${failedLabel}`
            : hasPending
              ? `${staging.pendingCount} pending change${staging.pendingCount === 1 ? '' : 's'} — last: ${lastLabel}`
              : 'All changes saved',
    });

    bar.append(addDet, undoBtn, redoBtn, saveBtn, status);
    bar.hidden = false;
  }

  /* `setFocusedDay` updates the toolbar's "Quick add" label so the user
   * can see which day Quick add will target. Clicking a day column on
   * the board sets this. The toolbar itself is owned by plan-header.js;
   * this just keeps the label in sync. */
  function setFocusedDay(date) {
    focusedDay = date;
    const day = days.find(d => d.date === date) || days[0];
    const dayLabel = day && day.index ? ` (Day ${day.index})` : '';
    const summary = document.querySelector('#add-toolbar .qa-summary');
    if (summary) summary.textContent = `+ Quick add${dayLabel}`;
  }

  /* ----- data actions ----- */

  async function reload() {
    // After a successful save, re-fetch items + expenses so the post-save
    // view reflects the canonical server state (including updated
    // timestamps, sort keys, etc.). Staging's base is reset to the new
    // server state.
    try {
      const [itemsRes, expRes] = await Promise.all([
        apiGet(`/api/plans/${ctx.planId}/items`),
        apiGet(`/api/plans/${ctx.planId}/expenses/by-item`).catch(() => ({ items: [] })),
      ]);
      const planRes = await apiGet(`/api/plans/${ctx.planId}`).catch(() => ({ plan: staging.base.plan }));
      staging.base = { items: itemsRes.items, plan: planRes.plan };
      staging.ops = []; staging.pointer = 0; staging.sessionOps.clear();
      expenseByItem = new Map(
        (expRes.items || []).map(x => [x.item_id, { total: x.grand_total_base_cents, missing: x.has_missing_rate }])
      );
      render();
    } catch (e) {
      const board = document.getElementById('board');
      if (board) { clear(board); board.appendChild(el('p', { class: 'muted', text: 'Failed to load: ' + e.message })); }
    }
  }

  function openEditorFor(item) {
    // Each editor session gets a unique id. The editor stages ops with this
    // id; on Cancel, the session is discarded (so e.g. a freshly-added blank
    // item created via the global Add button is removed on Cancel).
    const sessionId = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    openItemEditor(ctx, {
      plan,
      item,
      settings,
      members: allMembers,
      staging,
      sessionId,
      onApplied: () => { render(); renderPendingBar(); },
      // The backdrop click that dismisses the editor also reaches our
      // document-level click handler. We don't want that click to wipe a
      // multi-select the user built before opening the editor — the
      // click was only meant to close the editor. Set the suppress flag
      // here; the document handler consumes it on the same click.
      onClose: () => { suppressClearOnce = true; },
    });
  }

  function createItem(type, dayDate) {
    // Pre-fill cells the app already knows. The editor will run for the user
    // to enter title/details. Stage a blank item so the user sees it on the
    // board immediately and Cancel removes it. Spanning items (hotels) get
    // a 1-night default checkout so the user doesn't have to type it.
    // If the requested day no longer exists (e.g. user trimmed it via the
    // toolbar), fall back to the first day in the current view.
    const dayExists = dayDate && days.some(d => d.date === dayDate);
    const effectiveDate = dayExists ? dayDate : (days[0] && days[0].date) || null;
    const ti = settings.item_types[type];
    let defaultEnd = null;
    if (ti && ti.spans_days && effectiveDate) {
      const d = new Date(effectiveDate + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      defaultEnd = isoOf(d);
    }
    const sessionId = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const op = createBlankItemOp({
      planId: ctx.planId, item_type: type, item_date: effectiveDate || null,
      end_date: defaultEnd, sessionId,
    });
    staging.add(op);
    const draft = staging.viewItems().find(x => x.id === op._draftId);
    if (draft) {
      openItemEditor(ctx, {
        plan, item: draft, settings, members: allMembers,
        staging, sessionId,
        onApplied: () => { render(); renderPendingBar(); },
        onClose: () => { suppressClearOnce = true; },
      });
    }
  }

  async function doSave() {
    if (staging.saving) return;
    try {
      const apiMod = await import('/static/js/api.js');
      await staging.saveAll({
        post: apiMod.apiPost, patch: apiMod.apiPatch, del: apiMod.apiDel, upload: apiMod.apiUpload,
      });
      await reload();
      // Brief "Saved" status is rendered by renderPendingBar (it reads
      // staging.hasPending which is now false).
    } catch (e) {
      renderPendingBar();
    }
  }

  /* drag/drop callbacks */

  function onMove(itemId, { item_date, before_id, after_id }) {
    const item = staging.viewItems().find(i => String(i.id) === String(itemId));
    if (!item) return;
    // Drag/drop on a not-yet-saved item: open the editor instead of
    // staging a move, since the move's effect is captured when the user
    // Applies (the editor's snapshot includes the new date).
    if (item.isLocal || (typeof itemId === 'string' && itemId.startsWith('_'))) {
      openEditorFor(item);
      return;
    }
    const sessionId = batchSessionId();

    function spanEndDate(it, newDate) {
      const ti = settings.item_types[it.item_type];
      if (!ti || !ti.spans_days || !it.end_date || !it.item_date) return null;
      const offset = new Date(it.end_date + 'T00:00:00') - new Date(it.item_date + 'T00:00:00');
      return isoOf(new Date(new Date(newDate + 'T00:00:00').getTime() + offset));
    }

    // Multi-drag: if the dragged item is part of the selection, move
    // every selected item to the same target date. before_id / after_id
    // are only meaningful for the lead item; the rest land at the end
    // of the day (the user can re-order if needed).
    const leadId = String(itemId);
    if (isSelectable(item) && isSelected(leadId) && selection.size > 1) {
      const moving = [...selection].map(id => String(id));
      for (const id of moving) {
        const it = staging.viewItems().find(x => String(x.id) === id);
        if (!it) continue;
        const isLead = id === leadId;
        const leadDate = isLead ? item_date : (it.item_date || item_date);
        const end_date = spanEndDate(it, leadDate);
        staging.add(moveItemOp({
          itemId: it.id,
          item_date: leadDate,
          before_id: isLead ? before_id : null,
          after_id:  isLead ? after_id  : null,
          end_date,
          sessionId,
        }));
      }
      return;
    }
    const ti = settings.item_types[item.item_type];
    const end_date = spanEndDate(item, item_date);
    staging.add(moveItemOp({
      itemId, item_date, before_id, after_id, end_date,
    }));
  }

  function onUpload(itemId, file) {
    const item = staging.viewItems().find(i => String(i.id) === String(itemId));
    if (!item) return;
    if (item.isLocal || (typeof itemId === 'string' && itemId.startsWith('_'))) {
      // Uploading to a not-yet-saved item: open the editor so the upload is
      // bundled into the Apply (otherwise the file would be sent to a
      // non-existent server id).
      openEditorFor(item);
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    staging.add(uploadImageOp({ itemId, file, previewUrl, caption: file.name }));
  }

  /* ----- keyboard shortcuts ----- */
  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z (or Ctrl+Y) = redo, Cmd/Ctrl+S = save.
  // Ignored when the user is typing in a form field, so they don't conflict
  // with text editing.
  function isTypingTarget(t) {
    if (!t) return false;
    // The shim doesn't always implement `matches`; check the tagName
    // directly as a fallback. Real DOMs use `matches`.
    const tag = (t.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (t.isContentEditable) return true;
    if (t.matches) return t.matches('input, textarea, select, [contenteditable]');
    return false;
  }
  function onKeydown(e) {
    if (isTypingTarget(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); staging.undo(); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); staging.redo(); return; }
      if (k === 's') { e.preventDefault(); doSave(); return; }
      if (k === 'c') { e.preventDefault(); copySelection(); return; }
      if (k === 'x') { e.preventDefault(); cutSelection(); return; }
      if (k === 'v') { e.preventDefault(); pasteFromClipboard(); return; }
      if (k === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (k === 'a') {
        // ⌘A: select every non-spanning item on the board.
        e.preventDefault();
        selection = new Set(
          staging.viewItems().filter(isSelectable).map(i => String(i.id))
        );
        lastSelectedId = null;
        refreshCardOutlines();
        return;
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selection.size) { e.preventDefault(); deleteSelection(); return; }
    }
    if (e.key === 'Escape') {
      if (contextMenuEl) { closeContextMenu(); return; }
      if (selection.size) { clearSelection(); return; }
    }
  }

  /* ----- beforeunload guard ----- */
  function onBeforeUnload(e) {
    if (staging && staging.hasPending) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  }

  /* ----- boot ----- */
  render();
  renderHeaderChrome();
  renderPendingBar();
  renderToolbar();
  enableDragDrop(document.getElementById('board'), { onMove, onUpload });
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);
  // Global click: close the context menu if it's open and the click
  // didn't land inside it (the menu's own click handler stops propagation,
  // so this listener only fires for outside clicks). Also exit multi-
  // select when the user clicks on a blank area: a day section's empty
  // background, the board's outer margin, or the plan header. Cards,
  // buttons, form fields, and the toolbar keep their existing handlers
  // and don't trigger a clear.
  document.addEventListener('click', (e) => {
    if (contextMenuEl && !contextMenuEl.contains(e.target)) closeContextMenu();
    // The item editor can set suppressClearOnce before closing itself
    // (typically a backdrop click). When the click reaches us we skip the
    // multi-select clear once, then reset the flag.
    if (suppressClearOnce) { suppressClearOnce = false; return; }
    if (!selection.size || !e.target.closest) return;
    // Things that "consume" the click and should NOT clear the selection:
    const onCard     = e.target.closest('.card.item');
    const onInteract = e.target.closest(
      'button, summary, input, textarea, select, a, label, [contenteditable], .toolbar-label'
    );
    // If the click is on a card or on an interactive control, leave the
    // selection alone. Everything else (day section padding, the board's
    // own background, the plan header, anywhere off the board) is treated
    // as "the user wants to exit multi-select" and we clear.
    if (onCard || onInteract) return;
    clearSelection();
  });
  document.addEventListener('scroll', closeContextMenu, true);
}
