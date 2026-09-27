-- ############################################################################
-- #  GENERAL LEDGER, PURCHASE POSTINGS — A-01b (20260907)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/gl_purchase_postings.sql A01BP_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line. Covers the older path
-- #  (an invoice converted from an order, then received on the invoice), a
-- #  cancelled invoice and vendor payments; the goods-receipt path is covered by
-- #  the ledger section of receipt_invoicing.sql.
-- ############################################################################

SELECT set_config('a01bp.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN COALESCE(p_ok, false) THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('a01bp.log', COALESCE(current_setting('a01bp.log', true), '') || E'\n' || l, false);
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
CREATE FUNCTION pg_temp.entry(p_type text, p_id uuid, p_event text) RETURNS text LANGUAGE sql AS $f$
  SELECT string_agg(a.code || CASE WHEN l.debit > 0 THEN ':Dr ' || l.debit ELSE ':Cr ' || l.credit END, ' ' ORDER BY a.code, l.debit DESC)
    FROM public.journal_entries e JOIN public.journal_lines l ON l.entry_id = e.id JOIN public.gl_accounts a ON a.id = l.account_id
   WHERE e.source_type = p_type AND e.source_id = p_id AND e.event = p_event
$f$;
-- net debit of one account over this vendor's lines
CREATE FUNCTION pg_temp.net(p_code text, p_vendor uuid) RETURNS numeric LANGUAGE sql AS $f$
  SELECT COALESCE(sum(l.debit - l.credit), 0) FROM public.journal_lines l JOIN public.gl_accounts a ON a.id = l.account_id
   WHERE a.code = p_code AND l.vendor_id = p_vendor
$f$;
-- submit and approve the way the screen does (approving spend is an administrator's)
CREATE FUNCTION pg_temp.approve(p_mgr text, p_admin text, p_vi uuid, p_no text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_temp.as_user(p_mgr);
  PERFORM public.update_vendor_invoice(p_vi, NULL, jsonb_build_object('supplier_invoice_no', p_no, 'supplier_invoice_date', '2026-09-25'), p_mgr);
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = p_vi;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.as_user(p_admin);
  UPDATE public.vendor_invoices SET status = 'approved', approved_at = now() WHERE id = p_vi;
  PERFORM pg_temp.as_owner();
END $f$;

DO $do$
DECLARE
  v_mgr    text := 'a01bp-mgr@test.local';
  v_admin  text := 'a01bp-admin@test.local';
  v_vendor uuid;
  v_wh     uuid := gen_random_uuid();
  v_cable  uuid := gen_random_uuid();
  v_po     public.purchase_orders;
  v_po2    public.purchase_orders;
  v_vi     public.vendor_invoices;
  v_vi2    public.vendor_invoices;
  v_pay    uuid := gen_random_uuid();
  v_pay2   uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active'), (v_admin, 'admin', 'active');
  INSERT INTO public.brands (brand_name) VALUES ('A01bp Supplier') RETURNING id INTO v_vendor;
  INSERT INTO public.warehouses (id, name, code, warehouse_type) VALUES (v_wh, 'A01bp WH', 'A01BP-WH', 'main');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode)
  VALUES (v_cable, 'A01BP-CABLE', 'A01bp cable', 'hardware', 'bulk');

  -- ══ 1. the older path: an order invoiced whole, then received on the invoice ══
  -- 10 cables at 5 USD + 10% tax, at 2.0; the supplier bills 20 USD of freight
  PERFORM pg_temp.as_user(v_mgr);
  v_po := public.create_purchase_order(v_vendor, jsonb_build_array(
    jsonb_build_object('product_id', v_cable, 'qty_ordered', 10, 'unit_cost', 5, 'tax_pct', 10)),
    '{"currency":"USD","exchange_rate":2}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po.id;
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := public.convert_po_to_vendor_invoice(v_po.id, v_mgr);
  INSERT INTO public.vendor_invoice_charges (vendor_invoice_id, charge_type, amount) VALUES (v_vi.id, 'freight', 20);
  PERFORM pg_temp.as_owner();
  SELECT * INTO v_vi FROM public.vendor_invoices WHERE id = v_vi.id;
  PERFORM pg_temp.check('fixture: a 55 USD invoice (50 + 5 tax) with 20 USD of freight', v_vi.total = 55 AND v_vi.tax_amount = 5,
    '-> ' || v_vi.total || ' / ' || v_vi.tax_amount);
  PERFORM pg_temp.check('a draft invoice posts nothing',
    NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE source_id = v_vi.id));

  PERFORM pg_temp.approve(v_mgr, v_admin, v_vi.id, 'A01BP-SUP-1');
  PERFORM pg_temp.check('approved: Cr payables 110, Cr freight owed 40, Dr VAT 10, Dr goods not yet received 140',
    pg_temp.entry('vendor_invoice', v_vi.id, 'approved') = '1400:Dr 10.00 2100:Cr 110.00 2150:Dr 140.00 2160:Cr 40.00',
    '-> ' || COALESCE(pg_temp.entry('vendor_invoice', v_vi.id, 'approved'), 'nothing'));
  PERFORM pg_temp.check('the payable names the vendor',
    EXISTS (SELECT 1 FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id
             WHERE e.source_id = v_vi.id AND l.credit = 110 AND l.vendor_id = v_vendor));

  -- received in two lots: 4 then 6, each at the landed cost (5 + 2 freight) x 2.0 = 14
  PERFORM pg_temp.as_user(v_mgr);
  PERFORM public.receive_vendor_invoice(v_vi.id, jsonb_build_array(jsonb_build_object('product_id', v_cable, 'warehouse_id', v_wh, 'qty', 4)), v_mgr);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('receiving 4: Dr inventory 56 / Cr goods not yet received 56',
    pg_temp.entry('vendor_invoice', v_vi.id, 'received:0:4') = '1300:Dr 56.00 2150:Cr 56.00',
    '-> ' || COALESCE((SELECT string_agg(event, ',') FROM public.journal_entries WHERE source_id = v_vi.id), 'nothing'));
  PERFORM pg_temp.as_user(v_mgr);
  PERFORM public.receive_vendor_invoice(v_vi.id, jsonb_build_array(jsonb_build_object('product_id', v_cable, 'warehouse_id', v_wh, 'qty', 6)), v_mgr);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('receiving the other 6 posts 84, and the clearing account is back to 0',
    pg_temp.entry('vendor_invoice', v_vi.id, 'received:0:10') = '1300:Dr 84.00 2150:Cr 84.00'
    AND pg_temp.net('2150', v_vendor) = 0,
    '-> ' || pg_temp.net('2150', v_vendor));
  PERFORM pg_temp.check('the ledger''s inventory for these goods equals the stock''s cost (140)',
    pg_temp.net('1300', v_vendor) = 140
    AND (SELECT total_cost_base FROM public.warehouse_stock WHERE product_id = v_cable AND warehouse_id = v_wh) = 140,
    '-> ' || pg_temp.net('1300', v_vendor) || ' / ' || (SELECT total_cost_base FROM public.warehouse_stock WHERE product_id = v_cable AND warehouse_id = v_wh));

  -- ══ 2. an approved invoice cancelled before anything arrives ═════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_po2 := public.create_purchase_order(v_vendor, jsonb_build_array(
    jsonb_build_object('product_id', v_cable, 'qty_ordered', 2, 'unit_cost', 5)), '{"currency":"USD","exchange_rate":2}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po2.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po2.id;
  PERFORM pg_temp.as_user(v_mgr);
  v_vi2 := public.convert_po_to_vendor_invoice(v_po2.id, v_mgr);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.approve(v_mgr, v_admin, v_vi2.id, 'A01BP-SUP-2');
  PERFORM pg_temp.as_user(v_admin);
  UPDATE public.vendor_invoices SET status = 'cancelled' WHERE id = v_vi2.id;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('cancelling it reverses its approval entry',
    pg_temp.entry('vendor_invoice', v_vi2.id, 'approved') = '2100:Cr 20.00 2150:Dr 20.00'
    AND pg_temp.entry('vendor_invoice', v_vi2.id, 'cancelled') = '2100:Dr 20.00 2150:Cr 20.00',
    '-> ' || COALESCE(pg_temp.entry('vendor_invoice', v_vi2.id, 'cancelled'), 'nothing'));

  -- ══ 3. vendor payments ═════════════════════════════════════════════════════
  INSERT INTO public.vendor_payments (id, payment_code, vendor_id, amount, unapplied_amount, method, created_by, payment_date, currency, exchange_rate, status)
  VALUES (v_pay, 'VP-A01BP-1', v_vendor, 30, 30, 'bank_transfer', v_mgr, DATE '2026-09-22', 'USD', 2.1, 'active');
  PERFORM pg_temp.check('a payment: Dr payables / Cr cash, at its own rate (30 x 2.1 = 63), on its date',
    pg_temp.entry('vendor_payment', v_pay, 'paid') = '1110:Cr 63.00 2100:Dr 63.00'
    AND (SELECT entry_date FROM public.journal_entries WHERE source_id = v_pay) = DATE '2026-09-22',
    '-> ' || COALESCE(pg_temp.entry('vendor_payment', v_pay, 'paid'), 'nothing'));
  UPDATE public.vendor_payments SET status = 'voided', voided_at = now(), void_reason = 'test' WHERE id = v_pay;
  PERFORM pg_temp.check('voided: reversed', pg_temp.entry('vendor_payment', v_pay, 'voided') = '1110:Dr 63.00 2100:Cr 63.00');

  INSERT INTO public.vendor_payments (id, vendor_id, amount, unapplied_amount, method, created_by, currency, exchange_rate, status)
  VALUES (v_pay2, v_vendor, 10, 10, 'cash', v_mgr, 'EGP', 1, 'pending_approval');
  PERFORM pg_temp.check('a payment waiting for approval posts nothing',
    NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE source_id = v_pay2));
  UPDATE public.vendor_payments SET status = 'active', payment_code = 'VP-A01BP-2', approved_at = now() WHERE id = v_pay2;
  PERFORM pg_temp.check('approved: it posts', pg_temp.entry('vendor_payment', v_pay2, 'paid') = '1110:Cr 10.00 2100:Dr 10.00');

  -- ══ 4. the books balance ══════════════════════════════════════════════════
  PERFORM pg_temp.check('every entry here balances',
    NOT EXISTS (SELECT 1 FROM public.journal_entries e
                 WHERE e.source_id IN (v_vi.id, v_vi2.id, v_pay, v_pay2)
                   AND (SELECT sum(debit) - sum(credit) FROM public.journal_lines WHERE entry_id = e.id) <> 0)
    AND (SELECT count(*) FROM public.journal_entries WHERE source_id IN (v_vi.id, v_vi2.id, v_pay, v_pay2)) = 8);
  PERFORM pg_temp.check('the vendor is owed 110 + 20 - 20 - 10 = 100 in the ledger',
    -pg_temp.net('2100', v_vendor) = 100, '-> ' || -pg_temp.net('2100', v_vendor));
  -- raises here (and stops the script) if any entry does not balance
  SET CONSTRAINTS trg_journal_lines_balanced, trg_journal_entries_balanced IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.check('entries pass the commit-time check', true);

  PERFORM pg_temp.check('the new role has its account, and no client runs the triggers',
    (SELECT a.code FROM public.posting_rules r JOIN public.gl_accounts a ON a.id = r.account_id WHERE r.role = 'accrued_landed_costs') = '2160'
    AND NOT has_function_privilege('authenticated', 'public.rma_gl_post_vendor_invoice()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._gl_line(text, numeric, uuid)', 'EXECUTE'));

  RAISE EXCEPTION 'A01BP_TEST_DONE %', current_setting('a01bp.log', true);
END $do$;
