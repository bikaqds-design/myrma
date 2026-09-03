# Dark mode audit

Dark mode was in scope from 2026-09-02 and had never been examined. Audited
2026-09-03 against 16 routes in both directions, plus three sub-screens, with a
measured WCAG contrast pass.

---

## Headline: dark mode is in good shape

I expected this to be the largest liability left in the UI. It is not.

| measure | result |
|---|---|
| Routes rendering correctly in dark | **32 of 32** (16 routes × 2 directions) |
| Large light surfaces on a dark page | **0** |
| AA contrast failures, dark | **18** distinct |
| AA contrast failures, light (control) | **16** distinct |

**Dark mode adds 2 net contrast failures over light.** That is near-parity, and
it is not what a partially-implemented dark mode looks like.

### A measurement of mine that was wrong

A static scan counted **1,086 light-only colour utilities** across 56 files —
class lists setting `bg-white`, `text-gray-900` and similar with no `dark:`
variant in the same string. That number is misleading and should not be quoted.

Tailwind dark variants are frequently on a **parent** element, so a per-className
check cannot see them. The rendered reality disproves the static count:
`Inventory/WarehousesTab.jsx`, the worst file at 97 light-only utilities, shows
**zero** light surfaces when actually rendered in dark mode.

The lesson is the same one the codemod verification taught: measure the rendered
page, not the source.

---

## Findings

| ID | Issue | Severity | Effort |
|----|-------|----------|--------|
| ✅ UX-DARK-001 | Appearance settings are global, not per user | High | **CLOSED** |
| UX-DARK-002 | Dark mode never follows the operating system | Medium | S |
| ✅ UX-DARK-003 | An 88 KB config blob is fetched on every app mount | Medium | **CLOSED** |
| UX-DARK-004 | Knowledge Center muted text fails AA in dark only | Low | S |
| UX-GLOBAL-018 | Notification badge fails AA in **both** modes | Medium | S |

### ✅ UX-DARK-001 — Appearance settings are global (High) — CLOSED

`rmaConfig.set` upserts on `config_key` alone:

```ts
.upsert({ config_key, config_value, updated_by: userEmail }, { onConflict: 'config_key' })
```

`rma_config` has no `user_email` column; `userEmail` is recorded only as
`updated_by`. So `appearance_settings` is **one row for the whole system**.

One person turning on dark mode turns it on for every user. The same applies to
font family, date format and the rest of the appearance block. On a multi-user
CRM this is a real defect, not a preference — a technician changing their theme
silently changes the finance team's.

This is also why the first capture run of this audit produced entirely light
screenshots while claiming dark mode was on: the context fetches this global row
on mount and overwrites whatever was set locally. The audit had to intercept
that request to measure anything.

**Fixed.** No migration was needed — a `user_preferences` table already existed,
unused, with the right shape, RLS scoping every policy to
`user_email = rma_current_user_email()`, and a unique index for upsert.

The fix is a split by what each setting *is*, not by who may change it:

| personal (`user_preferences.prefs.appearance`) | company (`rma_config`) |
|---|---|
| `darkMode`, `fontFamily`, `tableDensity`, `sidebarCompact`, `dateFormat`, `timeFormat` | `faviconUrl`, `loginBg`, `tabTitle` |

The company row is kept as the **org default** rather than emptied, and personal
values layer on top — resolution is `DEFAULT -> company -> personal`. Nothing
changes for anyone on first load, no backfill is required, and an admin setting
the house date format still sets it for everyone who has not chosen their own.

Verified end to end against production with two throwaway accounts: user A
enabled dark mode, user B was unaffected, and the company row still reads
`darkMode: false` — A's choice did not leak into it.

### UX-DARK-002 — Never follows the OS (Medium)

`darkMode: 'class'` with `html.classList.toggle('dark', !!s.darkMode)` and a
default of `false`. There is no `prefers-color-scheme` handling anywhere in
`src/`. Someone whose system is set to dark gets a light app until they find the
toggle — and, per UX-DARK-001, flipping it changes everyone else's too.

### ✅ UX-DARK-003 — 88 KB fetched on every mount (Medium) — CLOSED

The `appearance_settings` row's `config_value` was **88,788 characters**, read on
every app mount before first paint, by every user.

It was the favicon: a 66 KB PNG inlined as a base64 data URI. `handleFaviconUpload`
read the file with `FileReader.readAsDataURL` and stored the result in the config
row, with a 1 MB size allowance — so that row could have carried megabytes.

**Fixed.** Favicons now upload to Supabase Storage under `branding/`, beside the
logo, which already worked this way; only the URL is stored. `uploadFavicon`
sets a one-year `cacheControl`, so the browser fetches the image once instead of
re-reading it inside the config on every mount.

The existing favicon was migrated in place: decoded from the data URI, uploaded,
and confirmed byte-identical (66,396 bytes both sides) and reachable **before**
the config row was touched — a failure at any point would have left the working
favicon alone.

| | before | after |
|---|---:|---:|
| `appearance_settings` row | 88,788 chars | **354 chars** |

All nine appearance keys intact, and the favicon verified still rendering from
the storage URL after a reload.

### UX-DARK-004 — Knowledge Center muted text (Low)

`rgb(108, 114, 128)` (gray-500) at 11px on the dark surface measures **3.69:1**
against a 4.5:1 requirement. Affects file metadata lines such as
`24G42E leaflet LQ.pdf · 1071 KB · 2 pages`. Dark-only; the light equivalent
passes.

### UX-GLOBAL-018 — Notification badge (Medium, not a dark-mode issue)

White 10px text on the red count badge measures **3.76:1** against 4.5:1. It
fails identically in light and dark, on every route, so it is filed as a global
finding rather than a dark one. It is the single most repeated contrast failure
in the app — 15 of the 16 per-route failures in each mode are this one badge.

---

## Coverage and gaps

**Covered:** 16 top-level routes, LTR and RTL, at 1440×900; three sub-screens
(Inventory → Warehouses, Products → Hierarchy, Control Panel → Users).
Screenshots in `design/audit/screens-dark/`.

**Not covered, and worth stating plainly:**

- **Modals and drawers.** Most are behind an interaction the sweep did not
  perform. `Products/_modals.jsx` (60 light-only utilities) and
  `Inventory/ProductDetailModal.jsx` (40) are unexamined in dark.
- **Mobile in dark.** Captures were desktop-width only.
- **`RMATracker.jsx`** (52 light-only utilities) is the public customer tracker.
  It may be deliberately light — it is a customer-facing page, not staff UI —
  but nobody has decided that on purpose.
- **`PDFLayout.jsx` and `PrintLabel.jsx`** are correctly light: printed output.
