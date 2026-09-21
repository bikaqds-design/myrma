-- ============================================================================
-- 20260880_quote_conversion_credit_note_controls.sql — BL-05 / I-05
--
-- Two controls that lived only in the UI, or nowhere.
--
-- QUOTE CONVERSION
--   convert_quotation_to_so turned a DRAFT, SENT or EXPIRED quotation into a
--   sales order. The screen only offers the button from 'accepted', but the
--   database accepted the call from anyone who could make it, and never looked
--   at validity_until. Now: the quotation must be 'accepted', and if its
--   validity date has passed only a manager or above can convert it, and only
--   by giving a reason (at least 10 characters), which is kept on the order
--   (sales_orders.override_reason). "Today" is the tenant's own date
--   (rma_config.timezone), not the server's UTC one: a quote valid "until the
--   20th" is still valid at 01:00 on the 20th in Cairo.
--
-- CREDIT NOTES
--   issue_credit_note capped nothing. 1,200 against a 1,000 invoice, or 500
--   and then 600 against the same one, both issued; a "return" of eleven units
--   from an invoice of ten issued too, as long as the money was small. Now:
--     * a credit note against an invoice may not exceed that invoice's total
--       minus the credit notes already issued against it (voided ones and
--       unissued drafts do not count);
--     * a return or correction may not credit more of a product than the
--       invoice sold, counting what was already credited;
--     * the invoice must be posted and belong to the same customer.
--   The reason becomes a coded field (reason_code: price_adjustment, return,
--   damaged, goodwill, billing_error, rebate) so credits can be reported by
--   reason; the existing free-text reason stays as the detail. A credit note
--   cannot be issued without one.
--   A credit note needs a SECOND person's approval when it is a rebate or
--   discount with no invoice behind it (regardless of amount), or when its
--   total is above rma_config 'credit_note_approval_threshold'. That gives it
--   a new status 'pending_approval': submit_credit_note_for_approval moves a
--   draft into it, the approver (a manager or above who is NOT the creator)
--   issues it with issue_credit_note, and return_credit_note_to_draft sends it
--   back. A note waiting for approval is locked from editing (it is no longer
--   a draft), so what is approved is what is issued. approved_by / approved_at
--   record who and when.
--   With no threshold configured only the invoice-less rebate/discount rule
--   applies: existing behaviour is otherwise unchanged until the tenant sets
--   one. (Decision for the owner: a stricter default for new tenants.)
--
--   The controls are worthless if a note can simply be created past them, and
--   it could: a signed-in user could INSERT a credit note that was already
--   'issued' (with a code and a balance of their choosing), and could write
--   created_by as somebody else, which is what "the approver is not the
--   creator" compares. A trigger now makes a client-created note a draft in
--   the client's own name, and keeps the fields only the RPCs set (code,
--   issued/approved/voided stamps, balances, creator) out of client hands.
--   Backup & Restore is a SECURITY DEFINER RPC, so it is unaffected. The
--   status itself is pinned here too (an administrator could otherwise write
--   'issued' straight past every check, wherever the transition guard's admin
--   bypass still exists), and trying to rewrite a protected field of a settled
--   note is refused loudly, as it was before.
--
--   Found by the independent review and fixed here:
--     * a credit-note line whose quantity is not a plain number (1e3, -5,
--       " 10", abc) counted as ZERO units against the per-product cap;
--     * ticket_id decides which RMA ticket issue_credit_note closes, and a
--       client could rewrite it on its own draft;
--     * an invoice-less "correction" was as free as a rebate but escaped the
--       approval rule;
--     * an administrator can edit a note that is waiting for approval (the
--       settled lock has an admin bypass), so the note is fingerprinted when
--       submitted and must be unchanged when issued;
--     * the approval rule reveals a finance setting: managers only;
--     * existing draft notes had no reason code and no screen to set one, so
--       they could never be issued: drafts are backfilled from their type.
--
-- Idempotent. Not applied to production without the owner's OK.
-- ============================================================================

