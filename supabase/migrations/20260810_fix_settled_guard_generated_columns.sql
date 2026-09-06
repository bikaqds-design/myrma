-- Fix rma_guard_settled_document(): stored generated columns made it refuse
-- every post-draft write.  (Regression in 20260809, audit finding BUG-002)
--
-- ── What went wrong ──────────────────────────────────────────────────────────
--
-- 20260809 compares the row before and after with the permitted keys removed:
--
--     IF (to_jsonb(OLD) - v_allowed) IS DISTINCT FROM (to_jsonb(NEW) - v_allowed)
--
-- That is sound only if every key in NEW means what it appears to mean. Stored
-- generated columns do not. Postgres computes them AFTER all BEFORE ROW
-- triggers have run, so inside the trigger NEW holds NULL for them while OLD
-- holds the stored value. Every update therefore looked like it changed
-- something, and the guard refused all of them.
--
-- Both guarded tables have one:
--
--     crm_invoices.cogs_complete    (cogs_base IS NOT NULL AND cogs_unknown_qty = 0)
--     credit_notes.affects_inventory (type = 'rma_return')
--
-- Measured, not deduced. A diagnostic trigger placed ahead of the guard on a
-- posted fixture invoice reported the archive attempt as:
--
--     archived [false -> true]  archived_at [NULL -> ...]
--     archived_by [NULL -> ...] cogs_complete [false -> NULL]
--
-- The verification script caught this on the first run — archiving a settled
-- document is offered at every status by the Sales Documents screen, and it had
-- stopped working for everyone except administrators.
--
-- ── The fix, and why it opens nothing ────────────────────────────────────────
--
-- Generated columns are excluded from the comparison, discovered from the
-- catalog rather than named, so a generated column added later is handled
-- without editing this function.
--
-- Skipping them cannot create a hole. Postgres refuses to let any client write
-- a generated column at all — `UPDATE ... SET cogs_complete = true` fails with
-- 428C9 regardless of policy — and the columns they are computed FROM
-- (cogs_base, cogs_unknown_qty, type) are ordinary columns that stay frozen.
-- The derived value cannot move unless its inputs do, and its inputs are
-- protected.
--
-- The catalog lookup runs per row. These are financial documents amended one at
-- a time, and it is a small indexed read; correctness is worth more than the
-- microsecond here.

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
  v_generated  text[];
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

  -- Stored generated columns read as NULL in NEW here — see the header. They
  -- are unwritable by any client and derived from columns this guard protects,
  -- so ignoring them is safe.
  SELECT coalesce(array_agg(a.attname::text), ARRAY[]::text[])
    INTO v_generated
    FROM pg_attribute a
   WHERE a.attrelid = TG_RELID
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND a.attgenerated <> '';

  v_allowed := v_allowed || v_generated;

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
  'Freezes a financial document once it leaves draft, for direct client writes only. SECURITY DEFINER callers (every money RPC) and administrators (Backup & Restore) pass through, as do stored generated columns, which read as NULL in NEW inside a BEFORE trigger and cannot be written by a client anyway. TG_ARGV[0] is the status column; any further arguments name columns that may still change.';

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- Prove the fix on a throwaway row rather than trusting the reasoning: archive a
-- settled invoice as a non-admin and require it to succeed, then require a
-- financial edit to still be refused. Both are undone before the block ends, and
-- a failure of either rolls the whole migration back.

DO $do$
DECLARE
  v_rep      text;
  v_customer uuid;
  v_id       uuid;
  v_blocked  boolean := false;
BEGIN
  SELECT user_email INTO v_rep
    FROM public.user_roles
   WHERE role IN ('sales_rep', 'manager') AND status = 'active'
   LIMIT 1;
  SELECT id INTO v_customer FROM public.customers LIMIT 1;

  IF v_rep IS NULL OR v_customer IS NULL THEN
    RAISE NOTICE 'Skipping the behavioural guard: no active non-admin staff member or no customer to build a fixture from. Run supabase/manual/20260848 by hand.';
    RETURN;
  END IF;

  INSERT INTO public.crm_invoices
    (customer_id, doc_status, payment_status, line_items,
     subtotal, discount_amount, tax_amount, total, amount_paid,
     created_by, assigned_rep, posted_at)
  VALUES (v_customer, 'posted', 'unpaid', '[]'::jsonb, 0, 0, 0, 100, 0, v_rep, v_rep, now())
  RETURNING id INTO v_id;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_rep, 'role', 'authenticated')::text, true);

  -- Must be allowed: this is the regression being fixed.
  BEGIN
    UPDATE public.crm_invoices
       SET archived = true, archived_at = now(), archived_by = v_rep
     WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE EXCEPTION
      'Refusing to apply: archiving a settled invoice is still refused (SQLSTATE %). The guard is too tight and Sales Documents would stay broken. Nothing has been changed.',
      SQLSTATE;
  END;

  -- Must still be refused: the point of the guard.
  BEGIN
    UPDATE public.crm_invoices SET amount_paid = total, payment_status = 'paid' WHERE id = v_id;
  EXCEPTION WHEN raise_exception THEN
    v_blocked := true;
  END;

  RESET ROLE;

  IF NOT v_blocked THEN
    RAISE EXCEPTION
      'Refusing to apply: a settled invoice can still be marked paid by its owner. The guard is not doing its job. Nothing has been changed.';
  END IF;

  DELETE FROM public.crm_invoices WHERE id = v_id;

  RAISE NOTICE 'Guard verified in place: a settled invoice can be archived and cannot be re-priced.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Re-run supabase/manual/20260848_verify_settled_document_lock.sql. Every line
-- should now read PASS or SKIP.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- There is nothing to roll back to: the previous body of this function refused
-- every post-draft client write. If this needs undoing, drop the two triggers
-- named in 20260809 instead.
