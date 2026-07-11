// settlement.js — exchange rates, balances, who-pays-whom, payments.
import { apiGet, apiPost, apiDel } from '/static/js/api.js';
import { el, clear, money } from '/static/js/util.js';

function decimalsFor(currency) {
  return (currency === 'JPY' || currency === 'KRW') ? 0 : 2;
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

  function nameOf(id, fallback) {
    const u = userById[id];
    return u ? (u.display_name || u.username) : (fallback || `user ${id}`);
  }

  function refreshBtn() {
    return el('button', { class: 'btn btn-ghost', text: 'Refresh settlement',
      onclick: () => { render(); } });
  }

  async function render() {
    clear(root);
    root.append(el('h2', { class: 'section-title', text: 'Settlement' }));
    root.append(el('p', { class: 'muted',
      text: `Base currency: ${baseCurrency}. Exchange rates are user-supplied and saved on this plan.` }));

    let st;
    try {
      st = await apiGet(`/api/plans/${planId}/settlement`);
    } catch (e) {
      root.append(el('p', { class: 'error', text: e.message }));
      return;
    }

    const present = st.currencies_present || [];
    const missing = st.missing_currencies || [];
    const rates = st.rates || {};
    const rateCurrencies = Array.from(new Set([...present, ...missing])).sort()
      .filter(c => c !== baseCurrency);

    // --- rate editor ---
    const ratePanel = el('div', { class: 'rate-panel' });
    ratePanel.append(el('h3', { text: 'Exchange rates' }));
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
    root.append(ratePanel);

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

    // If rates are missing, stop here (form shown, balances hidden).
    if (missing.length) {
      root.append(el('p', { class: 'muted',
        text: 'Balances and who-pays-whom will appear once rates are saved for all currencies.' }));
      root.append(refreshBtn());
      return;
    }

    // --- balances ---
    const balPanel = el('div', { class: 'panel balances-panel' });
    balPanel.append(el('h3', { text: 'Balances' }));
    const balList = el('ul', { class: 'balance-list' });
    (st.balances_base || []).forEach(b => {
      const cents = b.balance_cents || 0;
      const cls = cents > 0 ? 'creditor' : (cents < 0 ? 'debtor' : 'even');
      balList.append(el('li', { class: `balance-row ${cls}` }, [
        el('span', { class: 'bal-name', text: nameOf(b.user_id, b.username) }),
        el('span', { class: 'bal-amt', text: money(cents, baseDec, baseCurrency) }),
      ]));
    });
    if (!(st.balances_base || []).length) {
      balList.append(el('li', { class: 'muted', text: 'No balances.' }));
    }
    balPanel.append(balList);
    root.append(balPanel);

    // --- proposed settlement (who pays whom) ---
    const propPanel = el('div', { class: 'panel proposed-panel' });
    propPanel.append(el('h3', { text: 'Who pays whom' }));
    const propList = el('ul', { class: 'prop-list' });
    (st.proposed_settlement || []).forEach(p => {
      propList.append(el('li', { class: 'prop-row' }, [
        el('span', { class: 'prop-who' }, [
          el('strong', { text: nameOf(p.from, p.from_name) }),
          el('span', { text: ' pays ' }),
          el('strong', { text: nameOf(p.to, p.to_name) }),
        ]),
        el('span', { class: 'prop-amt',
          text: money(p.amount_cents || 0, baseDec, baseCurrency) }),
      ]));
    });
    if (!(st.proposed_settlement || []).length) {
      propList.append(el('li', { class: 'muted', text: 'Everyone is settled up.' }));
    }
    propPanel.append(propList);
    root.append(propPanel);

    // --- record payment form ---
    if (!readOnly) {
      root.append(renderPaymentForm());
    }

    // --- remaining balances ---
    const remPanel = el('div', { class: 'panel remaining-panel' });
    remPanel.append(el('h3', { text: 'Remaining balances' }));
    const remList = el('ul', { class: 'balance-list' });
    (st.remaining_balances || []).forEach(b => {
      const cents = b.balance_cents || 0;
      const cls = cents > 0 ? 'creditor' : (cents < 0 ? 'debtor' : 'even');
      remList.append(el('li', { class: `balance-row ${cls}` }, [
        el('span', { class: 'bal-name', text: nameOf(b.user_id, b.username) }),
        el('span', { class: 'bal-amt', text: money(cents, baseDec, baseCurrency) }),
      ]));
    });
    if (!(st.remaining_balances || []).length) {
      remList.append(el('li', { class: 'muted', text: 'No remaining balances.' }));
    }
    remPanel.append(remList);
    root.append(remPanel);

    // --- recorded payments ---
    root.append(await renderPayments());

    root.append(refreshBtn());
  }

  function renderPaymentForm() {
    const wrap = el('div', { class: 'panel payment-form-panel' });
    wrap.append(el('h3', { text: 'Record a payment' }));

    let fromId = users[0].id;
    let toId = users.length > 1 ? users[1].id : users[0].id;
    let amount = '';
    let currency = baseCurrency;
    let note = '';

    const fromSel = makeSelect(userOptions, fromId);
    fromSel.addEventListener('change', () => { fromId = Number(fromSel.value); });
    const toSel = makeSelect(userOptions, toId);
    toSel.addEventListener('change', () => { toId = Number(toSel.value); });

    const curOptions = (currencies && currencies.length ? currencies : [baseCurrency])
      .map(c => ({ value: c, label: c }));
    const curSel = makeSelect(curOptions, currency);
    curSel.addEventListener('change', () => { currency = curSel.value; });

    const amtInput = el('input', { type: 'text', inputmode: 'decimal',
      placeholder: '0.00', value: amount });
    amtInput.addEventListener('input', () => { amount = amtInput.value; });

    const noteInput = el('input', { type: 'text', placeholder: 'optional note',
      value: note });
    noteInput.addEventListener('input', () => { note = noteInput.value; });

    const msg = el('p', { class: 'form-msg' });
    const submit = el('button', { type: 'button', class: 'btn btn-primary',
      text: 'Record payment' });
    submit.addEventListener('click', async () => {
      if (!amount || isNaN(parseFloat(amount))) {
        msg.textContent = 'Enter an amount.';
        msg.className = 'form-msg error';
        return;
      }
      if (fromId === toId) {
        msg.textContent = 'From and to must differ.';
        msg.className = 'form-msg error';
        return;
      }
      msg.textContent = 'Saving…';
      msg.className = 'form-msg';
      try {
        await apiPost(`/api/plans/${planId}/payments`, {
          from_user_id: fromId, to_user_id: toId,
          amount: amount, currency, note: note || undefined,
        });
        render();
      } catch (e) {
        msg.textContent = e.message;
        msg.className = 'form-msg error';
      }
    });

    wrap.append(el('div', { class: 'form-grid' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'From' }), fromSel]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'To' }), toSel]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'Amount' }), amtInput]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'Currency' }), curSel]),
      el('label', { class: 'field full' }, [el('span', { class: 'field-label', text: 'Note' }), noteInput]),
    ]));
    wrap.append(el('div', { class: 'form-actions' }, [msg, submit]));
    return wrap;
  }

  async function renderPayments() {
    const wrap = el('div', { class: 'panel payments-panel' });
    wrap.append(el('h3', { text: 'Recorded payments' }));
    let res;
    try {
      res = await apiGet(`/api/plans/${planId}/payments`);
    } catch (e) {
      wrap.append(el('p', { class: 'error', text: e.message }));
      return wrap;
    }
    const payments = res.payments || [];
    if (!payments.length) {
      wrap.append(el('p', { class: 'empty', text: 'No payments recorded yet.' }));
      return wrap;
    }
    const list = el('ul', { class: 'payment-list' });
    payments.forEach(p => {
      const dec = decimalsFor(p.currency);
      const row = el('li', { class: 'payment-row' }, [
        el('span', { class: 'pay-who', text: `${p.from_name} → ${p.to_name}` }),
        el('span', { class: 'pay-amt', text: money(p.amount_cents, dec, p.currency) }),
        el('span', { class: 'pay-note muted', text: p.note || '' }),
        readOnly ? null : el('button', { class: 'btn btn-danger btn-sm',
          text: 'Delete', onclick: () => delPayment(p.id) }),
      ]);
      list.append(row);
    });
    wrap.append(list);
    return wrap;
  }

  async function delPayment(id) {
    if (!confirm('Delete this payment?')) return;
    try {
      await apiDel(`/api/payments/${id}`);
      render();
    } catch (e) {
      alert(e.message);
    }
  }

  await render();
}