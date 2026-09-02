# Phase 1 — Summary

Commit `2d8c17d` · 2026-09-02

## The headline

This codebase is **not** the mess the brief anticipated. There is no paradigm
war: one styling system (Tailwind), one component kit (`ui.jsx`, 17 primitives,
66 importers), one token file, one i18n setup with 4,000 translated keys, and a
working RTL root. Someone built the right foundation.

**The problem is that the foundation is bypassed.** Every serious finding below
is an adoption gap, not an absence:

- A token file with 52 properties — and 125 hardcoded hex colours beside it.
- A `Button` component — used 57% of the time.
- A bidi-isolation component written *specifically* to fix a known Arabic
  number-rendering bug — used 6 times.
- An `EmptyState` component — used in 14 of 115 page files.

That changes the shape of the work. This is a **migration and enforcement**
engagement, not a redesign. The highest-value output is not new components; it
is codemods plus lint rules that stop the drift returning.

## Status

**18 of 38 closed. All 6 Criticals and 5 of 9 Highs.**
Remaining: 0 Critical, 4 High, 12 Medium, 4 Low.

| Closed | in |
|---|---|
| UX-AUTH-002, -003, -004, UX-DASH-001, -002, UX-GLOBAL-010, -011, -013 | `c543dee` |
| UX-AUTH-001, UX-ONBOARD-001, -002, -003, UX-GLOBAL-003 | `e49bde5` |
| UX-AUTH-005, UX-GLOBAL-005, -014, -015 | `18e6ed5` |
| UX-GLOBAL-004 (585 physical properties -> 0) | this commit |

Every Critical was an Arabic/RTL defect, and every one of them reduced to the
same root cause: **English prose sitting inside an RTL container.** The bidi
symptoms — `?Forgot password`, `!Welcome to myCRM`, `.minutes` — were terminal
punctuation attaching to the paragraph direction. Translating the strings
removed the symptom along with the cause. No bidi wrapper was needed for any of
them.

UX-GLOBAL-003 was mis-scoped when raised. It claimed every number, currency,
SKU, serial and ID needed isolation; the Arabic accounting screen disproves that
— `80.00`, `8,000.00` and `PAY-2026-00011` all render correctly. Only signed
values break, and the dashboard delta was the only signed-value display in the
codebase.

## Remaining top issues — all effort `L`

The five left are the codemod and multi-day items. Nothing quick remains.

| # | ID | Issue | Sev | Why it is L |
|---|---|---|---|---|
| 1 | UX-GLOBAL-007 | No Table primitive; 72 raw `<table>` in 50 files | High | Build the component, then migrate 72 call sites |
| 2 | UX-GLOBAL-008 | Kit adoption 29–57% | High | ~250 hand-rolled controls to migrate |
| 3 | UX-GLOBAL-001 | 2,362 raw hex values | High | Needs the semantic token set defined first, with a dark value per role |
| 5 | UX-GLOBAL-006 | 101 of 115 page files have no empty state | High | Per-screen copy and a primary action each |

Both guarded classes (001, 004) are held by lint rules, so they cannot grow
while they wait.

## The guard rails

Three ESLint rules now cover the drift classes the audit found, landed before
the codemods they protect:

| Rule | Current count |
|---|---:|
| Physical CSS properties in className | **0** |
| Raw hex in className | 2,365 |
| Hardcoded user-visible JSX text | 36 |
| **Total (ratchet in `lint:ci`)** | **2,401** |

`npm run lint:ui` reports the breakdown. The number can fall and never rise;
when it reaches zero the rules become errors. That 36 is the honest measure of
how well translated this codebase already was — the problem was never coverage,
it was the two screens that never joined the system.

## Systemic root causes

1. **Nothing enforces the design system.** No lint rule against raw hex, physical
   CSS properties, or bare `<button>`. Every fix decays without a guard.
2. **The pre-auth screens were never brought into the i18n system.** Login and
   ResetPassword predate or bypassed it. They are also the highest-visibility
   screens in the product.
3. **Bidi correctness was solved once and never propagated.** The fix exists with
   a comment citing the QA that found it; adoption stopped at 6 call sites.
4. **Page components grew past the point of reuse.** At 1,500–2,000 lines
   (`Reports.jsx`, `CustomerDetails.jsx`, `RMATickets/index.jsx`), copying markup
   is cheaper than extracting a component — so the kit stops being used.
5. **Permission *enforcement* is sound; permission *communication* is absent.**
   Nav filtering is correct per role and a viewer cannot reach the Control Panel
   — but they are redirected with no message rather than told why.
6. **Documentation actively misleads.** `CLAUDE.md` describes a Base44 platform
   and a `hasPermission` API that no longer exist. Any developer — or agent —
   following it writes wrong code.

## Quick wins (Critical/High + effort `S`)

Roughly a day, all independently shippable:

| ID | Fix |
|---|---|
| UX-AUTH-002 | Translate the invitation screen (~12 strings) |
| UX-AUTH-004 | `dir="ltr"` on email/password/phone/serial inputs |
| UX-AUTH-003 | Collapse three taglines to one |
| UX-DASH-001 | Translate the date-range chips |
| UX-DASH-002 | Wrap dashboard deltas in `<Ltr>` |
| UX-GLOBAL-010 | Toast position follows direction |
| UX-GLOBAL-011 | `toastOptions` on the app-shell Toaster |
| UX-GLOBAL-013 | Delete the two empty `ui/` directories |

## Recommended sequencing

**Do not start with Phase 2 (design tokens).** The tokens already exist. Starting
there produces a second token system beside an ignored one.

1. **Quick wins above** — a day, closes 2 Criticals.
2. **Phase 6 first, partially: the guard rails.** ESLint rules against raw hex,
   physical CSS properties, and hardcoded JSX strings. Land these *before* the
   codemods, so the cleanup cannot regress. This is the highest-leverage step in
   the whole engagement.
3. **Phase 2, reduced to reconciliation** — audit the existing 52 tokens, fill
   gaps, add the z-index ladder. Not a new system.
4. **Phase 3, component normalisation** — highest value is the missing **Table**
   (72 call sites) and lifting Button/Input/Select adoption. This is where the
   engagement's bulk sits.
5. **Phase 4, module redesign** — order by daily use: **RMA → Inventory → Sales
   Funnel → Purchases → Dashboard**. RMA first because it is a counter workflow
   where seconds matter and it is the product's origin.
6. Phases 5, 7, 8, 9 as written.

## What I have not established

ND-1 is resolved: 60 authenticated screenshots were captured across 5 roles, so
the blocker is gone. What remains unfinished is the **per-screen** analysis for
14 of 16 modules — information hierarchy, and the click/keystroke baseline for
the top task in each, which the Definition of Done requires. That is reading and
counting against 60 captured screens, not a tooling problem, and is the natural
content of the next session.

Also outstanding: the ~12 Control Panel sub-tabs and all `:id` detail routes
(they need deliberately chosen seed records), and RTL/mobile for the four
non-admin roles — only the admin matrix is complete in all three viewports.

No accessibility, performance or bundle measurement yet; those are Phases 6 and 7
and I did not pre-empt them.
