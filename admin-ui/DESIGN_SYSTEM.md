# admin-ui design system

Reference doc for the visual redesign of the MCP REST Bridge admin panel. Read this before touching
any page's markup or `<style scoped>` block. The goal is **one coherent system**, not per-page
improvisation — every recipe below already exists somewhere in the codebase; reuse it verbatim
rather than inventing a variant.

## Direction

The product is infrastructure, not a consumer app: a bridge that mediates MCP agents and REST APIs,
with guards, canary/failover, circuit breakers, keys, policies. The aesthetic reference class is
Linear / Vercel / Stripe Dashboard — precise, calm, data-dense, restrained color, real depth instead
of flat gray boxes. Not playful, not maximalist. One accent color carries the personality; everything
else is quiet.

Two "signature" motifs already built, reuse them, don't invent new ones:

- **Command palette (⌘K)** — global fuzzy nav, lives in the sidebar via `<CommandPalette />`.
- **Underline tab strip** with a teal (`--signal`) active indicator — the "circuit trace" motif, used
  in `ServerDetailPage.vue`'s Tools/Settings tabs. Reuse this exact pattern for any future tabs.

## Tokens (`admin-ui/src/style.css`)

All colors/spacing/type live in `:root` as CSS custom properties. **Never hardcode a hex color, a
border-radius px value, or a font-family in a new `<style scoped>` block** — use the token. Color
tokenization rollout is complete (see Rollout status below); if you spot a hardcoded hex color
anywhere, it's either the one documented `.tag-chip` exception in `ServerDetailPage.vue` or a
regression — replace it with the matching token.

```css
/* Surfaces */
--ink: #0e1116; /* sidebar / dark surfaces */
--ink-raised: #171b24;
--ink-border: #262c3a;
--paper: #fafaf8; /* page background */
--surface: #ffffff; /* card background */
--surface-sunken: #f6f7f5; /* hover states, code bg, table stripe */

/* Accent */
--signal: #00a99a; /* primary accent — buttons, links, active states */
--signal-strong: #00877b; /* link/hover text color, darker for AA contrast */
--signal-soft: #e1f5f2; /* tinted backgrounds (icon chips, active nav, cmd-k selection) */
--canary: #d97f0a; /* amber — warnings, elevated/sensitive, canary feature */
--canary-soft: #fdf0dc;
--breach: #c9373d; /* danger — errors, circuit-open, destructive */
--breach-strong: #a52c31;
--breach-soft: #fbeceb;
--ok: #1a8f4f; /* healthy/enabled state — distinct from --signal on purpose */
--ok-soft: #e5f6ec;

/* Text */
--text-primary: #14171c;
--text-secondary: #565d6b;
--text-muted: #8a8f98;
--text-on-dark: #e6e8eb; /* sidebar text */
--text-on-dark-muted: #8d94a3; /* sidebar secondary text */

/* Borders */
--border: #e2e5ea;
--border-strong: #cbd0d8; /* input/button borders — slightly darker than dividers */

/* Type */
--font-display: "Space Grotesk", "IBM Plex Sans", sans-serif; /* h1-h4, StatCard values */
--font-body: "IBM Plex Sans", ...; /* everything else */
--font-mono: "IBM Plex Mono", ui-monospace, ...; /* URLs, endpoints, keys, JSON, ids */

/* Scale */
--radius-sm: 6px; /* buttons, inputs, icon chips */
--radius-md: 10px; /* cards, table wrappers */
--radius-lg: 16px; /* command palette, large modals */
--radius-pill: 999px; /* badges, toggle pills */

--shadow-xs: 0 1px 2px rgba(14, 17, 22, 0.05); /* resting card */
--shadow-sm: 0 1px 3px rgba(14, 17, 22, 0.06), 0 1px 2px rgba(14, 17, 22, 0.04); /* card hover */
--shadow-md: 0 6px 16px rgba(14, 17, 22, 0.08), 0 2px 6px rgba(14, 17, 22, 0.05);
--shadow-lg: 0 16px 40px rgba(14, 17, 22, 0.12), 0 4px 10px rgba(14, 17, 22, 0.05); /* command palette */
```

`h1`–`h4`, `:focus-visible`, `.btn-primary/.btn-secondary/.btn-danger`, `.link-btn`, `.error`, `code`
are already globally re-skinned in `style.css` — you get those for free everywhere, no per-page work
needed.

