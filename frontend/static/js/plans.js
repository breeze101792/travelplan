// plans.js — dashboard: list/create/edit/delete trips.
import {
  apiGet, apiPost, apiPatch, apiDel,
} from '/static/js/api.js';
import {
  el, clear, fmtDate, loadSettings,
} from '/static/js/util.js';

// Module-scoped cache of currencies for the create/edit selects.
let baseCurrencies = ['USD'];

/**
 * Initialize the dashboard: wire up the new-trip form and render plans.
 * @param {object} _ctx window.__CONTEXT__ (empty for dashboard)
 */
export async function initDashboard(_ctx) {
  const newToggle = document.getElementById('new-trip-toggle');
  const newForm = document.getElementById('new-trip-form');
  const plansSection = document.getElementById('plans');

  // Load settings first so currency selects are populated.
  try {
    const settings = await loadSettings();
    if (Array.isArray(settings.base_currencies) && settings.base_currencies.length) {
      baseCurrencies = settings.base_currencies;
    }
  } catch (e) {
    // Non-fatal: fall back to default currency list.
    console.warn('settings load failed', e);
  }

  populateCurrencySelect(newForm.querySelector('[name=base_currency]'));

  if (newToggle) {
    newToggle.addEventListener('click', () => {
      newForm.classList.toggle('hidden');
      if (!newForm.classList.contains('hidden')) {
        newForm.querySelector('[name=title]').focus();
      }
    });
  }

  newForm.addEventListener('submit', (ev) => onCreateSubmit(ev, newForm, plansSection));
  const cancelBtn = newForm.querySelector('[data-action=cancel-new]');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      newForm.reset();
      newForm.classList.add('hidden');
      setFormMsg(newForm, '');
    });
  }

  await renderPlans(plansSection);
}

/* ----------------------------------------------------------------- render */

/**
 * Fetch and render plan cards.
 */
export async function renderPlans(section) {
  try {
    const { plans } = await apiGet('/api/plans');
    clear(section);

    if (!plans || plans.length === 0) {
      section.appendChild(emptyState());
      return;
    }

    for (const plan of plans) {
      section.appendChild(planCard(plan));
    }
  } catch (e) {
    clear(section);
    section.appendChild(el('div', { class: 'msg error' }, [e.message || 'Failed to load trips']));
  }
}

function emptyState() {
  return el('div', { class: 'empty-state' }, [
    el('p', { class: 'empty-title' }, ['No trips yet — create one.']),
    el('p', { class: 'muted' }, ['Hit “New trip” to start planning your next adventure.']),
  ]);
}

function planCard(plan) {
  const isOwner = plan.role === 'owner';
  const range = plan.start_date
    ? `${fmtDate(plan.start_date)} – ${fmtDate(plan.end_date)}`
    : 'Dates not set';

  const links = el('div', { class: 'card-links' }, [
    el('a', { class: 'btn ghost', href: `/plans/${plan.id}` }, ['View']),
    el('a', { class: 'btn ghost', href: `/plans/${plan.id}/expenses` }, ['Expenses']),
    el('a', { class: 'btn ghost', href: `/plans/${plan.id}/members` }, ['Members']),
  ]);

  let controls = null;
  if (isOwner) {
    controls = el('div', { class: 'card-controls' }, [
      el('button', {
        class: 'btn small', text: 'Edit',
        onclick: () => openEditForm(plan, card),
      }),
      el('button', {
        class: 'btn small danger', text: 'Delete',
        onclick: () => onDeletePlan(plan, card),
      }),
    ]);
  }

  const card = el('article', { class: 'card plan-card', dataset: { id: plan.id } }, [
    el('div', { class: 'card-head' }, [
      el('h3', { class: 'card-title' }, [plan.title || 'Untitled trip']),
      el('div', { class: 'card-badges' }, [
        currencyBadge(plan.base_currency),
        roleBadge(plan.role),
      ].filter(Boolean)),
    ]),
    el('p', { class: 'card-dates' }, [range]),
    // Always render the description block (empty if none) so its reserved
    // min-height keeps every card the same height regardless of content.
    el('p', { class: 'card-desc' }, [plan.description || '']),
    links,
    controls,
  ].filter(Boolean));

  return card;
}

function currencyBadge(cur) {
  if (!cur) return null;
  return el('span', { class: 'badge currency' }, [cur]);
}

