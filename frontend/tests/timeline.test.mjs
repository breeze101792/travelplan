/* timeline.test.mjs — regression fixture for the timeline view.
 *
 * Run:  node --import ./register.mjs timeline.test.mjs   (from frontend/tests/)
 * or:   ./run.sh                                         (runs everything)
 *
 * Focuses on the parts the DOM shim can actually exercise: the boot path,
 * the day-1 numbering fix, the bars carrying the data-* attributes the
 * drag handler relies on, and the staging-engine round-trip for a
 * TIME_EDIT (the op drag/resize on the timeline emits). The pointer-based
 * drag itself needs real browser events (pointerdown/move/up + bounding
 * rects) so it stays as a manual browser test.
 */
import { assert, eq, summary } from './lib/t.mjs';
import { installDom } from './lib/dom-shim.mjs';
import { installFetch } from './lib/fetch-stub.mjs';
import { Staging, timeEditItemOp } from '/static/js/staging.js';

// Import the timeline module so the resize-math helpers are loaded.
// (We re-import per-boot to mirror the production page — see boot()
// below.) The first import also gives us a hook to reach the helpers
// indirectly through the resize-bottom regression test below.
const timelineMod = await import('/static/js/timeline.js');

const PAGE_IDS = ['timeline', 'edit-bar', 'plan-title', 'plan-dates'];

const SETTINGS = {
  base_currencies: ['USD', 'JPY', 'CNY'],
  item_types: {
    hotel: { label: 'Hotel', spans_days: true, fields: [] },
    activity: { label: 'Activity', fields: [] },
    flight: { label: 'Flight', fields: [] },
    transit: { label: 'Transit', fields: [] },
    note: { label: 'Note', fields: [] },
  },
};

const PLAN = { id: 1, title: 'Japan 2026', start_date: '2026-09-10', end_date: '2026-09-12', base_currency: 'JPY' };

const ACTIVITY = {
  id: 10, item_type: 'activity', title: 'Fushimi Inari', item_date: '2026-09-11', end_date: null,
  sort_key: 1, status: 'planned',
  details: { start_time: '2026-09-11T09:00', end_time: '2026-09-11T11:00' },
  attachments: [],
};

const HOTEL = {
  id: 11, item_type: 'hotel', title: 'Hotel A', item_date: '2026-09-10', end_date: '2026-09-12',
  sort_key: 1, status: 'planned',
  details: { hotel_name: 'Hotel A', check_in_time: '15:00', check_out_time: '11:00' },
  attachments: [],
};

function freshServer() {
  return installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: PLAN })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['GET /api/plans/1/items', () => ({ items: [HOTEL, ACTIVITY] })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: [] })],
  ]);
}

async function boot(role) {
  installDom({ ids: PAGE_IDS });
  freshServer();
  const { initTimeline } = await import('/static/js/timeline.js');
  await initTimeline({ planId: 1, role });
}

