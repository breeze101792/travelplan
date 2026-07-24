// expenses.js — Expenses ledger, by-item totals, add-expense form.
// Delegates settlement rendering to settlement.js.
import { apiGet, apiPost, apiDel } from '/static/js/api.js';
import { el, clear, money, statusBadge, loadSettings } from '/static/js/util.js';
import { initSettlement } from '/static/js/settlement.js';
import { openExpenseFormModal } from '/static/js/expense-form.js';

// --- helpers ---------------------------------------------------------------

// JPY/KRW have 0 decimal places; everything else 2.
function decimalsFor(currency) {
  return (currency === 'JPY' || currency === 'KRW') ? 0 : 2;
}

function moneyFor(cents, currency) {
  return money(cents, decimalsFor(currency), currency);
}

function kids(...xs) {
  return xs.filter(x => x != null && x !== false);
}

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
      root.append(renderAddBtn());
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

  // --- (c) add-expense button (opens shared modal) -----------------------
  function renderAddBtn() {
    const btn = el('button', { type: 'button', class: 'btn btn-primary',
      text: '+ Add an expense' });
    btn.addEventListener('click', () => {
      openExpenseFormModal({
        members: users,
        currencies,
        baseCurrency,
        currentUser,
        itemOptions,
        onSubmit: async (body) => {
          await apiPost(`/api/plans/${planId}/expenses`, body);
          await refresh();
        },
      });
    });
    return btn;
  }

  // --- initial render ---
  await renderByItem();
  await renderLedger();
  await initSettlement(
    { planId, role, baseCurrency, currencies, currentUser },
    { plan, users }
  );
}