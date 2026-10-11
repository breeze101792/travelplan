/* ai-agent.test.mjs — tests for the floating AI chat widget.
 *
 * Run:  node --import ./register.mjs ai-agent.test.mjs   (from frontend/tests/)
 *
 * Covers the widget's chat flow: it POSTs the conversation to the chat
 * endpoint, renders the reply, and offers suggested items via the active
 * view's createItemFromExtraction.
 */
import { assert, eq, summary } from './lib/t.mjs';
import { installDom } from './lib/dom-shim.mjs';
import { installFetch } from './lib/fetch-stub.mjs';

const CHAT_RESULT = {
  reply: 'Here is a flight suggestion.',
  items: [
    { item_type: 'transit', title: 'JL 123', details: { mode: 'Flight' },
      when: { start_at: '2026-09-10T09:00', end_at: '2026-09-10T10:00' },
      item_date: '2026-09-10', end_date: '2026-09-10',
      geocodes: [{ label: 'Tokyo', lat: 35.68, lng: 139.65 }] },
  ],
};

async function loadAgent() {
  const mod = await import('/static/js/ai-agent.js');
  mod.resetAgent();
  return mod;
}

// ---------- init + visibility ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, setAgentVisible } = await loadAgent();

  initAgent();
  const root = document.getElementById('ai-agent');
  assert(root != null, 'widget is created on init');
  assert(root.hidden === true, 'window hidden (minimized) by default');
  const icon = document.getElementById('ai-agent-icon');
  assert(icon != null, 'icon created on init');
  assert(icon.hidden === false, 'icon visible by default');

  // On a supported view while minimized: window stays hidden, icon shows.
  setAgentVisible('board');
  assert(root.hidden === true, 'window hidden on board when minimized');
  assert(icon.hidden === false, 'icon visible on board when minimized');

  // Unsupported view: both hidden.
  setAgentVisible('expenses');
  assert(root.hidden === true, 'hidden on expenses');
  assert(icon.hidden === true, 'icon hidden on expenses');

  // Restore, then switch to map: window shows, icon hides.
  icon.dispatch('click');
  setAgentVisible('map');
  assert(root.hidden === false, 'visible on map after restore');
  assert(icon.hidden === true, 'icon hidden on map when window open');
}

// ---------- minimize / restore ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent } = await loadAgent();
  initAgent();

  const root = document.getElementById('ai-agent');
  const toggle = document.querySelector('.ai-agent-toggle');

  toggle.dispatch('click');
  assert(root.hidden === true, 'window hidden on minimize');
  const icon = document.getElementById('ai-agent-icon');
  assert(icon != null, 'minimized icon created');
  assert(icon.hidden === false, 'icon visible when minimized');

  icon.dispatch('click');
  assert(root.hidden === false, 'window restored on icon click');
  assert(icon.hidden === true, 'icon hidden when window open');
}

// ---------- resize handle ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent } = await loadAgent();
  initAgent();

  const root = document.getElementById('ai-agent');
  const handle = document.querySelector('.ai-agent-resize');
  assert(handle != null, 'resize handle created');
  assert(root.style.width == null || root.style.width === '', 'no inline width until resized (CSS default applies)');
}

// ---------- typing indicator while processing ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();
  registerAgentContext({ canEdit: true, createItemFromExtraction: () => {} });

  // A fetch that resolves only after we've checked the indicator.
  let resolveFetch;
  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => new Promise((res) => { resolveFetch = () => res(CHAT_RESULT); })],
  ]);

  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'hello';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const typing = document.querySelector('.ai-typing');
  assert(typing != null, 'typing indicator shown while processing');
  assert(typing.querySelectorAll('.ai-typing-dot').length === 3, 'typing indicator has 3 dots');

  resolveFetch();
  await new Promise((r) => setTimeout(r, 0));
  assert(document.querySelector('.ai-typing') == null, 'typing indicator hidden after reply');

  restore();
}

