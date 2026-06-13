# myRMA — Improvement Plan

**Last updated:** 2026-06-13
**Sources:**
- `GUARD_SKILL_TEST_REPORT.md` — clean-code-guard + test-guard + docs-guard audit (2026-06-12 re-audit)
- `COMPETITIVE_ANALYSIS.md` — feature-gap + UX audit (2026-06-06)

**Rule:** Update Status in this file as items ship. Evidence, fix details, and competitor rationale stay in the source documents.

---

## How to use this file

**Status vocabulary:** `Open` · `In Progress` · `Shipped` · `Dropped`

**Priority vocabulary:**
- **P0** — correctness/security risk or revenue-blocking gap; fix before next feature
- **P1** — high-value, should be next sprint
- **P2** — worthwhile, not urgent
- **P3** — polish / nits

**IDs are immutable.** Never renumber, reuse, or delete a row — shipped/dropped rows remain as record.
Tables are sorted by priority (P0 first), then ID. Status changes append a Changelog line with the date.

---

## Now / Next / Later

### Shipped (Phase 1 + Phase 2 + Phase 3)

- **CQ-01** — Break up `handleSubmit` god-function ✅
- **CQ-02** — `ticketComments.create()` DTO ✅
- **CQ-03** — Narrow catch-all error handlers ✅
- **CQ-04** — `serialHistory.getBySerial()` → server-side RPC ✅
- **CQ-06** — Fix `sendBatch` index invariant ✅
- **CQ-08** — Wire `captureException` into fire-and-forget catches ✅
- **CQ-09** — Delete `toWhatsAppParams` dead code ✅
- **CQ-10** — Delete `validateConfig()` unused method ✅
- **CQ-11** — Extract `sendTicketAssignedEmail` helper ✅
- **CQ-12** — Extract `ActivityTimeline` component ✅
- **CQ-13** — Activity timeline i18n pipe format ✅
- **CQ-14** — Add `db.ticketActivity.log()` shared helper ✅
- **TS-01** — Fix COMPLETED status in constants test ✅
- **DOC-02, DOC-07, DOC-09, DOC-11** — Docs fixes ✅
- **DOC-03** — Fix i18n file path in CLAUDE.md ✅
- **DOC-05** — Add `vitest include` filter + `pool: 'forks'` ✅
- **UX-02** — Role-aware dashboard widgets ✅
- **TS-02** — Delete `typeof` type-system assertion ✅
- **TS-03** — `test.each` for status/priority/role loops ✅
- **UX-04** — Customer name blur validation ✅

### Shipped (Phase 5)

- **CQ-05** — Extract step helpers from `ticketEventHandlers.ts` ✅
- **UX-05** — Ticket kanban view ✅
- **UX-03** — Sidebar grouping (Dropped by user request)

### Shipped (Phase 6)

- **CQ-15** — Rename `fmt`/`inp`/`lbl`, delete dead `title` prop ✅
- **UX-06** — Keyboard shortcuts + `?` help panel ✅
- **CQ-07** — Missing sentinel (Deferred — touches 15+ call sites across 5 files)

### Next (Phase 7 candidates)

- **CQ-07** — Remove `{ missing: boolean }` sentinel (full sweep — inventory.ts, system.ts, whatsappNotifications.ts + all consumers)
- **UX-07** — WCAG AA accessibility audit + fix critical violations
- **FT-06** — SMS notifications via Twilio (reuses existing notification_queue pattern)

### Later (backlog)
- **FT-01** — Customer return initiation portal (highest-impact remaining feature gap)
- **FT-02** — Payment processing / POS (blocks closing the repair loop)
- **FT-03** — Public REST API + developer docs (required for B2B sales)
- **FT-04** — Native mobile app (technician workflow gap vs. RepairDesk)

---

## Track CQ — Code Quality

> Source: `GUARD_SKILL_TEST_REPORT.md` → clean-code-guard sections C-1..C-4, I-1..I-7, N-1..N-3, Nits

