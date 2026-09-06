/* notifications.js — central in-website notification system.
 *
 * Subscribes to SSE events from plan-store and creates notifications
 * for changes made by other users. Notifications persist in localStorage
 * and survive page reloads within the same plan.
 *
 * Usage: import and call init() once the plan shell loads.
 */
import { el, clear } from '/static/js/util.js';

const STORAGE_KEY = 'tp_notifications';
const MAX_NOTIFICATIONS = 50;
const TRIM_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let _notifications = [];
let _planId = null;
let _currentUserId = null;
let _dropdown = null;
let _badge = null;
let _list = null;
let _isOpen = false;

/* ---- persistence ---- */

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _notifications = raw ? JSON.parse(raw) : [];
  } catch {
    _notifications = [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_notifications));
  } catch { /* non-fatal */ }
}

function trimOld() {
  const cutoff = Date.now() - TRIM_AGE_MS;
  _notifications = _notifications.filter(n => n.ts > cutoff);
  if (_notifications.length > MAX_NOTIFICATIONS) {
    _notifications = _notifications.slice(0, MAX_NOTIFICATIONS);
  }
}

/* ---- notification model ---- */

function addNotification(type, entityLabel, planId) {
  // Don't duplicate the most recent notification of the same type+entity
  if (_notifications.length > 0) {
    const last = _notifications[0];
    if (last.type === type && last.entityLabel === entityLabel && last.planId === planId) return;
  }
  const n = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type,
    entityLabel,
    planId,
    ts: Date.now(),
    read: false,
  };
  _notifications.unshift(n);
  trimOld();
  save();
  render();
}

function markAllRead() {
  for (const n of _notifications) n.read = true;
  save();
  render();
}

function dismiss(id) {
  _notifications = _notifications.filter(n => n.id !== id);
  save();
  render();
}

function clearAll() {
  _notifications = [];
  save();
  render();
}

/* ---- human-readable labels ---- */

const LABELS = {
  'item.created':    'New item added',
  'item.updated':    'Item updated',
  'item.deleted':    'Item removed',
  'item.moved':      'Item moved',
  'expense.created': 'Expense added',
  'expense.updated': 'Expense updated',
  'expense.deleted': 'Expense removed',
  'payment.created': 'Payment recorded',
  'payment.updated': 'Payment updated',
  'payment.deleted': 'Payment removed',
  'member.added':    'Member joined',
  'member.updated':  'Member role changed',
  'member.removed':  'Member removed',
  'plan.updated':    'Plan updated',
};

function labelFor(type) {
  return LABELS[type] || type;
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const d = Math.floor(hr / 24);
  return d + 'd ago';
}

/* ---- rendering ---- */

function render() {
  if (!_badge || !_list) return;
  const unread = _notifications.filter(n => !n.read).length;
  _badge.textContent = unread || '';
  _badge.style.display = unread ? '' : 'none';

  clear(_list);
  if (_notifications.length === 0) {
    _list.appendChild(el('div', { class: 'notif-empty', text: 'No notifications' }));
    return;
  }
  for (const n of _notifications) {
    const row = el('div', { class: 'notif-row' + (n.read ? '' : ' unread') });
    const dot = el('span', { class: 'notif-dot' });
    const body = el('div', { class: 'notif-body' });
    body.appendChild(el('span', { class: 'notif-msg', text: labelFor(n.type) }));
    body.appendChild(el('span', { class: 'notif-time', text: timeAgo(n.ts) }));
    row.appendChild(dot);
    row.appendChild(body);
    const dismissBtn = el('button', { class: 'notif-dismiss', text: '\u00d7', title: 'Dismiss' });
    dismissBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(n.id); });
    row.appendChild(dismissBtn);
    _list.appendChild(row);
  }
}

/* ---- public API ---- */

export function getUnreadCount() {
  return _notifications.filter(n => !n.read).length;
}

export function init(opts) {
  _planId = opts.planId || null;
  _currentUserId = opts.currentUserId || null;
  load();
  trimOld();
  save();

  _dropdown = document.querySelector('.notif-dropdown');
  if (!_dropdown) return;

  const trigger = _dropdown.querySelector('.notif-trigger');
  _badge = _dropdown.querySelector('.notif-badge');
  _list = _dropdown.querySelector('.notif-list');
  const clearBtn = _dropdown.querySelector('#notif-clear-btn');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    _isOpen = !_dropdown.classList.contains('open');
    _dropdown.classList.toggle('open', _isOpen);
    if (_isOpen) {
      markAllRead();
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearAll();
    });
  }

  document.addEventListener('click', (e) => {
    if (!_dropdown.contains(e.target)) {
      _isOpen = false;
      _dropdown.classList.remove('open');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      _isOpen = false;
      _dropdown.classList.remove('open');
    }
  });

  render();
}

/**
 * Called by plan-store when an SSE event arrives. Creates a notification
 * if the event is from a different user (or always for non-user events
 * like plan updates).
 */
export function onSSEEvent(event, currentUserId) {
  if (!event || !event.type) return;
  // Skip events from the current user — they already know what they did
  if (event.user_id && currentUserId && event.user_id === currentUserId) return;
  addNotification(event.type, event.entityLabel || '', _planId);
}

/**
 * Reset notifications for a new plan context.
 */
export function resetForPlan(planId) {
  _planId = planId;
  render();
}