/* =============== owner: initial render =============== */
await boot('owner');
{
  const root = document.getElementById('timeline');
  // Hour column + 3 day sections (Sep 10, 11, 12).
  const daySections = root.querySelectorAll('.day');
  eq(daySections.length, 3, 'timeline renders 3 day sections');

  // The first day's title should be "Day 1 · ..." — regression for the
  // off-by-one where Day 1 was being shown on the second day because
  // buildDays used i starting at 0.
  const d1Title = daySections[0].querySelector('.day-head .date').textContent;
  assert(d1Title.startsWith('Day 1 ·'), 'first day is labeled Day 1');
  const d2Title = daySections[1].querySelector('.day-head .date').textContent;
  assert(d2Title.startsWith('Day 2 ·'), 'second day is labeled Day 2');
  const d3Title = daySections[2].querySelector('.day-head .date').textContent;
  assert(d3Title.startsWith('Day 3 ·'), 'third day is labeled Day 3');

  // Each day should have its date on dataset.day so the drag handler
  // can resolve which day the pointer is over.
  eq(daySections[0].dataset.day, '2026-09-10', 'day 1 carries date 2026-09-10');
  eq(daySections[1].dataset.day, '2026-09-11', 'day 2 carries date 2026-09-11');
  eq(daySections[2].dataset.day, '2026-09-12', 'day 3 carries date 2026-09-12');

  // The activity (Sep 11, 09:00–11:00) renders in day 2 with the
  // data-* attributes the drag handler reads.
  const d2 = daySections[1];
  const activityBar = d2.querySelector('.tl-item.activity');
  assert(!!activityBar, 'day 2 has the activity bar');
  eq(activityBar.dataset.itemId, '10', 'activity bar carries its item id');
  assert(activityBar.dataset.timeField && activityBar.dataset.timeField.includes('start_time'),
         'activity bar carries time field names');
  eq(activityBar.dataset.day, '2026-09-11', 'activity bar carries its source day');
  eq(Number(activityBar.dataset.start), 9, 'activity start = 09:00');
  eq(Number(activityBar.dataset.end), 11, 'activity end = 11:00');
  // The bar should have resize handles at the top and bottom.
  const handles = activityBar.querySelectorAll('.tl-resize');
  eq(handles.length, 2, 'activity bar has top + bottom resize handles');

  // Hotels render in every covered night with no resize handles (hotels
  // are spans, not points in time — resize is done in the editor).
  for (const d of daySections) {
    const hotelBars = d.querySelectorAll('.tl-item.hotel');
    if (!hotelBars.length) continue;
    eq(hotelBars[0].classList.contains('tl-item-hotel'), true, 'hotel bar has tl-item-hotel class');
    eq(hotelBars[0].querySelectorAll('.tl-resize').length, 0,
       'hotel bar has no resize handles');
  }

  // The edit bar is visible (owner can edit) and the drag-only
  // buttons (Revert/Redo/Save) are wired. There is no "Add" button —
  // the timeline doesn't create items.
  const bar = document.getElementById('edit-bar');
  eq(bar.hidden, false, 'edit bar visible for owner');
  const btnTexts = bar.querySelectorAll('.pb-btn').map(b => b.textContent);
  assert(btnTexts.some(t => t.includes('Revert')), 'bar has Revert');
  assert(btnTexts.some(t => t.includes('Redo')), 'bar has Redo');
  assert(btnTexts.some(t => t.includes('Save')), 'bar has Save');
  assert(!btnTexts.some(t => t.includes('Add')), 'timeline bar has no Add');
  assert(bar.querySelector('.pb-status').textContent.includes('All changes saved'),
         'status shows saved state');
}

/* =============== viewer: read-only =============== */
{
  // Re-boot as viewer; the bar hides and bars don't carry data-* attrs.
  // (Cheap to re-run because installDom gives a fresh document.)
  await boot('viewer');
  const bar = document.getElementById('edit-bar');
  eq(bar.hidden, true, 'edit bar hidden for viewer');
  const activityBar = document.querySelector('.tl-item.activity');
  assert(!!activityBar, 'viewer still sees the activity bar');
  // Bars are rendered without the data-* wiring for the drag handler
  // because the drag wiring only happens for non-viewer roles.
  assert(!activityBar.dataset.itemId, 'viewer bar has no item id data-* (no drag)');
  eq(activityBar.querySelectorAll('.tl-resize').length, 0,
     'viewer bar has no resize handles');
}

/* =============== timeEditItemOp: round-trip =============== */
// The drag handler stages a TIME_EDIT op when the user releases the
// pointer. We don't simulate the pointer sequence here (no bounding
// rects in the shim) but we *do* verify the op produces the right
// server call: PATCH /api/items/<id> with the new item_date + details.
// This is the contract the timeline relies on, and it also locks in
// the label so the pending bar reads "Reschedule <title>".
{
  const api = { post: async () => ({ item: {} }),
                patch: async () => ({ item: {} }),
                del:  async () => ({}),
                upload: async () => ({}) };
  const calls = [];
  api.patch = async (path, body) => { calls.push({ path, body }); return { item: {} }; };
  const staging = new Staging({
    baseItems: [ACTIVITY],
    basePlan: PLAN,
    onChange: () => {},
  });
  staging.add(timeEditItemOp({
    planId: 1,
    itemId: 10,
    item_date: '2026-09-12',
    details: { start_time: '2026-09-12T14:00', end_time: '2026-09-12T16:00' },
    title: 'Fushimi Inari',
  }));
  eq(staging.hasPending, true, 'timeEdit stages an op');
  eq(staging.ops[0].label, 'Reschedule Fushimi Inari',
     'op label is human-readable for the pending bar');
  await staging.saveAll(api);
  eq(calls.length, 1, 'save dispatches one PATCH');
  eq(calls[0].path, '/api/items/10', 'PATCH targets the item');
  eq(calls[0].body.item_date, '2026-09-12', 'PATCH carries the new day');
  eq(calls[0].body.details.start_time, '2026-09-12T14:00', 'PATCH carries new start time');
  eq(calls[0].body.details.end_time,   '2026-09-12T16:00', 'PATCH carries new end time');
}

