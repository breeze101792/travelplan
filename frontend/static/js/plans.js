import {
  apiGet, apiPost, apiPatch, apiDel,
} from '/static/js/api.js';
import {
  el, clear, fmtDate, loadSettings,
} from '/static/js/util.js';

let baseCurrencies = ['USD'];
let currentTab = 'ongoing';
let dragPlanId = null;
let selectedIds = new Set();
let anchorIdx = null;

export async function initDashboard(_ctx) {
  const newToggle = document.getElementById('new-trip-toggle');
  const newForm = document.getElementById('new-trip-form');
  const plansSection = document.getElementById('plans');

  try {
    const settings = await loadSettings();
    if (Array.isArray(settings.base_currencies) && settings.base_currencies.length) {
      baseCurrencies = settings.base_currencies;
    }
  } catch (e) {
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

  {
    const tabBar = document.getElementById('tab-bar');
    tabBar.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.tab-btn');
      if (!btn) return;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      renderPlans(plansSection, currentTab, false);
    });

    let dragOverTab = null;
    tabBar.addEventListener('dragenter', (ev) => {
      const btn = ev.target.closest('.tab-btn');
      if (!btn) return;
      dragOverTab = btn;
      btn.classList.add('drag-over');
    });
    tabBar.addEventListener('dragover', (ev) => {
      const btn = ev.target.closest('.tab-btn');
      if (!btn) return;
      ev.preventDefault();
      if (dragOverTab && dragOverTab !== btn) {
        dragOverTab.classList.remove('drag-over');
        dragOverTab = btn;
        btn.classList.add('drag-over');
      }
    });
    tabBar.addEventListener('dragleave', (ev) => {
      const btn = ev.target.closest('.tab-btn');
      if (!btn) return;
      btn.classList.remove('drag-over');
      if (dragOverTab === btn) dragOverTab = null;
    });
    tabBar.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      const btn = ev.target.closest('.tab-btn');
      if (!btn || !dragPlanId) return;
      btn.classList.remove('drag-over');
      dragOverTab = null;
      const newStatus = btn.dataset.tab;
      if (newStatus === currentTab) return;
      await apiPatch(`/api/plans/${dragPlanId}`, { status: newStatus });
      dragPlanId = null;
      renderPlans(plansSection, currentTab, false);
    });
  }

  currentTab = await resolveDefaultTab();
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === currentTab);
  });
  await renderPlans(plansSection, currentTab, false);
}

async function resolveDefaultTab() {
  try {
    const res = await apiGet('/api/plans?status=ongoing');
    if (res.plans && res.plans.length > 0) return 'ongoing';
  } catch (_) {}
  return 'planning';
}

async function renderPlans(section, status, _allowFallback) {
  selectedIds.clear();
  anchorIdx = null;
  try {
    const { plans } = await apiGet('/api/plans' + (status ? `?status=${status}` : ''));
    clear(section);

    if (!plans || plans.length === 0) {
      section.appendChild(emptyState(status));
      return;
    }

    for (let i = 0; i < plans.length; i++) {
      section.appendChild(planCard(plans[i], section, i));
    }
  } catch (e) {
    clear(section);
    section.appendChild(el('div', { class: 'msg error' }, [e.message || 'Failed to load trips']));
  }
}

function emptyState(status) {
  const labels = { planning: 'planning', ongoing: 'ongoing', archived: 'archived' };
  return el('div', { class: 'empty-state' }, [
    el('p', { class: 'empty-title' }, [`No ${labels[status] || ''} trips yet.`]),
    el('p', { class: 'muted' }, ['Hit “New trip” to start planning your next adventure.']),
  ]);
}

