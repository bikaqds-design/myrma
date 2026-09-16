# Full-System Audit — 2026-07-02

**Auditor role:** CTO / Chief Architect / Security Lead / QA Director
**Scope:** entire repository — source, schema, RPCs, Edge Functions, plan docs, CI/CD, dependencies
**Method:** evidence-first. Every finding below cites the file/line it was verified in. Where something could not be verified (live DB state, runtime behavior), uncertainty is stated explicitly.
**Supersedes:** `docs/archive/SYSTEM_AUDIT_REPORT_20260617.md` (that audit's CRIT items — RLS, error boundaries, list caps — were fixed; this audit found a new generation of issues introduced by the CRM/Accounting/Inventory sprints).

**How to use this file:** every finding has an ID and a checkbox. Check items off as they are fixed and note the commit/migration next to them. Do not delete findings — mark them `✅ FIXED (ref)`.

---

# 1. Executive Summary

| Dimension | Score | One-line justification |
|---|---|---|
| **Overall** | **6.0 / 10** | Strong architecture, dangerous gaps in enforcement and verification |
| Product | 7.5 | Coherent Lead→Deal→QT→SO→INV→CN→Payment funnel + RMA + inventory + purchasing; few real workflow holes |
| UI | 6.5 | Disciplined design system (Direction B tokens), but one tab ships **50 broken translation keys** and several 1,500+ line pages |
| UX | 6.5 | Deep-links, URL tabs, approval pool are good; bulk ops can partially fail silently; no undo anywhere |
| Frontend | 6.0 | Excellent data-layer discipline (`db.*` helpers, TanStack Query), but **TypeScript is never type-checked** and monster components abound |
| Backend | 6.5 | The RPC + append-only-ledger design is genuinely good; but the money RPCs have a **privilege hole** and two money paths still mutate balances client-side |
| Database | 7.5 | Idempotent migrations, RLS on every table, gapless sequences, `stock_moves` ledger — the strongest layer |
| Security | **4.5** | One Critical (unguarded SECURITY DEFINER money RPCs), actor-identity spoofing, zero HTTP security headers, vulnerable `xlsx` |
| Performance | 6.0 | Fine at current scale; hard ceilings at ~5–10k rows (client-side filtering/aggregation everywhere) |
| Scalability | 5.0 | Single-tenant, single-region, client-heavy; will serve 10–50 concurrent staff fine, will not serve 1,000 |
| Testing | **3.0** | 277 tests, **all in `src/lib`**. Zero tests on components, API modules, RPCs, RLS — the money paths have no automated coverage at all |

**Is this production-ready?** Not yet. Three things block launch: the unguarded money RPCs (SEC-1), the non-atomic client-side balance writes (REL-1), and the fact that 14 migrations and the entire Sprint 7.6–9 surface are **BUILT but never VERIFIED** (VER-1).

**Can this scale?** To a 10–50 person company: yes, comfortably. Beyond ~5,000 rows per core table or ~200 concurrent users: no, without moving filtering/aggregation server-side (the codebase already documents this and has `listPaged()` escape hatches — the path exists).

**Is this maintainable?** Mixed. The db layer, migrations, and docs are exemplary. The page layer is not: five components over 1,400 lines, 700+ lines of confirmed-dead code, and type annotations that nothing ever checks.

**Is this secure?** The RLS foundation is real and mostly correct. But SECURITY DEFINER functions bypass RLS by design, and the newest ones forgot their role guards — that one class of bug undoes the entire RLS investment for the financial tables.

**Should any core part be redesigned?** **No.** This is the most important sentence in this audit: the architecture (RPC transaction boundaries, append-only ledger, application tables, dual stock model) is correct and should be kept. The problems are enforcement gaps and verification debt, not design flaws.

---

# 2. Critical Findings

Ordered by severity, then blast radius. IDs are stable — reference them in commit messages.

---

## SEC-1 — Money RPCs are SECURITY DEFINER with no role check ⛔

- [ ] **Severity: CRITICAL** · **Priority: Immediate (before the migration batch is applied / before any push)**

**Location:** `supabase/migrations/20260735_cn_payment_lifecycle_rpcs.sql` — `issue_credit_note()`, `void_credit_note()`, `record_payment()`

**Problem:** All three functions are `SECURITY DEFINER` (they bypass RLS entirely) and contain **zero role checks** — verified by grep: no `rma_is_manager_or_above()`, no `rma_is_staff()`, no `REVOKE EXECUTE`. Postgres grants `EXECUTE` to `PUBLIC` by default, so **any authenticated user — including `viewer` — can issue credit notes, void credit notes, and record payments** by calling the RPC directly with the anon key + their own JWT. The sibling migrations got this right (`20260733`/`20260734` both contain `rma_is_manager_or_above()` guards), so this is an omission, not a design decision.

**Worse:** `CLAUDE.md` explicitly claims these RPCs "all enforce role." **The documentation asserts a security property the code does not have.** Anyone building on top of this claim inherits the hole.

**Impact:** A read-only viewer account (or any compromised low-privilege session) can fabricate payments (marking invoices paid without money), issue credit notes (reducing AR), and void financial records. This is direct financial-integrity compromise.

**Root cause:** The role-guard pattern was applied manually per