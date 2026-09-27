-- ############################################################################
-- #  GENERAL LEDGER, SALES POSTINGS — A-01b (20260906)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/gl_sales_postings.sql A01B_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line, for runners that do not
-- #  show notices. The status changes are made as the owner, as the RPCs make
-- #  them (the posting triggers fire on any writer); the payment void goes
-- #  through void_payment as a manager.
-- ############################################################################

SELECT set_config('a01b.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN COALESCE(p_ok, false) THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('a01b.log', COALESCE(current_setting('a01b.log', true), '') || E'\n' || l, false);
  RETURN l;
END $f$;
CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN out;
END $f$;
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN 'err:' || SQLSTATE || ' ' || left(SQLERRM, 200);
END $f$;
-- the lines of one (source, event) entry as 'role-code:Dr|Cr amount' sorted
CREATE FUNCTION pg_temp.entry(p_type text, p_id uuid, p_event text) RETURNS text LANGUAGE sql AS $f$
  SELECT string_agg(a.code || CASE WHEN l.debit > 0 THEN ':Dr ' || l.debit ELSE ':Cr ' || l.credit END, ' ' ORDER BY a.code, l.debit DESC)
    FROM public.journal_entries e
    JOIN public.journal_lines l ON l.entry_id = e.id
    JOIN public.gl_accounts a ON a.id = l.account_id
   WHERE e.source_type = p_type AND e.source_id = p_id AND e.event = p_event
$f$;
CREATE FUNCTION pg_temp.entries(p_id uuid) RETURNS integer LANGUAGE sql AS $f$
  SELECT count(*)::integer FROM public.journal_entries WHERE source_id = p_id
$f$;

DO $do$
DECLARE
  v_mgr   text := 'a01b-mgr@test.local';
  v_cust  uuid;
  v_prod  uuid;
  v_wh    uuid;
  v_so    uuid;
  v_sol   uuid;
  v_dlv   uuid;
  v_dl1   uuid;
  v_inv   uuid := gen_random_uuid();
  v_inv2  uuid := gen_random_uuid();
  v_inv3  uuid := gen_random_uuid();
  v_cn    uuid := gen_random_uuid();
  v_pay   uuid := gen_random_uuid();
  v_pay2  uuid := gen_random_uuid();
  v_rf    uuid := gen_random_uuid();
  v_rtn   uuid := gen_random_uuid();
  v_out   text;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('A01b Co', 'A01B-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.products (sku, product_name, product_type) VALUES ('A01B-P1', 'A01b router', 'hardware') RETURNING id INTO v_prod;
  INSERT INTO public.warehouses (name, code, warehouse_type) VALUES ('A01b main', 'A01B-MAIN', 'main') RETURNING id INTO v_wh;

  -- ══ 1. invoices ═══════════════════════════════════════════════════════════
  INSERT INTO public.crm_invoices (id, customer_id, created_by, doc_status, subtotal, tax_amount, total, line_items)
  VALUES (v_inv, v_cust, v_mgr, 'draft', 100, 15, 115, '[]');
  UPDATE public.crm_invoices SET doc_status = 'posted', inv_code = 'INV-A01B-1', posted_at = now() WHERE id = v_inv;
  PERFORM pg_temp.check('a posted invoice: Dr receivables total / Cr revenue net / Cr VAT tax',
    pg_temp.entry('crm_invoice', v_inv, 'posted') = '1200:Dr 115.00 2200:Cr 15.00 4100:Cr 100.00',
    '-> ' || COALESCE(pg_temp.entry('crm_invoice', v_inv, 'posted'), 'nothing'));
  PERFORM pg_temp.check('the receivables line names the customer',
    EXISTS (SELECT 1 FROM public.journal_entries e JOIN public.journal_lines l ON l.entry_id = e.id
             WHERE e.source_id = v_inv AND l.debit = 115 AND l.customer_id = v_cust));
  -- post_invoice sets a whole-order invoice's cost in a second update
  UPDATE public.crm_invoices SET cogs_base = 40, cogs_unknown_qty = 0 WHERE id = v_inv;
  PERFORM pg_temp.check('a whole-order invoice posts its cost of goods once, the sale once',
    pg_temp.entry('crm_invoice', v_inv, 'cogs') = '1300:Cr 40.00 5100:Dr 40.00' AND pg_temp.entries(v_inv) = 2,
    '-> ' || COALESCE(pg_temp.entry('crm_invoice', v_inv, 'cogs'), 'nothing') || ' / ' || pg_temp.entries(v_inv));

  UPDATE public.crm_invoices SET doc_status = 'cancelled', cogs_base = NULL, void_reason = 'test' WHERE id = v_inv;
  PERFORM pg_temp.check('voiding it reverses the sale and the cost',
    pg_temp.entry('crm_invoice', v_inv, 'voided') = '1200:Cr 115.00 2200:Dr 15.00 4100:Dr 100.00'
    AND pg_temp.entry('crm_invoice', v_inv, 'voided_cogs') = '1300:Dr 40.00 5100:Cr 40.00',
    '-> ' || COALESCE(pg_temp.entry('crm_invoice', v_inv, 'voided'), 'nothing'));

  INSERT INTO public.crm_invoices (id, customer_id, created_by, doc_status, subtotal, tax_amount, total, line_items)
  VALUES (v_inv2, v_cust, v_mgr, 'draft', 10, 0, 10, '[]');
  UPDATE public.crm_invoices SET doc_status = 'cancelled' WHERE id = v_inv2;
  PERFORM pg_temp.check('a draft cancelled posts nothing', pg_temp.entries(v_inv2) = 0);

  -- ══ 2. deliveries: the goods leave, cost of goods posts ═══════════════════
  INSERT INTO public.sales_orders (so_code, customer_id, created_by, status) VALUES ('SO-A01B-1', v_cust, v_mgr, 'confirmed') RETURNING id INTO v_so;
  INSERT INTO public.sales_order_lines (sales_order_id, line_no, product_id, product_name, qty, unit_price)
  VALUES (v_so, 0, v_prod, 'A01b router', 5, 50) RETURNING id INTO v_sol;
  INSERT INTO public.deliveries (sales_order_id, customer_id, created_by, status) VALUES (v_so, v_cust, v_mgr, 'draft') RETURNING id INTO v_dlv;
  INSERT INTO public.delivery_lines (delivery_id, line_no, sales_order_line_id, product_id, product_name, qty, cogs_base, cogs_unknown_qty)
  VALUES (v_dlv, 0, v_sol, v_prod, 'A01b router', 3, 90, 0) RETURNING id INTO v_dl1;
  PERFORM pg_temp.check('a draft delivery posts nothing', pg_temp.entries(v_dlv) = 0);
  UPDATE public.deliveries SET status = 'confirmed', delivery_code = 'DN-A01B-1', confirmed_at = now(), confirmed_by = v_mgr WHERE id = v_dlv;
  PERFORM pg_temp.check('a confirmed delivery: Dr cost of goods / Cr inventory, its lines'' cost',
    pg_temp.entry('delivery', v_dlv, 'confirmed') = '1300:Cr 90.00 5100:Dr 90.00',
    '-> ' || COALESCE(pg_temp.entry('delivery', v_dlv, 'confirmed'), 'nothing'));

  -- its invoice posts the sale, and no cost (the delivery did)
  INSERT INTO public.crm_invoices (id, customer_id, created_by, doc_status, subtotal, tax_amount, total, line_items, so_id, delivery_id)
  VALUES (v_inv3, v_cust, v_mgr, 'draft', 150, 0, 150, '[]', v_so, v_dlv);
  UPDATE public.crm_invoices SET doc_status = 'posted', inv_code = 'INV-A01B-3', posted_at = now() WHERE id = v_inv3;
  UPDATE public.crm_invoices SET cogs_base = 90, cogs_unknown_qty = 0 WHERE id = v_inv3;
  PERFORM pg_temp.check('a delivery''s invoice posts the sale but no second cost of goods',
    pg_temp.entry('crm_invoice', v_inv3, 'posted') = '1200:Dr 150.00 4100:Cr 150.00'
    AND pg_temp.entry('crm_invoice', v_inv3, 'cogs') IS NULL);

  -- ══ 3. a return brings the goods back ═════════════════════════════════════
  INSERT INTO public.customer_returns (id, delivery_id, sales_order_id, customer_id, created_by, status)
  VALUES (v_rtn, v_dlv, v_so, v_cust, v_mgr, 'draft');
  INSERT INTO public.customer_return_lines (customer_return_id, line_no, delivery_line_id, product_id, product_name, qty, warehouse_id, cost_base, cost_unknown_qty)
  VALUES (v_rtn, 0, v_dl1, v_prod, 'A01b router', 1, v_wh, 30, 0);
  UPDATE public.customer_returns SET status = 'confirmed', return_code = 'RTN-A01B-1', confirmed_at = now(), confirmed_by = v_mgr WHERE id = v_rtn;
  PERFORM pg_temp.check('a confirmed return: Dr inventory / Cr cost of goods',
    pg_temp.entry('customer_return', v_rtn, 'confirmed') = '1300:Dr 30.00 5100:Cr 30.00',
    '-> ' || COALESCE(pg_temp.entry('customer_return', v_rtn, 'confirmed'), 'nothing'));

  -- ══ 4. credit notes ═══════════════════════════════════════════════════════
  INSERT INTO public.credit_notes (id, type, customer_id, reason, reason_code, created_by, status, subtotal, tax_amount, total, remaining_balance)
  VALUES (v_cn, 'rebate', v_cust, 'Volume rebate', 'rebate', v_mgr, 'draft', 50, 7.5, 57.5, 57.5);
  UPDATE public.credit_notes SET status = 'issued', cn_code = 'CN-A01B-1', issued_at = now() WHERE id = v_cn;
  PERFORM pg_temp.check('an issued credit note: Dr revenue, Dr VAT / Cr receivables',
    pg_temp.entry('credit_note', v_cn, 'issued') = '1200:Cr 57.50 2200:Dr 7.50 4100:Dr 50.00',
    '-> ' || COALESCE(pg_temp.entry('credit_note', v_cn, 'issued'), 'nothing'));
  UPDATE public.credit_notes SET status = 'applied' WHERE id = v_cn;
  PERFORM pg_temp.check('being applied posts nothing more', pg_temp.entries(v_cn) = 1);
  UPDATE public.credit_notes SET status = 'voided', voided_at = now(), void_reason = 'test' WHERE id = v_cn;
  PERFORM pg_temp.check('voiding it reverses it',
    pg_temp.entry('credit_note', v_cn, 'voided') = '1200:Dr 57.50 2200:Cr 7.50 4100:Cr 50.00');

  -- ══ 5. payments and refunds ═══════════════════════════════════════════════
  INSERT INTO public.payments (id, payment_code, customer_id, amount, unapplied_amount, method, created_by, payment_date)
  VALUES (v_pay, 'PAY-A01B-1', v_cust, 200, 200, 'bank_transfer', v_mgr, DATE '2026-09-20');
  PERFORM pg_temp.check('a recorded payment: Dr cash / Cr receivables, on its payment date',
    pg_temp.entry('payment', v_pay, 'recorded') = '1110:Dr 200.00 1200:Cr 200.00'
    AND (SELECT entry_date FROM public.journal_entries WHERE source_id = v_pay AND event = 'recorded') = DATE '2026-09-20',
    '-> ' || COALESCE(pg_temp.entry('payment', v_pay, 'recorded'), 'nothing'));
  v_out := pg_temp.call(v_mgr, format('SELECT public.void_payment(%L, %L, %L)', v_pay, 'entered twice', v_mgr));
  PERFORM pg_temp.check('void_payment reverses it',
    v_out = 'ok' AND pg_temp.entry('payment', v_pay, 'voided') = '1110:Cr 200.00 1200:Dr 200.00', '-> ' || v_out);

  INSERT INTO public.payments (id, payment_code, customer_id, amount, unapplied_amount, method, created_by)
  VALUES (v_pay2, 'PAY-A01B-2', v_cust, 80, 80, 'cash', v_mgr);
  INSERT INTO public.customer_refunds (id, customer_id, payment_id, amount, method, created_by, refund_date)
  VALUES (v_rf, v_cust, v_pay2, 30, 'cash', v_mgr, DATE '2026-09-21');
  PERFORM pg_temp.check('a refund waiting for approval posts nothing', pg_temp.entries(v_rf) = 0);
  UPDATE public.customer_refunds SET status = 'approved', refund_code = 'RF-A01B-1', approved_at = now(), approved_by = 'x@y' WHERE id = v_rf;
  PERFORM pg_temp.check('an approved refund: Dr receivables / Cr cash, on its refund date',
    pg_temp.entry('customer_refund', v_rf, 'approved') = '1110:Cr 30.00 1200:Dr 30.00'
    AND (SELECT entry_date FROM public.journal_entries WHERE source_id = v_rf) = DATE '2026-09-21',
    '-> ' || COALESCE(pg_temp.entry('customer_refund', v_rf, 'approved'), 'nothing'));

  -- ══ 6. the books balance; every entry passes the commit-time check ════════
  -- (created_at is the transaction's start, so select this run's entries by their codes)
  PERFORM pg_temp.check('every entry posted here balances, and together they balance',
    (SELECT count(*) = 13 FROM public.journal_entries e WHERE e.source_code LIKE '%-A01B-%')
    AND (SELECT sum(l.debit) = sum(l.credit) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id
      WHERE e.source_code LIKE '%-A01B-%')
    AND NOT EXISTS (SELECT 1 FROM public.journal_entries e WHERE e.source_code LIKE '%-A01B-%'
       AND (SELECT sum(debit) - sum(credit) FROM public.journal_lines WHERE entry_id = e.id) <> 0),
    '-> ' || (SELECT count(*) FROM public.journal_entries e WHERE e.source_code LIKE '%-A01B-%'));
  -- voided invoice, voided credit note and voided payment net to 0 each
  PERFORM pg_temp.check('the customer''s receivables net to 150 billed - 80 paid + 30 refunded',
    (SELECT sum(l.debit) - sum(l.credit) FROM public.journal_lines l WHERE l.customer_id = v_cust) = 100);
  v_out := pg_temp.try('SET CONSTRAINTS trg_journal_lines_balanced, trg_journal_entries_balanced IMMEDIATE');
  PERFORM pg_temp.check('the entries pass the commit-time balance check', v_out = 'ok', '-> ' || v_out);
  SET CONSTRAINTS ALL DEFERRED;

  -- ══ 7. strict: a posting that cannot be made stops the step ═══════════════
  PERFORM set_config('rma.audit_suspended', 'on', true);
  DELETE FROM public.posting_rules WHERE role = 'cash';
  PERFORM set_config('rma.audit_suspended', 'off', true);
  v_out := pg_temp.try(format($s$INSERT INTO public.payments (customer_id, amount, unapplied_amount, method, created_by)
    VALUES (%L, 10, 10, 'cash', 'x@y')$s$, v_cust));
  PERFORM pg_temp.check('with no cash account, recording a payment fails (nothing is left unposted)',
    v_out LIKE 'err:P0001%No account is set for "cash"%'
    AND NOT EXISTS (SELECT 1 FROM public.payments WHERE customer_id = v_cust AND amount = 10), '-> ' || v_out);
  INSERT INTO public.posting_rules (role, account_id) SELECT 'cash', id FROM public.gl_accounts WHERE code = '1110';

  -- ══ 8. a restore posts nothing (it brings the journals back itself) ═══════
  PERFORM set_config('rma.audit_suspended', 'on', true);
  INSERT INTO public.payments (customer_id, amount, unapplied_amount, method, created_by, payment_code)
  VALUES (v_cust, 11, 11, 'cash', 'x@y', 'PAY-A01B-R');
  PERFORM set_config('rma.audit_suspended', 'off', true);
  PERFORM pg_temp.check('a restored payment posts nothing',
    NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE source_code = 'PAY-A01B-R'));

  PERFORM pg_temp.check('no client runs a posting trigger function',
    NOT has_function_privilege('authenticated', 'public.rma_gl_post_crm_invoice()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.rma_gl_post_delivery()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_gl_post_customer_refund()', 'EXECUTE'));

  RAISE EXCEPTION 'A01B_TEST_DONE %', current_setting('a01b.log', true);
END $do$;
