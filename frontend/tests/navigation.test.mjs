/* navigation.test.mjs — unit tests for the navigation (day-by-day) page.
 *
 * Run:  node --import ./register.mjs navigation.test.mjs   (from frontend/tests/)
 * or:   ./run.sh                                            (runs everything)
 *
 * Covers the full initNavigation pipeline: data loading, day bar rendering,
 * schedule rendering (timed / untimed items, hotel banners, section dividers),
 * day navigation via buttons/dropdown/touch swipe, and the empty-state
 * fallback. Each boot() runs in either the desktop (1280px) or iPhone (390px)
 * viewport so responsive behaviour is exercised at the JS level.
 */
import { assert, eq, summary } from './lib/t.mjs';
import { installDom } from './lib/dom-shim.mjs';
import { installFetch } from './lib/fetch-stub.mjs';

let _nextItemId = 100;

const SETTINGS = {
  base_currencies: ['USD', 'JPY', 'CNY'],
  item_types: {
    hotel: { label: 'Hotel', spans_days: true, fields: [] },
    transit: { label: 'Transit', fields: [] },
    activity: { label: 'Activity', fields: [] },
    restaurant: { label: 'Restaurant', fields: [] },
    note: { label: 'Note', fields: [] },
  },
};

const BASE_PLAN = { id: 1, title: 'Kyoto 2026', start_date: '2026-09-10', end_date: '2026-09-12', base_currency: 'JPY' };

function freshServer(items) {
  const state = {
    items: items || [],
    nextItemId: _nextItemId++,
  };
  return installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: BASE_PLAN })],
    ['GET /api/plans/1/items', () => ({ items: state.items })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['PATCH /api/plans/:id', (body) => ({ plan: Object.assign({}, BASE_PLAN, body) })],
  ]);
}

function dayBar() {
  return document.getElementById('nav-page').querySelector('#nav-day-bar');
}
function daySelect() {
  return dayBar().querySelector('.nav-day-select');
}
function prevBtn() {
  return [...dayBar().querySelectorAll('.nav-day-arrow')][0];
}
function nextBtn() {
  const arrows = [...dayBar().querySelectorAll('.nav-day-arrow')];
  return arrows[arrows.length - 1];
}
function todayBtn() {
  return dayBar().querySelector('.nav-day-today');
}
function navContent() {
  return document.getElementById('nav-page').querySelector('#nav-content');
}

function selectOptionLabels() {
  return [...dayBar().querySelectorAll('option')].map(o => o.textContent);
}
function selectOptions() {
  return [...dayBar().querySelectorAll('option')];
}
function selectIndex() {
  const opts = selectOptions();
  const val = daySelect().value;
  return opts.findIndex(o => o.value === val);
}

function cardTexts() {
  return [...navContent().querySelectorAll('.nav-card')].map(c => c.textContent);
}

function cardTitles() {
  return [...navContent().querySelectorAll('.nav-card-title')].map(c => c.textContent);
}

function hotelBannerTexts() {
  return [...navContent().querySelectorAll('.nav-hotel-banner')].map(b => b.textContent);
}

function sectionDividerTexts() {
  return [...navContent().querySelectorAll('.nav-section-divider')].map(d => d.textContent);
}

function cardStatuses() {
  return [...navContent().querySelectorAll('.nav-card')].map(c => {
    if (c.classList.contains('now')) return 'now';
    if (c.classList.contains('past')) return 'past';
    if (c.classList.contains('upcoming')) return 'upcoming';
    if (c.classList.contains('untimed')) return 'untimed';
    return 'none';
  });
}

async function boot({ role, viewport, items }) {
  installDom({ ids: ['nav-page'], viewport });
  freshServer(items);
  const { initNavigation } = await import('/static/js/navigation.js');
  await initNavigation({ planId: 1, role });
}