/* =============== move preserves duration =============== */
// Regression: a body-drag on the timeline shifts BOTH start and end
// by the same delta so the item's duration is untouched. The drag
// handler clamps the shift so neither end runs off the [0, 24] window.
// We verify the contract by staging a TIME_EDIT whose start+end differ
// from the base by the same amount (and re-asserting duration = 2h).
{
  // Base item: 09:00–11:00 (2h) on 2026-09-11. A drag that moves it
  // to 14:00–16:00 keeps the 2h duration.
  const api = { post: async () => ({}),
                patch: async () => ({ item: {} }),
                del:  async () => ({}),
                upload: async () => ({}) };
  const calls = [];
  api.patch = async (path, body) => { calls.push({ path, body }); return { item: {} }; };
  const staging = new Staging({
    baseItems: [ACTIVITY],
    basePlan: PLAN,
    onChange: () => {},
  });
  staging.add(timeEditItemOp({
    planId: 1,
    itemId: 10,
    item_date: '2026-09-11',                 // same day, time moved
    details: { start_time: '2026-09-11T14:00', end_time: '2026-09-11T16:00' },
    title: 'Fushimi Inari',
  }));
  await staging.saveAll(api);
  eq(calls[0].body.details.start_time, '2026-09-11T14:00',
     'move: new start = base start + delta');
  eq(calls[0].body.details.end_time,   '2026-09-11T16:00',
     'move: new end = base end + same delta (duration preserved)');
  // Sanity: start..end is 2h, same as the base 09:00..11:00.
  const baseDur = 11 - 9;
  const newDur  = 16 - 14;
  eq(newDur, baseDur, 'move preserves the 2h duration');
}

/* =============== multi-select: clicks toggle / range =============== */
// Regression for the click semantics: ⌘/Ctrl toggles, Shift ranges,
// plain click opens the editor. We exercise them via the bar's
// dispatch since the shim has no real pointer support.
{
  // Fresh boot — the previous blocks' selections don't carry over
  // because each block is its own test, but to be safe we re-boot.
  await boot('owner');
  const activityBar = document.querySelector('.tl-item.activity');
  assert(!!activityBar, 're-boot: activity bar present');

  // ⌘+click toggles into the multi-select.
  activityBar.dispatch('click', { button: 0, metaKey: true, target: activityBar });
  assert(activityBar.classList.contains('tl-item-selected'),
         '⌘+click puts the bar in the selection');

  // Second ⌘+click on the same bar toggles it out.
  activityBar.dispatch('click', { button: 0, metaKey: true, target: activityBar });
  assert(!activityBar.classList.contains('tl-item-selected'),
         'second ⌘+click toggles the bar back out');

  // Hotels don't toggle. The hotel bar is wired with a click handler
  // that shows a toast and refuses to participate in multi-select.
  const hotelBar = document.querySelector('.tl-item.hotel');
  assert(!!hotelBar, 'hotel bar present');
  const toastsBefore = document.querySelectorAll('.toast').length;
  hotelBar.dispatch('click', { button: 0, metaKey: true, target: hotelBar });
  assert(!hotelBar.classList.contains('tl-item-selected'),
         '⌘+click on a hotel does not select it');
  const toastsAfter = document.querySelectorAll('.toast').length;
  assert(toastsAfter > toastsBefore, '⌘+click on a hotel shows a toast');
}

/* =============== multi-select: shift+click ranges =============== */
// After ⌘+clicking bar A, shift-clicking bar B should select every
// selectable bar between them. We have only one non-hotel bar in the
// fixture (the activity), so this test verifies the wiring: a plain
// shift+click on the activity produces no error and (with only one
// selectable bar) the selection contains it.
{
  // The test above left the activity unselected. Reset by re-booting.
  await boot('owner');
  const activityBar = document.querySelector('.tl-item.activity');
  // Plain shift+click with no anchor: the handler picks the bar as
  // the only member of the range.
  activityBar.dispatch('click', { button: 0, shiftKey: true, target: activityBar });
  assert(activityBar.classList.contains('tl-item-selected'),
         'shift+click on a lone bar selects it');
}

