/* itinerary.test.mjs — executes the real initItinerary() against a DOM shim
 * and a stubbed fetch, i.e. the browser-less equivalent of opening the plan
 * board. This is the regression fixture for the "blank board" class of bugs:
 * it fails whenever the page JS throws before the first render, and whenever
 * the pending-changes bar / toolbar / editor wiring breaks.
 *
 * Run:  node --import ./register.mjs itinerary.test.mjs   (from frontend/tests/)
 */
import { assert, eq, summary } from './lib/t.mjs';
import { installDom } from './lib/dom-shim.mjs';
import { installFetch } from './lib/fetch-stub.mjs';

const PAGE_IDS = ['board', 'pending-bar', 'add-toolbar', 'plan-title', 'plan-dates', 'plan-currency'];

/* Find a toolbar quick-add button by its type label (Hotel / Activity / ...).
 * Skips the +/- day-range buttons that sit in front of the type buttons. */
function typeBtn(label) {
  return [...document.getElementById('add-toolbar').querySelectorAll('.toolbar-btn')]
    .find(b => !b.classList.contains('toolbar-range') && b.textContent === label);
}

const SETTINGS = {
  base_currencies: ['USD', 'JPY', 'CNY'],
  item_types: {
    hotel: { label: 'Hotel', spans_days: true, fields: [] },
    activity: { label: 'Activity', fields: [] },
    note: { label: 'Note', fields: [] },
  },
};

const PLAN = { id: 1, title: 'Japan 2026', start_date: '2026-07-01', end_date: '2026-07-03', base_currency: 'JPY' };

function freshServer() {
  const state = {
    nextItemId: 100,
    nextAttId: 500,
    items: [
      { id: 1, item_type: 'hotel', title: 'Hotel A', item_date: '2026-07-01', end_date: '2026-07-02',
        sort_key: 1, status: 'planned', details: {},
        attachments: [{ id: 5, kind: 'image', value: 'seed-hotel.png', caption: 'lobby' }] },
      { id: 2, item_type: 'activity', title: 'Fushimi Inari', item_date: '2026-07-02', end_date: null,
        sort_key: 1, status: 'confirmed', details: {}, attachments: [] },
    ],
  };
  return installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: PLAN })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['GET /api/plans/1/items', () => ({ items: state.items })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: [] })],
    ['POST /api/plans/:planId/items', (body) => {
      const item = Object.assign({ sort_key: 1, status: 'planned', details: {}, attachments: [] }, body, { id: state.nextItemId++ });
      state.items.push(item);
      return { item };
    }],
    ['PATCH /api/items/:id', (body, { id }) => {
      const it = state.items.find(x => String(x.id) === id);
      Object.assign(it, body);
      return { item: it };
    }],
    ['PATCH /api/plans/:id', (body) => ({ plan: Object.assign({}, PLAN, body) })],
    ['POST /api/items/:id/attachments', (body, { id }) => {
      const it = state.items.find(x => String(x.id) === id);
      const att = Object.assign({}, body, { id: state.nextAttId++, item_id: Number(id) });
      it.attachments.push(att);
      return { attachment: att };
    }],
    ['POST /api/items/:id/upload', (_body, { id }) => {
      const it = state.items.find(x => String(x.id) === id);
      const att = { id: state.nextAttId++, item_id: Number(id), kind: 'image', value: 'uploaded.png', caption: 'pic.png' };
      it.attachments.push(att);
      return { attachment: att };
    }],
    ['POST /api/plans/:planId/expenses', (body) => ({ expense: Object.assign({ id: 900 }, body) })],
    ['POST /api/items/:id/move', (body, { id }) => {
      const it = state.items.find(x => String(x.id) === id);
      Object.assign(it, { item_date: body.item_date });
      return { item: it };
    }],
    ['DELETE /api/attachments/:id', (_b, { id }) => {
      for (const it of state.items) it.attachments = (it.attachments || []).filter(a => String(a.id) !== id);
      return { deleted: Number(id) };
    }],
  ]);
}

