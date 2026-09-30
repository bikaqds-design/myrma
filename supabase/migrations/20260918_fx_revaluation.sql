-- 20260918_fx_revaluation.sql — W4 / A-08c: month-end revaluation of
-- foreign-currency balances (unrealised exchange gains and losses).
--
-- A foreign invoice sits in receivables at the rate it was booked at; by the
-- end of the month that currency may be worth more or less. Revaluing restates
-- every open foreign balance at the month-end rate so the balance sheet is
-- right on that date; the realised gain or loss is still booked when the item
-- is settled (A-05a).
--
-- Owner decisions (2026-09-30):
--   * unrealised gains and losses go to their own accounts, 4915 / 6525 (roles
--     fx_unrealised_gain / fx_unrealised_loss), apart from the realised 4910 /
--     6520;
--   * each revaluation is reversed on the first day of the next month, so the
--     real difference is booked once, at settlement;
--   * closing a month only warns ("foreign balances not revalued" on the
--     month-end checklist); it never blocks.
--
-- What is revalued, as it stood at the month end (applications, refunds and
-- dates on or before it; documents that are final — posted, issued, active,
-- approved — today):
--   receivables  foreign invoices' open balance (+), payments' unapplied amount
--                (−) and credit notes' remaining balance (−);
--   payables     foreign supplier invoices' open balance (+) and supplier
--                payments' unapplied amount (− — prepayments).
-- Each item: carried = open × its own rate, revalued = open × the month-end
-- rate (the latest exchange_rates row on or before it). The effect is a gain
-- when a receivable rises or a payable falls. One entry per month: Dr/Cr
-- receivables and payables by their net effect, Cr unrealised gain / Dr
-- unrealised loss by the gains and the losses; reversed on the 1st.
--
-- run_fx_revaluation: administrators and accountants (rma_is_finance), with
-- accounting.close_period (the catalog lists it); once per month, only after
-- the month has ended, refused while a currency has no rate; the period guard
-- refuses a closed month. rma_fx_revaluation_preview shows the same lines
-- without posting (managers and accountants). A document voided after the
-- month end is not revalued (it is not final today) — an edge the owner can
-- live with; the next month's reversal keeps the ledger whole either way.

-- ── 1. accounts and posting roles ────────────────────────────────────────────
ALTER TABLE public.posting_rules DROP CONSTRAINT IF EXISTS posting_rules_role_check;
ALTER TABLE public.posting_rules ADD CONSTRAINT posting_rules_role_check CHECK (role IN (
  'accounts_receivable', 'accounts_payable', 'inventory', 'goods_received_not_invoiced',
  'sales_revenue', 'sales_tax_payable', 'purchase_tax_receivable', 'cost_of_goods_sold',
  'purchase_price_variance', 'inventory_adjustment', 'cash', 'bank', 'customer_deposits',
  'retained_earnings', 'opening_balance_equity', 'rounding', 'accrued_landed_costs',
  'fx_gain', 'fx_loss', 'fx_unrealised_gain', 'fx_unrealised_loss'));

-- the country templates carry the same two accounts, on the same codes
INSERT INTO public.gl_chart_templates (country_code, code, name, name_ar, account_type, parent_code, is_postable, role) VALUES
  ('EG', '4915', 'Unrealised foreign exchange gains', 'أرباح فروق عملة غير محققة', 'income', '4000', true, 'fx_unrealised_gain'),
  ('EG', '6525', 'Unrealised foreign exchange losses', 'خسائر فروق عملة غير محققة', 'expense', '6000', true, 'fx_unrealised_loss'),
  ('AE', '4915', 'Unrealised foreign exchange gains', 'أرباح فروق عملة غير محققة', 'income', '4000', true, 'fx_unrealised_gain'),
  ('AE', '6525', 'Unrealised foreign exchange losses', 'خسائر فروق عملة غير محققة', 'expense', '6000', true, 'fx_unrealised_loss'),
  ('SA', '4915', 'Unrealised foreign exchange gains', 'أرباح فروق عملة غير محققة', 'income', '4000', true, 'fx_unrealised_gain'),
  ('SA', '6525', 'Unrealised foreign exchange losses', 'خسائر فروق عملة غير محققة', 'expense', '6000', true, 'fx_unrealised_loss')
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_inc uuid := (SELECT id FROM public.gl_accounts WHERE code = '4000' AND NOT is_postable);
  v_exp uuid := (SELECT id FROM public.gl_accounts WHERE code = '6000' AND NOT is_postable);
