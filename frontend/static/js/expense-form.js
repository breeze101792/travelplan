/* expense-form.js — shared modal for adding an expense.
 * Used by both the expenses page and the item editor.
 */
import { el, clear, money } from '/static/js/util.js';

// --- helpers ---------------------------------------------------------------

const METHODS = [
  { value: 'EQUAL', label: 'Equal' },
  { value: 'EXACT', label: 'Exact amounts' },
  { value: 'PERCENTAGE', label: 'Percentages' },
  { value: 'SHARES', label: 'Shares' },
];

function decimalsFor(currency) {
  return (currency === 'JPY' || currency === 'KRW') ? 0 : 2;
}

function parseMoneyStr(str, decimals) {
  if (str == null) return null;
  const s = String(str).trim();
  if (s === '') return null;
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  const factor = decimals === 0 ? 1 : 100;
  return Math.round(n * factor);
}

function makeSelect(options, value, attrs = {}) {
  const sel = el('select', attrs);
  options.forEach(o => {
    sel.append(el('option', { value: o.value, text: o.label }));
  });
  if (value != null) sel.value = String(value);
  return sel;
}

function kids(...xs) {
  return xs.filter(x => x != null && x !== false);
}

/* Open a modal for adding an expense.
 *
 * Options:
 *   members      — array of {id, username, display_name}
 *   currencies   — array of currency codes
 *   baseCurrency — default currency
 *   currentUser  — {id, username, display_name}
 *   itemOptions  — optional [{value, label}] for item select
 *   itemId       — optional pre-selected item id
 *   initial      — optional object to pre-fill the form (edit mode):
 *     { description, currency, amount (string), item_id,
 *       payers: [{user_id, amount (string)}],
 *       split_method, participants (for EQUAL),
 *       split_data: [{user_id, amount/percent/shares}] }
 *   onSubmit     — async(body) => Promise<void>, called with the ready-to-POST body
 *   onClose      — optional callback when modal is dismissed
 *   readOnly     — boolean
 */
