/* itinerary.js — renders the plan board (day columns + item cards) and wires
 * the pending-changes bar. All mutations on the page go through the Staging
 * engine; nothing reaches the server until the user clicks Save in the bar.
 *
 * Page contract: window.__CONTEXT__ = { planId, role }.
 */
import { apiGet } from '/static/js/api.js';
import { el, clear, fmtDate, money, statusBadge, loadSettings } from '/static/js/util.js';
import { enableDragDrop } from '/static/js/dragdrop.js';
import { openItemEditor } from '/static/js/item-editor.js';
import {
  Staging, createBlankItemOp, saveItemOp, updateItemOp, updatePlanTitleOp,
  updatePlanDatesOp, updatePlanBufferDaysOp,
  moveItemOp, uploadImageOp, addLinkOp, deleteAttachmentOp, addExpenseOp,
} from '/static/js/staging.js';

/* JPY/KRW have 0 minor units; everything else uses 2. Matches backend. */
function decimalsFor(cur) {
  return (cur === 'JPY' || cur === 'KRW') ? 0 : 2;
}

/* Build YYYY-MM-DD from a local Date (avoids UTC off-by-one from toISOString). */
function isoOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* Add `n` days to a YYYY-MM-DD string. Negative n is allowed. */
function addDaysIso(iso, n) {
  if (!iso) return iso;
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

/* Enumerate the plan's day columns, including any buffer days. A buffer
 * day sits at the boundary of the trip range (or outside) and is rendered
 * with a distinct visual marker — it's a planning scratchpad, not part of
 * the trip itself. Returned in chronological order with `is_buffer: true`
 * on the marker entries. The `label` is the full text the day title should
 * show; the render code uses it verbatim. */
function buildDays(plan) {
  if (!plan.start_date || !plan.end_date) {
    return [{ date: '', index: 0, label: 'Undated' }];
  }
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const tripStart = new Date(plan.start_date + 'T00:00:00');
  const tripEnd = new Date(plan.end_date + 'T00:00:00');
  const tripDates = new Set();
  for (let d = new Date(tripStart); d <= tripEnd; d.setDate(d.getDate() + 1)) {
    tripDates.add(isoOf(d));
  }
  const bufferDates = (plan.buffer_days || [])
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !tripDates.has(d))
    .sort();
  // Combined list, chronological.
  const all = [...tripDates].concat(bufferDates).sort();
  let dayIndex = 0;
  return all.map((date) => {
    const isBuffer = !tripDates.has(date);
    if (isBuffer) {
      // Buffer days carry no "Day N" or date in their title — they're a
      // planning scratchpad, not part of the trip. The chip on the column
      // is what the user clicks to remove it.
      return { date, is_buffer: true, index: 0, label: 'Buffer' };
    }
    dayIndex += 1;
    return {
      date,
      is_buffer: false,
      index: dayIndex,
      label: `Day ${dayIndex} · ${fmt.format(new Date(date + 'T00:00:00'))}`,
    };
  });
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

/* A few human-readable detail lines for a card, with a from -> to combo. */
function detailLines(item, settings) {
  const ti = settings.item_types[item.item_type];
  const d = item.details || {};
  const lines = [];
  if (d.from && d.to) lines.push(`${d.from} → ${d.to}`);
  const fields = ti ? ti.fields : [];
  for (const f of fields) {
    if (f.key === 'from' || f.key === 'to') continue;
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
        makeDayActions(day),
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
    // Repaint the plan title and dates (in case a title/dates edit was
    // staged or undone). The dates only get re-painted when the user is
    // not actively editing them (otherwise we'd steal their focus).
    const titleEl = document.getElementById('plan-title');
    if (titleEl) titleEl.textContent = staging.viewPlan().title || '';
    const datesEl = document.getElementById('plan-dates');
    if (datesEl && !datesEl.querySelector('input')) {
      const v = staging.viewPlan();
      paintDates(datesEl, v.start_date, v.end_date);
    }
    // The toolbar's +/- controls depend on the current range and
    // need to be repainted whenever the view changes.
    renderToolbar();
  }

  function renderCard(item, dayDate) {
    const ti = settings.item_types[item.item_type] || { label: item.item_type };
    const card = el('article', {
      class: `card item ${item.item_type} status-${item.status}`,
      dataset: { itemId: String(item.id), date: dayDate, end: item.end_date || '', type: item.item_type },
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

    card.addEventListener('click', () => openEditorFor(item));
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

  /* Per-day action chips. Buffer days get a close (×) button in the
   * title row to remove the buffer marker. Trip days don't get a chip. */
  function makeDayActions(day) {
    if (ctx.role === 'viewer' || !day.date || !day.is_buffer) return null;
    const btn = el('button', {
      type: 'button',
      class: 'day-action day-action-close',
      title: 'Remove this buffer day',
      text: '×',
      'aria-label': 'Remove this buffer day',
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      stageBufferRemove(day.date);
    });
    return btn;
  }

  /* ----- staging helpers for plan-level changes ----- */

  function stageDatesChange(newStart, newEnd) {
    const view = staging.viewPlan();
    staging.add(updatePlanDatesOp({
      planId: ctx.planId,
      start_date: newStart,
      end_date: newEnd,
      prev: { start_date: view.start_date, end_date: view.end_date },
    }));
  }

  function extendStartBy(delta) {
    const view = staging.viewPlan();
    if (!view.start_date) return;
    // Trimming the start removes the first day. Block if anything lives
    // on it; the user must move or delete the items first.
    if (delta > 0 && dayHasItems(view.start_date, staging.viewItems())) {
      setBlockError(`Can't trim the start — ${view.start_date} has item(s). Move or delete them first.`);
      return;
    }
    const newStart = addDaysIso(view.start_date, delta);
    if (view.end_date && newStart > view.end_date) return;
    setBlockError(null);
    stageDatesChange(newStart, view.end_date);
  }

  function extendEndBy(delta) {
    const view = staging.viewPlan();
    if (!view.end_date) return;
    // Trimming the end removes the last day. Block if anything lives on it.
    if (delta < 0 && dayHasItems(view.end_date, staging.viewItems())) {
      setBlockError(`Can't trim the end — ${view.end_date} has item(s). Move or delete them first.`);
      return;
    }
    const newEnd = addDaysIso(view.end_date, delta);
    if (view.start_date && newEnd < view.start_date) return;
    setBlockError(null);
    stageDatesChange(view.start_date, newEnd);
  }

  function setBlockError(msg) {
    blockError = msg;
    renderPendingBar();
  }

  function stageBufferRemove(date) {
    const view = staging.viewPlan();
    if (!(view.buffer_days || []).includes(date)) return;
    // Block if there are items on this buffer day — the user must move or
    // delete them first. The board re-renders unchanged and the error is
    // surfaced in the pending bar.
    if (dayHasItems(date, staging.viewItems())) {
      setBlockError(`Can't remove this buffer day — it has item(s). Move or delete them first.`);
      return;
    }
    setBlockError(null);
    staging.add(updatePlanBufferDaysOp({
      planId: ctx.planId,
      add: [],
      remove: [date],
    }));
  }

  /* Buffers always live on a "scratchpad calendar" far away from the trip
   * (year 9999), so they can never collide with a trip date no matter how
   * the trip range moves. The dates are internal only — the column
   * header just says "Buffer" with no day number or date. We allocate
   * from the end of the year backward: 9999-12-31, 9999-12-30, ... so
   * each buffer gets a unique, stable date (the table's PK is
   * (plan_id, date)). */
  function nextBufferDate(plan) {
    // Buffers live on a "scratchpad calendar" far away from the trip (year
    // 9999) so they can never collide with a trip date, regardless of how
    // the trip range moves. Allocate from the end of the year backward
    // (Dec 31, Dec 30, ...) so each buffer gets a unique, stable date
    // matching the table's (plan_id, date) PK. We build the date in local
    // time (not UTC) to keep it consistent with `isoOf` and the rest of
    // the app.
    const BUFFER_YEAR = 9999;
    const cap = new Date(BUFFER_YEAR, 11, 31);
    const capIso = isoOf(cap);
    const taken = new Set(plan.buffer_days || []);
    if (!taken.has(capIso)) return capIso;
    let d = cap;
    for (let i = 0; i < 366; i++) {
      d.setDate(d.getDate() - 1);
      const iso = isoOf(d);
      if (!taken.has(iso)) return iso;
    }
    // Pathological case: every day in the buffer year is taken. Fall back
    // to a year-padded counter so the date is still unique.
    return `${BUFFER_YEAR}-12-${String(31 + (plan.buffer_days || []).length).padStart(2, '0')}`;
  }

  function stageBufferAdd() {
    const view = staging.viewPlan();
    const date = nextBufferDate(view);
    staging.add(updatePlanBufferDaysOp({
      planId: ctx.planId,
      add: [date],
      remove: [],
    }));
  }

  /* True if the staged item list has any item whose item_date matches.
   * Spanning items (hotels) are checked by their item_date only — the
   * end_date is the exclusive checkout day, so a hotel that *ends* on
   * `date` is not "on" it. */
  function dayHasItems(date, items) {
    return items.some(i => i.item_date === date);
  }

  /* True if any item in the staged list has item_date inside the trip
   * range. Used by the date editor to validate that a proposed new range
   * doesn't sweep items away. */
  function tripRangeHasItems(start, end, items) {
    if (!start || !end) return false;
    return items.some(i => i.item_date >= start && i.item_date <= end);
  }

  /* ----- pending-changes bar ----- */

  function renderPendingBar() {
    const bar = document.getElementById('pending-bar');
    if (!bar) return;
    clear(bar);
    if (ctx.role === 'viewer') { bar.hidden = true; return; }

    const hasPending = staging.hasPending;
    const lastLabel = hasPending
      ? staging.ops[staging.pointer - 1].label
      : 'All changes saved';
    const canUndo = staging.canUndo;
    const canRedo = staging.canRedo;
    const canSave = hasPending && !staging.saving;
    const failed = staging.failedOpIndex >= 0;
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

  function renderToolbar() {
    const tb = document.getElementById('add-toolbar');
    if (!tb) return;
    clear(tb);
    if (ctx.role === 'viewer') return;

    // Range controls: extend or trim the trip by 1 day on either side.
    // Owner and editor both get this. Disabled when the relevant edge
    // is unset.
    const view = staging.viewPlan();
    const hasStart = !!view.start_date;
    const hasEnd = !!view.end_date;
    const canTrimStart = hasStart && (!hasEnd || view.start_date < view.end_date);
    const canTrimEnd = hasEnd && (!hasStart || view.start_date < view.end_date);

    const mkRangeBtn = (text, title, action, onClick, disabled) => el('button', {
      type: 'button', class: 'toolbar-btn toolbar-range', text, title,
      dataset: { action },
      disabled: !!disabled, onclick: onClick,
    });
    // Range controls: the arrow on each button points to the side the
    // affected day lives on — for `+` it's where the new day appears; for
    // `−` it's the side that just lost a day. The mental model is the
    // calendar: extending the start means the trip starts one day earlier
    // (the new day lives to the left of Day 1); extending the end means it
    // ends one day later (the new day lives to the right of the last day);
    // trimming pulls an edge inward.
    //
    // Each trip edge owns a pair of buttons: its extend on the outside,
    // its trim on the inside. The toolbar reads from the outside in.
    //
    //   [‹ +1 day]  [−1 day ›]    |    [‹ −1 day]  [+1 day ›]
    //     extend      trim-star       trim-end      extend
    //     -start                          -end
    const startGroup = el('span', { class: 'toolbar-range-group' }, [
      mkRangeBtn('‹ +1 day', 'Add one day to the start of the trip (new day on the left)', 'extend-start',
                 () => extendStartBy(-1), !hasStart),
      mkRangeBtn('−1 day ›', 'Remove the first day of the trip', 'trim-start',
                 () => extendStartBy(+1), !canTrimStart),
    ]);
    const endGroup = el('span', { class: 'toolbar-range-group' }, [
      mkRangeBtn('‹ −1 day', 'Remove the last day of the trip', 'trim-end',
                 () => extendEndBy(-1), !canTrimEnd),
      mkRangeBtn('+1 day ›', 'Add one day to the end of the trip (new day on the right)', 'extend-end',
                 () => extendEndBy(+1), !hasEnd),
    ]);
    tb.appendChild(startGroup);
    tb.appendChild(endGroup);

    // Buffer day control: one click adds a new buffer column. The date is
    // derived (no picker) — the day before the trip start, or one day
    // before the previously added buffer, so successive clicks keep adding
    // further-back days. If there's no trip start, we use today.
    tb.appendChild(makeBufferAddButton());

    const day = days.find(d => d.date === focusedDay) || days[0];
    tb.appendChild(el('span', { class: 'toolbar-label', text: `Quick add${day && day.index ? ` (Day ${day.index})` : ''}:` }));
    for (const [type, ti] of Object.entries(settings.item_types)) {
      const b = el('button', { class: 'toolbar-btn', text: ti.label, title: `Add ${ti.label}` });
      b.type = 'button';
      b.addEventListener('click', () => createItem(type, focusedDay));
      tb.appendChild(b);
    }
  }

  /* "Buffer day" button: a single click adds a new buffer day. The date is
   * derived automatically — never ask the user. The column header just
   * says "Buffer" (no day or date). */
  function makeBufferAddButton() {
    const btn = el('button', {
      type: 'button', class: 'toolbar-btn toolbar-range',
      text: '+ Buffer day',
      title: 'Add a buffer day to the board (planning scratchpad for items you\'re not sure about)',
    });
    btn.addEventListener('click', () => stageBufferAdd());
    return btn;
  }

  function setFocusedDay(date) {
    focusedDay = date;
    const lbl = document.querySelector('#add-toolbar .toolbar-label');
    if (lbl) {
      const day = days.find(d => d.date === date) || days[0];
      lbl.textContent = `Quick add${day && day.index ? ` (Day ${day.index})` : ''}:`;
    }
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
    const ti = settings.item_types[item.item_type];
    const end_date = (ti && ti.spans_days) ? (item.end_date || null) : null;
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

  /* ----- inline plan title + date editing ----- */

  function wireHeader() {
    const datesEl = document.getElementById('plan-dates');
    if (datesEl) {
      const view = staging ? staging.viewPlan() : plan;
      paintDates(datesEl, view.start_date, view.end_date);
      if (ctx.role !== 'viewer') {
        datesEl.classList.add('editable');
        datesEl.title = 'Click to edit trip start and end dates (saves on Save in the bar)';
        datesEl.addEventListener('click', () => beginDatesEdit(datesEl));
      }
    }
    const titleEl = document.getElementById('plan-title');
    if (titleEl && ctx.role === 'owner') {
      titleEl.classList.add('editable');
      titleEl.title = 'Click to edit title (saves on click Save in the bar)';
      titleEl.addEventListener('click', () => beginTitleEdit(titleEl));
    }
  }

  function paintDates(el_, start, end) {
    if (start && end) {
      el_.textContent = `${fmtDate(start)} → ${fmtDate(end)}`;
    } else if (start) {
      el_.textContent = fmtDate(start);
    } else {
      el_.textContent = 'Dates not set';
    }
  }

  function beginDatesEdit(datesEl) {
    if (datesEl.querySelector('input')) return;
    const view = staging.viewPlan();
    const startVal = view.start_date || '';
    const endVal = view.end_date || '';
    const startIn = document.createElement('input');
    startIn.type = 'date'; startIn.className = 'input title-edit'; startIn.value = startVal;
    const sep = document.createElement('span');
    sep.className = 'dates-sep'; sep.textContent = '→';
    const endIn = document.createElement('input');
    endIn.type = 'date'; endIn.className = 'input title-edit'; endIn.value = endVal;
    const wrap = document.createElement('span');
    wrap.className = 'dates-edit-wrap';
    wrap.append(startIn, sep, endIn);
    clear(datesEl);
    datesEl.appendChild(wrap);
    startIn.focus();

    function commit() {
      const s = startIn.value || null;
      const e = endIn.value || null;
      const changed = s !== (view.start_date || null) || e !== (view.end_date || null);
      if (changed && (!s || !e || s <= e)) {
        // Validate that the proposed new range doesn't sweep any items off
        // the board. We look at the staged item list — items that have
        // moved (e.g. via drag/drop) are already on their new dates.
        const items = staging.viewItems();
        // Items that would fall outside the new range. (Spanning items are
        // checked by their item_date only; the end_date is exclusive.)
        const wouldLose = items.filter(i =>
          i.item_date && (i.item_date < s || i.item_date > e));
        // Also account for items on buffer days — those are managed by
        // the buffer flow, not the date editor. If the new range still
        // contains them, they remain on the board. If it sweeps past
        // them, treat them like normal items (block).
        const bufferSet = new Set(view.buffer_days || []);
        const willCollide = wouldLose.some(i => !bufferSet.has(i.item_date));
        if (willCollide) {
          setBlockError(`New range would leave some item(s) outside the trip. Move or delete them first.`);
          paintDates(datesEl, view.start_date, view.end_date);
          return;
        }
        setBlockError(null);
        stageDatesChange(s, e);
      } else {
        paintDates(datesEl, view.start_date, view.end_date);
      }
    }
    function cancel() {
      paintDates(datesEl, view.start_date, view.end_date);
    }
    function onKey(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    }
    startIn.addEventListener('keydown', onKey);
    endIn.addEventListener('keydown', onKey);
    // Commit on blur of either input, but avoid double-commit when moving
    // focus from start to end: schedule commit on the *next* blur.
    let committed = false;
    const onBlur = () => {
      if (committed) return;
      committed = true;
      // Microtask so the second input's focus has settled; if focus moved
      // between the two inputs, skip committing and let the second input
      // handle it on its own blur.
      setTimeout(() => {
        if (document.activeElement === startIn || document.activeElement === endIn) return;
        commit();
      }, 0);
    };
    startIn.addEventListener('blur', onBlur);
    endIn.addEventListener('blur', onBlur);
  }

  function beginTitleEdit(titleEl) {
    if (titleEl.querySelector('input')) return;
    const cur = titleEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'title-edit input';
    input.value = cur;
    clear(titleEl);
    titleEl.appendChild(input);
    input.focus();
    input.select();

    function commit() {
      const v = input.value.trim();
      if (v && v !== cur) {
        staging.add(updatePlanTitleOp({ planId: ctx.planId, title: v }));
      } else {
        titleEl.textContent = cur;
      }
    }

    input.addEventListener('blur', commit, { once: true });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') {
        input.removeEventListener('blur', commit);
        titleEl.textContent = cur;
      }
    });
  }

  /* ----- keyboard shortcuts ----- */
  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z (or Ctrl+Y) = redo, Cmd/Ctrl+S = save.
  // Ignored when the user is typing in a form field, so they don't conflict
  // with text editing.
  function isTypingTarget(t) {
    if (!t) return false;
    if (t.matches && t.matches('input, textarea, select, [contenteditable]')) return true;
    return false;
  }
  function onKeydown(e) {
    if (isTypingTarget(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); staging.undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); staging.redo(); }
    else if (k === 's') { e.preventDefault(); doSave(); }
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
  wireHeader();
  renderPendingBar();
  renderToolbar();
  enableDragDrop(document.getElementById('board'), { onMove, onUpload });
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);
}