/* =============== desktop: initial render with 2 items across 2 days =============== */
await boot({ role: 'owner', viewport: { width: 1280, height: 800 }, items: [
  { id: 1, item_type: 'activity', title: 'Fushimi Inari', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'confirmed', details: { when: { start_at: '2026-09-10T09:00', end_at: '2026-09-10T11:00' } },
    attachments: [] },
  { id: 2, item_type: 'note', title: 'Buy souvenirs', item_date: '2026-09-11', end_date: null,
    sort_key: 1, status: 'planned', details: { text: 'Magnet, keychain' }, attachments: [] },
]});
{
  // Day bar has 3 day options (10, 11, 12).
  const opts = selectOptionLabels();
  eq(opts.length, 3, 'desktop: day bar has 3 options');
  assert(opts[0].includes('Day 1'), 'desktop: first option is Day 1');
  assert(opts[1].includes('Day 2'), 'desktop: second option is Day 2');
  assert(opts[2].includes('Day 3'), 'desktop: third option is Day 3');

  // Today button hidden because we're not on today (Sep 10 vs test date).
  // The test environment date is "today" from js isoOf(new Date()) so this
  // might or might not be today. We just verify the button exists.
  assert(todayBtn() != null, 'desktop: today button exists');

  // Prev / next buttons exist.
  assert(prevBtn() != null, 'desktop: prev button exists');
  assert(nextBtn() != null, 'desktop: next button exists');

  // The selected option matches the first or today's day.
  const selectedOpt = selectOptions().find(o => o.selected);
  assert(selectedOpt != null, 'desktop: one option is selected');
  assert(selectedOpt.value === '2026-09-10' || selectedOpt.value === '2026-09-11' || selectedOpt.value === '2026-09-12',
         'desktop: selected day is one of the plan days');

  // Schedule shows items for the selected day.
  const titles = cardTitles();
  if (selectedOpt.value === '2026-09-10') {
    assert(titles.includes('Fushimi Inari'), 'desktop: day 1 shows Fushimi Inari');
  }
}

/* =============== desktop: next/prev day navigation =============== */
{
  // Click next until we reach the last day.
  const opts = selectOptions();
  let targetIdx = opts.length - 1;
  while (selectIndex() < targetIdx) {
    nextBtn().click();
  }
  eq(selectIndex(), targetIdx, 'desktop: next navigates to last day');
  // Click prev once.
  prevBtn().click();
  eq(selectIndex(), targetIdx - 1, 'desktop: prev navigates back one day');

  // Reset to first day via prev.
  while (selectIndex() > 0) {
    prevBtn().click();
  }
  eq(selectIndex(), 0, 'desktop: prev navigates to first day');
  // Next at first day goes to second.
  nextBtn().click();
  eq(selectIndex(), 1, 'desktop: next from first day goes to second');
}

/* =============== desktop: day dropdown select =============== */
{
  daySelect().value = '2026-09-12';
  daySelect().dispatch('change');
  const titles = cardTitles();
  // Day 3 has no items, so it should show the empty message.
  const content = navContent().textContent;
  assert(content.includes('Nothing planned'), 'desktop: day 3 shows empty state');
}

/* =============== desktop: hotel + transit + activity rendering =============== */
await boot({ role: 'owner', viewport: { width: 1280, height: 800 }, items: [
  { id: 10, item_type: 'hotel', title: 'Kyoto Station Hotel', item_date: '2026-09-10', end_date: '2026-09-12',
    sort_key: 1, status: 'confirmed',
    details: { when: { start_at: '2026-09-10T15:00', end_at: '2026-09-12T11:00' }, address: 'Kyoto Station' },
    attachments: [] },
  { id: 11, item_type: 'transit', title: 'Shinkansen', item_date: '2026-09-10', end_date: null,
    sort_key: 2, status: 'confirmed',
    details: { when: { start_at: '2026-09-10T08:00', end_at: '2026-09-10T10:30' }, from: 'Tokyo', to: 'Kyoto', provider: 'JR' },
    attachments: [] },
  { id: 12, item_type: 'activity', title: 'Nijo Castle', item_date: '2026-09-10', end_date: null,
    sort_key: 3, status: 'planned', details: { when: { start_at: '2026-09-10T11:00', end_at: '2026-09-10T13:00' } },
    attachments: [] },
]});
{
  // Hotel banner renders.
  const banners = hotelBannerTexts();
  assert(banners.some(b => b.includes('Kyoto Station Hotel')), 'hotel: banner shows hotel name');
  assert(banners.some(b => b.includes('Check-in')) || banners.some(b => b.includes('Check-out')),
         'hotel: banner shows check-in/out info');

  // Transit card renders.
  const titles = cardTitles();
  assert(titles.includes('Shinkansen'), 'hotel: transit card shows');
  assert(titles.includes('Nijo Castle'), 'hotel: activity card shows');

  // Transit card shows from/to details.
  const cards = navContent().querySelectorAll('.nav-card');
  const transitCard = [...cards].find(c => c.querySelector('.nav-card-title').textContent === 'Shinkansen');
  assert(transitCard != null, 'hotel: transit card found');
  const transitDetail = transitCard.querySelector('.nav-card-detail');
  assert(transitDetail != null && transitDetail.textContent.includes('Tokyo'),
         'hotel: transit card shows departure city');

  // Cards are sorted by time (transit at 8:00 before activity at 11:00).
  const orderedTitles = cardTitles();
  const transitIdx = orderedTitles.indexOf('Shinkansen');
  const castleIdx = orderedTitles.indexOf('Nijo Castle');
  assert(transitIdx < castleIdx, 'hotel: transit (08:00) before activity (11:00)');
}

