-- ============================================================================
-- 20260875_protect_posted_financial_history.sql          (BL-01 / I-01)
--
-- A posted financial document must not be editable or deletable by anyone from
-- the client, administrators included. Corrections go through the void, credit
-- and reversal RPCs, which run as the function owner.
--
-- Four gaps, all confirmed against the live schema on 2026-09-20:
--
-- 1. Admin bypass in three guard triggers. rma_guard_settled_document,
--    rma_assert_sales_status_transition and rma_guard_sales_order_status each
--    returned early for rma_is_admin(). Their comments say Backup & Restore
--    "upserts from the browser". It no longer does: restore is
--    rma_restore_begin -> rma_restore_stage -> rma_restore_apply, all
--    SECURITY DEFINER, so the trigger's first check
--    (current_user NOT IN ('authenticated','anon')) already lets it through.
--    The admin branch was dead for restore and live only for an administrator
--    editing a posted invoice from the browser, which is the hole.
--
-- 2. Admin hard-delete of any quotation, sales order, invoice or credit note,
--    posted or not, with no error — the RLS policy was `rma_is_admin()` and
--    nothing enforced draft-only deletion. A DELETE policy alone cannot fix
--    this with a clear error: a restrictive `USING (... AND status='draft')`
--    filters the row out of the DELETE's visible set before any trigger runs,
--    so a forbidden delete would just silently affect 0 rows — indprintable
--    from the RPC result, easy to miss, and no message telling the admin why.
--    So the policy is left as `rma_is_admin()` and a BEFORE DELETE guard,
--    added to rma_guard_settled_document itself, raises P0001 with a clear
--    reason when the targeted row is not a draft.
--
-- 3. No lock at all on purchase_orders or vendor_invoices. A confirmed PO's
--    lines and prices, and an approved vendor invoice's, stayed editable.
--
-- 4. rma_report_financial filtered invoices by created_at and counted drafts
--    as invoiced. It now reports posted invoices by posted_at.
-- ============================================================================

-- ── 1. Remove the admin bypass; add a DELETE guard for the same rule ────────
-- One function, two events: BEFORE UPDATE keeps every non-archive column
-- frozen once a document leaves draft (unchanged from before except the
-- admin exemption); BEFORE DELETE refuses to remove anything but a draft.

CREATE OR REPLACE FUNCTION public.rma_guard_settled_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  -- TG_ARGV[0] is the column holding the document's status; the rest (UPDATE
  -- only) are columns that may still change after it leaves draft, on top of
  -- the archive fields every document shares.
  v_status_col text   := TG_ARGV[0];
  v_allowed    text[] := ARRAY['archived', 'archived_at', 'archived_by', 'updated_at'];
  v_generated  text[];
  v_status     text;
  i            integer;
BEGIN
  -- Only the client surface is policed. An RPC runs as the function owner and
  -- is the intended way to change or remove a settled document. That includes
  -- rma_restore_apply, so Backup & Restore needs no exemption of its own.
  -- There is deliberately no administrator exemption (20260875): an admin who
  -- can rewrite or delete a posted invoice can rewrite the books.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_status := to_jsonb(OLD) ->> v_status_col;
    IF v_status = 'draft' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'This % is % and cannot be deleted. Use the void, cancel or reversal action instead — deleting it would remove the record without reversing what it did.',
      replace(TG_TABLE_NAME, '_', ' '), v_status
      USING ERRCODE = 'P0001';
  END IF;

  v_status := to_jsonb(OLD) ->> v_status_col;

  -- A draft is still being written. Editing it is the whole point of the form.
  IF v_status = 'draft' THEN
    RETURN NEW;
  END IF;

  FOR i IN 1 .. TG_NARGS - 1 LOOP
    v_allowed := v_allowed || TG_ARGV[i];
  END LOOP;

  -- Stored generated columns read as NULL in NEW here. They are unwritable by
  -- any client and derived from columns this guard protects, so ignoring them
  -- is safe.
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
$function$;

DROP TRIGGER IF EXISTS trg_crm_invoices_lock_settled ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_lock_settled
  BEFORE UPDATE OR DELETE ON public.crm_invoices
  FOR EACH ROW EXECUTE FUNCTION rma_guard_settled_document('doc_status');

DROP TRIGGER IF EXISTS trg_credit_notes_lock_settled ON public.credit_notes;
CREATE TRIGGER trg_credit_notes_lock_settled
  BEFORE UPDATE OR DELETE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION rma_guard_settled_document('status', 'restock_status');