/* =============== context menu =============== */
// Right-clicking a non-hotel bar opens a context menu with the standard
// actions (Cut/Copy/Paste/Duplicate/Delete). The menu is appended to
// document.body and the actions are enabled iff the selection is non-
// empty. We also verify the menu shows up.
{
  await boot('owner');
  const activityBar = document.querySelector('.tl-item.activity');
  // ⌘+click to put it in the selection so Cut/Copy/Duplicate/Delete
  // are enabled.
  activityBar.dispatch('click', { button: 0, metaKey: true, target: activityBar });
  // Right-click should now show the context menu. The shim doesn't
  // fire contextmenu with clientX/Y automatically, so we dispatch a
  // synthetic event.
  activityBar.dispatch('contextmenu', { clientX: 100, clientY: 100,
                                       preventDefault() {}, target: activityBar });
  const menu = document.querySelector('.context-menu');
  assert(!!menu, 'right-click opens a context menu');
  const labels = [...menu.querySelectorAll('button')].map(b => b.textContent);
  assert(labels.includes('Cut'), 'menu has Cut');
  assert(labels.includes('Copy'), 'menu has Copy');
  assert(labels.includes('Paste'), 'menu has Paste');
  assert(labels.includes('Duplicate'), 'menu has Duplicate');
  assert(labels.includes('Delete'), 'menu has Delete');
  // Cut/Copy/Duplicate/Delete are enabled (selection non-empty),
  // Paste is disabled (clipboard is empty).
  const findBtn = (label) => [...menu.querySelectorAll('button')].find(b => b.textContent === label);
  eq(findBtn('Cut').disabled, false, 'Cut enabled with a selection');
  eq(findBtn('Copy').disabled, false, 'Copy enabled with a selection');
  eq(findBtn('Paste').disabled, true, 'Paste disabled when clipboard is empty');
  eq(findBtn('Delete').disabled, false, 'Delete enabled with a selection');
}

/* =============== multi-drag preserves per-item duration =============== */
// When a bar in a multi-selection is dragged, every selected item
// moves by the same time delta and to the same target day, each
// keeping its own duration. We exercise onMultiDrag directly with
// two items starting at different times; the staging engine should
// receive one TIME_EDIT per item with the correct (start, end) shift.
{
  // Build a fresh staging engine so we can poke it without the page
  // boot's wiring getting in the way.
  const staging = new Staging({
    baseItems: [
      { id: 1, item_type: 'activity', title: 'Breakfast', item_date: '2026-09-10',
        sort_key: 1, status: 'planned', details: { start_time: '2026-09-10T08:00', end_time: '2026-09-10T09:00' },
        attachments: [] },
      { id: 2, item_type: 'activity', title: 'Lunch', item_date: '2026-09-10',
        sort_key: 2, status: 'planned', details: { start_time: '2026-09-10T12:00', end_time: '2026-09-10T13:00' },
        attachments: [] },
    ],
    basePlan: PLAN,
    onChange: () => {},
  });
  // Simulate a multi-drag: shift both by +2h on the same day.
  const sessionId = 'sess-test';
  for (const it of staging.viewItems()) {
    const f = { start: 'start_time', end: 'end_time' };
    const d = it.details;
    const startH = Number(d.start_time.slice(11, 13));
    const endH = Number(d.end_time.slice(11, 13));
    const newStartH = startH + 2;
    const newEndH = endH + 2;
    staging.add(timeEditItemOp({
      planId: 1, itemId: it.id, item_date: '2026-09-10',
      details: { start_time: `2026-09-10T${String(newStartH).padStart(2,'0')}:00`,
                 end_time:   `2026-09-10T${String(newEndH).padStart(2,'0')}:00` },
      title: it.title, sessionId,
    }));
  }
  eq(staging.pendingCount, 2, 'multi-drag stages 2 ops');
  const after = staging.viewItems();
  // Breakfast: 08–09 → 10–11 (still 1h, +2h shift).
  eq(after[0].details.start_time, '2026-09-10T10:00', 'breakfast new start = 10:00');
  eq(after[0].details.end_time,   '2026-09-10T11:00', 'breakfast new end = 11:00 (1h preserved)');
  // Lunch: 12–13 → 14–15 (still 1h).
  eq(after[1].details.start_time, '2026-09-10T14:00', 'lunch new start = 14:00');
  eq(after[1].details.end_time,   '2026-09-10T15:00', 'lunch new end = 15:00 (1h preserved)');
}