// ---------- chat submit flow ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();

  const { calls, restore } = installFetch([
    ['POST /api/plans/7/ai/chat', (body) => CHAT_RESULT],
  ]);

  let received = null;
  registerAgentContext({
    canEdit: true,
    createItemFromExtraction: (ext) => { received = ext; },
  });

  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'add a flight';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const call = calls.find((c) => c.url.endsWith('/ai/chat'));
  assert(call != null, 'chat endpoint was called');
  eq(call.method, 'POST', 'chat uses POST');
  const sent = JSON.parse(call.body);
  eq(sent.messages[0].content, 'add a flight', 'user message sent');
  eq(sent.image, null, 'no image when none attached');

  // reply rendered (as markdown)
  const texts = [...document.querySelectorAll('.ai-msg-text')].map((n) => n.textContent);
  assert(texts.some((t) => t.includes('Here is a flight suggestion.')), 'assistant reply rendered');

  // suggestion row offered: an Edit button and an Add button. With no batch
  // handler registered, Add falls back to opening the editor.
  const suggestionRow = document.querySelector('.ai-edit-row');
  assert(suggestionRow != null, 'suggestion row rendered');
  eq(suggestionRow.querySelector('.ai-edit-title').textContent, 'JL 123', 'row shows the suggested title');
  assert(suggestionRow.querySelector('.ai-edit-open') != null, 'suggestion row has an Edit button');
  const addBtn = suggestionRow.querySelector('.ai-edit-add');
  assert(addBtn != null, 'suggestion row has an Add button');
  assert(document.querySelector('.ai-suggest-all') == null, 'no Add all without a batch handler');

  addBtn.dispatch('click');
  assert(received != null, 'createItemFromExtraction called on Add click');
  eq(received.item_type, 'transit', 'suggested item_type passed through');
  eq(received.title, 'JL 123', 'suggested title passed through');
  eq(received.geocodes[0].lat, 35.68, 'suggested geocodes passed through');

  restore();
}

// ---------- grouped suggestions: Add all stages the complete ones ----------

const TWO_ITEMS_RESULT = {
  reply: 'Two suggestions.',
  items: [
    { item_type: 'transit', title: 'Flight', details: { mode: 'Flight' },
      when: { start_at: '2026-09-10T09:00', end_at: '2026-09-10T10:00' }, geocodes: [] },
    { item_type: 'hotel', title: 'Hotel', details: {},
      when: { start_at: '2026-09-10T15:00', end_at: '2026-09-12T11:00' }, geocodes: [] },
  ],
  edits: [],
};

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();

  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => TWO_ITEMS_RESULT],
  ]);

  const batches = [];
  registerAgentContext({
    canEdit: true,
    createItemFromExtraction: () => {},
    addItemsFromExtraction: (exts) => {
      batches.push(exts);
      // Treat the hotel suggestion as incomplete in this test.
      return {
        staged: exts.filter(e => e.item_type !== 'hotel'),
        invalid: exts.filter(e => e.item_type === 'hotel'),
      };
    },
  });

  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'suggest two';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const rows = document.querySelectorAll('.ai-edit-row');
  eq(rows.length, 2, 'one row per suggested item');
  eq(document.querySelectorAll('.ai-edit-add').length, 2, 'each row has an Add button');
  const allBtn = document.querySelector('.ai-suggest-all');
  assert(allBtn != null && allBtn.textContent.includes('2'), 'Add all shows the item count');

  // Add the first (complete) row on its own.
  rows[0].querySelector('.ai-edit-add').dispatch('click');
  eq(batches.length, 1, 'row Add calls addItemsFromExtraction');
  eq(batches[0].length, 1, 'row Add passes only that item');
  assert(rows[0].classList.contains('ai-edit-applied'), 'complete row marked added');
  assert(document.querySelector('.ai-suggest-all').textContent.includes('1'),
         'Add all count drops to the remaining item');
  assert(!rows[0].querySelector('.ai-edit-add').disabled, 'added row stays clickable for a redo');

  // Add all → the remaining row is incomplete; it stays unmarked.
  document.querySelector('.ai-suggest-all').dispatch('click');
  eq(batches.length, 2, 'Add all calls addItemsFromExtraction');
  eq(batches[1].length, 1, 'Add all passes only the remaining item');
  assert(!rows[1].classList.contains('ai-edit-applied'), 'incomplete row stays unmarked');
  assert(document.querySelector('.ai-suggest-all') != null, 'Add all stays while an incomplete row remains');

  restore();
}

