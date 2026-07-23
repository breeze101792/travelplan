import { apiGet, apiPost, apiPatch, apiDel, apiUpload } from '/static/js/api.js';
import { el, clear, loadSettings } from '/static/js/util.js';
import { buildDays, isoOf, addDaysIso, wirePlanHeaderDirect } from '/static/js/plan-header.js';
import { openItemEditor } from '/static/js/item-editor.js';
import { Staging } from '/static/js/staging.js';

const api = { get: apiGet, post: apiPost, patch: apiPatch, del: apiDel, upload: apiUpload };

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
let statusTimer;
let selectedItemId = null;

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
  wirePlanHeaderDirect({ planId: ctx.planId, role: ctx.role });

  const todayStr = isoOf(new Date());
  selectedDay = days.find(d => d.date === todayStr) || days[0];

  renderDayBar();
  renderSchedule();
  startStatusTimer();
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
    renderSchedule();
  }
}

function formatDayLabel(day) {
  if (day.is_buffer) return 'Buffer \u2014 ' + day.date;
  const d = new Date(day.date + 'T12:00:00');
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  return `Day ${day.index} \u2014 ${weekday}, ${month} ${d.getDate()}`;
}

/* ---------------------------------------------------------------- schedule */

function renderSchedule() {
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

  const isToday = dateStr === isoOf(new Date());
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Hotels
  if (hotels.length) {
    content.appendChild(renderHotelBanners(hotels, dateStr));
  }

  // Split non-hotels
  const timed = [];
  const untimed = [];

  for (const item of nonHotels) {
    const tw = itemTimeWindow(item);
    if (tw) {
      timed.push({ ...tw, item });
    } else {
      untimed.push(item);
    }
  }
  timed.sort((a, b) => a.start - b.start);

  if (!timed.length && !untimed.length) {
    content.appendChild(el('div', { class: 'nav-empty', html: 'Nothing planned for this day \u2728' }));
    return;
  }

  // Timed items with section dividers (only for today)
  if (timed.length) {
    if (isToday) {
      const past = timed.filter(tw => tw.end * 60 <= nowMinutes);
      const curr = timed.filter(tw => tw.start * 60 <= nowMinutes && tw.end * 60 > nowMinutes);
      const upcom = timed.filter(tw => tw.start * 60 > nowMinutes);

      if (past.length) {
        content.appendChild(el('div', { class: 'nav-section-divider', text: 'Earlier' }));
        for (const tw of past) content.appendChild(renderCard(tw.item, 'past'));
      }
      if (curr.length) {
        content.appendChild(el('div', { class: 'nav-section-divider now-divider', html: '\u{1F4CD} Now' }));
        for (const tw of curr) content.appendChild(renderCard(tw.item, 'now'));
      }
      if (upcom.length) {
        content.appendChild(el('div', { class: 'nav-section-divider', text: 'Up next' }));
        for (const tw of upcom) content.appendChild(renderCard(tw.item, 'upcoming'));
      }
    } else {
      for (const tw of timed) content.appendChild(renderCard(tw.item, null));
    }
  }

  // Untimed
  if (untimed.length) {
    content.appendChild(el('div', { class: 'nav-section-divider', text: 'Notes' }));
    for (const item of untimed) content.appendChild(renderCard(item, 'untimed'));
  }

  if (isToday) setTimeout(() => scrollToNow(), 150);
}

/* ---------------------------------------------------------------- hotels */

