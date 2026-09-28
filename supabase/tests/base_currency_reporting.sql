-- ############################################################################
-- #  STATEMENTS, AGING AND REPORTS IN THE BASE CURRENCY — A-05b part 2 (20260913)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/base_currency_reporting.sql A05B_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line.
-- #
-- #  Base currency EGP. A USD customer is invoiced 100 + 14 % at 51 (5,814 in
-- #  base) beside a local 1,000 + 14 % invoice (1,140), and pays 114 USD at 53
-- #  (6,042): the statement, summed in base, must equal the customer's
-- #  receivable in the ledger at every step, and the aging and the reports must
-- #  add 5,814 + 1,140, never 114 + 1,140. A USD supplier bill booked at 50 and
-- #  paid at 48 does the same for the supplier statement.
-- ############################################################################

SELECT set_config('a05b.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN COALESCE(p_ok, false) THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN COALESCE(p_ok, false) THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('a05b.log', COALESCE(current_setting('a05b.log', true), '') || E'\n' || l, false);
  RETURN l;
END $f$;
CREATE FUNCTION pg_temp.as_user(p_email text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $f$;
CREATE FUNCTION pg_temp.as_owner() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
END $f$;
-- the customer's receivable in the ledger, and on the statement
CREATE FUNCTION pg_temp.ar_ledger(p_customer uuid) RETURNS numeric LANGUAGE sql AS $f$
  SELECT COALESCE(sum(l.debit - l.credit), 0) FROM public.journal_lines l
    JOIN public.posting_rules r ON r.account_id = l.account_id AND r.role = 'accounts_receivable'
   WHERE l.customer_id = p_customer
$f$;
CREATE FUNCTION pg_temp.ar_statement(p_customer uuid) RETURNS numeric LANGUAGE sql AS $f$
  SELECT COALESCE(sum(amount_base), 0) FROM public.v_customer_ledger WHERE customer_id = p_customer
$f$;
-- the checklist is for managers and accountants
CREATE FUNCTION pg_temp.checklist(p_item text) RETURNS numeric LANGUAGE plpgsql AS $f$
DECLARE v numeric;
BEGIN
  PERFORM pg_temp.as_user('a05b-mgr@test.local');
  SELECT amount INTO v FROM public.rma_period_close_checklist(date_trunc('month', public.rma_today())::date) WHERE item = p_item;
  PERFORM pg_temp.as_owner();
  RETURN v;
END $f$;

DO $do$
DECLARE
  v_mgr   text := 'a05b-mgr@test.local';
  v_admin text := 'a05b-admin@test.local';
  v_d     date := public.rma_today();
  v_now   timestamptz := now();
  v_usd   uuid;
  v_egp   uuid;
  v_vend  uuid;
  v_svc   uuid;
  v_inv   uuid;
  v_loc   uuid;
  v_draft uuid;
  v_pay   uuid;
  v_vi    uuid;
  v_vp    uuid;
  v_x     numeric;
  v_y     numeric;
  v_j     jsonb;
  v_draft_before numeric;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active'), (v_admin, 'admin', 'active');
  INSERT INTO public.products (sku, product_name, product_type) VALUES ('A05B-S1', 'A05B support', 'service') RETURNING id INTO v_svc;
  INSERT INTO public.brands (brand_name) VALUES ('A05B Supplier') RETURNING id INTO v_vend;
  INSERT INTO public.exchange_rates (currency, rate_date, rate) VALUES ('USD', v_d, 52)
    ON CONFLICT (currency, rate_date) DO UPDATE SET rate = 52;
  INSERT INTO public.customers (company_name, customer_code, customer_type, currency) VALUES ('A05B US Co', 'A05B-US', 'B2B', 'USD') RETURNING id INTO v_usd;
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('A05B Local Co', 'A05B-EG', 'B2B') RETURNING id INTO v_egp;
  v_draft_before := COALESCE(pg_temp.checklist('draft_sales_invoices'), 0);

  -- ══ 1. two invoices, one in USD at 51, one local ══════════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_inv := (public.create_crm_invoice(v_usd, jsonb_build_array(jsonb_build_object('product_id', v_svc, 'qty', 1, 'unit_price', 100, 'tax_code', 'VAT14')),
            NULL, NULL, NULL, NULL, NULL, v_mgr)).id;
  PERFORM public.set_document_currency('invoice', v_inv, 'USD', 51);
  v_loc := (public.create_crm_invoice(v_egp, jsonb_build_array(jsonb_build_object('product_id', v_svc, 'qty', 1, 'unit_price', 1000, 'tax_code', 'VAT14')),
            NULL, NULL, NULL, NULL, NULL, v_mgr)).id;
  -- a USD draft left for the month-end checklist: 10 at 52 = 520
  v_draft := (public.create_crm_invoice(v_usd, jsonb_build_array(jsonb_build_object('product_id', v_svc, 'qty', 1, 'unit_price', 10, 'tax_code', 'EXEMPT')),
              NULL, NULL, NULL, NULL, NULL, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  UPDATE public.crm_invoices SET doc_status = 'posted', inv_code = 'INV-A05B-1', posted_at = v_now WHERE id = v_inv;
  UPDATE public.crm_invoices SET doc_status = 'posted', inv_code = 'INV-A05B-2', posted_at = v_now WHERE id = v_loc;

  PERFORM pg_temp.check('the statement shows the USD invoice as 114 USD, 5,814 in base',
    EXISTS (SELECT 1 FROM public.v_customer_ledger WHERE id = v_inv AND amount = 114 AND currency = 'USD'
             AND exchange_rate = 51 AND amount_base = 5814),
    '-> ' || (SELECT string_agg(amount || ' ' || currency || ' @' || exchange_rate || ' = ' || amount_base, '; ')
               FROM public.v_customer_ledger WHERE id = v_inv));
  v_x := pg_temp.ar_statement(v_usd); v_y := pg_temp.ar_ledger(v_usd);
  PERFORM pg_temp.check('before payment, the statement in base equals the ledger''s receivable (5,814)',
    v_x = 5814 AND v_x = v_y, '-> statement ' || v_x || ' ledger ' || v_y);

  -- ══ 2. aging in base ═══════════════════════════════════════════════════════
  PERFORM pg_temp.check('the aging counts the USD invoice as 5,814 and the local one as 1,140',
    (SELECT total FROM public.rma_ar_aging(v_d) WHERE customer_id = v_usd) = 5814
    AND (SELECT total FROM public.rma_ar_aging(v_d) WHERE customer_id = v_egp) = 1140,
    '-> ' || (SELECT string_agg(customer_id::text || '=' || total, '; ') FROM public.rma_ar_aging(v_d) WHERE customer_id IN (v_usd, v_egp)));

  -- ══ 3. the reports in base ═════════════════════════════════════════════════
  v_j := public.rma_report_financial(v_now, v_now);
  PERFORM pg_temp.check('the financial report invoices 6,954 (5,814 + 1,140), not 1,254',
    (v_j ->> 'total_invoiced')::numeric = 6954 AND (v_j ->> 'outstanding')::numeric = 6954
    AND v_j ->> 'currency' = public.rma_base_currency(), '-> ' || v_j::text);
  v_j := public.rma_report_sales(v_now, v_now);
  PERFORM pg_temp.check('the sales report''s invoiced value is in base too (the draft at 52 included: 7,474)',
    (v_j #>> '{invoiced,value}')::numeric = 7474, '-> ' || (v_j -> 'invoiced')::text);
  PERFORM pg_temp.check('the Reports invoice table carries the currency and the base amounts',
    EXISTS (SELECT 1 FROM public.v_report_invoices WHERE id = v_inv AND currency = 'USD' AND total = 114 AND total_base = 5814 AND amount_paid_base = 0));
  PERFORM pg_temp.check('the month-end checklist counts the USD draft as 520',
    COALESCE(pg_temp.checklist('draft_sales_invoices'), 0) - v_draft_before = 520,
    '-> ' || (COALESCE(pg_temp.checklist('draft_sales_invoices'), 0) - v_draft_before));

  -- ══ 4. margin: net revenue in base ═════════════════════════════════════════
  PERFORM pg_temp.check('margin revenue is the net 100 at 51 = 5,100 (not the 114 gross in USD)',
    (SELECT revenue_base FROM public.v_invoice_margin WHERE id = v_inv) = 5100
    AND (SELECT revenue_base FROM public.v_invoice_margin WHERE id = v_loc) = 1000,
    '-> ' || (SELECT string_agg(inv_code || '=' || revenue_base, '; ') FROM public.v_invoice_margin WHERE id IN (v_inv, v_loc)));

  -- ══ 5. paid at 53: the exchange difference is on the statement ════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_pay := public.record_payment(v_usd, 114, 'bank_transfer', 'A05B-REF', v_d, NULL, v_mgr,
             jsonb_build_array(jsonb_build_object('invoice_id', v_inv, 'amount', 114)), 'USD', 53);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('the payment is -114 USD, -6,042 in base, with a +228 exchange difference against INV-A05B-1',
    EXISTS (SELECT 1 FROM public.v_customer_ledger WHERE id = v_pay AND amount = -114 AND amount_base = -6042)
    AND EXISTS (SELECT 1 FROM public.v_customer_ledger WHERE customer_id = v_usd AND entry_type = 'exchange_difference'
                 AND entry_code = 'INV-A05B-1' AND amount = 0 AND amount_base = 228),
    '-> ' || (SELECT string_agg(entry_type || ' ' || amount || ' ' || amount_base, '; ') FROM public.v_customer_ledger WHERE customer_id = v_usd));
  v_x := pg_temp.ar_statement(v_usd); v_y := pg_temp.ar_ledger(v_usd);
  PERFORM pg_temp.check('paid, the statement nets to 0 in base, as the ledger does',
    v_x = 0 AND v_y = 0, '-> statement ' || v_x || ' ledger ' || v_y);
  PERFORM pg_temp.check('a paid invoice leaves the aging',
    NOT EXISTS (SELECT 1 FROM public.rma_ar_aging(v_d) WHERE customer_id = v_usd));

  -- reversing the application reverses its difference too
  PERFORM pg_temp.as_user(v_mgr);
  PERFORM public.reverse_payment_application((SELECT id FROM public.payment_applications WHERE payment_id = v_pay AND NOT is_reversal), 'A05B wrong invoice', v_mgr);
  PERFORM pg_temp.as_owner();
  v_x := pg_temp.ar_statement(v_usd); v_y := pg_temp.ar_ledger(v_usd);
  PERFORM pg_temp.check('after reversing the application, statement and ledger still agree (5,814 - 6,042 = -228)',
    v_x = v_y AND v_x = -228, '-> statement ' || v_x || ' ledger ' || v_y);

  -- ══ 6. the supplier statement: a bill at 50 paid at 48 ═══════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := (public.create_vendor_invoice(v_vend, jsonb_build_array(jsonb_build_object('product_id', v_svc, 'qty_ordered', 1, 'unit_cost', 200, 'tax_code', 'EXEMPT')),
           jsonb_build_object('currency', 'USD', 'exchange_rate', 50, 'non_po_reason', 'Services without a purchase order'), v_mgr)).id;
  PERFORM public.update_vendor_invoice(v_vi, NULL, jsonb_build_object('supplier_invoice_no', 'A05B-SUP-1', 'supplier_invoice_date', v_d), v_mgr);
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.as_user(v_admin);
  UPDATE public.vendor_invoices SET status = 'approved', approved_at = now() WHERE id = v_vi;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.as_user(v_mgr);
  v_vp := public.record_vendor_payment(v_vend, 200, 'bank_transfer', 'A05B-VP', v_d, NULL, v_mgr,
            jsonb_build_array(jsonb_build_object('invoice_id', v_vi, 'amount', 200)), 'USD', 48, false);
  PERFORM pg_temp.as_owner();
  SELECT COALESCE(sum(amount_base), 0) INTO v_x FROM public.v_vendor_ledger WHERE vendor_id = v_vend;
  SELECT COALESCE(sum(l.credit - l.debit), 0) INTO v_y FROM public.journal_lines l
    JOIN public.posting_rules r ON r.account_id = l.account_id AND r.role = 'accounts_payable' WHERE l.vendor_id = v_vend;
  PERFORM pg_temp.check('the supplier statement shows the -400 difference and nets to 0, as payables do',
    EXISTS (SELECT 1 FROM public.v_vendor_ledger WHERE vendor_id = v_vend AND entry_type = 'exchange_difference' AND amount_base = -400)
    AND v_x = 0 AND v_y = 0,
    '-> statement ' || v_x || ' ledger ' || v_y || ' / ' ||
    (SELECT string_agg(entry_type || ' ' || amount || ' ' || amount_base, '; ') FROM public.v_vendor_ledger WHERE vendor_id = v_vend));

  -- ══ 7. the replaced views still respect the reader's rights ══════════════
  PERFORM pg_temp.check('every replaced view is still security_invoker',
    NOT EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('public.v_customer_ledger'::regclass, 'public.v_vendor_ledger'::regclass,
                  'public.v_report_invoices'::regclass, 'public.v_invoice_margin'::regclass)
                 AND NOT COALESCE(reloptions, '{}') @> ARRAY['security_invoker=true']));

  RAISE EXCEPTION 'A05B_TEST_DONE %', current_setting('a05b.log', true);
END $do$;