async function boot(role) {
  installDom({ ids: PAGE_IDS });
  const stub = freshServer();
  const { initItinerary } = await import('/static/js/itinerary.js');
  await initItinerary({ planId: 1, role });
  return stub;
}

/* =============== owner: initial render =============== */
const ownerStub = await boot('owner');
{
  const board = document.getElementById('board');
  eq(board.children.length, 3, 'board renders 3 day sections');
  const d1titles = board.children[0].querySelectorAll('.card .card-title').map(n => n.textContent);
  assert(d1titles.includes('Hotel A'), 'day 1 shows Hotel A');
  const d2titles = board.children[1].querySelectorAll('.card .card-title').map(n => n.textContent);
  assert(d2titles.includes('Fushimi Inari'), 'day 2 shows Fushimi Inari');
  const imgs = board.children[0].querySelectorAll('.card-thumb');
  eq(imgs.length, 1, 'hotel card has one thumbnail');
  eq(imgs[0].src, '/uploads/seed-hotel.png', 'server image uses /uploads/ prefix');

  /* Spanning items (hotels) are pinned to the bottom of every day they
   * cover, regardless of sort_key, so they read as the "home" / last
   * destination of the night. */
  const d1Order = board.children[0].querySelectorAll('.card .card-title').map(n => n.textContent);
  eq(d1Order[d1Order.length - 1], 'Hotel A', 'hotel pinned to bottom of day 1');
  const d2Order = board.children[1].querySelectorAll('.card .card-title').map(n => n.textContent);
  eq(d2Order[d2Order.length - 1], 'Hotel A', 'hotel pinned to bottom of day 2');

  const bar = document.getElementById('pending-bar');
  eq(bar.hidden, false, 'pending bar visible for owner');
  const btnTexts = bar.querySelectorAll('.pb-btn').map(b => b.textContent);
  assert(btnTexts.some(t => t.includes('Add')), 'bar has Add');
  assert(btnTexts.some(t => t.includes('Revert')), 'bar has Revert');
  assert(btnTexts.some(t => t.includes('Redo')), 'bar has Redo');
  assert(btnTexts.some(t => t.includes('Save')), 'bar has Save');
  assert(bar.querySelector('.pb-status').textContent.includes('All changes saved'), 'status shows saved state');
  const btns = bar.querySelectorAll('button.pb-btn');
  eq(btns[0].disabled, true, 'Revert disabled with no pending changes');
  eq(btns[1].disabled, true, 'Redo disabled with no pending changes');
  eq(btns[2].disabled, true, 'Save disabled with no pending changes');

  const tb = document.getElementById('add-toolbar');
  // Range extend/trim buttons come first; the 3 type buttons (Hotel /
  // Activity / Note) follow them. Filter to just the type buttons.
  const typeButtons = [...tb.querySelectorAll('.toolbar-btn')].filter(b => !b.classList.contains('toolbar-range'));
  eq(typeButtons.length, 3, 'quick-add toolbar has the 3 type buttons');
  eq(document.getElementById('plan-title').textContent, 'Japan 2026', 'plan title rendered');
}