Scrollbars are also globally re-skinned (thin, token-colored thumb on a transparent track, using
`--border-strong`/`--text-muted` which already flip for dark theme) on every overflowing element —
page content, `.table-scroll`, the command palette, drawers, etc. Don't add a per-component
scrollbar rule; if you find one styled with raw browser defaults, it means it's not overflowing yet
(new scrollable areas get the global rule automatically). The one exception is the sidebar
(`.nav-groups` in `App.vue`), which sits on `--ink` regardless of theme, so it overrides the thumb
color with `--ink-border`/`--text-on-dark-muted` instead of the theme-tied tokens above — copy that
override for any other future surface that's permanently dark.

### Measurement tokens (spacing, font-size, z-index)

Same idea as colors: **never write a bespoke margin/padding/gap/font-size/z-index value** — use the
token. These were grounded in an audit of every value actually in use across the app (not invented),
then consolidated into a clean scale.

```css
/* Spacing — 4px base unit, non-contiguous steps on purpose (forces a real choice
   instead of splitting hairs between e.g. 0.6rem and 0.65rem). */
--space-1: 0.25rem; /* 4px  — icon-to-dot gaps, chip inner padding */
--space-1-5: 0.375rem; /* 6px  — tight icon+label gaps */
--space-2: 0.5rem; /* 8px  — compact padding, badge/nav gaps */
--space-3: 0.75rem; /* 12px — table cell padding, default small gaps */
--space-4: 1rem; /* 16px — field spacing, card internal gaps */
--space-5: 1.25rem; /* 20px — card padding, page-header margin */
--space-6: 1.5rem; /* 24px — section spacing */
--space-8: 2rem; /* 32px — large section breaks */
--space-10: 2.5rem; /* 40px — page content horizontal padding */
--space-12: 3rem; /* 48px — empty-state padding, big vertical breathing room */

/* Font sizes — t-shirt scale, matches radius/shadow naming. */
--text-xs: 0.72rem; /* eyebrow labels, uppercase micro-labels, table headers */
--text-sm: 0.8rem; /* secondary/muted text, badges, hints */
--text-base: 0.88rem; /* default body text inside components — buttons, table cells */
--text-md: 0.95rem; /* form inputs, slightly larger body copy */
--text-lg: 1.1rem; /* dialog titles, subsection headings */

/* Z-index — named layers, low to high. Always use the token; never a bare
   number, or the next overlay someone adds will collide with an existing
   one (this scale replaced 7 uncoordinated magic numbers found in the
   wild: 49, 50, 100, 120, 150, 200, 300 used on 2 different elements).
   --z-drawer/--z-drawer-top sit above --z-mobile-topbar so the guard-editor
   drawer (header + Close button included) stays usable on mobile, and
   --z-overlay sits above --z-drawer-top so an in-drawer ConfirmDialog
   (e.g. clear-guards) still renders on top of the drawer on every viewport. */
--z-drawer: 130; /* ServerDetailPage guard-editor drawer overlay */
--z-drawer-top: 131; /* the drawer panel itself, sibling of its overlay */
--z-overlay: 140; /* ConfirmDialog — blocks the whole page */
--z-mobile-topbar: 120; /* sticky mobile header */
--z-mobile-backdrop: 150; /* mobile nav backdrop */
--z-mobile-nav: 200; /* mobile sidebar panel */
--z-banner: 250; /* persistent fixed banners (e.g. demo-mode ribbon) */
--z-command-palette: 300; /* always reachable above everything else */
```

Rules for using these:

- If a value is below `--space-1` (sub-4px, e.g. a hairline nudge), leave it as a literal — the scale
  intentionally doesn't cover micro-adjustments that aren't part of the real rhythm.
- `em`-based padding/gap (scales with the element's own `font-size`, e.g. badge padding, `code`
  padding) is a different, deliberate technique — don't convert those to `--space-*` (which is
  `rem`-based, i.e. root-relative).
- The big display numbers in `StatCard.vue` (`1.85rem`) are intentionally above the `--text-*` scale
  — that scale is for body/UI text, not display numbers (those already get their character from
  `--font-display`, not from being bigger body text).
- Adding a new overlay/fixed-position element? Give it a named `--z-*` token, don't reuse a bare
  number — that's exactly how the old code ended up with two unrelated elements both at `z-index: 300`.
