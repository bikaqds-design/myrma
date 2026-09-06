-- Freeze a financial document once it leaves draft.  (Audit finding BUG-002)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- manager_update_crm_invoices reads
--
--   USING (rma_is_manager_or_above()
--          OR assigned_rep = rma_current_user_email()
--          OR created_by   = rma_current_user_email())
--
-- with no WITH CHECK, and nothing else stood between a rep and a posted
-- invoice. Ownership therefore granted an unrestricted UPDATE of every column:
-- payment_status, amount_paid, total, line_items, doc_status, inv_code,
-- customer_id, assigned_rep. The client only ever sends a subset, so the
-- interface hid it; PostgREST does not.
--
-- One thing that is NOT a defect, written down because the first draft of this
-- migration claimed it was: the missing WITH CHECK. For an UPDATE policy
-- Postgres reuses the USING expression as the check on the new row whenever
-- WITH CHECK is omitted, so a rep could never hand a document away by writing
-- assigned_rep. Measured rather than argued — as of today, before this
-- migration, that attempt is refused with 42501. The clauses added in part 3
-- below therefore change no behaviour at all. They are written out so that a
-- later edit to USING alone cannot silently widen what the new row must satisfy.
--
-- credit_notes carried the same policy shape. payments and vendor_payments
-- carried a weaker one still: manager_update_payments is
-- `rma_is_manager_or_above() OR created_by = me`, which is not gated on a cash
-- role at all, so whoever created a payment could rewrite its amount after the
-- fact.
--
-- ── The shape of the fix ─────────────────────────────────────────────────────
--
-- Two different problems, so two different mechanisms.
--
-- payments / vendor_payments have NO legitimate client UPDATE. Every mutation
-- goes through record_payment, apply_*_to_invoice, void_* or reverse_*; the
-- ten places src/ touches these tables are all selects. So the policy is simply
-- narrowed to rma_is_admin(), exactly as 20260808 did for their INSERTs, and
-- for the same reason: Backup & Restore upserts them from the browser and is
-- admin-gated.
--
-- crm_invoices / credit_notes DO have a legitimate client UPDATE — a draft is
-- edited in the document form, and Archive stays available at every status. A
-- blanket lock would break both. So the policy keeps its ownership rule (plus
-- the WITH CHECK it was missing) and a trigger decides what may still change
-- once the document is settled.
--
-- ── How the trigger tells an RPC from a REST call ────────────────────────────
--
-- A trigger fires for both, so it needs a discriminator. Inside a SECURITY
-- DEFINER function current_user is the function owner; a PostgREST request runs
-- with the role it switched to. Measured on this database rather than assumed:
--
--   direct write            -> current_user = 'authenticated'
--   inside SECURITY DEFINER -> current_user = 'postgres'
--
-- So the guard enforces only for 'authenticated' and 'anon', and stands aside
-- for the RPCs, the trigger functions and any service-role backend. Nothing in
-- post_invoice, void_invoice, apply_payment_to_invoice, issue_credit_note or
-- the reversal functions has to change.
--
-- Administrators are exempt for the restore path, consistent with 20260808.
-- That is not a segregation boundary: it is the difference between seventeen
-- accounts being able to rewrite a posted invoice and four.
--
-- ── Why an allow-list rather than a list of protected columns ────────────────
--
-- The guard compares to_jsonb(OLD) and to_jsonb(NEW) with the permitted keys
-- removed, so a column added to either table later is frozen by default. Naming
-- the protected columns instead would mean every future money column is
-- unprotected until somebody remembers this file.

-- ═══ 1. payments and vendor_payments: no client UPDATE at all ════════════════

DROP POLICY IF EXISTS manager_update_payments ON public.payments;

CREATE POLICY admin_update_payments ON public.payments
  FOR UPDATE TO public
  USING (public.rma_is_admin())
  WITH CHECK (public.rma_is_admin());

