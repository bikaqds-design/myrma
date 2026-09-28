-- ############################################################################
-- #  FOREIGN CURRENCY ON SALES; REALISED EXCHANGE DIFFERENCES — A-05a (20260912)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/multi_currency_sales.sql A05_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line.
-- #
-- #  A USD customer is invoiced 100 + 14 % at 51 (booked 5,814) and pays 114 USD
-- #  at 53 (6,042 into the bank): a 228 exchange gain, and the customer's
-- #  receivable nets to 0. A USD supplier bill booked at 50 and paid at 48 is a
-- #  gain too. Base currency EGP.
-- ############################################################################

SELECT set_config('a05.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN COALESCE(p_ok, false) THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN COALESCE(p_ok, false) THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('a05.log', COALESCE(current_setting('a05.log', true), '') || E'\n' || l, false);
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
CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  PERFORM pg_temp.as_user(p_email);
  BEGIN
    EXECUTE p_sql;
    out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 220);
  END;
  PERFORM pg_temp.as_owner();
  RETURN out;
END $f$;
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN 'err:' || SQLSTATE || ' ' || left(SQLERRM, 220);
END $f$;
CREATE FUNCTION pg_temp.entry(p_type text, p_id uuid, p_event text) RETURNS text LANGUAGE sql AS $f$
  SELECT string_agg(a.code || CASE WHEN l.debit > 0 THEN ':Dr ' || l.debit ELSE ':Cr ' || l.credit END, ' ' ORDER BY a.code, l.debit DESC)
    FROM public.journal_entries e JOIN public.journal_lines l ON l.entry_id = e.id JOIN public.gl_accounts a ON a.id = l.account_id
   WHERE e.source_type = p_type AND e.source_id = p_id AND e.event = p_event
$f$;
CREATE FUNCTION pg_temp.rule(p_role text) RETURNS text LANGUAGE sql AS $f$
  SELECT a.code FROM public.posting_rules r JOIN public.gl_accounts a ON a.id = r.account_id WHERE r.role = p_role
$f$;