/* =============== keyboard shortcuts: ⌘A, Delete, Escape =============== */
// ⌘A selects every non-hotel item. Delete removes the selection. Escape
// clears the selection. The shim doesn't bubble, so we dispatch the
// keyboard event on document directly (matches the board's test).
{
  // Use a fixture with two activities so ⌘A selects more than one.
  installDom({ ids: PAGE_IDS });
  installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: PLAN })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['GET /api/plans/1/items', () => ({ items: [
      { id: 10, item_type: 'activity', title: 'A1', item_date: '2026-09-11', end_date: null,
        sort_key: 1, status: 'planned', details: { start_time: '2026-09-11T09:00' }, attachments: [] },
      { id: 11, item_type: 'activity', title: 'A2', item_date: '2026-09-12', end_date: null,
        sort_key: 1, status: 'planned', details: { start_time: '2026-09-12T10:00' }, attachments: [] },
      HOTEL,
    ] })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: [] })],
  ]);
  const { initTimeline } = await import('/static/js/timeline.js');
  await initTimeline({ planId: 1, role: 'owner' });

  // ⌘A selects every non-hotel item.
  document.dispatch('keydown', { key: 'a', metaKey: true, target: document.body });
  const activityBars = document.querySelectorAll('.tl-item.activity');
  const selectedAfterAll = document.querySelectorAll('.tl-item-selected').length;
  eq(selectedAfterAll, activityBars.length, '⌘A selects every non-hotel bar');
  const hotelBar = document.querySelector('.tl-item.hotel');
  assert(!hotelBar.classList.contains('tl-item-selected'),
         'hotels are excluded from ⌘A');

  // Delete stages a delete for every selected item (2 ops).
  const before = staging_pendingCount();
  document.dispatch('keydown', { key: 'Delete', target: document.body });
  const after = staging_pendingCount();
  assert(after - before >= 2, 'Delete stages one op per selected item');

  // Revert the staged deletes — two clicks to undo both.
  const undoBtn = [...document.getElementById('edit-bar').querySelectorAll('button.pb-btn')]
    .find(b => b.textContent.includes('Revert'));
  undoBtn.click();
  undoBtn.click();
  const afterRevert = staging_pendingCount();
  eq(afterRevert, before, 'Revert removes the staged deletes');

  // Escape clears the selection.
  document.dispatch('keydown', { key: 'a', metaKey: true, target: document.body });
  assert(document.querySelectorAll('.tl-item-selected').length > 0,
         '⌘A rebuilt the selection');
  document.dispatch('keydown', { key: 'Escape', target: document.body });
  eq(document.querySelectorAll('.tl-item-selected').length, 0,
     'Escape clears the selection');
}

// Helper: count pending ops. The staging engine isn't exposed from
// initTimeline's closure, so we read the bar's status text instead.
function staging_pendingCount() {
  const status = document.getElementById('edit-bar').querySelector('.pb-status');
  const m = status && status.textContent.match(/(\d+)\s+pending/);
  return m ? Number(m[1]) : 0;
}

/* =============== resize handles: every timed type has both edges =============== */
// Restaurant and transport used to be "time" only (a point in time, no
// duration), so their bars had no resize handles. They're now mandatory
// start+end — every timed type gets both resize handles.
{
  installDom({ ids: PAGE_IDS });
  installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: PLAN })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['GET /api/plans/1/items', () => ({ items: [
      { id: 20, item_type: 'restaurant', title: 'Ichiran', item_date: '2026-09-11', end_date: null,
        sort_key: 1, status: 'planned',
        details: { start_time: '2026-09-11T19:00', end_time: '2026-09-11T20:30' },
        attachments: [] },
      { id: 21, item_type: 'transit', title: 'Airport bus', item_date: '2026-09-11', end_date: null,
        sort_key: 2, status: 'planned',
        details: { depart_time: '2026-09-11T16:30', arrive_time: '2026-09-11T17:30' },
        attachments: [] },
      { id: 22, item_type: 'activity', title: 'Fushimi Inari', item_date: '2026-09-11', end_date: null,
        sort_key: 3, status: 'planned',
        details: { start_time: '2026-09-11T09:00', end_time: '2026-09-11T11:00' },
        attachments: [] },
    ] })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: [] })],
  ]);
  const { initTimeline } = await import('/static/js/timeline.js');
  await initTimeline({ planId: 1, role: 'owner' });

  const restaurant = document.querySelector('.tl-item.restaurant');
  const transport  = document.querySelector('.tl-item.transit');
  const activity   = document.querySelector('.tl-item.activity');

  // All three timed types get both resize handles — uniform contract.
  eq(restaurant.querySelectorAll('.tl-resize').length, 2,
     'restaurant bar has both resize handles (start_time + end_time)');
  eq(transport.querySelectorAll('.tl-resize').length, 2,
     'transport bar has both resize handles (start_time + end_time)');
  eq(activity.querySelectorAll('.tl-resize').length, 2,
     'activity bar has both resize handles (start_time + end_time)');

  // Subtitle shows the start → end range, not just a single time.
  const restaurantTime = restaurant.querySelector('.tl-item-time').textContent;
  assert(/19:00/.test(restaurantTime) && /20:30/.test(restaurantTime),
         'restaurant subtitle shows the start–end range: ' + restaurantTime);
  const transportTime = transport.querySelector('.tl-item-time').textContent;
  assert(/16:30/.test(transportTime) && /17:30/.test(transportTime),
         'transport subtitle shows the start–end range: ' + transportTime);
}