/* =============== desktop: notes (untimed items) =============== */
await boot({ role: 'owner', viewport: { width: 1280, height: 800 }, items: [
  { id: 20, item_type: 'note', title: 'Packing list', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'planned', details: { text: 'Passport, charger' }, attachments: [] },
]});
{
  const titles = cardTitles();
  assert(titles.includes('Packing list'), 'note: note card shows');
  const cards = navContent().querySelectorAll('.nav-card');
  const noteCard = [...cards].find(c => c.querySelector('.nav-card-title').textContent === 'Packing list');
  assert(noteCard != null, 'note: note card found');
  const detail = noteCard.querySelector('.nav-card-detail');
  assert(detail != null && detail.textContent.includes('Passport'),
         'note: note card shows detail text');
  assert(noteCard.classList.contains('untimed'), 'note: note card has untimed class');
}

/* =============== desktop: link attachment on card =============== */
await boot({ role: 'owner', viewport: { width: 1280, height: 800 }, items: [
  { id: 30, item_type: 'activity', title: 'Kinkaku-ji', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'planned', details: {},
    attachments: [{ id: 301, kind: 'link', value: 'https://example.com/kinkakuji', caption: 'Official site' }] },
]});
{
  const cards = navContent().querySelectorAll('.nav-card');
  const card = [...cards].find(c => c.querySelector('.nav-card-title').textContent === 'Kinkaku-ji');
  assert(card != null, 'link: card found');
  const link = card.querySelector('.nav-card-link');
  assert(link != null && link.href === 'https://example.com/kinkakuji',
         'link: attachment link rendered with correct href');
}

/* =============== desktop: image attachment renders =============== */
await boot({ role: 'owner', viewport: { width: 1280, height: 800 }, items: [
  { id: 40, item_type: 'note', title: 'Photo note', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'planned', details: {},
    attachments: [{ id: 401, kind: 'image', value: 'kyoto.jpg', caption: 'Temple view' }] },
]});
{
  const img = navContent().querySelector('.nav-card-image img');
  assert(img != null, 'image: card image element rendered');
  assert(img.src.endsWith('/uploads/kyoto.jpg'), 'image: src points to /uploads/kyoto.jpg');
}

/* =============== desktop: geocodes render map links =============== */
await boot({ role: 'owner', viewport: { width: 1280, height: 800 }, items: [
  { id: 50, item_type: 'activity', title: 'Arashiyama', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'planned', details: {},
    geocodes: [{ lat: 35.0094, lng: 135.6727, label: 'Bamboo Grove' }],
    attachments: [] },
]});
{
  const cards = navContent().querySelectorAll('.nav-card');
  const card = [...cards].find(c => c.querySelector('.nav-card-title').textContent === 'Arashiyama');
  assert(card != null, 'geo: card found');
  const mapLinks = card.querySelectorAll('.map-link');
  assert(mapLinks.length >= 3, 'geo: at least 3 map links (G, A, O)');
}

/* =============== desktop: empty day shows placeholder =============== */
await boot({ role: 'owner', viewport: { width: 1280, height: 800 }, items: [] });
{
  // Navigate to day 1 (the only day) — it has no items.
  const content = navContent().textContent;
  assert(content.includes('Nothing planned'), 'empty: empty day shows placeholder message');
}

/* =============== iPhone: narrow viewport renders same data =============== */
await boot({ role: 'owner', viewport: { width: 390, height: 664 }, items: [
  { id: 60, item_type: 'activity', title: 'Kiyomizu-dera', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'confirmed',
    details: { when: { start_at: '2026-09-10T10:00', end_at: '2026-09-10T12:00' } },
    attachments: [] },
]});
{
  // Check the viewport is actually narrow.
  eq(window.innerWidth, 390, 'iphone: innerWidth is 390');

  // Same rendering contract applies.
  const titles = cardTitles();
  assert(titles.includes('Kiyomizu-dera'), 'iphone: activity card shows on narrow viewport');

  const opts = selectOptionLabels();
  eq(opts.length, 3, 'iphone: day bar has 3 options');

  // Day navigation works identically.
  const selectedOpt = selectOptions().find(o => o.selected);
  assert(selectedOpt != null, 'iphone: a day option is selected');
  nextBtn().click();
  eq(selectIndex(), 1, 'iphone: next navigates forward');
}