-- ── columns and constraints ─────────────────────────────────────────────────
ALTER TABLE public.sales_orders  ADD COLUMN IF NOT EXISTS override_reason text;
ALTER TABLE public.credit_notes  ADD COLUMN IF NOT EXISTS reason_code text;
ALTER TABLE public.credit_notes  ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE public.credit_notes  ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.credit_notes  ADD COLUMN IF NOT EXISTS submitted_hash text;

ALTER TABLE public.credit_notes DROP CONSTRAINT IF EXISTS credit_notes_reason_code_check;
ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_reason_code_check
  CHECK (reason_code IS NULL OR reason_code IN
    ('price_adjustment', 'return', 'damaged', 'goodwill', 'billing_error', 'rebate'));

ALTER TABLE public.credit_notes DROP CONSTRAINT IF EXISTS credit_notes_status_check;
ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_status_check
  CHECK (status IN ('draft', 'pending_approval', 'issued', 'applied', 'voided'));

-- Notes drafted before reason codes existed cannot be issued (a code is now
-- required) and there is no screen to set one on an existing note. Derive it
-- from the type, which is what the person meant. Issued notes stay as they
-- were: history is not rewritten.
UPDATE public.credit_notes
   SET reason_code = CASE type
         WHEN 'rma_return' THEN 'return'
         WHEN 'rebate'     THEN 'rebate'
         WHEN 'discount'   THEN 'price_adjustment'
         ELSE 'billing_error'
       END
 WHERE reason_code IS NULL AND status = 'draft';

-- ── a client can only create a draft, in its own name ──────────────────────
CREATE OR REPLACE FUNCTION public.rma_guard_credit_note_client_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only the client surface. An RPC (issue_credit_note, the application
  -- triggers, Backup & Restore) runs as the owner and is the intended writer.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A credit note is created as a draft. Issuing it is issue_credit_note(), which applies the limits and the approval rule.'
        USING ERRCODE = 'P0001';
    END IF;
    -- The maker is whoever is signed in, whatever the browser sent.
    NEW.created_by        := COALESCE(public.rma_current_user_email(), NEW.created_by);
    NEW.cn_code           := NULL;
    NEW.issued_at         := NULL;
    NEW.approved_by       := NULL;
    NEW.approved_at       := NULL;
    NEW.applied_amount    := 0;
    NEW.remaining_balance := 0;
    NEW.voided_at         := NULL;
    NEW.voided_by         := NULL;
    NEW.void_reason       := NULL;
    NEW.submitted_hash    := NULL;
  ELSE
    -- The status moves only through the RPCs. trg_credit_notes_assert_transition
    -- also polices it, but it exempts administrators; this does not.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'The status of a credit note changes when it is submitted, issued, returned or voided, not by editing it.'
        USING ERRCODE = 'P0001';
    END IF;

    -- A settled note: an attempt to rewrite one of these is refused, loudly
    -- (it used to be, via the settled lock, before this trigger reverted the
    -- change ahead of it). On a draft the value is simply kept.
    IF OLD.status <> 'draft' AND (
         NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.cn_code IS DISTINCT FROM OLD.cn_code
      OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.applied_amount IS DISTINCT FROM OLD.applied_amount
      OR NEW.remaining_balance IS DISTINCT FROM OLD.remaining_balance OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
      OR NEW.voided_by IS DISTINCT FROM OLD.voided_by OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
      OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id OR NEW.submitted_hash IS DISTINCT FROM OLD.submitted_hash
    ) THEN
      RAISE EXCEPTION 'This credit note is % and can no longer be edited directly.', OLD.status
        USING ERRCODE = 'P0001';
    END IF;

    -- Fields the RPCs own keep their value. ticket_id decides which RMA ticket
    -- issue_credit_note closes, so it is fixed once the note exists.
    NEW.created_by        := OLD.created_by;
    NEW.cn_code           := OLD.cn_code;
    NEW.issued_at         := OLD.issued_at;
    NEW.approved_by       := OLD.approved_by;
    NEW.approved_at       := OLD.approved_at;
    NEW.applied_amount    := OLD.applied_amount;
    NEW.remaining_balance := OLD.remaining_balance;
    NEW.voided_at         := OLD.voided_at;
    NEW.voided_by         := OLD.voided_by;
    NEW.void_reason       := OLD.void_reason;
    NEW.ticket_id         := OLD.ticket_id;
    NEW.submitted_hash    := OLD.submitted_hash;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.rma_guard_credit_note_client_writes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_guard_credit_note_client_writes() TO service_role;

