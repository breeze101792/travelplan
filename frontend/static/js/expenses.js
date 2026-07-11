// expenses.js — Expenses ledger, by-item totals, add-expense form.
// Delegates settlement rendering to settlement.js.
import { apiGet, apiPost, apiDel } from '/static/js/api.js';
import { el, clear, money, statusBadge, loadSettings } from '/static/js/util.js';
import { initSettlement } from '/static/js/settlement.js';

// --- helpers ---------------------------------------------------------------

// JPY/KRW have 0 decimal places; everything else 2.
function decimalsFor(currency) {
  return (currency === 'JPY' || currency === 'KRW') ? 0 : 2;
}

// Parse a human money string ('120.00' or '40000') into integer cents
// (or units for 0-decimal currencies). Returns null when invalid.
function parseMoneyStr(str, decimals) {
  if (str == null) return null;
  const s = String(str).trim();
  if (s === '') return null;
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  const factor = decimals === 0 ? 1 : 100;
  return Math.round(n * factor);
}

function moneyFor(cents, currency) {
  return money(cents, decimalsFor(currency), currency);
}

// Filter out null/false children so el() never gets boolean junk.
function kids(...xs) {
  return xs.filter(x => x != null && x !== false);
}

// Build a <select> from [{value,label}] and set the current value.
function makeSelect(options, value, attrs = {}) {
  const sel = el('select', attrs);
  options.forEach(o => {
    sel.append(el('option', { value: o.value, text: o.label }));
  });
  if (value != null) sel.value = String(value);
  return sel;
}

const METHODS = [
  { value: 'EQUAL', label: 'Equal' },
  { value: 'EXACT', label: 'Exact amounts' },
  { value: 'PERCENTAGE', label: 'Percentages' },
  { value: 'SHARES', label: 'Shares' },
];

// --- main entry ------------------------------------------------------------

