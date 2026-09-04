/* ai-extract.test.mjs — tests for ai-extract.js, which turns AI-suggested
 * items/edits into pre-filled item editors.
 *
 * Run:  node --import ./register.mjs ai-extract.test.mjs   (from frontend/tests/)
 *
 * Covers the two entry points:
 *   - createItemFromExtraction: stages a blank item and patches it with the
 *     suggested fields, including geocodes.
 *   - editItemFromExtraction: patches an existing item with the edit fields,
 *     including geocodes.
 */
import { assert, eq, summary } from './lib/t.mjs';
import { installDom } from './lib/dom-shim.mjs';
import { installFetch } from './lib/fetch-stub.mjs';

const PAGE_IDS = ['board', 'edit-bar', 'plan-title', 'plan-dates'];

const SETTINGS = {
  base_currencies: ['USD', 'JPY', 'CNY'],
  item_types: {
    hotel: { label: 'Hotel', spans_days: true, fields: [] },
    transit: { label: 'Transit', fields: [] },
    note: { label: 'Note', fields: [] },
  },
};

const PLAN = { id: 1, title: 'Japan 2026', start_date: '2026-07-01', end_date: '2026-07-03', base_currency: 'JPY' };

function freshServer() {
  const state = { items: [] };
  return installFetch([
    ['GET /api/settings', () => SETTINGS],
    ['GET /api/plans/1', () => ({ plan: PLAN })],
    ['GET /api/plans/1/members', () => ({ owner: { id: 1, username: 'admin', display_name: 'Admin' }, members: [] })],
    ['GET /api/plans/1/items', () => ({ items: state.items })],
    ['GET /api/plans/1/expenses/by-item', () => ({ items: [] })],
  ]);
}

async function makeStaging() {
  const { Staging } = await import('/static/js/staging.js');
  const staging = new Staging({ baseItems: [], basePlan: PLAN, onChange: () => {} });
  return staging;
}

const ctx = { planId: 1, role: 'owner' };

// ---------- createItemFromExtraction patches geocodes onto the draft ----------

{
  installDom({ ids: PAGE_IDS });
  freshServer();
  const staging = await makeStaging();

  const { createItemFromExtraction } = await import('/static/js/ai-extract.js');
  createItemFromExtraction(
    { ctx, staging, plan: PLAN, settings: SETTINGS, members: [], onApplied: () => {}, onClose: () => {} },
    {
      item_type: 'hotel',
      title: 'Beverly Hotels Elements',
      details: { address: '1 Raffles Place, Singapore' },
      when: { start_at: '2026-07-01T15:00', end_at: '2026-07-02T11:00' },
      item_date: '2026-07-01',
      end_date: '2026-07-02',
      geocodes: [{ label: '1 Raffles Place, Singapore', lat: 1.2844, lng: 103.8512 }],
    },
  );

  const draft = staging.viewItems().find(x => x.item_type === 'hotel');
  assert(draft != null, 'a hotel draft was staged');
  eq(draft.title, 'Beverly Hotels Elements', 'title patched onto draft');
  eq(draft.details.address, '1 Raffles Place, Singapore', 'details patched onto draft');
  assert(draft.geocodes != null && draft.geocodes.length === 1, 'geocodes patched onto draft');
  eq(draft.geocodes[0].lat, 1.2844, 'geocode lat patched');
  eq(draft.geocodes[0].lng, 103.8512, 'geocode lng patched');
  eq(draft.geocodes[0].label, '1 Raffles Place, Singapore', 'geocode label patched');
}

// ---------- createItemFromExtraction without geocodes leaves none ----------

{
  installDom({ ids: PAGE_IDS });
  freshServer();
  const staging = await makeStaging();

  const { createItemFromExtraction } = await import('/static/js/ai-extract.js');
  createItemFromExtraction(
    { ctx, staging, plan: PLAN, settings: SETTINGS, members: [], onApplied: () => {}, onClose: () => {} },
    { item_type: 'note', title: 'A note', details: { text: 'hi' } },
  );

  const draft = staging.viewItems().find(x => x.item_type === 'note');
  assert(draft != null, 'a note draft was staged');
  assert(draft.geocodes == null || draft.geocodes.length === 0, 'no geocodes when none supplied');
}

// ---------- editItemFromExtraction patches geocodes onto an existing item ----------

{
  installDom({ ids: PAGE_IDS });
  freshServer();
  const staging = await makeStaging();
  // Seed an existing item in the base.
  staging.base.items = [{
    id: 7, item_type: 'hotel', title: 'Beverly Hotels Elements',
    item_date: '2026-07-01', end_date: '2026-07-02', details: { address: 'Old St' },
    attachments: [], geocodes: [],
  }];

  const { editItemFromExtraction } = await import('/static/js/ai-extract.js');
  editItemFromExtraction(
    { ctx, staging, plan: PLAN, settings: SETTINGS, members: [], onApplied: () => {}, onClose: () => {} },
    {
      item_id: 7,
      details: { address: '2 Marina Blvd, Singapore' },
      geocodes: [{ label: '2 Marina Blvd, Singapore', lat: 1.2834, lng: 103.8607 }],
    },
  );

  const item = staging.viewItems().find(x => String(x.id) === '7');
  assert(item != null, 'existing item found');
  eq(item.details.address, '2 Marina Blvd, Singapore', 'edit details patched');
  assert(item.geocodes != null && item.geocodes.length === 1, 'edit geocodes patched');
  eq(item.geocodes[0].lat, 1.2834, 'edit geocode lat patched');
  eq(item.geocodes[0].lng, 103.8607, 'edit geocode lng patched');
}

// ---------- editItemFromExtraction with unknown id is a no-op ----------

{
  installDom({ ids: PAGE_IDS });
  freshServer();
  const staging = await makeStaging();
  staging.base.items = [{ id: 7, item_type: 'hotel', title: 'X', item_date: null, end_date: null, details: {}, attachments: [] }];

  const { editItemFromExtraction } = await import('/static/js/ai-extract.js');
  editItemFromExtraction(
    { ctx, staging, plan: PLAN, settings: SETTINGS, members: [], onApplied: () => {}, onClose: () => {} },
    { item_id: 999, title: 'Nope' },
  );

  const items = staging.viewItems();
  eq(items.length, 1, 'no new item staged for unknown id');
  eq(items[0].title, 'X', 'existing item unchanged');
}

summary('ai-extract');
