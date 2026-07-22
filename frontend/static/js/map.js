import { apiGet } from '/static/js/api.js';
import { buildDays } from '/static/js/plan-header.js';

const DAY_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
];

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=';

function pickColor(i) { return DAY_COLORS[i % DAY_COLORS.length]; }

let map = null;
let dayLayers = {};
let geocodeCache = {};
let activeDayIndex = null;
let days = [];
let dayCoords = {};
let allItems = [];
let plan = null;

/* ---------- geocode ---------- */

async function geocode(query) {
  if (geocodeCache[query] !== undefined) return geocodeCache[query];
  try {
    const res = await fetch(NOMINATIM_URL + encodeURIComponent(query), {
      headers: { 'User-Agent': 'TravelPlan/1.0' },
    });
    if (!res.ok) { geocodeCache[query] = null; return null; }
    const data = await res.json();
    if (!data.length) { geocodeCache[query] = null; return null; }
    const coord = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    geocodeCache[query] = coord;
    return coord;
  } catch {
    geocodeCache[query] = null;
    return null;
  }
}

function extractLocationQueries(item) {
  const d = item.details || {};
  const queries = [];
  const t = item.item_type;
  if (t === 'hotel' && d.address) queries.push(d.address);
  else if (t === 'restaurant' && d.address) queries.push(d.address);
  else if (t === 'activity' && d.location) queries.push(d.location);
  else if (t === 'activity' && d.address) queries.push(d.address);
  else if ((t === 'flight' || t === 'train' || t === 'transport') && d.to) queries.push(d.to);
  if (item.title && /^[A-Z]/.test(item.title)) queries.push(item.title);
  return queries;
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

/* ---------- drawer ---------- */

function openDrawer(index) {
  const drawer = document.getElementById('item-drawer');
  const title = document.getElementById('drawer-title');
  const list = document.getElementById('drawer-items');
  if (!drawer) return;

  const dayItems = allItems.filter(it => it.item_date === days[index].date && it.item_type !== 'hotel');
  title.textContent = days[index].label + ' — ' + dayItems.length + ' item' + (dayItems.length !== 1 ? 's' : '');
  list.innerHTML = '';

  if (!dayItems.length) {
    list.innerHTML = '<div class="drawer-empty">No items for this day</div>';
  } else {
    for (const it of dayItems) {
      const card = document.createElement('div');
      card.className = 'drawer-item';
      card.draggable = true;
      card.dataset.itemId = it.id;
      card.dataset.sourceDay = it.item_date;
      card.innerHTML = `
        <div class="di-type">${it.item_type}</div>
        <div class="di-title">${it.title}</div>
      `;
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(it.id));
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => { card.classList.remove('dragging'); });
      list.appendChild(card);
    }
  }

  document.getElementById('drawer-close').onclick = () => { drawer.hidden = true; };
  drawer.hidden = false;
}

/* ---------- UI ---------- */

function renderDayList() {
  const container = document.getElementById('day-list');
  container.innerHTML = '';
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const color = pickColor(i);
    const count = (dayCoords[i] || []).length;
    const card = document.createElement('div');
    card.className = 'day-card' + (i === activeDayIndex ? ' active' : '');
    card.dataset.dayIndex = i;
    card.dataset.targetDate = day.date;
    card.innerHTML = `
      <span class="day-dot" style="background:${color}"></span>
      <span class="day-label">${day.label}</span>
      <span class="day-count">${count} place${count !== 1 ? 's' : ''}</span>
    `;
    card.addEventListener('click', () => selectDay(i));

    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop-target'); });
    card.addEventListener('dragleave', () => { card.classList.remove('drop-target'); });
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drop-target');
      const itemId = e.dataTransfer.getData('text/plain');
      if (!itemId) return;
      const targetDate = card.dataset.targetDate;
      if (!targetDate) return;
      const item = allItems.find(it => String(it.id) === itemId);
      if (!item || item.item_date === targetDate) return;

      try {
        const res = await fetch(`/api/items/${itemId}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_date: targetDate }),
        });
        if (!res.ok) return;
        item.item_date = targetDate;
        await reloadMap();
      } catch {}
    });

    container.appendChild(card);
  }
}

async function reloadMap() {
  const res = await apiGet(`/api/plans/${plan.id}/items`);
  allItems = res.items || [];
  dayCoords = {};
  const seen = new Set();
  const limiter = rateLimiter(1000);
  for (let i = 0; i < days.length; i++) {
    const dayItems = allItems.filter(it => it.item_date === days[i].date && it.item_type !== 'hotel');
    const batch = [];
    for (const it of dayItems) {
      const queries = extractLocationQueries(it);
      for (const q of queries) {
        if (seen.has(q)) continue;
        seen.add(q);
        await limiter();
        const coord = await geocode(q);
        if (coord) {
          batch.push({ lat: coord.lat, lng: coord.lng, label: it.title, item: it });
          break;
        }
      }
    }
    dayCoords[i] = batch;
  }
  for (const idx in dayLayers) removeDay(Number(idx));
  dayLayers = {};
  renderDayList();
  if (activeDayIndex !== null) {
    const activeCoords = dayCoords[activeDayIndex] || [];
    if (activeCoords.length) drawDay(activeDayIndex, activeCoords, pickColor(activeDayIndex));
    openDrawer(activeDayIndex);
  }
}

function selectDay(index) {
  activeDayIndex = index;
  for (const idx in dayLayers) removeDay(Number(idx));
  dayLayers = {};
  const coords = dayCoords[index] || [];
  if (coords.length) drawDay(index, coords, pickColor(index));
  renderDayList();
  openDrawer(index);
}

/* ---------- init ---------- */

export async function initMap(ctx) {
  const container = document.getElementById('map-container');
  if (!container) return;

  const [planRes, itemsRes] = await Promise.all([
    apiGet(`/api/plans/${ctx.planId}`),
    apiGet(`/api/plans/${ctx.planId}/items`),
  ]);

  plan = planRes.plan;
  allItems = itemsRes.items || [];

  if (!plan.start_date || !plan.end_date) {
    container.innerHTML = '<div class="map-empty">Set a start and end date for this plan to see the map.</div>';
    return;
  }

  map = L.map(container).setView([35.6762, 139.6503], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);

  days = buildDays(plan);
  dayCoords = {};
  const seen = new Set();
  const limiter = rateLimiter(1000);
  for (let i = 0; i < days.length; i++) {
    const dayItems = allItems.filter(it => it.item_date === days[i].date && it.item_type !== 'hotel');
    const batch = [];
    for (const it of dayItems) {
      const queries = extractLocationQueries(it);
      for (const q of queries) {
        if (seen.has(q)) continue;
        seen.add(q);
        await limiter();
        const coord = await geocode(q);
        if (coord) {
          batch.push({ lat: coord.lat, lng: coord.lng, label: it.title, item: it });
          break;
        }
      }
    }
    dayCoords[i] = batch;
  }

  renderDayList();

  const anyCoords = Object.values(dayCoords).some(c => c.length);
  if (days.length) {
    selectDay(0);
    if (!anyCoords) map.setView([35.6762, 139.6503], 5);
  }
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