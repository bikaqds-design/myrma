# myRMA — Design System (Direction B · "Command")
# Drop this file in your project root. Claude Code will read it to apply
# the new theme consistently across all files it touches.

---
name: myRMA Command
description: >
  Professional RMA operations console. Cool neutral palette, flat hairline
  cards (no soft shadows), bold indigo accent, crisp labelled sections,
  and minimal thin-line charts. Supports light and dark mode via Tailwind's
  `dark:` variant and Tailwind CSS custom tokens below.

colors:
  # Light mode (default)
  page-light:        "#f4f6f9"
  surface-light:     "#ffffff"
  surface-inset:     "#f8f9fb"
  border-light:      "#e6e9ef"
  border-soft-light: "#f0f2f6"
  text-light:        "#211f1b"
  text-muted-light:  "#6c6760"
  text-faint-light:  "#a09d99"

  # Dark mode (class="dark" on <html>)
  page-dark:        "#0b0f17"
  surface-dark:     "#121823"
  surface-inset-dark: "#0f1520"
  border-dark:      "#212a38"
  border-soft-dark: "#1a2230"
  text-dark:        "#e8ebf0"
  text-muted-dark:  "#9aa4b2"
  text-faint-dark:  "#4a5568"

  # Accent — indigo
  accent-light:  "#4338ca"   # indigo-700
  accent-dark:   "#a5b4fc"   # indigo-300
  accent-soft-light: "rgba(67,56,202,0.11)"
  accent-soft-dark:  "rgba(165,180,252,0.16)"

  # Semantic
  good:  "#10b981"   # emerald-500
  warn:  "#f59e0b"   # amber-400
  bad:   "#ef4444"   # red-500

  # Status (RMA ticket statuses)
  status-open:        "#3b82f6"
  status-in-progress: "#6366f1"
  status-pending:     "#f59e0b"
  status-on-hold:     "#eab308"
  status-completed:   "#14b8a6"
  status-closed:      "#10b981"
  status-cancelled:   "#94a3b8"
  status-overdue:     "#ef4444"

  # Priority
  priority-critical: "#ef4444"
  priority-high:     "#f59e0b"
  priority-medium:   "#6366f1"
  priority-low:      "#94a3b8"

  # Charts
  chart-track-light: "#eaedf2"
  chart-grid-light:  "#eef1f5"
  chart-tick-light:  "#a8a39a"
  chart-track-dark:  "#212a38"
  chart-grid-dark:   "#1a2230"
  chart-tick-dark:   "#64707f"

typography:
  sans:
    fontFamily: "Hanken Grotesk"
    source: "https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&display=swap"
    weights: [400, 500, 600, 700, 800]
  heading-xl:
    fontSize: "25px"
    fontWeight: "750"
    letterSpacing: "-0.5px"
  heading-lg:
    fontSize: "20px"
    fontWeight: "700"
    letterSpacing: "-0.3px"
  label-upper:
    fontSize: "11px"
    fontWeight: "700"
    letterSpacing: "1.2px"
    textTransform: "uppercase"
  kpi-hero:
    fontSize: "40px"
    fontWeight: "780"
    letterSpacing: "-1.4px"
    fontVariantNumeric: "tabular-nums"
  kpi-medium:
    fontSize: "26px"
    fontWeight: "760"
    letterSpacing: "-0.7px"
    fontVariantNumeric: "tabular-nums"
  body:
    fontSize: "13.5px"
    fontWeight: "400"
  body-sm:
    fontSize: "12.5px"
    fontWeight: "500"
  label:
    fontSize: "12px"
    fontWeight: "600"
    letterSpacing: "0.1px"

rounded:
  card: "14px"
  tile: "10px"
  badge: "6px"
  pill: "9999px"
  inset-tile: "10px"

spacing:
  page-x: "28px"
  page-y: "28px"
  grid-gap: "16px"
  card-pad: "18px"

