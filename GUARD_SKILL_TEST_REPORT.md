# Code Review: myRMA 2.0 — `src/` (full codebase pass)
**Date:** 2026-06-12 *(re-audit — previous pass 2026-06-08)*
**Skill:** clean-code-guard (review mode)
**Scope:** Full `src/` directory · all 2026-06-08 findings re-verified · new code since then reviewed (P2-4 activity timeline, `useURLTab` rewrite, Reports tab fix)

---

# Test Guard Report: myRMA 2.0 — `src/test/`
**Date:** 2026-06-12 *(re-audit — previous pass 2026-06-08)*
**Skill:** test-guard (review mode)
**Runner:** Vitest 4.1.7 · **Environment:** jsdom · **Result:** 80/80 passing ✅ · 3 files · 3.46s

## Summary

The existing tests are clean, well-scoped, and free of mocks — the three test files cover pure functions with real inputs and real assertions. No Rule 1, 2, or 8 violations (the "must fix" category). The issues that exist are in Rules 3, 4, 5, and 7 — bloat and weak test names that make failures harder to diagnose. The `resolvePermissions` regression suite is excellent and should be treated as sacred (Rule 6). Notable gap: `TemplateEngine.ts` and `generateRmaNumber()` have complex logic and zero test coverage.

### Re-audit status (2026-06-12)

All three test files are unchanged since 2026-05-31 (verified by file timestamps), so **every finding below remains open** — none of the Rule 3/4/5/7 fixes or coverage gaps have been addressed. No new test files have been added since the last pass, despite new logic shipping in the meantime (P2-4 activity timeline, `useURLTab` rewrite). The suite still passes 80/80 with zero mock usage and the `resolvePermissions` regression guard intact. One coverage-gap update: `useURLTab` was rewritten onto React Router's `useSearchParams` — its delete-param-on-empty-value behavior is now testable with `renderHook` + `MemoryRouter` and worth a small suite (added to the gap table below).

---

## Violations by File

### `src/test/constants.test.js`

**Rule 7 + Rule 4 violation** in `constants.test.js::STORAGE_KEY > APPEARANCE and AUDIT_QUEUE are strings`
- **What:** `typeof STORAGE_KEY.APPEARANCE === 'string'` is already guaranteed by the TypeScript type annotation. This test would pass even if you deleted all the app's logic and left only the type declaration. It doesn't catch a real bug.
- **Fix:** Delete this assertion entirely. If you want to guard the *value* (not the type), replace it with: `expect(STORAGE_KEY.APPEARANCE).toBe('myrma_appearance')` (or whatever the actual string is).

---

**Rule 3 violation** in `constants.test.js::ROLES > defines all five roles`
- **What:** Five `toBe()` assertions in one `it()` — same scenario repeated five times. When one fails, you only see "defines all five roles failed," not which role.
- **Fix:** Use `test.each`:
```js
test.each([
  ['SUPER_ADMIN', 'super_admin'],
  ['ADMIN', 'admin'],
  ['MANAGER', 'manager'],
  ['TECHNICIAN', 'technician'],
  ['VIEWER', 'viewer'],
])('ROLES.%s equals %s', (key, expected) => {
  expect(ROLES[key]).toBe(expected)
})
```
Apply the same pattern to `PRIORITY > defines four priorities`, `INVENTORY_STATUS > defines expected values`, `BATCH_STATUS > defines draft/sent/resolved`, `AUTOMATION_ACTION > defines expected action types`, and `CONFIG_KEY > defines expected keys`.

---

**Rule 5 violation** in `constants.test.js` — four test names describe *what*, not *scenario*
- `'defines all five roles'` → `'role string values match DB column names (anti-rename guard)'`
- `'defines expected values'` (INVENTORY_STATUS) → `'inventory status strings match expected DB values'`
- `'defines expected action types'` → `'automation action strings match expected values'`
- `'defines expected keys'` (CONFIG_KEY) → `'config keys match expected setting_key column values'`

---

### `src/test/schemas.test.js`

**Rule 3 violation** in `schemas.test.js::ticketSchema > accepts all valid ticket_status values`
- **What:** A `for` loop inside a single `it()` iterates 6 statuses. If `'On Hold'` fails, the test output just says the whole `it` failed — you can't see which status.
- **Fix:** Use `test.each` so each value gets its own pass/fail row:
```js
test.each(['Open', 'In Progress', 'Pending', 'On Hold', 'Closed', 'Cancelled'])(
  'accepts ticket_status "%s"',
  (status) => {
    expect(ticketSchema.safeParse({ ...valid, ticket_status: status }).success).toBe(true)
  }
)
```
Apply the same to `'accepts all valid priority values'` and `addUserSchema > 'accepts all valid roles'`.

---

### `src/test/permissions.test.js`

**Rule 3 violation** in `permissions.test.js::canDo — permission object lookup > returns false when permissions is null` + `returns false when permissions is undefined`
- **What:** Two near-identical tests differing only by `null` vs `undefined`.
- **Fix:** Merge into one `test.each`:
```js
test.each([null, undefined])(
  'returns false when permissions is %s',
  (permissions) => {
    expect(canDo(ROLES.MANAGER, permissions, 'rma_tickets', 'view_all')).toBe(false)
  }
)
```

---

**Rule 3 violation** in `permissions.test.js::canDo with default permissions` (5 separate `it` blocks, lines 161–180)
- **What:** Five `it` blocks differing only by role/section/action/expected value — maintenance drag.
- **Fix:**
```js
test.each([
  [ROLES.MANAGER,    managerPerms, 'rma_tickets', 'create', true],
  [ROLES.TECHNICIAN, techPerms,    'rma_tickets', 'create', false],
  [ROLES.VIEWER,     viewerPerms,  'rma_tickets', 'create', false],
  [ROLES.MANAGER,    managerPerms, 'products',    'export', true],
  [ROLES.VIEWER,     viewerPerms,  'products',    'export', false],
])(
  'canDo(%s, …, %s, %s) → %s',
  (role, perms, section, action, expected) => {
    expect(canDo(role, perms, section, action)).toBe(expected)
  }
)
```

---

## What's Good (Tests)

