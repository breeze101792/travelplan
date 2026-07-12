/* itinerary.js — renders the plan board (day columns + item cards), wires up
 * inline title editing, the add-item toolbar, drag/drop and the item editor.
 * Page contract: window.__CONTEXT__ = { planId, role }.
 */
import { apiGet, apiPost, apiPatch, apiUpload } from '/static/js/api.js';
import { el, clear, fmtDate, money, statusBadge, loadSettings } from '/static/js/util.js';
import { enableDragDrop } from '/static/js/dragdrop.js';
import { openItemEditor } from '/static/js/item-editor.js';

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
  // Boot fetches fire in parallel. They used to await one at a time
  // (settings -> plan -> members -> items -> by-item), so entering a plan
  // waited for 5 sequential round-trips. None of these depend on each other,
  // so they go in a single Promise.all — the page is ready when the slowest
  // one returns instead of the sum of all of them.
  let settings, plan, allMembers, days, base;
  let focusedDay = '';
  let items = [];
  let expenseByItem = new Map(); // itemId -> { total, missing }

  try {
    const [, planRes, memRes, itemsRes, expRes] = await Promise.all([
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
    items = itemsRes.items;
    expenseByItem = new Map((expRes.items || []).map(
      (x) => [x.item_id, { total: x.grand_total_base_cents, missing: x.has_missing_rate }]
    ));
  } catch (e) {
    const board = document.getElementById('board');
    if (board) { clear(board); board.appendChild(el('p', { class: 'muted', text: 'Failed to load: ' + e.message })); }
    return;
  }

  /* ----- rendering ----- */

  function renderCard(item, dayDate) {
    const ti = settings.item_types[item.item_type] || { label: item.item_type };
    const card = el('article', {
      class: `card item ${item.item_type} status-${item.status}`,
      dataset: { itemId: String(item.id), date: dayDate, end: item.end_date || '', type: item.item_type },
    });
    if (ctx.role !== 'viewer') card.draggable = true;

    card.appendChild(el('div', { class: 'card-head' }, [
      el('span', { class: 'card-type', text: ti.label }),
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
      const im = el('img', { class: 'card-thumb', src: `/uploads/${img.value}`, alt: '' });
      im.loading = 'lazy';
      card.appendChild(im);
    }

    const ex = expenseByItem.get(item.id);
    if (ex) {
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

  function render() {
    const board = document.getElementById('board');
    if (!board) return;
    clear(board);
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
    try {
      const [itemsRes, expRes] = await Promise.all([
        apiGet(`/api/plans/${ctx.planId}/items`),
        apiGet(`/api/plans/${ctx.planId}/expenses/by-item`).catch(() => ({ items: [] })),
      ]);
      items = itemsRes.items;
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
    openItemEditor(ctx, { plan, item, settings, members: allMembers, onSave: reload });
  }

  async function createItem(type, dayDate) {
    // Pre-fill cells the app already knows: the item's date is the day column
    // it was added from, and a spanning item (hotel) gets a 1-night checkout
    // (check-in day + 1) so the user doesn't have to type it.
    const ti = settings.item_types[type];
    const body = {
      item_type: type,
      title: '(Untitled)',
      item_date: dayDate || null,
    };
    if (ti && ti.spans_days && dayDate) {
      const d = new Date(dayDate + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      body.end_date = isoOf(d);
    }
    try {
      const res = await apiPost(`/api/plans/${ctx.planId}/items`, body);
      await reload();
      openEditorFor(res.item);
    } catch (e) {
      alert(e.message);
    }
  }

  /* drag/drop callbacks */
  async function onMove(itemId, { item_date, before_id, after_id }) {
    const item = items.find(i => String(i.id) === String(itemId));
    if (!item) return;
    const body = {
      item_date: item_date || null,
      before_id: before_id || null,
      after_id: after_id || null,
    };
    const ti = settings.item_types[item.item_type];
    if (ti && ti.spans_days) body.end_date = item.end_date || null; // hotels: shift start, keep length
    try {
      await apiPost(`/api/items/${itemId}/move`, body);
    } catch (e) {
      alert(e.message);
    } finally {
      await reload();
    }
  }

  async function onUpload(itemId, file) {
    try {
      await apiUpload(`/api/items/${itemId}/upload`, file);
    } catch (e) {
      alert(e.message);
    } finally {
      await reload();
    }
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
      titleEl.title = 'Click to edit title';
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

    async function commit() {
      const v = input.value.trim();
      if (v && v !== cur) {
        try {
          const res = await apiPatch(`/api/plans/${ctx.planId}`, { title: v });
          titleEl.textContent = res.plan.title;
          return;
        } catch (e) {
          alert(e.message);
        }
      }
      titleEl.textContent = cur;
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

  /* ----- boot ----- */
  // items + expense totals were already fetched in parallel above, so just
  // render — no second round-trip. (reload() is still used after mutations.)
  render();
  wireHeader();
  renderToolbar();
  enableDragDrop(document.getElementById('board'), { onMove, onUpload });
}