-- Issuing a credit note can close its ticket in the same transaction.
-- (Audit finding BUG-048.)
--
-- NOTE ON PROVENANCE: this file was recovered on 2026-09-07 from
-- `supabase_migrations.schema_migrations` (version 20260906151510). The
-- migration was applied to production on 2026-09-06 but its .sql file was never
-- written to the repository, so four applied migrations (20260833-20260836)
-- existed only in the database. This is the SQL that actually ran, verbatim.

CREATE OR REPLACE FUNCTION public.issue_credit_note(
  p_cn_id uuid,
  p_actor_email text,
  p_close_ticket boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cn            record;
  v_code          text;
  v_actor         text;
  v_inv_remaining numeric(12,2);
  v_apply_amount  numeric(12,2);
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to issue credit notes';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_cn_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id;
  END IF;

  IF v_cn.status <> 'draft' THEN
    RAISE EXCEPTION 'Credit note is already % - cannot issue again', v_cn.status;
  END IF;

  v_code := public.nextval_for_type('credit_note');

  UPDATE public.credit_notes
  SET cn_code           = v_code,
      status            = 'issued',
      remaining_balance = v_cn.total,
      issued_at         = NOW(),
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

DO $do$
BEGIN
  IF to_regprocedure('public.issue_credit_note(uuid, text, boolean)') IS NULL THEN
    RAISE EXCEPTION 'Refusing to finish: the 3-argument form was not created.';
  END IF;
  IF pg_get_functiondef('public.issue_credit_note(uuid, text, boolean)'::regprocedure) NOT LIKE '%BUG-048%' THEN
    RAISE EXCEPTION 'Refusing to finish: the ticket-closing step is missing.';
  END IF;
  RAISE NOTICE 'BUG-048: issuing a credit note can now close its ticket in one transaction.';
END
$do$;
