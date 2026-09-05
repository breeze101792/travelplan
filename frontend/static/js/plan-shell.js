// plan-shell.js — SPA shell for plan sub-pages.
// Handles client-side routing, view lifecycle, and nav link interception.

import { hasPendingChanges, clearActiveStaging, confirmDiscard } from '/static/js/guard.js';

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
let _navigating = false;

function viewNameFromPath(path) {
  const m = path.match(/^\/plans\/\d+\/(\w+)/);
  if (m && VIEWS[m[1]]) return m[1];
  if (/^\/plans\/\d+$/.test(path)) return 'board';
  return null;
}

function urlForView(view) {
  const base = `/plans/${window.__CONTEXT__.planId}`;
  return view === 'board' ? base : `${base}/${view}`;
}

/* Prompt before leaving the current view when there are unsaved (pending)
 * changes. Resolves true when navigation may proceed: either there is nothing
 * pending, or the user confirmed they want to leave. */
async function confirmLeave() {
  if (!hasPendingChanges()) return true;
  return confirmDiscard(
    'You have unsaved changes that will be lost if you leave this page. Continue?',
    { confirmText: 'Leave', cancelText: 'Stay' }
  );
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
  if (_navigating) return;

  if (!(await confirmLeave())) {
    // Declined: on a browser back/forward (pushState=false) the address bar
    // has already moved, so restore it to the view we're actually showing.
    if (!pushState && window.__CONTEXT__) {
      history.pushState({ view: _currentView }, '', urlForView(_currentView));
    }
    return;
  }

  _navigating = true;
  try {
    const editBar = document.getElementById('edit-bar');
    if (editBar) editBar.hidden = true;

    // The outgoing view's staging is no longer the active one. The incoming
    // view registers its own staging during init (board/timeline/map only).
    clearActiveStaging();

    if (_currentCleanup) {
      _currentCleanup();
      _currentCleanup = null;
    }
    _currentView = view;

    const container = document.getElementById('plan-view');
    if (!container) return;

    container.innerHTML = '';
    updateNav(view);

    // Show the AI agent only on the board / timeline / map views.
    const { setAgentVisible } = await import('/static/js/ai-agent.js');
    setAgentVisible(view);

    if (pushState) {
      history.pushState({ view }, '', urlForView(view));
    }

    try {
      const mod = await VIEWS[view]();
      _currentCleanup = await mod.init(container, window.__CONTEXT__);
    } catch (e) {
      console.error(`Failed to load view "${view}":`, e);
      container.innerHTML = `<div class="error">Failed to load ${view} view</div>`;
    }
  } finally {
    _navigating = false;
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

  // Boot the floating AI agent widget (hidden until a board/timeline/map view).
  import('/static/js/ai-agent.js').then(({ initAgent }) => initAgent());

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