1. **Zero mocks** — all three files test pure functions with real inputs and real objects. Rules 2 and 8 fully respected.
2. **`resolvePermissions` regression suite** (`permissions.test.js:62-103`) — named `"manager-can't-create regression guard"`, covers null/empty/partial/override/custom-role edge cases. Sacred — never delete (Rule 6).
3. **Schema tests test project logic, not Zod** — `superRefine` cross-field rules and enum lists from `constants.ts` are your code, not the framework.
4. **Error message assertions use `.toMatch(/regex/)`** not `.toBe('exact string')` — resilient to minor wording changes.
5. **`PRIORITY_WEIGHT` ordering test** — asserts relative ordering, not specific numbers. Correct contract.

---

## Coverage Gaps (no tests exist — worth adding later)

| Module | Why it matters |
|--------|---------------|
| `TemplateEngine.ts` | Static class with regex-based conditional block rendering — complex enough to break silently |
| `generateRmaNumber()` (`_utils.js`) | Date-based + max-serial collision logic; `Math.max(...todaySerials)` path has edge cases |
| `auditInsert()` (`audit.ts`) | Retry-after-600ms + localStorage queue logic — needs `vi.useFakeTimers()` to test deterministically |
| `getStatusColor()` / `getPriorityColor()` (`_utils.js`) | The fallback for unknown status is worth a test |
| `useURLTab` (`hooks/useURLTab.js`) | *(added 2026-06-12)* Rewritten onto `useSearchParams`; the empty/null → param-delete branch and `pushHistory` replace-vs-push behavior are pure contract, testable via `renderHook` inside `MemoryRouter` |

---

## Test Fix Priority Order

| Priority | Finding | File | Effort |
|----------|---------|------|--------|
| 1 | Rule 7+4: Delete typeof-string assertion | `constants.test.js` | Low |
| 2 | Rule 3: Convert for-loops to `test.each` | `schemas.test.js` | Low |
| 3 | Rule 3: Merge null/undefined tests | `permissions.test.js` | Low |
| 4 | Rule 3: Consolidate `canDo with default permissions` | `permissions.test.js` | Low |
| 5 | Rule 3+5: Convert multi-assert `it()` blocks to `test.each` | `constants.test.js` | Low |
| 6 | Coverage gap: Add `TemplateEngine` tests | new file | Medium |
| 7 | Coverage gap: Add `generateRmaNumber` tests | new file | Low |
| 8 | Coverage gap: Add `auditInsert` retry tests | new file | Medium |

---

---

## Summary

The codebase is well-structured overall — clean TypeScript types, a good Zod schema layer, and solid design in the messaging, permissions, and audit subsystems. The main quality debt is unchanged since the 2026-06-08 pass: **all 4 Critical and all 7 Important findings from that pass remain open** — none have been fixed. `handleSubmit` in `TicketForm.jsx` is still a ~385-line god-method (now lines 224–609). The new code shipped since then (P2-4 unified activity timeline, `useURLTab` rewrite) is mostly good quality, but the timeline introduces two new Important findings: a ~100-line IIFE render block and an i18n violation that stores/renders English-only activity strings. **Needs work before the next major feature.**

### Status of 2026-06-08 findings (re-verified 2026-06-12)

| Finding | Status | Current location |
|---------|--------|------------------|
| C-1 `handleSubmit` god-function | 🔴 Open | `TicketForm.jsx:224–609` |
| C-2 `ticketComments.create()` 8 params | 🔴 Open | `tickets.ts:158–167` |
| C-3 Catch-all handlers swallow errors | 🔴 Open | `tickets.ts`, `users.ts` (all 8 occurrences unchanged) |
| C-4 `serialHistory.getBySerial()` full-table fetch | 🔴 Open | `tickets.ts:248–264` |
| I-1 Step-number comments | 🔴 Open | `ticketEventHandlers.ts:46–152` (now 7 numbered steps) |
| I-2 `sendBatch` fragile index invariant | 🔴 Open | `MessagingService.ts:57` |
| I-3 `{ missing }` sentinel leak | 🔴 Open | `tickets.ts:142`, `users.ts:204–224` |
| I-4 Silent `.catch(() => {})` | 🔴 Open | `TicketForm.jsx` (~15 sites) + **spread to new code**: `TicketDrawer.jsx` `logActivity` |
| I-5 `toWhatsAppParams` dead code | 🔴 Open | `TemplateEngine.ts:95` — grep confirms zero callers |
| I-6 `validateConfig()` unused | 🔴 Open | `WhatsAppProvider.ts:28` + interface decl `types.ts:89` — zero callers |
| I-7 Three near-identical notification blocks | 🔴 Open | `TicketForm.jsx:332–383` |
| Nits (`fmt`, `inp`/`lbl`, `logAct`) | 🔴 Open | `_utils.js:58`, `TicketForm.jsx:29–31`, `TicketForm.jsx:304` |

Full evidence and suggested fixes for the above are in the 2026-06-08 sections below (unchanged and still accurate). New findings from this pass follow.

---

## New Critical Findings (2026-06-12)

None. The new code since 2026-06-08 introduces no correctness or data-loss issues.

---

## New Important Findings (2026-06-12)

### N-1. Activity timeline is a ~100-line IIFE inside JSX — `TicketDrawer.jsx:958–1059`
**Evidence:** `{(() => { const entries = […]; const ACTIVITY_CFG = {…}; const typeIcon = …; const typeLabel = …; return (<div>…</div>) })()}` — the entire timeline (data merge, config map, two render helpers, and markup) lives in an immediately-invoked closure inside the drawer's JSX. `ACTIVITY_CFG`, `typeIcon`, and `typeLabel` are re-created on every drawer render, and `TicketDrawer.jsx` has grown to 1 505 lines.
**Principle violated:** Functions stay small / one thing (imperative 2); long function mixing concerns (AI failure mode 8).
**Suggested fix:** Extract an `ActivityTimeline({ comments, timeEntries, activityLog })` component (new file in `src/pages/RMATickets/` per the existing folder convention). Move `ACTIVITY_CFG` to module scope — it is a pure constant. The entries merge belongs in a `useMemo`.

---

