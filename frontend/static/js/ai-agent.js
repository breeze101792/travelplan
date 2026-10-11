/* ai-agent.js — floating AI chat window for the plan pages.
 *
 * A draggable, collapsible chat window. The user sends text and optionally
 * attaches an image; the plan's AI assistant replies and may suggest
 * itinerary items. Suggested items are offered as "Add" buttons that open
 * the item editor pre-filled (via the active view's createItemFromExtraction).
 *
 * The widget lives in the SPA shell (survives view swaps) and is shown only
 * on the board / timeline / map views. Each of those views registers its
 * staging context via registerAgentContext() so the widget can reach the
 * active view's createItemFromExtraction().
 */
import { el, clear } from '/static/js/util.js';
import { showToast } from '/static/js/page-utils.js';
import { renderMarkdown } from '/static/js/markdown.js';

const STORAGE_KEY = 'travelplan.ai-agent';
const VISIBLE_VIEWS = new Set(['board', 'timeline', 'map']);
// Below this many suggested edits/items, the per-row buttons already cover the
// reply and a bulk "Apply all" / "Add all" button would just be noise.
const MIN_FOR_BULK_ACTION = 2;

const ICON_TITLE = 'Open AI Agent';
const ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path class="ai-agent-bubble" ' +
  'd="M7.5 3h9a5 5 0 0 1 5 5v4a5 5 0 0 1-5 5H6.5l-4 3.5V8a5 5 0 0 1 5-5Z"/>' +
  '<path class="ai-agent-spark" ' +
  'd="M12 5.4q1 3.6 4.6 4.6q-3.6 1-4.6 4.6q-1-3.6-4.6-4.6q3.6-1 4.6-4.6Z"/>' +
  '</svg>';

let _root = null;
let _body = null;
let _messages = null;
let _input = null;
let _sendBtn = null;
let _attachBtn = null;
let _fileInput = null;
let _pendingImage = null;   // { dataUrl, name }
let _agentContext = null;   // { createItemFromExtraction } from the active view
let _history = [];          // [{role, content}] sent to the backend
let _icon = null;           // small floating icon shown when minimized
let _minimized = true;      // start minimized (icon shown, window hidden)
let _latestBulk = [];       // bulk buttons (Apply all / Add all) on the newest reply only

/* ---------- context bridge ---------- */

export function registerAgentContext(ctx) {
  _agentContext = ctx;
}

export function getAgentContext() {
  return _agentContext;
}

/* ---------- drag ---------- */

function makeDraggable(handle, win) {
  let state = null;
  handle.addEventListener('mousedown', (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    down.stopPropagation();
    const rect = win.getBoundingClientRect();
    state = {
      startX: down.clientX,
      startY: down.clientY,
      origLeft: rect.left,
      origTop: rect.top,
    };
    const onMove = (move) => {
      if (!state) return;
      const dx = move.clientX - state.startX;
      const dy = move.clientY - state.startY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = win.offsetWidth || 360;
      const h = win.offsetHeight || 480;
      const left = Math.max(8, Math.min(state.origLeft + dx, vw - w - 8));
      const top = Math.max(8, Math.min(state.origTop + dy, vh - h - 8));
      win.style.left = left + 'px';
      win.style.top = top + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (state) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
            left: win.style.left, top: win.style.top,
          }));
        } catch (e) { /* storage unavailable */ }
      }
      state = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/* ---------- resize ---------- */

