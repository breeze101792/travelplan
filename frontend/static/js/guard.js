/* guard.js — single source of truth for "unsaved changes" prompts.
 *
 * The board / timeline / map views each own a Staging engine. They register
 * it here so the plan shell can prompt before SPA navigation when there are
 * pending (not-yet-saved) changes. The item editor uses the same confirm
 * dialog for its close-window / backdrop-click warning.
 *
 * The confirm dialog is intentionally generic — callers pass the message and
 * the button labels so each surface reads naturally:
 *   - item editor close:  "Keep editing" / "Discard"
 *   - leave the page:     "Stay" / "Leave"
 * Resolves true when the user picks the affirmative (destructive) button.
 */

import { el } from '/static/js/util.js';
import { lockBodyScroll, unlockBodyScroll } from '/static/js/page-utils.js';

/* ----- active staging registry ----- */

let _activeStaging = null;

export function setActiveStaging(staging) {
  _activeStaging = staging;
}

export function clearActiveStaging() {
  _activeStaging = null;
}

/* True when the current view has staged changes that haven't been saved to
 * the server. Views without a Staging engine never register, so this reads
 * false on pages like Overview / Expenses / Members. */
export function hasPendingChanges() {
  return !!(_activeStaging && _activeStaging.hasPending);
}

/* ----- generic confirm dialog ----- */

/**
 * Show a modal asking the user to confirm discarding unsaved changes.
 * @param {string} message  the body text
 * @param {object} [opts]
 * @param {string} [opts.confirmText='Discard'] the affirmative (destructive) label
 * @param {string} [opts.cancelText='Cancel']  the safe / stay label
 * @returns {Promise<boolean>} true when the user chose the affirmative
 */
export function confirmDiscard(message, { confirmText = 'Discard', cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop editor-backdrop' });
    const modal = el('div', { class: 'modal expense-modal', style: 'width: min(90vw, 380px); max-width: 380px; padding: 0;' });
    backdrop.appendChild(modal);
    modal.appendChild(el('div', { class: 'modal-header' }, [
      el('h3', { text: 'Unsaved changes' }),
      el('button', {
        type: 'button', class: 'modal-close', text: '\u00d7',
        'aria-label': 'Keep editing',
        onclick: () => finish(false),
      }),
    ]));
    modal.appendChild(el('div', { class: 'modal-body', style: 'padding: 16px 24px;' }, [
      el('p', { text: message, style: 'margin: 0;' }),
    ]));
    const stayBtn = el('button', {
      type: 'button', class: 'btn btn-ghost', text: cancelText,
      onclick: () => finish(false),
    });
    const leaveBtn = el('button', {
      type: 'button', class: 'btn btn-primary', text: confirmText,
      onclick: () => finish(true),
    });
    modal.appendChild(el('div', { class: 'modal-footer' }, [stayBtn, leaveBtn]));

    function finish(val) {
      backdrop.remove();
      unlockBodyScroll();
      resolve(val);
    }

    document.body.appendChild(backdrop);
    lockBodyScroll();
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(false);
    });
    // Focus the safe choice so Enter / Return doesn't accidentally discard.
    stayBtn.focus();
  });
}