### N-2. Activity timeline renders English-only strings to all locales — `TicketDrawer.jsx:1013, 1068` + `logActivity` call sites
**Evidence (two related violations of the project i18n LAW):**
1. `TicketDrawer.jsx:1068` — `{ticketComments.length} comment{ticketComments.length !== 1 ? 's' : ''}` — hardcoded English pluralization, not `t()`. Arabic users see "3 comments".
2. The new `logActivity()` helper writes freeform English into `ticket_activity.details` (`'Deleted a comment'`, `` `Resolution: ${resForm.type}` ``, `` `Logged ${h}h ${m}m — ${notes}` ``), and `typeLabel` (line 1013) renders `entry.details` raw. The same applies to `TicketForm.jsx`'s `logAct` strings. Once written, these strings are frozen in the writer's language forever.
**Principle violated:** CLAUDE.md LAW — "Every new page, component, modal, or function must use `t()` for all user-visible strings at build time."
**Suggested fix:** For (1), use `t('ticketDrawer.commentCount', { count: ticketComments.length })` — i18next handles plural rules per locale (Arabic has 6 plural forms). For (2), the durable fix is structural: store machine-readable `action_type` + a small params object (e.g. `{ hours, minutes }`, `{ resolution_type }`) and translate at render time via `t(\`activity.${entry.action_type}\`, params)`. Storing pre-rendered prose in the DB makes per-locale rendering impossible.

---

### N-3. `logActivity` duplicates `logAct` — third copy of the activity-insert shape — `TicketDrawer.jsx:148–153` vs `TicketForm.jsx:304–305`
**Evidence:** Both helpers build the same `{ ticket_id, action_type, details, user_email, created_date }` insert with the same silent `.catch(() => {})`. `TicketForm` also inlines the same shape once more at line 575.
**Principle violated:** DRY — knowledge duplication (imperative 11); also extends I-4 (silent catch) into new code.
**Suggested fix:** Add `db.ticketActivity.log(ticketId, actionType, details, userEmail)` in `tickets.ts` that owns the timestamp and the error policy (at minimum `captureException` before swallowing), then use it from both components.

---

## New Nits (2026-06-12)

- **Dead `title` prop** — `TicketForm.jsx:616`. `title={editingTicket ? 'Edit RMA Ticket' : 'Create New RMA Ticket'}` is hardcoded English, but the same `Modal` call passes `hideHeader`, so the title never renders. Delete the prop (or translate it if `hideHeader` is ever removed).
- **`entry.id ?? i` list key** — `TicketDrawer.jsx:1032`. Falling back to array index is safe only because entries are re-sorted on every render anyway; fine for now, worth a stable key if the timeline ever gets inline editing.

---

## What's Improved Since 2026-06-08

1. **`useURLTab` rewrite** (`useURLTab.js`) — replaced manual `window.history` + `popstate` listener (31 lines) with React Router's `useSearchParams` (18 lines). Fewer moving parts, back/forward now handled by the router, and the `pushHistory` flag has a real caller (`ControlPanel.jsx:439`). Textbook simplification.
2. **`Reports.jsx` tab state** now uses `useURLTab` instead of bare `useState` — deep links work, consistent with every other page.
3. **`ACTIVITY_CFG` map** replaces the old `actionType?.includes('creat')` string-sniffing heuristic for timeline icon colors — explicit lookup with a sensible default. (Just move it to module scope per N-1.)
4. **`logActivity` optimistic UI** — appending the returned entry to local state so the timeline updates without a refetch is the right pattern.

---

## Critical Findings

### C-1. `handleSubmit` is a 385-line god-function — `TicketForm.jsx:224–609`
**Evidence:** The function does form validation, file upload, SLA computation, DB create/update, activity logging (per changed field), three separate `db.notifications.create()` calls, three `db.automationRules.evaluate()` + `db.webhooks.dispatch()` pairs, two WhatsApp `emitAsync()` calls, two email paths, and resolution upsert — all in a single try block.
**Principle violated:** SRP (one actor per module), Functions Stay Small (imperative 2 — target ≤20 lines), cyclomatic ≤10 (imperative 13).
**Estimated cyclomatic complexity:** ≥25 branches.
**Suggested fix:** Extract at minimum these four helpers, each ≤30 lines:
- `uploadPendingAttachments(pendingFiles, rmaNumber): Promise<Attachment[]>`
- `logTicketChanges(editingTicket, newData, userEmail): void` — wraps all the `logAct` and `db.userActivity` calls
- `dispatchTicketNotifications(editingTicket, newData, resolvedEmail): void` — wraps the three `db.notifications.create`, two `db.automationRules`, two `db.webhooks`, and the `notificationEventBus.emitAsync` calls
- `fireEmailNotifications(editingTicket, newData, resolvedEmail): void` — wraps the three `notifications.sendEmail` calls

---

### C-2. `ticketComments.create()` takes 8 positional parameters — `tickets.ts:158–167`
**Evidence:**
```typescript
async create(
  ticketId: string,
  commentText: string,
  authorEmail: string,
  authorName: string,
  isInternal = false,
  parentCommentId: string | null = null,
  attachments: unknown[] = [],
  isCustomerComment = false
): Promise<...>
```
**Principle violated:** Four-argument ceiling (imperative 3). Two boolean flag parameters (`isInternal`, `isCustomerComment`) are also a direct violation.
**Suggested fix:** Introduce a `CreateCommentOptions` DTO:
```typescript
interface CreateCommentOptions {
  ticketId: string
  commentText: string
  authorEmail: string
  authorName: string
  isInternal?: boolean
  parentCommentId?: string | null
  attachments?: unknown[]
  isCustomerComment?: boolean
}
async create(opts: CreateCommentOptions): Promise<TicketCommentRow | undefined>
```

---

### C-3. Multiple catch-all handlers silently return null/empty — `tickets.ts`, `users.ts`
**Evidence (8 occurrences):**
- `ticketResolutions.get()` `tickets.ts:293-298` — catches everything, returns `null`; only `42P01` is recoverable
- `serialHistory.getBySerial()` `tickets.ts:247-264` — bare `catch { return [] }`
- `rmaTracker.getTicketByRmaNumber()` `tickets.ts:200-208` — catches supabase error AND function invoke error, both return `null`
- `rmaTracker.getPublicComments()` `tickets.ts:211-220` — same
- `ticketComments.list()` `tickets.ts:143-157` — catches beyond `42P01`, returns `{ missing: true, data: [] }`
- `userRoles.getUserRole()` `users.ts:49` — catches everything after `PGRST116` guard, returns `null`
- `userRoles.getCustomRoles()` `users.ts:136-140` — bare `catch { return [] }`
- `userActivity.list()` `users.ts:171-176` — bare `catch { return [] }`