BEGIN
  INSERT INTO public.gl_accounts (id, code, name, name_ar, account_type, parent_id, is_postable)
  VALUES (md5('gl_account:4915')::uuid, '4915', 'Unrealised foreign exchange gains', 'أرباح فروق عملة غير محققة', 'income', v_inc, true)
  ON CONFLICT (code) DO NOTHING;
  INSERT INTO public.gl_accounts (id, code, name, name_ar, account_type, parent_id, is_postable)
  VALUES (md5('gl_account:6525')::uuid, '6525', 'Unrealised foreign exchange losses', 'خسائر فروق عملة غير محققة', 'expense', v_exp, true)
  ON CONFLICT (code) DO NOTHING;
  INSERT INTO public.posting_rules (role, account_id)
  SELECT 'fx_unrealised_gain', id FROM public.gl_accounts WHERE code = '4915' AND is_postable AND is_active
  ON CONFLICT (role) DO NOTHING;
  INSERT INTO public.posting_rules (role, account_id)
  SELECT 'fx_unrealised_loss', id FROM public.gl_accounts WHERE code = '6525' AND is_postable AND is_active
  ON CONFLICT (role) DO NOTHING;
END $$;

-- ── 2. the record of each run ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fx_revaluations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start      date NOT NULL UNIQUE CHECK (period_start = date_trunc('month', period_start)::date),
  revalued_on       date NOT NULL,
  item_count        integer NOT NULL DEFAULT 0,
  total_gain        numeric(14, 2) NOT NULL DEFAULT 0,
  total_loss        numeric(14, 2) NOT NULL DEFAULT 0,
  entry_id          uuid REFERENCES public.journal_entries(id),
  reversal_entry_id uuid REFERENCES public.journal_entries(id),
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.fx_revaluation_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revaluation_id uuid NOT NULL REFERENCES public.fx_revaluations(id) ON DELETE CASCADE,
  side           text NOT NULL CHECK (side IN ('receivable', 'payable')),
  doc_type       text NOT NULL,
  doc_id         uuid NOT NULL,
  doc_code       text,
  party_id       uuid,
  currency       text NOT NULL,
  open_amount    numeric(14, 2) NOT NULL,
  doc_rate       numeric NOT NULL,
  carried_base   numeric(14, 2) NOT NULL,
  rate           numeric NOT NULL,
  revalued_base  numeric(14, 2) NOT NULL,
  effect         numeric(14, 2) NOT NULL
);
CREATE INDEX IF NOT EXISTS fx_revaluation_lines_run_idx ON public.fx_revaluation_lines (revaluation_id);
COMMENT ON TABLE public.fx_revaluations IS
  'A-08c (20260918): one month-end revaluation of foreign balances, its journal entry and the reversal on the 1st. Written only by run_fx_revaluation.';

ALTER TABLE public.fx_revaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_revaluation_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fx_revaluations, public.fx_revaluation_lines FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.fx_revaluations, public.fx_revaluation_lines FROM authenticated;
GRANT SELECT ON TABLE public.fx_revaluations, public.fx_revaluation_lines TO authenticated;
GRANT ALL ON TABLE public.fx_revaluations, public.fx_revaluation_lines TO service_role;
DROP POLICY IF EXISTS "read_fx_revaluations" ON public.fx_revaluations;
CREATE POLICY "read_fx_revaluations" ON public.fx_revaluations FOR SELECT
  TO authenticated USING (COALESCE(public.rma_can_handle_cash(), false));
DROP POLICY IF EXISTS "read_fx_revaluation_lines" ON public.fx_revaluation_lines;
CREATE POLICY "read_fx_revaluation_lines" ON public.fx_revaluation_lines FOR SELECT
  TO authenticated USING (COALESCE(public.rma_can_handle_cash(), false));

DROP TRIGGER IF EXISTS trg_audit_fx_revaluations ON public.fx_revaluations;
CREATE TRIGGER trg_audit_fx_revaluations AFTER INSERT OR DELETE OR UPDATE ON public.fx_revaluations
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();