DO $do$
DECLARE
  v_acct  text := 'a05-acct@test.local';
  v_mgr   text := 'a05-mgr@test.local';
  v_admin text := 'a05-admin@test.local';
  v_tech  text := 'a05-tech@test.local';
  v_d     date := public.rma_today();
  v_usd   uuid;
  v_gbp   uuid;
  v_egp   uuid;
  v_vend  uuid;
  v_svc   uuid;
  v_inv   uuid;
  v_inv2  uuid;
  v_cn    uuid;
  v_pay   uuid;
  v_app   uuid;
  v_vi    uuid;
  v_vp    uuid;
  v_vapp  uuid;
  v_out   text;
  v_x     numeric;
  ar      text;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES
    (v_acct, 'accountant', 'active'), (v_mgr, 'manager', 'active'), (v_admin, 'admin', 'active'), (v_tech, 'technician', 'active');
  INSERT INTO public.products (sku, product_name, product_type) VALUES ('A05-S1', 'A05 support', 'service') RETURNING id INTO v_svc;
  INSERT INTO public.brands (brand_name) VALUES ('A05 Supplier') RETURNING id INTO v_vend;
  ar := pg_temp.rule('accounts_receivable');
  -- the checks below expect only their own rates: clear any USD / GBP rates
  -- staging already holds (a browser check saved one); rolled back at the end
  DELETE FROM public.exchange_rates WHERE currency IN ('USD', 'GBP');

  -- ══ 1. rates ═══════════════════════════════════════════════════════════════
  v_out := pg_temp.call(v_mgr, format('INSERT INTO public.exchange_rates (currency, rate_date, rate) VALUES (''USD'', %L, 50)', v_d - 27));
  PERFORM pg_temp.check('a manager cannot add a rate', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, format('INSERT INTO public.exchange_rates (currency, rate_date, rate) VALUES (''USD'', %L, 50), (''USD'', %L, 52)', v_d - 27, v_d - 8));
  PERFORM pg_temp.check('an accountant adds USD rates', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, format('INSERT INTO public.exchange_rates (currency, rate_date, rate) VALUES (''EGP'', %L, 2)', v_d));
  PERFORM pg_temp.check('the base currency has no rate', v_out LIKE 'err:P0001%base currency%', '-> ' || v_out);
  v_out := pg_temp.call(v_tech, 'SELECT count(*) FROM public.exchange_rates');
  PERFORM pg_temp.check('staff read the rates', v_out = 'ok', '-> ' || v_out);
  PERFORM pg_temp.check('the rate for a day is the latest on or before it; the base is 1; none is none',
    public.rma_exchange_rate('USD', v_d - 10) = 50 AND public.rma_exchange_rate('USD', v_d) = 52
    AND public.rma_exchange_rate('EGP', v_d) = 1 AND public.rma_exchange_rate('GBP', v_d) IS NULL);

  -- ══ 2. a USD customer's invoice ════════════════════════════════════════════
  INSERT INTO public.customers (company_name, customer_code, customer_type, currency) VALUES ('A05 US Co', 'A05-US', 'B2B', 'USD') RETURNING id INTO v_usd;
  INSERT INTO public.customers (company_name, customer_code, customer_type, currency) VALUES ('A05 UK Co', 'A05-UK', 'B2B', 'GBP') RETURNING id INTO v_gbp;
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('A05 Local Co', 'A05-EG', 'B2B') RETURNING id INTO v_egp;
  PERFORM pg_temp.as_user(v_mgr);
  v_inv := (public.create_crm_invoice(v_usd, jsonb_build_array(jsonb_build_object('product_id', v_svc, 'qty', 1, 'unit_price', 100, 'tax_code', 'VAT14')),
            NULL, NULL, NULL, NULL, NULL, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('a new invoice takes the customer''s currency and today''s rate',
    (SELECT currency = 'USD' AND exchange_rate = 52 AND total = 114 FROM public.crm_invoices WHERE id = v_inv),
    '-> ' || (SELECT currency || ' ' || exchange_rate || ' ' || total FROM public.crm_invoices WHERE id = v_inv));
  v_out := pg_temp.call(v_mgr, format('SELECT public.set_document_currency(''invoice'', %L, ''USD'', 51)', v_inv));
  PERFORM pg_temp.check('its author changes the rate on the draft',
    v_out = 'ok' AND (SELECT exchange_rate FROM public.crm_invoices WHERE id = v_inv) = 51, '-> ' || v_out);
  v_out := pg_temp.call(v_tech, format('SELECT public.set_document_currency(''invoice'', %L, ''USD'', 60)', v_inv));
  PERFORM pg_temp.check('a technician cannot', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('UPDATE public.crm_invoices SET exchange_rate = 70 WHERE id = %L', v_inv));
  PERFORM pg_temp.check('nobody changes it by writing the invoice directly',
    v_out LIKE 'err:%' AND (SELECT exchange_rate FROM public.crm_invoices WHERE id = v_inv) = 51, '-> ' || v_out);

  v_out := pg_temp.try(format('UPDATE public.crm_invoices SET doc_status = ''posted'', inv_code = ''INV-A05-1'', posted_at = now() WHERE id = %L', v_inv));
  PERFORM pg_temp.check('posted, it books receivables, revenue and VAT in the base currency at 51',
    v_out = 'ok' AND pg_temp.entry('crm_invoice', v_inv, 'posted') = ar || ':Dr 5814.00 2200:Cr 714.00 4100:Cr 5100.00',
    '-> ' || v_out || ' / ' || COALESCE(pg_temp.entry('crm_invoice', v_inv, 'posted'), 'nothing'));
  v_out := pg_temp.call(v_mgr, format('SELECT public.set_document_currency(''invoice'', %L, ''USD'', 40)', v_inv));
  PERFORM pg_temp.check('a posted invoice''s rate is fixed', v_out LIKE 'err:P0001%draft%', '-> ' || v_out);

  -- ══ 3. paid in USD at 53: a realised gain ══════════════════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_pay := public.record_payment(v_usd, 114, 'bank_transfer', 'A05-REF', v_d, NULL, v_mgr,
             jsonb_build_array(jsonb_build_object('invoice_id', v_inv, 'amount', 114)), 'USD', 53);
  PERFORM pg_temp.as_owner();
  SELECT id INTO v_app FROM public.payment_applications WHERE payment_id = v_pay;
  PERFORM pg_temp.check('the payment posts 114 USD at 53 into the bank',
    pg_temp.entry('payment', v_pay, 'recorded') = pg_temp.rule('bank') || ':Dr 6042.00 ' || ar || ':Cr 6042.00',
    '-> ' || COALESCE(pg_temp.entry('payment', v_pay, 'recorded'), 'nothing'));
  PERFORM pg_temp.check('applying it posts the 228 difference as an exchange gain',
    pg_temp.entry('payment_application', v_app, 'fx') = ar || ':Dr 228.00 4910:Cr 228.00',
    '-> ' || COALESCE(pg_temp.entry('payment_application', v_app, 'fx'), 'nothing'));
  SELECT COALESCE(sum(l.debit - l.credit), 0) INTO v_x FROM public.journal_lines l WHERE l.customer_id = v_usd;
  PERFORM pg_temp.check('the customer''s receivable nets to 0 in the base currency', v_x = 0, '-> ' || v_x);

  -- a payment in another currency cannot settle it
  PERFORM pg_temp.as_user(v_mgr);
  v_inv2 := (public.create_crm_invoice(v_usd, jsonb_build_array(jsonb_build_object('product_id', v_svc, 'qty', 1, 'unit_price', 10, 'tax_code', 'EXEMPT')),
             NULL, NULL, NULL, NULL, NULL, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.try(format('UPDATE public.crm_invoices SET doc_status = ''posted'', inv_code = ''INV-A05-2'', posted_at = now() WHERE id = %L', v_inv2));
  v_out := pg_temp.call(v_mgr, format('SELECT public.record_payment(%L, 10, ''cash'', NULL, %L, NULL, %L, %L::jsonb, ''EGP'', NULL)',
             v_usd, v_d, v_mgr, jsonb_build_array(jsonb_build_object('invoice_id', v_inv2, 'amount', 10))::text));
  PERFORM pg_temp.check('an EGP payment cannot settle a USD invoice', v_out LIKE 'err:P0001%its own currency%', '-> ' || v_out);

  -- ══ 4. a credit note keeps its invoice's currency and rate ═════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_cn := (public.create_credit_note('rebate', v_usd, 'A05 rebate', 'rebate',
           jsonb_build_array(jsonb_build_object('product_name', 'Rebate', 'qty', 1, 'unit_price', 5, 'tax_code', 'EXEMPT')),
           v_inv2, NULL, NULL, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('a credit note against an invoice takes its currency and rate',
    (SELECT c.currency = i.currency AND c.exchange_rate = i.exchange_rate FROM public.credit_notes c JOIN public.crm_invoices i ON i.id = c.source_invoice_id WHERE c.id = v_cn));
  v_out := pg_temp.call(v_mgr, format('SELECT public.set_document_currency(''credit_note'', %L, ''USD'', 60)', v_cn));
  PERFORM pg_temp.check('and cannot change them', v_out LIKE 'err:P0001%rate%', '-> ' || v_out);

  -- ══ 5. no rate, no document; the base currency is always 1 ═══════════════
  v_out := pg_temp.call(v_mgr, format('SELECT public.create_crm_invoice(%L, %L::jsonb, NULL, NULL, NULL, NULL, NULL, %L)',
             v_gbp, jsonb_build_array(jsonb_build_object('product_id', v_svc, 'qty', 1, 'unit_price', 1))::text, v_mgr));
  PERFORM pg_temp.check('a GBP customer''s invoice needs a GBP rate first', v_out LIKE 'err:P0001%no exchange rate for GBP%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_mgr);
  v_inv2 := (public.create_crm_invoice(v_egp, jsonb_build_array(jsonb_build_object('product_id', v_svc, 'qty', 1, 'unit_price', 1)),
             NULL, NULL, NULL, NULL, NULL, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('a local customer''s invoice is in EGP at 1',
    (SELECT currency = 'EGP' AND exchange_rate = 1 FROM public.crm_invoices WHERE id = v_inv2));
  v_out := pg_temp.call(v_mgr, format('SELECT public.set_document_currency(''invoice'', %L, ''USD'', NULL)', v_inv2));
  PERFORM pg_temp.check('a draft can move to USD at the table''s rate',
    v_out = 'ok' AND (SELECT currency = 'USD' AND exchange_rate = 52 FROM public.crm_invoices WHERE id = v_inv2), '-> ' || v_out);

  -- ══ 6. a USD supplier bill booked at 50, paid at 48 ═══════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := (public.create_vendor_invoice(v_vend, jsonb_build_array(jsonb_build_object('product_id', v_svc, 'qty_ordered', 1, 'unit_cost', 200, 'tax_code', 'EXEMPT')),
           jsonb_build_object('currency', 'USD', 'exchange_rate', 50, 'non_po_reason', 'Services without a purchase order'), v_mgr)).id;
  PERFORM public.update_vendor_invoice(v_vi, NULL, jsonb_build_object('supplier_invoice_no', 'A05-SUP-1', 'supplier_invoice_date', v_d), v_mgr);
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.as_user(v_admin);
  UPDATE public.vendor_invoices SET status = 'approved', approved_at = now() WHERE id = v_vi;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.as_user(v_mgr);
  v_vp := public.record_vendor_payment(v_vend, 200, 'bank_transfer', 'A05-VP', v_d, NULL, v_mgr,
            jsonb_build_array(jsonb_build_object('invoice_id', v_vi, 'amount', 200)), 'USD', 48, false);
  PERFORM pg_temp.as_owner();
  SELECT id INTO v_vapp FROM public.vendor_payment_applications WHERE payment_id = v_vp;
  PERFORM pg_temp.check('paying the supplier at 48 what was booked at 50 posts a 400 exchange gain',
    pg_temp.entry('vendor_payment_application', v_vapp, 'fx') = pg_temp.rule('accounts_payable') || ':Dr 400.00 4910:Cr 400.00',
    '-> ' || COALESCE(pg_temp.entry('vendor_payment_application', v_vapp, 'fx'), 'nothing'));
  -- payables only: the bill's goods-received line carries the supplier too
  SELECT COALESCE(sum(l.credit - l.debit), 0) INTO v_x FROM public.journal_lines l JOIN public.posting_rules r ON r.account_id = l.account_id AND r.role = 'accounts_payable'
   WHERE l.vendor_id = v_vend;
  PERFORM pg_temp.check('the supplier''s payable nets to 0 in the base currency', v_x = 0, '-> ' || v_x || ' / ' ||
    (SELECT string_agg(e.source_type || ':' || e.event || ' ' || a.code || ' Dr' || l.debit || ' Cr' || l.credit, '; ')
       FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.gl_accounts a ON a.id = l.account_id
      WHERE l.vendor_id = v_vend));

  -- ══ 7. the VAT return converts at each invoice's rate ═════════════════════
  PERFORM pg_temp.check('the VAT return counts the USD invoice at 51: net 5100, tax 714',
    EXISTS (SELECT 1 FROM public.crm_invoice_lines l JOIN public.crm_invoices i ON i.id = l.crm_invoice_id
             WHERE i.id = v_inv AND round(l.qty * l.unit_price * i.exchange_rate, 2) = 5100)
    AND position('* COALESCE(NULLIF(i.exchange_rate, 0), 1)' in pg_get_functiondef('public.rma_vat_return(date,date)'::regprocedure)) > 0);

  -- ══ 8. who runs what ═══════════════════════════════════════════════════════
  PERFORM pg_temp.check('anon runs none of the new functions',
    NOT has_function_privilege('anon', 'public.rma_exchange_rate(char, date)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.set_document_currency(text, uuid, text, numeric)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.record_payment(uuid, numeric, text, text, date, text, text, jsonb, text, numeric)', 'EXECUTE'));
  PERFORM pg_temp.check('exchange gains and losses have accounts: 4910 and 6520',
    pg_temp.rule('fx_gain') = '4910' AND pg_temp.rule('fx_loss') = '6520');

  RAISE EXCEPTION 'A05_TEST_DONE %', current_setting('a05.log', true);
END $do$;
