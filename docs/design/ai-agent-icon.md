# AI Agent launcher icon — design handoff

This documents the redesigned "minimized" floating button for the AI Agent
chat window (`#ai-agent-icon`). It replaces the emoji 🤖 with an inline SVG
mark. This is a component-level change: it does not alter the design system
in `base.css`, it only consumes existing tokens.

A visual preview lives outside the repo at
`/tmp/opencode/icon-preview/icon-mockup.html` (open in a browser; not part
of the app).

## Design rationale

**The mark.** A rounded chat bubble with a soft-cornered left tail, carrying
a four-point "AI sparkle" in its center. The bubble says *conversation*;
the sparkle says *AI*. Two ideas, one compact glyph — clearer at 48px than
a robot face, which needs eyes, antenna, and mouth to read and turns to mud
at small sizes.

**Construction.** Two flat fills, no strokes, no gradients inside the glyph:
a white bubble (`var(--card)`) on an accent disc, with the sparkle filled
in the disc's own color. The disc gets a subtle 145° gradient from
`--accent` to `--accent-strong` for a soft, modern look; keeping the glyph
itself flat guarantees crisp edges and predictable contrast. The sparkle
uses four quadratic curves with concave sides — a softer, friendlier
star than straight-edged.

**Interaction.** Restraint over decoration:

- Idle: a barely-there pulse ring every 3.4s draws the eye without
  nagging (0 → 0.4 → 0 opacity, scaling to 1.45).
- Hover: the button lifts 2px and brightens 6%; the sparkle rotates 45°
  with a springy overshoot curve and grows 12% — a small "twinkle".
- Press: scale to 0.95 for tactile feedback.
- Focus: 2px accent outline, 3px offset, matching `.btn:focus-visible`
  and `.user-dropdown-trigger:focus-visible` conventions in `base.css`.

**Motion is optional by OS setting.** All animation is gated behind
`@media (prefers-reduced-motion: reduce)`.

## Tokens used (all existing)

| Purpose | Token | Fallback |
| --- | --- | --- |
| Disc gradient start | `--accent` | `#2563eb` |
| Disc gradient end / press | `--accent-strong` | `#1d4ed8` |
| Bubble fill | `--card` | `#ffffff` |
| Focus outline / pulse ring | `--accent` | `#2563eb` |
| Shadow | `--shadow-lg` | `0 10px 30px rgba(16, 24, 40, .14)` |
| Sparkle fill | `currentColor` → `--accent-strong` | `#1d4ed8` |

No new tokens. No new colors outside the two gradient stops, both of which
already exist.

## Dimensions

- Button: 52 × 52px (was 48; +4px improves touch target toward the 44px
  WCAG minimum and gives the glyph room; stays unobtrusive). If you prefer
  to keep 48px, keep everything else identical and set the glyph to
  24px — the mockup size ladder shows both read well.
- Glyph: 26 × 26px inside the 52px disc (50% of the disc, in the usual
  44–56% optical range for icons-in-circles).
- Position: unchanged — `position: fixed; right: 16px; bottom: 16px`.
- Glyph geometry lives in a `24×24` viewBox; the mark's visual bounds are
  x 2.5–21.5, y 3–20.5 (center of mass at ~11.75y; the tail pulls the
  optical center slightly high, which reads balanced at rest).

## Component spec — states

| State | Transform / filter | Sparkle | Ring |
| --- | --- | --- | --- |
| default | none | none | pulse ring animating 3.4s loop |
| hover | `translateY(-2px)`, `brightness(1.06)` | `rotate(45deg) scale(1.12)` | pulse continues |
| active | `translateY(0) scale(0.95)`, `brightness(0.97)` | — | pulse continues |
| focus-visible | none | none | 2px `--accent` outline, 3px offset |
| hidden | `display: none` (existing `[hidden]` rule kept) | | |

Transitions: 180ms ease on transform/filter (button), 350ms
`cubic-bezier(0.34, 1.56, 0.64, 1)` on the sparkle (springy overshoot).

## Accessibility

- `<button>` element: keyboard-focusable, Enter/Space activate, `restore()`
  unchanged.
- `title` + `aria-label` = "Open AI Agent". The SVG is `aria-hidden` and
  `focusable="false"`; the accessible name comes from the button.
- Contrast: white bubble on `#2563eb` ≈ 4.6:1; the sparkle's deep-blue fill
  on white ≈ 6.7:1. Both exceed the 3:1 graphics requirement and the
  sparkle exceeds 4.5:1 for text-equivalents.
- `prefers-reduced-motion: reduce` disables pulse, twinkle, and lift.
- The pulse ring is decorative (`::before`, `pointer-events: none`), so it
  never blocks the 52px hit area.

## Exact changes

### 1. `frontend/static/js/ai-agent.js`

Add module-level constants near the top (after `VISIBLE_VIEWS`), then
change the `minimize()` icon creation.

```js
// Accessible name for the minimized launcher button (title + aria-label).
const ICON_TITLE = 'Open AI Agent';

// Inline SVG mark for the minimized launcher button: a chat bubble with a
// four-point AI sparkle. Two paths so CSS can target each (bubble fill vs
// sparkle twinkle); classes are the styling hooks, never styled inline.
const ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path class="ai-agent-bubble" ' +
  'd="M7.5 3h9a5 5 0 0 1 5 5v4a5 5 0 0 1-5 5H6.5l-4 3.5V8a5 5 0 0 1 5-5Z"/>' +
  '<path class="ai-agent-spark" ' +
  'd="M12 5.4q1 3.6 4.6 4.6q-3.6 1-4.6 4.6q-1-3.6-4.6-4.6q3.6-1 4.6-4.6Z"/>' +
  '</svg>';
```

