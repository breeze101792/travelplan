// settlement.js — exchange rates, balances, who-pays-whom, payments.
import { apiGet, apiPost, apiPatch, apiDel } from '/static/js/api.js';
import { el, clear, money } from '/static/js/util.js';

const QUICK_SETTLE_NOTE = 'Quick settle';
const AMOUNT_RE = /^\d+(\.\d+)?$/;

function decimalsFor(currency) {
  return (currency === 'JPY' || currency === 'KRW') ? 0 : 2;
}

// A proposed row from `from` to `to` is settled once the debtor no longer
// owes the group (remaining >= 0) or the creditor has nothing left to
// receive (remaining <= 0). `remaining` is the server's remaining_balances,
// which already includes recorded payments.
export function isTransferSettled(from, to, remainingByUser) {
  const remFrom = remainingByUser[from] ?? 0;
  const remTo = remainingByUser[to] ?? 0;
  return remFrom >= 0 || remTo <= 0;
}

// How much of a proposed transfer is still outstanding, in minor units:
// the smaller of what the debtor owes and what the creditor is owed.
export function outstandingTransferCents(from, to, remainingByUser) {
  const remFrom = remainingByUser[from] ?? 0;
  const remTo = remainingByUser[to] ?? 0;
  const outstanding = Math.min(-remFrom, remTo);
  return outstanding > 0 ? outstanding : 0;
}

// How a proposed transfer row should be settled:
//   'settled'           — nothing left to pay on this row.
//   'per_currency_only' — still outstanding, but the row has no direct
//                         per-currency debt, so a one-tap payment would carry
//                         no allocations and the server would default it to
//                         the display currency. Send the user to per-currency
//                         mode instead.
//   'quick'             — a real per-currency debt, settleable in one tap.
export function rowSettleMode(settled, parts) {
  if (settled) return 'settled';
  return (parts && parts.length) ? 'quick' : 'per_currency_only';
}

// The per-currency allocations a settlement payment should record, so one
// payment settles the real debts in each currency the pair owes. `parts` is
// the row's real per-currency debt, `displayCents` is the amount the user
// typed in the displayed currency's minor units, and `valueInDisplay`
// converts `amountCents` of `currency` into displayed minor units.
//
// Returns [] to let the server default to one allocation in the payment
// currency: that is exactly right when there is no per-currency breakdown or
// the debt is already all in the displayed currency. For a single part in the
// display currency, valueInDisplay is the identity, so its value equals its
// own amount. Otherwise it greedily fills parts in order, taking each part
// whole while it fits and one partial part to cover the remainder. The server
// adds the paid residual itself, so no residual is produced here.
export function computeAllocations(parts, displayCents, valueInDisplay) {
  const list = parts || [];
  if (!list.length) return [];
  if (list.length === 1
      && valueInDisplay(list[0].currency, list[0].amount_cents, list[0].decimals)
         === list[0].amount_cents) {
    return [];
  }
  const allocations = [];
  let budget = displayCents;
  for (const part of list) {
    if (budget <= 0) break;
    const fullValue = valueInDisplay(part.currency, part.amount_cents, part.decimals);
    if (!(fullValue > 0) || !isFinite(fullValue)) {
      // Missing/zero rate: skip rather than allocate a currency we cannot
      // value, so a bad rate never throws or over-allocates.
      continue;
    }
    if (fullValue <= budget) {
      allocations.push({ currency: part.currency, amount_cents: part.amount_cents });
      budget -= fullValue;
    } else {
      const partial = Math.max(1, Math.round(part.amount_cents * budget / fullValue));
      allocations.push({ currency: part.currency,
                         amount_cents: Math.min(part.amount_cents, partial) });
      budget = 0;
    }
  }
  return allocations;
}