/* =============== owner: quick-add → editor → Apply → Save =============== */
{
  const board = document.getElementById('board');
  const bar = document.getElementById('pending-bar');
  const tb = document.getElementById('add-toolbar');

  // Click "Hotel" in the quick-add toolbar → draft on board + editor opens.
  typeBtn('Hotel').click();
  assert(bar.querySelector('.pb-status').textContent.includes('1 pending change'), 'bar shows 1 pending after Add');
  assert(board.querySelectorAll('.card-title').map(n => n.textContent).includes('(Untitled)'), 'draft card on board');
  const editor = document.body.querySelector('.item-editor');
  assert(!!editor, 'item editor opened');

  // Layout: date + end date are paired on one row in the right column.
  // Walk the modal children: modal-header, modal-body, modal-footer.
  const modalBody = [...editor.children].find(c => c.classList.contains('modal-body'));
  const fieldRows = modalBody.querySelectorAll('.field-row').length;
  assert(fieldRows >= 1, 'editor has at least one field-row (date + end date)');
  // Layout: title is the first input in the left col, before the type-specific
  // fields. (Hotel fixture has fields: [] so the type-specific section is
  // empty here; we just check the row markup is wired.)

  // Fill the title, queue a link and an expense, then Apply.
  const inputs = editor.querySelectorAll('input');
  const titleInput = inputs.find(i => i.type === 'text');
  titleInput.value = 'Shinjuku Granvia';
  const linkUrl = inputs.find(i => i.placeholder === 'https://link');
  linkUrl.value = 'https://example.com/booking';
  const addLinkBtn = [...editor.querySelectorAll('button')].find(b => b.textContent === 'Add link');
  addLinkBtn.click();
  assert(editor.querySelectorAll('.att-row').length === 1, 'queued link shows in editor attachment list');
  const amtInput = inputs.find(i => i.placeholder === 'Amount');
  amtInput.value = '1200';
  const addExpBtn = [...editor.querySelectorAll('button')].find(b => b.textContent === 'Add expense');
  addExpBtn.click();
  assert(editor.querySelector('.expense-mini').textContent.includes('Expense queued'), 'expense queued note shown');

  const applyBtn = [...editor.querySelectorAll('button')].find(b => b.textContent === 'Apply');
  applyBtn.click();
  assert(!document.body.querySelector('.item-editor'), 'editor closes on Apply');
  assert(bar.querySelector('.pb-status').textContent.includes('2 pending changes'), 'bar shows 2 pending after Apply (create + save)');
  const titles = board.querySelectorAll('.card-title').map(n => n.textContent);
  assert(titles.includes('Shinjuku Granvia'), 'board shows the applied title');

  // Revert both ops, then Redo them.
  const undoBtn = [...bar.querySelectorAll('button.pb-btn')].find(b => b.textContent.includes('Revert'));
  const redoBtn = [...bar.querySelectorAll('button.pb-btn')].find(b => b.textContent.includes('Redo'));
  undoBtn.click(); undoBtn.click();
  assert(!board.querySelectorAll('.card-title').map(n => n.textContent).includes('Shinjuku Granvia'), 'Revert twice removes the new item');
  redoBtn.click(); redoBtn.click();
  assert(board.querySelectorAll('.card-title').map(n => n.textContent).includes('Shinjuku Granvia'), 'Redo twice restores the new item');

  // Save: server receives create + link + expense, board re-renders saved state.
  const saveBtn = [...bar.querySelectorAll('button.pb-btn')].find(b => b.textContent.includes('Save'));
  const { calls } = ownerStub;
  saveBtn.click();
  await new Promise(r => setTimeout(r, 0));
  const posts = calls.filter(c => c.method === 'POST').map(c => c.url);
  assert(posts.includes('/api/plans/1/items'), 'Save POSTs the new item');
  assert(posts.some(u => /\/api\/items\/100\/attachments$/.test(u)), 'Save POSTs the link to the new item id');
  assert(posts.includes('/api/plans/1/expenses'), 'Save POSTs the expense');
  assert(bar.querySelector('.pb-status').textContent.includes('All changes saved'), 'bar back to saved after Save');
  const saveBtnAfter = [...bar.querySelectorAll('button.pb-btn')].find(b => b.textContent.includes('Save'));
  assert(saveBtnAfter.disabled, 'Save disabled after Save');
}

/* =============== owner: Add then Cancel discards the draft =============== */
{
  const board = document.getElementById('board');
  const bar = document.getElementById('pending-bar');
  const tb = document.getElementById('add-toolbar');
  typeBtn('Activity').click();          // activity
  const editor = document.body.querySelector('.item-editor');
  assert(!!editor, 'editor opened for second add');
  const cancelBtn = [...editor.querySelectorAll('button')].find(b => b.textContent === 'Cancel');
  cancelBtn.click();
  assert(!document.body.querySelector('.item-editor'), 'editor closes on Cancel');
  assert(!board.querySelectorAll('.card-title').map(n => n.textContent).includes('(Untitled)'), 'Cancel removes the draft');
  assert(bar.querySelector('.pb-status').textContent.includes('All changes saved'), 'Cancel discards the session');
}

