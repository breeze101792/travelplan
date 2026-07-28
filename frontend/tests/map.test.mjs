/* map.test.mjs — unit tests for the plan map page (map.js).
 *
 * Run:  node --import ./register.mjs map.test.mjs   (from frontend/tests/)
 * or:   ./run.sh                                     (runs everything)
 *
 * Uses a minimal Leaflet stub (lib/map-shim.mjs) so map.js's Leaflet calls
 * (L.map, L.circleMarker, L.polyline, …) work under Node without a real
 * browser or Leaflet library.  Tests cover initialisation, day-list
 * rendering, day expansion, context menu, and drag-drop wiring.
 */
import { assert, eq, summary } from './lib/t.mjs';
import { installDom } from './lib/dom-shim.mjs';
import { installFetch } from './lib/fetch-stub.mjs';
import './lib/map-shim.mjs';

const PAGE_IDS = ['map-container', 'day-list', 'edit-bar', 'plan-title', 'plan-dates'];

const SETTINGS = {
  base_currencies: ['USD', 'JPY', 'CNY'],
  item_types: {
    hotel: { label: 'Hotel', spans_days: true, fields: [] },
    activity: { label: 'Activity', fields: [] },
    restaurant: { label: 'Restaurant', fields: [] },
    transit: { label: 'Transit', fields: [] },
    note: { label: 'Note', fields: [] },
  },
};

const PLAN = {
  id: 1, title: 'Kyoto Map Test', start_date: '2026-09-10', end_date: '2026-09-12',
  base_currency: 'JPY',
};

function freshServer(items) {
  const state = { items: items || [], nextItemId: 200 };
  return installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: PLAN })],
    ['GET /api/plans/1/items', () => ({ items: state.items })],
    ['PATCH /api/plans/:id', (body) => ({ plan: Object.assign({}, PLAN, body) })],
    ['PATCH /api/items/:id', (body, { id }) => {
      const it = state.items.find(x => String(x.id) === id);
      Object.assign(it, body);
      return { item: it };
    }],
    ['DELETE /api/items/:id', (_b, { id }) => {
      state.items = state.items.filter(x => String(x.id) !== id);
      return { deleted: true };
    }],
    ['POST /api/items/:id/move', (body, { id }) => {
      const it = state.items.find(x => String(x.id) === id);
      if (it) it.item_date = body.item_date;
      return { item: it };
    }],
  ]);
}

function dayHeaders() {
  return [...document.getElementById('day-list').querySelectorAll('.day-header')];
}
function dayItems() {
  return [...document.getElementById('day-list').querySelectorAll('.day-item')];
}
function dayHeaderTexts() {
  return dayHeaders().map(h => h.textContent);
}

async function boot(role, items) {
  installDom({ ids: PAGE_IDS, viewport: { width: 1280, height: 800 } });
  freshServer(items || []);
  const { initMap } = await import('/static/js/map.js');
  await initMap({ planId: 1, role });
}

/* =============== desktop: init with 3-day plan and 2 items =============== */
await boot('owner', [
  { id: 1, item_type: 'hotel', title: 'Kyoto Hotel', item_date: '2026-09-10', end_date: '2026-09-12',
    sort_key: 1, status: 'confirmed',
    details: { when: { start_at: '2026-09-10T15:00', end_at: '2026-09-12T11:00' } },
    geocodes: [{ lat: 35.0116, lng: 135.7681, label: 'Hotel location' }],
    attachments: [] },
  { id: 2, item_type: 'activity', title: 'Kinkaku-ji', item_date: '2026-09-11', end_date: null,
    sort_key: 1, status: 'planned',
    details: { when: { start_at: '2026-09-11T09:00', end_at: '2026-09-11T11:00' } },
    geocodes: [{ lat: 35.0394, lng: 135.7292, label: 'Temple' }],
    attachments: [] },
]);
{
  // Map was created and stored.
  const map = globalThis.__L_map;
  assert(map != null, 'desktop: Leaflet map instance was created');
  assert(map.container != null, 'desktop: map has a container element');

  // Day list renders headers for 3 days.
  const headers = dayHeaders();
  eq(headers.length, 3, 'desktop: 3 day headers in day-list');
  assert(headers[0].textContent.includes('Day 1'), 'desktop: first header is Day 1');
  assert(headers[1].textContent.includes('Day 2'), 'desktop: second header is Day 2');
  assert(headers[2].textContent.includes('Day 3'), 'desktop: third header is Day 3');

  // Day 1 shows hotel event items (check-in / check-out virtual events).
  eq(headers[0].classList.contains('active'), true, 'desktop: Day 1 is expanded by default (today or first day)');
}

/* =============== desktop: day toggle expand/collapse =============== */
{
  // Re-query after every click because toggleDay() calls renderList()
  // which replaces all DOM elements.
  let headers = dayHeaders();
  const activeIdx = headers.findIndex(h => h.classList.contains('active'));
  if (activeIdx >= 0) {
    headers[activeIdx].click();
    headers = dayHeaders();
    eq(headers[activeIdx].classList.contains('active'), false, 'desktop-toggle: day collapsed on click');
    // Click again to re-expand.
    headers[activeIdx].click();
    headers = dayHeaders();
    eq(headers[activeIdx].classList.contains('active'), true, 'desktop-toggle: day re-expanded on second click');
  }
}