-- ── 3. the open foreign items at a month end (internal) ──────────────────────
CREATE OR REPLACE FUNCTION public._rma_fx_open_items(p_month_end date)
RETURNS TABLE(side text, doc_type text, doc_id uuid, doc_code text, party_id uuid, currency text,
              open_amount numeric, doc_rate numeric, carried_base numeric, rate numeric,
              revalued_base numeric, effect numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  WITH base AS (SELECT public.rma_base_currency() AS cur),
  items AS (
    -- receivables: invoices (+)
    SELECT 'receivable' AS side, 'invoice' AS doc_type, i.id AS doc_id, i.inv_code AS doc_code, i.customer_id AS party_id,
           upper(i.currency::text) AS currency, i.exchange_rate AS doc_rate,
           i.total
             - COALESCE((SELECT sum(pa.amount_applied) FROM public.payment_applications pa
                          WHERE pa.invoice_id = i.id AND public._rma_tenant_date(pa.applied_date) <= p_month_end), 0)
             - COALESCE((SELECT sum(ca.amount_applied) FROM public.credit_note_applications ca
                          WHERE ca.invoice_id = i.id AND public._rma_tenant_date(ca.applied_date) <= p_month_end), 0) AS open_amount
      FROM public.crm_invoices i, base
     WHERE i.doc_status = 'posted' AND upper(i.currency::text) <> base.cur
       AND public._rma_tenant_date(i.posted_at) <= p_month_end
    UNION ALL
    -- receivables: payments not yet applied (−)
    SELECT 'receivable', 'payment', p.id, p.payment_code, p.customer_id, upper(p.currency::text), p.exchange_rate,
           -(p.amount
             - COALESCE((SELECT sum(pa.amount_applied) FROM public.payment_applications pa
                          WHERE pa.payment_id = p.id AND public._rma_tenant_date(pa.applied_date) <= p_month_end), 0)
             - COALESCE((SELECT sum(r.amount) FROM public.customer_refunds r
                          WHERE r.payment_id = p.id AND r.status = 'approved' AND r.refund_date <= p_month_end), 0))
      FROM public.payments p, base
     WHERE p.status = 'active' AND upper(p.currency::text) <> base.cur AND p.payment_date <= p_month_end
    UNION ALL
    -- receivables: credit notes not yet used (−)
    SELECT 'receivable', 'credit_note', c.id, c.cn_code, c.customer_id, upper(c.currency::text), c.exchange_rate,
           -(c.total
             - COALESCE((SELECT sum(ca.amount_applied) FROM public.credit_note_applications ca
                          WHERE ca.credit_note_id = c.id AND public._rma_tenant_date(ca.applied_date) <= p_month_end), 0)
             - COALESCE((SELECT sum(r.amount) FROM public.customer_refunds r
                          WHERE r.credit_note_id = c.id AND r.status = 'approved' AND r.refund_date <= p_month_end), 0))
      FROM public.credit_notes c, base
     WHERE c.status IN ('issued', 'applied') AND upper(c.currency::text) <> base.cur
       AND public._rma_tenant_date(c.issued_at) <= p_month_end
    UNION ALL
    -- payables: supplier invoices (+)
    SELECT 'payable', 'vendor_invoice', v.id, COALESCE(v.vi_code, v.supplier_invoice_no), v.vendor_id,
           upper(v.currency::text), v.exchange_rate,
           v.total
             - COALESCE((SELECT sum(a.amount_applied) FROM public.vendor_payment_applications a
                          WHERE a.invoice_id = v.id AND public._rma_tenant_date(a.applied_date) <= p_month_end), 0)
      FROM public.vendor_invoices v, base
     WHERE v.status IN ('approved', 'partially_received', 'received') AND upper(v.currency::text) <> base.cur
       AND public._rma_tenant_date(v.approved_at) <= p_month_end
    UNION ALL
    -- payables: supplier payments not yet applied (−, prepayments)
    SELECT 'payable', 'vendor_payment', vp.id, vp.payment_code, vp.vendor_id, upper(vp.currency::text), vp.exchange_rate,
           -(vp.amount
             - COALESCE((SELECT sum(a.amount_applied) FROM public.vendor_payment_applications a
                          WHERE a.payment_id = vp.id AND public._rma_tenant_date(a.applied_date) <= p_month_end), 0))
      FROM public.vendor_payments vp, base
     WHERE vp.status = 'active' AND upper(vp.currency::text) <> base.cur AND vp.payment_date <= p_month_end
  ), priced AS (
    SELECT it.*,
           (SELECT r.rate FROM public.exchange_rates r
             WHERE r.currency = it.currency AND r.rate_date <= p_month_end
             ORDER BY r.rate_date DESC LIMIT 1) AS rate
      FROM items it
     WHERE round(it.open_amount, 2) <> 0
  )
  SELECT p.side, p.doc_type, p.doc_id, p.doc_code, p.party_id, p.currency,
         round(p.open_amount, 2), p.doc_rate,
         round(p.open_amount * p.doc_rate, 2),
         p.rate,
         CASE WHEN p.rate IS NULL THEN NULL ELSE round(p.open_amount * p.rate, 2) END,
         CASE WHEN p.rate IS NULL THEN NULL
              WHEN p.side = 'receivable' THEN round(p.open_amount * p.rate, 2) - round(p.open_amount * p.doc_rate, 2)
              ELSE round(p.open_amount * p.doc_rate, 2) - round(p.open_amount * p.rate, 2) END
    FROM priced p
   ORDER BY p.side DESC, p.currency, p.doc_code NULLS LAST, p.doc_id
$fn$;
REVOKE ALL ON FUNCTION public._rma_fx_open_items(date) FROM PUBLIC, anon, authenticated;

-- ── 4. preview (read-only) ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_fx_revaluation_preview(p_month date)
RETURNS TABLE(side text, doc_type text, doc_id uuid, doc_code text, party_id uuid, party_name text, currency text,
              open_amount numeric, doc_rate numeric, carried_base numeric, rate numeric,
              revalued_base numeric, effect numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_end date;
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Only managers and accountants can read the revaluation.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'Choose a month.' USING ERRCODE = 'P0001';
  END IF;
  v_end := (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date;
  RETURN QUERY
  SELECT x.side, x.doc_type, x.doc_id, x.doc_code, x.party_id,
         CASE WHEN x.side = 'receivable' THEN (SELECT c.company_name FROM public.customers c WHERE c.id = x.party_id)
              ELSE (SELECT b.brand_name FROM public.brands b WHERE b.id = x.party_id) END,
         x.currency, x.open_amount, x.doc_rate, x.carried_base, x.rate, x.revalued_base, x.effect
    FROM public._rma_fx_open_items(v_end) x;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_fx_revaluation_preview(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_fx_revaluation_preview(date) TO authenticated, service_role;

-- ── 5. run it ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.run_fx_revaluation(p_month date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_start   date;
  v_end     date;
  v_id      uuid;
  v_missing text;
  v_ar      numeric;
  v_ap      numeric;
  v_gain    numeric;
  v_loss    numeric;
  v_n       integer;
  v_lines   jsonb := '[]'::jsonb;
  v_entry   uuid;
  v_rev     uuid;
  v_code    text;
BEGIN
  PERFORM public.rma_require_permission('accounting', 'close_period');
  IF NOT COALESCE(public.rma_is_finance(), false) THEN
    RAISE EXCEPTION 'Only administrators and accountants can revalue foreign balances.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'Choose a month.' USING ERRCODE = 'P0001';
  END IF;
  v_start := date_trunc('month', p_month)::date;
  v_end := (v_start + interval '1 month' - interval '1 day')::date;
  IF v_end >= public.rma_today() THEN
    RAISE EXCEPTION 'A month is revalued once it has ended; % ends on %.', to_char(v_start, 'FMMonth YYYY'), v_end
      USING ERRCODE = 'P0001';
  END IF;

  -- one run per month; a second caller waits here and then finds the first
  PERFORM pg_advisory_xact_lock(hashtext('fx_revaluation:' || v_start));
  IF EXISTS (SELECT 1 FROM public.fx_revaluations r WHERE r.period_start = v_start) THEN
    RAISE EXCEPTION '% has already been revalued.', to_char(v_start, 'FMMonth YYYY') USING ERRCODE = 'P0001';
  END IF;

  SELECT string_agg(DISTINCT i.currency, ', ') INTO v_missing FROM public._rma_fx_open_items(v_end) i WHERE i.rate IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Enter an exchange rate on or before % for: %.', v_end, v_missing USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(sum(i.effect) FILTER (WHERE i.side = 'receivable'), 0),
         COALESCE(sum(i.effect) FILTER (WHERE i.side = 'payable'), 0),
         COALESCE(sum(i.effect) FILTER (WHERE i.effect > 0), 0),
         COALESCE(-sum(i.effect) FILTER (WHERE i.effect < 0), 0),
         count(*)
    INTO v_ar, v_ap, v_gain, v_loss, v_n
    FROM public._rma_fx_open_items(v_end) i;

  INSERT INTO public.fx_revaluations (period_start, revalued_on, item_count, total_gain, total_loss, created_by)
  VALUES (v_start, v_end, v_n, v_gain, v_loss, public.rma_current_user_email())
  RETURNING id INTO v_id;

  INSERT INTO public.fx_revaluation_lines (revaluation_id, side, doc_type, doc_id, doc_code, party_id, currency,
                                           open_amount, doc_rate, carried_base, rate, revalued_base, effect)
  SELECT v_id, i.side, i.doc_type, i.doc_id, i.doc_code, i.party_id, i.currency,
         i.open_amount, i.doc_rate, i.carried_base, i.rate, i.revalued_base, i.effect
    FROM public._rma_fx_open_items(v_end) i;

  IF v_gain <> 0 OR v_loss <> 0 THEN
    v_code := 'FXR-' || to_char(v_start, 'YYYY-MM');
    IF v_ar <> 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('role', 'accounts_receivable',
                   CASE WHEN v_ar > 0 THEN 'debit' ELSE 'credit' END, abs(v_ar)));
    END IF;
    IF v_ap <> 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('role', 'accounts_payable',
                   CASE WHEN v_ap > 0 THEN 'debit' ELSE 'credit' END, abs(v_ap)));
    END IF;
    IF v_gain <> 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('role', 'fx_unrealised_gain', 'credit', v_gain));
    END IF;
    IF v_loss <> 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('role', 'fx_unrealised_loss', 'debit', v_loss));
    END IF;
    v_entry := public._gl_post('fx_revaluation', v_id, 'revalue', v_end, v_code,
                               'Revaluation of foreign balances at ' || v_end, v_lines);
    v_rev := public._gl_reverse('fx_revaluation', v_id, 'revalue', 'reverse', v_end + 1,
                                'Reversal of the ' || to_char(v_start, 'YYYY-MM') || ' revaluation');
    UPDATE public.fx_revaluations SET entry_id = v_entry, reversal_entry_id = v_rev WHERE id = v_id;
  END IF;
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.run_fx_revaluation(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_fx_revaluation(date) TO authenticated, service_role;

-- the permission catalog names every function that checks it
UPDATE public.permission_catalog
   SET functions = array_append(functions, 'run_fx_revaluation')
 WHERE section = 'accounting' AND action = 'close_period' AND NOT ('run_fx_revaluation' = ANY (functions));

-- ── 6. the month-end checklist warns (rewritten in its live definition) ──────
DO $rw$
DECLARE
  v_def    text;
  v_anchor text := '  -- bank reconciliation arrives with bank accounts (A-07)';
BEGIN
  v_def := replace(pg_get_functiondef('public.rma_period_close_checklist(date)'::regprocedure), E'\r\n', E'\n');
  IF position('fx_not_revalued' IN v_def) > 0 THEN
    RETURN;  -- already applied
  END IF;
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION '20260918: rma_period_close_checklist does not read as expected (anchor not found once)';
  END IF;
  v_def := replace(v_def, v_anchor,
    E'  -- foreign balances not revalued (A-08c, 20260918): advisory, never blocks\n'
    || E'  RETURN QUERY SELECT ''fx_not_revalued''::text,\n'
    || E'    CASE WHEN EXISTS (SELECT 1 FROM public.fx_revaluations r WHERE r.period_start = v_m) THEN 0::bigint\n'
    || E'         ELSE (SELECT count(*) FROM public._rma_fx_open_items(v_end)) END,\n'
    || E'    NULL::numeric;\n\n'
    || v_anchor);
  EXECUTE v_def;
END
$rw$;

-- ── 7. Backup & Restore: the restorable BACKUP_TABLES, in order ─────────────
-- (src/test/restoreManifest.test.js fails if the two drift apart). A run and
-- its lines come after the journal they point at.
CREATE OR REPLACE FUNCTION public.rma_restore_manifest()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'currencies', 'countries', 'country_area_codes', 'rma_config', 'gl_accounts', 'posting_rules',
    'tax_codes', 'tax_code_rates', 'exchange_rates',
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
    'fx_revaluations', 'fx_revaluation_lines',
    'activities', 'notifications', 'user_activity_log'
  ]::text[]
$function$;

-- ── 8. checks ────────────────────────────────────────────────────────────────
DO $chk$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.run_fx_revaluation(date)', 'public.rma_fx_revaluation_preview(date)',
                           'public._rma_fx_open_items(date)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION '20260918: anon can execute %', f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._rma_fx_open_items(date)', 'EXECUTE') THEN
    RAISE EXCEPTION '20260918: _rma_fx_open_items is client-callable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.posting_rules WHERE role = 'fx_unrealised_gain')
     OR NOT EXISTS (SELECT 1 FROM public.posting_rules WHERE role = 'fx_unrealised_loss') THEN
    RAISE EXCEPTION '20260918: the unrealised gain / loss roles have no account';
  END IF;
  IF position('fx_not_revalued' IN pg_get_functiondef('public.rma_period_close_checklist(date)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '20260918: the checklist does not warn about revaluation';
  END IF;
END
$chk$;