function renderHotelBanners(hotels, dateStr) {
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

/* ---------------------------------------------------------------- card */

function renderCard(item, status) {
  const card = el('div', { class: `nav-card${status ? ' ' + status : ''}`, dataset: { itemId: item.id } });

  card.appendChild(el('div', { class: 'nav-card-indicator', style: `background:${getTypeColor(item.item_type)}` }));

  const body = el('div', { class: 'nav-card-body' });

  // Header: type + time + badge
  const header = el('div', { class: 'nav-card-header' });
  const tw = itemTimeWindow(item);
  const timeStr = tw ? formatItemTime(item, tw) : '';
  const typeIcon = TYPE_ICONS[item.item_type] || '\u{1F4CB}';
  const typeDef = settings.item_types[item.item_type] || {};
  const typeLabel = typeDef.label || TYPE_LABELS[item.item_type] || item.item_type;

  header.appendChild(el('span', { class: 'nav-card-type', text: `${typeIcon} ${typeLabel}` }));
  if (timeStr) header.appendChild(el('span', { class: 'nav-card-time', text: timeStr }));
  if (status === 'now') header.appendChild(el('span', { class: 'nav-badge now-badge', text: 'Now' }));
  else if (status === 'past') header.appendChild(el('span', { class: 'nav-badge past-badge', text: '\u2713' }));
  body.appendChild(header);

  // Title
  body.appendChild(el('div', { class: 'nav-card-title', text: item.title }));

  // Details
  const details = buildCardDetails(item);
  if (details) body.appendChild(details);

  // Image (first image attachment)
  const imgAtt = (item.attachments || []).find(a => a.kind === 'image');
  if (imgAtt) {
    body.appendChild(el('div', { class: 'nav-card-image' }, [
      el('img', { src: `/uploads/${imgAtt.value}`, alt: imgAtt.caption || item.title, loading: 'lazy' }),
    ]));
  }

  // Actions
  const actions = el('div', { class: 'nav-card-actions' });

  for (const att of (item.attachments || [])) {
    if (att.kind === 'link') {
      actions.appendChild(el('a', {
        class: 'nav-card-link',
        href: att.value,
        target: '_blank',
        rel: 'noopener',
        text: `\u{1F517} ${att.caption || 'Link'}`,
      }));
    }
  }

  if (item.geocodes && item.geocodes.length) {
    for (const g of item.geocodes) {
      const label = encodeURIComponent(g.label || item.title);
      const mapGroup = el('span', { class: 'nav-map-group', title: g.label || item.title });
      mapGroup.appendChild(el('a', {
        class: 'nav-card-link map-link', href: `https://www.google.com/maps?q=${g.lat},${g.lng}`,
        target: '_blank', rel: 'noopener', text: 'G',
      }));
      mapGroup.appendChild(el('a', {
        class: 'nav-card-link map-link', href: `https://maps.apple.com/?ll=${g.lat},${g.lng}&q=${label}`,
        target: '_blank', rel: 'noopener', text: 'A',
      }));
      mapGroup.appendChild(el('a', {
        class: 'nav-card-link map-link', href: `https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lng}&zoom=15`,
        target: '_blank', rel: 'noopener', text: 'O',
      }));
      if (g.label) mapGroup.appendChild(el('span', { class: 'nav-map-label', text: g.label }));
      actions.appendChild(mapGroup);
    }
  }

  actions.appendChild(el('button', {
    class: 'nav-card-open',
    text: 'Open details \u25B8',
    onclick: e => { e.stopPropagation(); openEditorFor(item); },
  }));

  body.appendChild(actions);
  card.appendChild(body);

  card.addEventListener('click', (e) => {
    if (e.detail > 1) return;
    if (item.item_type === 'hotel') return;
    e.stopPropagation();
    selectItem(item.id);
  });
  card.addEventListener('dblclick', () => {
    if (item.item_type === 'hotel') return;
    openEditorFor(item);
  });

  return card;
}

function buildCardDetails(item) {
  const d = item.details || {};
  const parts = [];

  if (item.item_type === 'hotel') {
    if (d.address) parts.push(`\u{1F4CD} ${d.address}`);
    if (d.booking_ref) parts.push(`\u{1F511} ${d.booking_ref}`);
  } else if (item.item_type === 'transit') {
    if (d.from && d.to) parts.push(`\u{1F689} ${d.from} \u2192 ${d.to}`);
    if (d.provider) parts.push(`\u{1F3E2} ${d.provider}${d.ref_no ? ' ' + d.ref_no : ''}`);
    if (d.confirmation) parts.push(`\u2705 Conf: ${d.confirmation}`);
  } else if (item.item_type === 'activity') {
    if (d.location) parts.push(`\u{1F4CD} ${d.location}`);
  } else if (item.item_type === 'restaurant') {
    if (d.address) parts.push(`\u{1F4CD} ${d.address}`);
    if (d.party_size) parts.push(`\u{1F465} Party: ${d.party_size}`);
  } else if (item.item_type === 'note') {
    if (d.text) parts.push(d.text);
  }

  if (!parts.length) return null;
  const container = el('div', { class: 'nav-card-details' });
  for (const p of parts) {
    container.appendChild(el('span', { class: 'nav-card-detail', text: p }));
  }
  return container;
}

/* ---------------------------------------------------------------- scroll */

function scrollToNow() {
  const nowCard = document.querySelector('.nav-card.now');
  if (nowCard) {
    nowCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    const first = document.querySelector('.nav-card.upcoming');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/* ---------------------------------------------------------------- timer */

function startStatusTimer() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => {
    const dateStr = selectedDay && selectedDay.date;
    if (dateStr && dateStr === isoOf(new Date())) {
      renderSchedule();
    }
  }, 30000);
}

/* ---------------------------------------------------------------- editor */

function selectItem(id) {
  selectedItemId = id;
  document.querySelectorAll('.nav-card.selected').forEach(el => el.classList.remove('selected'));
  const card = document.querySelector(`.nav-card[data-item-id="${id}"]`);
  if (card) card.classList.add('selected');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.nav-card') && !e.target.closest('.nav-hotel-banner')) {
    selectedItemId = null;
    document.querySelectorAll('.nav-card.selected').forEach(el => el.classList.remove('selected'));
  }
});

function openEditorFor(item) {
  const sessionId = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  openItemEditor(ctx, {
    plan, item, settings, members, staging, sessionId,
    onApplied: async () => {
      await staging.saveAll(api);
      const res = await apiGet(`/api/plans/${ctx.planId}/items`);
      allItems = res.items || [];
      staging = new Staging({ baseItems: allItems, basePlan: plan });
      renderSchedule();
    },
  });
}

/* ---------------------------------------------------------------- helpers */

function itemTimeWindow(item) {
  const d = item.details || {};
  let start = null, end = null;
  if (item.item_type === 'transit') {
    start = timeOfDay(d.depart_time);
    end = timeOfDay(d.arrive_time);
  } else if (item.item_type === 'activity' || item.item_type === 'restaurant') {
    start = timeOfDay(d.start_time);
    end = timeOfDay(d.end_time);
  }
  if (start === null) return null;
  if (end === null || end <= start) end = start + 1;
  if (end > 24) end = 24;
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
  let s = '', e = '';
  if (item.item_type === 'transit') {
    s = extractTime(d.depart_time);
    e = extractTime(d.arrive_time);
  } else {
    s = extractTime(d.start_time);
    e = extractTime(d.end_time);
  }
  if (!s) s = fmtHour(tw.start);
  if (!e) e = fmtHour(tw.end);
  return s + (e ? ' \u2013 ' + e : '');
}

function fmtHour(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function getTypeColor(type) {
  return ({
    hotel: '#3b82f6',
    transit: '#8b5cf6',
    activity: '#10b981',
    restaurant: '#f59e0b',
    note: '#eab308',
  })[type] || '#94a3b8';
}
