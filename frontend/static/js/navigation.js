import { apiGet, apiPost, apiPatch, apiDel, apiUpload } from '/static/js/api.js';
import { el, clear, loadSettings, fmtDate } from '/static/js/util.js';
import { buildDays, isoOf, addDaysIso } from '/static/js/plan-header.js';
import { openItemEditor } from '/static/js/item-editor.js';
import { Staging } from '/static/js/staging.js';

const api = { get: apiGet, post: apiPost, patch: apiPatch, del: apiDel, upload: apiUpload };

const HOUR_PX = 48;
const TOTAL_HEIGHT = 24 * HOUR_PX;

const TYPE_ICONS = {
  hotel: '\u{1F3E8}',
  transit: '\u{1F686}',
  activity: '\u{1F3D4}\uFE0F',
  restaurant: '\u{1F37D}\uFE0F',
  note: '\u{1F4DD}',
};

const TYPE_LABELS = {
  hotel: 'Hotel',
  transit: 'Transit',
  activity: 'Activity',
  restaurant: 'Restaurant',
  note: 'Note',
};

let ctx, plan, settings, allItems, members, days, staging;
let selectedDay;
let nowInterval;

export async function initNavigation(pageCtx) {
  ctx = pageCtx;

  const [settingsRes, planRes, itemsRes, memRes] = await Promise.all([
    loadSettings(),
    apiGet(`/api/plans/${ctx.planId}`),
    apiGet(`/api/plans/${ctx.planId}/items`),
    apiGet(`/api/plans/${ctx.planId}/members`),
  ]);

  settings = settingsRes;
  plan = planRes.plan;
  allItems = itemsRes.items || [];
  members = memRes ? [memRes.owner, ...(memRes.members || [])] : [];
  days = buildDays(plan);
  staging = new Staging({ baseItems: allItems, basePlan: plan });

  const todayStr = isoOf(new Date());
  selectedDay = days.find(d => d.date === todayStr) || days[0];

  renderDayBar();
  renderView();
  renderPendingBar();

  updateNowLine();
  if (nowInterval) clearInterval(nowInterval);
  nowInterval = setInterval(updateNowLine, 30000);
}

/* ---------------------------------------------------------------- day bar */

function renderDayBar() {
  const container = document.getElementById('nav-page');
  let bar = container.querySelector('#nav-day-bar');
  if (!bar) {
    bar = el('div', { id: 'nav-day-bar' });
    container.appendChild(bar);
  }
  clear(bar);

  const todayStr = isoOf(new Date());

  const prev = el('button', { class: 'nav-day-arrow', text: '\u25C0', title: 'Previous day' });
  const next = el('button', { class: 'nav-day-arrow', text: '\u25B6', title: 'Next day' });
  const select = el('select', { class: 'nav-day-select' });

  days.forEach(d => {
    const isToday = d.date === todayStr;
    const prefix = isToday ? '\u{1F4CD} ' : '';
    const opt = el('option', { value: d.date, text: prefix + formatDayLabel(d) });
    if (d.date === selectedDay.date) opt.selected = true;
    select.appendChild(opt);
  });

  const todayBtn = el('button', {
    class: 'nav-day-today',
    text: '\u{1F4CD} Today',
    title: 'Go to today',
  });
  todayBtn.hidden = (selectedDay.date === todayStr);

  prev.addEventListener('click', () => {
    const idx = days.findIndex(d => d.date === selectedDay.date);
    if (idx > 0) { selectedDay = days[idx - 1]; onDayChange(); }
  });
  next.addEventListener('click', () => {
    const idx = days.findIndex(d => d.date === selectedDay.date);
    if (idx < days.length - 1) { selectedDay = days[idx + 1]; onDayChange(); }
  });
  select.addEventListener('change', () => {
    selectedDay = days.find(d => d.date === select.value) || selectedDay;
    onDayChange();
  });
  todayBtn.addEventListener('click', () => {
    selectedDay = days.find(d => d.date === todayStr) || days[0];
    onDayChange();
  });

  bar.appendChild(prev);
  bar.appendChild(select);
  bar.appendChild(next);
  bar.appendChild(todayBtn);

  function onDayChange() {
    select.value = selectedDay.date;
    todayBtn.hidden = (selectedDay.date === todayStr);
    renderView();
    updateNowLine();
    renderPendingBar();
  }
}

function formatDayLabel(day) {
  if (day.is_buffer) return 'Buffer \u2014 ' + day.date;
  const d = new Date(day.date + 'T12:00:00');
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  return `Day ${day.index} \u2014 ${weekday}, ${month} ${d.getDate()}`;
}

/* ---------------------------------------------------------------- render */