**Principle violated:** Catch only the specific error type you can recover from (imperative 15, Karpathy). DB permission errors, schema mismatches, and auth failures are all silently eaten.
**Suggested fix:** Only catch `PostgrestError` with known codes (`42P01` = table missing, `PGRST116` = no row). Let everything else propagate — or at minimum `captureException()` before returning the default. Pattern to use:
```typescript
if (error.code === '42P01') return null // table missing — graceful degradation
if (error) throw error                   // everything else propagates
```

---

### C-4. `serialHistory.getBySerial()` fetches all rows then filters client-side — `tickets.ts:249-264`
**Evidence:** No `.limit()`, no `.filter()` predicate. Fetches every row in `rma_tickets` to find serial matches in the JSONB `products[]` column.
**Principle violated:** Correctness at scale — at 5,000+ tickets this query will timeout or return truncated results silently.
**Suggested fix:** Use Postgres JSONB containment or a generated column index. At minimum add `.limit(5000)` matching the `rmaTickets.list()` cap and document it. Ideally add a GIN index: `CREATE INDEX ON rma_tickets USING gin(products)` and filter server-side with `.contains('products', [{serial_number: serialNumber}])`.

---

## Important Findings

### I-1. Step-number scaffolding comments in `ticketEventHandlers.ts:46-145`
**Evidence:** `// ── 1. Check global WhatsApp toggle ──`, `// ── 2. Check per-event toggle ──`, `// ── 3. Load active template...`, etc.
**Principle violated:** Comments explain *why*, never *what* (imperative 5). These describe the sequence of what the code does — the function name and structure should express that.
**Suggested fix:** Extract each numbered block into its own named `async` helper (e.g., `fetchGlobalToggle`, `fetchEventToggle`, `loadTemplateForEvent`, `resolveCustomerPhone`, `buildNotificationPayload`, `enqueueNotification`). The step comments disappear and the outer handler becomes a readable 10-line orchestrator.

---

### I-2. `sendBatch` uses a fragile invariant to recover the provider name — `MessagingService.ts:55-58`
**Evidence:**
```typescript
provider: slice[results.length % slice.length]?.provider ?? 'whatsapp',
```
This relies on `results.length === current settled index`, which holds only because every fulfilled *and* rejected path pushes to `results` — a hidden invariant.
**Principle violated:** No copy-from-similar / off-by-one risk (imperative 19). Fragile: any future `continue` or early-push breaks it.
**Suggested fix:**
```typescript
settled.forEach((r, idx) => {
  if (r.status === 'fulfilled') {
    results.push(r.value)
  } else {
    results.push({
      success: false,
      provider: slice[idx]?.provider ?? 'whatsapp',
      status: 'failed',
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    })
  }
})
```

---

### I-3. `{ missing: boolean }` sentinel leaks DB internals into callers — `tickets.ts:142`, `users.ts:194`
**Evidence:** `ticketComments.list()` returns `{ missing: boolean; data: TicketCommentRow[] }`. `userPreferences.get()` returns `{ missing: boolean; prefs? }`. `userPreferences.set()` returns `{ missing: boolean; error? }`. Every caller must branch on `missing`.
**Principle violated:** Wrong abstraction (imperative 12, Metz) — per-caller special-case flag accumulated in shared functions.
**Suggested fix:** Callers should not know about table existence. Return `data: []` for missing tables (the graceful fallback), or throw a typed `TableNotFoundError` that callers can catch specifically. The `42P01` case is a migration concern, not a runtime API shape.

---

### I-4. Silent `.catch(() => {})` on side-effects with no observability — `TicketForm.jsx` multiple lines
**Evidence:** Lines 305, 322, 344, 363, 382, 388, 392, etc. Activity logs, notifications, automation rules, and webhooks all use empty catch callbacks.
**Principle violated:** Even fire-and-forget errors should reach Sentry (imperative 15 intent). Silent swallowing means failed webhook dispatches or automation rule errors go completely undetected in production.
**Suggested fix:** Replace `.catch(() => {})` with `.catch((err) => captureException(err, { context: 'ticketSave:webhooks' }))` on at minimum the automation and webhook calls. Notification failures can remain silent if that's intentional, but should be documented.

---

### I-5. `TemplateEngine.toWhatsAppParams()` appears to be dead code — `TemplateEngine.ts:95-97`
**Evidence:** `ticketEventHandlers.ts:118-122` builds the `params` array manually. A grep of the project finds no callers of `toWhatsAppParams`.
**Principle violated:** Strip dead code before delivery (imperative 21).
**Suggested fix:** Verify no callers exist (`grep -r toWhatsAppParams src/`), then delete or replace the manual `params` construction in `ticketEventHandlers.ts` with a call to this method.

---

### I-6. `WhatsAppProvider.validateConfig()` appears unused — `WhatsAppProvider.ts:28-30`
**Evidence:** `isEnabled()` already checks `!!this.phoneNumberId`. `validateConfig()` duplicates that check and is not called anywhere visible.
**Principle violated:** No speculative anything (imperative 14); dead code (imperative 21).
**Suggested fix:** Delete if no callers exist.

---

### I-7. Three nearly-identical `db.notifications.create()` blocks in the edit path — `TicketForm.jsx:332-383`
**Evidence:** The `ticket_updated`, `ticket_assigned`, and `ticket_status_changed` notification blocks are ~12 lines each with the same shape, differing only in `type`, `title`, `message`, and `targetEmails`.
**Principle violated:** DRY (imperative 11).
**Suggested fix:** Extract `createTicketNotification(type, title, message, targetEmails, ctx)` with `ctx = { ticketId, rmaNumber, createdBy }`.

---

## Nits

- **`fmt` is a generic name** — `_utils.js:58`. Rename to `formatDate` for clarity. (Imperative 1)
- **`inp` / `lbl` module-level variables** — `TicketForm.jsx:29-31`. These are CSS class strings named with 2-letter abbreviations. Rename to `inputClass` / `labelClass`.
- **`logAct` abbreviated name** — `TicketForm.jsx:305`. Rename to `logActivityChange`.
- **`TicketForm` component takes 8 props** — `TicketForm.jsx:33-44`. Consider a typed `TicketFormProps` interface / destructuring from a single prop object for IDE discoverability.
- **Code-paraphrasing comments in `TicketForm.jsx`** — Lines 258, 268, 303. These describe *what*, not *why*. Delete or replace with the non-obvious constraint.
- **`auditFlushQueue` bare `catch {}`** — `audit.ts:43`. Should at least `console.warn` so flush failures appear in browser devtools during debugging.

