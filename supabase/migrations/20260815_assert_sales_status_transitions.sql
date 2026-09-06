-- A sales document may only change status the way the workflow allows.
-- (Audit finding BUG-034, and it closes an exploitable gap left by BUG-002.)
--
-- ── The gap this closes, measured ────────────────────────────────────────────
--
-- 20260809 froze a financial document once it LEAVES draft. That was the right
-- boundary for the finding it fixed, and it left one open: while a document is
-- still a draft, its status column is ordinary and writable by its owner. So:
--
--   rep, on their own draft invoice:
--     PATCH crm_invoices {"doc_status":"posted","posted_at":"..."}   -> succeeded
--   rep, on their own draft credit note:
--     PATCH credit_notes {"status":"issued","issued_at":"..."}       -> succeeded
--
-- Both were reproduced against this database in a rolled-back transaction
-- before this migration was written. Neither is cosmetic:
--
-- post_invoice() opens with `IF NOT rma_is_manager_or_above() THEN RAISE`, then
-- assigns the gapless inv_code from nextval_for_type('invoice'), checks that the
-- serialized units the invoice bills are actually reserved against its sales
-- order, delivers them, and computes COGS. Writing doc_status by hand skips all
-- of it: posted revenue lands in the ledger with a NULL invoice code, no stock
-- check, and no cost — and a sales rep, who post_invoice would have refused,
-- did the posting.
--
-- issue_credit_note() is the same shape: manager check, gapless cn_code,
-- remaining_balance, and application against the source invoice.
--
-- So this is an authority bypass and an integrity bypass at once, and it is
-- reachable by the role least entitled to it.
--
-- ── The shape of the fix ─────────────────────────────────────────────────────
--
-- What BUG-034 actually asked for: port assert_purchase_status_transition to
-- the sales documents. This is that function's sibling, written in the same
-- style — one function, a CASE on TG_TABLE_NAME, a per-status allow-list — and
-- the map is deliberately expressed as what a BROWSER may do. Everything the
-- RPCs do is out of scope by construction, because they run as their owner and
-- return at the first branch.
--
-- The three maps were built from the client helpers and the screens that call
-- them, not from imagination:
--
--   crm_invoices   cancelDraft() is the only client status write in src/.
--                  Posting and voiding are post_invoice()/void_invoice().
--                  -> draft may be cancelled. Nothing else.
--
--   credit_notes   There is NO client status write at all: creditNotes.update()
--                  is typed Pick<'line_items'|'reason'|'assigned_rep'|
--                  'source_invoice_number'> and cannot reach the column.
--                  issue/void/apply are all RPCs.
--                  -> a browser may not move a credit note at all.
--
--   quotations     Read off the buttons. Send for approval from draft; Cancel
--                  offered from draft/sent/accepted and hidden once converted;
--                  Reopen offered only from cancelled/declined and sets 'sent'.
--                  Convert is the convert_quotation_to_so RPC.
--
-- ── The converted quotation ──────────────────────────────────────────────────
--
-- 'converted' is terminal for a client, which is the specific inconsistency
-- BUG-034 named: quotations.cancel() would happily cancel a quotation that had
-- already become a sales order, orphaning the order behind it. The interface
-- already hides the button in that state; now the database agrees rather than
-- relying on the button staying hidden.
--
-- ── What is NOT fixed here ───────────────────────────────────────────────────
--
-- The other half of BUG-034 is a user-interface inconsistency, not a database
-- one: "reopen" means markSent() -> 'sent' on the Sales Documents screen and
-- quotations.reopen() -> 'draft' in the deal screen's action map. Both targets
-- are permitted below so neither screen breaks, but making the word mean one
-- thing is an application change and is left to that.

CREATE OR REPLACE FUNCTION public.rma_assert_sales_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_col     text;
  v_old     text;
  v_new     text;
  v_allowed text[];
  v_hint    text;
BEGIN
  -- The RPCs run as the function owner and are the intended writers.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Backup & Restore upserts these tables from the browser and is admin-gated.
  -- Consistent with 20260808/20260809/20260813.
  IF public.rma_is_admin() THEN
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
$fn$;

COMMENT ON FUNCTION public.rma_assert_sales_status_transition() IS
  'Sales-side sibling of assert_purchase_status_transition(). Constrains what a BROWSER may do to doc_status/status on crm_invoices, credit_notes and quotations; SECURITY DEFINER callers (post_invoice, issue_credit_note, void_*, convert_quotation_to_so) and administrators pass through.';