/* =============== owner: inline plan-title edit is staged =============== */
{
  const titleEl = document.getElementById('plan-title');
  titleEl.click();
  const input = titleEl.querySelector('input');
  assert(!!input, 'title becomes an input on click (owner)');
  input.value = 'Japan 2026 (renamed)';
  input.blur();
  const bar = document.getElementById('pending-bar');
  assert(bar.querySelector('.pb-status').textContent.includes('1 pending change'), 'title edit staged');
  eq(titleEl.textContent, 'Japan 2026 (renamed)', 'header shows the staged title');
  // Undo it so later scenarios are unaffected.
  const undoBtn = [...bar.querySelectorAll('button.pb-btn')].find(b => b.textContent.includes('Revert'));
  undoBtn.click();
  eq(document.getElementById('plan-title').textContent, 'Japan 2026', 'Revert restores the title');
}

/* =============== owner: Ctrl+Z / Ctrl+S shortcuts =============== */
{
  const board = document.getElementById('board');
  const bar = document.getElementById('pending-bar');
  const tb = document.getElementById('add-toolbar');
  typeBtn('Note').click();                                 // note
  assert(bar.querySelector('.pb-status').textContent.includes('1 pending change'), 'note staged');
  const cancelBtn = [...document.body.querySelector('.item-editor').querySelectorAll('button')].find(b => b.textContent === 'Cancel');
  cancelBtn.click();                                       // discard (draft op was in the same session)
  // Stage another one and revert via keyboard.
  typeBtn('Note').click();
  document.dispatch('keydown', { key: 'z', ctrlKey: true, target: document.body });
  assert(bar.querySelector('.pb-status').textContent.includes('All changes saved'), 'Ctrl+Z reverts');
  // beforeunload guard: with nothing pending it does not block.
  const ev = window.dispatch('beforeunload', {});
  eq(ev.returnValue, undefined, 'no beforeunload prompt without pending changes');
}

/* =============== owner: hotel pinned last even when its sort_key
 * would put it before a non-spanning item on the same day =============== */
{
  // Re-boot with a fixture where the hotel has a SMALLER sort_key than the
  // activity that comes after it on day 2 — i.e. without pinning, the hotel
  // would render first. The pin must still place it at the bottom.
  const SPAN_PLAN = { id: 1, title: 'Japan 2026', start_date: '2026-07-01', end_date: '2026-07-02', base_currency: 'JPY' };
  const SPAN_STATE = {
    nextItemId: 100,
    nextAttId: 500,
    items: [
      // Hotel spans day 1 -> day 2 (exclusive). sort_key 1 (would render first on day 2 without pinning).
      { id: 10, item_type: 'hotel', title: 'Hotel A', item_date: '2026-07-01', end_date: '2026-07-02',
        sort_key: 1, status: 'planned', details: {}, attachments: [] },
      // Activity on day 2 with a HIGHER sort_key than the hotel.
      { id: 11, item_type: 'activity', title: 'Late Lunch', item_date: '2026-07-01', end_date: null,
        sort_key: 5, status: 'planned', details: {}, attachments: [] },
    ],
  };
  installDom({ ids: PAGE_IDS });
  installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: SPAN_PLAN })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['GET /api/plans/1/items', () => ({ items: SPAN_STATE.items })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: [] })],
  ]);
  const { initItinerary } = await import('/static/js/itinerary.js');
  await initItinerary({ planId: 1, role: 'owner' });

  const board = document.getElementById('board');
  const d1Order = board.children[0].querySelectorAll('.card .card-title').map(n => n.textContent);
  eq(d1Order[d1Order.length - 1], 'Hotel A',
     'hotel pinned last on day 1 even when a non-spanning item has a higher sort_key');
}

