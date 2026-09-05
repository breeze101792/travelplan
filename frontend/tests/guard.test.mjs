/* guard.test.mjs — unit tests for the unsaved-changes guard module.
 *
 * Run:  node --import ./register.mjs guard.test.mjs   (from frontend/tests/)
 * or:   ./run.sh                                       (runs everything)
 *
 * Covers the active-staging registry (hasPendingChanges) and the shared
 * confirm-discard dialog (both button paths + backdrop dismiss).
 */
import { assert, eq, summary } from './lib/t.mjs';
import { installDom } from './lib/dom-shim.mjs';
import { Staging } from '/static/js/staging.js';
import {
  setActiveStaging, clearActiveStaging, hasPendingChanges, confirmDiscard,
} from '/static/js/guard.js';

installDom();

const noopOp = {
  apply: (items) => items,
  planApply: () => null,
  execute: async () => null,
};

/* =============== hasPendingChanges: no staging / clean / dirty =============== */
{
  clearActiveStaging();
  eq(hasPendingChanges(), false, 'no staging → no pending changes');

  const staging = new Staging({ baseItems: [], basePlan: {} });
  setActiveStaging(staging);
  eq(hasPendingChanges(), false, 'clean staging → no pending changes');

  staging.add(noopOp);
  eq(hasPendingChanges(), true, 'after staging an op → pending changes');

  staging.undo();
  eq(hasPendingChanges(), false, 'after undo to base → no pending changes');

  staging.redo();
  eq(hasPendingChanges(), true, 'after redo → pending changes again');

  clearActiveStaging();
  eq(hasPendingChanges(), false, 'cleared staging → no pending changes');
}

/* =============== confirmDiscard: affirm button resolves true =============== */
{
  const p = confirmDiscard('You have unsaved changes. Discard them?', {
    confirmText: 'Discard', cancelText: 'Keep editing',
  });
  const confirmBtn = document.body.querySelector('.modal-footer .btn-primary');
  assert(confirmBtn != null, 'confirm: primary button rendered');
  confirmBtn.click();
  const val = await p;
  eq(val, true, 'confirm: primary button resolves true');
  assert(document.body.querySelector('.editor-backdrop') == null,
         'confirm: backdrop removed after resolve');
}

/* =============== confirmDiscard: cancel button resolves false =============== */
{
  const p = confirmDiscard('You have unsaved changes. Discard them?', {
    confirmText: 'Discard', cancelText: 'Keep editing',
  });
  const cancelBtn = document.body.querySelector('.modal-footer .btn-ghost');
  assert(cancelBtn != null, 'cancel: ghost button rendered');
  cancelBtn.click();
  const val = await p;
  eq(val, false, 'cancel: ghost button resolves false');
  assert(document.body.querySelector('.editor-backdrop') == null,
         'cancel: backdrop removed after resolve');
}

/* =============== confirmDiscard: backdrop click resolves false =============== */
{
  const p = confirmDiscard('You have unsaved changes. Discard them?');
  const backdrop = document.body.querySelector('.editor-backdrop');
  assert(backdrop != null, 'backdrop: modal appended to body');
  backdrop.dispatch('click');
  const val = await p;
  eq(val, false, 'backdrop: clicking the backdrop resolves false');
  assert(document.body.querySelector('.editor-backdrop') == null,
         'backdrop: backdrop removed after resolve');
}

summary('guard.test.mjs');
process.exit(0);
