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

  // suggestion button offered
  const suggestBtn = document.querySelector('.ai-suggest-btn');
  assert(suggestBtn != null, 'suggestion button rendered');
  suggestBtn.dispatch('click');
  assert(received != null, 'createItemFromExtraction called on suggestion click');
  eq(received.item_type, 'transit', 'suggested item_type passed through');
  eq(received.title, 'JL 123', 'suggested title passed through');
  eq(received.geocodes[0].lat, 35.68, 'suggested geocodes passed through');

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

  let receivedEdit = null;
  registerAgentContext({
    canEdit: true,
    createItemFromExtraction: () => {},
    editItemFromExtraction: (ed) => { receivedEdit = ed; },
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

  // edit button offered, labeled with the item title
  const editBtn = document.querySelector('.ai-suggest-btn');
  assert(editBtn != null, 'edit button rendered');
  assert(editBtn.textContent.includes('Edit Beverly Hotels Elements'), 'edit button labels the item title');
  assert(!editBtn.textContent.includes('item #3'), 'edit button does not show the raw id');
  editBtn.dispatch('click');
  assert(receivedEdit != null, 'editItemFromExtraction called on edit click');
  eq(receivedEdit.item_id, 3, 'edit item_id passed through');
  eq(receivedEdit.when.end_at, '2026-09-30T11:00', 'edit when passed through');

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

  const editBtn = document.querySelector('.ai-suggest-btn');
  assert(editBtn == null, 'no edit button when read-only');
  const readonly = document.querySelector('.ai-suggest-readonly');
  assert(readonly != null, 'read-only edit shown as text');
  assert(readonly.textContent.includes('Edit Beverly Hotels Elements'), 'read-only edit shows item title');

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

summary('ai-agent');