---

## What's Good

1. **`resolvePermissions`** (`permissions.ts:260-280`) — elegantly solves the "empty object is truthy" trap with a clear merge algorithm and a well-placed comment explaining the non-obvious invariant it protects against.
2. **`auditInsert` retry-and-queue** (`audit.ts:45-63`) — thoughtful resilience: retry once, queue to localStorage on double failure, flush on next success. Observability via `captureException` is wired in.
3. **`MessagingService` / `WhatsAppProvider` provider registry** (`MessagingService.ts`, `WhatsAppProvider.ts`) — clean DIP-compliant design; the API token never touches the browser, and `sendBatch` with `Promise.allSettled` correctly handles partial batch failures.
4. **WhatsApp JSONB ordering comment** (`ticketEventHandlers.ts:109-121`) — the comment explaining *why* a positional `params` array must be used instead of an object (Postgres JSONB destroys key order) is exactly the kind of non-obvious constraint a comment should capture.
5. **`TemplateEngine`** (`TemplateEngine.ts`) — clean static utility: pure functions, no side effects, straightforward regex for conditional blocks, easy to unit-test in isolation.
6. **Zod schemas** (`schemas.ts`) — comprehensive coverage of all user-facing forms with correct use of `superRefine` for cross-field rules, proper `z.infer<>` type exports, and `getFirstError` / `getFieldErrors` helpers that prevent duplicated flatten logic.
7. **`lazyWithReload`** (`App.jsx:70-82`) — solves the stale chunk URL problem elegantly. The `return new Promise(() => {})` to freeze the lazy component on reload is a clever idiom worth keeping.
8. **`generateRmaNumber`** (`_utils.js:4-20`) — handles the today-serial collision case, `Math.max(...todaySerials)`, and serial padding correctly with clean, pure logic.

---

## Fix Priority Order

| Priority | Finding | File | Effort |
|----------|---------|------|--------|
| 1 | C-1: Break up `handleSubmit` | `TicketForm.jsx:224` | High |
| 2 | C-2: Refactor `ticketComments.create()` to DTO | `tickets.ts:158` | Low |
| 3 | C-3: Narrow catch-all handlers | `tickets.ts`, `users.ts` | Medium |
| 4 | C-4: Server-side filter in `serialHistory.getBySerial()` | `tickets.ts:249` | Medium |
| 5 | I-4: Add `captureException` to fire-and-forget catches | `TicketForm.jsx` | Low |
| 6 | I-2: Fix `sendBatch` fragile index | `MessagingService.ts:55` | Low |
| 7 | I-7: Extract `createTicketNotification` helper | `TicketForm.jsx:332` | Low |
| 8 | I-1: Extract helpers in `ticketEventHandlers.ts` | `ticketEventHandlers.ts:46` | Medium |
| 9 | I-3: Remove `{ missing }` sentinel | `tickets.ts`, `users.ts` | Medium |
| 10 | N-2: Fix timeline i18n (plural + stored-English details) | `TicketDrawer.jsx:1013,1068` | Medium |
| 11 | N-1: Extract `ActivityTimeline` component | `TicketDrawer.jsx:958` | Medium |
| 12 | N-3: Shared `db.ticketActivity.log()` helper | `tickets.ts`, both components | Low |
| 13 | I-5/I-6: Delete dead code (`toWhatsAppParams`, `validateConfig`) | `TemplateEngine.ts`, `WhatsAppProvider.ts` | Low |
| 14 | Nits | Various | Low |

---

## Self-Check Coverage

- [x] Walked Section A (naming & functions)
- [x] Walked Section B (comments & formatting)
- [x] Walked Section C (SOLID)
- [x] Walked Section D (DRY/KISS/YAGNI)
- [x] Walked Section E (AI failure modes)

---

---

# Docs Guard Report: myRMA 2.0 — `README.md`, `CLAUDE.md`, `AGENTS.md`, `DESIGN.md`
**Date:** 2026-06-08
**Skill:** docs-guard (review mode)
**Claims checked:** ~40 · **False/stale:** 8 · **Contradictions between docs:** 5

**Verdict: Fix first.** The architecture docs are largely accurate and high quality, but five file-path claims in `README.md` and `AGENTS.md` are verifiably wrong (wrong extensions), the test count is stale, the i18n file path is wrong, and five design token hex values contradict between `DESIGN.md` and `CLAUDE.md`. These will mislead contributors and agents on their first day.

---

## Must Fix (Rules 1–4)

---

**Rule 1 violation** in `README.md` — Project Structure tree, `src/api/db/` section

- **Claim:** `inventory.js`, `users.js`, `notifications.js`, `system.js`, `audit.js`
- **Reality:** All five files are `.ts` (TypeScript): `inventory.ts`, `users.ts`, `notifications.ts`, `system.ts`, `audit.ts` — verified by directory listing of `D:\myrma-app\src\api\db`. The same tree section correctly lists `tickets.ts`, `customers.ts`, etc., making the inconsistency easy to miss.
- **Fix:** Change the five `.js` entries to `.ts` in the project structure tree.

---

**Rule 1 violation** in `AGENTS.md` — Data layer module table (lines 103–111)

- **Claim:** `tickets.js`, `customers.js`, `catalog.js`, `inventory.js`, `users.js`, `notifications.js`, `system.js`, `audit.js`, `whatsappNotifications.js`
- **Reality:** All nine files are `.ts`. `CLAUDE.md` (the twin doc) correctly uses `.ts` throughout.
- **Fix:** Update all nine entries in the AGENTS.md module table to `.ts`.

---

**Rule 1 violation** in `CLAUDE.md` — i18n section (line 164)

- **Claim:** `src/i18n.js` — i18next config (language detection, `en` default)
- **Reality:** The file lives at `src/lib/i18n.js` — `Test-Path "D:\myrma-app\src\i18n.js"` returns `False`; `src/lib/i18n.js` returns `True`.
- **Fix:** Change `src/i18n.js` → `src/lib/i18n.js`.

---

**Rule 3 violation** in `README.md`, `CLAUDE.md`, `AGENTS.md` — test count