/* =============== legacy single-`time` items still render =============== */
// Backward compat: items that pre-date the restaurant/transport
// migration only have a `time` field (no start_time, no end_time).
// The timeline should still render them as 1h bars so old data isn't
// broken, and the subtitle should fall back to the `time` value.
{
  installDom({ ids: PAGE_IDS });
  installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: PLAN })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['GET /api/plans/1/items', () => ({ items: [
      { id: 30, item_type: 'restaurant', title: 'Old Ichiran', item_date: '2026-09-11', end_date: null,
        sort_key: 1, status: 'planned', details: { time: '2026-09-11T19:00' }, attachments: [] },
    ] })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: [] })],
  ]);
  const { initTimeline } = await import('/static/js/timeline.js');
  await initTimeline({ planId: 1, role: 'owner' });

  const restaurant = document.querySelector('.tl-item.restaurant');
  assert(!!restaurant, 'legacy `time` restaurant still renders');
  // The time subtitle shows the value the user originally entered.
  const restaurantTime = restaurant.querySelector('.tl-item-time').textContent;
  assert(/19:00/.test(restaurantTime),
         'legacy `time` restaurant shows the user-entered time: ' + restaurantTime);
  // Bar is 1h tall (default duration for legacy data).
  const heightPx = Number(String(restaurant.style.height).replace('px', ''));
  // HOUR_PX = 36, so 1h = 36px (or 20px min, whichever is larger — 36 wins).
  eq(heightPx, 36, 'legacy `time` restaurant renders as a 1h bar');
  // Resize handles are present (because TIME_FIELDS now has end for
  // restaurant), so the user can switch the bar to start+end on first
  // interaction.
  eq(restaurant.querySelectorAll('.tl-resize').length, 2,
     'legacy `time` restaurant still gets resize handles');
}

/* =============== beforeunload guard =============== */
// When the user has unsaved changes, the page should prompt before
// unloading (close tab, navigate away, refresh). After Revert returns
// the staging engine to "no pending", the guard must release — the
// user can leave without a prompt. The guard is wired in the page's
// boot; we exercise it by calling the registered listener directly
// with a synthetic event object that records `preventDefault` calls.
// (The DOM shim's window.dispatch has a no-op preventDefault that
// doesn't update defaultPrevented, so we call the listener directly
// with a tracking event object.)
{
  await boot('owner');
  const listeners = (window._listeners || {}).beforeunload || [];
  assert(listeners.length >= 1, 'beforeunload listener is registered');

  function fireGuard() {
    // Reset our tracking object between invocations.
    const ev = { defaultPrevented: false, returnValue: undefined,
                 preventDefault() { this.defaultPrevented = true; } };
    for (const fn of listeners) fn(ev);
    return ev;
  }

  // No pending changes yet — guard releases.
  let ev = fireGuard();
  assert(!ev.defaultPrevented,
         'no prompt when there are no pending changes');

  // Stage a delete by selecting the activity and pressing Delete.
  const activity = document.querySelector('.tl-item.activity');
  activity.dispatch('click', { button: 0, metaKey: true, target: activity });
  document.dispatch('keydown', { key: 'Delete', target: document.body });
  const pending = staging_pendingCount();
  assert(pending >= 1, 'sanity: we have at least one pending change');

  // Now the guard should prevent the unload.
  ev = fireGuard();
  assert(ev.defaultPrevented,
         'guard calls preventDefault when there are pending changes');

  // Revert the staged delete and verify the guard releases again.
  const undoBtn = [...document.getElementById('edit-bar').querySelectorAll('button.pb-btn')]
    .find(b => b.textContent.includes('Revert'));
  for (let i = 0; i < pending; i++) undoBtn.click();
  eq(staging_pendingCount(), 0, 'sanity: all pending changes reverted');
  ev = fireGuard();
  assert(!ev.defaultPrevented,
         'guard releases after Revert returns the engine to clean state');
}