function makeResizable(handle, win) {
  handle.addEventListener('mousedown', (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    down.stopPropagation();
    const startW = win.offsetWidth || 360;
    const startH = win.offsetHeight || 480;
    const startX = down.clientX;
    const startY = down.clientY;
    const onMove = (move) => {
      const w = Math.max(280, Math.min(startW + (move.clientX - startX), window.innerWidth - 16));
      const h = Math.max(320, Math.min(startH + (move.clientY - startY), window.innerHeight - 16));
      win.style.width = w + 'px';
      win.style.height = h + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          left: win.style.left, top: win.style.top,
          width: win.style.width, height: win.style.height,
        }));
      } catch (e) { /* storage unavailable */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/* ---------- rendering ---------- */

// Bulk buttons belong to the newest reply only. Drop them all when a new turn
// starts (or the chat clears) so an old reply never keeps an "Apply all" /
// "Add all" control after newer replies have arrived.
function clearLatestBulkButtons() {
  for (const btn of _latestBulk) btn.remove();
  _latestBulk = [];
}

function addMessage(role, text, image) {
  const row = el('div', { class: 'ai-msg ai-msg-' + role });
  if (image) {
    row.appendChild(el('img', { class: 'ai-msg-img', src: image, alt: 'attached image' }));
  }
  if (text) {
    // Assistant replies are rendered as markdown (safe: HTML is escaped
    // first); user messages stay plain text.
    const body = el('div', { class: 'ai-msg-text' });
    if (role === 'assistant') {
      body.innerHTML = renderMarkdown(text);
    } else {
      body.textContent = text;
    }
    row.appendChild(body);
  }
  _messages.appendChild(row);
  _messages.scrollTop = _messages.scrollHeight;
  return row;
}

function addSuggestions(items) {
  if (!items || !items.length) return;
  const canEdit = !!( _agentContext && _agentContext.canEdit);
  const row = el('div', { class: 'ai-msg ai-msg-assistant' });
  row.appendChild(el('div', {
    class: 'ai-msg-text',
    text: `Suggested items (${items.length}):`,
  }));

  // Read-only (viewer / archived): show the suggestions as plain text.
  if (!canEdit) {
    const list = el('div', { class: 'ai-suggest' });
    for (const it of items) {
      list.appendChild(el('div', { class: 'ai-suggest-readonly', text: `${it.item_type}: ${it.title}` }));
    }
    row.appendChild(list);
    _messages.appendChild(row);
    _messages.scrollTop = _messages.scrollHeight;
    return;
  }

  const canBatch = !!(_agentContext && _agentContext.addItemsFromExtraction);
  const group = el('div', { class: 'ai-edits-group' });
  const list = el('ul', { class: 'ai-edit-list' });
  const pending = new Set(items.map((_, i) => i));   // indices not yet added
  let addAllBtn = null;

  function markAdded(i, li) {
    pending.delete(i);
    li.classList.add('ai-edit-applied');
    const btn = li.querySelector('.ai-edit-add');
    if (btn) { btn.textContent = '\u2713 Added'; btn.title = 'Add this item again'; }
  }

  function refreshAddAll() {
    if (!addAllBtn) return;
    // The button stays available after adding so the batch can be re-added
    // (e.g. after the user reverts); the label shows how many are left.
    addAllBtn.textContent = pending.size
      ? `+ Add all ${pending.size} item${pending.size === 1 ? '' : 's'}`
      : '+ Added \u2014 add all again';
  }

  function openEditor(it) {
    if (!_agentContext || !_agentContext.createItemFromExtraction) {
      showToast('Open the board, timeline, or map to add items.', 'warn');
      return;
    }
    _agentContext.createItemFromExtraction(it);
  }

  // Add one row: stage it directly when complete, else open its editor. Always
  // usable, including after the row was added, so a reverted add can be redone.
  function addOne(it, i, li) {
    if (!canBatch) { openEditor(it); return; }
    const wasPending = pending.has(i);
    const res = _agentContext.addItemsFromExtraction([it]);
    // An incomplete suggestion is opened in the editor by the view; its row
    // stays so the user can retry once the fields are filled.
    if (res && res.staged && res.staged.length) {
      markAdded(i, li);
      refreshAddAll();
      showToast(wasPending
        ? 'Added 1 item \u2014 review, then Save.'
        : 'Added 1 item again \u2014 review, then Save.', 'info');
    }
  }

  items.forEach((it, i) => {
    const li = el('li', { class: 'ai-edit-row' });
    li.appendChild(el('div', { class: 'ai-edit-desc' }, [
      el('span', { class: 'ai-edit-title', text: it.title || `(${it.item_type})` }),
      el('span', { class: 'ai-edit-change', text: describeItem(it) }),
    ]));
    const openBtn = el('button', {
      class: 'ai-edit-open', text: 'Edit', title: 'Open the item editor',
    });
    openBtn.addEventListener('click', () => openEditor(it));
    const addBtn = el('button', {
      class: 'ai-edit-add ai-edit-apply', text: 'Add', title: 'Add this item',
    });
    addBtn.addEventListener('click', () => addOne(it, i, li));
    li.appendChild(openBtn);
    li.appendChild(addBtn);
    list.appendChild(li);
  });
  group.appendChild(list);

  if (canBatch && items.length >= MIN_FOR_BULK_ACTION) {
    addAllBtn = el('button', {
      class: 'ai-suggest-btn ai-suggest-all',
      text: `+ Add all ${items.length} items`,
      title: 'Stage this reply\'s complete items as one grouped change; incomplete ones open in the editor',
    });
    addAllBtn.addEventListener('click', () => {
      // Add the not-yet-added items; once all are added, add the whole batch
      // again so a revert can be redone in one click.
      const selected = pending.size ? items.filter((_, i) => pending.has(i)) : items.slice();
      if (!selected.length) return;
      const res = _agentContext.addItemsFromExtraction(selected);
      const staged = (res && res.staged) || [];
      for (const i of [...pending]) {
        if (staged.indexOf(items[i]) === -1) continue;
        const li = list.children[i];
        if (li) markAdded(i, li);
      }
      refreshAddAll();
      const nInvalid = (res && res.invalid && res.invalid.length) || 0;
      showToast(nInvalid
        ? `Added ${staged.length} item${staged.length === 1 ? '' : 's'} \u2014 ${nInvalid} need review.`
        : `Added ${staged.length} item${staged.length === 1 ? '' : 's'} \u2014 review, then Save.`, 'info');
    });
    group.appendChild(addAllBtn);
    _latestBulk.push(addAllBtn);
  }

  row.appendChild(group);
  _messages.appendChild(row);
  _messages.scrollTop = _messages.scrollHeight;
}

// Short human summary of a suggested item, shown next to its title.
function describeItem(it) {
  const parts = [];
  const details = it.details || {};
  const when = it.when || details.when;
  if (when && when.start_at) parts.push(String(when.start_at).replace('T', ' '));
  else if (it.item_date) parts.push(it.item_date);
  for (const [k, v] of Object.entries(details)) {
    if (k === 'when' || v == null || v === '') continue;
    parts.push(`${k}: ${v}`);
  }
  return parts.join(', ') || it.item_type;
}

// Short human summary of what one edit changes, shown next to its item title.
function describeEdit(ed) {
  const parts = [];
  if (ed.title) parts.push(`title \u2192 \u201c${ed.title}\u201d`);
  if (ed.when && ed.when.start_at) {
    const timeOf = (s) => { const m = String(s).match(/T(\d{2}:\d{2})/); return m ? m[1] : ''; };
    const day = String(ed.when.start_at).slice(0, 10);
    const st = timeOf(ed.when.start_at);
    let w = st ? `${day} ${st}` : day;
    if (timeOf(ed.when.end_at)) w += `\u2013${timeOf(ed.when.end_at)}`;
    parts.push(`time \u2192 ${w}`);
  }
  if (ed.details) {
    for (const [k, v] of Object.entries(ed.details)) {
      if (v == null || v === '') continue;
      parts.push(`${k}: ${v}`);
    }
  }
  if (ed.geocodes && ed.geocodes.length) parts.push('location updated');
  return parts.join(', ') || 'update';
}

function itemTitleFor(ed) {
  return (_agentContext && _agentContext.getItemTitle)
    ? (_agentContext.getItemTitle(ed.item_id) || `item #${ed.item_id}`)
    : `item #${ed.item_id}`;
}

function addEdits(edits) {
  if (!edits || !edits.length) return;
  const canEdit = !!( _agentContext && _agentContext.canEdit);
  const row = el('div', { class: 'ai-msg ai-msg-assistant' });
  row.appendChild(el('div', {
    class: 'ai-msg-text',
    text: `Suggested edits (${edits.length}):`,
  }));

  // Read-only (viewer / archived): list the edits as plain text.
  if (!canEdit) {
    const list = el('div', { class: 'ai-suggest' });
    for (const ed of edits) {
      list.appendChild(el('div', {
        class: 'ai-suggest-readonly',
        text: `${itemTitleFor(ed)} \u2014 ${describeEdit(ed)}`,
      }));
    }
    row.appendChild(list);
    _messages.appendChild(row);
    _messages.scrollTop = _messages.scrollHeight;
    return;
  }

  // Only the newest reply keeps an "Apply all" button; older replies keep
  // their per-row Apply buttons so the user can still apply one at a time.
  const group = el('div', { class: 'ai-edits-group' });
  const list = el('ul', { class: 'ai-edit-list' });
  const pending = new Set(edits.map((_, i) => i));   // indices not yet applied
  let allBtn = null;

  // Stage the chosen edits. Returns false when nothing could be staged.
  function stage(selected) {
    if (_agentContext && _agentContext.applyEditsFromExtraction) {
      return _agentContext.applyEditsFromExtraction(selected) !== false;
    }
    showToast('Open the board, timeline, or map to apply edits.', 'warn');
    return false;
  }

  function markApplied(i, li, btn) {
    pending.delete(i);
    li.classList.add('ai-edit-applied');
    btn.textContent = '\u2713 Applied';
    btn.title = 'Apply this change again';
  }

  function refreshApplyAll() {
    if (!allBtn) return;
    // The button stays available after applying so the batch can be re-applied
    // (e.g. after the user reverts); the label shows how many are left.
    allBtn.textContent = pending.size
      ? `\u2713 Apply all ${pending.size} edit${pending.size === 1 ? '' : 's'}`
      : '\u2713 Applied \u2014 apply all again';
  }

  edits.forEach((ed, i) => {
    const li = el('li', { class: 'ai-edit-row' });
    li.appendChild(el('div', { class: 'ai-edit-desc' }, [
      el('span', { class: 'ai-edit-title', text: itemTitleFor(ed) }),
      el('span', { class: 'ai-edit-change', text: describeEdit(ed) }),
    ]));
    const openBtn = el('button', {
      class: 'ai-edit-open', text: 'Edit',
      title: 'Open the full editor for this change',
    });
    openBtn.addEventListener('click', () => {
      if (!_agentContext || !_agentContext.editItemFromExtraction) {
        showToast('Open the board, timeline, or map to edit items.', 'warn');
        return;
      }
      _agentContext.editItemFromExtraction(ed);
    });
    const applyBtn = el('button', {
      class: 'ai-edit-apply', text: 'Apply', title: 'Stage this change',
    });
    applyBtn.addEventListener('click', () => {
      // Always usable, including after the row was applied, so a reverted edit
      // can be staged again.
      const wasPending = pending.has(i);
      if (!stage([ed])) return;
      markApplied(i, li, applyBtn);
      refreshApplyAll();
      showToast(wasPending
        ? 'Applied 1 edit \u2014 review, then Save.'
        : 'Applied 1 edit again \u2014 review, then Save.', 'info');
    });
    li.appendChild(openBtn);
    li.appendChild(applyBtn);
    list.appendChild(li);
  });
  group.appendChild(list);

  if (edits.length >= MIN_FOR_BULK_ACTION) {
    allBtn = el('button', {
      class: 'ai-suggest-btn ai-suggest-all',
      text: `\u2713 Apply all ${edits.length} edits`,
      title: 'Stage this reply\'s edits as one grouped change',
    });
    allBtn.addEventListener('click', () => {
      // Apply the not-yet-applied edits; once all are applied, apply the whole
      // batch again so a revert can be redone in one click.
      const selected = pending.size ? edits.filter((_, i) => pending.has(i)) : edits.slice();
      if (!selected.length || !stage(selected)) return;
      for (const i of [...pending]) {
        const li = list.children[i];
        const btn = li && li.querySelector('.ai-edit-apply');
        if (li && btn) markApplied(i, li, btn);
      }
      refreshApplyAll();
      showToast(`Applied ${selected.length} edits \u2014 review, then Save.`, 'info');
    });
    group.appendChild(allBtn);
    _latestBulk.push(allBtn);
  }

  row.appendChild(group);
  _messages.appendChild(row);
  _messages.scrollTop = _messages.scrollHeight;
}

function setBusy(busy) {
  _sendBtn.disabled = busy;
  _sendBtn.textContent = busy ? '…' : 'Send';
}

/* ---------- typing indicator ---------- */

let _typingEl = null;

function showTyping() {
  if (_typingEl) return;
  _typingEl = el('div', { class: 'ai-msg ai-msg-assistant ai-typing' }, [
    el('span', { class: 'ai-typing-dot' }),
    el('span', { class: 'ai-typing-dot' }),
    el('span', { class: 'ai-typing-dot' }),
  ]);
  _messages.appendChild(_typingEl);
  _messages.scrollTop = _messages.scrollHeight;
}

function hideTyping() {
  if (_typingEl) {
    _typingEl.remove();
    _typingEl = null;
  }
}

/* ---------- send ---------- */

async function send() {
  const text = _input.value.trim();
  const image = _pendingImage;
  if (!text && !image) return;
  if (!_agentContext) {
    showToast('Open the board, timeline, or map to use the AI agent.', 'warn');
    return;
  }

  addMessage('user', text, image ? image.dataUrl : null);
  _history.push({ role: 'user', content: text });
  clearLatestBulkButtons();
  _input.value = '';
  _pendingImage = null;
  renderAttach();
  setBusy(true);
  showTyping();

  try {
    const res = await fetch(`/api/plans/${window.__CONTEXT__.planId}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: _history,
        image: image ? image.dataUrl : null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      addMessage('assistant', data.error || 'AI request failed');
      _history.push({ role: 'assistant', content: data.error || 'AI request failed' });
      return;
    }
    addMessage('assistant', data.reply || '');
    addSuggestions(data.items || []);
    addEdits(data.edits || []);
    _history.push({ role: 'assistant', content: data.reply || '' });
  } catch (e) {
    addMessage('assistant', 'AI request failed: ' + e.message);
    _history.push({ role: 'assistant', content: 'AI request failed: ' + e.message });
  } finally {
    hideTyping();
    setBusy(false);
  }
}

/* ---------- image attach ---------- */

function renderAttach() {
  clear(_attachBtn);
  if (_pendingImage) {
    _attachBtn.appendChild(el('span', { class: 'ai-attach-name', text: _pendingImage.name }));
  } else {
    _attachBtn.appendChild(el('span', { text: '📎' }));
  }
}

function onFileSelected(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Only images can be attached.', 'warn');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    _pendingImage = { dataUrl: reader.result, name: file.name };
    renderAttach();
  };
  reader.readAsDataURL(file);
}

// Paste an image from the clipboard (e.g. a screenshot) into the chat.
function onPaste(e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        onFileSelected(file);
        return;
      }
    }
  }
}

/* ---------- lifecycle ---------- */

export function initAgent() {
  if (_root) return;
  _root = el('div', { id: 'ai-agent', class: 'ai-agent' });
  const header = el('div', { class: 'ai-agent-header' }, [
    el('span', { class: 'ai-agent-title', text: 'AI Agent' }),
    el('div', { class: 'ai-agent-header-actions' }, [
      el('button', { class: 'ai-agent-clear', text: '🗑', title: 'Clear chat' }),
      el('button', { class: 'ai-agent-toggle', text: '−', title: 'Collapse' }),
    ]),
  ]);
  _messages = el('div', { class: 'ai-agent-messages' });
  _messages.appendChild(el('div', {
    class: 'ai-msg ai-msg-assistant ai-msg-welcome',
    text: 'Hi! I can help plan your trip. Paste a ticket or confirmation, ask a question, or attach an image.',
  }));

  const composer = el('div', { class: 'ai-agent-composer' }, [
    el('div', { class: 'ai-agent-inputrow' }, [
      _input = el('textarea', {
        class: 'ai-agent-input',
        placeholder: 'Ask a question or paste a ticket…',
        rows: 1,
      }),
      _attachBtn = el('button', { class: 'ai-agent-attach', title: 'Attach image' }),
      _sendBtn = el('button', { class: 'ai-agent-send', text: 'Send' }),
    ]),
  ]);
  _fileInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  composer.appendChild(_fileInput);

  _body = el('div', { class: 'ai-agent-body' }, [_messages, composer]);
  _root.appendChild(header);
  _root.appendChild(_body);
  _root.appendChild(el('div', { class: 'ai-agent-resize', title: 'Resize' }));
  document.body.appendChild(_root);

  // Start minimized: hide the window, show the icon.
  _root.hidden = true;
  minimize();

  _sendBtn.addEventListener('click', send);
  _input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  _input.addEventListener('paste', onPaste);
  _attachBtn.addEventListener('click', () => _fileInput.click());
  _fileInput.addEventListener('change', () => onFileSelected(_fileInput.files && _fileInput.files[0]));

  const toggle = _root.querySelector('.ai-agent-toggle');
  toggle.addEventListener('click', minimize);

  _root.querySelector('.ai-agent-clear').addEventListener('click', clearChat);

  makeDraggable(header, _root);
  makeResizable(_root.querySelector('.ai-agent-resize'), _root);

  // Restore saved position and size.
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && saved.left && saved.top) {
      _root.style.left = saved.left;
      _root.style.top = saved.top;
    }
    if (saved && saved.width && saved.height) {
      _root.style.width = saved.width;
      _root.style.height = saved.height;
    }
  } catch (e) { /* ignore */ }
}

/* ---------- minimize / restore ---------- */

function minimize() {
  _minimized = true;
  _root.hidden = true;
  if (!_icon) {
    _icon = el('button', {
      id: 'ai-agent-icon',
      class: 'ai-agent-icon',
      title: ICON_TITLE,
      'aria-label': ICON_TITLE,
      html: ICON_SVG,
    });
    _icon.addEventListener('click', restore);
    document.body.appendChild(_icon);
  }
  _icon.hidden = false;
}

function restore() {
  _minimized = false;
  _root.hidden = false;
  if (_icon) _icon.hidden = true;
}

/* ---------- clear chat ---------- */

function clearChat() {
  if (!confirm('Clear the AI chat history?')) return;
  // Remove all message bubbles except the welcome one.
  for (const node of [..._messages.children]) {
    node.remove();
  }
  _messages.appendChild(el('div', {
    class: 'ai-msg ai-msg-assistant ai-msg-welcome',
    text: 'Hi! I can help plan your trip. Paste a ticket or confirmation, ask a question, or attach an image.',
  }));
  hideTyping();
  _history = [];
  clearLatestBulkButtons();
}

export function setAgentVisible(view) {
  if (!_root) return;
  const visible = VISIBLE_VIEWS.has(view);
  if (!visible) {
    // Not a supported view: hide both the window and the icon.
    _root.hidden = true;
    if (_icon) _icon.hidden = true;
    return;
  }
  // Supported view: show the window if open, otherwise the minimized icon.
  _root.hidden = _minimized;
  if (_icon) _icon.hidden = !_minimized;
}

/* Test hook: drop the cached widget so a fresh page can re-init. */
export function resetAgent() {
  _root = null;
  _body = null;
  _messages = null;
  _input = null;
  _sendBtn = null;
  _attachBtn = null;
  _fileInput = null;
  _pendingImage = null;
  _agentContext = null;
  _history = [];
  _icon = null;
  _minimized = true;
  _latestBulk = [];
}
