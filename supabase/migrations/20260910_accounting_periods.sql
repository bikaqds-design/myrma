-- ############################################################################
-- #  20260910 — accounting periods and month-end close (A-03, BL-13)
-- #
-- #  A month is open, soft closed or closed. Nothing may be posted to the
-- #  ledger dated in a closed month; in a soft-closed month only finance
-- #  (an accountant or an administrator) may post. Owner decisions 2026-09-27:
-- #    · closing is for accountants and administrators;
-- #    · a closed month is reopened only when an administrator other than the
-- #      one who asked approves it;
-- #    · soft close first, then close.
-- #
-- #  The guard sits on journal_entries (BEFORE INSERT), not inside _gl_post /
-- #  _gl_reverse, so every writer is covered, and a refused posting fails the
-- #  document step that caused it. A month with no row is open.
-- #
-- #  A restore (rma.audit_suspended) is left alone: it writes rows as they were.
-- #  Pinned by src/test/accountingPeriods.test.js;
-- #  supabase/tests/accounting_periods.sql is the rolled-back reference script.
-- ############################################################################

-- ── 1. who counts as finance ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_is_finance()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT COALESCE(public.rma_is_admin() OR public.rma_user_role() = 'accountant', false)
$fn$;
REVOKE ALL ON FUNCTION public.rma_is_finance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_is_finance() TO authenticated, service_role;

-- ── 2. tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.accounting_periods (
  period_start    date PRIMARY KEY CHECK (period_start = date_trunc('month', period_start)::date),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'soft_closed', 'closed')),
  soft_closed_by  text,
  soft_closed_at  timestamptz,
  closed_by       text,
  closed_at       timestamptz,
  reopened_by     text,
  reopened_at     timestamptz,
  reopen_reason   text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.accounting_periods IS
  'Month-end close (A-03). A month with no row is open. Closed: nothing posts dated in it. Soft closed: only an accountant or administrator posts. Written only by the period functions.';

CREATE TABLE IF NOT EXISTS public.period_reopen_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start   date NOT NULL REFERENCES public.accounting_periods(period_start),
  reason         text NOT NULL CHECK (length(btrim(reason)) >= 10),
  requested_by   text NOT NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by     text,
  decided_at     timestamptz,
  decision_note  text
);
CREATE UNIQUE INDEX IF NOT EXISTS period_reopen_requests_one_pending_idx
  ON public.period_reopen_requests (period_start) WHERE status = 'pending';
COMMENT ON TABLE public.period_reopen_requests IS
  'A request to reopen a closed month (A-03). Approved by an administrator other than the requester; the month then returns to soft closed.';

ALTER TABLE public.accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.period_reopen_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_periods, public.period_reopen_requests FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.accounting_periods, public.period_reopen_requests FROM authenticated;
GRANT SELECT ON TABLE public.accounting_periods, public.period_reopen_requests TO authenticated;
GRANT ALL ON TABLE public.accounting_periods, public.period_reopen_requests TO service_role;

DROP POLICY IF EXISTS "read_accounting_periods" ON public.accounting_periods;
CREATE POLICY "read_accounting_periods" ON public.accounting_periods FOR SELECT
  USING (COALESCE(public.rma_is_staff(), false));
DROP POLICY IF EXISTS "read_period_reopen_requests" ON public.period_reopen_requests;
CREATE POLICY "read_period_reopen_requests" ON public.period_reopen_requests FOR SELECT
  USING (COALESCE(public.rma_can_handle_cash(), false));

DROP TRIGGER IF EXISTS trg_audit_accounting_periods ON public.accounting_periods;
CREATE TRIGGER trg_audit_accounting_periods AFTER INSERT OR DELETE OR UPDATE ON public.accounting_periods
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();
DROP TRIGGER IF EXISTS trg_audit_truncate_accounting_periods ON public.accounting_periods;
CREATE TRIGGER trg_audit_truncate_accounting_periods AFTER TRUNCATE ON public.accounting_periods
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_truncate();
DROP TRIGGER IF EXISTS trg_audit_period_reopen_requests ON public.period_reopen_requests;
CREATE TRIGGER trg_audit_period_reopen_requests AFTER INSERT OR DELETE OR UPDATE ON public.period_reopen_requests
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();
DROP TRIGGER IF EXISTS trg_audit_truncate_period_reopen_requests ON public.period_reopen_requests;
CREATE TRIGGER trg_audit_truncate_period_reopen_requests AFTER TRUNCATE ON public.period_reopen_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_truncate();

