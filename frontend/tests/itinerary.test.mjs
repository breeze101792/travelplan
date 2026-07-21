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
  eq(tb.querySelectorAll('.toolbar-btn').length, 3, 'quick-add toolbar has the 3 type buttons');
  eq(document.getElementById('plan-title').textContent, 'Japan 2026', 'plan title rendered');
}

/* =============== owner: quick-add → editor → Apply → Save =============== */
{
  const board = document.getElementById('board');
  const bar = document.getElementById('pending-bar');
  const tb = document.getElementById('add-toolbar');

  // Click "Hotel" in the quick-add toolbar → draft on board + editor opens.
  tb.querySelectorAll('.toolbar-btn')[0].click();
  assert(bar.querySelector('.pb-status').textContent.includes('1 pending change'), 'bar shows 1 pending after Add');
  assert(board.querySelectorAll('.card-title').map(n => n.textContent).includes('(Untitled)'), 'draft card on board');
  const editor = document.body.querySelector('.item-editor');
  assert(!!editor, 'item editor opened');

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
  tb.querySelectorAll('.toolbar-btn')[1].click();          // activity
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
  tb.querySelectorAll('.toolbar-btn')[2].click();          // note
  assert(bar.querySelector('.pb-status').textContent.includes('1 pending change'), 'note staged');
  const cancelBtn = [...document.body.querySelector('.item-editor').querySelectorAll('button')].find(b => b.textContent === 'Cancel');
  cancelBtn.click();                                       // discard (draft op was in the same session)
  // Stage another one and revert via keyboard.
  tb.querySelectorAll('.toolbar-btn')[2].click();
  document.dispatch('keydown', { key: 'z', ctrlKey: true, target: document.body });
  assert(bar.querySelector('.pb-status').textContent.includes('All changes saved'), 'Ctrl+Z reverts');
  // beforeunload guard: with nothing pending it does not block.
  const ev = window.dispatch('beforeunload', {});
  eq(ev.returnValue, undefined, 'no beforeunload prompt without pending changes');
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