components:
  card:
    backgroundColor: "{colors.surface-light}"
    border: "1px solid {colors.border-light}"
    borderRadius: "{rounded.card}"
    padding: "{spacing.card-pad}"
    boxShadow: "none"
  card-dark:
    backgroundColor: "{colors.surface-dark}"
    border: "1px solid {colors.border-dark}"
  section-label:
    textColor: "{colors.text-faint-light}"
    typography: "{typography.label-upper}"
  status-pill:
    borderRadius: "{rounded.pill}"
    padding: "3px 10px"
    typography: "{typography.body-sm}"
  button-active:
    backgroundColor: "{colors.accent-light}"
    textColor: "#ffffff"
    borderRadius: "{rounded.pill}"

---

## Overview
myRMA "Command" is a professional RMA operations console. The design philosophy
is **data clarity over decoration**: flat hairline cards (never soft shadows),
a cool slightly-blue-gray page background, and a strong indigo accent that
identifies interactive/actionable elements. Every piece of data is reachable
in 1–2 clicks.

## Colors
Use the page background (`#f4f6f9` / `#0b0f17` dark) as the canvas. Cards are
pure white / `#121823` dark. Surface-inset (`#f8f9fb` / `#0f1520` dark) is for
nested tiles inside cards (inventory grid, technician columns). Never use
shadows — borders do the separation work.

The indigo accent (`#4338ca` / `#a5b4fc` dark) is used for: active buttons,
chart lines/bars/arcs, focused states, section labels' line accents. Do not
use it for decorative elements.

Status colours are fixed (see token list) and must be consistent everywhere:
badges, dots, chart segments, KPI numbers. Never reuse a status colour for
a different status.

## Typography
Hanken Grotesk replaces whatever sans font the project currently uses. Add to
Google Fonts import in `index.html` and set as `fontFamily.sans` in
`tailwind.config.js`. Use font-weight 650–780 for KPI numbers (no standard
Tailwind class — use arbitrary `font-[750]`). Enable tabular-nums on all
numeric displays with `tabular-nums` / `font-variant-numeric: tabular-nums`.

## Layout
Page container: `min-h-screen bg-[#f4f6f9] dark:bg-[#0b0f17] px-7 py-7`.
Grid: `grid grid-cols-12 gap-4`.

Section labels break the grid into named groups (Performance, Trends, Activity,
Team & inventory) and span all 12 columns. They are visually lightweight —
uppercase 11px label on the left, a 1px border line filling to the right.

## Cards
`bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38]
rounded-[14px] p-[18px]` — no shadow. Cards are the primary container; never
nest cards.

Card headers are a flex row: title (15px / 650 weight) left, optional action
text right. No icon chips in card headers — icons are used at the page header
level only.

## Charts (Recharts)
- Line chart: `strokeWidth={2}`, dots `r={2.6}`, `<Area>` with 16% opacity
  gradient. Grid: horizontal lines only, colour `#eef1f5` / `#1a2230` dark.
  Axis ticks: 9.5px, colour `#a8a39a` / `#64707f` dark.
- Bar chart: `radius={[4,4,0,0]}`, bar width ≤ 12px (slot × 0.5), accent fill
  at 0.85 opacity. Same grid.
- Radial gauge: SVG only, `stroke-linecap="round"`, track circle behind arc.
- Donut: `<PieChart innerRadius>` or SVG. Custom legend HTML (not Recharts legend).

## Interactions
All interactive rows/tiles get `hover:bg-gray-50 dark:hover:bg-[#1a2230]
transition-colors` instead of the current `hover:shadow-md`. Active pill
buttons replace the current tab/filter pattern.

## Dark Mode
Uses Tailwind's `class` strategy. Dark tokens are listed above. The
`AppearanceContext`'s `darkMode` boolean should toggle `dark` on `<html>` or
`<body>` — check `src/contexts/AppearanceContext.jsx` and ensure the toggle
writes `document.documentElement.classList.toggle('dark', darkMode)`.

## RTL / Arabic Layout

The app supports Arabic with full RTL layout. `AppearanceContext` sets `dir="rtl"`
on `<html>` when `language === 'ar'`. Tailwind's logical-property utilities
(`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`) flip automatically.

**Key rules for RTL-aware components:**

- Use `ms-` / `me-` (margin-start/end) and `ps-` / `pe-` (padding-start/end)
  instead of `ml-`/`mr-` for any spacing that should mirror in RTL.
