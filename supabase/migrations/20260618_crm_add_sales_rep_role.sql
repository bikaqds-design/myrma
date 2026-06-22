-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 1, Step 1 — sales_rep role prerequisite
--
--  Hard gate for every other CRM migration (20260619 onward). Without this,
--  chk_user_role rejects inserting a sales_rep row outright, and
--  rma_is_staff() blocks sales_rep from reading customers and every other
--  table gated by that function.
--
--  Deliberately does NOT add sales_rep to rma_is_manager_or_above() — that
--  function gates writes across the entire schema (rma_tickets, inventory,
--  etc.), and sales_rep must stay out of RMA-internal data. The one write
--  sales_rep needs (updating their own assigned customers) requires the
--  customers.assigned_rep column, which doesn't exist until
--  20260624_crm_customers_extend.sql — that migration creates the
--  sales_rep_update_assigned policy once the column it references exists.
--  (Postgres validates column references in a policy at CREATE time, so
--  defining it here against a not-yet-existing column would fail outright.)
--
--  See specs/002-crm-upgrade/research.md §2 and CRM_UPGRADE_PLAN.md
--  Sprint 1 Step 1 for the full rationale.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Allow sales_rep in user_roles ────────────────────────────────────────

ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS chk_user_role;
ALTER TABLE public.user_roles
  ADD CONSTRAINT chk_user_role
  CHECK (role IN (
    'super_admin', 'admin', 'manager', 'technician', 'viewer', 'sales_rep'
  )) NOT VALID;


-- ── 2. Add sales_rep to rma_is_staff() only ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.rma_is_staff() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT public.rma_user_role() IN (
  'super_admin', 'admin', 'manager', 'technician', 'viewer', 'sales_rep'
) $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_user_role';
-- SELECT pg_get_functiondef('public.rma_is_staff'::regproc);