// ---------- edit flow (change date) ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();

  const EDIT_RESULT = {
    reply: 'Moved your checkout to Sep 30.',
    items: [],
    edits: [
      { item_id: 3, when: { start_at: '2026-09-24T15:00', end_at: '2026-09-30T11:00' } },
    ],
  };
  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => EDIT_RESULT],
  ]);

  let opened = null;
  const batches = [];
  registerAgentContext({
    canEdit: true,
    createItemFromExtraction: () => {},
    applyEditsFromExtraction: (eds) => { batches.push(eds); },
    editItemFromExtraction: (ed) => { opened = ed; },
    getItemTitle: (id) => id === 3 ? 'Beverly Hotels Elements' : null,
  });

  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'change the hotel date';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  // reply rendered
  const texts = [...document.querySelectorAll('.ai-msg-text')].map((n) => n.textContent);
  assert(texts.some((t) => t.includes('Moved your checkout')), 'edit reply rendered');

  // one grouped row, labeled with the item title and a change summary
  const row = document.querySelector('.ai-edit-row');
  assert(row != null, 'edit row rendered');
  eq(row.querySelector('.ai-edit-title').textContent, 'Beverly Hotels Elements', 'row labels the item title');
  assert(row.querySelector('.ai-edit-change').textContent.includes('time \u2192'), 'row summarizes the change');
  assert(document.querySelector('.ai-suggest-all') == null, 'no apply-all for a single edit');

  // The Edit button opens the item editor for this change.
  row.querySelector('.ai-edit-open').dispatch('click');
  assert(opened != null, 'editItemFromExtraction called on row Edit');
  eq(opened.item_id, 3, 'row Edit passes the edit through');

  const applyBtn = row.querySelector('.ai-edit-apply');
  applyBtn.dispatch('click');
  eq(batches.length, 1, 'applyEditsFromExtraction called on row Apply');
  eq(batches[0].length, 1, 'only this row\'s edit is staged');
  eq(batches[0][0].item_id, 3, 'edit item_id passed through');
  eq(batches[0][0].when.end_at, '2026-09-30T11:00', 'edit when passed through');
  assert(!applyBtn.disabled, 'row Apply stays clickable after applying');
  assert(!row.querySelector('.ai-edit-open').disabled, 'row Edit stays available after applying');
  eq(applyBtn.textContent, '\u2713 Applied', 'row Apply shows the applied state');
  applyBtn.dispatch('click');
  eq(batches.length, 2, 'row Apply can stage the edit again');
  eq(batches[1][0].item_id, 3, 'the re-applied edit is the same one');
  assert(row.classList.contains('ai-edit-applied'), 'row marked applied');

  restore();
}

// ---------- edit flow read-only shows plain text ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'viewer' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();
  registerAgentContext({
    canEdit: false,
    createItemFromExtraction: () => {},
    getItemTitle: (id) => id === 3 ? 'Beverly Hotels Elements' : null,
  });

  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => ({
      reply: 'ok', items: [],
      edits: [{ item_id: 3, when: { start_at: '2026-09-24T15:00' } }],
    })],
  ]);
  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'change the date';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  assert(document.querySelector('.ai-edit-apply') == null, 'no apply button when read-only');
  const readonly = document.querySelector('.ai-suggest-readonly');
  assert(readonly != null, 'read-only edit shown as text');
  assert(readonly.textContent.includes('Beverly Hotels Elements'), 'read-only edit shows item title');

  restore();
}

// ---------- no context -> warn, no fetch ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();
  registerAgentContext(null);

  const { calls, restore } = installFetch([]);
  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'some text';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  eq(calls.length, 0, 'no fetch when no view context is registered');
  restore();
}

// ---------- read-only (viewer / archived) shows plain suggestions ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'viewer' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();
  registerAgentContext({ canEdit: false, createItemFromExtraction: () => {} });

  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => CHAT_RESULT],
  ]);
  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'add a flight';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const suggestBtn = document.querySelector('.ai-suggest-btn');
  assert(suggestBtn == null, 'no Add button when read-only');
  const readonly = document.querySelector('.ai-suggest-readonly');
  assert(readonly != null, 'read-only suggestion shown as text');
  assert(readonly.textContent.includes('transit'), 'read-only suggestion shows type');

  restore();
}

// ---------- clear chat ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();

  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => CHAT_RESULT],
  ]);
  registerAgentContext({ canEdit: true, createItemFromExtraction: () => {} });

  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'hello there';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const beforeWelcome = document.querySelectorAll('.ai-msg-welcome').length;
  assert(beforeWelcome === 1, 'one welcome message before clear');
  assert(document.querySelectorAll('.ai-msg-user').length === 1, 'user message present before clear');

  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    document.querySelector('.ai-agent-clear').dispatch('click');
  } finally {
    globalThis.confirm = originalConfirm;
  }
  await new Promise((r) => setTimeout(r, 0));

  assert(document.querySelectorAll('.ai-msg-user').length === 0, 'user messages cleared');
  assert(document.querySelectorAll('.ai-msg-welcome').length === 1, 'welcome message restored after clear');

  restore();
}