- Applied so far to: `style.css` itself, `App.vue`, `ConfirmDialog.vue`, `CommandPalette.vue`,
  `StatCard.vue`, `SegmentedBar.vue`, `MiniBarChart.vue`, `StatusBadge.vue`, and the two z-index rules
  in `ServerDetailPage.vue`'s drawer. The other ~20 page files still have their spacing/font-size as
  bespoke rem values (functionally fine, just not yet mapped to the token scale) — when you're in one
  of those files for any reason, prefer switching its values to the nearest token over leaving new
  bespoke numbers next to old ones.

## Large screens / TV mode

This is a manager + observability + realtime surface — it ends up full-screen on big monitors and
wall TVs viewed from meters away. The strategy (implemented, don't regress it):

1. **The shell is fluid.** `.content` in `App.vue` has **no max-width** — pages fill every pixel.
   Never re-introduce a cap on the shell; constrain _forms and prose_ per page instead (rem-based
   `max-width` on the form/filter element, which every page already does).
2. **The root font-size ramps up with viewport width** (`:root` in `style.css`):
   `clamp(100%, calc(100% + (100vw - 1920px) / 240), 175%)` — 16px below 1920, ~18.7px at 2560,
   24px at 4K, capped 28px. Because every spacing/type token is rem-based, this zooms the whole UI
   coherently, and it bounds the _effective_ design width to ~1920–2750px on any screen — layouts
   tested at desktop widths stay valid on an 8K wall.
3. **Structural dimensions are rem, never px.** Anything ≥ ~1.5rem/24px that participates in layout
   (sidebar/drawer/dialog widths, form/filter `max-width`s, grid `minmax()` mins, table column
   widths, bar/track heights) must be written in rem so the ramp scales it. Keep px only for
   hairlines (1–2px borders), radii, shadows, and `@media` breakpoints (those intentionally stay
   physical). The `min()`/`clamp()` insides count too: `width: min(26.25rem, 100%)`, not `min(420px, 100%)`.
4. **Icons are em-sized globally.** `svg.lucide { width: 1em; height: 1em }` in `style.css` re-bases
   every lucide icon on its local font-size (authored `:size` values were ~1em of their context
   anyway); `.empty-icon`/`.not-found-icon` are 1.75em. The `:size` prop still sets the fallback —
   keep passing it — but don't fight the em rule with per-icon px CSS.
5. **Charts scale.** `TimeSeriesChart` measures its rem-based box and multiplies its px-space
   geometry (paddings, stroke widths, dot radii) by the live zoom factor; `DonutChart` is CSS-sized
   in rem over a fixed viewBox (pure vector scaling — note its center text is viewBox-px on purpose,
   rem there would double-scale). New chart components must follow one of these two patterns.
6. **Grids add columns on their own.** Card/stat grids use `repeat(auto-fit|auto-fill, minmax(Nrem, 1fr))`
   — with rem mins, the column count grows with effective width. Don't hardcode column counts for
   wide screens.

Test at 2560×1440 and 3840×2160 (and still at ~700–900px) when touching layout: no dead space to the
right of `.content`, no horizontal scrollbar, text/controls visibly larger at 4K, charts keep their
aspect and stroke proportions.

## Icons

Library: `lucide-vue-next` (already installed). Import specific icons per file, e.g.
`import { KeyRound, Trash2 } from "lucide-vue-next"`.

- Inline with text (buttons, nav items, table headers): `:size="14"` to `:size="16"`, `stroke-width="2"`.
- Larger standalone (empty states): `:size="24"`–`:size="28"`, `stroke-width="1.5"`.
- Always `aria-hidden="true"` — icons are decorative, the adjacent text is the accessible name.
- Pick icons for _meaning_, not decoration: e.g. `KeyRound` for API keys, `ShieldCheck` for policies,
  `Users2` for consumers, `Trash2`/`XCircle` for destructive actions, `RotateCcw` for reset/rollback
  actions. Check `App.vue` and `CommandPalette.vue` for the icon already chosen for each entity type
  — reuse the same icon for the same concept everywhere (a "server" is always `Server`, never `Box`
  in one place and `Server` in another).

## Component inventory (`admin-ui/src/components/`)

`components/` is organized into subdirectories by domain — `ui/` (generic primitives), `charts/`,
`guard-editor/` (the `GuardEditor.vue` family), `server-detail/` (the `ServerDetailPage.vue` section
family), and `layout/` (`TheSidebar.vue`/`TheMobileTopbar.vue`/`DemoRibbon.vue`, extracted from
`App.vue`) — plus a handful of standalone files (`CommandPalette.vue`, `SchemaForm.vue`,
`BundleToolPicker.vue`, the dialog components) still directly under `components/`. The table below
gives each component's subdirectory — don't assume it's a flat child of `components/`.

| Component                 | Use for                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/StatCard.vue`         | Any "big number + label" metric tile. Props: `icon` (component), `label`, `value`, `detail?`, `tone?` (`default/danger/warning/ok`), `pulse?`. Default slot renders below the value/detail (used for `SegmentedBar`). Layout is icon+label row, then value on its own full-width row below — **don't revert to the icon-beside-value layout**, it overflows on narrow cards (see git history if curious why). |
| `charts/SegmentedBar.vue` | Proportion bar from real counts. Props: `segments: {label, value, color}[]`. Never fabricate segments — only chart real fields that exist on the API response.                                                                                                                                                                                                                                                |
| `charts/MiniBarChart.vue` | Ranked horizontal bars (top-N by some count). Props: `rows: {label, value, hint?, danger?}[]`. Use for any "top N by count" table that already exists (top tools, by-key, etc.) — add the chart _above_ the existing table, don't remove the table (chart = shape, table = exact numbers).                                                                                                                    |
| `CommandPalette.vue`      | Already global via `App.vue`. Don't re-instantiate elsewhere. If a new entity type should be jumpable (e.g. Policies, Consumers), add it to the `PAGES` array or a new live-fetch block in that file.                                                                                                                                                                                                         |
| `ui/StatusBadge.vue`      | Any `healthy/degraded/unreachable/closed/open/half_open` state pill. Already icon-based (CheckCircle2/AlertTriangle/XCircle/Circle).                                                                                                                                                                                                                                                                          |
| `ui/ConfirmDialog.vue`    | All destructive/risky confirmations. Fully tokenized.                                                                                                                                                                                                                                                                                                                                                         |
| `ui/SignalLoader.vue`     | Any inline "data is loading" state — replaces plain `<div class="loading">Loading…</div>` text. Props: `label?` (defaults to `"Loading…"`, pass a custom string like `"Loading tags…"` where the old text had one). Reuses the login page's oscilloscope-trace shape at a compact scale, animated via the same `signal-pulse` keyframe as the sidebar live-dot — don't invent a second loading animation.     |

## CSS recipes (copy these verbatim)

**Table wrapped in a card** (any `<table>` that lists rows — clients, keys, policies, etc.):

```html
<div class="table-card table-scroll">
  <table class="whatever-table">
    …
  </table>
</div>
```

```css
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.whatever-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.whatever-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.whatever-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.whatever-table tbody tr:last-child td {
  border-bottom: none;
}
.whatever-table tbody tr:hover {
  background: var(--surface-sunken);
}
```

**Toggle pill** (enabled/disabled state that's also a button — Bundles, Composites, Servers, Keys…):

```css
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  border-radius: var(--radius-pill);
  padding: 0.28rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  background: var(--surface);
  transition: background-color 0.12s ease;
}
.toggle::before {
  content: "";
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.toggle-on {
  border: 1px solid var(--ok);
  color: var(--ok);
}
.toggle-off {
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.toggle-on:hover {
  background: var(--ok-soft);
}
.toggle-off:hover {
  background: var(--surface-sunken);
}
```

Button text should be a verb+state where the action is the primary purpose of the row (e.g. bundles:
"Disable bundle"/"Enable bundle"), or just the state where it's a secondary column among many other
actions (e.g. servers table: "Enabled"/"Disabled").

**Underline tab strip** (the "circuit trace" motif — reuse for any future tabbed view):

```css
.tab-strip {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--border);
}
.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.88rem;
  padding: 0.55rem 0.35rem;
  margin-bottom: -1px;
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease;
}
.tab-btn:hover {
  color: var(--text-primary);
}
.tab-btn.tab-active {
  color: var(--signal-strong);
  border-bottom-color: var(--signal);
}
```

Use with proper tab semantics — wrap in `role="tablist"` and mark each button `role="tab"` with
`:aria-selected`:

```html
<div class="tab-strip" role="tablist">
  <button
    type="button"
    role="tab"
    :aria-selected="activeTab === 'x'"
    class="tab-btn"
    :class="{ 'tab-active': activeTab === 'x' }"
    @click="..."
  >
    Label
  </button>