/* =============== editor: type-specific fields render in declared rows =============== */
{
  // Boot with settings whose hotel has two rows of paired fields and a full-
  // width textarea row. Opening the editor must produce the same number of
  // .field-row containers, with paired inputs in the same row, and a
  // textarea in its own row.
  const SETTINGS_RICH = {
    base_currencies: ['USD', 'JPY'],
    item_types: {
      hotel: {
        label: 'Hotel', spans_days: true,
        fields: [
          { key: 'hotel_name', label: 'Hotel name', type: 'text' },
          { key: 'booking_ref', label: 'Booking ref', type: 'text' },
          { key: 'check_in_time', label: 'Check-in', type: 'time' },
          { key: 'check_out_time', label: 'Check-out', type: 'time' },
          { key: 'note', label: 'Note', type: 'textarea' },
        ],
        rows: [
          ['hotel_name', 'booking_ref'],
          ['check_in_time', 'check_out_time'],
          ['note'],
        ],
      },
      activity: { label: 'Activity', fields: [] },
      note: { label: 'Note', fields: [] },
    },
  };
  const RICH_PLAN = { id: 1, title: 'P', start_date: '2026-07-01', end_date: '2026-07-02', base_currency: 'USD' };
  installDom({ ids: PAGE_IDS });
  installFetch([
    ['GET /api/settings', () => SETTINGS_RICH],
    ['GET /api/plans/1', () => ({ plan: RICH_PLAN })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['GET /api/plans/1/items', () => ({ items: [
      { id: 1, item_type: 'hotel', title: 'Hotel X', item_date: '2026-07-01', end_date: '2026-07-02',
        sort_key: 1, status: 'planned', details: { hotel_name: 'H', booking_ref: 'B' },
        attachments: [] },
    ] })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: [] })],
  ]);
  const { initItinerary } = await import('/static/js/itinerary.js');
  await initItinerary({ planId: 1, role: 'owner' });
  const board = document.getElementById('board');
  board.querySelectorAll('.card')[0].click();
  const editor = document.body.querySelector('.item-editor');
  assert(!!editor, 'editor opened for the rich-fields hotel');
  // The type-specific section in the left column is 3 rows by declaration.
  // Walk the left col to find direct-child .field-row elements (dom-shim's
  // querySelectorAll doesn't support :scope).
  const leftCol = editor.querySelector('.ie-col');
  function directFieldRows(col) {
    return col.children.filter(c => c.classList && c.classList.contains('field-row'));
  }
  const leftRows = directFieldRows(leftCol);
  eq(leftRows.length, 3, 'left col has 3 field rows (2 paired + 1 textarea)');
  // Each paired row has 2 .field-group children, the single row has 1.
  const pairRow1 = leftRows[0];
  eq(pairRow1.querySelectorAll('.field-group').length, 2, 'row 1 has 2 field-groups (name + booking)');
  const singleRow = leftRows[2];
  eq(singleRow.querySelectorAll('.field-group').length, 1, 'row 3 (note) has 1 field-group');
  // Inputs are still wired and prefilled from details.
  const allInputs = leftCol.querySelectorAll('input');
  const hotelNameInput = [...allInputs].find(i => i.value === 'H');
  assert(!!hotelNameInput, 'hotel_name input prefilled from details');
  const bookingInput = [...allInputs].find(i => i.value === 'B');
  assert(!!bookingInput, 'booking_ref input prefilled from details');
  // Date + End date are paired in the right column for spanning items.
  const allCol = editor.querySelectorAll('.ie-col');
  const rightCol = allCol[allCol.length - 1];
  const dateRow = directFieldRows(rightCol)[0];
  assert(!!dateRow, 'right col has a field-row pairing date + end date');
  const dateInputs = dateRow.querySelectorAll('input[type=date]');
  eq(dateInputs.length, 2, 'date + end date share a row with 2 date inputs');
}