COMMENT ON POLICY admin_update_payments ON public.payments IS
  'Restore only. Payments are mutated by record_payment(), apply_payment_to_invoice(), void_payment() and reverse_payment_application(), all SECURITY DEFINER and all bypassing RLS. The previous policy let whoever created a payment rewrite its amount.';

DROP POLICY IF EXISTS manager_update_vendor_payments ON public.vendor_payments;

CREATE POLICY admin_update_vendor_payments ON public.vendor_payments
  FOR UPDATE TO public
  USING (public.rma_is_admin())
  WITH CHECK (public.rma_is_admin());

COMMENT ON POLICY admin_update_vendor_payments ON public.vendor_payments IS
  'Restore only - see admin_update_payments.';

-- ═══ 2. The guard for documents that have a draft stage ══════════════════════

CREATE OR REPLACE FUNCTION public.rma_guard_settled_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  -- TG_ARGV[0] is the column holding the document's status; the rest are the
  -- columns that may still change after it leaves draft, on top of the archive
  -- fields every document shares.
  v_status_col text   := TG_ARGV[0];
  v_allowed    text[] := ARRAY['archived', 'archived_at', 'archived_by', 'updated_at'];
  v_status     text;
  i            integer;
BEGIN
  -- Only the client surface is policed. An RPC runs as the function owner and
  -- is the intended way to change a settled document.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Backup & Restore writes these tables directly, and only an administrator
  -- can reach it.
  IF public.rma_is_admin() THEN
    RETURN NEW;
  END IF;

  v_status := to_jsonb(OLD) ->> v_status_col;

  -- A draft is still being written. Editing it is the whole point of the form.
  IF v_status = 'draft' THEN
    RETURN NEW;
  END IF;

  FOR i IN 1 .. TG_NARGS - 1 LOOP
    v_allowed := v_allowed || TG_ARGV[i];
  END LOOP;

  IF (to_jsonb(OLD) - v_allowed) IS DISTINCT FROM (to_jsonb(NEW) - v_allowed) THEN
    RAISE EXCEPTION
      'This % is % and can no longer be edited directly. Use the void or reversal action instead — it restores the stock and the customer balance, which a direct edit does not.',
      replace(TG_TABLE_NAME, '_', ' '), v_status
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.rma_guard_settled_document() IS
  'Freezes a financial document once it leaves draft, for direct client writes only. SECURITY DEFINER callers (every money RPC) and administrators (Backup & Restore) pass through. TG_ARGV[0] is the status column; any further arguments name columns that may still change.';

-- ── crm_invoices ─────────────────────────────────────────────────────────────
-- Nothing beyond the archive fields: the Sales Documents screen only offers
-- Edit while doc_status = 'draft', and Archive at any status.

DROP TRIGGER IF EXISTS trg_crm_invoices_lock_settled ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_lock_settled
  BEFORE UPDATE ON public.crm_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_settled_document('doc_status');

-- ── credit_notes ─────────────────────────────────────────────────────────────
-- restock_status is the exception. creditNotes.restoreUnits() sets it to
-- 'restocked' from the browser immediately after the restore_units RPC, on a
-- credit note that is already 'issued'. Folding that write into the RPC is the
-- better answer and is tracked as BUG-031; until then, blocking it here would
-- break returning goods against a credit note.

DROP TRIGGER IF EXISTS trg_credit_notes_lock_settled ON public.credit_notes;
CREATE TRIGGER trg_credit_notes_lock_settled
  BEFORE UPDATE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_settled_document('status', 'restock_status');

-- ═══ 3. Write the implicit check out in full ═════════════════════════════════
-- Identical to USING, which is what Postgres already applies to the new row.
-- This is documentation enforced by the database, not a behaviour change: it
-- means someone widening USING later has to decide, in the same statement,
-- whether the new row should be held to the same rule.

DROP POLICY IF EXISTS manager_update_crm_invoices ON public.crm_invoices;

