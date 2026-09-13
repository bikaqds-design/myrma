-- BUG-086: invoices and credit notes could be edited by roles that cannot see them.
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- Every document table gates its UPDATE branch on role. quotations and
-- sales_orders say:
--
--   manager_or_above OR (sales_rep AND (assigned_rep = me OR created_by = me))
--
-- crm_invoices and credit_notes had dropped the `sales_rep AND`:
--
--   manager_or_above OR assigned_rep = me OR created_by = me      -- any role
--
-- while their SELECT policy admits only managers, sales reps and accountants. So
-- at the database level a technician or viewer recorded as the creator or
-- assignee of an invoice passed the UPDATE policy for a document it cannot read.
--
-- ── How exposed it actually was, measured rather than assumed ────────────────
--
-- Less than the policy text suggests, and the report first said otherwise.
-- Rolled-back probes as the live active technician (linked to 4 invoices):
--
--   UPDATE … WHERE id = …                        → 0 rows. A WHERE clause that
--       names a column makes PostgreSQL apply the SELECT policy as well, and
--       the technician cannot read the row.
--   UPDATE … SET reference_po = '…'  (no WHERE)  → passed RLS, stopped only by
--       the settled-document trigger because those invoices are posted.
--
-- And the API cannot send the second form: `authenticator` loads `safeupdate`,
-- which rejects any UPDATE without a WHERE, and every WHERE PostgREST builds
-- names a column. So the gap was not reachable through the app or the API. It
-- rested on two incidental protections instead of the policy saying what it
-- means — one draft invoice linked to an active technician was covered by
-- nothing else. Hence a consistency fix, not an emergency one.
--
-- It was found while checking which tables were safe for BUG-074's write guard,
-- which reads back the row it wrote — something this policy forbade.
--
-- ── What changes, decided by the owner ────────────────────────────────────────
--
-- Both tables now use the quotations rule exactly. The owner was asked the one
-- question this hinges on — whether an accountant who created an invoice should
-- keep being able to edit it — and chose to match quotations: accountants keep
-- read access and record payments through the SECURITY DEFINER procedures, which
-- bypass RLS and are therefore unaffected.
--
-- The settled-document and transition triggers (BUG-002) are untouched and still
-- apply on top of this.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_invoices'
                  AND policyname = 'manager_update_crm_invoices') THEN
    RAISE EXCEPTION 'Refusing to apply: manager_update_crm_invoices is not the policy this migration expects to replace.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'credit_notes'
                  AND policyname = 'manager_update_credit_notes') THEN
    RAISE EXCEPTION 'Refusing to apply: manager_update_credit_notes is not the policy this migration expects to replace.';
  END IF;
END
$do$;

DROP POLICY manager_update_crm_invoices ON public.crm_invoices;
CREATE POLICY sales_update_crm_invoices ON public.crm_invoices
  FOR UPDATE
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep'
        AND (assigned_rep = public.rma_current_user_email() OR created_by = public.rma_current_user_email()))
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep'
        AND (assigned_rep = public.rma_current_user_email() OR created_by = public.rma_current_user_email()))
  );

DROP POLICY manager_update_credit_notes ON public.credit_notes;
CREATE POLICY sales_update_credit_notes ON public.credit_notes
  FOR UPDATE
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep'
        AND (assigned_rep = public.rma_current_user_email() OR created_by = public.rma_current_user_email()))
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep'
        AND (assigned_rep = public.rma_current_user_email() OR created_by = public.rma_current_user_email()))
  );

-- ═══ Guard: the four document tables now say the same thing ══════════════════

DO $do$
DECLARE
  v_ref text;
  v_bad text;
BEGIN
  SELECT qual INTO v_ref FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'quotations' AND cmd = 'UPDATE';

  SELECT string_agg(tablename || '(' || cmd || ')', ', ') INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('crm_invoices', 'credit_notes', 'sales_orders')
     AND cmd = 'UPDATE'
     AND (qual IS DISTINCT FROM v_ref OR with_check IS DISTINCT FROM v_ref);

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: UPDATE policy on % does not match quotations.', v_bad;
  END IF;

  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
        AND tablename IN ('crm_invoices', 'credit_notes') AND cmd IN ('UPDATE', 'ALL')) <> 2 THEN
    RAISE EXCEPTION 'Refusing to finish: expected exactly one UPDATE policy on each table; another permissive policy would reopen the gap.';
  END IF;

  RAISE NOTICE 'BUG-086: crm_invoices and credit_notes UPDATE policies now match quotations and sales_orders.';
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP POLICY sales_update_crm_invoices ON public.crm_invoices;
--   CREATE POLICY manager_update_crm_invoices ON public.crm_invoices FOR UPDATE
--     USING (rma_is_manager_or_above() OR assigned_rep = rma_current_user_email() OR created_by = rma_current_user_email())
--     WITH CHECK (rma_is_manager_or_above() OR assigned_rep = rma_current_user_email() OR created_by = rma_current_user_email());
--   (and the same for credit_notes) — which reopens the gap.