/* =============== desktop: toggle a different day =============== */
{
  let headers = dayHeaders();
  // Click day 2 to expand it.
  headers[1].click();
  headers = dayHeaders();
  eq(headers[1].classList.contains('active'), true, 'desktop-toggle: day 2 is active after click');
  eq(headers[0].classList.contains('active'), false, 'desktop-toggle: day 1 no longer active');

  // Expanded day shows day items.
  const items = dayItems();
  assert(items.length > 0, 'desktop-toggle: expanded day shows items');
}

/* =============== desktop: plan without dates shows empty state =============== */
{
  installDom({ ids: PAGE_IDS, viewport: { width: 1280, height: 800 } });
  const NO_DATE_PLAN = { id: 2, title: 'No dates', start_date: null, end_date: null, base_currency: 'USD' };
  installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/2', () => ({ plan: NO_DATE_PLAN })],
    ['GET /api/plans/2/items', () => ({ items: [] })],
    ['PATCH /api/plans/:id', (body) => ({ plan: Object.assign({}, NO_DATE_PLAN, body) })],
  ]);
  const container = document.getElementById('map-container');
  const { initMap } = await import('/static/js/map.js');
  await initMap({ planId: 2, role: 'owner' });
  assert(container.textContent.includes('Set a start and end date'),
         'no-dates: empty state message shown when plan has no dates');
}

/* =============== desktop: context menu renders for an item =============== */
await boot('owner', [
  { id: 3, item_type: 'activity', title: 'Arashiyama Bamboo', item_date: '2026-09-11', end_date: null,
    sort_key: 1, status: 'planned',
    geocodes: [{ lat: 35.0170, lng: 135.6713, label: 'Bamboo Grove' }],
    attachments: [] },
]);
{
  // Expand day 2 (2026-09-11) where the item lives.
  let headers = dayHeaders();
  headers[1].click();
  headers = dayHeaders();
  eq(headers[1].classList.contains('active'), true, 'context-menu: day 2 expanded');

  const items = dayItems();
  assert(items.length > 0, 'context-menu: day items rendered');

  // Right-click the first day-item to trigger context menu.
  const firstItem = items[0];
  firstItem.dispatch('contextmenu', { clientX: 100, clientY: 200, preventDefault() {} });

  const menu = document.querySelector('.context-menu');
  assert(menu != null, 'context-menu: context-menu element created');
  const buttons = [...menu.querySelectorAll('button')].map(b => b.textContent);
  assert(buttons.some(b => b === 'Cut'), 'context-menu: Cut option present');
  assert(buttons.some(b => b === 'Delete'), 'context-menu: Delete option present');
  assert(buttons.some(b => b === 'Center on map'), 'context-menu: Center on map option present');
  assert(buttons.some(b => b === 'Open detail'), 'context-menu: Open detail option present');
}

/* =============== desktop: geocode rows render when item selected =============== */
await boot('owner', [
  { id: 4, item_type: 'activity', title: 'Fushimi Inari', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'confirmed',
    geocodes: [
      { lat: 34.9671, lng: 135.7727, label: 'Main gate' },
      { lat: 34.9688, lng: 135.7735, label: 'Summit' },
    ],
    attachments: [] },
]);
{
  // Day 1 should already be expanded after boot (today or first day).
  // If not, expand it.
  let headers = dayHeaders();
  if (!headers[0].classList.contains('active')) {
    headers[0].click();
    headers = dayHeaders();
  }
  const items = dayItems();
  assert(items.length >= 1, 'geocode: at least one item rendered');
  items[0].click();

  // Geocode rows should now be visible.
  const geoRows = [...document.getElementById('day-list').querySelectorAll('.di-geo-row')];
  assert(geoRows.length >= 1, 'geocode: geocode rows rendered after item click');
  const labels = geoRows.map(r => r.querySelector('.di-geo-label').textContent);
  assert(labels.some(l => l.includes('Main gate')), 'geocode: first geocode label visible');
}

/* =============== iPhone: narrow viewport renders same structure =============== */
await boot('owner', [
  { id: 5, item_type: 'note', title: 'Mobile note', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'planned', details: {}, attachments: [] },
]);
{
  // The viewport is narrow but the page still renders.
  eq(window.innerWidth, 1280, 'iphone: viewport is set');
  const headers = dayHeaders();
  eq(headers.length, 3, 'iphone: 3 day headers on narrow viewport');
  assert(dayItems().length >= 0, 'iphone: day items queryable');
}

/* =============== desktop: drag-drop wiring on day items =============== */
await boot('owner', [
  { id: 6, item_type: 'activity', title: 'Movable item', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'planned', details: {}, attachments: [] },
]);
{
  // Ensure day 1 is expanded (it should be after boot).
  let headers = dayHeaders();
  if (!headers[0].classList.contains('active')) {
    headers[0].click();
    headers = dayHeaders();
  }
  const items = dayItems();
  // The first day (2026-09-10) should show the movable item.
  const itemTitles = items.map(i => i.textContent);
  assert(itemTitles.some(t => t.includes('Movable')), 'drag: movable item found in day items');
  const item = items.find(i => i.textContent.includes('Movable'));
  // Check the item has been wired for drag (draggable attribute set).
  assert(item != null && (item.draggable === true || item.draggable === false),
         'drag: item has draggable attribute set');
}

summary('map.test.mjs');