function renderView() {
  const container = document.getElementById('nav-page');
  let content = container.querySelector('#nav-content');
  if (!content) {
    content = el('div', { id: 'nav-content' });
    container.appendChild(content);
  }
  clear(content);

  const dateStr = selectedDay.date;
  const viewItems = staging.viewItems();

  const dayItems = viewItems.filter(item => {
    if (item.item_type === 'hotel') {
      return dateStr >= item.item_date && dateStr < (item.end_date || item.item_date);
    }
    return item.item_date === dateStr;
  });

  const hotels = dayItems.filter(i => i.item_type === 'hotel');
  const nonHotels = dayItems.filter(i => i.item_type !== 'hotel');

  if (hotels.length) {
    content.appendChild(renderHotels(hotels, dateStr));
  }

  const timedItems = [];
  const untimedItems = [];

  for (const item of nonHotels) {
    const tw = itemTimeWindow(item);
    if (tw) {
      timedItems.push({ ...tw, item });
    } else {
      untimedItems.push(item);
    }
  }

  assignColumns(timedItems);

  if (timedItems.length) {
    content.appendChild(renderTimeline(timedItems, dateStr));
  }

  if (untimedItems.length) {
    content.appendChild(renderUntimed(untimedItems));
  }

  if (!hotels.length && !timedItems.length && !untimedItems.length) {
    content.appendChild(el('div', { class: 'nav-empty', html: 'Nothing planned for this day \u2728' }));
  }
}

/* ---------------------------------------------------------------- hotels */

function renderHotels(hotels, dateStr) {
  const section = el('div', { class: 'nav-hotels' });
  for (const hotel of hotels) {
    const d = hotel.details || {};
    const isCheckIn = dateStr === hotel.item_date;
    const isLastNight = addDaysIso(dateStr, 1) === hotel.end_date;

    let stayInfo;
    if (isCheckIn && isLastNight) {
      stayInfo = `Check-in today${d.check_in_time ? ' at ' + d.check_in_time : ''} \u00B7 Check-out tomorrow${d.check_out_time ? ' at ' + d.check_out_time : ''}`;
    } else if (isCheckIn) {
      stayInfo = `Check-in today${d.check_in_time ? ' at ' + d.check_in_time : ''}`;
    } else if (isLastNight) {
      stayInfo = `Check-out tomorrow${d.check_out_time ? ' at ' + d.check_out_time : ''}`;
    } else {
      stayInfo = 'Overnight stay';
    }

    const banner = el('div', { class: 'nav-hotel-banner' }, [
      el('span', { class: 'nav-hotel-icon', text: '\u{1F3E8}' }),
      el('div', { class: 'nav-hotel-info' }, [
        el('div', { class: 'nav-hotel-name', text: hotel.title }),
        el('div', { class: 'nav-hotel-stay', text: stayInfo }),
      ]),
      el('button', { class: 'btn btn-ghost nav-item-open', text: 'Open details \u25B8' }),
    ]);

    banner.querySelector('.nav-item-open').addEventListener('click', e => {
      e.stopPropagation();
      openEditorFor(hotel);
    });
    banner.addEventListener('click', () => openEditorFor(hotel));
    section.appendChild(banner);
  }
  return section;
}

/* ---------------------------------------------------------------- timeline */

function renderTimeline(timedItems, dateStr) {
  const wrap = el('div', { id: 'nav-timeline-wrap' });
  const axis = el('div', { id: 'nav-axis' });
  const itemsArea = el('div', { id: 'nav-items', style: `height:${TOTAL_HEIGHT}px` });

  for (let h = 0; h <= 24; h++) {
    const isMajor = h % 6 === 0;
    const label = String(h).padStart(2, '0') + ':00';
    axis.appendChild(el('div', {
      class: 'nav-axis-label' + (isMajor ? ' major' : ''),
      style: `top:${h * HOUR_PX}px`,
      text: h === 24 ? '00:00' : label,
    }));
    itemsArea.appendChild(el('div', {
      class: 'nav-gridline' + (isMajor ? ' major' : ''),
      style: `top:${h * HOUR_PX}px`,
    }));
  }

  for (const tw of timedItems) {
    itemsArea.appendChild(renderTimedItemCard(tw.item, tw));
  }

  if (dateStr === isoOf(new Date())) {
    const now = new Date();
    const px = ((now.getHours() * 60 + now.getMinutes()) / (24 * 60)) * TOTAL_HEIGHT;
    const line = el('div', { class: 'nav-now-line', style: `top:${px}px`, id: 'nav-now-line' });
    line.appendChild(el('span', { class: 'nav-now-label', text: 'Now' }));
    itemsArea.appendChild(line);
  }

  wrap.appendChild(axis);
  wrap.appendChild(itemsArea);
  return wrap;
}