function planCard(plan, section, idx) {
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
    const btns = [
      el('button', {
        class: 'btn small', text: 'Edit',
        onclick: () => openEditModal(plan, section),
      }),
    ];
    if (plan.status !== 'archived') {
      btns.push(el('button', {
        class: 'btn small', text: 'Archive',
        onclick: () => onArchivePlan(plan, section),
      }));
    }
    btns.push(el('button', {
      class: 'btn small danger', text: 'Delete',
      onclick: () => onDeletePlan(plan, section),
    }));
    controls = el('div', { class: 'card-controls' }, btns);
  }

  const statusLabels = { planning: 'Planning', ongoing: 'Ongoing', archived: 'Archived' };
  const badges = [
    currencyBadge(plan.base_currency),
    roleBadge(plan.role),
    el('span', { class: `badge status-${plan.status || 'planning'}` }, [statusLabels[plan.status] || 'Planning']),
  ].filter(Boolean);

  const card = el('article', {
    class: 'card plan-card' + (selectedIds.has(plan.id) ? ' selected' : ''),
    dataset: { id: plan.id, idx },
    draggable: 'true',
    ondragstart: (ev) => {
      dragPlanId = plan.id;
      card.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
    },
    ondragend: () => {
      dragPlanId = null;
      card.classList.remove('dragging');
    },
  }, [
    el('div', { class: 'card-head' }, [
      el('h3', { class: 'card-title' }, [plan.title || 'Untitled trip']),
      el('div', { class: 'card-badges' }, badges),
    ]),
    el('p', { class: 'card-dates' }, [range]),
    el('p', { class: 'card-desc' }, [plan.description || '']),
    links,
    controls,
  ].filter(Boolean));

  card.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('a')) return;

    const pid = plan.id;
    if (e.shiftKey && anchorIdx !== null) {
      const start = Math.min(anchorIdx, idx);
      const end = Math.max(anchorIdx, idx);
      const cards = section.querySelectorAll('.plan-card');
      for (let i = start; i <= end; i++) {
        const c = cards[i];
        if (c) {
          c.classList.add('selected');
          selectedIds.add(Number(c.dataset.id));
        }
      }
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      card.classList.toggle('selected');
      if (card.classList.contains('selected')) {
        selectedIds.add(pid);
      } else {
        selectedIds.delete(pid);
      }
      return;
    }

    document.querySelectorAll('.plan-card.selected').forEach(c => c.classList.remove('selected'));
    selectedIds.clear();
    card.classList.add('selected');
    selectedIds.add(pid);
    anchorIdx = idx;
  });

  card.addEventListener('dblclick', () => {
    window.location.href = `/plans/${plan.id}`;
  });

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
    data.status = 'planning';
    await apiPost('/api/plans', data);
    form.reset();
    form.classList.add('hidden');
    setFormMsg(form, '');
    currentTab = 'planning';
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === 'planning');
    });
    await renderPlans(section, currentTab);
  } catch (e) {
    setFormMsg(form, e.message || 'Failed to create trip.');
  }
}

function openEditModal(plan, section) {
  const backdrop = el('div', { class: 'modal-backdrop editor-backdrop' });
  const modal = el('div', { class: 'modal plan-editor' });

  const form = el('form', { autocomplete: 'off' }, [
    el('div', { class: 'modal-header' }, [
      el('h3', { text: 'Edit trip' }),
      el('button', { type: 'button', class: 'modal-close', text: '×',
        onclick: () => backdrop.remove() }),
    ]),
    el('div', { class: 'modal-body' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label' }, ['Title']),
        el('input', { type: 'text', name: 'title', value: plan.title || '' }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label' }, ['Description']),
        el('textarea', { name: 'description', rows: 3 }, [plan.description || '']),
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
      ]),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [
          el('span', { class: 'field-label' }, ['Base currency']),
          currencySelect(plan.base_currency),
        ]),
        el('label', { class: 'field' }, [
          el('span', { class: 'field-label' }, ['Status']),
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
        onclick: () => backdrop.remove() }),
      el('button', { type: 'submit', class: 'btn primary' }, ['Save']),
      el('span', { class: 'form-msg', role: 'status' }),
    ]),
  ]);

  modal.appendChild(form);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = formData(form);
    const msgEl = form.querySelector('.form-msg');
    try {
      msgEl.textContent = 'Saving…';
      await apiPatch(`/api/plans/${plan.id}`, data);
      backdrop.remove();
      await renderPlans(section, currentTab);
    } catch (e) {
      msgEl.textContent = e.message || 'Failed to save.';
    }
  });
}

async function onArchivePlan(plan, section) {
  try {
    await apiPatch(`/api/plans/${plan.id}`, { status: 'archived' });
    await renderPlans(section, currentTab);
  } catch (e) {
    let card = document.querySelector(`[data-id="${plan.id}"]`);
    if (card) {
      let msgEl = card.querySelector('.card-error');
      if (!msgEl) {
        msgEl = el('div', { class: 'msg error card-error' });
        card.appendChild(msgEl);
      }
      msgEl.textContent = e.message || 'Failed to archive.';
    }
  }
}

async function onDeletePlan(plan, section) {
  if (!confirm(`Delete “${plan.title}”? This cannot be undone.`)) return;
  try {
    await apiDel(`/api/plans/${plan.id}`);
    await renderPlans(section, currentTab);
  } catch (e) {
    let card = document.querySelector(`[data-id="${plan.id}"]`);
    if (card) {
      let msgEl = card.querySelector('.card-error');
      if (!msgEl) {
        msgEl = el('div', { class: 'msg error card-error' });
        card.appendChild(msgEl);
      }
      msgEl.textContent = e.message || 'Failed to delete.';
    }
  }
}

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