// Build a `valueInDisplay(currency, amountCents, decimals)` closure from the
// settlement response's user-supplied `rates` (currency -> base) and base
// currency. It returns how many minor units of `displayCurrency` the amount is
// worth, or Infinity when a needed rate is missing so computeAllocations skips
// (rather than throws on) a currency it cannot value.
function makeValueInDisplay(rates, baseCurrency, displayCurrency) {
  const rate = (cur) => {
    if (cur === baseCurrency) return 1;
    const r = rates ? Number(rates[cur]) : NaN;
    return r > 0 ? r : 0;
  };
  const displayRate = rate(displayCurrency);
  const displayDec = decimalsFor(displayCurrency);
  return (currency, amountCents, decimals) => {
    const curRate = rate(currency);
    if (!(curRate > 0) || !(displayRate > 0)) return Infinity;
    const dec = decimals != null ? decimals : decimalsFor(currency);
    // minor units -> major -> base major -> display major -> display minor
    const num = Number(amountCents) * curRate * (10 ** displayDec);
    const den = (10 ** dec) * displayRate;
    const value = num / den;
    return isFinite(value) ? Math.round(value) : Infinity;
  };
}

function kids(...xs) {
  return xs.filter(x => x != null && x !== false);
}

function makeSelect(options, value, attrs = {}) {
  const sel = el('select', attrs);
  options.forEach(o => sel.append(el('option', { value: o.value, text: o.label })));
  if (value != null) sel.value = String(value);
  return sel;
}

