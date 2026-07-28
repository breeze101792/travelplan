import { initExpenses } from '/static/js/expenses.js';
import { wirePlanHeaderDirect } from '/static/js/plan-header.js';

export async function init(container, ctx) {
  container.innerHTML = '<section id="by-item" class="expenses-section"></section><section id="expense-ledger" class="expenses-section"></section><section id="settlement" class="expenses-section"></section>';

  await initExpenses(ctx);
  wirePlanHeaderDirect(ctx);

  return () => {
    container.innerHTML = '';
  };
}