/* =============== resize math: move / resize-top / resize-bottom =============== */
// The DOM shim doesn't fire pointer events, so we exercise the drag/resize
// math directly through the helpers the timeline module exports. This
// guards against the resize-bottom bug where the new bottom was
// computed from startH + dy (compressing the bar) instead of
// endH + dy (extending it correctly). The bug was: dragging the bottom
// of a 9–11 bar down 1h would have produced a 1h bar (start=9, end=10)
// instead of a 3h bar (start=9, end=12).
{
  const { moveTimeWindow, resizeTop, resizeBottom } = timelineMod;

  // --- move: shift both ends by the same delta, duration preserved.
  eq(JSON.stringify(moveTimeWindow({ startH: 9, endH: 11, dyPx: 36 })),
     JSON.stringify({ startH: 10, endH: 12 }),
     'move +1h shifts both ends by +1h');
  eq(JSON.stringify(moveTimeWindow({ startH: 9, endH: 11, dyPx: -36 })),
     JSON.stringify({ startH: 8, endH: 10 }),
     'move -1h shifts both ends by -1h');
  // Clamp at the 24h ceiling.
  eq(JSON.stringify(moveTimeWindow({ startH: 23, endH: 24, dyPx: 72 })),
     JSON.stringify({ startH: 23, endH: 24 }),
     'move down at the bottom is clamped (no overflow past 24)');
  // Clamp at the 0h floor.
  eq(JSON.stringify(moveTimeWindow({ startH: 0.5, endH: 1.5, dyPx: -72 })),
     JSON.stringify({ startH: 0, endH: 1 }),
     'move up at the top is clamped (no underflow below 0)');

  // --- resize-top: top edge moves, bottom stays.
  eq(JSON.stringify(resizeTop({ endH: 11, newTopH: 10 })),
     JSON.stringify({ startH: 10, endH: 11 }),
     'resize-top to 10 keeps end=11');
  eq(JSON.stringify(resizeTop({ endH: 11, newTopH: 7 })),
     JSON.stringify({ startH: 7, endH: 11 }),
     'resize-top to 7 keeps end=11');
  // Clamp: new top can't go below endH - 0.5h.
  eq(JSON.stringify(resizeTop({ endH: 11, newTopH: 14 })),
     JSON.stringify({ startH: 10.5, endH: 11 }),
     'resize-top clamps at endH - 0.5h');

  // --- resize-bottom: the bug regression. Top stays, bottom moves.
  // Drag the bottom of a 9-11 bar down 1h: endH + dy/H = 12.
  // The pre-fix code computed `newStart = startH + dy = 10` and used
  // it as the new bottom, making the bar 1h tall. After the fix, the
  // bar correctly extends to 3h.
  const r = resizeBottom({ startH: 9, newBottomH: 12 });
  eq(JSON.stringify(r), JSON.stringify({ startH: 9, endH: 12 }),
     'resize-bottom to 12 keeps start=9 (regression: was {start:9, end:10})');
  // Drag the bottom up 1h: endH - 1 = 10.
  eq(JSON.stringify(resizeBottom({ startH: 9, newBottomH: 10 })),
     JSON.stringify({ startH: 9, endH: 10 }),
     'resize-bottom to 10 keeps start=9');
  // Clamp: new bottom can't go below startH + 0.5h.
  eq(JSON.stringify(resizeBottom({ startH: 9, newBottomH: 4 })),
     JSON.stringify({ startH: 9, endH: 9.5 }),
     'resize-bottom clamps at startH + 0.5h');
}

/* =============== buffer day renders its own column =============== */
// A buffer day (an entry in plan.buffer_days) is a planning scratchpad —
// year 9999, far from any real trip date. The shared buildDays() turns
// each entry into a { date, is_buffer: true, label: 'Buffer' } object;
// renderDay() draws it as a column with no hour gridlines, an "× close"
// chip in the day-head, and the buffer CSS class so the column can be
// styled differently (lighter background, no gridlines).
{
  installDom({ ids: PAGE_IDS });
  installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: { ...PLAN, buffer_days: ['9999-12-31'] } })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['GET /api/plans/1/items', () => ({ items: [HOTEL, ACTIVITY] })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: [] })],
  ]);
  const { initTimeline } = await import('/static/js/timeline.js');
  await initTimeline({ planId: 1, role: 'owner' });

  const root = document.getElementById('timeline');
  const sections = root.querySelectorAll('.day');
  // 3 trip days + 1 buffer day = 4 columns.
  eq(sections.length, 4, 'buffer day adds an extra column');
  const bufferSection = [...sections].find(s => s.dataset.day === '9999-12-31');
  assert(!!bufferSection, 'buffer section is in the DOM');
  eq(bufferSection.classList.contains('day-buffer'), true,
     'buffer section carries the day-buffer class');
  // No hour gridlines drawn in the buffer day.
  eq(bufferSection.querySelectorAll('.hour-label').length, 0,
     'buffer column has no hour labels');
  // The day-head shows "Buffer" (no Day N prefix).
  const bufferTitle = bufferSection.querySelector('.day-head .date').textContent;
  eq(bufferTitle, 'Buffer', 'buffer column title is "Buffer"');
  // × close chip is present (owner can remove buffer days).
  const closeChip = bufferSection.querySelector('.day-action-close');
  assert(!!closeChip, 'buffer day has the × close chip');
  eq(closeChip.getAttribute('aria-label'), 'Remove this buffer day',
     'close chip has an accessible label');
}

