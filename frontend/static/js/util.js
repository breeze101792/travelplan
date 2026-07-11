// util.js — small DOM + formatting helpers shared across page modules.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Format an integer cents amount with Intl.NumberFormat.
// decimals=0 is used for zero-decimal currencies (JPY/KRW).
//   money(40000, 0, 'JPY') -> 'JPY 40,000'
//   money(12000, 2, 'USD') -> 'USD 120.00'
export function money(cents, decimals, currency) {
  if (cents == null || isNaN(cents)) cents = 0;
  const d = decimals == null ? 2 : decimals;
  const value = Number(cents) / Math.pow(10, d);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    }).format(value);
  } catch (e) {
    // Fallback if currency code is unknown.
    return (currency || '') + ' ' + value.toFixed(d);
  }
}

// 'Jul 1, 2026'; tolerant of null/empty -> ''
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

// 'Jul 1, 2026, 14:30'
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ', ' + hh + ':' + mm;
}

// Create an element. attrs supports: class, dataset, text, html, and common
// HTML attributes (value, type, placeholder, onclick, for, href, src, cols,
// rows, step, min, max, name, id, ...). children is an array of nodes/strings.
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val == null || val === false) continue;
    switch (key) {
      case 'class':
        node.className = val;
        break;
      case 'dataset':
        for (const [dk, dv] of Object.entries(val)) node.dataset[dk] = dv;
        break;
      case 'text':
        node.textContent = val;
        break;
      case 'html':
        node.innerHTML = val;
        break;
      case 'onclick':
        node.addEventListener('click', val);
        break;
      case 'onchange':
        node.addEventListener('change', val);
        break;
      case 'oninput':
        node.addEventListener('input', val);
        break;
      case 'onsubmit':
        node.addEventListener('submit', val);
        break;
      case 'style':
        if (typeof val === 'string') node.setAttribute('style', val);
        else Object.assign(node.style, val);
        break;
      case 'for':
        node.setAttribute('for', val);
        break;
      default:
        if (key in node) {
          try { node[key] = val; } catch (e) { node.setAttribute(key, val); }
        } else {
          node.setAttribute(key, val);
        }
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const child of kids) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Replace all children of a node.
export function clear(node) {
  node.replaceChildren();
}

let _settingsCache = null;
// GET /api/settings, cached for the lifetime of the page.
export async function loadSettings() {
  if (_settingsCache) return _settingsCache;
  const res = await fetch('/api/settings', { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('failed to load settings');
  _settingsCache = await res.json();
  return _settingsCache;
}

// Small <span> badge for an item status.
export function statusBadge(status) {
  const label = (status || '').charAt(0).toUpperCase() + (status || '').slice(1);
  return el('span', { class: 'badge status-' + (status || 'planned'), text: label });
}