function roleBadge(role) {
  const label = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
  return el('span', { class: `badge role role-${role || 'viewer'}` }, [label]);
}

/* ----------------------------------------------------------- create trip */

async function onCreateSubmit(ev, form, section) {
  ev.preventDefault();
  const msgEl = form.querySelector('.form-msg');
  const data = formData(form);

  if (!data.title || !data.title.trim()) {
    setFormMsg(form, 'Title is required.');
    return;
  }

  try {
    setFormMsg(form, 'Creating…');
    await apiPost('/api/plans', data);
    form.reset();
    form.classList.add('hidden');
    setFormMsg(form, '');
    await renderPlans(section);
  } catch (e) {
    setFormMsg(form, e.message || 'Failed to create trip.');
  }
}

/* ------------------------------------------------------------ edit trip */

function openEditForm(plan, card) {
  // Replace controls with an inline edit form.
  const existing = card.querySelector('.edit-form');
  if (existing) return;

  const form = el('form', { class: 'trip-form edit-form', autocomplete: 'off' }, [
    el('label', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Title']),
      el('input', { type: 'text', name: 'title', value: plan.title || '' }),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Description']),
      el('textarea', { name: 'description', rows: 2 }, [plan.description || '']),
    ]),
    el('div', { class: 'field-row' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label' }, ['Start date']),
        el('input', { type: 'date', name: 'start_date', value: plan.start_date || '' }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label' }, ['End date']),
        el('input', { type: 'date', name: 'end_date', value: plan.end_date || '' }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label' }, ['Base currency']),
        currencySelect(plan.base_currency),
      ]),
    ]),
    el('div', { class: 'form-actions' }, [
      el('button', { type: 'submit', class: 'btn primary' }, ['Save']),
      el('button', { type: 'button', class: 'btn ghost', text: 'Cancel',
        onclick: () => form.remove() }),
      el('span', { class: 'form-msg', role: 'status' }, []),
    ]),
  ]);

  form.addEventListener('submit', (ev) => onEditSubmit(ev, form, plan, card));
  card.appendChild(form);
}

async function onEditSubmit(ev, form, plan, card) {
  ev.preventDefault();
  const data = formData(form);

  try {
    setFormMsg(form, 'Saving…');
    await apiPatch(`/api/plans/${plan.id}`, data);
    // Re-render the whole list to reflect changes cleanly.
    const section = document.getElementById('plans');
    await renderPlans(section);
  } catch (e) {
    setFormMsg(form, e.message || 'Failed to save.');
  }
}

/* ----------------------------------------------------------- delete trip */

async function onDeletePlan(plan, card) {
  if (!confirm(`Delete “${plan.title}”? This cannot be undone.`)) return;

  try {
    await apiDel(`/api/plans/${plan.id}`);
    const section = document.getElementById('plans');
    await renderPlans(section);
  } catch (e) {
    // Inline error on the card.
    let msgEl = card.querySelector('.card-error');
    if (!msgEl) {
      msgEl = el('div', { class: 'msg error card-error' }, []);
      card.appendChild(msgEl);
    }
    msgEl.textContent = e.message || 'Failed to delete.';
  }
}

/* --------------------------------------------------------------- helpers */

function formData(form) {
  const out = {};
  for (const el_ of form.elements) {
    if (!el_.name) continue;
    const v = el_.value.trim();
    if (el_.type === 'date') {
      out[el_.name] = v || null;
    } else if (el_.tagName === 'TEXTAREA' || el_.type === 'text') {
      out[el_.name] = v;
    } else if (el_.tagName === 'SELECT') {
      out[el_.name] = v;
    }
  }
  return out;
}

function setFormMsg(form, text) {
  const msg = form.querySelector('.form-msg');
  if (msg) {
    msg.textContent = text || '';
    msg.classList.toggle('error', !!text && !text.endsWith('…'));
  }
}

function populateCurrencySelect(select) {
  if (!select) return;
  clear(select);
  for (const c of baseCurrencies) {
    select.appendChild(el('option', { value: c }, [c]));
  }
}

function currencySelect(selected) {
  const sel = el('select', { name: 'base_currency' }, []);
  for (const c of baseCurrencies) {
    const opt = el('option', { value: c }, [c]);
    if (selected && c === selected) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}