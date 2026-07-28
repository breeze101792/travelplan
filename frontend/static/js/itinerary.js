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
import { Staging, createBlankItemOp, createItemsFromClipOp, saveItemOp, updateItemOp,
        moveItemOp, deleteItemOp, uploadImageOp, addLinkOp, deleteAttachmentOp, addExpenseOp } from '/static/js/staging.js';
import { clipboardGet, clipboardSet, serializeItem } from '/static/js/clipboard.js';
import { buildDays, isoOf, wirePlanHeader, renderEditBar, makeDayActions,
        showDayContextMenu, closeDayContextMenu } from '/static/js/plan-header.js';
import { expandHotelEvents } from '/static/js/hotel-events.js';
import { createMultiSelect } from '/static/js/multi-select.js';
import { doSave as sharedSave, showToast, batchSessionId } from '/static/js/page-utils.js';

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

/* Extract a numeric sort value from an item's when.start_at (HH.MM) so items
 * sort chronologically within a day. Returns null when no time is set. */
function effectiveTimeSort(item) {
  const d = item.details || {};
  const when = d.when || {};
  const raw = when.start_at;
  if (!raw) return null;
  const s = String(raw).replace(/^[^T]+T/, '');
  const [h, m] = s.split(':').map(Number);
  if (isNaN(h)) return null;
  return h + (isNaN(m) ? 0 : m / 60);
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
    arr.sort((a, b) => {
      const aTime = effectiveTimeSort(a);
      const bTime = effectiveTimeSort(b);
      if (aTime !== null && bTime !== null) {
        if (aTime !== bTime) return aTime - bTime;
      } else if (aTime !== null) {
        return -1; // timed items before untimed
      } else if (bTime !== null) {
        return 1;
      }
      return (a.sort_key - b.sort_key) || (a.id - b.id);
    });
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
 * special-cased "time range" for any item that has both when.start_at
 * and when.end_at (every timed type does — see settings.json). We
 * render them as one "19:00 → 20:00" line instead of two separate
 * "Start: ..." and "End: ..." lines, which is what the user actually
 * wants to see on the card. Other fields fall through to the
 * type-defined labels. */
function detailLines(item, settings) {
  const ti = settings.item_types[item.item_type];
  const d = item.details || {};
  const when = d.when || {};
  const lines = [];
  if (d.from && d.to) lines.push(`${d.from} → ${d.to}`);
  // Time range line: combine when.start_at and when.end_at into a single
  // "19:00 → 20:00" line. Skip the range for spanning items (e.g. hotels
  // that cover multiple days) — their start and end times are on different
  // days so a "15:00 → 11:00" range would be misleading. The per-day
  // check-in / check-out virtual events carry the correct day-specific time.
  if (item._hotelEvent && when.start_at) {
    const label = item._hotelEvent === 'check-in' ? 'Check-in' : 'Check-out';
    const t = String(when.start_at).replace(/^[^T]+T/, '');
    lines.push(`${label}: ${t}`);
  } else if (!isSpanningItem(item, settings) && when.start_at && when.end_at) {
    // Strip the date prefix — "2026-09-11T19:00" → "19:00". The day
    // column already shows the date. Schedule items always have both
    // start and end (the server defaults end to start + 1h if blank),
    // so this branch is the common case.
    const s = String(when.start_at).replace(/^[^T]+T/, '');
    const e = String(when.end_at).replace(/^[^T]+T/, '');
    lines.push(`${s} → ${e}`);
  } else if (when.start_at) {
    // Defensive: legacy data without end_at. Show just the start.
    const s = String(when.start_at).replace(/^[^T]+T/, '');
    lines.push(s);
  }
  const fields = ti ? ti.fields : [];
  for (const f of fields) {
    if (f.key === 'from' || f.key === 'to') continue;
    // Skip when (the unified time field), link — handled elsewhere.
    if (f.key === 'when' || f.key === 'link') continue;
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
  let suppressClearOnce = false;
  let savedScrollLeft = 0;

  try {
    let planRes, memRes;
    // Each fetch handled independently so a network failure doesn't
    // crash the whole page — cached data (if available) will be returned
    // by apiGet's cache-first strategy.
    [, planRes, memRes, itemsRes, expRes] = await Promise.all([
      loadSettings().then((s) => { settings = s; }).catch(() => { settings = null; }),
      apiGet(`/api/plans/${ctx.planId}`).catch(() => null),
      apiGet(`/api/plans/${ctx.planId}/members`).catch(() => null),
      apiGet(`/api/plans/${ctx.planId}/items`).catch(() => null),
      apiGet(`/api/plans/${ctx.planId}/expenses/by-item`).catch(() => ({ items: [] })),
    ]);
    if (!settings || !planRes || !memRes || !itemsRes) {
      const board = document.getElementById('board');
      if (board) {
        clear(board);
        board.appendChild(el('p', { class: 'muted', text: 'No Internet connection. Please check your connection and try again.' }));
      }
      return;
    }
    plan = planRes.plan;
    allMembers = [memRes.owner, ...memRes.members];
    days = buildDays(plan);
    base = plan.base_currency;
    const todayStr = isoOf(new Date());
    focusedDay = days.find(d => !d.is_buffer && d.date === todayStr)?.date || (days.length ? days[0].date : '');
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
  staging.subscribe(() => renderEditBarCtl());

  function isSelectable(item) {
    if (!item) return false;
    if (item._hotelEvent) return false;
    return !isSpanningItem(item, settings);
  }

  const ms = createMultiSelect({
    staging, settings, ctx,
    isSelectable,
    sortItems: (items) => items.slice().sort((a, b) => {
      if (a.item_date !== b.item_date) {
        return (a.item_date < b.item_date) ? -1 : 1;
      }
      const aTime = effectiveTimeSort(a);
      const bTime = effectiveTimeSort(b);
      if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
      if (a.sort_key !== b.sort_key) return a.sort_key - b.sort_key;
      return a.id - b.id;
    }),
    refreshOutlines: refreshCardOutlines,
    getFocusedDay: () => focusedDay,
    setBlockError,
    clipboardGet, clipboardSet, serializeItem,
    createItemsFromClipOp, deleteItemOp,
    onSave: () => doSave(),
  });

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
    days = buildDays(staging.viewPlan());
    const items = expandHotelEvents(staging.viewItems());
    const grouped = groupByDay(items, days, settings);
    const todayStr = isoOf(new Date());

    function buildDaySection(day) {
      const isToday = !day.is_buffer && day.date === todayStr;
      const sec = el('section', {
        class: 'day' + (day.is_buffer ? ' day-buffer' : '') + (isToday ? ' day-today' : ''),
        dataset: { date: day.date, buffer: day.is_buffer ? '1' : '0' },
      });
      sec.addEventListener('click', () => setFocusedDay(day.date));
      sec.addEventListener('contextmenu', (e) => {
        if (ctx.role === 'viewer' || 'ontouchstart' in window) return;
        e.preventDefault();
        e.stopPropagation();
        showDayContextMenu(day, e.clientX, e.clientY, {
          plan, staging, ctx,
          items: staging.viewItems(),
          onChange: () => { render(); },
          setBlockError,
        });
      });
      const titleRow = el('div', { class: 'day-title-row' }, [
        el('h3', { class: 'day-title', text: day.label }),
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
      return sec;
    }

    // Pinned days sit outside the scroll container (same as timeline).
    const pinnedDays = days.filter(d => d.pinned);
    const unpinnedDays = days.filter(d => !d.pinned);

    if (pinnedDays.length) {
      const pinnedWrap = el('div', { class: 'board-pinned' });
      for (const day of pinnedDays) {
        pinnedWrap.appendChild(buildDaySection(day));
      }
      board.appendChild(pinnedWrap);
    }

    const scrollWrap = el('div', { class: 'board-scroll' });
    scrollWrap.addEventListener('scroll', () => { savedScrollLeft = scrollWrap.scrollLeft; }, { passive: true });
    let todaySec = null;
    for (const day of unpinnedDays) {
      const sec = buildDaySection(day);
      scrollWrap.appendChild(sec);
      if (!day.is_buffer && day.date === todayStr) todaySec = sec;
    }
    board.appendChild(scrollWrap);

    renderHeaderChrome();
    renderEditBarCtl();

    if (savedScrollLeft > 0) {
      requestAnimationFrame(() => { scrollWrap.scrollLeft = savedScrollLeft; });
    } else if (todaySec && window.matchMedia('(max-width: 640px)').matches) {
      requestAnimationFrame(() => {
        scrollWrap.scrollLeft = todaySec.offsetLeft - 16;
      });
    }
  }

  function renderCard(item, dayDate) {
    const ti = settings.item_types[item.item_type] || { label: item.item_type };
    const card = el('article', {
      class: `card item ${item.item_type} status-${item.status}` + (isSelectable(item) && ms.isSelected(item.id) ? ' card-selected' : ''),
      dataset: { itemId: String(item.id), date: dayDate, end: item.end_date || '',
                 type: item.item_type, spans: isSpanningItem(item, settings) ? '1' : '0' },
    });
    if (ctx.role !== 'viewer' && (!item._hotelEvent || item._hotelEvent === 'check-in' || item._hotelEvent === 'check-out') && !(window.matchMedia && window.matchMedia('(max-width: 640px)').matches)) card.draggable = true;
    if (item.isLocal) card.classList.add('is-local');
    if (item._hotelEvent) card.classList.add('hotel-event', `hotel-event-${item._hotelEvent}`);

    card.appendChild(el('div', { class: 'card-head' }, [
      el('span', { class: 'card-type', text: item._hotelEvent === 'check-in' ? 'Check-in'
        : item._hotelEvent === 'check-out' ? 'Check-out'
        : ti.label }),
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
      if (ctx.role === 'viewer') return;
      if (item._hotelEvent) {
        const parent = staging.viewItems().find(i => String(i.id) === String(item._hotelId));
        if (parent) openEditorFor(parent);
        return;
      }
      openEditorFor(item);
    });
    if ('ontouchstart' in window) {
      let lastTap = 0;
      card.addEventListener('touchend', (e) => {
        const now = Date.now();
        const dt = now - lastTap;
        lastTap = now;
        if (dt > 0 && dt < 300) {
          if (ctx.role === 'viewer') return;
          if (item._hotelEvent) {
            const parent = staging.viewItems().find(i => String(i.id) === String(item._hotelId));
            if (parent) openEditorFor(parent);
            return;
          }
          openEditorFor(item);
        }
      });
    }
    card.addEventListener('contextmenu', (e) => {
      if (ctx.role === 'viewer' || 'ontouchstart' in window) return;
      e.preventDefault();
      e.stopPropagation();
      if (isSelectable(item) && !ms.isSelected(item.id)) {
        ms.selectOnly(item.id);
      }
      closeDayContextMenu();
      ms.showContextMenu(e.clientX, e.clientY);
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
   * so the wiring lives in plan-header.js. The edit bar accounts for
   * the toolbar + pending-changes bar in one.
   */
  function setBlockError(msg) {
    blockError = msg;
    renderEditBarCtl();
  }

  const headerCtl = wirePlanHeader({
    plan, staging, ctx,
    onChange: () => { render(); },
  });
  headerCtl.setBlockError(setBlockError);

  function renderHeaderChrome() { headerCtl.repaint(); }

  function renderEditBarCtl() {
    renderEditBar({
      days, settings, staging, ctx,
      setBlockError,
      getFocusedDay: () => focusedDay,
      setFocusedDay,
      onCreateItem: (type, date) => createItem(type, date),
      onChange: () => { render(); },
      doSave,
      blockError,
    });
  }

  /* ----- multi-select -----
   * Spanning items (hotels) are not selectable — they live across days,
   * are pinned to the bottom, and selecting them for cut/copy/duplicate
   * would require special handling that's not worth the complexity. The
   * user can still open them with a regular click. */
  /* Update the .card-selected class on every card without re-rendering
   * the whole board. Cheap and doesn't disturb the focus or scroll.
   * Spanning items (hotels, etc.) never get the outline — they're a
   * different kind of object and can't be part of a multi-select, even
   * if they happen to be in the selection set (a transient state). */
  function refreshCardOutlines() {
    const board = document.getElementById('board');
    if (!board) return;
    for (const c of board.querySelectorAll('.card.item')) {
      const inSel = ms.isSelected(c.dataset.itemId);
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
    // Hotel events (check-in/check-out): single click does nothing;
    // double-click opens the parent hotel's editor.
    if (item._hotelEvent) return;
    // Cmd/Ctrl + click: toggle selection (spanning items rejected).
    if (ev.metaKey || ev.ctrlKey) {
      if (!isSelectable(item)) {
        showToast("Spanning items (e.g. hotels) can't be multi-selected. Drag or open the editor to change dates.", 'warn');
        return;
      }
      ms.toggleSelect(item.id);
      return;
    }
    // Shift + click: range select. If anchor and target are on the same
    // day, use the faster within-day range; otherwise cross-day.
    if (ev.shiftKey) {
      if (!isSelectable(item)) {
        showToast("Spanning items (e.g. hotels) can't be multi-selected. Drag or open the editor to change dates.", 'warn');
        return;
      }
      const from = ms.lastSelectedId || ms.getLastItemInSelection() || null;
      ms.selectRangeAcrossDays(from, item.id);
      return;
    }
    // Plain click on a selectable item: single-select it.
    if (isSelectable(item)) ms.selectOnly(item.id);
  }

  /* `setFocusedDay` updates the edit bar's "Quick add" label so the user
   * can see which day Quick add will target. Clicking a day column on
   * the board sets this. The edit bar is owned by plan-header.js;
   * this just keeps the label in sync. */
  function setFocusedDay(date) {
    focusedDay = date;
    const day = days.find(d => d.date === date) || days[0];
    const dayLabel = day && day.index ? ` (Day ${day.index})` : '';
    const summary = document.querySelector('#edit-bar .qa-summary');
    if (summary) summary.textContent = `+ Quick add${dayLabel}`;
  }

  /* ----- data actions ----- */

  async function reload() {
    // After a successful save, re-fetch items + expenses so the post-save
    // view reflects the canonical server state (including updated
    // timestamps, sort keys, etc.). Staging's base is reset to the new
    // server state.
    // forceRefresh bypasses the cache since we know the network is
    // available (saveAll just succeeded). If the refresh fails we fall
    // back to the staging base which was already updated by saveAll.
    try {
      const [itemsRes, expRes] = await Promise.all([
        apiGet(`/api/plans/${ctx.planId}/items`, { forceRefresh: true }),
        apiGet(`/api/plans/${ctx.planId}/expenses/by-item`, { forceRefresh: true }).catch(() => null),
      ]);
      const planRes = await apiGet(`/api/plans/${ctx.planId}`, { forceRefresh: true }).catch(() => null);
      // Use forceRefresh results if available; otherwise staging.base was
      // already updated by saveAll's _commitFromLive with the merged state.
      if (itemsRes) staging.base.items = itemsRes.items;
      if (planRes) staging.base.plan = planRes.plan;
      if (expRes && expRes.items) {
        expenseByItem = new Map(
          expRes.items.map(x => [x.item_id, { total: x.grand_total_base_cents, missing: x.has_missing_rate }])
        );
      }
      staging.ops = []; staging.pointer = 0; staging.sessionOps.clear();
      render();
    } catch (e) {
      // staging.base was already updated by _commitFromLive — render what we have
      staging.ops = []; staging.pointer = 0; staging.sessionOps.clear();
      render();
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
      onApplied: () => { render(); renderEditBarCtl(); },
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
        onApplied: () => { render(); renderEditBarCtl(); },
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
    } catch (e) {
      renderEditBarCtl();
    }
  }

  /* drag/drop callbacks */

  function onMove(itemId, { item_date, before_id, after_id }) {
    const allItems = expandHotelEvents(staging.viewItems());
    const item = allItems.find(i => String(i.id) === String(itemId));
    if (!item) return;
    const sessionId = batchSessionId();

    // Hotel event drag: update parent hotel's check-in or check-out date.
    if (item._hotelEvent) {
      const parent = staging.viewItems().find(i => String(i.id) === String(item._hotelId));
      if (!parent) return;
      const newItemDate = item._hotelEvent === 'check-in' ? item_date : parent.item_date;
      const newEndDate = item._hotelEvent === 'check-out' ? item_date : parent.end_date;
      if (newItemDate === parent.item_date && newEndDate === parent.end_date) return;
      staging.add(moveItemOp({
        itemId: parent.id, item_date: newItemDate,
        before_id, after_id, end_date: newEndDate, sessionId,
      }));
      return;
    }

    // Drag/drop on a not-yet-saved item: open the editor instead of
    // staging a move, since the move's effect is captured when the user
    // Applies (the editor's snapshot includes the new date).
    if (item.isLocal || (typeof itemId === 'string' && itemId.startsWith('_'))) {
      openEditorFor(item);
      return;
    }

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
    if (isSelectable(item) && ms.isSelected(leadId) && ms.count > 1) {
      const moving = ms.selectedItems().map(i => String(i.id));
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

    // For spanning items (hotels), keep end_date unchanged — reduces the
    // stay duration instead of shifting the whole block forward.
    const ti = settings.item_types[item.item_type];
    if (ti && ti.spans_days && item.end_date) {
      staging.add(moveItemOp({
        itemId, item_date, before_id, after_id,
        end_date: item.end_date, sessionId,
      }));
    } else {
      const end_date = spanEndDate(item, item_date);
      staging.add(moveItemOp({
        itemId, item_date, before_id, after_id, end_date,
      }));
    }
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

  /* ----- keyboard shortcuts + beforeunload ----- */
  function onKeydown(e) { ms.onKeydown(e); }
  function onBeforeUnload(e) { ms.onBeforeUnload(e); }

  /* ----- boot ----- */
  render();
  renderHeaderChrome();
  renderEditBarCtl();
  enableDragDrop(document.getElementById('board'), { onMove, onUpload });
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);
  // Global click: clear multi-select when the user clicks on empty space
  // (day section padding, board margins, plan header) but not on cards,
  // buttons, form fields, or the toolbar. The multi-select module's
  // Escape key also clears it. We also close any open context menu.
  document.addEventListener('click', (e) => {
    ms.closeContextMenu();
    if (suppressClearOnce) { suppressClearOnce = false; return; }
    if (!ms.count || !e.target.closest) return;
    const onCard     = e.target.closest('.card.item');
    const onInteract = e.target.closest(
      'button, summary, input, textarea, select, a, label, [contenteditable], .toolbar-label'
    );
    if (onCard || onInteract) return;
    ms.clearSelection();
  });
  document.addEventListener('scroll', () => ms.closeContextMenu(), true);
}