export function openExpenseFormModal({
  members, currencies, baseCurrency, currentUser,
  itemOptions, itemId,
  initial,
  onSubmit, onClose,
  readOnly,
}) {
  const users = members;
  const isEdit = !!initial;

  const userOptions = users.map(u => ({ value: u.id, label: u.display_name || u.username }));

  // Form state
  function buildInitialFs() {
    if (!initial) return null;
    const parts = new Set();
    const exact = {};
    const percent = {};
    const shares = {};
    if (initial.split_method === 'EQUAL' && Array.isArray(initial.participants)) {
      initial.participants.forEach(uid => parts.add(uid));
    } else if (initial.split_method === 'EXACT' && Array.isArray(initial.split_data)) {
      initial.split_data.forEach(d => { exact[d.user_id] = d.amount || ''; });
    } else if (initial.split_method === 'PERCENTAGE' && Array.isArray(initial.split_data)) {
      initial.split_data.forEach(d => { percent[d.user_id] = String(d.percent); });
    } else if (initial.split_method === 'SHARES' && Array.isArray(initial.split_data)) {
      initial.split_data.forEach(d => { shares[d.user_id] = String(d.shares); });
    }
    return {
      description: initial.description || '',
      itemId: initial.item_id != null ? String(initial.item_id) : '',
      currency: initial.currency || baseCurrency,
      amount: initial.amount || '',
      payers: (initial.payers && initial.payers.length)
        ? initial.payers.map(p => ({ user_id: p.user_id, amount: p.amount || '' }))
        : [{ user_id: currentUser.id, amount: initial.amount || '' }],
      method: initial.split_method || 'EQUAL',
      participants: parts.size ? parts : new Set(users.map(u => u.id)),
      exact,
      percent,
      shares,
    };
  }
  const fs = buildInitialFs() || {
    description: '',
    itemId: itemId != null ? String(itemId) : '',
    currency: baseCurrency,
    amount: '',
    payers: [{ user_id: currentUser.id, amount: '' }],
    method: 'EQUAL',
    participants: new Set(users.map(u => u.id)),
    exact: {},
    percent: {},
    shares: {},
  };

  // --- modal scaffolding ---
  const backdrop = el('div', { class: 'modal-backdrop editor-backdrop' });
  const modal = el('div', { class: 'modal expense-modal' });
  backdrop.appendChild(modal);

  modal.appendChild(el('div', { class: 'modal-header' }, [
    el('h3', { text: isEdit ? 'Edit expense' : 'Add an expense' }),
    el('button', { type: 'button', class: 'modal-close', text: '\u00d7',
      onclick: () => closeModal() }),
  ]));

  const body = el('div', { class: 'modal-body' });
  modal.appendChild(body);

  // description
  const descInput = el('input', { type: 'text', placeholder: 'Description',
    value: fs.description, required: true });
  descInput.addEventListener('input', () => { fs.description = descInput.value; });
  body.appendChild(el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: 'Description' }), descInput,
  ]));

  // item link (optional)
  if (itemOptions) {
    const itemSelect = makeSelect(itemOptions, fs.itemId);
    itemSelect.addEventListener('change', () => { fs.itemId = itemSelect.value; });
    body.appendChild(el('label', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Item' }), itemSelect,
    ]));
  }

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

  body.appendChild(el('div', { class: 'field-row' }, [
    el('label', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Currency' }), curSelect]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Total amount' }), amountInput]),
  ]));

  // payers section
  const payersPanel = el('div', { class: 'payers-panel' });
  body.appendChild(payersPanel);

  // split method
  const methodSelect = makeSelect(METHODS, fs.method);
  methodSelect.addEventListener('change', () => {
    fs.method = methodSelect.value;
    renderMethodPanel();
    renderPreview();
  });
  body.appendChild(el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: 'Split method' }), methodSelect,
  ]));

  // method-specific panel
  const methodPanel = el('div', { class: 'method-panel' });
  body.appendChild(methodPanel);

  // live preview
  const previewPanel = el('div', { class: 'preview-panel' });
  body.appendChild(previewPanel);

  // validation message + footer buttons
  const msg = el('p', { class: 'form-msg' });

  const footer = el('div', { class: 'modal-footer' }, [
    el('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancel',
      onclick: () => closeModal() }),
    msg,
    el('button', { type: 'button', class: 'btn btn-primary',
      text: isEdit ? 'Save changes' : 'Add expense', onclick: onSubmitClick }),
  ]);
  modal.appendChild(footer);

  // ---- payers panel ----
  function renderPayersPanel() {
    clear(payersPanel);
    payersPanel.appendChild(el('span', { class: 'field-label', text: 'Paid by' }));
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
      rows.appendChild(row);
    });
    payersPanel.appendChild(rows);
    payersPanel.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-ghost',
      text: '+ Add payer', onclick: () => {
        fs.payers.push({ user_id: users[0].id, amount: '' });
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
        wrap.appendChild(el('label', { class: 'check-row', for: id }, [cb,
          el('span', { text: u.display_name || u.username })]));
      });
      methodPanel.appendChild(wrap);
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
        grid.appendChild(el('div', { class: 'pp-row' }, [
          el('span', { class: 'pp-name', text: u.display_name || u.username }),
          inp,
        ]));
      });
      methodPanel.appendChild(grid);
      if (fs.method === 'EXACT') {
        methodPanel.appendChild(el('p', { class: 'muted hint',
          text: 'Per-person amounts should sum to the total.' }));
      } else if (fs.method === 'PERCENTAGE') {
        methodPanel.appendChild(el('p', { class: 'muted hint',
          text: 'Percentages should sum to 100.' }));
      } else {
        methodPanel.appendChild(el('p', { class: 'muted hint',
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
      previewPanel.appendChild(el('p', { class: 'muted',
        text: 'Enter a total and split details to preview each person\u2019s share.' }));
      return;
    }
    previewPanel.appendChild(el('span', { class: 'field-label', text: 'Preview' }));
    const list = el('ul', { class: 'preview-list' });
    users.forEach(u => {
      if (owed[u.id] == null) return;
      list.appendChild(el('li', {}, [
        el('span', { text: u.display_name || u.username }),
        el('strong', { text: money(owed[u.id], dec, fs.currency) }),
      ]));
    });
    previewPanel.appendChild(list);
  }

  // ---- validation ----
  function validate() {
    const dec = decimalsFor(fs.currency);
    if (!fs.description.trim()) return 'Enter a description.';
    const total = parseMoneyStr(fs.amount, dec);
    if (total == null) return 'Enter a valid total amount.';

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

  // ---- submit ----
  async function onSubmitClick() {
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

    const submitBtn = footer.querySelector('.btn-primary');
    submitBtn.disabled = true;
    msg.textContent = 'Saving\u2026';
    msg.className = 'form-msg';
    try {
      await onSubmit(body);
      closeModal();
    } catch (e) {
      msg.textContent = e.message;
      msg.className = 'form-msg error';
    } finally {
      submitBtn.disabled = false;
    }
  }

  function closeModal() {
    backdrop.remove();
    if (onClose) onClose();
  }

  // initial paint
  renderPayersPanel();
  renderMethodPanel();
  renderPreview();

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
}