// ctx = { planId, role, baseCurrency, currencies, currentUser }
// { plan, users }
export async function initSettlement(ctx, { plan, users }) {
  const { planId, role, baseCurrency, currencies, currentUser } = ctx;
  const readOnly = role === 'viewer';
  const root = document.getElementById('settlement');
  const userById = {};
  users.forEach(u => { userById[u.id] = u; });
  const userOptions = users.map(u => ({ value: u.id, label: u.display_name || u.username }));
  const baseDec = decimalsFor(baseCurrency);

  let currentMode = 'single';
  let currentCurrency = baseCurrency;

  const allCurrencyOptions = (currencies && currencies.length ? currencies : [baseCurrency])
    .map(c => ({ value: c, label: c }));
  if (!allCurrencyOptions.find(o => o.value === baseCurrency)) {
    allCurrencyOptions.unshift({ value: baseCurrency, label: baseCurrency });
  }

  function nameOf(id, fallback) {
    const u = userById[id];
    return u ? (u.display_name || u.username) : (fallback || `user ${id}`);
  }

  function refreshBtn() {
    return el('button', { class: 'btn btn-ghost', text: 'Refresh settlement',
      onclick: () => { render(); } });
  }

  function renderSettlementPanel(label, balances, proposed, remaining, dec, currency,
                                 valueInDisplay) {
    const wrap = el('div', { class: 'panel settlement-currency-panel' });
    wrap.append(el('h3', { text: label }));

    // balances
    const balList = el('ul', { class: 'balance-list' });
    (balances || []).forEach(b => {
      const cents = b.balance_cents || 0;
      const cls = cents > 0 ? 'creditor' : (cents < 0 ? 'debtor' : 'even');
      balList.append(el('li', { class: `balance-row ${cls}` }, [
        el('span', { class: 'bal-name', text: nameOf(b.user_id, b.username) }),
        el('span', { class: 'bal-amt', text: money(cents, dec, currency) }),
      ]));
    });
    if (!(balances || []).length) {
      balList.append(el('li', { class: 'muted', text: 'No balances.' }));
    }
    wrap.append(el('h4', { class: 'sub-title', text: 'Balances' }));
    wrap.append(balList);

    // proposed settlement
    const remainingByUser = {};
    (remaining || []).forEach(b => { remainingByUser[b.user_id] = b.balance_cents || 0; });
    const factor = 10 ** dec;

    const propList = el('ul', { class: 'prop-list' });
    (proposed || []).forEach(p => {
      const settled = isTransferSettled(p.from, p.to, remainingByUser);
      const outstanding = outstandingTransferCents(p.from, p.to, remainingByUser);

      const who = el('span', { class: 'prop-who' }, [
        el('strong', { text: nameOf(p.from, p.from_name) }),
        el('span', { text: ' pays ' }),
        el('strong', { text: nameOf(p.to, p.to_name) }),
      ]);

      let action;
      const parts = p.parts || [];
      const mode = rowSettleMode(settled, parts);
      if (mode === 'settled') {
        action = el('span', { class: 'settled-badge', text: 'Settled' });
      } else if (readOnly) {
        action = el('span', { class: 'prop-amt',
          text: money(p.amount_cents || 0, dec, currency) });
      } else if (mode === 'per_currency_only') {
        // No direct per-currency debt for this pair: a one-tap payment would
        // record no allocations and the server would default them to the
        // display currency. Point the user at per-currency mode instead.
        const gotoBtn = el('button', { type: 'button',
          class: 'btn btn-sm', text: 'Settle per currency' });
        gotoBtn.addEventListener('click', () => {
          currentMode = 'per_currency';
          render();
        });
        action = el('span', { class: 'prop-action' }, [
          el('span', { class: 'mixed-note',
            text: 'This is a net across people, not one debt.' }),
          gotoBtn,
        ]);
      } else {
        // Pre-fill the pair's outstanding debt in minor units, not the raw
        // proposal, so a row that is partly paid does not offer the full
        // amount again. Not settled implies remFrom < 0 and remTo > 0, so
        // outstanding is already positive.
        const prefillCents = outstanding;
        const amtInput = el('input', { type: 'text', inputmode: 'decimal',
          class: 'prop-amount-input',
          value: (prefillCents / factor).toFixed(dec) });
        const settleBtn = el('button', { type: 'button',
          class: 'btn btn-primary btn-sm', text: 'Settle' });
        settleBtn.addEventListener('click', async () => {
          if (!AMOUNT_RE.test(amtInput.value.trim())) { alert('Enter a valid amount.'); return; }
          if (parseFloat(amtInput.value) <= 0) { alert('Amount must be greater than 0.'); return; }
          if (p.from === p.to) return;
          settleBtn.disabled = true;
          try {
            const displayCents = Math.round(parseFloat(amtInput.value) * factor);
            const allocations = computeAllocations(parts, displayCents, valueInDisplay);
            const body = {
              from_user_id: p.from, to_user_id: p.to,
              amount: amtInput.value.trim(), currency, note: QUICK_SETTLE_NOTE,
            };
            if (allocations.length) body.allocations = allocations;
            await apiPost(`/api/plans/${planId}/payments`, body);
            render();
          } catch (e) {
            settleBtn.disabled = false;
            alert(e.message);
          }
        });
        action = el('span', { class: 'prop-action' }, [amtInput, settleBtn]);
      }

      propList.append(el('li', {
        class: 'prop-row' + (settled ? ' settled' : ''),
      }, [who, action]));
    });
    if (!(proposed || []).length) {
      propList.append(el('li', { class: 'muted', text: 'Everyone is settled up.' }));
    }
    wrap.append(el('h4', { class: 'sub-title', text: 'Who pays whom' }));
    wrap.append(propList);

    // remaining balances
    const remList = el('ul', { class: 'balance-list' });
    (remaining || []).forEach(b => {
      const cents = b.balance_cents || 0;
      const cls = cents > 0 ? 'creditor' : (cents < 0 ? 'debtor' : 'even');
      remList.append(el('li', { class: `balance-row ${cls}` }, [
        el('span', { class: 'bal-name', text: nameOf(b.user_id, b.username) }),
        el('span', { class: 'bal-amt', text: money(cents, dec, currency) }),
      ]));
    });
    if (!(remaining || []).length) {
      remList.append(el('li', { class: 'muted', text: 'No remaining balances.' }));
    }
    wrap.append(el('h4', { class: 'sub-title', text: 'Remaining balances' }));
    wrap.append(remList);

    return wrap;
  }

  async function render() {
    // Fetch all data first — old DOM stays visible during loading so the
    // page doesn't collapse and scroll to top. After all data is in hand,
    // build the new DOM and swap it in one synchronous clear+append.
    let st;
    try {
      const params = new URLSearchParams();
      params.set('mode', currentMode);
      if (currentMode === 'single') params.set('currency', currentCurrency);
      st = await apiGet(`/api/plans/${planId}/settlement?${params.toString()}`);
    } catch (e) {
      clear(root);
      root.append(el('p', { class: 'error', text: e.message }));
      root.append(refreshBtn());
      return;
    }

    const present = st.currencies_present || [];
    const missing = st.missing_currencies || [];
    const rates = st.rates || {};
    const rateCurrencies = Array.from(new Set([...present, ...missing])).sort()
      .filter(c => c !== baseCurrency);

    // Build all new DOM nodes while old content is still visible.
    const els = [];

    els.push(el('h2', { class: 'section-title', text: 'Settlement' }));
    els.push(el('p', { class: 'muted',
      text: `Base currency: ${baseCurrency}. Exchange rates are user-supplied and saved on this plan.` }));

    // --- mode / currency selector ---
    const controls = el('div', { class: 'settlement-controls' });
    const singleRadio = el('input', { type: 'radio', name: 'settlement-mode',
      value: 'single', checked: currentMode === 'single',
      onchange: () => { currentMode = 'single'; render(); } });
    const perCurRadio = el('input', { type: 'radio', name: 'settlement-mode',
      value: 'per_currency', checked: currentMode === 'per_currency',
      onchange: () => { currentMode = 'per_currency'; render(); } });

    const curSel = makeSelect(allCurrencyOptions, currentCurrency, {
      class: 'settlement-currency-select',
      onchange: () => { currentCurrency = curSel.value; render(); },
    });

    controls.append(
      el('span', { class: 'control-group' }, [
        el('span', { class: 'control-label', text: 'Mode:' }),
        el('label', { class: 'radio-label' }, [singleRadio, ' Single currency']),
        el('label', { class: 'radio-label' }, [perCurRadio, ' Per currency']),
      ])
    );
    els.push(controls);

    const settleRow = el('div', { class: 'settle-row' +
      (currentMode === 'single' ? '' : ' hide') } );
    settleRow.append(el('span', { class: 'control-label', text: 'Settle in:' }));
    settleRow.append(curSel);
    els.push(settleRow);

    // --- rate editor ---
    const ratePanel = el('div', { class: 'rate-panel' });
    ratePanel.append(el('h4', { class: 'sub-title', text: 'Exchange rates' }));
    if (missing.length) {
      ratePanel.append(el('p', { class: 'notice warn',
        text: 'Enter exchange rates to compute settlement.' }));
    }
    const rateInputs = {};
    if (rateCurrencies.length) {
      const form = el('div', { class: 'rate-form' });
      rateCurrencies.forEach(cur => {
        const init = rates[cur] != null && rates[cur] !== '' ? String(rates[cur]) : '';
        const inp = el('input', { type: 'number', step: 'any', min: '0',
          placeholder: '0', value: init });
        rateInputs[cur] = inp;
        form.append(el('label', { class: 'rate-row' }, [
          el('span', { class: 'rate-label', text: `1 ${cur} = ? ${baseCurrency}` }),
          inp,
        ]));
      });
      if (!readOnly) {
        form.append(el('button', { type: 'button', class: 'btn',
          text: 'Save rates', onclick: saveRates }));
      }
      ratePanel.append(form);
    } else {
      ratePanel.append(el('p', { class: 'muted',
        text: 'All expenses use the base currency.' }));
    }
    els.push(ratePanel);

    function saveRates() {
      const ratesBody = {};
      rateCurrencies.forEach(cur => {
        const v = parseFloat(rateInputs[cur].value);
        if (!isNaN(v) && v > 0) ratesBody[cur] = v;
      });
      apiPost(`/api/plans/${planId}/rates`, { rates: ratesBody })
        .then(() => render())
        .catch(e => alert(e.message));
    }

    // ---- per-currency settlement ----'
    if (st.mode === 'per_currency') {
      const pc = st.per_currency || {};
      const curKeys = Object.keys(pc).sort();
      if (!curKeys.length) {
        els.push(el('p', { class: 'muted',
          text: 'No expenses to settle.' }));
      }
      curKeys.forEach(cur => {
        const data = pc[cur];
        const d = data.decimals != null ? data.decimals : decimalsFor(cur);
        els.push(renderSettlementPanel(
          `${cur}`,
          data.balances || [],
          data.proposed_settlement || [],
          data.remaining_balances || [],
          d, cur,
          makeValueInDisplay(rates, baseCurrency, cur)
        ));
      });

      els.push(await renderPaymentsPanel());
      els.push(refreshBtn());

      clear(root);
      for (const el of els) root.append(el);
      return;
    }

    // ---- single-currency mode ----
    const settleCur = st.settlement_currency || baseCurrency;
    const settleDec = decimalsFor(settleCur);

    // If rates are missing, stop here (form shown, balances hidden).
    if (missing.length) {
      els.push(el('p', { class: 'muted',
        text: 'Balances and who-pays-whom will appear once rates are saved for all currencies.' }));
      els.push(refreshBtn());

      clear(root);
      for (const el of els) root.append(el);
      return;
    }

    els.push(renderSettlementPanel(
      `All amounts in ${settleCur}`,
      st.balances_base || [],
      st.proposed_settlement || [],
      st.remaining_balances || [],
      settleDec, settleCur,
      makeValueInDisplay(rates, baseCurrency, settleCur)
    ));

    els.push(await renderPaymentsPanel());
    els.push(refreshBtn());

    clear(root);
    for (const el of els) root.append(el);
  }

  let editingPaymentId = null;
  let showAddForm = false;

  function payFormFields(editPayment) {
    let fromId = editPayment ? editPayment.from_user_id : users[0].id;
    let toId = editPayment ? editPayment.to_user_id : (users.length > 1 ? users[1].id : users[0].id);
    let amount = editPayment ? (editPayment.amount_cents / (10 ** decimalsFor(editPayment.currency))).toFixed(decimalsFor(editPayment.currency)) : '';
    let currency = editPayment ? editPayment.currency : baseCurrency;
    let note = editPayment ? (editPayment.note || '') : '';

    const fromSel = makeSelect(userOptions, fromId, { class: 'pay-inline-select' });
    fromSel.addEventListener('change', () => { fromId = Number(fromSel.value); });
    const toSel = makeSelect(userOptions, toId, { class: 'pay-inline-select' });
    toSel.addEventListener('change', () => { toId = Number(toSel.value); });

    const curOptions = Array.from(new Set([...(currencies || []), baseCurrency]))
      .map(c => ({ value: c, label: c }));
    const curSel = makeSelect(curOptions, currency, { class: 'pay-inline-select' });
    curSel.addEventListener('change', () => { currency = curSel.value; });

    const amtInput = el('input', { type: 'text', inputmode: 'decimal',
      placeholder: '0.00', class: 'pay-inline-input', value: amount });
    amtInput.addEventListener('input', () => { amount = amtInput.value; });

    const noteInput = el('input', { type: 'text', placeholder: 'note',
      class: 'pay-inline-input pay-inline-note', value: note });
    noteInput.addEventListener('input', () => { note = noteInput.value; });

    return { fromSel, toSel, curSel, amtInput, noteInput, getData: () => ({ fromId, toId, amount, currency, note }) };
  }

  function createPaymentRow(payment) {
    const isEditing = payment && editingPaymentId === payment.id;
    const isNew = !payment;

    if (isEditing) {
      const f = payFormFields(payment);
      const row = el('li', { class: 'payment-row pay-edit-row' }, [
        f.fromSel, el('span', { class: 'pay-arrow', text: '→' }), f.toSel,
        f.amtInput, f.curSel, f.noteInput,
        el('button', { type: 'button', class: 'btn btn-primary btn-sm',
          text: 'Save', onclick: async () => {
            const d = f.getData();
            if (!d.amount || isNaN(parseFloat(d.amount))) return;
            if (d.fromId === d.toId) return;
            try {
              await apiPatch(`/api/payments/${payment.id}`, {
                from_user_id: d.fromId, to_user_id: d.toId,
                amount: d.amount, currency: d.currency, note: d.note || undefined,
              });
              editingPaymentId = null;
              render();
            } catch (e) { alert(e.message); }
          } }),
        el('button', { type: 'button', class: 'btn btn-sm',
          text: 'Cancel', onclick: () => { editingPaymentId = null; render(); } }),
      ]);
      return row;
    }

    if (isNew) {
      if (readOnly) return null;
      const f = payFormFields(null);
      const row = el('li', { class: 'payment-row pay-add-row' }, [
        f.fromSel, el('span', { class: 'pay-arrow', text: '→' }), f.toSel,
        f.amtInput, f.curSel, f.noteInput,
        el('button', { type: 'button', class: 'btn btn-sm',
          text: 'Add', onclick: async () => {
            const d = f.getData();
            if (!d.amount || isNaN(parseFloat(d.amount))) return;
            if (d.fromId === d.toId) return;
            try {
              await apiPost(`/api/plans/${planId}/payments`, {
                from_user_id: d.fromId, to_user_id: d.toId,
                amount: d.amount, currency: d.currency, note: d.note || undefined,
              });
              showAddForm = false;
              render();
            } catch (e) { alert(e.message); }
          } }),
        el('button', { type: 'button', class: 'btn btn-danger btn-sm',
          text: 'Cancel', onclick: () => { showAddForm = false; render(); } }),
      ]);
      return row;
    }

    // view mode
    const dec = decimalsFor(payment.currency);
    const allocs = payment.allocations || [];
    const allocNote = allocs.length > 1
      ? el('span', { class: 'pay-alloc muted', style: 'font-size: 0.8rem;',
          text: allocs.map(a => money(a.amount_cents, a.decimals != null
            ? a.decimals : decimalsFor(a.currency), a.currency)).join(' + ') })
      : null;
    const row = el('li', { class: 'payment-row' }, [
      el('span', { class: 'pay-who', text: `${payment.from_name} → ${payment.to_name}` }),
      el('span', { class: 'pay-amt', text: money(payment.amount_cents, dec, payment.currency) }),
      allocNote,
      el('span', { class: 'pay-note muted', text: payment.note || '' }),
      readOnly ? null : el('button', { type: 'button', class: 'btn btn-sm', text: 'Edit',
        onclick: () => { editingPaymentId = payment.id; render(); } }),
      readOnly ? null : el('button', { type: 'button', class: 'btn btn-danger btn-sm', text: 'Delete',
        onclick: async () => {
          if (!confirm('Delete this payment?')) return;
          try { await apiDel(`/api/payments/${payment.id}`); render(); }
          catch (e) { alert(e.message); }
        } }),
    ]);
    return row;
  }

  async function renderPaymentsPanel() {
    const wrap = el('div', { class: 'panel payments-panel' });
    wrap.append(el('h3', { text: 'Payments' }));
    let res;
    try {
      res = await apiGet(`/api/plans/${planId}/payments`);
    } catch (e) {
      wrap.append(el('p', { class: 'error', text: e.message }));
      return wrap;
    }
    const payments = res.payments || [];
    const list = el('ul', { class: 'payment-list' });
    payments.forEach(p => {
      const row = createPaymentRow(p);
      if (row) list.append(row);
    });
    if (!payments.length) {
      list.append(el('li', { class: 'empty', style: 'padding: 0.5rem 0.75rem;', text: 'No payments recorded yet.' }));
    }
    if (showAddForm) {
      const addRow = createPaymentRow(null);
      if (addRow) list.append(addRow);
    }
    wrap.append(list);
    if (!readOnly && !showAddForm) {
      wrap.append(el('div', { style: 'margin-top: 0.5rem;' }, [
        el('button', { type: 'button', class: 'btn btn-primary',
          text: '+ Add a payment',
          onclick: () => { showAddForm = true; render(); } }),
      ]));
    }
    return wrap;
  }

  await render();
}