- Icons placed beside text: use `ltr:mr-2 rtl:ml-2` or the logical `me-2`.
- Portaled elements (dropdowns, panels rendered via `createPortal`) do NOT
  inherit `dir` from `<html>`. Always add `dir={isRtl ? 'rtl' : 'ltr'}` to the
  root element of any portaled component.
- Floating panels anchored to a button: in RTL the button may be on the opposite
  side of the viewport. Compute position from `button.getBoundingClientRect()`
  and branch on `i18n.language === 'ar'`. See `NotificationBell.jsx` for the
  reference implementation.
- Never use `text-right` or `text-left` for content alignment that should follow
  reading direction — use `text-start` / `text-end` instead.
- SVG arrows and chevrons that indicate direction (→ / ←) should be flipped in
  RTL via `rtl:rotate-180` or by swapping the icon entirely.

**Font:** Hanken Grotesk works for both scripts (Latin + Arabic numerals in
mixed UI). For Arabic body text, the system fallback handles Arabic glyphs
naturally. No additional Arabic font loading is required for the current scope.

## Canonical Search + Filter Components

These are the exact Tailwind class strings every page MUST use. Do not deviate.

### Search input (always full-width inside a `relative` wrapper)

```jsx
<div className="relative flex-1 min-w-48">
  <input
    className="w-full pl-9 pr-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#a09d99] dark:placeholder:text-[#4a5568]"
    ...
  />
  <svg className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute left-3 top-1/2 -translate-y-1/2" .../>
</div>
```

### Filters button (toggles a collapsible panel)

```jsx
<button
  className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${
    showFilters || activeFilterCount > 0
      ? 'border-[#4338ca] dark:border-[#a5b4fc] text-[#4338ca] dark:text-[#a5b4fc] bg-indigo-50 dark:bg-indigo-900/20'
      : 'border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'
  }`}
>
  <svg className="w-4 h-4" .../>  {/* always w-4 h-4, never w-5 h-5 */}
  {t('common.filters')}
  {activeFilterCount > 0 && (
    <span className="w-4 h-4 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] text-xs rounded-full flex items-center justify-center">
      {activeFilterCount}
    </span>
  )}
</button>
```

### Filter panel container

```jsx
<div className="p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
```

### Filter panel `<select>` / `<input>` elements

```jsx
const inp = 'px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent'
```

**Reference implementation:** `src/pages/cp/AuditLog.jsx` — exact markup, `aria-expanded`, `aria-controls`, `activeFilterCount` badge, and collapsible panel.

---

## Canonical Bulk Action Bar — UNIFIED 2026-07-09

When rows can be multi-selected for bulk operations, the bar MUST appear as a standalone block **below** the search/filter card and **above** the table. Never place it inside `<PageHeader>` or the toolbar row.

**Reference implementation:** `src/pages/Pipeline/PipelineListView.jsx`

**Pages unified (2026-07-09):** Pipeline, Leads, Customers, Products, RMA Tickets.

### Container

```jsx
<div className="bg-indigo-50 dark:bg-indigo-900/20 border border-[#4338ca]/20 dark:border-[#a5b4fc]/20 rounded-[14px] px-4 py-2.5 flex items-center gap-3 flex-wrap">
```

### Selection count label

```jsx
<span className="text-sm font-medium text-[#4338ca] dark:text-[#a5b4fc]">
  {count} {t('common.selected')}
</span>
```

### Divider

```jsx
<div className="w-px h-5 bg-[#4338ca]/20 dark:bg-[#a5b4fc]/20" />
```

### Action selects (change status / change stage / etc.)

```jsx
<select className="text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent">
```

### Apply button (select + apply pattern)

```jsx
<button className="px-3 py-1.5 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-40 transition-opacity">
```

### Delete button (soft red — NOT solid)

```jsx
<button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors border border-red-200 dark:border-red-800">
  <svg className="w-3.5 h-3.5" ...trash icon... />
  {t('common.delete')}
</button>
```

### Clear / Deselect button (always `ml-auto` — pushes to far right)

```jsx
<button onClick={clearSelection} className="ml-auto text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]">
  {t('common.clear')}
</button>
```