DROP TRIGGER IF EXISTS trg_credit_notes_guard_client_writes ON public.credit_notes;
CREATE TRIGGER trg_credit_notes_guard_client_writes
  BEFORE INSERT OR UPDATE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_credit_note_client_writes();

-- ── the tenant's own date ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_today()
 RETURNS date
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (now() AT TIME ZONE COALESCE(
            (SELECT z.name FROM pg_timezone_names z
              WHERE z.name = (SELECT NULLIF(c.config_value #>> '{}', '') FROM public.rma_config c WHERE c.config_key = 'timezone')
              LIMIT 1),
            'UTC'))::date
$function$;

REVOKE ALL ON FUNCTION public.rma_today() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_today() TO authenticated, service_role;

-- ── quote conversion ────────────────────────────────────────────────────────
-- Adding a parameter creates a NEW overload; the old one is dropped so a call
-- cannot be routed round the new rules.
DROP FUNCTION IF EXISTS public.convert_quotation_to_so(uuid, text);

CREATE OR REPLACE FUNCTION public.convert_quotation_to_so(
  p_quotation_id uuid, p_actor_email text, p_override_reason text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_qt         record;
  v_so_code    text;
  v_so_id      uuid;
  v_null_lines bigint;
  v_actor      text := COALESCE(public.rma_current_user_email(), p_actor_email);
  v_reason     text := btrim(COALESCE(p_override_reason, ''));
  v_override   text;
BEGIN
  IF NOT COALESCE((public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep'), false) THEN
    RAISE EXCEPTION 'Not authorized to convert quotations' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_qt FROM public.quotations WHERE id = p_quotation_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quotation not found: %', p_quotation_id;
  END IF;

  -- Not merely "not cancelled, declined or converted": only an ACCEPTED quote
  -- is one the customer has agreed to. A draft or sent one has not been.
  IF v_qt.status <> 'accepted' THEN
    RAISE EXCEPTION 'Only an accepted quotation can be converted to a sales order (this one is %).', v_qt.status
      USING ERRCODE = 'P0001';
  END IF;

  IF v_qt.validity_until IS NOT NULL AND v_qt.validity_until < public.rma_today() THEN
    IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
      RAISE EXCEPTION 'This quotation expired on %. Only a manager can convert an expired quotation.', v_qt.validity_until
        USING ERRCODE = 'P0001';
    END IF;
    IF length(v_reason) < 10 THEN
      RAISE EXCEPTION 'This quotation expired on %. A manager can still convert it by giving a reason (at least 10 characters).', v_qt.validity_until
        USING ERRCODE = 'P0001';
    END IF;
    v_override := v_reason;
  END IF;

  SELECT count(*) INTO v_null_lines
  FROM jsonb_array_elements(v_qt.line_items) AS line
  WHERE (line->>'product_id') IS NULL OR (line->>'product_id') = '';

  IF v_null_lines > 0 THEN
    RAISE EXCEPTION '% line(s) have no product — promote them to real products first', v_null_lines;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sales_orders
    WHERE quotation_id = p_quotation_id AND status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Quotation already converted to a sales order';
  END IF;

  v_so_code := public.generate_doc_code('SO');

  INSERT INTO public.sales_orders (
    so_code, quotation_id, customer_id, status, line_items,
    subtotal, discount_amount, tax_amount, total,
    payment_terms, reference_po, notes, assigned_rep, created_by, override_reason
  )
  VALUES (
    v_so_code, p_quotation_id, v_qt.customer_id, 'draft', v_qt.line_items,
    v_qt.subtotal, v_qt.discount_amount, v_qt.tax_amount, v_qt.total,
    v_qt.payment_terms, v_qt.reference_po, v_qt.notes,
    COALESCE(v_qt.assigned_rep, v_actor), v_actor, v_override
  )
  RETURNING id INTO v_so_id;

  UPDATE public.quotations
  SET status = 'converted', updated_at = NOW()
  WHERE id = p_quotation_id;

  RETURN v_so_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.convert_quotation_to_so(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_quotation_to_so(uuid, text, text) TO authenticated, service_role;

-- ── credit-note approval rule ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_credit_note_needs_approval(
  p_type text, p_has_invoice boolean, p_total numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_text      text;
  v_threshold numeric;
BEGIN
  -- The threshold is a finance setting and this answers "is X above it?", so
  -- anyone who could ask repeatedly could read it out. Managers only; a job
  -- with no login (the owner, service_role) passes.
  IF auth.role() IN ('authenticated', 'anon')
     AND NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  -- A rebate, discount or correction with no invoice behind it is money given
  -- away with nothing to check it against: always a second pair of eyes. (An
  -- RMA return is different: it is tied to a ticket and to units.)
  IF NOT p_has_invoice AND p_type IN ('rebate', 'discount', 'correction') THEN
    RETURN true;
  END IF;

  SELECT c.config_value #>> '{}' INTO v_text
    FROM public.rma_config c WHERE c.config_key = 'credit_note_approval_threshold';
  -- Unset, blank or not a plain number = no threshold (never a cast error at issue time).
  IF v_text IS NULL OR v_text !~ '^[0-9]+(\.[0-9]+)?$' THEN
    RETURN false;
  END IF;
  v_threshold := v_text::numeric;

  RETURN p_total > v_threshold;
END;
$function$;

REVOKE ALL ON FUNCTION public.rma_credit_note_needs_approval(text, boolean, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_credit_note_needs_approval(text, boolean, numeric) TO authenticated, service_role;

-- ── credit-note caps (internal: called from the RPCs below) ────────────────
CREATE OR REPLACE FUNCTION public._credit_note_assert_within_caps(p_cn_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cn    record;
  v_inv   record;
  v_prior numeric;
  v_line  record;
  v_sold  numeric;
  v_done  numeric;
BEGIN
  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_cn_id;
  IF v_cn.source_invoice_id IS NULL THEN
    RETURN;                                   -- nothing to cap it against
  END IF;

  -- Lock the invoice so two credit notes issued at once cannot both see the
  -- same remaining room.
  SELECT * INTO v_inv FROM public.crm_invoices WHERE id = v_cn.source_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The invoice this credit note refers to no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF v_inv.doc_status <> 'posted' THEN
    RAISE EXCEPTION 'A credit note can only be issued against a posted invoice (this one is %).', v_inv.doc_status
      USING ERRCODE = 'P0001';
  END IF;
  IF v_inv.customer_id <> v_cn.customer_id THEN
    RAISE EXCEPTION 'This credit note is for a different customer than the invoice it credits.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(c.total), 0) INTO v_prior
    FROM public.credit_notes c
   WHERE c.source_invoice_id = v_inv.id
     AND c.status IN ('issued', 'applied')      -- not drafts, not voided
     AND c.id <> v_cn.id;

  IF v_cn.total > v_inv.total - v_prior THEN
    RAISE EXCEPTION 'This credit note (%) is more than the % still available to credit on the invoice (invoice total %, already credited %).',
      v_cn.total, GREATEST(v_inv.total - v_prior, 0), v_inv.total, v_prior
      USING ERRCODE = 'P0001';
  END IF;

  -- Returns and corrections credit goods, so the units must also add up.
  -- Compared as TEXT ids: a malformed id must not turn into a cast error.
  IF v_cn.type IN ('rma_return', 'correction') THEN
    -- A malformed quantity (1e3, -5, " 10", abc) must not count as ZERO units
    -- credited, which is what let it through the cap.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_cn.line_items) AS l(line)
       WHERE COALESCE(l.line->>'product_id', '') <> ''
         AND COALESCE(l.line->>'qty', '') !~ '^[0-9]+(\.[0-9]+)?$'
    ) THEN
      RAISE EXCEPTION 'A line on this credit note has an invalid quantity. Quantities must be plain positive numbers.'
        USING ERRCODE = 'P0001';
    END IF;
    FOR v_line IN
      SELECT l.line->>'product_id' AS pid,
             SUM(CASE WHEN (l.line->>'qty') ~ '^[0-9]+(\.[0-9]+)?$' THEN (l.line->>'qty')::numeric ELSE 0 END) AS qty
        FROM jsonb_array_elements(v_cn.line_items) AS l(line)
       WHERE COALESCE(l.line->>'product_id', '') <> ''
       GROUP BY 1
    LOOP
      SELECT COALESCE(SUM(CASE WHEN (il.line->>'qty') ~ '^[0-9]+(\.[0-9]+)?$' THEN (il.line->>'qty')::numeric ELSE 0 END), 0)
        INTO v_sold
        FROM jsonb_array_elements(v_inv.line_items) AS il(line)
       WHERE il.line->>'product_id' = v_line.pid;

      SELECT COALESCE(SUM(CASE WHEN (cl.line->>'qty') ~ '^[0-9]+(\.[0-9]+)?$' THEN (cl.line->>'qty')::numeric ELSE 0 END), 0)
        INTO v_done
        FROM public.credit_notes c
        CROSS JOIN LATERAL jsonb_array_elements(c.line_items) AS cl(line)
       WHERE c.source_invoice_id = v_inv.id
         AND c.status IN ('issued', 'applied')
         AND c.id <> v_cn.id
         AND c.type IN ('rma_return', 'correction')
         AND cl.line->>'product_id' = v_line.pid;

      IF v_line.qty + v_done > v_sold THEN
        RAISE EXCEPTION 'This credit note returns % of a product the invoice sold % of (% already credited).',
          v_line.qty, v_sold, v_done
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public._credit_note_assert_within_caps(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._credit_note_assert_within_caps(uuid) TO service_role;

-- ── submit / return ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_credit_note_for_approval(p_cn_id uuid, p_actor_email text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cn record;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to submit credit notes for approval' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_cn_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id USING ERRCODE = 'P0001';
  END IF;
  IF v_cn.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft credit note can be submitted for approval (this one is %).', v_cn.status
      USING ERRCODE = 'P0001';
  END IF;
  IF v_cn.reason_code IS NULL THEN
    RAISE EXCEPTION 'Choose a reason for this credit note before submitting it.' USING ERRCODE = 'P0001';
  END IF;

  -- Fail now, not when the approver opens it: a note that can never be issued
  -- should not wait in someone's queue.
  PERFORM public._credit_note_assert_within_caps(p_cn_id);

  -- Fingerprint what is being put in front of the approver. An administrator
  -- can edit a note that is waiting (the settled lock has an admin bypass), and
  -- what is approved must be what is issued.
  UPDATE public.credit_notes
     SET status = 'pending_approval',
         submitted_hash = md5(concat_ws('|', v_cn.type, v_cn.customer_id::text, COALESCE(v_cn.source_invoice_id::text, ''),
                                        v_cn.total::text, v_cn.subtotal::text, v_cn.line_items::text)),
         updated_at = NOW()
   WHERE id = p_cn_id;
  RETURN 'pending_approval';
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_credit_note_for_approval(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_credit_note_for_approval(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.return_credit_note_to_draft(p_cn_id uuid, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to return credit notes to draft' USING ERRCODE = 'P0001';
  END IF;

  SELECT status INTO v_status FROM public.credit_notes WHERE id = p_cn_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Only a credit note waiting for approval can be sent back to draft (this one is %).', v_status
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.credit_notes SET status = 'draft', submitted_hash = NULL, updated_at = NOW() WHERE id = p_cn_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.return_credit_note_to_draft(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.return_credit_note_to_draft(uuid, text) TO authenticated, service_role;

-- ── issue: caps, reason code, approval ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.issue_credit_note(p_cn_id uuid, p_actor_email text, p_close_ticket boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cn            record;
  v_code          text;
  v_actor         text;
  v_inv_remaining numeric(12,2);
  v_apply_amount  numeric(12,2);
  v_needs         boolean;
  v_approver      text;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to issue credit notes';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_cn_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id;
  END IF;

  IF v_cn.status NOT IN ('draft', 'pending_approval') THEN
    RAISE EXCEPTION 'Credit note is already % - cannot issue again', v_cn.status;
  END IF;

  IF v_cn.reason_code IS NULL THEN
    RAISE EXCEPTION 'Choose a reason for this credit note before issuing it.' USING ERRCODE = 'P0001';
  END IF;

  v_needs := public.rma_credit_note_needs_approval(v_cn.type, v_cn.source_invoice_id IS NOT NULL, v_cn.total);

  IF v_cn.status = 'draft' AND v_needs THEN
    RAISE EXCEPTION 'This credit note needs approval before it can be issued. Submit it for approval; a second manager then issues it.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Anything that waited for approval is approved by whoever issues it, and
  -- that must be somebody other than the person who made it.
  IF v_cn.status = 'pending_approval' THEN
    IF lower(v_actor) = lower(v_cn.created_by) THEN
      RAISE EXCEPTION 'The person who created a credit note cannot approve it. Ask another manager to issue it.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_cn.submitted_hash IS DISTINCT FROM md5(concat_ws('|', v_cn.type, v_cn.customer_id::text, COALESCE(v_cn.source_invoice_id::text, ''),
                                        v_cn.total::text, v_cn.subtotal::text, v_cn.line_items::text)) THEN
      RAISE EXCEPTION 'This credit note was changed after it was submitted for approval. Return it to draft and submit it again.'
        USING ERRCODE = 'P0001';
    END IF;
    v_approver := v_actor;
  END IF;

  PERFORM public._credit_note_assert_within_caps(p_cn_id);

  v_code := public.nextval_for_type('credit_note');

  UPDATE public.credit_notes
  SET cn_code           = v_code,
      status            = 'issued',
      remaining_balance = v_cn.total,
      issued_at         = NOW(),
      approved_by       = v_approver,
      approved_at       = CASE WHEN v_approver IS NULL THEN NULL ELSE NOW() END,
      updated_at        = NOW()
  WHERE id = p_cn_id;

  IF v_cn.source_invoice_id IS NOT NULL THEN
    SELECT GREATEST(total - amount_paid, 0) INTO v_inv_remaining
    FROM public.crm_invoices
    WHERE id = v_cn.source_invoice_id AND doc_status = 'posted'
    FOR UPDATE;

    IF FOUND AND v_inv_remaining > 0 THEN
      v_apply_amount := LEAST(v_cn.total, v_inv_remaining);

      INSERT INTO public.credit_note_applications
        (credit_note_id, invoice_id, amount_applied, applied_by)
      VALUES (p_cn_id, v_cn.source_invoice_id, v_apply_amount, v_actor);

      UPDATE public.crm_invoices
      SET amount_paid    = LEAST(amount_paid + v_apply_amount, total),
          payment_status = CASE
            WHEN LEAST(amount_paid + v_apply_amount, total) >= total THEN 'paid'
            WHEN LEAST(amount_paid + v_apply_amount, total) > 0     THEN 'partial'
            ELSE 'unpaid'
            END,
          paid_at = CASE
            WHEN LEAST(amount_paid + v_apply_amount, total) >= total THEN NOW()
            ELSE paid_at
            END,
          updated_at = NOW()
      WHERE id = v_cn.source_invoice_id;
    END IF;
  END IF;

  -- BUG-048: close the originating ticket in the SAME transaction.
  --
  -- The ticket drawer used to call this RPC and then issue a separate
  -- rmaTickets.update(). If that second write failed -- an RLS no-op for a
  -- technician who is not the assignee, or a dropped connection -- the credit
  -- note was already issued and applied while the ticket stayed open, and
  -- retrying could not help because this function refuses a non-draft note.
  -- There was no way back to a consistent state from the interface.
  --
  -- The ticket id is taken from the credit note itself, never from a caller
  -- parameter, so this cannot be used to close an unrelated ticket.
  IF p_close_ticket AND v_cn.ticket_id IS NOT NULL THEN
    UPDATE public.rma_tickets
       SET ticket_status = 'Closed',
           closed_date   = COALESCE(closed_date, NOW()),
           updated_by    = v_actor,
           updated_date  = NOW()
     WHERE id = v_cn.ticket_id
       AND ticket_status <> 'Closed';
  END IF;

  RETURN v_code;
END;
$function$;