DROP TRIGGER IF EXISTS trg_crm_invoices_assert_transition ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_assert_transition
  BEFORE UPDATE ON public.crm_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_assert_sales_status_transition();

DROP TRIGGER IF EXISTS trg_credit_notes_assert_transition ON public.credit_notes;
CREATE TRIGGER trg_credit_notes_assert_transition
  BEFORE UPDATE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.rma_assert_sales_status_transition();

DROP TRIGGER IF EXISTS trg_quotations_assert_transition ON public.quotations;
CREATE TRIGGER trg_quotations_assert_transition
  BEFORE UPDATE ON public.quotations
  FOR EACH ROW EXECUTE FUNCTION public.rma_assert_sales_status_transition();

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- Prove the exploit is closed and the legitimate path still open, on throwaway
-- rows, before this migration is allowed to commit.

DO $do$
DECLARE
  v_rep      text;
  v_customer uuid;
  v_inv      uuid;
  v_qt       uuid;
  v_blocked  boolean := false;
BEGIN
  SELECT user_email INTO v_rep
    FROM public.user_roles
   WHERE role IN ('sales_rep', 'manager') AND status = 'active'
   LIMIT 1;
  SELECT id INTO v_customer FROM public.customers LIMIT 1;

  IF v_rep IS NULL OR v_customer IS NULL THEN
    RAISE NOTICE 'Skipping the behavioural guard: no active non-admin staff member or customer. Run supabase/manual/20260853 by hand.';
    RETURN;
  END IF;

  INSERT INTO public.crm_invoices
    (customer_id, doc_status, payment_status, line_items,
     subtotal, discount_amount, tax_amount, total, amount_paid, created_by, assigned_rep)
  VALUES (v_customer, 'draft', 'unpaid', '[]'::jsonb, 0, 0, 0, 100, 0, v_rep, v_rep)
  RETURNING id INTO v_inv;

  INSERT INTO public.quotations
    (qt_code, customer_id, status, line_items,
     subtotal, discount_amount, tax_amount, total, created_by, assigned_rep)
  VALUES ('QT-GUARD-' || substr(gen_random_uuid()::text, 1, 8), v_customer, 'converted', '[]'::jsonb,
          0, 0, 0, 0, v_rep, v_rep)
  RETURNING id INTO v_qt;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_rep, 'role', 'authenticated')::text, true);

  -- Must be refused: the posting bypass.
  BEGIN
    UPDATE public.crm_invoices SET doc_status = 'posted' WHERE id = v_inv;
  EXCEPTION WHEN raise_exception THEN
    v_blocked := true;
  END;

  IF NOT v_blocked THEN
    RESET ROLE;
    DELETE FROM public.crm_invoices WHERE id = v_inv;
    DELETE FROM public.quotations   WHERE id = v_qt;
    RAISE EXCEPTION
      'Refusing to apply: a draft invoice can still be posted by a direct write. Nothing has been changed.';
  END IF;

  -- Must still be allowed: cancelling a draft.
  BEGIN
    UPDATE public.crm_invoices SET doc_status = 'cancelled' WHERE id = v_inv;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE EXCEPTION
      'Refusing to apply: cancelling a draft invoice is now refused (SQLSTATE %). The map is too tight. Nothing has been changed.',
      SQLSTATE;
  END;

  -- Must be refused: cancelling a quotation that is already a sales order.
  v_blocked := false;
  BEGIN
    UPDATE public.quotations SET status = 'cancelled' WHERE id = v_qt;
  EXCEPTION WHEN raise_exception THEN
    v_blocked := true;
  END;

  RESET ROLE;

  IF NOT v_blocked THEN
    DELETE FROM public.crm_invoices WHERE id = v_inv;
    DELETE FROM public.quotations   WHERE id = v_qt;
    RAISE EXCEPTION
      'Refusing to apply: a converted quotation can still be cancelled, orphaning its sales order. Nothing has been changed.';
  END IF;

  DELETE FROM public.crm_invoices WHERE id = v_inv;
  DELETE FROM public.quotations   WHERE id = v_qt;

  RAISE NOTICE 'Guard verified: a draft invoice cannot be posted by hand, a draft can still be cancelled, and a converted quotation is terminal.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- supabase/manual/20260853_verify_sales_status_transitions.sql
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_crm_invoices_assert_transition ON public.crm_invoices;
--   DROP TRIGGER trg_credit_notes_assert_transition ON public.credit_notes;
--   DROP TRIGGER trg_quotations_assert_transition   ON public.quotations;
--   DROP FUNCTION public.rma_assert_sales_status_transition();