-- quotations and sales_orders already have their own UPDATE guards
-- (rma_assert_sales_status_transition / rma_guard_sales_order_status, both
-- fixed below); they only need the DELETE half added here.
DROP TRIGGER IF EXISTS trg_quotations_lock_settled_delete ON public.quotations;
CREATE TRIGGER trg_quotations_lock_settled_delete
  BEFORE DELETE ON public.quotations
  FOR EACH ROW EXECUTE FUNCTION rma_guard_settled_document('status');

DROP TRIGGER IF EXISTS trg_sales_orders_lock_settled_delete ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_lock_settled_delete
  BEFORE DELETE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION rma_guard_settled_document('status');

CREATE OR REPLACE FUNCTION public.rma_assert_sales_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_col     text;
  v_old     text;
  v_new     text;
  v_allowed text[];
  v_hint    text;
BEGIN
  -- The RPCs run as the function owner and are the intended writers (restore
  -- included). No administrator exemption: see 20260875.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- crm_invoices calls it doc_status; the other two call it status.
  v_col := CASE TG_TABLE_NAME WHEN 'crm_invoices' THEN 'doc_status' ELSE 'status' END;
  v_old := to_jsonb(OLD) ->> v_col;
  v_new := to_jsonb(NEW) ->> v_col;

  -- The document forms post the whole row back on save, so an unchanged status
  -- is the ordinary case and must pass.
  IF v_new IS NOT DISTINCT FROM v_old THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'crm_invoices' THEN
    v_allowed := CASE v_old
      WHEN 'draft' THEN ARRAY['cancelled']
      ELSE ARRAY[]::text[]
    END;
    v_hint := 'Posting is post_invoice() (it assigns the invoice number, checks the stock is reserved and records the cost); voiding is void_invoice().';

  ELSIF TG_TABLE_NAME = 'credit_notes' THEN
    -- No client status write exists, so none is permitted.
    v_allowed := ARRAY[]::text[];
    v_hint := 'Issuing is issue_credit_note(), voiding is void_credit_note(), and applying one to an invoice is apply_credit_note_to_invoice().';

  ELSE  -- quotations
    v_allowed := CASE v_old
      WHEN 'draft'     THEN ARRAY['sent', 'cancelled']
      WHEN 'sent'      THEN ARRAY['accepted', 'declined', 'expired', 'cancelled', 'draft']
      WHEN 'accepted'  THEN ARRAY['declined', 'cancelled', 'draft']
      WHEN 'declined'  THEN ARRAY['sent', 'draft', 'cancelled']
      WHEN 'expired'   THEN ARRAY['sent', 'draft', 'cancelled']
      WHEN 'cancelled' THEN ARRAY['sent', 'draft']
      -- It is a sales order now. Cancelling it here would orphan that order.
      WHEN 'converted' THEN ARRAY[]::text[]
      ELSE ARRAY[]::text[]
    END;
    v_hint := 'Converting a quotation is convert_quotation_to_so(), which creates the sales order at the same time.';
  END IF;

  IF NOT (v_new = ANY (v_allowed)) THEN
    RAISE EXCEPTION
      'Illegal % status change: % -> %. Allowed from "%": %. %',
      replace(TG_TABLE_NAME, '_', ' '),
      v_old,
      v_new,
      v_old,
      CASE WHEN array_length(v_allowed, 1) IS NULL
           THEN 'nothing by editing the document'
           ELSE array_to_string(v_allowed, ', ')
      END,
      v_hint
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rma_guard_sales_order_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- The RPCs run as the function owner. They are the intended writers, and
  -- that includes rma_restore_apply. No administrator exemption: see 20260875.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- The document forms post the whole row back on save, so an unchanged status
  -- is the normal case and must pass — editing a draft's line items is not a
  -- transition.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Submitting for approval, and re-submitting one that came back declined.
  IF NEW.status = 'sent' AND OLD.status IN ('draft', 'sent', 'declined') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'A sales order cannot be moved from % to % by editing it. Use the %.',
    OLD.status,
    NEW.status,
    CASE NEW.status
      WHEN 'delivered' THEN 'Accept action, which reserves the stock at the same time (approve_sales_order)'
      WHEN 'accepted'  THEN 'Accept action, which reserves the stock at the same time (approve_sales_order)'
      WHEN 'confirmed' THEN 'Accept action, which reserves the stock at the same time (approve_sales_order)'
      WHEN 'declined'  THEN 'Reject action (reject_sales_order)'
      WHEN 'cancelled' THEN 'Cancel action, which releases any reservation (cancel_sales_order)'
      ELSE 'documented action for that transition'
    END
    USING ERRCODE = 'P0001';