function renderTimedItemCard(item, tw) {
  const top = tw.start * HOUR_PX;
  const height = Math.max((tw.end - tw.start) * HOUR_PX, 32);
  const col = tw.col || 0;
  const totalCols = tw.totalCols || 1;
  const widthPct = (1 / totalCols) * 100;
  const leftPct = (col / totalCols) * 100;

  const card = el('div', {
    class: `nav-item type-${item.item_type}`,
    style: `top:${top}px;height:${height}px;width:calc(${widthPct}% - 4px);left:calc(${leftPct}% + 2px)`,
  });

  const indicator = el('div', { class: 'nav-item-indicator' });
  const body = el('div', { class: 'nav-item-body' });

  const head = el('div', { class: 'nav-item-head' });
  head.appendChild(el('span', {
    class: 'nav-item-type',
    text: `${TYPE_ICONS[item.item_type] || '\u{1F4CB}'} ${TYPE_LABELS[item.item_type] || item.item_type}`,
  }));
  head.appendChild(el('span', { class: 'nav-item-time', text: formatItemTime(item, tw) }));
  body.appendChild(head);

  body.appendChild(el('div', { class: 'nav-item-title', text: item.title }));

  const details = buildDetailLines(item);
  if (details) body.appendChild(details);

  const openBtn = el('button', { class: 'nav-item-open', text: '\u25B8' });
  openBtn.addEventListener('click', e => {
    e.stopPropagation();
    openEditorFor(item);
  });
  body.appendChild(openBtn);

  card.appendChild(indicator);
  card.appendChild(body);

  card.addEventListener('click', () => openEditorFor(item));

  return card;
}

/* ---------------------------------------------------------------- untimed */

function renderUntimed(items) {
  const section = el('div', { class: 'nav-untimed' });
  section.appendChild(el('div', { class: 'nav-untimed-header', text: 'Untimed' }));

  const grid = el('div', { class: 'nav-untimed-grid' });
  for (const item of items) {
    grid.appendChild(renderUntimedCard(item));
  }
  section.appendChild(grid);
  return section;
}

function renderUntimedCard(item) {
  const d = item.details || {};
  const card = el('div', { class: 'nav-untimed-card', style: `border-left: 3px solid ${getTypeColor(item.item_type)}` });

  card.appendChild(el('span', { class: 'nav-untimed-icon', text: TYPE_ICONS[item.item_type] || '\u{1F4CB}' }));

  const body = el('div', { class: 'nav-untimed-body' });
  body.appendChild(el('div', { class: 'nav-untimed-title', text: item.title }));

  let sub = '';
  if (item.item_type === 'note' && d.text) {
    sub = d.text.length > 80 ? d.text.slice(0, 80) + '\u2026' : d.text;
  } else if (item.item_type === 'activity') {
    sub = d.location || '';
  } else if (item.item_type === 'restaurant') {
    sub = d.address || '';
  } else if (item.item_type === 'transit') {
    sub = d.from && d.to ? `${d.from} \u2192 ${d.to}` : '';
  }
  if (sub) body.appendChild(el('div', { class: 'nav-untimed-sub', text: sub }));

  card.appendChild(body);
  card.appendChild(el('button', { class: 'nav-item-open', text: '\u25B8' }));

  card.addEventListener('click', () => openEditorFor(item));
  card.querySelector('.nav-item-open').addEventListener('click', e => {
    e.stopPropagation();
    openEditorFor(item);
  });

  return card;
}

/* ---------------------------------------------------------------- editor */

function openEditorFor(item) {
  const sessionId = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  openItemEditor(ctx, {
    plan,
    item,
    settings,
    members,
    staging,
    sessionId,
    onApplied: () => { renderView(); renderPendingBar(); },
  });
}

/* ---------------------------------------------------------------- pending bar */

function renderPendingBar() {
  const bar = document.getElementById('pending-bar');
  if (!bar) return;
  clear(bar);
  if (ctx.role === 'viewer') { bar.hidden = true; return; }

  const hasPending = staging.hasPending;
  const canUndo = staging.canUndo;
  const canRedo = staging.canRedo;
  const canSave = hasPending && !staging.saving;
  const failed = staging.failedOpIndex >= 0;
  const lastLabel = hasPending ? staging.ops[staging.pointer - 1].label : '';

  const undoBtn = el('button', {
    type: 'button', class: 'pb-btn', text: '\u21B6 Revert',
    disabled: !canUndo,
    onclick: () => { staging.undo(); renderView(); renderPendingBar(); },
  });
  const redoBtn = el('button', {
    type: 'button', class: 'pb-btn', text: '\u21B7 Redo',
    disabled: !canRedo,
    onclick: () => { staging.redo(); renderView(); renderPendingBar(); },
  });
  const saveBtn = el('button', {
    type: 'button', class: 'pb-btn pb-save',
    text: staging.saving ? 'Saving\u2026' : 'Save',
    disabled: !canSave,
    onclick: async () => {
      await staging.saveAll(api);
      renderPendingBar();
      // Reload fresh items from server after save
      apiGet(`/api/plans/${ctx.planId}/items`).then(res => {
        allItems = res.items || [];
        staging = new Staging({ baseItems: allItems, basePlan: plan });
        renderView();
        renderPendingBar();
      });
    },
  });

  const statusClass = 'pb-status' + (failed ? ' pb-failed' : '');
  let statusText;
  if (staging.saving) statusText = 'Saving changes\u2026';
  else if (failed) statusText = `Save failed: ${staging.failedError}`;
  else if (hasPending) statusText = `${staging.pendingCount} pending \u2014 last: ${lastLabel}`;
  else statusText = 'All changes saved';

  bar.append(undoBtn, redoBtn, saveBtn, el('span', { class: statusClass, text: statusText }));
  bar.hidden = false;
}