-- ── 3. the status of a date's month ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_period_status(p_date date)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT COALESCE((SELECT status FROM public.accounting_periods
                    WHERE period_start = date_trunc('month', p_date)::date), 'open')
$fn$;
REVOKE ALL ON FUNCTION public.rma_period_status(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_period_status(date) TO authenticated, service_role;

-- ── 4. the posting guard ─────────────────────────────────────────────────────
-- The shared advisory lock makes a close wait for postings already under way
-- (the period functions take it exclusively), so a posting that read "open"
-- cannot land after the month was closed.
CREATE OR REPLACE FUNCTION public.rma_guard_journal_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_status text;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtext('rma.accounting_periods'));
  v_status := public.rma_period_status(NEW.entry_date);
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'The accounting period % is closed: nothing can be posted dated %. Use a date in an open month, or ask for the period to be reopened.',
      to_char(NEW.entry_date, 'FMMonth YYYY'), NEW.entry_date USING ERRCODE = 'P0001';
  ELSIF v_status = 'soft_closed' AND NOT COALESCE(public.rma_is_finance(), false) THEN
    RAISE EXCEPTION 'The accounting period % is being closed: only an accountant or an administrator can post dated %.',
      to_char(NEW.entry_date, 'FMMonth YYYY'), NEW.entry_date USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_guard_journal_period() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_journal_entries_period ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_period BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_journal_period();

-- ── 5. internal: lock the periods and fetch (creating) one month's row ──────
CREATE OR REPLACE FUNCTION public._period_lock_month(p_month date)
RETURNS public.accounting_periods LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_m   date := date_trunc('month', p_month)::date;
  v_row public.accounting_periods;
BEGIN
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'A month is required.' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('rma.accounting_periods'));
  INSERT INTO public.accounting_periods (period_start) VALUES (v_m) ON CONFLICT (period_start) DO NOTHING;
  SELECT * INTO v_row FROM public.accounting_periods WHERE period_start = v_m FOR UPDATE;
  RETURN v_row;
END $fn$;
REVOKE ALL ON FUNCTION public._period_lock_month(date) FROM PUBLIC, anon, authenticated;