| ID | Title | Priority | Effort | Status | Source | Where |
|----|-------|----------|--------|--------|--------|-------|
| CQ-01 | Break up `handleSubmit` god-function (385 lines, cyclomatic ≥25) | P0 | High | Shipped | GUARD → C-1 | `TicketForm.jsx:224–609` |
| CQ-02 | Refactor `ticketComments.create()` from 8 positional params to DTO | P0 | Low | Shipped | GUARD → C-2 | `tickets.ts:158–167` |
| CQ-03 | Narrow catch-all handlers to specific error codes (8 occurrences) | P0 | Medium | Shipped | GUARD → C-3 | `tickets.ts`, `users.ts` |
| CQ-04 | Fix `serialHistory.getBySerial()` full-table client-side fetch | P0 | Medium | Shipped | GUARD → C-4 | `tickets.ts:249–264` |
| CQ-06 | Fix `sendBatch` fragile index invariant | P1 | Low | Shipped | GUARD → I-2 | `MessagingService.ts:57` |
| CQ-08 | Replace silent `.catch(() => {})` with `captureException` | P1 | Low | Shipped | GUARD → I-4 | `TicketForm.jsx` (~15 sites), `TicketDrawer.jsx` |
| CQ-09 | Delete `toWhatsAppParams` dead code | P1 | Low | Shipped | GUARD → I-5 | `TemplateEngine.ts:95` |
| CQ-10 | Delete `validateConfig()` unused method | P1 | Low | Shipped | GUARD → I-6 | `WhatsAppProvider.ts:28` |
| CQ-11 | Extract `createTicketNotification` helper (3 identical notification blocks) | P1 | Low | Shipped | GUARD → I-7 | `TicketForm.jsx:332–383` |
| CQ-12 | Extract `ActivityTimeline` component from ~100-line IIFE | P1 | Medium | Shipped | GUARD → N-1 | `TicketDrawer.jsx:958–1059` → `ActivityTimeline.jsx` |
| CQ-13 | Fix activity timeline i18n (plural count + stored-English details in DB) | P1 | Medium | Shipped | GUARD → N-2 | `TicketDrawer.jsx:1013,1068` + logActivity call sites |
| CQ-14 | Add shared `db.ticketActivity.log()` helper (3 copies of insert shape) | P1 | Low | Shipped | GUARD → N-3 | `tickets.ts`, `TicketDrawer.jsx`, `TicketForm.jsx` |
| CQ-05 | Extract numbered-step blocks in `ticketEventHandlers.ts` into named helpers | P2 | Medium | Shipped | GUARD → I-1 | `ticketEventHandlers.ts:46–152` |
| CQ-07 | Remove `{ missing: boolean }` sentinel from API return types | P2 | Medium | Open | GUARD → I-3 | `tickets.ts:142`, `users.ts:194` |
| CQ-15 | Nits bundle: rename `fmt`→`formatDate`, `inp`/`lbl`→`inputClass`/`labelClass`, `logAct`→`logActivityChange`; delete `title` dead prop; delete paraphrasing comments | P3 | Low | Shipped | GUARD → Nits | `_utils.js:58`, `TicketForm.jsx:29–31,258,268,303,616` |

---

## Track TS — Tests

> Source: `GUARD_SKILL_TEST_REPORT.md` → test-guard section

| ID | Title | Priority | Effort | Status | Source | Where |
|----|-------|----------|--------|--------|--------|-------|
| TS-01 | Fix `COMPLETED` status missing from constants test (7th status not covered) | P0 | Low | Shipped | GUARD → constants.test.js analysis | `constants.test.js` — `defines the six canonical statuses` |
| TS-02 | Delete `typeof STORAGE_KEY.APPEARANCE === 'string'` type-system test | P1 | Low | Shipped | GUARD → Rule 7+4 | `constants.test.js` |
| TS-03 | Convert `for` loops in schemas tests to `test.each` | P1 | Low | Shipped | GUARD → Rule 3 | `schemas.test.js` — ticket_status, priority, roles loops |
| TS-04 | Merge `null`/`undefined` permission tests into one `test.each` | P2 | Low | Open | GUARD → Rule 3 | `permissions.test.js` |
| TS-05 | Consolidate 5 `canDo with default permissions` blocks into `test.each` | P2 | Low | Open | GUARD → Rule 3 | `permissions.test.js:161–180` |
| TS-06 | Convert multi-assert `it()` blocks in constants tests to `test.each` | P2 | Low | Open | GUARD → Rule 3 | `constants.test.js` — ROLES, PRIORITY, INVENTORY_STATUS, etc. |
| TS-07 | Rename 4 test names to describe scenario not structure | P3 | Low | Open | GUARD → Rule 5 | `constants.test.js` |
| TS-08 | Add `TemplateEngine` unit tests (conditional block rendering, substitution) | P2 | Medium | Open | GUARD → Coverage gaps | New file in `src/test/` |
| TS-09 | Add `generateRmaNumber()` tests (collision logic, serial padding) | P2 | Low | Open | GUARD → Coverage gaps | New file in `src/test/` |
| TS-10 | Add `auditInsert()` retry tests using `vi.useFakeTimers()` | P2 | Medium | Open | GUARD → Coverage gaps | New file in `src/test/` |
| TS-11 | Add `getStatusColor()`/`getPriorityColor()` fallback tests | P3 | Low | Open | GUARD → Coverage gaps | New file or `constants.test.js` |
| TS-12 | Add `useURLTab` hook tests (empty→delete-param, pushHistory replace-vs-push) | P2 | Low | Open | GUARD → Coverage gaps (added 2026-06-12) | New file — `renderHook` + `MemoryRouter` |