export async function initExpenses(ctx) {
  const planId = ctx.planId;
  const role = ctx.role;
  const readOnly = role === 'viewer';

  const [settings, planRes, membersRes, itemsRes, meRes] = await Promise.all([
    loadSettings(),
    apiGet(`/api/plans/${planId}`),
    apiGet(`/api/plans/${planId}/members`),
    apiGet(`/api/plans/${planId}/items`),
    apiGet('/api/me'),
  ]);

  const plan = planRes.plan || planRes;
  const baseCurrency = plan.base_currency;

  // Users = owner + members; build lookup maps.
  const users = [membersRes.owner, ...(membersRes.members || [])].filter(Boolean);
  const userById = {};
  users.forEach(u => { userById[u.id] = u; });

  const currentUser =
    (meRes.user && userById[meRes.user.id]) ? userById[meRes.user.id] : users[0];

  const items = itemsRes.items || [];
  const itemById = {};
  items.forEach(it => { itemById[it.id] = it; });

  const currencies = settings.base_currencies && settings.base_currencies.length
    ? settings.base_currencies
    : [baseCurrency];

  const userOptions = users.map(u => ({ value: u.id, label: u.display_name || u.username }));
  const itemOptions = [{ value: '', label: '— (no item)' }]
    .concat(items.map(it => ({ value: it.id, label: it.title || `#${it.id}` })));

  function userName(id) {
    const u = userById[id];
    return u ? (u.display_name || u.username) : `user ${id}`;
  }

  // Re-render the data-driven sections (used after create/delete).
  async function refresh() {
    await Promise.all([renderByItem(), renderLedger()]);
  }

  // --- (a) totals by item -------------------------------------------------
  async function renderByItem() {
    const root = document.getElementById('by-item');
    clear(root);
    root.append(el('h2', { class: 'section-title', text: 'Totals by item' }));

    let data;
    try {
      data = await apiGet(`/api/plans/${planId}/expenses/by-item`);
    } catch (e) {
      root.append(el('p', { class: 'error', text: e.message }));
      return;
    }
    const rows = data.items || [];
    if (!rows.length) {
      root.append(el('p', { class: 'empty', text: 'No expenses yet.' }));
      return;
    }

    const grid = el('div', { class: 'by-item-grid' });
    rows.forEach(it => {
      const card = el('article', { class: 'by-item-card' });
      card.append(el('h3', { class: 'by-item-title', text: it.title || 'Untitled item' }));
      if (it.item_type) {
        card.append(el('span', { class: 'chip type-chip', text: it.item_type }));
      }
      const totals = el('div', { class: 'by-item-totals' });
      const byCur = it.total_by_currency || {};
      const curEntries = Object.entries(byCur);
      if (curEntries.length) {
        curEntries.forEach(([cur, cents]) => {
          totals.append(el('div', { class: 'total-row' }, [
            el('span', { class: 'total-cur', text: cur }),
            el('span', { class: 'total-amt', text: moneyFor(cents, cur) }),
          ]));
        });
      } else {
        totals.append(el('div', { class: 'total-row muted', text: 'No expenses.' }));
      }
      card.append(totals);

      card.append(el('div', { class: 'grand-total' }, [
        el('span', { text: 'Grand total (' + baseCurrency + ')' }),
        el('strong', { text: moneyFor(it.grand_total_base_cents || 0, baseCurrency) }),
      ]));

      if (it.has_missing_rate) {
        card.append(el('span', { class: 'chip warn-chip',
          text: 'Missing exchange rate' }));
      }
      grid.append(card);
    });
    root.append(grid);
  }

  // --- (b) ledger + (c) add form -----------------------------------------
  async function renderLedger() {
    const root = document.getElementById('expense-ledger');
    clear(root);
    root.append(el('h2', { class: 'section-title', text: 'Expenses' }));

    let res;
    try {
      res = await apiGet(`/api/plans/${planId}/expenses`);
    } catch (e) {
      root.append(el('p', { class: 'error', text: e.message }));
      return;
    }
    const expenses = res.expenses || [];

    if (!expenses.length) {
      root.append(el('p', { class: 'empty', text: 'No expenses recorded yet.' }));
    } else {
      const table = el('table', { class: 'ledger' });
      table.append(el('thead', {}, [el('tr', {}, kids(
        el('th', { text: 'Description' }),
        el('th', { text: 'Item' }),
        el('th', { text: 'Currency' }),
        el('th', { text: 'Total' }),
        el('th', { text: 'Paid by' }),
        el('th', { text: 'Method' }),
        el('th', { text: 'Splits' }),
        readOnly ? null : el('th', { text: '' })
      ))]));

      const tbody = el('tbody');
      expenses.forEach(exp => {
        const dec = exp.decimals != null ? exp.decimals : decimalsFor(exp.currency);
        const itemLabel = exp.item_id && itemById[exp.item_id]
          ? (itemById[exp.item_id].title || `#${exp.item_id}`)
          : (exp.item_id ? `#${exp.item_id}` : '—');

        const payersText = (exp.payers || []).map(p =>
          `${userName(p.user_id)}: ${money(p.paid_cents, dec, exp.currency)}`
        ).join(', ');

        const splitsText = (exp.splits || []).map(s =>
          `${userName(s.user_id)}: ${money(s.owed_cents, dec, exp.currency)}`
        ).join(', ');

        const methodBadge = statusBadge(String(exp.split_method).toLowerCase());

        tbody.append(el('tr', {}, kids(
          el('td', { class: 'desc', text: exp.description || '—' }),
          el('td', { text: itemLabel }),
          el('td', { text: exp.currency }),
          el('td', { class: 'amt', text: money(exp.total_cents, dec, exp.currency) }),
          el('td', { class: 'payers', text: payersText || '—' }),
          el('td', {}, [methodBadge]),
          el('td', { class: 'splits-cell', text: splitsText || '—' }),
          readOnly ? null : el('td', {}, [el('button', {
            class: 'btn btn-danger btn-sm',
            text: 'Delete',
            onclick: () => delExpense(exp.id),
          })])
        )));
      });
      table.append(tbody);
      root.append(table);
    }

    if (!readOnly) {
      root.append(renderAddForm());
    }
  }

  async function delExpense(id) {
    if (!confirm('Delete this expense?')) return;
    try {
      await apiDel(`/api/expenses/${id}`);
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  // --- (c) add-expense form ----------------------------------------------
  // Form state lives in a closure; dynamic panels re-render on change.
  function renderAddForm() {
    const fs = {
      description: '',
      itemId: '',
      currency: baseCurrency,
      amount: '',
      payers: [{ user_id: currentUser.id, amount: '' }],
      method: 'EQUAL',
      participants: new Set(users.map(u => u.id)),
      exact: {},
      percent: {},
      shares: {},
    };

    const form = el('form', { class: 'expense-form', autocomplete: 'off' });
    form.append(el('h3', { class: 'form-title', text: 'Add an expense' }));

    // description
    const descInput = el('input', { type: 'text', placeholder: 'Description',
      value: fs.description, required: true });
    descInput.addEventListener('input', () => { fs.description = descInput.value; });
    form.append(el('label', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Description' }), descInput,
    ]));

    // item link
    const itemSelect = makeSelect(itemOptions, fs.itemId);
    itemSelect.addEventListener('change', () => { fs.itemId = itemSelect.value; });
    form.append(el('label', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Item' }), itemSelect,
    ]));

    // currency + amount on one row
    const curSelect = makeSelect(
      currencies.map(c => ({ value: c, label: c })), fs.currency);
    curSelect.addEventListener('change', () => {
      fs.currency = curSelect.value;
      renderMethodPanel();
      renderPreview();
    });

    const amountInput = el('input', { type: 'text', inputmode: 'decimal',
      placeholder: '0.00', value: fs.amount });
    amountInput.addEventListener('input', () => {
      fs.amount = amountInput.value;
      renderPayersPanel();
      renderPreview();
    });

    form.append(el('div', { class: 'field-row' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Currency' }), curSelect]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Total amount' }), amountInput]),
    ]));

    // payers section
    const payersPanel = el('div', { class: 'payers-panel' });
    form.append(payersPanel);

    // split method
    const methodSelect = makeSelect(METHODS, fs.method);
    methodSelect.addEventListener('change', () => {
      fs.method = methodSelect.value;
      renderMethodPanel();
      renderPreview();
    });
    form.append(el('label', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Split method' }), methodSelect,
    ]));

    // method-specific panel
    const methodPanel = el('div', { class: 'method-panel' });
    form.append(methodPanel);

    // live preview
    const previewPanel = el('div', { class: 'preview-panel' });
    form.append(previewPanel);

    // validation message + submit
    const msg = el('p', { class: 'form-msg' });
    const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary',
      text: 'Add expense' });
    form.append(el('div', { class: 'form-actions' }, [msg, submitBtn]));

    // ---- payers panel ----
    function renderPayersPanel() {
      clear(payersPanel);
      payersPanel.append(el('span', { class: 'field-label', text: 'Paid by' }));
      const rows = el('div', { class: 'payer-rows' });
      fs.payers.forEach((p, idx) => {
        const single = fs.payers.length === 1;
        const sel = makeSelect(userOptions, p.user_id);
        sel.addEventListener('change', () => { p.user_id = Number(sel.value); });
        const amt = el('input', { type: 'text', inputmode: 'decimal',
          placeholder: 'amount', value: p.amount, disabled: single });
        if (single) amt.value = fs.amount;
        amt.addEventListener('input', () => { p.amount = amt.value; renderPreview(); });
        const row = el('div', { class: 'payer-row' }, kids(
          sel,
          amt,
          single ? null : el('button', { type: 'button', class: 'btn btn-sm btn-ghost',
            text: 'Remove', onclick: () => {
              fs.payers.splice(idx, 1);
              renderPayersPanel();
              renderPreview();
            } })
        ));
        rows.append(row);
      });
      payersPanel.append(rows);
      payersPanel.append(el('button', { type: 'button', class: 'btn btn-sm btn-ghost',
        text: '+ Add payer', onclick: () => {
          fs.payers.push({ user_id: users[0].id, amount: '' });
          // when moving to multi-payer, clear the auto-filled single amount
          if (fs.payers.length === 2) fs.payers[0].amount = '';
          renderPayersPanel();
          renderPreview();
        } }));
    }

    // ---- method panel ----
    function renderMethodPanel() {
      clear(methodPanel);
      if (fs.method === 'EQUAL') {
        const wrap = el('div', { class: 'check-grid' });
        users.forEach(u => {
          const id = `part-${u.id}`;
          const cb = el('input', { type: 'checkbox', id, value: u.id });
          cb.checked = fs.participants.has(u.id);
          cb.addEventListener('change', () => {
            if (cb.checked) fs.participants.add(u.id);
            else fs.participants.delete(u.id);
            renderPreview();
          });
          wrap.append(el('label', { class: 'check-row', for: id }, [cb,
            el('span', { text: u.display_name || u.username })]));
        });
        methodPanel.append(wrap);
      } else {
        const grid = el('div', { class: 'per-person-grid' });
        users.forEach(u => {
          const store = fs.method === 'EXACT' ? fs.exact
            : fs.method === 'PERCENTAGE' ? fs.percent : fs.shares;
          const inp = el('input', {
            type: fs.method === 'SHARES' ? 'number' : 'text',
            inputmode: fs.method === 'SHARES' ? 'numeric' : 'decimal',
            placeholder: fs.method === 'PERCENTAGE' ? '%' : '0',
            value: store[u.id] || '',
            step: fs.method === 'SHARES' ? '1' : 'any',
            min: '0',
          });
          inp.addEventListener('input', () => {
            store[u.id] = inp.value;
            renderPreview();
          });
          grid.append(el('div', { class: 'pp-row' }, [
            el('span', { class: 'pp-name', text: u.display_name || u.username }),
            inp,
          ]));
        });
        methodPanel.append(grid);
        if (fs.method === 'EXACT') {
          methodPanel.append(el('p', { class: 'muted hint',
            text: 'Per-person amounts should sum to the total.' }));
        } else if (fs.method === 'PERCENTAGE') {
          methodPanel.append(el('p', { class: 'muted hint',
            text: 'Percentages should sum to 100.' }));
        } else {
          methodPanel.append(el('p', { class: 'muted hint',
            text: 'Shares are relative integers (e.g. 2 and 1).' }));
        }
      }
    }

    // ---- preview ----
    function computeOwed() {
      const dec = decimalsFor(fs.currency);
      const total = parseMoneyStr(fs.amount, dec);
      if (total == null) return null;
      const out = {};
      if (fs.method === 'EQUAL') {
        const parts = users.filter(u => fs.participants.has(u.id));
        if (!parts.length) return null;
        const each = Math.floor(total / parts.length);
        let rem = total - each * parts.length;
        parts.forEach(u => {
          let a = each;
          if (rem > 0) { a += 1; rem -= 1; }
          out[u.id] = a;
        });
      } else if (fs.method === 'EXACT') {
        users.forEach(u => {
          const v = parseMoneyStr(fs.exact[u.id] || '', dec);
          if (v != null) out[u.id] = v;
        });
      } else if (fs.method === 'PERCENTAGE') {
        users.forEach(u => {
          const p = parseFloat(fs.percent[u.id] || '');
          if (!isNaN(p)) out[u.id] = Math.round(total * p / 100);
        });
      } else if (fs.method === 'SHARES') {
        let totalShares = 0;
        users.forEach(u => {
          const s = parseInt(fs.shares[u.id] || '', 10);
          if (!isNaN(s) && s > 0) totalShares += s;
        });
        if (totalShares > 0) {
          users.forEach(u => {
            const s = parseInt(fs.shares[u.id] || '', 10);
            if (!isNaN(s) && s > 0) out[u.id] = Math.round(total * s / totalShares);
          });
        }
      }
      return out;
    }

    function renderPreview() {
      clear(previewPanel);
      const dec = decimalsFor(fs.currency);
      const owed = computeOwed();
      if (!owed) {
        previewPanel.append(el('p', { class: 'muted',
          text: 'Enter a total and split details to preview each person’s share.' }));
        return;
      }
      previewPanel.append(el('span', { class: 'field-label', text: 'Preview' }));
      const list = el('ul', { class: 'preview-list' });
      users.forEach(u => {
        if (owed[u.id] == null) return;
        list.append(el('li', {}, [
          el('span', { text: u.display_name || u.username }),
          el('strong', { text: money(owed[u.id], dec, fs.currency) }),
        ]));
      });
      previewPanel.append(list);
    }

    // ---- validation + submit ----
    function validate() {
      const dec = decimalsFor(fs.currency);
      if (!fs.description.trim()) return 'Enter a description.';
      const total = parseMoneyStr(fs.amount, dec);
      if (total == null) return 'Enter a valid total amount.';

      // payers
      if (fs.payers.length === 1) {
        // single payer implicitly pays the total
      } else {
        let psum = 0;
        for (const p of fs.payers) {
          const v = parseMoneyStr(p.amount, dec);
          if (v == null) return 'Enter a valid amount for every payer.';
          psum += v;
        }
        if (psum !== total) return 'Payer amounts must sum to the total.';
      }

      if (fs.method === 'EQUAL') {
        if (!users.some(u => fs.participants.has(u.id)))
          return 'Select at least one participant.';
      } else if (fs.method === 'EXACT') {
        let s = 0, any = false;
        users.forEach(u => {
          const v = parseMoneyStr(fs.exact[u.id] || '', dec);
          if (v != null) { s += v; any = true; }
        });
        if (!any) return 'Enter per-person amounts.';
        if (s !== total) return 'Exact amounts must sum to the total.';
      } else if (fs.method === 'PERCENTAGE') {
        let s = 0;
        users.forEach(u => {
          const p = parseFloat(fs.percent[u.id] || '');
          if (!isNaN(p)) s += p;
        });
        if (Math.abs(s - 100) > 0.01) return 'Percentages must sum to 100.';
      } else if (fs.method === 'SHARES') {
        let s = 0;
        users.forEach(u => {
          const sh = parseInt(fs.shares[u.id] || '', 10);
          if (!isNaN(sh) && sh > 0) s += sh;
        });
        if (s < 1) return 'Enter at least one share.';
      }
      return null;
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = validate();
      if (err) { msg.textContent = err; msg.className = 'form-msg error'; return; }

      const dec = decimalsFor(fs.currency);
      const body = {
        description: fs.description.trim(),
        currency: fs.currency,
        amount: fs.amount,
        split_method: fs.method,
        payers: fs.payers.map(p => ({
          user_id: p.user_id,
          amount: fs.payers.length === 1 ? fs.amount : (p.amount || fs.amount),
        })),
      };
      if (fs.itemId) body.item_id = parseInt(fs.itemId, 10);

      if (fs.method === 'EQUAL') {
        body.participants = users.filter(u => fs.participants.has(u.id)).map(u => u.id);
      } else if (fs.method === 'EXACT') {
        body.split_data = users
          .map(u => ({ user_id: u.id, amount: fs.exact[u.id] || '' }))
          .filter(o => o.amount !== '');
      } else if (fs.method === 'PERCENTAGE') {
        body.split_data = users
          .map(u => ({ user_id: u.id, percent: parseFloat(fs.percent[u.id] || '') }))
          .filter(o => !isNaN(o.percent));
      } else if (fs.method === 'SHARES') {
        body.split_data = users
          .map(u => ({ user_id: u.id, shares: parseInt(fs.shares[u.id] || '', 10) }))
          .filter(o => !isNaN(o.shares));
      }

      submitBtn.disabled = true;
      msg.textContent = 'Saving…';
      msg.className = 'form-msg';
      try {
        await apiPost(`/api/plans/${planId}/expenses`, body);
        await refresh();
      } catch (e) {
        msg.textContent = e.message;
        msg.className = 'form-msg error';
      } finally {
        submitBtn.disabled = false;
      }
    });

    // initial paint of dynamic panels
    renderPayersPanel();
    renderMethodPanel();
    renderPreview();
    return form;
  }

  // --- initial render ---
  await renderByItem();
  await renderLedger();
  await initSettlement(
    { planId, role, baseCurrency, currencies, currentUser },
    { plan, users }
  );
}