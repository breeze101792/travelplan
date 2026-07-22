import { apiGet } from '/static/js/api.js';
import { buildDays } from '/static/js/plan-header.js';

const DAY_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
];

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=';

function pickColor(i) { return DAY_COLORS[i % DAY_COLORS.length]; }

let map = null;
let dayLayers = {};       // dayIndex -> { markers: [], polyline: null, visible: true }
let geocodeCache = {};    // address string -> { lat, lng } | null
let activeDayIndex = null;

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
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    const coord = { lat, lng };
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
  const itemType = item.item_type;
  if (itemType === 'hotel' && d.address) queries.push(d.address);
  else if (itemType === 'restaurant' && d.address) queries.push(d.address);
  else if (itemType === 'activity' && d.location) queries.push(d.location);
  else if (itemType === 'activity' && d.address) queries.push(d.address);
  else if ((itemType === 'flight' || itemType === 'train' || itemType === 'transport') && d.to) queries.push(d.to);
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
    const pts = coords.map(c => [c.lat, c.lng]);
    polyline = L.polyline(pts, { color, weight: 3, opacity: .7 });
    polyline.addTo(map);
  }

  dayLayers[dayIndex] = { markers, polyline, visible: true };

  if (coords.length) {
    const allLats = coords.map(c => c.lat);
    const allLngs = coords.map(c => c.lng);
    const bounds = [[Math.min(...allLats), Math.min(...allLngs)], [Math.max(...allLats), Math.max(...allLngs)]];
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
  }
}

/* ---------- UI ---------- */

function renderDayList(days, dayCoords) {
  const container = document.getElementById('day-list');
  container.innerHTML = '';
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const color = pickColor(i);
    const count = (dayCoords[i] || []).length;
    const card = document.createElement('div');
    card.className = 'day-card' + (i === activeDayIndex ? ' active' : '');
    card.innerHTML = `
      <span class="day-dot" style="background:${color}"></span>
      <span class="day-label">${day.label}</span>
      <span class="day-count">${count} place${count !== 1 ? 's' : ''}</span>
    `;
    card.addEventListener('click', () => selectDay(i, days, dayCoords));
    container.appendChild(card);
  }
}

function selectDay(index, days, dayCoords) {
  activeDayIndex = index;
  for (const idx in dayLayers) removeDay(Number(idx));
  dayLayers = {};
  const coords = dayCoords[index] || [];
  if (coords.length) {
    drawDay(index, coords, pickColor(index));
  }
  renderDayList(days, dayCoords);
}

/* ---------- init ---------- */

export async function initMap(ctx) {
  const container = document.getElementById('map-container');
  if (!container) return;

  const [planRes, itemsRes] = await Promise.all([
    apiGet(`/api/plans/${ctx.planId}`),
    apiGet(`/api/plans/${ctx.planId}/items`),
  ]);

  const plan = planRes.plan;
  const allItems = itemsRes.items || [];

  if (!plan.start_date || !plan.end_date) {
    container.innerHTML = '<div class="map-empty">Set a start and end date for this plan to see the map.</div>';
    return;
  }

  map = L.map(container).setView([35.6762, 139.6503], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);

  const days = buildDays(plan);
  const dayCoords = {};
  const seen = new Set();

  const limiter = rateLimiter(1000);
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const items = allItems.filter(it => it.item_date === day.date && it.item_type !== 'hotel');
    const batch = [];

    for (const it of items) {
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

  renderDayList(days, dayCoords);

  const anyCoords = Object.values(dayCoords).some(c => c.length);
  if (days.length) {
    if (anyCoords) {
      selectDay(0, days, dayCoords);
    } else {
      map.setView([35.6762, 139.6503], 5);
    }
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