---

## Track DOC — Documentation

> Source: `GUARD_SKILL_TEST_REPORT.md` → docs-guard sections (README/CLAUDE/AGENTS/DESIGN pass + CONSTITUTION/AUDIT_LOG pass)

| ID | Title | Priority | Effort | Status | Source | Where |
|----|-------|----------|--------|--------|--------|-------|
| DOC-01 | Fix `.js` → `.ts` extensions in AGENTS.md module table | P0 | Low | Dropped | GUARD → docs-guard Rule 1 | Pre-existing correct — TypeScript conversion (2026-06-03) already fixed all 9 entries |
| DOC-02 | Fix `.js` → `.ts` in README.md data flow + add missing `whatsappNotifications.ts` + 3 Edge Functions to tree | P0 | Low | Shipped | GUARD → docs-guard Rule 1 | `README.md:253,194,233` |
| DOC-03 | Fix i18n path: `src/i18n.js` → `src/lib/i18n.js` in CLAUDE.md | P0 | Low | Shipped | GUARD → docs-guard Rule 1 | `CLAUDE.md:164` |
| DOC-04 | Resolve design token contradiction: sync DESIGN.md hex values to CLAUDE.md | P0 | Low | Dropped | GUARD → docs-guard Rule 1 | Pre-existing correct — token tables match exactly |
| DOC-05 | Add `include` filter to Vitest config to fix test doubling from worktree | P0 | Low | Shipped | GUARD → docs-guard Rule 3 | `vite.config.js` test config + update counts in README/CLAUDE/AGENTS |
| DOC-11 | Fix CONSTITUTION.md §13.1 Directory Map — add 3 missing Edge Functions | P0 | Low | Shipped | GUARD → docs-guard Rule 1+3 | `CONSTITUTION.md:~1246–1250` |
| DOC-12 | Fix CONSTITUTION.md §12.1 Naming table (.js→.ts in extension column) | P0 | Low | Dropped | GUARD → docs-guard Rule 1 | Pre-existing correct — table already shows `.ts` for all TypeScript modules |
| DOC-06 | Remove CI badge placeholder or replace with real repo URL | P1 | Low | Dropped | GUARD → docs-guard Rule 5 | Pre-existing correct — no badge placeholder in README |
| DOC-07 | Remove redundant `--legacy-peer-deps` flag (already in .npmrc) | P1 | Low | Shipped | GUARD → docs-guard Rule 7 | `CLAUDE.md:334`, `AGENTS.md:335` updated; README install cmd was already clean |
| DOC-08 | Add i18n/RTL section to AGENTS.md (entirely missing) | P1 | Medium | Dropped | GUARD → docs-guard Rule 8 | Pre-existing correct — full i18n/RTL section already present at AGENTS.md:157–193 |
| DOC-09 | Remove SPECKIT stubs from CLAUDE.md | P1 | Low | Shipped | GUARD → docs-guard Rule 10 | `CLAUDE.md:336–339` removed; AGENTS.md had no stub |
| DOC-10 | Verify and sync `QueueJob` export in AGENTS.md vs CLAUDE.md | P2 | Low | Open | GUARD → docs-guard Worth noting | `AGENTS.md:208`, `CLAUDE.md:222` |
| DOC-13 | Fix AUDIT_LOG.md i18n path in 2026-06-05 entry | P0 | Low | Dropped | GUARD → docs-guard Rule 1 | Pre-existing correct — `src/lib/i18n.js` already correct at AUDIT_LOG.md:1310 |
| DOC-14 | Add 3 missing Edge Functions to CONSTITUTION.md §7.4 | P1 | Low | Dropped | GUARD → docs-guard Rule 1 | Pre-existing correct — §7.4 already lists all 6 functions + ai-assist |
| DOC-15 | Fix CONSTITUTION.md §16.3 CI test count: 74 → 80 | P1 | Low | Dropped | GUARD → docs-guard Rule 1 | Pre-existing correct — §16.3 already reads `80 unit tests` |
| DOC-16 | Mark MFA / replacement / i18n as Shipped in COMPETITIVE_ANALYSIS.md §3 | P1 | Low | Dropped | GUARD → docs-guard Rule 3 | Pre-existing correct — all three already marked ✅ Shipped in §3 |
| DOC-17 | Add note in AUDIT_LOG.md C-1 entry: `poolOptions` refined to `fileParallelism: false` | P2 | Low | Open | GUARD → docs-guard Rule 3 | `AUDIT_LOG.md:~601` |
| DOC-18 | Update GUARD_SKILL_TEST_REPORT.md header: `107/107` → `80/80` with note | P2 | Low | Open | GUARD → docs-guard Worth noting | `GUARD_SKILL_TEST_REPORT.md:11` |