- **Claim (all three docs):** `npm test` → "80 tests, ~1s" / "80 tests, 3 suites"
- **Reality:** Running `npm test` produces `Tests 160 passed (160)` across `Test Files 6 passed (6)` and takes ~13s. Vitest has no `include` pattern, so it picks up files from both `src/test/` AND `.claude/worktrees/…/src/test/`, doubling every test. The unique project test count is 80, but `npm test` will show 160 to a new contributor.
- **Fix:** Add `include: ['src/test/**/*.test.{js,ts}']` to the `test` config in `vite.config.js` to exclude the worktree path. Then update the test count and timing in all three docs to match the corrected output.

---

**Rule 1 violation** in `DESIGN.md` vs `CLAUDE.md` / `AGENTS.md` — 5 contradictory design token hex values

- **Claim (DESIGN.md):**

  | Token | DESIGN.md value |
  |-------|----------------|
  | `surface-inset` (light) | `#f7f8fb` |
  | `border-soft` (light) | `#eef0f4` |
  | `text-faint` (light) | `#a39e95` |
  | `surface-inset` (dark) | `#0e131c` |
  | `text-faint` (dark) | `#646f7e` |

- **Reality (CLAUDE.md + AGENTS.md token tables):**

  | Token | CLAUDE.md / AGENTS.md value |
  |-------|---------------------------|
  | `surface-inset` (light) | `#f8f9fb` |
  | `border-soft` (light) | `#f0f2f6` |
  | `text-faint` (light) | `#a09d99` |
  | `surface-inset` (dark) | `#0f1520` |
  | `text-faint` (dark) | `#4a5568` |

- All five values differ between the two sources. Agents reading `DESIGN.md` will write different hex values than agents reading `CLAUDE.md`.
- **Fix:** Pick one source of truth (recommended: the `CLAUDE.md`/`AGENTS.md` table, since those are the agent-facing docs used at development time), then update `DESIGN.md` to match. Add a note in `DESIGN.md`: "Authoritative token values are in `CLAUDE.md` Design tokens section."

---

## Should Fix (Rules 5–9)

---

**Rule 5 violation** in `README.md` line 5 — broken CI badge

- **Claim:** `[![CI](https://github.com/your-org/myrma-app/actions/workflows/ci.yml/badge.svg)]`
- **Reality:** `your-org` is a placeholder. The badge image returns 404; clicking it goes nowhere.
- **Fix:** Replace with the real repo URL or delete the badge until the repo is public.

---

**Rule 7 violation** in `README.md` — redundant `--legacy-peer-deps` flag

- **Claim:** `npm install --legacy-peer-deps`
- **Reality:** `.npmrc` already contains `legacy-peer-deps=true`, so `npm install` alone applies the flag automatically. The explicit flag implies this is exceptional behavior when it's project default.
- **Fix:** Change to `npm install` and add a note: "(legacy-peer-deps is set in .npmrc — no flag needed)"

---

**Rule 8 violation** in `AGENTS.md` — i18n/RTL section missing entirely

- **Claim:** `AGENTS.md` is presented as a complete agent guide equivalent to `CLAUDE.md`.
- **Reality:** The entire i18n/RTL section from `CLAUDE.md` lines 159–195 (covering `react-i18next`, locale files, `t()` usage, module-level patterns, and RTL portal guidance) is absent from `AGENTS.md`. An agent reading only `AGENTS.md` has no guidance on i18n.
- **Fix:** Copy the i18n/RTL section from `CLAUDE.md` into `AGENTS.md`, or add a cross-reference: "See CLAUDE.md → Internationalisation (i18n) / RTL."

---

## Worth Noting (Rule 10)

---

**Rule 10 violation** in `CLAUDE.md` and `AGENTS.md` — dangling SPECKIT stub (last 4 lines)

- **Claim:**
  ```
  <!-- SPECKIT START -->
  For additional context about technologies to be used, project structure,
  shell commands, and other important information, read the current plan
  <!-- SPECKIT END -->
  ```
- **Reality:** "read the current plan" refers to nothing a reader can find — this is scaffolding left by the SPECKIT tool, not real navigation.
- **Fix:** Delete these 4 lines from both `CLAUDE.md` and `AGENTS.md`.

---

**Worth noting** — `AGENTS.md` messaging types discrepancy (line 208)

- **Claim:** `types.ts` exports `QueueJob` (in AGENTS.md); `CLAUDE.md` (line 222) omits `QueueJob` from the same list.
- **Fix:** Verify against `src/lib/messaging/types.ts` and sync both docs to match reality.

---

## Verified Correct

- All 10 migration filenames in `CLAUDE.md`/`AGENTS.md` match actual files in `supabase/migrations/`. ✓
- All routes in the route tables match `App.jsx`. ✓
- `STORAGE_KEY.APPEARANCE = 'mrma_appearance'` — `constants.ts:199` ✓
- Locale files at `src/locales/en.json` and `src/locales/ar.json` ✓
- Test count "80 unique tests" is accurate for the project's own `src/test/` files ✓
- Edge Function names in `README.md` `supabase functions deploy` block match `CLAUDE.md`/`AGENTS.md` ✓
- `WhatsApp JSONB ordering` explanation in `CLAUDE.md`/`AGENTS.md` matches the actual `params` array construction in `ticketEventHandlers.ts:118-122` ✓

---

## Fix Priority Order

| Priority | Finding | File | Effort |
|----------|---------|------|--------|
| 1 | `.js` → `.ts` extension in AGENTS.md module table | `AGENTS.md:103-111` | Low |
| 2 | `.js` → `.ts` extension in README.md project tree | `README.md:193-196` | Low |
| 3 | Fix i18n file path `src/i18n.js` → `src/lib/i18n.js` | `CLAUDE.md:164` | Low |
| 4 | Resolve design token contradiction (pick one source) | `DESIGN.md` vs `CLAUDE.md` | Low |
| 5 | Fix test count + add vitest `include` filter | `vite.config.js`, all 3 docs | Low |
| 6 | Remove CI badge placeholder or replace URL | `README.md:5` | Low |
| 7 | Remove redundant `--legacy-peer-deps` flag | `README.md:78` | Low |
| 8 | Add i18n/RTL section to AGENTS.md | `AGENTS.md` | Medium |
| 9 | Remove SPECKIT stubs | `CLAUDE.md`, `AGENTS.md` (last 4 lines) | Low |
| 10 | Verify and sync `QueueJob` in types.ts export list | `AGENTS.md:208`, `CLAUDE.md:222` | Low |

---

## What's Good

