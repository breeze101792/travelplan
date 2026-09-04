# Settings / Members / AI Agent — unified design handoff

This is the design contract for the three authenticated account/admin pages:

| Page | Route | Template | Audience |
| --- | --- | --- | --- |
| Settings | `/auth/settings` | `frontend/templates/settings.html` | any signed-in user |
| Members | `/auth/members` | `frontend/templates/members.html` | admin |
| AI Agent | `/auth/ai` | `frontend/templates/ai-settings.html` | admin |

They currently share no layout of their own: all three reuse `.auth-view`
(the 420px vertically-centered login wrapper from `auth.css`) and then patch
it per page. This document replaces that with one shared shell, reuses the
existing `base.css` components as-is, and adds a single new stylesheet.

A rendered mockup of all three pages lives at
`/tmp/opencode/settings-members-ai-mockup.html` (open in a browser; not part
of the app). The CSS in that mockup mirrors this document exactly.

## What this fixes

| Problem | Fix |
| --- | --- |
| `.auth-view` misused on all three pages; `ai-settings` has no width override so it renders at the 420px login width, vertically centered | New `.page-shell` container, same on all three pages. `.auth-view` returns to login/setup only |
| Per-page `body[data-page=...]` width overrides in `auth.css` | Deleted. Layout comes from the template's own classes, not the body attribute |
| `.members-section` misused on settings/AI pages | Removed. Section cards are plain `.card`; stacking comes from `.page-shell .card + .card` |
| ~10 inline `style=` one-offs | Replaced by classes: `.section-desc`, `.field--wide`, `.field-hint`, `.label-hint`, `.form-divider`, `.cell-actions`, `.edit-row` |
| `.ai-test-*`: ghost buttons, separate result boxes, no `aria-live` | New `.test-action` + `.test-result` pattern; result is an `aria-live` region that stays in the DOM and hides itself with `:empty` |
| Two danger button languages (solid `.btn-danger` in base.css vs outline `.btn.danger` in dashboard.css) | One hierarchy: `.btn-danger` (solid, confirm dialogs only) + new `.btn-ghost-danger` (quiet row actions). Dashboard migrates to the new class |
| Members edit-row labels lack `for`/`id`; empty `<th>` | Unique `for`/`id` per row (`edit-display-name-{{ m.id }}`); actions `<th>` gets a visually-hidden "Actions" label |

Not in scope: the plan-level Members page (`plan-members.html`,
`.members-root`, `#members-root`) is a different surface and keeps its own
styles. No class here collides with it.

## Design tokens

All tokens exist in `base.css` `:root`. Three are added (mirroring the
existing `--accent-strong` pattern), because the current ok/danger text
colors fail WCAG AA on their tinted backgrounds:

| Token | Value | Why |
| --- | --- | --- |
| `--danger-strong` (new) | `#b91c1c` | danger text on `--danger-weak`; `--danger` (#dc2626) on #fee2e2 is ~3.9:1, this is 5.3:1 |
| `--ok-strong` (new) | `#15803d` | ok text on `--ok-weak`; `--ok` (#16a34a) on #dcfce7 is ~3.4:1, this is 4.6:1 |
| `--danger-border` (new) | `#fecaca` | border for `.btn-ghost-danger` (was a hardcoded fallback in dashboard.css) |

Everything else uses what is already there: `--bg #f6f7f9`, `--card #fff`,
`--ink #1f2430`, `--muted #6b7280`, `--line #e5e7eb`, `--accent #2563eb`,
`--accent-weak #dbeafe`, `--accent-strong #1d4ed8`, `--surface-2 #f1f5f9`,
`--danger #dc2626`, `--danger-weak #fee2e2`, `--ok #16a34a`,
`--ok-weak #dcfce7`, `--radius 12px`, `--radius-sm 8px`, `--shadow`,
`--shadow-lg`.

## Shared page layout

Every page uses the same skeleton:

```
#view (base.css, unchanged)
└── .page-shell                    NEW — max-width 760px, centered
    ├── .page-header               base.css — h1 + .sub
    ├── .notice / .error-msg       base.css — only when set by the server
    ├── section.card               1–2 per page
    │   ├── h2.card-title          base.css
    │   ├── p.section-desc         NEW — muted intro line
    │   └── form or table
    └── (footer breathing room via shell padding-bottom)
```

`.page-shell` spec:

```css
.page-shell {
  max-width: 760px;
  margin: 0 auto;
  padding: 12px 0 48px;   /* #view already adds 20px top */
}
.page-shell .card + .card { margin-top: 20px; }  /* wider than the global 14px */
.page-shell [hidden] { display: none !important; }  /* beats flex/grid parents */
```

One width for all three pages: 760px fits the 5-column members table with
room for two row-action buttons, and keeps the forms at a comfortable
reading measure. No vertical centering — these are working pages, not a
login moment.

## Component specs

### Page header — reuse `.page-header` (base.css)

`h1` 26px (22px ≤640px) + `.sub` 14px muted, `margin-bottom: 24px`,
optional `.actions` slot on the right (unused on these pages today).
Keep the server-rendered `.notice` / `.error-msg` directly under it.

### Section card — reuse `.card` + new `.section-desc`

`.card`: white, 1px `--line` border, `--radius`, `--shadow`, padding 18px
(base.css). Every section opens with `h2.card-title` (16px/600), then
optionally a description line:

```css
.section-desc {
  margin: -2px 0 18px;      /* .card-title already adds 10px above */
  font-size: 14px;
  line-height: 1.5;
  color: var(--muted);
}
.section-desc code {
  font-size: 13px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
}
```

### Form field — reuse `.field`, `.field-row`, `.form-actions`; add helpers

Base rules stay: label 13px/500, input 15px with `--radius-sm` border,
focus = accent border + 3px `--accent-weak` ring, `.field` margin-bottom
16px, `.field-row` flex gap 12px (`flex: 1; min-width: 140px` per field),
`.form-actions` right-aligned gap 8px, margin-top 8px.

New helpers (replace all inline `style=`):

```css
.page-shell .field--wide { flex: 2 1 0; min-width: 220px; }  /* e.g. Base URL */
.label-hint { font-weight: 400; color: var(--muted); }      /* inside <label> */
.field-hint {                                              /* under an input */
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--muted);
}
.form-divider {                                            /* between form groups */
  border: 0;
  border-top: 1px solid var(--line);
  margin: 4px 0 20px;
}
```

Field markup contract (applies to every field on all three pages):

```html
<div class="field">
  <label for="base_url">Base URL</label>
  <input id="base_url" name="base_url" type="text" required>
</div>
```

No `<label>` without a matching `for`/`id`. Hints inside labels use
`<span class="label-hint">`; hints under inputs use `<p class="field-hint">`.

### Button hierarchy

| Class | Look | Use on these pages |
| --- | --- | --- |
| `.btn-primary` | accent bg, white text | the page's one main submit (Save, Add member, Change password) |
| `.btn` | white, `--line` border | secondary actions that hit the server (Test AI provider, Test SearXNG, Edit) |
| `.btn-ghost` | transparent | tertiary/cancel inside compact rows |
| `.btn-ghost-danger` (new) | transparent, `--danger-border` border, `--danger` text; hover `--danger-weak` bg + `--danger-strong` text | quiet destructive row actions (Delete in the members table) |
| `.btn-danger` (existing) | solid `--danger`, white text | irreversible confirmations only — none on these pages; do not use it in table rows |
| `.btn-sm` | modifier | all buttons inside table rows |

States (base.css): hover `#f3f4f6`, active `translateY(1px)`,
`:focus-visible` 2px accent outline 1px offset, disabled 55% opacity +
`cursor: not-allowed`. New class:

```css
.btn-ghost-danger {
  background: transparent;
  border-color: var(--danger-border);
  color: var(--danger);           /* 4.5:1 on white */
}
.btn-ghost-danger:hover {
  background: var(--danger-weak);
  border-color: var(--danger);
  color: var(--danger-strong);    /* 5.3:1 on --danger-weak */
}
```

Dashboard follow-up (out of scope here but part of the unification):
migrate `dashboard.css` `.btn.danger` → `.btn-ghost-danger` and delete the
old rule, leaving one danger language app-wide.

### Test action — new `.test-action` + `.test-result`

Replaces `.ai-test-item` / `.ai-test-result`. A test row sits directly
under the field group it probes, so button, inputs, and result read as one
unit:

```html
<div class="test-action">
  <button class="btn" type="button" id="ai-test-ai">Test AI provider</button>
  <p class="test-result" id="ai-test-ai-result" role="status" aria-live="polite"></p>
</div>
```

```css
.test-action {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 20px;
}
/* Tighten the field above a test row — they form one group. If :has() is
 * unsupported the field keeps its 16px margin; harmless either way. */
.page-shell .field:has(+ .test-action) { margin-bottom: 12px; }

.test-result {
  flex: 1 1 200px;
  min-height: 35px;          /* matches .btn height, keeps the row even */
  display: inline-flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  line-height: 1.4;
  word-break: break-word;
}
.test-result:empty { display: none; }  /* no message, no box, no shift */
.test-result.is-testing { background: var(--surface-2); color: var(--muted); }
.test-result.is-ok     { background: var(--ok-weak);     color: var(--ok-strong); }
.test-result.is-err    { background: var(--danger-weak); color: var(--danger-strong); }
```

The result element is **always in the DOM and never `hidden`** — an
`aria-live` region must exist before content arrives or screen readers miss
the announcement. Visibility is handled by `:empty`. Buttons were switched
from ghost to the standard outline `.btn`: a network probe deserves a real
button affordance without competing with Save.

States:

| State | Result element | Button |
| --- | --- | --- |
| Idle | empty (hidden via `:empty`) | "Test …" enabled |
| Testing | `.is-testing`, text "Testing…" | `disabled`, `aria-busy="true"`, label "Testing…" |
| Success | `.is-ok`, text "✓ <detail>" | restored |
| Failure | `.is-err`, text "✗ <detail>" | restored |

### Table card + inline edit row — `.card--table`

The members table gets a flush table card so the header row aligns with the
card edges, with a hairline separating title zone and table:

```css
.card--table { padding: 0; }
.card--table > .card-title { margin: 0; padding: 16px 18px 12px; }
.card--table .table-scroll { overflow-x: auto; }  /* wrap every <table> in one */
.card--table th { border-top: 1px solid var(--line); padding: 9px 18px; }
.card--table td { padding: 11px 18px; }
.card--table tbody tr:not(.edit-row):hover td { background: var(--surface-2); }

.cell-primary { font-weight: 600; }
.cell-actions {
  text-align: right;
  white-space: nowrap;
  width: 1%;
}
.cell-actions .btn { margin-left: 6px; }
.cell-actions form { display: inline; margin: 0; }  /* delete form */

.edit-row > td {
  background: var(--surface-2);
  padding: 14px 18px 16px;
}
.edit-row .form-actions { margin-bottom: 0; }

.badge.role-admin { background: var(--accent-weak); color: var(--accent-strong); }
```

Base table rules still apply (14px text, `th` 12px uppercase muted,
`tr:last-child td` no bottom border). Member role uses the default `.badge`
(neutral); admin gets `.badge.role-admin`.

Column contract:

| Column | Cell class | Content |
| --- | --- | --- |
| Username | `td.cell-primary` | username |
| Display name | — | display name |
| Role | — | `<span class="badge …">role</span>` |
| Created | `td.muted` | created_at |
| Actions | `th.cell-actions` + `td.cell-actions` | Edit (`.btn .btn-sm`), Delete (`.btn-ghost-danger .btn-sm`, admins have no Delete) |

The actions `<th>` is no longer empty:

```html
<th class="cell-actions" scope="col"><span class="visually-hidden">Actions</span></th>
```

Edit row — full a11y contract, labels included:

```html
<tr class="edit-row" id="members-edit-row-{{ m.id }}" hidden>
  <td colspan="5">
    <form method="post" action="/auth/members/edit">
      <input type="hidden" name="user_id" value="{{ m.id }}">
      <div class="field-row">
        <div class="field">
          <label for="edit-display-name-{{ m.id }}">Display name</label>
          <input id="edit-display-name-{{ m.id }}" name="display_name"
                 type="text" value="{{ m.display_name }}">
        </div>
        <div class="field">
          <label for="edit-new-password-{{ m.id }}">New password</label>
          <input id="edit-new-password-{{ m.id }}" name="new_password"
                 type="password" minlength="8" autocomplete="new-password">
          <p class="field-hint">Leave blank to keep the current password.</p>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" type="submit">Save</button>
        <button type="button" class="btn btn-ghost btn-sm"
                data-action="members-edit-cancel" data-user-id="{{ m.id }}">Cancel</button>
      </div>
    </form>
  </td>
</tr>
```

Empty state (no members yet):

```html
<tr class="empty-row"><td colspan="5"><p class="empty">No members yet.</p></td></tr>
```

## Page blueprints

### Settings — `/auth/settings`

Zone order: header → optional notice/error → card "Display name" →
card "Password". Splitting the current single card into two removes the
inline `style="margin-bottom: 24px"` between the forms and matches the
section-card rhythm of the other pages.

```html
<div class="page-shell">
  <div class="page-header">
    <div>
      <h1>Settings</h1>
      <div class="sub">
        Update your display name and password.
        {%- if me.role == 'admin' %}
        Manage member accounts on the <a href="/auth/members">Members page</a>.
        {%- endif %}
      </div>
    </div>
  </div>

  {% if error %}<div class="error-msg">{{ error }}</div>{% endif %}
  {% if info %}<div class="notice">{{ info }}</div>{% endif %}

  <section class="card">
    <h2 class="card-title">Display name</h2>
    <p class="section-desc">
      Signed in as <strong>{{ me.username }}</strong>{% if me.role == 'admin' %} (admin){% endif %}.
    </p>
    <form method="post" action="/auth/settings/profile">
      <div class="field-row">
        <div class="field">
          <label for="display_name">Display name</label>
          <input id="display_name" name="display_name" type="text" required
                 value="{{ me.display_name }}">
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Save name</button>
      </div>
    </form>
  </section>

  <section class="card">
    <h2 class="card-title">Password</h2>
    <p class="section-desc">Choose a new password of at least 8 characters.</p>
    <form method="post" action="/auth/settings/password">
      <div class="field-row">
        <div class="field">
          <label for="current_password">Current password</label>
          <input id="current_password" name="current_password" type="password"
                 required autocomplete="current-password">
        </div>
        <div class="field">
          <label for="new_password">New password</label>
          <input id="new_password" name="new_password" type="password"
                 required minlength="8" autocomplete="new-password">
        </div>
        <div class="field">
          <label for="confirm_password">Confirm new password</label>
          <input id="confirm_password" name="confirm_password" type="password"
                 required minlength="8" autocomplete="new-password">
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Change password</button>
      </div>
    </form>
  </section>
</div>
```

### Members — `/auth/members`

Zone order: header → optional notice/error → card "Create member" →
card `card--table` "Existing accounts".

Create-member card mirrors the others (title, desc, field-row of three
fields, right-aligned primary action). The table card uses the component
contract above; per row: Edit (`.btn .btn-sm`, `aria-expanded` toggled),
Delete for non-admins (`.btn-ghost-danger .btn-sm`, keeps the
`confirm('Delete member … ?')` guard, plus
`aria-label="Delete member {{ m.username }}"` so the button is unambiguous
out of row context).

### AI Agent — `/auth/ai`

Zone order: header → optional notice/error → single card "Provider" with
one form in two groups separated by `.form-divider`:

1. Base URL (`.field--wide`) + Model in one `.field-row`
2. API key field, label hint "(optional for local models)"
3. `.test-action` — Test AI provider + result
4. `.form-divider`
5. SearXNG URL field, label hint "(optional — enables web search)",
   `.field-hint` with the search explanation
6. `.test-action` — Test SearXNG + result
7. `.form-actions` — Save (`.btn-primary`)

Card description keeps the existing copy with `<code>` styling for
`/chat/completions` and `data/config/ai.json`.

## Spacing and typography

Only values that already exist in `base.css` are used — nothing new to invent.

Spacing scale (px): 4 hairline · 6 (buttons in action cells) · 8 (field-row
gap, form-actions gap, notice padding) · 10 (card-title bottom) · 12
(field above a test row) · 14 (global card gap) · 16 (field margin-bottom,
card padding vertical rhythm, section-desc bottom) · 18 (card padding,
table cell padding) · 20 (shell card gap, test-action bottom, divider
bottom) · 24 (page-header bottom) · 48 (shell bottom padding).

| Element | Spec |
| --- | --- |
| `h1` | 26px, −0.02em (22px ≤640px) |
| `.sub` | 14px, `--muted` |
| `h2.card-title` | 16px / 600 |
| `.section-desc` | 14px / 1.5, `--muted` |
| labels | 13px / 500 |
| `.label-hint`, `.field-hint` | 13px / 400, `--muted` |
| inputs | 15px, padding 8px 11px, `--radius-sm` |
| table | 14px; `th` 12px / 600 uppercase / `--muted`, 0.04em |
| badges | 11px / 600 uppercase (base `.badge`) |
| buttons | 14px (`.btn-sm` 13px) |

## Responsive behavior

One breakpoint matters: `max-width: 640px` (already in `base.css`).

| Width | Behavior |
| --- | --- |
| >640px | Shell 760px centered; field-rows horizontal; test results beside buttons |
| ≤640px | `#view` padding 16px (base); `h1` 22px (base); `.field-row` becomes a column (base); `th/td` padding 8px (base). New: `.test-result` goes full width under its button (`.test-result { flex-basis: 100% }`); table card cells tighten to 12px sides; the table itself scrolls horizontally inside `.table-scroll` |

The stacked edit row stays usable at 360px: its fields stack inside the
scrolled table width.

```css
@media (max-width: 640px) {
  .page-shell { padding-top: 4px; }
  .test-result { flex-basis: 100%; }
  .card--table th, .card--table td { padding-left: 12px; padding-right: 12px; }
}
```

## Class-name plan

New file `frontend/static/css/settings.css` owns everything page-specific.
Rationale: `auth.css` is scoped to anonymous pre-login pages — sharing it
with authenticated admin pages is the root cause of the current bug. Do not
extend `auth.css`; add `settings.css` and link it in each page's
`{% block styles %}` (after the global `base.css`, which `layout.html`
always loads).

| Class | Status | Lives in |
| --- | --- | --- |
| `.page-shell` | new | settings.css |
| `.section-desc` (+ `code`) | new | settings.css |
| `.field--wide`, `.label-hint`, `.field-hint`, `.form-divider` | new | settings.css |
| `.test-action`, `.test-result` (+ `.is-testing/.is-ok/.is-err`, `:empty`) | new | settings.css |
| `.card--table`, `.table-scroll`, `.cell-primary`, `.cell-actions`, `.edit-row` | new | settings.css |
| `.badge.role-admin` | new | settings.css |
| `.btn-ghost-danger` | new | base.css (next to the other `.btn-*` variants — it is a base component, like `.btn-danger`) |
| `--danger-strong`, `--ok-strong`, `--danger-border` | new tokens | base.css `:root` |
| `.visually-hidden` | new utility | base.css (generic, used by the actions `<th>`) |
| `.page-header`, `.card`, `.card-title`, `.field`, `.field-row`, `.form-actions`, `.btn*`, `.badge`, `.notice`, `.error-msg`, `.empty`, `.muted`, table base | reuse unchanged | base.css |
| `.auth-view`, `.auth-card` | keep, login/setup only | auth.css |
| `body[data-page="members"]…`, `body[data-page="settings"]…`, `.members-section`, `.ai-test-block/.ai-test-item/.ai-test-result` | **delete** | auth.css (lines ~41–91) |
| `.btn.danger` | migrate to `.btn-ghost-danger`, then delete | dashboard.css (follow-up) |

Keep stable, because scripts and tests reference them: ids `ai-test-ai`,
`ai-test-ai-result`, `ai-test-searxng`, `ai-test-searxng-result`,
`members-edit-row-{{ id }}`; attributes `data-action="members-edit"`,
`data-action="members-edit-cancel"`, `data-user-id`. The `body[data-page]`
attribute stays in `layout.html` (test hook); no CSS on these pages keys
off it.

## JS contracts

Members edit toggle (existing script, two additions):

```js
btn.addEventListener('click', () => {
  const row = document.getElementById('members-edit-row-' + id);
  row.hidden = false;
  btn.disabled = true;
  btn.setAttribute('aria-expanded', 'true');   // NEW
  row.querySelector('input[name="display_name"]').focus();
});
// cancel restores hidden, re-enables, and sets aria-expanded="false".
```

Edit buttons start with `aria-expanded="false"` in the template.

AI test script (existing `test()` reshaped to the new result pattern):

```js
function setResult(el, text, state) {         // state: 'is-testing' | 'is-ok' | 'is-err'
  el.className = 'test-result ' + state;
  el.textContent = text;                      // includes the ✓ / ✗ prefix
}

// in test(): before the fetch —
btn.disabled = true;
btn.setAttribute('aria-busy', 'true');
btn.textContent = 'Testing…';
setResult(resultEl, 'Testing…', 'is-testing');
// in .finally() —
btn.disabled = false;
btn.removeAttribute('aria-busy');
btn.textContent = /* original label */;
```

The element is never toggled with `hidden` — see the test-action spec.

## Accessibility validation

- Contrast (normal text, ≥4.5:1): `--muted` #6b7280 on white 4.9:1 and on
  `--bg` 4.6:1; `--ok-strong` on `--ok-weak` 4.6:1; `--danger-strong` on
  `--danger-weak` 5.3:1; `--danger` on white 4.5:1; accent links on white
  5.1:1. `--ok`/`--danger` on their `-weak` tints fail — that is why the
  `-strong` tokens exist; do not put `--ok` text on `--ok-weak`.
- Every input has a `for`/`id` label, including edit rows.
- Focus: inputs get the accent ring; buttons get the 2px
  `:focus-visible` outline; opening an edit row moves focus into the first
  input; Cancel/Save return it to the Edit button.
- Announcements: test results are polite live regions present before
  content arrives; testing buttons carry `aria-busy`.
- Keyboard: Edit toggles with Enter/Space (native button), the delete
  `confirm()` guard is keyboard-operable, every control is reachable in
  DOM order.
- The actions `<th>` is announced as "Actions" via `.visually-hidden`.

## Implementation checklist

1. `base.css`: add the three tokens, `.visually-hidden`, `.btn-ghost-danger`
   (+ hover).
2. Create `frontend/static/css/settings.css` with the full source from this
   doc (one contiguous block; ~120 lines).
3. `auth.css`: delete the members/settings `body[data-page]` overrides,
   `.members-section`, and the `.ai-test-*` rules. Login/setup are untouched.
4. `settings.html` / `members.html` / `ai-settings.html`:
   - `{% block styles %}` → `settings.css` (instead of `auth.css`);
   - `.auth-view` → `.page-shell`; drop `.members-section`; drop every
     inline `style=`;
   - apply the page blueprints above (Settings becomes two cards);
   - members table: `.card--table` + `.table-scroll`, labeled edit rows,
     visually-hidden actions header, `.btn-ghost-danger` delete with
     `aria-label`;
   - AI page: `.test-action` rows with live-region results, `.form-divider`,
     `.field--wide`, hint classes.
5. Update the two page scripts per the JS contracts.
6. Follow-up (separate change): migrate dashboard `.btn.danger` to
   `.btn-ghost-danger`.
7. Verify ≤640px: stacked fields, full-width test results, horizontally
   scrollable members table.

## Mockup

`/tmp/opencode/settings-members-ai-mockup.html` renders all three pages in
the unified design plus a state gallery (test-result states, button
hierarchy, role badges). Its embedded CSS is this document rendered — copy
rules from the mockup only via the sections above, which are the source of
truth.