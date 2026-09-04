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
  row.appendChild(el('div', { class: 'ai-msg-text', text: 'Suggested items:' }));
  const list = el('div', { class: 'ai-suggest' });
  for (const it of items) {
    if (!canEdit) {
      // Read-only (viewer role or archived plan): show the suggestion as
      // plain text instead of an actionable Add button.
      list.appendChild(el('div', { class: 'ai-suggest-readonly', text: `${it.item_type}: ${it.title}` }));
      continue;
    }
    const btn = el('button', {
      class: 'ai-suggest-btn',
      text: `+ ${it.item_type}: ${it.title}`,
    });
    btn.addEventListener('click', () => {
      if (!_agentContext || !_agentContext.createItemFromExtraction) {
        showToast('Open the board, timeline, or map to add items.', 'warn');
        return;
      }
      _agentContext.createItemFromExtraction(it);
    });
    list.appendChild(btn);
  }
  row.appendChild(list);
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
}