In `minimize()` (line ~362):

```js
  if (!_icon) {
    _icon = el('button', {
      id: 'ai-agent-icon',
      class: 'ai-agent-icon',
      title: ICON_TITLE,
      'aria-label': ICON_TITLE,
      html: ICON_SVG,
    });
    _icon.addEventListener('click', restore);
    document.body.appendChild(_icon);
  }
```

Note on the `el()` API (`util.js`): the `html` attr sets `innerHTML`
(switch case at `util.js:71`), which parses the SVG string into real SVG
elements; `aria-label` falls through to the default case and is applied
via `setAttribute` (`aria-label` is not an own property of a fresh
`button` element). Do not use the `children` argument for the SVG
string: `el()` appends plain strings as text nodes. The dom-shim used by
`frontend/tests` implements both `innerHTML` and `setAttribute`
(`dom-shim.mjs:83`, `:108`), so tests exercise the same code path.

### 2. `frontend/static/css/ai-agent.css`

Replace the whole `/* ---------- minimized icon ---------- */` section
(lines 70–94) with:

```css
/* ---------- minimized icon ---------- */

.ai-agent-icon {
  position: fixed;
  z-index: 1000;
  right: 16px;
  bottom: 16px;
  width: 52px;
  height: 52px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: linear-gradient(145deg, var(--accent, #2563eb), var(--accent-strong, #1d4ed8));
  color: var(--accent-strong, #1d4ed8); /* sparkle fill via currentColor */
  cursor: pointer;
  box-shadow: var(--shadow-lg, 0 10px 30px rgba(16, 24, 40, 0.14));
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.18s ease, filter 0.18s ease;
}

.ai-agent-icon > svg { display: block; width: 26px; height: 26px; }
.ai-agent-bubble { fill: var(--card, #ffffff); }

/* Sparkle twinkle on hover; transform-box keeps the origin at the
   sparkle's own center, not the SVG canvas. */
.ai-agent-spark {
  fill: currentColor;
  transform-box: fill-box;
  transform-origin: center;
  transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* Idle attention ring: gentle, 3.4s cycle, decorative only. */
.ai-agent-icon::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid var(--accent, #2563eb);
  opacity: 0;
  animation: ai-agent-pulse 3.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  pointer-events: none;
}

@keyframes ai-agent-pulse {
  0% { transform: scale(1); opacity: 0; }
  12% { opacity: 0.4; }
  35%, 100% { transform: scale(1.45); opacity: 0; }
}

.ai-agent-icon:hover { filter: brightness(1.06); transform: translateY(-2px); }
.ai-agent-icon:hover .ai-agent-spark { transform: rotate(45deg) scale(1.12); }

.ai-agent-icon:active {
  filter: brightness(0.97);
  transform: translateY(0) scale(0.95);
}

/* Focus ring matches .btn:focus-visible convention in base.css. */
.ai-agent-icon:focus-visible {
  outline: 2px solid var(--accent, #2563eb);
  outline-offset: 3px;
}

.ai-agent-icon[hidden] { display: none; }

@media (prefers-reduced-motion: reduce) {
  .ai-agent-icon, .ai-agent-icon > svg, .ai-agent-spark {
    transition: none;
    animation: none;
  }
  .ai-agent-icon::before { animation: none; }
}
```

### Positioning note (one-line change if you keep 48px)

The pulse `::before` uses `position: absolute` inside the button. The
existing `.ai-agent-icon` rule keeps `position: fixed`, which also
establishes a containing block for absolutely-positioned descendants —
`inset: 0` resolves against the button box, so this works as-is. If anyone
later changes the button to `position: relative`/`static`, the ring will
still anchor correctly as long as the button itself is the positioned
ancestor.

## Responsive notes

The icon is fixed-position chrome, independent of viewport layout. 52px is
comfortable for both mouse and touch. No breakpoint-specific changes.

## Verification

1. The proposed JS change was applied to a scratch copy of
   `ai-agent.js` and the suite
   `node --import ./register.mjs ai-agent.test.mjs` (from
   `frontend/tests/`) was run against it: **32 passed, 0 failed** — the
   emoji → SVG swap does not affect any test assertion. The repo file was
   restored afterward; nothing in the working tree was left modified.
2. Manual: open a plan page → minimize the AI window → confirm the new
   icon renders (bubble + sparkle, no emoji) → hover (lift + twinkle) →
   click (restores) → Tab-focus (ring) → OS reduced-motion (no pulse).
3. The mockup at `/tmp/opencode/icon-preview/icon-mockup.html` shows all
   states side-by-side, size ladder 36–64px, and busy-background checks.

## What to avoid

- Do not swap the bubble fill to a literal `#fff` — use `var(--card)` so
  dark themes or card color changes keep the glyph coherent.
- Do not add more geometry (eyes, mouth, antenna, gradient fills inside
  the glyph) — the 48px size punishes detail.
- Do not put the pulse ring on a pseudo-element of the SVG or animate
  `box-shadow` — the `::before` + transform approach stays on the
  compositor (no repaint).
- Do not remove `title` (native tooltip still useful) or `aria-label`
  (accessible name when title is suppressed by some AT/screen-reader
  combos).