---

## Track FT — Features

> Source: `COMPETITIVE_ANALYSIS.md` §3 Missing Features Report + §5 Product Roadmap

| ID | Title | Priority | Effort | Status | Source | Notes |
|----|-------|----------|--------|--------|--------|-------|
| FT-01 | Customer return initiation portal (customers submit own RMAs, no login) | P0 | Medium | Open | COMP §3/§5 #15 | Highest-impact remaining gap; blocks scaling intake |
| FT-02 | Payment processing / POS (Stripe invoice payment links + in-app collection) | P0 | Med-Hard | Open | COMP §3/§5 #9 | Required to close the repair loop; drives churn without it |
| FT-03 | Public REST API + developer documentation | P0 | Medium | Open | COMP §3/§5 #16 | Blocks all B2B integration; no enterprise sales without it |
| FT-04 | Native mobile app (React Native / Expo) | P0 | Hard | Open | COMP §3/§5 #17 | Technician workflow gap vs. RepairDesk; target iOS first |
| FT-05 | Full customer self-service portal (ticket history, comments, quote approval) | P1 | Medium | Open | COMP §3/§5 #8 | Reduces inbound tickets 30–40% |
| FT-06 | SMS notifications via Twilio | P1 | Easy | Open | COMP §3/§5 #10 | Reuses notification_queue + send-whatsapp pattern; universal channel |
| FT-07 | Warranty validation engine (rule-based auto-flag) | P2 | Medium | Open | COMP §3/§5 #20 | Removes manual warranty status entry |
| FT-08 | Parts supplier integration | P2 | Hard | Open | COMP §3 | RepairDesk differentiator; context-switch elimination |
| FT-09 | Admin impersonation (view-as-user for support) | P2 | Easy | Open | COMP §3 | Standard in Freshdesk, Zendesk, Salesforce |
| FT-10 | Knowledge base / FAQ tied to public tracker portal | P2 | Easy | Open | COMP §3 | Deflects repeat "what's my status?" calls |
| FT-S1 | MFA / TOTP | — | — | Shipped | COMP §3/§5 #2 | Supabase TOTP on login + Account Settings |
| FT-S2 | Session management UI (active sessions + force-logout) | — | — | Shipped | COMP §3/§5 #3 | Account Settings |
| FT-S3 | Replacement / exchange RMA workflow | — | — | Shipped | COMP §3/§5 #12 | Exchange + credit note outcome |
| FT-S4 | Credit notes / refund workflow | — | — | Shipped | COMP §5 #19 | Credit note generation |
| FT-S5 | Barcode / QR code scanner | — | — | Shipped | COMP §3/§5 #11 | Browser camera API, IMEI scan |
| FT-S6 | AI ticket assist (summarize + suggest next action) | — | — | Shipped | COMP §5 #18 | NVIDIA NIM / Llama 3.3 70B |
| FT-S7 | pg_cron scheduled notifications (overdue + SLA breach) | — | — | Shipped | COMP §3/§5 #1 | Daily 08:00 UTC + every-2-min queue drain |
| FT-S8 | Report builder (date-range, CSV/Excel export) | — | — | Shipped | COMP §5 #13 | All major entities |
| FT-S9 | Onboarding wizard (5-step dismissible) | — | — | Shipped | COMP §5 #14 | New account setup |
| FT-S10 | Multi-language / RTL support (Arabic + English) | — | — | Shipped | COMP §3/§5 #21 | react-i18next, 200+ keys |

---

## Track UX — UX Improvements

> Source: `COMPETITIVE_ANALYSIS.md` §4 UX Audit

