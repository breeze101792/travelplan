import { apiGet, apiPatch } from '/static/js/api.js';
import { el, clear, fmtDate, loadSettings } from '/static/js/util.js';
import { wirePlanHeaderDirect } from '/static/js/plan-header.js';
import { lockBodyScroll, unlockBodyScroll } from '/static/js/page-utils.js';

let ctx, plan, settings, allItems, members;

export async function initOverview(pageCtx) {
  ctx = pageCtx;

  const [settingsRes, planRes, itemsRes, memRes] = await Promise.all([
    loadSettings().catch(() => null),
    apiGet(`/api/plans/${ctx.planId}`).catch(() => null),
    apiGet(`/api/plans/${ctx.planId}/items`).catch(() => null),
    apiGet(`/api/plans/${ctx.planId}/members`).catch(() => ({ owner: null, members: [] })),
  ]);

  settings = settingsRes;
  plan = planRes.plan;
  allItems = itemsRes.items || [];
  members = memRes.owner ? [memRes.owner, ...(memRes.members || [])] : [];

  if (!plan) {
    document.getElementById('overview-root').textContent = 'Failed to load plan.';
    return;
  }

  wirePlanHeaderDirect({ planId: ctx.planId, role: ctx.role });
  render();
}

function render() {
  const root = document.getElementById('overview-root');
  if (!root) return;
  clear(root);

  const statusLabels = { planning: 'Planning', ongoing: 'Ongoing', archived: 'Archived' };

  const days = plan.start_date && plan.end_date
    ? Math.round((new Date(plan.end_date + 'T00:00:00') - new Date(plan.start_date + 'T00:00:00')) / 86400000) + 1
    : 0;

  // Section header
  root.appendChild(el('div', { class: 'ov-section-header' }, [
    el('h2', { text: 'Trip Details' }),
  ]));

  // Stat cards
  const cards = el('div', { class: 'ov-grid' }, [
    statCard('Calendar days', String(days), 'Duration of the trip'),
    statCard('Items', String(allItems.length), 'Total items in this trip'),
    statCard('Members', String(members.length), 'People on this trip'),
    statCard('Status', statusLabels[plan.status] || plan.status || 'Unknown', plan.status === 'planning' ? 'Still planning' : plan.status === 'ongoing' ? 'Trip is happening' : 'Archived'),
    statCard('Currency', plan.base_currency || 'USD', 'Base currency for expenses'),
  ]);
  root.appendChild(cards);

  // Description
  root.appendChild(el('div', { class: 'ov-section-header' }, [
    el('h2', { text: 'Description' }),
  ]));
  root.appendChild(el('div', { class: 'ov-section' }, [
    el('p', { class: 'ov-desc', text: plan.description || '' }),
  ]));

  // Edit button
  if (ctx.role !== 'viewer') {
    root.appendChild(el('div', { class: 'ov-actions' }, [
      el('button', {
        type: 'button', class: 'btn primary', text: 'Edit trip',
        onclick: () => openEditModal(),
      }),
    ]));
  }
}

function statCard(label, value, tooltip) {
  return el('div', { class: 'ov-stat-card', title: tooltip }, [
    el('span', { class: 'ov-stat-value', text: value }),
    el('span', { class: 'ov-stat-label', text: label }),
  ]);
}

function openEditModal() {
  const backdrop = el('div', { class: 'modal-backdrop editor-backdrop' });
  const modal = el('div', { class: 'modal plan-editor' });

  const baseCurrencies = (settings && settings.base_currencies) || ['USD'];
  function currencySelect(selected) {
    const sel = el('select', { name: 'base_currency' });
    for (const c of baseCurrencies) {
      const opt = el('option', { value: c, text: c });
      if (selected && c === selected) opt.selected = true;
      sel.appendChild(opt);
    }
    return sel;
  }

  const form = el('form', { autocomplete: 'off' }, [
    el('div', { class: 'modal-header' }, [
      el('h3', { text: 'Edit trip' }),
      el('button', { type: 'button', class: 'modal-close', text: '\u00d7',
        onclick: () => { backdrop.remove(); unlockBodyScroll(); } }),
    ]),
    el('div', { class: 'modal-body' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Title' }),
        el('input', { type: 'text', name: 'title', value: plan.title || '' }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Description' }),
        el('textarea', { name: 'description', rows: 3 }, [plan.description || '']),
      ]),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [
          el('span', { class: 'field-label', text: 'Start date' }),
          el('input', { type: 'date', name: 'start_date', value: plan.start_date || '' }),
        ]),
        el('label', { class: 'field' }, [
          el('span', { class: 'field-label', text: 'End date' }),
          el('input', { type: 'date', name: 'end_date', value: plan.end_date || '' }),
        ]),
      ]),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [
          el('span', { class: 'field-label', text: 'Base currency' }),
          currencySelect(plan.base_currency),
        ]),
        el('label', { class: 'field' }, [
          el('span', { class: 'field-label', text: 'Status' }),
          el('select', { name: 'status' }, [
            el('option', { value: 'planning', selected: plan.status === 'planning' }, ['Planning']),
            el('option', { value: 'ongoing', selected: plan.status === 'ongoing' }, ['Ongoing']),
            el('option', { value: 'archived', selected: plan.status === 'archived' }, ['Archived']),
          ]),
        ]),
      ]),
    ]),
    el('div', { class: 'modal-footer' }, [
      el('button', { type: 'button', class: 'btn ghost', text: 'Cancel',
        onclick: () => { backdrop.remove(); unlockBodyScroll(); } }),
      el('button', { type: 'submit', class: 'btn primary', text: 'Save' }),
      el('span', { class: 'form-msg', role: 'status' }),
    ]),
  ]);

  modal.appendChild(form);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  // Lock the body scroll while the modal is open. Without this, iOS
  // Safari's elastic overscroll on the modal body can still scroll
  // the page behind the modal — and that scroll bleeds into the
  // page's pull-to-refresh. The CSS `overscroll-behavior: contain`
  // blocks the visual scroll; this is the body-scroll lock that
  // stops the touch-driven pull-to-refresh.
  lockBodyScroll();

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) { backdrop.remove(); unlockBodyScroll(); }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const msgEl = form.querySelector('.form-msg');
    try {
      msgEl.textContent = 'Saving\u2026';
      const res = await apiPatch(`/api/plans/${ctx.planId}`, data);
      plan = res.plan;
      backdrop.remove();
      unlockBodyScroll();
      render();
    } catch (e) {
      msgEl.textContent = e.message || 'Failed to save.';
    }
  });
}