</div>
```

**Chart card** (any chart — donut, time-series, mini-bar — wrapped in its own card, with a small
heading above it):

```html
<div class="chart-card">
  <h2>Chart title</h2>
  <SomeChartComponent ... />
</div>
```

```css
.chart-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: var(--space-4) var(--space-5);
  margin-bottom: var(--space-6);
}
.chart-card h2 {
  font-size: var(--text-sm);
  margin: 0 0 var(--space-3);
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-weight: 600;
}
```

**Search/filter input with leading icon**:

```html
<div class="search-input">
  <search :size="15" stroke-width="2" aria-hidden="true" />
  <input type="search" placeholder="…" />
</div>
```

```css
.search-input {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0 0.6rem;
  background: var(--surface);
}
.search-input svg {
  color: var(--text-muted);
  flex-shrink: 0;
}
.search-input input {
  flex: 1;
  width: 100%;
  padding: 0.45rem 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 0.9rem;
}
```

**Page header** (title + primary action, used on every list page):

```css
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.25rem;
}
.page-header h1 {
  margin: 0 0 0.2rem;
}
.subtitle {
  color: var(--text-secondary);
  margin: 0;
}
```

**Empty state** (no rows yet):

```html
<div class="empty-state">
  <SomeIcon :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
  <p>…</p>