// ---------- image attach (file picker) ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();
  registerAgentContext({ canEdit: true, createItemFromExtraction: () => {} });

  const { calls, restore } = installFetch([
    ['POST /api/plans/7/ai/chat', (body) => CHAT_RESULT],
  ]);

  const fileInput = document.querySelector('input');
  assert(fileInput != null, 'hidden file input exists');

  // Simulate selecting an image file.
  const file = { type: 'image/png', name: 'ticket.png' };
  fileInput.files = [file];
  fileInput.dispatch('change');
  await new Promise((r) => setTimeout(r, 0));

  const attachName = document.querySelector('.ai-attach-name');
  assert(attachName != null, 'attached image name shown');
  eq(attachName.textContent, 'ticket.png', 'attached image name matches');

  // Send with the image attached.
  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'read this ticket';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const call = calls.find((c) => c.url.endsWith('/ai/chat'));
  const sent = JSON.parse(call.body);
  assert(sent.image != null, 'image data URL sent with chat');
  assert(sent.image.startsWith('data:image/png;base64,'), 'image is a data URL');

  restore();
}

// ---------- image paste (clipboard) ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();
  registerAgentContext({ canEdit: true, createItemFromExtraction: () => {} });

  const input = document.querySelector('.ai-agent-input');
  const file = { type: 'image/png', name: 'screenshot.png' };
  const pasteEvent = {
    clipboardData: {
      items: [
        { type: 'text/plain', getAsFile: () => null },
        { type: 'image/png', getAsFile: () => file },
      ],
    },
    preventDefault() {},
  };
  input.dispatch('paste', pasteEvent);
  await new Promise((r) => setTimeout(r, 0));

  const attachName = document.querySelector('.ai-attach-name');
  assert(attachName != null, 'pasted image attached');
  eq(attachName.textContent, 'screenshot.png', 'pasted image name matches');
}

// ---------- apply-all edits (one grouped click) ----------

const MULTI_EDIT_RESULT = {
  reply: 'Updated both items.',
  items: [],
  edits: [
    { item_id: 3, when: { start_at: '2026-09-24T15:00', end_at: '2026-09-30T11:00' } },
    { item_id: 4, title: 'New title' },
  ],
};

function editContext(over = {}) {
  return Object.assign({
    canEdit: true,
    createItemFromExtraction: () => {},
    editItemFromExtraction: () => {},
    applyEditsFromExtraction: () => {},
    getItemTitle: (id) => `Item ${id}`,
  }, over);
}

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();

  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => MULTI_EDIT_RESULT],
  ]);

  const batches = [];
  registerAgentContext(editContext({
    applyEditsFromExtraction: (eds) => { batches.push(eds); },
  }));

  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'update both';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const allBtn = document.querySelector('.ai-suggest-all');
  assert(allBtn != null, 'apply-all button rendered for a multi-edit reply');
  assert(allBtn.textContent.includes('2'), 'apply-all button shows the edit count');
  eq(document.querySelectorAll('.ai-edit-apply').length, 2, 'one Apply button per edit row');
  eq(document.querySelectorAll('.ai-suggest-btn').length, 1, 'the only .ai-suggest-btn is apply-all');

  allBtn.dispatch('click');
  eq(batches.length, 1, 'applyEditsFromExtraction called on apply-all click');
  eq(batches[0].length, 2, 'all edits from the reply passed in one call');
  eq(batches[0][1].item_id, 4, 'second edit passed through');
  eq([...document.querySelectorAll('.ai-edit-apply')].every(b => b.disabled), false,
     'rows stay clickable after apply-all (so a revert can be redone)');
  eq(document.querySelectorAll('.ai-edit-applied').length, 2, 'every row marked applied');
  const stillAll = document.querySelector('.ai-suggest-all');
  assert(stillAll != null && /again/.test(stillAll.textContent), 'apply-all stays, offering to apply again');

  // Re-apply one row after (say) a revert: it stages again.
  document.querySelectorAll('.ai-edit-row')[0].querySelector('.ai-edit-apply').dispatch('click');
  eq(batches.length, 2, 'a row can be applied again');
  eq(batches[1].length, 1, 'the re-apply stages only that row');
  eq(batches[1][0].item_id, 3, 'the re-applied row is the first edit');

  restore();
}