/* ---------------------------------------------------------------- helpers */

function itemTimeWindow(item) {
  const d = item.details || {};
  let start = null;
  let end = null;

  if (item.item_type === 'transit') {
    start = timeOfDay(d.depart_time);
    end = timeOfDay(d.arrive_time);
  } else if (item.item_type === 'activity' || item.item_type === 'restaurant') {
    start = timeOfDay(d.start_time);
    end = timeOfDay(d.end_time);
  }

  if (start === null) return null;
  if (end === null || end <= start) end = start + 1;
  return { start, end };
}

function timeOfDay(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{2}):(\d{2})/);
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
}

function extractTime(v) {
  if (!v) return '';
  const m = String(v).match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

function formatItemTime(item, tw) {
  const d = item.details || {};
  let startStr = '';
  let endStr = '';

  if (item.item_type === 'transit') {
    startStr = extractTime(d.depart_time);
    endStr = extractTime(d.arrive_time);
  } else {
    startStr = extractTime(d.start_time);
    endStr = extractTime(d.end_time);
  }

  if (!startStr) startStr = fmtHour(tw.start);
  if (!endStr) endStr = fmtHour(tw.end);

  return startStr + (endStr ? ` \u2013 ${endStr}` : '');
}

function fmtHour(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function buildDetailLines(item) {
  const d = item.details || {};
  const lines = [];

  if (item.item_type === 'transit') {
    if (d.from && d.to) lines.push(`${d.from} \u2192 ${d.to}`);
    if (d.provider) lines.push(`${d.provider}${d.ref_no ? ' ' + d.ref_no : ''}`);
    if (d.confirmation) lines.push(`Conf: ${d.confirmation}`);
  } else if (item.item_type === 'activity') {
    if (d.location) lines.push(`\u{1F4CD} ${d.location}`);
    if (d.note) lines.push(d.note);
  } else if (item.item_type === 'restaurant') {
    if (d.address) lines.push(`\u{1F4CD} ${d.address}`);
    if (d.party_size) lines.push(`Party: ${d.party_size}`);
    if (d.note) lines.push(d.note);
  } else if (item.item_type === 'note') {
    if (d.text) lines.push(d.text);
  }

  if (!lines.length) return null;
  const container = el('div', { class: 'nav-item-details' });
  for (const line of lines) {
    container.appendChild(el('span', { text: line }));
  }
  return container;
}

function getTypeColor(type) {
  const colors = {
    hotel: '#3b82f6',
    transit: '#8b5cf6',
    activity: '#10b981',
    restaurant: '#f59e0b',
    note: '#eab308',
  };
  return colors[type] || '#94a3b8';
}

function assignColumns(intervals) {
  if (!intervals.length) return;
  intervals.sort((a, b) => a.start - b.start || (b.end - b.end) - (a.end - a.start));

  const ends = [];
  for (const iv of intervals) {
    let placed = false;
    for (let col = 0; col < ends.length; col++) {
      if (ends[col] <= iv.start) {
        ends[col] = iv.end;
        iv.col = col;
        placed = true;
        break;
      }
    }
    if (!placed) {
      ends.push(iv.end);
      iv.col = ends.length - 1;
    }
  }

  for (const iv of intervals) {
    let maxCol = 0;
    for (const other of intervals) {
      if (other === iv) continue;
      if (other.start < iv.end && other.end > iv.start) {
        maxCol = Math.max(maxCol, other.col);
      }
    }
    iv.totalCols = maxCol + 1;
  }
}

function updateNowLine() {
  const line = document.getElementById('nav-now-line');
  if (!line) return;
  const now = new Date();
  const px = ((now.getHours() * 60 + now.getMinutes()) / (24 * 60)) * TOTAL_HEIGHT;
  line.style.top = `${px}px`;
}
