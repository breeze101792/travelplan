import { apiGet } from '/static/js/api.js';
import { buildDays, wirePlanHeader, renderPlanToolbar } from '/static/js/plan-header.js';
import { Staging, moveItemOp } from '/static/js/staging.js';

const DAY_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
];

function pickColor(i) { return DAY_COLORS[i % DAY_COLORS.length]; }

let map = null;
let dayLayers = {};
let geocodeCache = {};
let expIndex = null;
let days = [];
let dayCoords = {};
let allItems = [];
let plan = null;
let staging = null;
let setBlockError = null;
let settings = null;
let renderToolbar = () => {};

/* ---------- geocode (proxied through server) ---------- */

async function geocode(query) {
  if (geocodeCache[query] !== undefined) return geocodeCache[query];
  try {
    const res = await fetch('/api/geocode?q=' + encodeURIComponent(query));
    if (!res.ok) { geocodeCache[query] = null; return null; }
    const data = await res.json();
    if (!data || data.lat == null) { geocodeCache[query] = null; return null; }
    const coord = { lat: data.lat, lng: data.lng };
    geocodeCache[query] = coord;
    return coord;
  } catch {
    geocodeCache[query] = null;
    return null;
  }
}

function extractLocationQueries(item) {
  const d = item.details || {};
  const t = item.item_type;
  const queries = [];
  if (t === 'hotel' && d.address) queries.push('ADDR:' + d.address);
  else if (t === 'restaurant' && d.address) queries.push('ADDR:' + d.address);
  else if (t === 'activity' && d.location) queries.push('LOC:' + d.location);
  else if (t === 'activity' && d.address) queries.push('ADDR:' + d.address);
  if (t === 'flight' || t === 'train' || t === 'transport') {
    if (d.from) queries.push('FROM:' + d.from);
    if (d.to) queries.push('TO:' + d.to);
  }
  // Always try the item title as a geocode fallback
  if (item.title) queries.push('TITLE:' + item.title);
  return queries;
}

function queryLabel(q) {
  if (q.startsWith('FROM:')) return 'From ' + q.slice(5);
  if (q.startsWith('TO:')) return 'To ' + q.slice(3);
  if (q.startsWith('ADDR:')) return q.slice(5);
  if (q.startsWith('LOC:')) return q.slice(4);
  if (q.startsWith('TITLE:')) return q.slice(6);
  return q;
}

function qValue(q) {
  if (q.startsWith('FROM:')) return q.slice(5);
  if (q.startsWith('TO:')) return q.slice(3);
  if (q.startsWith('ADDR:')) return q.slice(5);
  if (q.startsWith('LOC:')) return q.slice(4);
  if (q.startsWith('TITLE:')) return q.slice(6);
  return q;
}

/* ---------- draw ---------- */

function removeDay(dayIndex) {
  const layer = dayLayers[dayIndex];
  if (!layer) return;
  for (const m of layer.markers) map.removeLayer(m);
  if (layer.polyline) map.removeLayer(layer.polyline);
}

function drawDay(dayIndex, coords, color) {
  removeDay(dayIndex);
  const markers = [];
  for (const c of coords) {
    const m = L.circleMarker([c.lat, c.lng], {
      radius: 7, fillColor: color, color: '#fff', weight: 2, fillOpacity: .9,
    });
    m.bindTooltip(c.label, { permanent: false, direction: 'top' });
    m.addTo(map);
    markers.push(m);
  }
  let polyline = null;
  if (coords.length > 1) {
    polyline = L.polyline(coords.map(c => [c.lat, c.lng]), { color, weight: 3, opacity: .7 });
    polyline.addTo(map);
  }
  dayLayers[dayIndex] = { markers, polyline, visible: true };
  if (coords.length) {
    const lats = coords.map(c => c.lat);
    const lngs = coords.map(c => c.lng);
    map.fitBounds([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]], { padding: [50, 50], maxZoom: 14 });
  }
}

/* ---------- drag helpers ---------- */

function wireItemDrag(el, itemId) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(itemId));
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
}

function enableDropZone(container) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    const hdr = findDayHeaderAt(container, e.clientY);
    container.querySelectorAll('.day-header.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (hdr) hdr.classList.add('drop-target');
  });
  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) {
      container.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    }
  });
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    const hdr = findDayHeaderAt(container, e.clientY);
    if (!hdr) return;
    const targetDate = hdr.dataset.targetDate;
    const itemId = e.dataTransfer.getData('text/plain');
    if (!itemId || !targetDate) return;
    const item = allItems.find(it => String(it.id) === itemId);
    if (!item || item.item_date === targetDate) return;
    staging.add(moveItemOp({
      planId: plan.id, itemId: Number(itemId), item_date: targetDate,
    }));
    item.item_date = targetDate;
    await reloadAll();
  });
}

function findDayHeaderAt(container, clientY) {
  const headers = [...container.querySelectorAll('.day-header')];
  if (!headers.length) return null;
  for (const h of headers) {
    const r = h.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return h;
  }
  return headers[headers.length - 1];
}

/* ---------- render ---------- */