/* =============== owner: header dates are click-to-edit =============== */
{
  // Plan already booted in the prior scenario. Verify the dates element is
  // editable for the owner and shows the formatted range.
  const dates = document.getElementById('plan-dates');
  assert(dates.classList.contains('editable'), 'plan-dates is editable for owner');
  assert(/\u2192/.test(dates.textContent) || dates.textContent.includes('→'),
         'plan-dates shows the start → end range');
  // Clicking the dates should swap the static text for two date inputs.
  dates.click();
  const startIn = dates.querySelector('input');
  assert(!!startIn, 'clicking dates opens a date input');
  eq(startIn.type, 'date', 'first input is type=date');
  // Escape reverts without staging anything.
  startIn.dispatch('keydown', { key: 'Escape', target: startIn });
}

/* =============== owner: extend / trim trip via toolbar =============== */
{
  const board = document.getElementById('board');
  const bar = document.getElementById('pending-bar');
  const tb = document.getElementById('add-toolbar');
  // Find the +1-day-at-end button (data-action="extend-end").
  const endExtend = tb.querySelector('.toolbar-range[data-action="extend-end"]');
  assert(!!endExtend, 'toolbar exposes a +1 day end-extend button');
  const beforeCount = board.children.length;
  endExtend.click();
  // One pending op; the staged plan now has a new end_date.
  assert(bar.querySelector('.pb-status').textContent.includes('1 pending change'),
         'bar shows 1 pending after +1 day');
  // The board re-renders with one more day column.
  eq(board.children.length, beforeCount + 1, '+1 day adds a new day column at the end');
  const newDay = board.children[board.children.length - 1];
  assert(newDay.querySelector('.day-title').textContent.startsWith('Day 4'),
         'new day is labelled "Day 4" (the next trip-day after the extension)');
  // Undo removes the day.
  const undoBtn = [...bar.querySelectorAll('button.pb-btn')].find(b => b.textContent.includes('Revert'));
  undoBtn.click();
  eq(board.children.length, beforeCount, 'Revert removes the added day');
  // The trim-end button is enabled when the range has at least 2 days.
  const endTrim = tb.querySelector('.toolbar-range[data-action="trim-end"]');
  assert(!!endTrim && !endTrim.disabled, '−1 day end-trim is enabled');
}

/* =============== owner: buffer day toolbar control =============== */
{
  const board = document.getElementById('board');
  const bar = document.getElementById('pending-bar');
  const tb = document.getElementById('add-toolbar');
  // Trip days don't have a buffer chip; the toolbar's "+ Buffer day" button
  // adds a new buffer column with a single click (no date picker).
  const tripDayChip = board.children[0].querySelector('.day-action');
  assert(!tripDayChip, 'trip days do not show a per-day buffer chip');
  const bufBtn = [...tb.querySelectorAll('.toolbar-btn')]
    .find(b => b.textContent === '+ Buffer day');
  assert(!!bufBtn, 'toolbar exposes a + Buffer day button');
  const beforeCount = board.children.length;
  bufBtn.click();
  assert(bar.querySelector('.pb-status').textContent.includes('1 pending change'),
         'bar shows 1 pending after + Buffer day click');
  // A new buffer column appears on the board.
  eq(board.children.length, beforeCount + 1, '+1 buffer day adds a new column');
  const bufCol = board.children[0];
  assert(bufCol.classList.contains('day-buffer'), 'new column is a buffer day');
  // The buffer column has just the word "Buffer" — no day number or date.
  eq(bufCol.querySelector('.day-title').textContent, 'Buffer',
     'buffer column shows just "Buffer", no day info');
  // Buffers live on a "scratchpad calendar" far from the trip (year 9999)
  // so they can never collide with a trip date, regardless of how the
  // trip range moves. The first buffer gets 9999-12-31.
  eq(bufCol.dataset.date, '9999-12-31',
     'first buffer uses a far-future sentinel date (9999-12-31)');
  // Undo restores the original columns.
  const undoBtn = [...bar.querySelectorAll('button.pb-btn')].find(b => b.textContent.includes('Revert'));
  undoBtn.click();
  eq(board.children.length, beforeCount, 'Revert removes the buffer day');
}