END;
$function$;

-- ── 2. Lock confirmed purchase orders and approved vendor invoices ──────────
-- Separate from rma_guard_settled_document because "still editable" is not
-- just 'draft' here: a PO is written through draft, sent and
-- pending_confirmation, a vendor invoice through draft and pending_approval.
-- TG_ARGV[0] is the status column, TG_ARGV[1] a comma-separated list of the
-- statuses in which the document is still editable, and the rest are the
-- columns that may still change afterwards.
--
-- `status` stays writable after the lock: which transitions are legal is the
-- job of assert_purchase_status_transition and rma_guard_approval_authority,
-- so cancelling a confirmed PO is not blocked here. Prices, quantities,
-- currency, vendor and totals are.

CREATE OR REPLACE FUNCTION public.rma_guard_locked_purchase_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status_col text   := TG_ARGV[0];
  v_editable   text[] := string_to_array(TG_ARGV[1], ',');
  v_allowed    text[] := ARRAY['status', 'archived', 'archived_at', 'archived_by', 'updated_at'];
  v_generated  text[];
  v_status     text;
  i            integer;
BEGIN
  -- Only the client surface is policed. receive_vendor_invoice, the payment
  -- RPCs and rma_restore_apply run as the function owner.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  v_status := to_jsonb(OLD) ->> v_status_col;

  IF v_status = ANY (v_editable) THEN
    RETURN NEW;
  END IF;

  FOR i IN 2 .. TG_NARGS - 1 LOOP
    v_allowed := v_allowed || TG_ARGV[i];
  END LOOP;

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
      'This % is % and can no longer be edited. Cancel it and raise a new one, or use the amend action, instead of changing prices or quantities after approval.',
      replace(TG_TABLE_NAME, '_', ' '), v_status
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.rma_guard_locked_purchase_document() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rma_guard_locked_purchase_document() TO service_role;

DROP TRIGGER IF EXISTS trg_purchase_orders_lock_confirmed ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_lock_confirmed
  BEFORE UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_locked_purchase_document(
    'status', 'draft,sent,pending_confirmation');

-- amount_paid / payment_status / paid_at / received_at / approved_at are
-- written by the payment and receipt RPCs, which are exempt as the owner, but
-- listing them keeps a client-side status change from tripping the guard.
DROP TRIGGER IF EXISTS trg_vendor_invoices_lock_approved ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_lock_approved
  BEFORE UPDATE ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_locked_purchase_document(
    'status', 'draft,pending_approval',
    'approved_at', 'approved_by', 'received_at', 'amount_paid', 'payment_status', 'paid_at');

-- ── 3. The financial report counts posted invoices by posting date ──────────

CREATE OR REPLACE FUNCTION public.rma_report_financial(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- A draft is not revenue and a cancelled (voided) invoice is reversed. Only a
  -- posted invoice counts, and it counts in the period it was posted, not the
  -- one in which someone first typed it up.
  WITH inv AS (
    SELECT * FROM public.crm_invoices
     WHERE doc_status = 'posted'
       AND posted_at IS NOT NULL AND posted_at >= p_from AND posted_at <= p_to
  )
  SELECT jsonb_build_object(
    'invoices', (SELECT count(*) FROM inv),
    'total_invoiced', (SELECT coalesce(sum(coalesce(total, 0)), 0) FROM inv),
    'total_paid', (SELECT coalesce(sum(coalesce(amount_paid, 0)), 0) FROM inv),
    'outstanding', (SELECT coalesce(sum(greatest(coalesce(total, 0) - coalesce(amount_paid, 0), 0)), 0) FROM inv),
    'quotes_value', (SELECT coalesce(sum(coalesce(total, 0)), 0) FROM public.quotations
                      WHERE created_at IS NOT NULL AND created_at >= p_from AND created_at <= p_to
                        AND status IS DISTINCT FROM 'cancelled' AND status IS DISTINCT FROM 'declined'
                        AND status IS DISTINCT FROM 'expired')
  );
$function$;