function renderList() {
  const container = document.getElementById('day-list');
  container.innerHTML = '';
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const color = pickColor(i);
    const isExpanded = i === expIndex;

    const hdr = document.createElement('div');
    hdr.className = 'day-header' + (isExpanded ? ' expanded' : '') + (i === expIndex ? ' active' : '');
    hdr.dataset.targetDate = day.date;
    hdr.innerHTML = `
      <span class="day-dot" style="background:${color}"></span>
      <span class="day-expand-icon">&#9654;</span>
      <span class="day-label">${day.label}</span>
      <span class="day-count">${dayItemsFor(i).length}</span>
    `;
    hdr.addEventListener('click', () => toggleDay(i));
    container.appendChild(hdr);

    if (isExpanded) {
      const items = dayItemsFor(i);
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'day-item';
        empty.style.cssText = 'cursor:default;opacity:.5;';
        empty.innerHTML = '<span class="di-title">No items</span>';
        container.appendChild(empty);
      } else {
        for (const it of items) {
          const row = document.createElement('div');
          row.className = 'day-item';
          row.dataset.itemId = it.id;
          row.innerHTML = `
            <span class="di-type">${it.item_type}</span>
            <span class="di-title">${it.title}</span>
          `;
          wireItemDrag(row, it.id);
          container.appendChild(row);
        }
      }
    }
  }
}

function dayItemsFor(dayIndex) {
  return allItems.filter(it => it.item_date === days[dayIndex].date && it.item_type !== 'hotel');
}

function toggleDay(index) {
  const wasExpanded = expIndex === index;
  if (wasExpanded) {
    expIndex = null;
    for (const idx in dayLayers) removeDay(Number(idx));
    dayLayers = {};
    renderList();
    return;
  }
  expIndex = index;
  for (const idx in dayLayers) removeDay(Number(idx));
  dayLayers = {};
  const coords = dayCoords[index] || [];
  if (coords.length) drawDay(index, coords, pickColor(index));
  renderList();
  const hdr = document.querySelector('.day-header.active');
  if (hdr) hdr.scrollIntoView({ block: 'nearest' });
}

/* ---------- reload ---------- */

async function reloadAll() {
  const res = await apiGet(`/api/plans/${plan.id}/items`);
  allItems = res.items || [];
  dayCoords = {};
  const seen = new Set();
  for (let i = 0; i < days.length; i++) {
    const batch = [];
    for (const it of dayItemsFor(i)) {
      const queries = extractLocationQueries(it);
      for (const q of queries) {
        if (seen.has(q)) continue;
        seen.add(q);
        const coord = await geocode(qValue(q));
        if (coord) {
          batch.push({ lat: coord.lat, lng: coord.lng, label: it.title + ': ' + queryLabel(q), item: it });
        }
      }
    }
    dayCoords[i] = batch;
  }
  for (const idx in dayLayers) removeDay(Number(idx));
  dayLayers = {};
  renderList();
  if (expIndex !== null) {
    const coords = dayCoords[expIndex] || [];
    if (coords.length) drawDay(expIndex, coords, pickColor(expIndex));
  }
  renderToolbar();
}

/* ---------- init ---------- */

export async function initMap(ctx) {
  const container = document.getElementById('map-container');
  if (!container) return;

  const [planRes, itemsRes, settingsRes] = await Promise.all([
    apiGet(`/api/plans/${ctx.planId}`),
    apiGet(`/api/plans/${ctx.planId}/items`),
    apiGet('/api/settings'),
  ]);

  plan = planRes.plan;
  allItems = itemsRes.items || [];
  settings = settingsRes;

  if (!plan.start_date || !plan.end_date) {
    container.innerHTML = '<div class="map-empty">Set a start and end date for this plan to see the map.</div>';
    return;
  }

  staging = new Staging({ planId: ctx.planId });

  setBlockError = (msg) => {
    const bar = document.getElementById('pending-bar');
    if (!bar) return;
    const status = bar.querySelector('.pb-status');
    if (status) status.textContent = msg || '';
  };

  wirePlanHeader({ plan, staging, ctx, onChange: () => {} });

  renderToolbar = () => {
    renderPlanToolbar({
      days, settings, staging, ctx,
      setBlockError,
      getFocusedDay: () => days[0] && days[0].date,
      setFocusedDay: () => {},
      onCreateItem: () => {},
      onChange: () => { reloadAll(); },
    });
  };
  renderToolbar();

  map = L.map(container).setView([35.6762, 139.6503], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);

  days = buildDays(plan);
  dayCoords = {};
  const seen = new Set();
  for (let i = 0; i < days.length; i++) {
    const batch = [];
    for (const it of dayItemsFor(i)) {
      const queries = extractLocationQueries(it);
      for (const q of queries) {
        if (seen.has(q)) continue;
        seen.add(q);
        const coord = await geocode(qValue(q));
        if (coord) {
          batch.push({ lat: coord.lat, lng: coord.lng, label: it.title + ': ' + queryLabel(q), item: it });
        }
      }
    }
    dayCoords[i] = batch;
  }

  enableDropZone(document.getElementById('day-list'));
  renderList();
  expIndex = 0;
  toggleDay(0);
  const anyCoords = Object.values(dayCoords).some(c => c.length);
  if (!anyCoords) map.setView([35.6762, 139.6503], 5);
  renderToolbar();
}

function rateLimiter(ms) {
  let last = 0;
  return () => {
    const now = Date.now();
    const wait = Math.max(0, ms - (now - last));
    last = now + wait;
    return new Promise(r => setTimeout(r, wait));
  };
}