1. **CLAUDE.md architecture section** is authoritative and detailed — the permission resolution algorithm, WhatsApp event flow, JSONB ordering pitfall, and RTL portal guidance are documented at a precision level that would take a new contributor hours to derive from the code.
2. **WhatsApp JSONB pitfall documentation** in both `CLAUDE.md` and `AGENTS.md` is an excellent Rule 3 example: the docs explain not just *what* to do but *why* (JSONB reorders object keys), with the exact Meta error codes that result from getting it wrong.
3. **Security section in README** accurately describes RLS, upload restrictions, and Edge Function JWT validation — all verifiable against the actual API client and migration files.

---

## Self-Check Coverage (docs-guard)

- [x] Pass 1: Claim verification (symbols, paths, versions, config keys)
- [x] Pass 2: Code samples (n/a — no fenced code samples with import chains)
- [x] Pass 3: Drift scan (renamed symbols, cross-doc consistency)
- [x] Pass 4: Substance (filler, paraphrase, upstream restatement)
- [x] Pass 5: Navigation (links, stubs, TOC accuracy)

---

---

# Docs Guard Report: myRMA 2.0 — `AUDIT_LOG.md`, `COMPETITIVE_ANALYSIS.md`, `CONSTITUTION.md`, `GUARD_SKILL_TEST_REPORT.md`, `SYSTEM_TEST_REPORT_20260527.md`
**Date:** 2026-06-08
**Skill:** docs-guard (review mode)
**Claims checked:** ~50 · **False/stale:** 7 · **Internal contradictions:** 4

**Verdict by file:**
| File | Verdict | Issues |
|------|---------|--------|
| `CONSTITUTION.md` | ⚠️ Fix before use | 5 issues — 2 Must Fix, 3 Should Fix |
| `COMPETITIVE_ANALYSIS.md` | ⚠️ Should fix | 1 issue — internal contradiction across sections |
| `AUDIT_LOG.md` | ⚠️ Minor fix | 2 issues — 1 Must Fix (recent entry), stale historical links (worth noting) |
| `SYSTEM_TEST_REPORT_20260527.md` | ✅ Clean | Historical dated snapshot — stale data is expected and correct |
| `GUARD_SKILL_TEST_REPORT.md` | ✅ Mostly clean | One stale test count in our own header (worth noting) |

---

## CONSTITUTION.md

### Must Fix (Rules 1–3)

---

**Rule 1 violation** in `CONSTITUTION.md` — §12.1 Naming Conventions table

- **Claim** (line ~1082): "API domain module | camelCase `.js` in `src/api/db/` | e.g. `tickets.js`, `customers.js`"
- **Reality:** All 9 db modules are `.ts`: `tickets.ts`, `customers.ts`, `catalog.ts`, `inventory.ts`, `users.ts`, `notifications.ts`, `system.ts`, `audit.ts`, `whatsappNotifications.ts` — converted 2026-06-03. Verified by directory listing in the previous docs-guard pass on `CLAUDE.md`/`AGENTS.md`.
- **Fix:** Update the naming table: extension `.js` → `.ts`, examples `tickets.js, customers.js` → `tickets.ts, customers.ts`.

---

**Rule 1 + Rule 3 violation** in `CONSTITUTION.md` — §13.1 Directory Map

- **Claim** (lines ~1178–1185): Lists `src/api/db/` contents as `index.js`, `tickets.js`, `customers.js`, `products.js`, `inventory.js`, `users.js`, `notifications.js`
- **Reality (three issues):**
  1. All files are `.ts`, not `.js`.
  2. `products.js` / `products.ts` does not exist in `src/api/db/`. The correct file is `catalog.ts` (products domain logic lives there). `products.ts` is a page in `src/pages/`.
  3. The module list is also incomplete — missing `system.ts`, `audit.ts`, `whatsappNotifications.ts`.
  4. Contradiction within the same document: §7.1 (lines ~673–686) correctly lists these files as `.ts` with their TypeScript Row types. Two sections of the same doc disagree.
- **Fix:** Update the directory map to `index.ts`, `tickets.ts`, `customers.ts`, `catalog.ts`, `inventory.ts`, `users.ts`, `notifications.ts`, `system.ts`, `audit.ts`, `whatsappNotifications.ts`.

---

### Should Fix (Rules 1, 5)

---

**Rule 1 violation** in `CONSTITUTION.md` — §7.4 Edge Functions

- **Claim** (lines ~753–763): Lists 3 Edge Functions: `admin-reset-password`, `public-track`, `send-email`
- **Reality:** There are 6 Edge Functions. Missing: `send-whatsapp`, `notification-worker`, `whatsapp-webhook` — added 2026-06-02 (documented in `CLAUDE.md`, `AGENTS.md`, and `AUDIT_LOG.md` changelog).
- **Fix:** Add the three missing functions to the §7.4 table.

---

**Rule 1 violation** in `CONSTITUTION.md` — §16.3 CI/CD Pipeline

- **Claim** (line ~1454): "1. `npm test` — Vitest (74 unit tests, must all pass)"
- **Reality:** 80 tests in 3 suites as of 2026-05-29 (Sprint 8 adds `resolvePermissions` regression suite). `§15.1` in the same document was already updated to say "80 tests across 3 suites" — internal contradiction.
- **Fix:** Line ~1454: `74 unit tests` → `80 unit tests`.

---

**Rule 5 (drift) / Rule 3 (code disagrees with docs) violation** in `CONSTITUTION.md` — §7.1 vs §12.1 + §13.1

- **Claim:** §7.1 (lines ~673–686) correctly uses `.ts` extensions for all db modules.
- **Reality:** §12.1 and §13.1 still say `.js`. Three sections of the same document describe the same files with two different extensions.
- **Fix:** Once §12.1 and §13.1 are corrected (see Must Fix above), this contradiction resolves automatically.

---

## COMPETITIVE_ANALYSIS.md

### Should Fix (Rule 3)

---

**Rule 3 violation** in `COMPETITIVE_ANALYSIS.md` — Section 3 "Missing Features Report" vs Section 5 "Roadmap"

- **Claim (Section 3):**
  - "MFA / Two-Factor Auth" — 🔴 Critical MISSING
  - "Replacement / Exchange RMA" — 🔴 Critical MISSING
  - "Multi-language support" — 🟡 Medium MISSING