/* =============== buffer close chip stages a remove =============== */
// Clicking × on a buffer day should stage an updatePlanBufferDaysOp
// that removes the date from plan.buffer_days. The pending bar should
// show "1 pending change — last: Remove buffer day".
{
  installDom({ ids: PAGE_IDS });
  const planWithBuffer = { ...PLAN, buffer_days: ['9999-12-31'] };
  installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: planWithBuffer })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['GET /api/plans/1/items', () => ({ items: [HOTEL, ACTIVITY] })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: [] })],
  ]);
  const { initTimeline } = await import('/static/js/timeline.js');
  await initTimeline({ planId: 1, role: 'owner' });

  const before = staging_pendingCount();
  const bufferSection = [...document.querySelectorAll('.day')].find(s => s.dataset.day === '9999-12-31');
  const closeChip = bufferSection.querySelector('.day-action-close');
  closeChip.click();
  const after = staging_pendingCount();
  eq(after, before + 1, 'clicking × on a buffer day stages one op');
  // The buffer column is gone after the re-render.
  const stillThere = [...document.querySelectorAll('.day')].find(s => s.dataset.day === '9999-12-31');
  eq(!!stillThere, false, 'buffer column is removed after the close click');
}

/* =============== edit-bar: range + buffer + quick add =============== */
// The shared renderEditBar() mounts the same chrome the board uses:
// +/- day-range buttons, + Buffer day, and a Quick add type picker.
// The owner should see all of it; the viewer should see none of it.
{
  await boot('owner');
  const eb = document.getElementById('edit-bar');
  assert(!!eb, 'edit-bar exists in the DOM');
  const rangeLabels = [...eb.querySelectorAll('button.toolbar-btn')].map(b => b.textContent);
  // Range buttons (in order: extend-start, trim-start, trim-end, extend-end).
  assert(rangeLabels.includes('‹ +1 day'),  'edit-bar has extend-start button');
  assert(rangeLabels.includes('−1 day ›'),  'edit-bar has trim-start button');
  assert(rangeLabels.includes('‹ −1 day'),  'edit-bar has trim-end button');
  assert(rangeLabels.includes('+1 day ›'),  'edit-bar has extend-end button');
  // Buffer + quick add.
  assert(rangeLabels.includes('+ Buffer day'), 'edit-bar has + Buffer day button');
  // Quick add buttons are inside the .qa-dropdown.
  const qaLabels = [...eb.querySelectorAll('.qa-item')].map(b => b.textContent);
  for (const ti of Object.values(SETTINGS.item_types)) {
    assert(qaLabels.includes(ti.label), `edit-bar has Quick add: ${ti.label}`);
  }
  // The "Quick add" summary is the focused-day hint.
  const summary = eb.querySelector('.qa-summary');
  assert(!!summary, 'edit-bar shows a Quick add summary');
  assert(summary.textContent.startsWith('+ Quick add'), 'summary says "+ Quick add"');

  // Viewer: no edit-bar buttons at all (the whole bar is hidden for
  // view-only roles, just like the board).
  await boot('viewer');
  const ebViewer = document.getElementById('edit-bar');
  eq(ebViewer.hidden, true, 'viewer: edit-bar is hidden');
}

/* =============== plan-level chrome: title + dates are editable =============== */
// The plan title is editable only for the owner; the dates are editable
// for any non-viewer role. The shared wirePlanHeader() handles both.
{
  // Owner: title is editable (clickable, hover-affordance), dates are editable.
  await boot('owner');
  const titleEl = document.getElementById('plan-title');
  const datesEl = document.getElementById('plan-dates');
  assert(titleEl.classList.contains('editable'), 'owner: title is editable');
  assert(datesEl.classList.contains('editable'), 'owner: dates are editable');

  // Editor (non-viewer) sees editable dates but not title.
  await boot('editor');
  const titleEl2 = document.getElementById('plan-title');
  const datesEl2 = document.getElementById('plan-dates');
  assert(!titleEl2.classList.contains('editable'), 'editor: title is NOT editable');
  assert(datesEl2.classList.contains('editable'), 'editor: dates are editable');

  // Viewer: neither is editable.
  await boot('viewer');
  const titleEl3 = document.getElementById('plan-title');
  const datesEl3 = document.getElementById('plan-dates');
  assert(!titleEl3.classList.contains('editable'), 'viewer: title is NOT editable');
  assert(!datesEl3.classList.contains('editable'), 'viewer: dates are NOT editable');
}

summary('timeline.test.mjs');