| ID | Title | Priority | Effort | Status | Source | Notes |
|----|-------|----------|--------|--------|--------|-------|
| UX-01 | Mobile-first ticket view (tap targets, swipe actions, camera attachment) | P0 | Hard | Open | COMP §4 Mobile | Not mobile-first; technicians work at benches |
| UX-02 | Role-aware dashboard widgets (technician vs. manager views) | P1 | Medium | Shipped | COMP §4 Dashboard | "My Open Tickets" panel for technician/viewer roles |
| UX-03 | Sidebar navigation grouping (Service, Customers, Operations, Admin sections) | P1 | Medium | Dropped | COMP §4 Sidebar | 14+ flat items; discovery slow for new users |
| UX-04 | Form validation on blur (real-time field errors before submit) | P1 | Low | Shipped | COMP §4 Forms | Zod wired but errors appear only post-submit |
| UX-05 | Ticket status workflow view (kanban or stage-pipeline, block illegal transitions) | P1 | Medium | Shipped | COMP §4 Status | No visual transition diagram |
| UX-06 | Keyboard shortcuts + `?` shortcut menu (`N`=new ticket, `Esc`=close, `Cmd+K`) | P2 | Easy | Shipped | COMP §4 Keyboard | Power user gap |
| UX-07 | WCAG AA accessibility audit + fix critical violations | P2 | Medium | Open | COMP §4 Accessibility | axe-core runs in dev; no production audit done |
| UX-08 | Table pagination controls ("Showing X–Y of Z" + server-side above 500 rows) | P2 | Low | Open | COMP §4 Pagination | 5,000-row client cap with no visible controls |
| UX-09 | Direction B token sweep — finish remaining pages (Invoices, PartsInventory) | P2 | Low | Open | COMP §4 Consistency | Some pages still use old Tailwind grays |
| UX-10 | Notification center improvements (mark-all-read, grouping by type, history page) | P3 | Low | Open | COMP §4 Notifications | Polish item |
| UX-S1 | Skeleton loaders (replace full-page spinner) | — | — | Shipped | COMP §4 Loading | P2-3 — `Skeleton.jsx` |
| UX-S2 | Breadcrumb navigation | — | — | Shipped | COMP §4 Breadcrumb | P2-2 — `Breadcrumb.jsx` |
| UX-S3 | Unified comment / activity timeline | — | — | Shipped | COMP §4 Timeline | P2-4 — `TicketDrawer.jsx` unified tab |
| UX-S4 | Empty states (contextual + CTA) | — | — | Shipped | COMP §4 Empty states | 5 pages |
| UX-S5 | Inline ticket actions (status/priority dropdowns in list row) | — | — | Shipped | COMP §4 List density | Ticket list inline controls |
| UX-S6 | Global `Cmd+K` search (tickets + products + customers) | — | — | Shipped | COMP §4 Global search | Command palette |

---

## Horizon (6–12 months)

> Direction markers — not yet plannable work items. No priority/effort/status.

| ID | Title | Why it matters | Source |
|----|-------|----------------|--------|
| H-1 | Multi-tenancy / workspaces | Required for white-label reselling, franchise chains, and any per-org data isolation | COMP §5 #22 |
| H-2 | Supplier / vendor portal | OEMs + suppliers log in, see claims, approve/reject repairs — Claimlane's primary differentiator; path to enterprise pricing | COMP §5 #23 |
| H-3 | SSO / SAML integration (Okta, Entra, Google Workspace) | Non-negotiable checkbox in enterprise RFPs | COMP §5 #24 |
| H-4 | AI disposition engine (repair / replace / recycle / refurbish suggestion) | Premium differentiator; defect photo + cost + age + warranty → best outcome | COMP §5 #25 |
| H-5 | SOC2 Type II certification | 12-month process; required for enterprise, healthcare-adjacent, government service centers | COMP §5 #26 |
| H-6 | Parts supplier marketplace (regional supplier API / PO automation) | MENA: local distributor APIs; removes context-switch for technicians ordering parts | COMP §5 #27 |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-06-12 | Initial population — 75 items across CQ (15), TS (12), DOC (18), FT (10 open + 10 shipped), UX (10 open + 6 shipped), Horizon (6) |
| 2026-06-13 | Phase 1 shipped: CQ-01, CQ-03, TS-01, DOC-03, DOC-05. Phase 2 shipped: CQ-08, CQ-12, CQ-14, UX-02. Updated Now/Next/Later section. |
| 2026-06-13 | Group 1 doc fixes: DOC-02, DOC-07, DOC-09, DOC-11 shipped. DOC-01/04/06/08/12/13/14/15/16 dropped (pre-existing correct from 2026-06-03 TypeScript conversion). |
