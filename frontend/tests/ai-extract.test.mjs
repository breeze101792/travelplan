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

// ---------- applyEditsFromExtraction stages a whole batch as one op ----------

{
  installDom({ ids: PAGE_IDS });
  freshServer();
  const staging = await makeStaging();
  staging.base.items = [
    { id: 7, item_type: 'hotel', title: 'Beverly', item_date: '2026-07-01', end_date: '2026-07-02',
      details: { address: 'Old St' }, attachments: [], geocodes: [] },
    { id: 8, item_type: 'transit', title: 'Flight', item_date: '2026-07-01', end_date: null,
      details: { mode: 'Flight' }, attachments: [], geocodes: [] },
  ];

  const { applyEditsFromExtraction } = await import('/static/js/ai-extract.js');
  applyEditsFromExtraction(
    { ctx, staging, onApplied: () => {} },
    [
      { item_id: 7, details: { address: '2 Marina Blvd' } },
      { item_id: 8, when: { start_at: '2026-07-05T09:00', end_at: '2026-07-05T12:00' } },
    ],
  );

  eq(staging.pendingCount, 1, 'batch is staged as a single grouped op');
  const h = staging.viewItems().find(x => String(x.id) === '7');
  const t = staging.viewItems().find(x => String(x.id) === '8');
  eq(h.details.address, '2 Marina Blvd', 'first edit applied');
  eq(t.item_date, '2026-07-05', 'second edit date applied');
}

// ---------- applyEditsFromExtraction with no edits is a no-op ----------

{
  installDom({ ids: PAGE_IDS });
  freshServer();
  const staging = await makeStaging();

  const { applyEditsFromExtraction } = await import('/static/js/ai-extract.js');
  applyEditsFromExtraction({ ctx, staging, onApplied: () => {} }, []);

  eq(staging.pendingCount, 0, 'no op staged for an empty edit list');
}

// ---------- suggestionError mirrors the server's required-field check ----------

{
  const { suggestionError } = await import('/static/js/ai-extract.js');
  const SETTINGS_REQ = {
    item_types: {
      transit: { fields: [
        { key: 'mode', label: 'Type', required: true },
        { key: 'from', label: 'From', required: true },
      ] },
      note: { fields: [] },
    },
  };
  const when = { start_at: '2026-07-01T09:00', end_at: '2026-07-01T10:00' };

  eq(suggestionError({ item_type: 'note', title: 'N', when, details: {} }, SETTINGS_REQ),
     null, 'complete note is valid');
  eq(suggestionError({ item_type: 'note', title: '  ', when, details: {} }, SETTINGS_REQ),
     'title required', 'blank title flagged');
  eq(suggestionError({ item_type: 'note', title: 'N', details: {} }, SETTINGS_REQ),
     'start time required', 'missing when flagged');
  eq(suggestionError({ item_type: 'note', title: 'N', when: { start_at: when.start_at }, details: {} }, SETTINGS_REQ),
     'end time required', 'missing end flagged');
  eq(suggestionError({ item_type: 'transit', title: 'F', when, details: { mode: 'Flight' } }, SETTINGS_REQ),
     'From required', 'missing required type field flagged by label');
  eq(suggestionError({ item_type: 'transit', title: 'F', when, details: { mode: 'Flight', from: 'Tokyo' } }, SETTINGS_REQ),
     null, 'all required fields present is valid');
}

// ---------- addItemsFromExtraction stages complete items as one grouped op ----------

{
  installDom({ ids: PAGE_IDS });
  freshServer();
  const staging = await makeStaging();

  const { addItemsFromExtraction } = await import('/static/js/ai-extract.js');
  const res = addItemsFromExtraction(
    { ctx, staging, plan: PLAN, settings: SETTINGS, members: [], onApplied: () => {} },
    [
      { item_type: 'note', title: 'A', item_date: '2026-07-01',
        when: { start_at: '2026-07-01T09:00', end_at: '2026-07-01T10:00' }, details: {} },
      { item_type: 'hotel', title: 'B', item_date: '2026-07-02', end_date: '2026-07-03',
        when: { start_at: '2026-07-02T15:00', end_at: '2026-07-03T11:00' },
        details: { address: '1 Raffles Place' }, geocodes: [{ label: 'x', lat: 1, lng: 2 }] },
    ],
  );

  eq(res.staged.length, 2, 'both complete suggestions are staged');
  eq(res.invalid.length, 0, 'nothing is reported invalid');
  eq(staging.pendingCount, 1, 'the batch stages as a single grouped op');
  const drafts = staging.viewItems().filter(i => i.isNew);
  eq(drafts.length, 2, 'two drafts are inserted');
  const hotel = drafts.find(d => d.item_type === 'hotel');
  eq(hotel.details.address, '1 Raffles Place', 'per-item details carried into the draft');
  eq(hotel.geocodes[0].lat, 1, 'per-item geocodes carried into the draft');
  eq(hotel.item_date, '2026-07-02', 'per-item date carried into the draft');
}

// ---------- addItemsFromExtraction reports the incomplete ones ----------

{
  installDom({ ids: PAGE_IDS });
  freshServer();
  const staging = await makeStaging();

  const { addItemsFromExtraction } = await import('/static/js/ai-extract.js');
  // One complete note and one note with no `when` (incomplete). The plan/settings
  // are provided so the incomplete one can open its editor without throwing.
  const res = addItemsFromExtraction(
    { ctx, staging, plan: PLAN, settings: SETTINGS, members: [], onApplied: () => {}, onClose: () => {} },
    [
      { item_type: 'note', title: 'Complete', item_date: '2026-07-01',
        when: { start_at: '2026-07-01T09:00', end_at: '2026-07-01T10:00' }, details: {} },
      { item_type: 'note', title: 'Incomplete', details: {} },
    ],
  );

  eq(res.staged.length, 1, 'only the complete suggestion is staged');
  eq(res.invalid.length, 1, 'the incomplete suggestion is reported');
  eq(staging.pendingCount, 2, 'the batch op plus the editor draft are both pending');
}

summary('ai-extract');