</div>
```

```css
.empty-state {
  padding: 3rem 2rem;
  text-align: center;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.empty-icon {
  color: var(--text-muted);
  margin-bottom: 0.75rem;
}
```

**Pagination bar pinned to the bottom of the screen** (Previous/Next controls below a table —
Servers, Traces, Traffic…): `position: sticky` alone only keeps the bar visible while scrolling
content taller than the viewport — on a short page (e.g. 2 servers) it just sits right after the
table with empty space below, not at the bottom of the screen. To get real app-like behavior in
both cases, the page root also needs to be a full-height flex column so the bar's own margin can
push it down when content is short:

```css
section {
  display: flex;
  flex-direction: column;
  min-height: 100%; /* fills the .content viewport; grows taller if content overflows it */
}
.pagination {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: auto; /* pushes the bar to the bottom when content doesn't fill the viewport */
  position: sticky; /* ...and re-pins it to the bottom edge once content does overflow */
  bottom: 0;
  z-index: 1;
  background: var(--paper);
  border-top: 1px solid var(--border);
  padding: var(--space-3) 0;
}
```

`.content` (`App.vue`) already has a definite `height: 100%` and is the page's scroll container, so
`min-height: 100%` on `section` resolves correctly without any other markup changes — every other
direct child of `section` (`.page-header`, `.filters`, `.table-card`, etc.) keeps its normal size,
only `.pagination`'s auto margin absorbs the leftover space.

Only apply this where the page has one real trailing Previous/Next bar (`DashboardPage.vue`,
`TracesPage.vue`, `TrafficPage.vue`). Pages with several independent inline save buttons scattered
across sections (`ServerDetailPage.vue`, `BundleDetailPage.vue`, `CompositeDetailPage.vue`) or a
single create/edit form near the top (`ConsumersPage.vue`, `WsProxyTargetsPage.vue`) don't have one
canonical "bottom bar" to pin — don't force it there.

**"Cancel" toggling a create form** — the button must not stay `.btn-primary` once it means Cancel:

```html
<button :class="showForm ? 'btn-secondary' : 'btn-primary'" @click="showForm = !showForm">
  {{ showForm ? 'Cancel' : 'New thing' }}
</button>
```

**Checkboxes and radios** — styled globally in `style.css` (`input[type="checkbox"]`,
`input[type="radio"]`), no per-file work needed: custom box/circle with a clip-path checkmark or
dot, `--signal` when checked, `:focus-visible` ring. Just use plain `<input type="checkbox">` /
`<input type="radio">` anywhere and it picks up the modern style automatically.

**Segmented control** — replaces a _visible_ native radio group for 2-4 mutually-exclusive inline
choices (e.g. REST API/MCP server, From OpenAPI/Manual tools). Still real `<input type="radio">`
under the hood (keyboard nav + a11y intact), only the visual is redrawn on the `<label>` via the
global `.segmented` class in `style.css` — don't reimplement this per page:

```html
<div class="segmented" role="radiogroup" aria-label="…">
  <label><input v-model="mode" type="radio" name="mode" value="a" /> Option A</label>
  <label><input v-model="mode" type="radio" name="mode" value="b" /> Option B</label>
</div>
```

No extra CSS needed in the page's `<style scoped>` — `.segmented` is fully global. For a radio group
with more than ~4 options or that needs to stack vertically with descriptive text per option, don't
force it into a segmented control — leave it as a plain vertical list of native (now auto-styled)
radios instead.

**Form field** — label above input, always associated by `for`/`id`:

```css
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.field input,
.field select,
.field textarea {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
```

## Rules

- Reuse the shared components and recipes above before writing new CSS. If a page needs something
  none of the recipes cover, model it after the closest existing pattern rather than inventing a new
  visual language.
- Icons are for real semantic categories (entity types, states, actions) — don't decorate arbitrary
  headings with icons just to add polish.
- Never fabricate chart data. Only visualize fields that already exist on the API response type in
  `admin-ui/src/types/api.ts`. If a page's data doesn't support a chart, leave it as StatCards/tables.
- Don't touch component logic/behavior while doing a visual pass — this is a styling-only pass. If you
  spot an actual bug while in a file, note it in your summary instead of fixing it inline.
- Test at a narrow width (~700-900px), not just full desktop — several early bugs in this system only
  showed up when cards got tight. `StatCard.vue` in particular had two rounds of real overflow bugs;
  its current icon-row-then-value-row layout is the fix, don't regress it.
- Run `bun run typecheck` (from `admin-ui/`) after every file you touch.

## Rollout status

**Full rollout complete.** Every page and shared component now applies the tokens + recipes above:
`App.vue`, `style.css`, `main.ts`, `StatusBadge.vue`, `ConfirmDialog.vue`, `CommandPalette.vue`,
`StatCard.vue`, `SegmentedBar.vue`, `MiniBarChart.vue`, `GuardEditor.vue`, `SchemaForm.vue`,
`DashboardPage.vue`, `ServerDetailPage.vue`, `RegisterServerPage.vue`, `OverviewPage.vue`,
`UsagePage.vue`, `LoginPage.vue`, `NotFoundPage.vue`, `BundlesPage.vue`, `BundleDetailPage.vue`,
`BundleToolPicker.vue`, `CompositesPage.vue`, `CompositeDetailPage.vue`, `KeysPage.vue`,
`PoliciesPage.vue`, `ConsumersPage.vue`, `UsersPage.vue`, `TeamsPage.vue`, `ConfigPage.vue`,
`AlertsPage.vue`, `AuditLogPage.vue`, `SchedulesPage.vue`, `DonutChart.vue`, `QuotaBar.vue`,
`TimeSeriesChart.vue`, `TrafficPage.vue`, `MonitorsPage.vue`, `ApprovalsPage.vue`.

`ServerDetailPage.vue` was the last holdout with raw hex colors (test-ok/test-error banners, example
chips, drawer background, form borders, diff add/remove) and got tokenized as part of the
components-directory reorg (rebuild onto the shared `ui/`/`server-detail/` primitives). One
deliberate exception remains there: `.tag-chip`'s blue tint has no matching semantic token in this
app's palette (there's no generic "info" color — only `--signal`/`--canary`/`--breach`/`--ok`/
`--kind-mcp`, none of which mean "tag"), so it's left as a commented hardcoded pair rather than
forced onto an unrelated token or a new one-off token invented for a single chip — see the inline
comment above `.tag-chip` in that file.

`bun run typecheck` is clean. If you add a new page or component, follow the recipes above rather
than starting from scratch — every visual pattern this app needs already has a home here.

### Known gaps noticed during rollout, not fixed (out of scope for a styling-only pass)

- `RegisterServerPage.vue`: in REST+OpenAPI mode, "Register server" stays disabled until "Preview
  tools" has been run at least once, and any edit to the OpenAPI URL/tags/ops resets that — nothing
  in the UI explains _why_ the primary button is disabled.
- `CompositeDetailPage.vue` has no unsaved-changes route-leave guard, unlike `BundleDetailPage.vue`
  which already has one via `onBeforeRouteLeave` + `ConfirmDialog`.
- `KeysPage.vue`: the "Elevated" checkbox in the create form is styled identically to the "elevated"
  status chip in the table, which conflates "this sets the flag" with "this key is elevated."