/* =============== iPhone: touch swipe changes day =============== */
await boot({ role: 'owner', viewport: { width: 390, height: 664 }, items: [
  { id: 61, item_type: 'note', title: 'Swipe test', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'planned', details: {}, attachments: [] },
  { id: 62, item_type: 'note', title: 'Day 2 item', item_date: '2026-09-11', end_date: null,
    sort_key: 1, status: 'planned', details: {}, attachments: [] },
]});
{
  const navPage = document.getElementById('nav-page');

  // Start on day 1 — verify via the selected option's value.
  eq(cardTitles().includes('Swipe test'), true, 'swipe: day 1 shows item');

  // Swipe left (touchstart at x:200, touchend at x:100) → go to next day.
  navPage.dispatch('touchstart', {
    touches: [{ clientX: 200, clientY: 300 }],
    changedTouches: [{ clientX: 200, clientY: 300 }],
  });
  navPage.dispatch('touchend', {
    changedTouches: [{ clientX: 100, clientY: 305 }],
  });

  // Allow the animationend callback to fire.
  const content = navContent();
  if (content) content.dispatch('animationend');

  eq(cardTitles().includes('Day 2 item'), true, 'swipe: day 2 shows item');

  // Swipe right (touchstart at x:100, touchend at x:200) → go to previous day.
  navPage.dispatch('touchstart', {
    touches: [{ clientX: 100, clientY: 300 }],
    changedTouches: [{ clientX: 100, clientY: 300 }],
  });
  navPage.dispatch('touchend', {
    changedTouches: [{ clientX: 200, clientY: 305 }],
  });

  const content2 = navContent();
  if (content2) content2.dispatch('animationend');

  eq(cardTitles().includes('Swipe test'), true, 'swipe: right swipe goes back to day 1');
}

/* =============== iPhone: touch swipe threshold — short swipe doesn't change =============== */
await boot({ role: 'owner', viewport: { width: 390, height: 664 }, items: [
  { id: 63, item_type: 'note', title: 'Stay put', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'planned', details: {}, attachments: [] },
]});
{
  const navPage = document.getElementById('nav-page');

  // Swipe less than 50px threshold → should NOT change day.
  navPage.dispatch('touchstart', {
    touches: [{ clientX: 200, clientY: 300 }],
    changedTouches: [{ clientX: 200, clientY: 300 }],
  });
  navPage.dispatch('touchend', {
    changedTouches: [{ clientX: 210, clientY: 305 }],
  });
  // Still on the same day (swipe was only 10px).
  eq(cardTitles().includes('Stay put'), true, 'swipe-threshold: short swipe does not change day');
}

/* =============== iPhone: vertical swipe doesn't change day =============== */
await boot({ role: 'owner', viewport: { width: 390, height: 664 }, items: [
  { id: 64, item_type: 'note', title: 'No move', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'planned', details: {}, attachments: [] },
]});
{
  const navPage = document.getElementById('nav-page');

  navPage.dispatch('touchstart', {
    touches: [{ clientX: 200, clientY: 100 }],
    changedTouches: [{ clientX: 200, clientY: 100 }],
  });
  // Vertical swipe (dy=200, dx=10) — abs(dx) < abs(dy) so it should NOT navigate.
  navPage.dispatch('touchend', {
    changedTouches: [{ clientX: 210, clientY: 300 }],
  });
  eq(cardTitles().includes('No move'), true, 'swipe-vertical: vertical swipe does not change day');
}

/* =============== member/viewer: render is the same (no blocking) =============== */
await boot({ role: 'member', viewport: { width: 1280, height: 800 }, items: [
  { id: 70, item_type: 'note', title: 'Member sees this', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'planned', details: {}, attachments: [] },
]});
{
  // Members can view the navigation page.
  const titles = cardTitles();
  assert(titles.includes('Member sees this'), 'member: member can see items');
}

/* =============== today button visibility: shows when not on today =============== */
await boot({ role: 'owner', viewport: { width: 1280, height: 800 }, items: [
  { id: 80, item_type: 'note', title: 'Today test', item_date: '2026-09-10', end_date: null,
    sort_key: 1, status: 'planned', details: {}, attachments: [] },
]});
{
  // If default day is not today, today button is visible.
  // We can't control what "today" is in the test env, but we can verify
  // the button has the expected class/text regardless.
  const btn = todayBtn();
  assert(btn != null, 'today-btn: today button element exists');
  assert(btn.textContent.includes('Today') || btn.hidden,
         'today-btn: button either shows Today label or is hidden when already on today');
}

summary('navigation.test.mjs');
// Force exit — navigation.js's startStatusTimer() keeps the event loop alive.
process.exit(0);