CREATE POLICY manager_update_crm_invoices ON public.crm_invoices
  FOR UPDATE TO public
  USING (
    public.rma_is_manager_or_above()
    OR assigned_rep = public.rma_current_user_email()
    OR created_by   = public.rma_current_user_email()
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR assigned_rep = public.rma_current_user_email()
    OR created_by   = public.rma_current_user_email()
  );

DROP POLICY IF EXISTS manager_update_credit_notes ON public.credit_notes;

CREATE POLICY manager_update_credit_notes ON public.credit_notes
  FOR UPDATE TO public
  USING (
    public.rma_is_manager_or_above()
    OR assigned_rep = public.rma_current_user_email()
    OR created_by   = public.rma_current_user_email()
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR assigned_rep = public.rma_current_user_email()
    OR created_by   = public.rma_current_user_email()
  );

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- The SQL editor runs a script in one implicit transaction, so a RAISE here
-- rolls back everything above it.

DO $do$
DECLARE
  r         record;
  v_bad     text[] := ARRAY[]::text[];
  v_rpcs    text[] := ARRAY[
    'post_invoice', 'void_invoice', 'issue_credit_note', 'void_credit_note',
    'record_payment', 'record_vendor_payment',
    'apply_payment_to_invoice', 'apply_credit_note_to_invoice',
    'apply_vendor_payment_to_invoice',
    'void_payment', 'void_vendor_payment',
    'reverse_payment_application', 'reverse_credit_note_application',
    'reverse_vendor_payment_application'
  ];
  v_unreachable text[] := ARRAY[]::text[];
BEGIN
  -- 1. Both guard triggers must exist and be enabled.
  FOR r IN
    SELECT unnest(ARRAY['crm_invoices', 'credit_notes']) AS tbl
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p  ON p.oid = t.tgfoid
       WHERE c.relname = r.tbl
         AND p.proname = 'rma_guard_settled_document'
         AND NOT t.tgisinternal
         AND t.tgenabled <> 'D'
    ) THEN
      v_bad := v_bad || format('%s has no enabled settled-document guard', r.tbl);
    END IF;
  END LOOP;

  -- 2. Every UPDATE policy on the four tables must state its WITH CHECK. Not
  --    because omitting it is unsafe — Postgres falls back to USING — but
  --    because this migration claims to have written them all out, and a
  --    half-applied script that left one implicit should not pass silently.
  FOR r IN
    SELECT c.relname AS tbl, p.polname AS pol
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('crm_invoices', 'credit_notes', 'payments', 'vendor_payments')
       AND p.polcmd IN ('w', '*')
       AND p.polwithcheck IS NULL
  LOOP
    v_bad := v_bad || format('%s.%s is an UPDATE policy with no WITH CHECK', r.tbl, r.pol);
  END LOOP;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: %. Nothing has been changed.', array_to_string(v_bad, '; ');
  END IF;

  -- 3. Every money RPC must still be reachable, or the screens break on deploy.
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY(v_rpcs)
  LOOP
    IF NOT has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      v_unreachable := v_unreachable || r.proname;
    END IF;
  END LOOP;

  IF array_length(v_unreachable, 1) > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: the application calls these functions but authenticated can no longer execute them: %. Nothing has been changed.',
      array_to_string(v_unreachable, ', ');
  END IF;

  RAISE NOTICE 'Settled invoices and credit notes are now frozen for direct client writes; payments and vendor payments accept no client UPDATE.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260848_verify_settled_document_lock.sql. It simulates
-- the rep who owns a posted invoice and asserts the rewrite is refused, then
-- asserts that archiving it still works and that a draft is still editable.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_crm_invoices_lock_settled ON public.crm_invoices;
--   DROP TRIGGER trg_credit_notes_lock_settled ON public.credit_notes;
--   DROP FUNCTION public.rma_guard_settled_document();
--   -- and recreate manager_update_payments / manager_update_vendor_payments as
--   -- USING (rma_is_manager_or_above() OR created_by = rma_current_user_email())
--   -- with no WITH CHECK, and drop the WITH CHECK from the two sales policies.
