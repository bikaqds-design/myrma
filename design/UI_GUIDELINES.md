# myCRM UI guidelines

How to build or change a screen in this app. Written for whoever touches the UI
next, including a future session of this work.

---

## The one rule that explains most of the others

**Arabic is a first-class locale.** Roughly half the audit's findings, and every
single Critical, came from that not being true in some corner. If you remember
nothing else: build it, then look at it in Arabic before calling it done.

---

## Use the primitives

Import from `src/components/ui`:

```jsx
import { Button, Input, Select, Table, Spinner, Ltr } from '../components/ui'
```

Adoption is partial — 29–57% depending on the primitive — so you will find
hand-rolled controls beside the real ones. Copying the hand-rolled neighbour is
how the inconsistency spread. Use the primitive.

---

## Text

**Every user-visible string goes through `t()`.** No exceptions for "it's just a
label" or "it's only in the admin panel". A hardcoded English string in an RTL
page renders its terminal punctuation on the wrong edge — `?Forgot password`,
`!Welcome to myCRM`, `.minutes` were all real, and all fixed by translating
rather than by any bidi trick.

Add keys to **both** `src/locales/en.json` and `src/locales/ar.json` in the same
change. A key missing from `ar.json` silently falls back to English.

A lint rule flags hardcoded JSX text of two words or more.

---

## Direction

**Logical properties only.** `ms-`/`me-`/`ps-`/`pe-`, `text-start`/`text-end`,
`start-`/`end-`. Never `ml-`, `text-right`, `left-0`. A lint rule enforces this;
585 physical properties were converted in one pass and the count is held at zero.

**`dir="ltr"` is not enough on its own.** It sets the caret direction but
`text-align` inherits as a resolved physical value, so an isolated Latin field
still aligned to the wrong edge until `rtl.css` was changed from
`text-align: right` to `text-align: start`. If you add a field for an email,
phone, serial or SKU, `dir="ltr"` is correct — just know it is the direction, not
the alignment.

**Directional glyphs must mirror.** Arrows, chevrons, back and next controls.

```jsx
const isRtl = i18n.language === 'ar'
<span aria-hidden="true">{isRtl ? '←' : '→'}</span>
```

**Isolate signed numbers.** `+8%` inside RTL text renders as `8%+`, which reads
as a different value. Wrap in `<Ltr>`, or use `numeric: true` on a Table column
and get it for free. Plain unsigned numbers, currency and IDs are fine —
`8,000.00` and `PAY-2026-00011` render correctly without help.

---

## Tables

`src/components/Table.jsx`. Columns are data, not children — that is what lets
the component own the empty row's `colSpan`, skeleton rows that match the real
layout, and selection.

```jsx
<Table
  columns={[
    { key: 'name', header: t('x.name'), cell: (r) => r.name },
    { key: 'total', header: t('x.total'), align: 'end', numeric: true,
      cell: (r) => fmtMoney(r.total) },
  ]}
  rows={rows}
  rowKey={(r) => r.id}
  loading={isLoading}
  empty={{ title: t('x.none') }}
  caption={t('x.tableCaption')}
/>
```

Column options: `align` (`start`/`end`/`center`), `numeric` (bidi-isolates),
`sortable`, `width`, `cellClassName`, `cell` (a render function, so inputs and
nested components inside cells work normally).

Table options: `selectable` + `selected` + `onSelectionChange`, `onRowClick`
(adds keyboard support automatically), `sort` + `onSortChange`, `stickyHeader`,
`footer` (validates its own spans against the column count).

### Migrating a hand-written table

The migration is **opportunistic** — convert a table when you are already
changing that screen for another reason. Do not run a bulk migration; see
`design/BACKLOG.md` for why.

1. Read the whole `<table>` block first. Note per-column alignment, any
   conditional cell rendering, and row actions.
2. One column entry per `<th>`, in order. `align: 'end'` wherever the original
   had `text-end`; add `numeric: true` if the value is signed or a percentage.
3. Move the `colSpan` empty row to the `empty` prop. Delete the hand-counted
   `colSpan` — the component derives it.
4. Move a `<tfoot>` to `footer` as `[{ span, content, align, numeric }]`.
5. **Do not trust line numbers from `awk` across multiple files.** `NR` does not
   reset between files. Assert the block you are replacing starts with `<table`
   and ends with `</table>` before writing.
6. Run lint (`no-undef` catches constants you renamed by accident), then look at
   the screen in both directions.

**Do not migrate** `cp/PDFLayout.jsx` — those tables render the printed document
preview, which has its own layout rules and no dark mode.

---

## States

Every list, table and widget needs four:

- **loading** — skeletons shaped like the real content, not a bare spinner, so
  the layout does not jump when data arrives
- **empty** — `EmptyState`, with the primary action in it
- **error** — `toUserMessage(err)`, never `err.message`. Raw Postgres text tells
  the user nothing and leaks schema detail
- **no permission** — `NoModuleAccess`, never a silent redirect. A user sent to
  the dashboard with no explanation cannot tell that from a broken feature

---

## Errors

```jsx
import { toUserMessage } from '../lib/errorMessage'
toast.error(toUserMessage(err))
```

It maps Postgres classes to human copy in both languages and **passes through**
anything the app raised deliberately — a `RAISE EXCEPTION` or an Edge Function
response is already written for a person.

---

## Colour

Tokens live in `src/styles/tokens.css`. There are still 2,365 raw hex values in
markup; a lint rule stops the count growing. When you touch a component, prefer
a token over adding another hex.

Dark mode exists and is in scope but has never been audited. If you add a
surface colour, add its dark variant in the same change.

---

## Before you call it done

- Rendered in **English and Arabic**
- Rendered at **mobile width** (390px); wide tables scroll in their own wrapper,
  never the page
- Every interactive element reachable by keyboard, with visible focus
- `npm run lint` clean, `npm run lint:ui` no higher than it was
