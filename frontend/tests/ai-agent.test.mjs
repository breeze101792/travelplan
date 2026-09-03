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
      item_date: '2026-09-10', end_date: '2026-09-10' },
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
  assert(root.hidden === false, 'widget visible by default');

  setAgentVisible('board');
  assert(root.hidden === false, 'visible on board');
  setAgentVisible('expenses');
  assert(root.hidden === true, 'hidden on expenses');
  setAgentVisible('map');
  assert(root.hidden === false, 'visible on map');
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

summary('ai-agent');