-- ── 6. soft close, close, reopen a soft-closed month ─────────────────────────
CREATE OR REPLACE FUNCTION public.soft_close_accounting_period(p_month date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_row public.accounting_periods;
  v_gap date;
BEGIN
  IF NOT COALESCE(public.rma_is_finance(), false) THEN
    RAISE EXCEPTION 'Only an accountant or an administrator can close a period.' USING ERRCODE = '42501';
  END IF;
  IF date_trunc('month', p_month)::date >= date_trunc('month', public.rma_today())::date THEN
    RAISE EXCEPTION 'A month can be closed only after it has ended.' USING ERRCODE = '22023';
  END IF;
  v_row := public._period_lock_month(p_month);
  IF v_row.status <> 'open' THEN
    RAISE EXCEPTION '% is already %.', to_char(v_row.period_start, 'FMMonth YYYY'), replace(v_row.status, '_', ' ') USING ERRCODE = 'P0001';
  END IF;
  -- months are closed in order: an earlier month with postings must not be open
  SELECT min(x.m) INTO v_gap
    FROM (SELECT DISTINCT date_trunc('month', entry_date)::date AS m
            FROM public.journal_entries WHERE entry_date < v_row.period_start) x
    LEFT JOIN public.accounting_periods p ON p.period_start = x.m
   WHERE COALESCE(p.status, 'open') = 'open';
  IF v_gap IS NOT NULL THEN
    RAISE EXCEPTION 'Close % first: months are closed in order.', to_char(v_gap, 'FMMonth YYYY') USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.accounting_periods
     SET status = 'soft_closed', soft_closed_by = public.rma_current_user_email(), soft_closed_at = now(), updated_at = now()
   WHERE period_start = v_row.period_start
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END $fn$;

CREATE OR REPLACE FUNCTION public.close_accounting_period(p_month date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_row public.accounting_periods;
  v_gap date;
BEGIN
  IF NOT COALESCE(public.rma_is_finance(), false) THEN
    RAISE EXCEPTION 'Only an accountant or an administrator can close a period.' USING ERRCODE = '42501';
  END IF;
  v_row := public._period_lock_month(p_month);
  IF v_row.status <> 'soft_closed' THEN
    RAISE EXCEPTION '% must be soft closed before it is closed.', to_char(v_row.period_start, 'FMMonth YYYY') USING ERRCODE = 'P0001';
  END IF;
  SELECT min(m) INTO v_gap FROM (
    SELECT x.m
      FROM (SELECT DISTINCT date_trunc('month', entry_date)::date AS m
              FROM public.journal_entries WHERE entry_date < v_row.period_start) x
      LEFT JOIN public.accounting_periods p ON p.period_start = x.m
     WHERE COALESCE(p.status, 'open') <> 'closed'
    UNION ALL
    SELECT period_start FROM public.accounting_periods
     WHERE period_start < v_row.period_start AND status = 'soft_closed'
  ) g;
  IF v_gap IS NOT NULL THEN
    RAISE EXCEPTION 'Close % first: months are closed in order.', to_char(v_gap, 'FMMonth YYYY') USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.accounting_periods
     SET status = 'closed', closed_by = public.rma_current_user_email(), closed_at = now(), updated_at = now()
   WHERE period_start = v_row.period_start
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END $fn$;

CREATE OR REPLACE FUNCTION public.reopen_soft_closed_period(p_month date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_row   public.accounting_periods;
  v_later date;
BEGIN
  IF NOT COALESCE(public.rma_is_finance(), false) THEN
    RAISE EXCEPTION 'Only an accountant or an administrator can reopen a period.' USING ERRCODE = '42501';
  END IF;
  v_row := public._period_lock_month(p_month);
  IF v_row.status <> 'soft_closed' THEN
    RAISE EXCEPTION '% is not soft closed.', to_char(v_row.period_start, 'FMMonth YYYY') USING ERRCODE = 'P0001';
  END IF;
  SELECT max(period_start) INTO v_later FROM public.accounting_periods
   WHERE period_start > v_row.period_start AND status <> 'open';
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'Reopen % first: a later month is still closed or being closed.', to_char(v_later, 'FMMonth YYYY') USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.accounting_periods
     SET status = 'open', reopened_by = public.rma_current_user_email(), reopened_at = now(), updated_at = now()
   WHERE period_start = v_row.period_start
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END $fn$;

-- ── 7. reopening a closed month: request, approve (another admin), reject ───
CREATE OR REPLACE FUNCTION public.request_period_reopen(p_month date, p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_row   public.accounting_periods;
  v_later date;
  v_id    uuid;
BEGIN
  IF NOT COALESCE(public.rma_is_finance(), false) THEN
    RAISE EXCEPTION 'Only an accountant or an administrator can ask to reopen a period.' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters.' USING ERRCODE = '22023';
  END IF;
  v_row := public._period_lock_month(p_month);
  IF v_row.status <> 'closed' THEN
    RAISE EXCEPTION '% is not closed.', to_char(v_row.period_start, 'FMMonth YYYY') USING ERRCODE = 'P0001';
  END IF;
  SELECT max(period_start) INTO v_later FROM public.accounting_periods
   WHERE period_start > v_row.period_start AND status = 'closed';
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'Reopen % first: a later month is closed.', to_char(v_later, 'FMMonth YYYY') USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.period_reopen_requests WHERE period_start = v_row.period_start AND status = 'pending') THEN
    RAISE EXCEPTION 'A request to reopen % is already waiting.', to_char(v_row.period_start, 'FMMonth YYYY') USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.period_reopen_requests (period_start, reason, requested_by)
  VALUES (v_row.period_start, btrim(p_reason), public.rma_current_user_email())
  RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION public.approve_period_reopen(p_request uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_req   public.period_reopen_requests;
  v_row   public.accounting_periods;
  v_me    text := public.rma_current_user_email();
  v_later date;
BEGIN
  IF NOT COALESCE(public.rma_is_admin(), false) THEN
    RAISE EXCEPTION 'Only an administrator can approve reopening a period.' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('rma.accounting_periods'));
  SELECT * INTO v_req FROM public.period_reopen_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND OR v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'That request is not waiting for approval.' USING ERRCODE = 'P0001';
  END IF;
  IF lower(COALESCE(v_me, '')) = lower(v_req.requested_by) THEN
    RAISE EXCEPTION 'Another administrator must approve this: you asked for it.' USING ERRCODE = '42501';
  END IF;
  v_row := public._period_lock_month(v_req.period_start);
  IF v_row.status <> 'closed' THEN
    RAISE EXCEPTION '% is no longer closed.', to_char(v_row.period_start, 'FMMonth YYYY') USING ERRCODE = 'P0001';
  END IF;
  SELECT max(period_start) INTO v_later FROM public.accounting_periods
   WHERE period_start > v_row.period_start AND status = 'closed';
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'Reopen % first: a later month is closed.', to_char(v_later, 'FMMonth YYYY') USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.period_reopen_requests
     SET status = 'approved', decided_by = v_me, decided_at = now(), decision_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = v_req.id;
  -- back to soft closed: finance can correct it, and close it again
  UPDATE public.accounting_periods
     SET status = 'soft_closed', reopened_by = v_me, reopened_at = now(), reopen_reason = v_req.reason, updated_at = now()
   WHERE period_start = v_row.period_start
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END $fn$;

CREATE OR REPLACE FUNCTION public.reject_period_reopen(p_request uuid, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_req public.period_reopen_requests;
  v_me  text := public.rma_current_user_email();
BEGIN
  SELECT * INTO v_req FROM public.period_reopen_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND OR v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'That request is not waiting for approval.' USING ERRCODE = 'P0001';
  END IF;
  -- an administrator turns it down, or the one who asked withdraws it
  IF NOT COALESCE(public.rma_is_admin()
                  OR (public.rma_is_finance() AND lower(v_me) = lower(v_req.requested_by)), false) THEN
    RAISE EXCEPTION 'Only an administrator, or the one who asked, can turn this request down.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.period_reopen_requests
     SET status = 'rejected', decided_by = v_me, decided_at = now(), decision_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = v_req.id;
END $fn$;

-- ── 8. the close checklist (advisory) ────────────────────────────────────────
-- What is still unfinished for a month. Nothing here blocks a close.
CREATE OR REPLACE FUNCTION public.rma_period_close_checklist(p_month date)
RETURNS TABLE (item text, item_count bigint, amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_m   date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date;
  v_grni uuid;
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Not allowed.' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'A month is required.' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY SELECT 'draft_sales_invoices'::text, count(*), COALESCE(sum(total), 0)::numeric
    FROM public.crm_invoices
   WHERE doc_status = 'draft' AND NOT COALESCE(archived, false) AND created_at::date <= v_end;

  RETURN QUERY SELECT 'unissued_credit_notes'::text, count(*), COALESCE(sum(total), 0)::numeric
    FROM public.credit_notes
   WHERE status IN ('draft', 'pending_approval') AND NOT COALESCE(archived, false) AND created_at::date <= v_end;

  RETURN QUERY SELECT 'unapproved_supplier_invoices'::text, count(*), COALESCE(sum(total), 0)::numeric
    FROM public.vendor_invoices
   WHERE status IN ('draft', 'pending_approval') AND NOT COALESCE(archived, false)
     AND COALESCE(supplier_invoice_date, invoice_date, created_at::date) <= v_end;

  RETURN QUERY SELECT 'uncosted_deliveries'::text, count(*), NULL::numeric
    FROM public.deliveries d
   WHERE d.status = 'confirmed' AND d.confirmed_at::date BETWEEN v_m AND v_end
     AND EXISTS (SELECT 1 FROM public.delivery_lines l WHERE l.delivery_id = d.id AND l.cogs_unknown_qty > 0);

  RETURN QUERY SELECT 'pending_supplier_payments'::text, count(*), COALESCE(sum(vp.amount), 0)::numeric
    FROM public.vendor_payments vp
   WHERE vp.status = 'pending_approval' AND vp.payment_date <= v_end;

  RETURN QUERY SELECT 'pending_refunds'::text, count(*), COALESCE(sum(r.amount), 0)::numeric
    FROM public.customer_refunds r
   WHERE r.status = 'pending_approval' AND r.refund_date <= v_end;

  -- goods received and not yet invoiced, as the ledger has it at month end
  SELECT account_id INTO v_grni FROM public.posting_rules WHERE role = 'goods_received_not_invoiced';
  RETURN QUERY SELECT 'grni_balance'::text,
         CASE WHEN COALESCE(sum(l.credit - l.debit), 0) = 0 THEN 0::bigint ELSE 1::bigint END,
         COALESCE(sum(l.credit - l.debit), 0)::numeric
    FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id
   WHERE l.account_id = v_grni AND e.entry_date <= v_end;

  -- bank reconciliation arrives with bank accounts (A-07)
  RETURN QUERY SELECT 'bank_reconciliation'::text, NULL::bigint, NULL::numeric;
END $fn$;

-- ── 9. grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.soft_close_accounting_period(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_accounting_period(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reopen_soft_closed_period(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_period_reopen(date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_period_reopen(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_period_reopen(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rma_period_close_checklist(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_close_accounting_period(date), public.close_accounting_period(date),
  public.reopen_soft_closed_period(date), public.request_period_reopen(date, text),
  public.approve_period_reopen(uuid, text), public.reject_period_reopen(uuid, text),
  public.rma_period_close_checklist(date) TO authenticated, service_role;

-- ── 10. Backup & Restore: the restorable BACKUP_TABLES, in order ─────────────
-- (src/test/restoreManifest.test.js fails if the two drift apart)
CREATE OR REPLACE FUNCTION public.rma_restore_manifest()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'currencies', 'countries', 'country_area_codes', 'rma_config', 'gl_accounts', 'posting_rules',
    'brands', 'categories',
    'subcategories', 'warehouses', 'pipelines', 'parts', 'custom_field_definitions',
    'custom_roles', 'user_roles', 'user_preferences', 'announcements', 'kb_articles',
    'branding_settings', 'email_templates', 'whatsapp_templates', 'notification_settings',
    'notification_preferences', 'products', 'product_images', 'product_documents',
    'company_documents', 'customers', 'contacts', 'customer_notes', 'deals', 'leads',
    'rma_tickets', 'ticket_comments', 'ticket_activity', 'ticket_parts', 'ticket_resolutions',
    'time_entries', 'purchase_orders', 'purchase_order_lines', 'vendor_invoices',
    'vendor_invoice_lines', 'vendor_invoice_charges', 'vendor_payments',
    'vendor_payment_applications', 'goods_receipts', 'goods_receipt_lines',
    'vendor_invoice_receipt_lines', 'purchase_cost_adjustments', 'manufacturer_batches',
    'inventory_units', 'warehouse_stock', 'goods_receipt_line_units', 'goods_receipt_line_bins',
    'quotations', 'quotation_lines', 'sales_orders', 'sales_order_lines', 'deliveries',
    'delivery_lines', 'delivery_line_units', 'delivery_line_bins', 'customer_returns',
    'customer_return_lines', 'customer_return_line_units', 'customer_return_line_bins',
    'crm_invoices', 'crm_invoice_lines', 'invoices', 'payments', 'payment_applications',
    'credit_notes', 'credit_note_lines', 'credit_note_applications', 'customer_refunds',
    'journal_entries', 'journal_lines', 'accounting_periods', 'period_reopen_requests',
    'activities', 'notifications', 'user_activity_log'
  ]::text[]
$function$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.accounting_periods', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'INSERT')
     OR has_table_privilege('authenticated', 'public.period_reopen_requests', 'INSERT')
     OR has_table_privilege('authenticated', 'public.period_reopen_requests', 'UPDATE') THEN
    RAISE EXCEPTION 'Refusing to finish: the period tables are writable outside the period functions';
  END IF;
  IF has_function_privilege('anon', 'public.rma_is_finance()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_period_status(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.soft_close_accounting_period(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.approve_period_reopen(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_guard_journal_period()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._period_lock_month(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a period function is executable by the wrong role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_journal_entries_period'
                   AND tgrelid = 'public.journal_entries'::regclass AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'Refusing to finish: the journal period guard is not in place';
  END IF;
END $$;
