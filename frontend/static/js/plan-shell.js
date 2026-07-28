// plan-shell.js — SPA shell for plan sub-pages.
// Handles client-side routing, view lifecycle, and nav link interception.

const VIEWS = {
  overview:   () => import('/static/js/views/overview.js'),
  board:      () => import('/static/js/views/board.js'),
  timeline:   () => import('/static/js/views/timeline.js'),
  map:        () => import('/static/js/views/map.js'),
  navigation: () => import('/static/js/views/navigation.js'),
  expenses:   () => import('/static/js/views/expenses.js'),
  members:    () => import('/static/js/views/members.js'),
};

let _currentView = null;
let _currentCleanup = null;

function viewNameFromPath(path) {
  const m = path.match(/^\/plans\/\d+\/(\w+)/);
  if (m && VIEWS[m[1]]) return m[1];
  if (/^\/plans\/\d+$/.test(path)) return 'board';
  return null;
}

function updateNav(view) {
  document.querySelectorAll('.pn-link').forEach(el => {
    el.classList.toggle('active', el.getAttribute('href')?.endsWith(`/${view}`) ||
      (view === 'board' && /\/plans\/\d+$/.test(el.getAttribute('href') || '')));
    el.removeAttribute('aria-current');
    if (el.classList.contains('active')) el.setAttribute('aria-current', 'page');
  });
}

export async function navigate(view, pushState = true) {
  if (view === _currentView) return;
  if (_currentCleanup) {
    _currentCleanup();
    _currentCleanup = null;
  }
  _currentView = view;

  const container = document.getElementById('plan-view');
  if (!container) return;

  container.innerHTML = '';
  updateNav(view);

  if (pushState) {
    const base = `/plans/${window.__CONTEXT__.planId}`;
    const url = view === 'board' ? base : `${base}/${view}`;
    history.pushState({ view }, '', url);
  }

  try {
    const mod = await VIEWS[view]();
    _currentCleanup = await mod.init(container, window.__CONTEXT__);
  } catch (e) {
    console.error(`Failed to load view "${view}":`, e);
    container.innerHTML = `<div class="error">Failed to load ${view} view</div>`;
  }
}

function handleNavClick(e) {
  const link = e.target.closest('.pn-link');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href || href === '/') return;
  const view = viewNameFromPath(href);
  if (!view) return;
  e.preventDefault();
  navigate(view);
}

function handlePopState(e) {
  const view = e.state?.view || viewNameFromPath(location.pathname) || 'board';
  navigate(view, false);
}

function initShell(context) {
  window.__CONTEXT__ = context;
  document.querySelector('.plan-nav')?.addEventListener('click', handleNavClick);
  window.addEventListener('popstate', handlePopState);

  document.getElementById('plan-refresh-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('plan-refresh-btn');
    btn.disabled = true;
    btn.textContent = '⟳';
    try {
      const { refresh } = await import('/static/js/plan-store.js');
      await refresh(['plan', 'item', 'member', 'expense']);
    } finally {
      btn.disabled = false;
      btn.textContent = '↻';
    }
  });

  const initialView = document.getElementById('plan-view')?.dataset?.view || 'board';
  navigate(initialView, false);
}

// Auto-init when loaded as a module (window.__CONTEXT__ is set in the template)
if (window.__CONTEXT__) {
  initShell(window.__CONTEXT__);
}
