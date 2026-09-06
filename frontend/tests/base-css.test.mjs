/* base-css.test.mjs — tests for the iOS safe-area-inset rules in
 * frontend/static/css/base.css.
 *
 * These lock in the PWA notch/safe-area fixes: the topbar and pull-to-refresh
 * indicator must clear the top inset, and the main view must clear the bottom
 * inset, at both the default and the 640px responsive breakpoint.
 *
 * Run:  node --import ./register.mjs base-css.test.mjs   (from frontend/tests/)
 * or:   ./run.sh                                         (runs everything)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assert, eq, summary } from './lib/t.mjs';

const CSS_PATH = fileURLToPath(new URL('../static/css/base.css', import.meta.url));
const css = readFileSync(CSS_PATH, 'utf8');

/* ---- tiny CSS block extractor -----------------------------------------
 * Pulls the declaration block for a top-level selector (e.g. '.topbar' or
 * '#view') or for a selector inside a media query. Returns the raw text of
 * the block (without braces) or '' if not found.
 */
function blockFor(selector, source = css) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm');
  const m = source.match(re);
  return m ? m[1] : '';
}

/* Extract the body of the first @media (max-width: 640px) block. */
function media640() {
  const m = css.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/);
  return m ? m[1] : '';
}

const topbar = blockFor('.topbar');
const view = blockFor('#view');
const ptr = blockFor('#ptr');
const media = media640();
const topbar640 = blockFor('.topbar', media);
const view640 = blockFor('#view', media);

/* ---- .topbar (default) ------------------------------------------------ */
{
  assert(topbar.includes('env(safe-area-inset-top, 0)'),
    '.topbar padding includes env(safe-area-inset-top, 0)');
  assert(/padding\s*:\s*env\(safe-area-inset-top,\s*0\)/.test(topbar),
    '.topbar padding starts with the top safe-area inset');
  assert(/min-height\s*:\s*52px/.test(topbar),
    '.topbar uses min-height: 52px');
  assert(!/(?<!min-|max-)height\s*:\s*52px/.test(topbar),
    '.topbar does not use a fixed height (must be min-height so it can grow)');
}

/* ---- .topbar @media (max-width: 640px) -------------------------------- */
{
  assert(topbar640.includes('env(safe-area-inset-top, 0)'),
    '.topbar 640px padding includes env(safe-area-inset-top, 0)');
  assert(/min-height\s*:\s*48px/.test(topbar640),
    '.topbar 640px uses min-height: 48px');
  assert(!/(?<!min-|max-)height\s*:\s*48px/.test(topbar640),
    '.topbar 640px does not use a fixed height (must be min-height)');
}

/* ---- #ptr (pull-to-refresh) ------------------------------------------- */
{
  assert(ptr.includes('env(safe-area-inset-top, 0)'),
    '#ptr top includes env(safe-area-inset-top, 0)');
  assert(/top\s*:\s*env\(safe-area-inset-top,\s*0\)/.test(ptr),
    '#ptr uses top: env(safe-area-inset-top, 0)');
}

/* ---- #view (default) -------------------------------------------------- */
{
  assert(view.includes('env(safe-area-inset-bottom, 0)'),
    '#view padding includes env(safe-area-inset-bottom, 0)');
  assert(/padding\s*:.*env\(safe-area-inset-bottom,\s*0\)/.test(view),
    '#view padding ends with the bottom safe-area inset');
}

/* ---- #view @media (max-width: 640px) ---------------------------------- */
{
  assert(view640.includes('env(safe-area-inset-bottom, 0)'),
    '#view 640px padding includes env(safe-area-inset-bottom, 0)');
  assert(/padding\s*:.*env\(safe-area-inset-bottom,\s*0\)/.test(view640),
    '#view 640px padding ends with the bottom safe-area inset');
}

/* ---- sanity: the media query block actually exists -------------------- */
{
  assert(media.length > 0, '@media (max-width: 640px) block is present');
  eq(topbar640 !== '', true, '.topbar rule exists inside the 640px media query');
  eq(view640 !== '', true, '#view rule exists inside the 640px media query');
}

summary('base-css');