// ---------- applying one row leaves the rest and updates apply-all ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();

  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => MULTI_EDIT_RESULT],
  ]);

  const batches = [];
  registerAgentContext(editContext({
    applyEditsFromExtraction: (eds) => { batches.push(eds); },
  }));

  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'update both';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const rows = document.querySelectorAll('.ai-edit-row');
  rows[0].querySelector('.ai-edit-apply').dispatch('click');
  eq(batches.length, 1, 'first row Apply stages one batch');
  eq(batches[0].length, 1, 'the batch holds only the selected edit');
  eq(batches[0][0].item_id, 3, 'the selected edit is the first row');
  const allBtn = document.querySelector('.ai-suggest-all');
  assert(allBtn.textContent.includes('1'), 'apply-all count drops to the one remaining edit');

  // Apply all now stages only the remaining (not-yet-applied) edit.
  allBtn.dispatch('click');
  eq(batches.length, 2, 'apply-all stages the remainder');
  eq(batches[1].length, 1, 'only the remaining edit is staged');
  eq(batches[1][0].item_id, 4, 'the remaining edit is the second row');
  const afterAll = document.querySelector('.ai-suggest-all');
  assert(afterAll != null && /again/.test(afterAll.textContent),
         'apply-all stays after every row is applied, offering to apply again');

  restore();
}

// ---------- apply-all appears only on the newest reply ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();

  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => MULTI_EDIT_RESULT],
  ]);
  registerAgentContext(editContext());

  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'first';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  eq(document.querySelectorAll('.ai-suggest-all').length, 1, 'apply-all on the first reply');

  const allBtn = document.querySelector('.ai-suggest-all');
  allBtn.dispatch('click');
  assert(document.querySelector('.ai-suggest-all') != null, 'apply-all stays after clicking (can apply again)');

  input.value = 'second';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  eq(document.querySelectorAll('.ai-suggest-all').length, 1, 'only the newest reply keeps apply-all');
  eq(document.querySelectorAll('.ai-edits-group').length, 2, 'both edit groups remain in the scrollback');

  restore();
}

// ---------- applying on an older reply must not clear the newest apply-all ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();

  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => MULTI_EDIT_RESULT],
  ]);
  registerAgentContext(editContext());

  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'first';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  input.value = 'second';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const groups = document.querySelectorAll('.ai-edits-group');
  eq(groups.length, 2, 'two replies with edits');
  // Apply both rows of the OLDER reply, emptying its pending set.
  const aRows = groups[0].querySelectorAll('.ai-edit-row');
  aRows[0].querySelector('.ai-edit-apply').dispatch('click');
  aRows[1].querySelector('.ai-edit-apply').dispatch('click');

  // The newest reply must keep its own apply-all.
  const newest = document.querySelectorAll('.ai-suggest-all');
  eq(newest.length, 1, 'older-reply applies do not remove the newest apply-all');
  assert(newest[0].textContent.includes('2'), 'newest apply-all still counts its own two edits');

  restore();
}

// ---------- no apply-all for a single edit ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'owner' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();

  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => ({
      reply: 'ok', items: [], edits: [{ item_id: 3, title: 'Solo' }],
    })],
  ]);
  registerAgentContext(editContext());

  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'one';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  assert(document.querySelector('.ai-suggest-all') == null, 'no apply-all for a single edit');

  restore();
}

// ---------- no apply-all when read-only ----------

{
  installDom({ ids: [] });
  window.__CONTEXT__ = { planId: 7, role: 'viewer' };
  const { initAgent, registerAgentContext } = await loadAgent();
  initAgent();

  const { restore } = installFetch([
    ['POST /api/plans/7/ai/chat', () => MULTI_EDIT_RESULT],
  ]);
  registerAgentContext({ canEdit: false, createItemFromExtraction: () => {}, getItemTitle: () => 'Item' });

  const input = document.querySelector('.ai-agent-input');
  const sendBtn = document.querySelector('.ai-agent-send');
  input.value = 'update both';
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  assert(document.querySelector('.ai-suggest-all') == null, 'no apply-all when read-only');
  eq(document.querySelectorAll('.ai-suggest-readonly').length, 2, 'both edits shown as read-only text');

  restore();
}

summary('ai-agent');