- **Reality (Section 5 "Roadmap"):** All three are marked ✅ with shipped dates. The document records them as shipped but Section 3 was never updated when they shipped.
- **Scope:** This is a product/marketing document, so there are no code paths to verify. The violation is purely an internal contradiction between two sections.
- **Fix:** Update Section 3 to mark these three items as ✅ Shipped with their shipped dates. Or add a note at the top of Section 3: "This section reflects the pre-launch baseline; see Section 5 for current status."

---

## AUDIT_LOG.md

### Must Fix (Rule 1)

---

**Rule 1 violation** in `AUDIT_LOG.md` — 2026-06-05 i18n changelog entry

- **Claim** (line 1310): "Stack: `react-i18next`, `src/locales/en.json` + `src/locales/ar.json` (~500+ keys), `src/i18n.js` config."
- **Reality:** The i18n config is at `src/lib/i18n.js`, not `src/i18n.js`. Verified by `Test-Path` in the previous docs-guard session (same correction already applied to `CLAUDE.md:164`).
- **Fix:** Line 1310: `src/i18n.js` → `src/lib/i18n.js`.

---

### Should Fix (Rule 3 — internal inconsistency)

---

**Rule 3 violation** in `AUDIT_LOG.md` — C-1 fix description inconsistency

- **Claim (Sprint 3 findings, line ~601):** Proposed fix for C-1 (Vitest parallel race): "Add `poolOptions: { forks: { singleFork: true } }`"
- **Reality (Sprint 4 completed task, line 663):** Actual fix applied was `fileParallelism: false` in the `test` block — a different config key, different location. The two descriptions exist in the same document without noting the refinement.
- **Fix:** Add a one-line note at the C-1 finding entry (~line 601): "(Refined in Sprint 4 to `fileParallelism: false` — see Sprint 4 C-1.)"

---

### Worth Noting (Rule 10 — navigation)

---

**Stale file links** in `AUDIT_LOG.md` — Sprint 4–9 historical entries

Multiple historical entries (written before the 2026-06-03 TypeScript conversion) contain `[src/api/db/tickets.js]`, `[src/api/db/audit.js]`, `[src/api/db/users.js:37]` and similar links that now resolve to `.ts` files. Affected lines include approximately: 261, 336, 602, 664, 734, 851, 852 and others in the Sprint 8 UM-findings table.

These are dated historical sprint entries — the files genuinely were `.js` at time-of-writing. The links are not misleading about the outcome of those sprints. However, anyone following a link today will land on `tickets.ts`, not `tickets.js`.

**Recommendation:** Leave Sprint 4–8 entries as-is (historical accuracy). Only update the C-1 entry (~601) per the Should Fix above, and the 2026-06-05 i18n entry per the Must Fix above. Optionally, add a one-line note at the top of the Sprint 4 section noting the TS conversion date.

---

## SYSTEM_TEST_REPORT_20260527.md

**Clean.** This is a dated historical test snapshot from 2026-05-27. The stale test count ("74 passed (74)"), `.js` file references, and route counts are accurate for that date. No violations.

---

## GUARD_SKILL_TEST_REPORT.md

### Worth Noting (Rule 1 — our own artifact)

---

**Stale test count in test-guard report header** (line 11)

- **Claim:** "**Result:** 107/107 passing ✅"
- **Reality:** Current `npm test` shows 80/80. The report was generated before the `include: ['src/test/**/*.test.{js,ts}']` fix was applied to `vite.config.js` in this session. The 107 count reflects a transient state between the worktree-doubling bug and the fix.
- **Impact:** Low — this is an audit artifact, not a spec. But a reader comparing "107" to the documented "80" will be confused.
- **Fix:** Update line 11: `107/107` → `80/80`, and add: `(pre-fix count was 107 due to Vitest worktree duplication — see vite.config.js include filter)`.

---

## Fix Priority Table

| Priority | File | Section / Line | Fix | Effort |
|----------|------|----------------|-----|--------|
| 1 | `CONSTITUTION.md` | §13.1 Directory Map (~1178–1185) | `.js` → `.ts`; `products.js` → `catalog.ts`; add missing modules | Low |
| 2 | `CONSTITUTION.md` | §12.1 Naming table (~1082) | `.js` → `.ts` in extension column and examples | Low |
| 3 | `AUDIT_LOG.md` | Line 1310 (i18n entry) | `src/i18n.js` → `src/lib/i18n.js` | Low |
| 4 | `CONSTITUTION.md` | §7.4 Edge Functions (~753–763) | Add 3 missing functions | Low |
| 5 | `CONSTITUTION.md` | §16.3 CI/CD (~1454) | `74` → `80` unit tests | Low |
| 6 | `COMPETITIVE_ANALYSIS.md` | Section 3 vs Section 5 | Mark MFA / replacement / i18n as shipped | Low |
| 7 | `AUDIT_LOG.md` | C-1 entry (~601) | Note that `poolOptions` approach was refined to `fileParallelism: false` | Low |
| 8 | `GUARD_SKILL_TEST_REPORT.md` | Line 11 header | Update `107/107` → `80/80` with note | Low |

---

## What's Good

1. **`SYSTEM_TEST_REPORT_20260527.md`** is a clean historical snapshot — accurately dated, findings correctly tagged to their sprint, and the "status at 2026-05-27" framing is explicit throughout.
2. **`AUDIT_LOG.md` changelog** (lines 1224–1313) is unusually thorough: every sprint's acceptance criteria (`npm test X/X · lint 0/0 · build clean`) are recorded, scores evolve predictably, and the 2026-06-03 entries correctly use `.ts` extensions after the conversion.
3. **`CONSTITUTION.md` §7.1** correctly uses `.ts` for all db modules — the standard was already written correctly for the data access section. Only the naming table and directory map drifted.
4. **`CONSTITUTION.md` WhatsApp JSONB ordering rule** (in the AI Agent rules section) matches the non-obvious invariant documented in `CLAUDE.md` and `AGENTS.md` — consistent across all three docs.
5. **`COMPETITIVE_ANALYSIS.md` Section 5 Roadmap** is up-to-date and correctly marks all shipped features. Only Section 3 lags.

---

## Self-Check Coverage (docs-guard)

- [x] Pass 1: Claim verification (symbols, paths, file extensions, counts, function names)
- [x] Pass 2: Code samples (n/a — no fenced code samples with import chains in these files)
- [x] Pass 3: Drift scan (cross-doc consistency, internal contradictions)
- [x] Pass 4: Substance (filler, paraphrase, obsolete stubs)
- [x] Pass 5: Navigation (section numbering, internal links, historical vs current claims)
