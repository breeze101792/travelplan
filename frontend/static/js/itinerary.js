/* itinerary.js — renders the plan board (day columns + item cards) and wires
 * the pending-changes bar. All mutations on the page go through the Staging
 * engine; nothing reaches the server until the user clicks Save in the bar.
 *
 * Page contract: window.__CONTEXT__ = { planId, role }.
 */
import { apiGet, apiPatch } from '/static/js/api.js';
import { el, clear, fmtDate, money, statusBadge, loadSettings } from '/static/js/util.js';
import { enableDragDrop } from '/static/js/dragdrop.js';
import { openItemEditor } from '/static/js/item-editor.js';
import {
  Staging, createBlankItemOp, saveItemOp, updateItemOp, updatePlanTitleOp,
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

/* Enumerate the plan's day columns. No dates -> a single undated day (""). */
function buildDays(plan) {
  if (!plan.start_date || !plan.end_date) {
    return [{ date: '', index: 0, label: 'Undated' }];
  }
  const days = [];
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  let d = new Date(plan.start_date + 'T00:00:00');
  const end = new Date(plan.end_date + 'T00:00:00');
  for (let i = 1; d <= end; d.setDate(d.getDate() + 1), i++) {
    days.push({ date: isoOf(d), index: i, label: fmt.format(new Date(d)) });
  }
  return days;
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

/* Group items into day buckets, preserving API sort order (item_date, sort_key, id). */
function groupByDay(items, days, settings) {
  const map = new Map(days.map(d => [d.date, []]));
  for (const item of items) {
    for (const dd of itemDays(item, settings)) {
      if (map.has(dd)) map.get(dd).push(item);
    }
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.sort_key - b.sort_key) || (a.id - b.id));
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
    const items = staging.viewItems();
    const grouped = groupByDay(items, days, settings);
    for (const day of days) {
      const sec = el('section', { class: 'day', dataset: { date: day.date } });
      sec.addEventListener('click', () => setFocusedDay(day.date));
      sec.appendChild(el('h3', {
        class: 'day-title',
        text: day.index ? `Day ${day.index} · ${day.label}` : day.label,
      }));
      const itemsBox = el('div', { class: 'day-items', dataset: { date: day.date } });
      for (const item of grouped.get(day.date)) {
        itemsBox.appendChild(renderCard(item, day.date));
      }
      sec.appendChild(itemsBox);
      const bar = makeAddBar(day.date);
      if (bar) sec.appendChild(bar);
      board.appendChild(sec);
    }
    // Repaint the plan title (in case a title edit was staged or undone).
    const titleEl = document.getElementById('plan-title');
    if (titleEl) titleEl.textContent = staging.viewPlan().title || '';
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
      class: 'pb-status' + (failed ? ' pb-failed' : ''),
      text: staging.saving
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
    const day = days.find(d => d.date === focusedDay) || days[0];
    tb.appendChild(el('span', { class: 'toolbar-label', text: `Quick add${day && day.index ? ` (Day ${day.index})` : ''}:` }));
    for (const [type, ti] of Object.entries(settings.item_types)) {
      const b = el('button', { class: 'toolbar-btn', text: ti.label, title: `Add ${ti.label}` });
      b.type = 'button';
      b.addEventListener('click', () => createItem(type, focusedDay));
      tb.appendChild(b);
    }
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
    const ti = settings.item_types[type];
    let defaultEnd = null;
    if (ti && ti.spans_days && dayDate) {
      const d = new Date(dayDate + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      defaultEnd = isoOf(d);
    }
    const sessionId = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const op = createBlankItemOp({
      planId: ctx.planId, item_type: type, item_date: dayDate || null,
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

  /* ----- inline plan title editing (owner only) ----- */

  function wireHeader() {
    const datesEl = document.getElementById('plan-dates');
    if (datesEl) {
      if (plan.start_date && plan.end_date) {
        datesEl.textContent = `${fmtDate(plan.start_date)} → ${fmtDate(plan.end_date)}`;
      } else if (plan.start_date) {
        datesEl.textContent = fmtDate(plan.start_date);
      } else {
        datesEl.textContent = 'Dates not set';
      }
    }
    const titleEl = document.getElementById('plan-title');
    if (titleEl && ctx.role === 'owner') {
      titleEl.classList.add('editable');
      titleEl.title = 'Click to edit title (saves on click Save in the bar)';
      titleEl.addEventListener('click', () => beginTitleEdit(titleEl));
    }
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