/* =============== owner: initial GET plan includes buffer_days list =============== */
{
  // Boot with a plan that already has buffer days; they should appear on
  // the board as additional columns with the buffer marker.
  const SETTINGS_B = {
    base_currencies: ['USD'],
    item_types: {
      hotel: { label: 'Hotel', spans_days: true, fields: [] },
      activity: { label: 'Activity', fields: [] },
      note: { label: 'Note', fields: [] },
    },
  };
  const PLAN_B = { id: 1, title: 'P', start_date: '2026-07-01', end_date: '2026-07-02',
                   base_currency: 'USD', buffer_days: ['2026-06-30'] };
  installDom({ ids: PAGE_IDS });
  installFetch([
    ['GET /api/settings', () => SETTINGS_B],
    ['GET /api/plans/1', () => ({ plan: PLAN_B })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['GET /api/plans/1/items', () => ({ items: [] })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: [] })],
  ]);
  const { initItinerary } = await import('/static/js/itinerary.js');
  await initItinerary({ planId: 1, role: 'owner' });
  const board = document.getElementById('board');
  eq(board.children.length, 3, 'board shows 2 trip days + 1 buffer day = 3 columns');
  // The first column is the buffer day (2026-06-30 < trip start).
  const firstDay = board.children[0];
  assert(firstDay.classList.contains('day-buffer'), 'first column is the buffer day');
  // Buffer day title is just "Buffer" — no "Day N" or date in it.
  eq(firstDay.querySelector('.day-title').textContent, 'Buffer',
     'buffer day title is exactly "Buffer" (no day info)');
  // The buffer day has a close (×) chip in its title row.
  const chip = firstDay.querySelector('.day-action');
  assert(chip && chip.classList.contains('day-action-close'),
         'buffer day chip is a close (×) button');
  assert(chip.textContent === '×', 'close chip text is the × symbol');
  chip.click();
  const bar = document.getElementById('pending-bar');
  assert(bar.querySelector('.pb-status').textContent.includes('1 pending change'),
         'clicking the on-chip stages a buffer remove');
}

/* =============== owner: trim a day with items is blocked =============== */
{
  // The default fixture has a hotel on 2026-07-01. Trimming the start
  // (which would remove 2026-07-01) must be blocked because the day has
  // an item. The board should NOT stage anything and the status bar
  // should show the block message.
  const stub = await boot('owner');
  stub.restore();
  const board = document.getElementById('board');
  const bar = document.getElementById('pending-bar');
  const tb = document.getElementById('add-toolbar');
  // Before the action: status is "All changes saved".
  assert(bar.querySelector('.pb-status').textContent.includes('All changes saved'),
         'starts in saved state');
  const trimStart = tb.querySelector('.toolbar-range[data-action="trim-start"]');
  assert(!!trimStart, 'trim-start button exists');
  trimStart.click();
  // Status now shows a block error, NOT a pending change.
  const status = bar.querySelector('.pb-status');
  assert(status.classList.contains('pb-blocked'),
         'block error class is applied to the status');
  assert(/item/i.test(status.textContent),
         'block message mentions the items on the day');
  assert(bar.querySelector('.pb-status').textContent.includes('0 pending'),
         'no pending change was staged');
  // Board is unchanged.
  eq(board.children.length, 3, 'board still shows 3 days after blocked trim');
}

/* =============== viewer: bar hidden, board renders =============== */
{
  const stub = await boot('viewer');
  stub.restore();
  const board = document.getElementById('board');
  eq(board.children.length, 3, 'viewer: board still renders 3 day sections');
  const bar = document.getElementById('pending-bar');
  eq(bar.hidden, true, 'viewer: pending bar stays hidden');
  eq(document.getElementById('add-toolbar').children.length, 0, 'viewer: no quick-add toolbar');
  const card = board.querySelector('.card');
  eq(card.draggable, false, 'viewer: cards not draggable');
}

summary('itinerary.test.mjs');
