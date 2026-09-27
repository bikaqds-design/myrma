-- supabase/tests/vendor_payment_controls.sql — P-04b (20260901), rolled back.
-- Paying for goods not yet received needs a prepayment flag; supplier payments
-- can require a second person.
-- #  node scripts/run-sql-test.mjs supabase/tests/vendor_payment_controls.sql P04B_TEST_DONE

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT CASE WHEN p_ok THEN 'PASS  ' || p_label ELSE 'FAIL  ' || p_label || ' ' || COALESCE(p_detail, '') END
$f$;
CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE p_sql;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN 'err:' || SQLSTATE || ' ' || SQLERRM;
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
-- record a payment as a manager; returns 'ok:<id>' or the error
CREATE FUNCTION pg_temp.pay(p_email text, p_vendor uuid, p_amount numeric, p_allocs jsonb, p_prepay boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_id uuid;
BEGIN
  PERFORM pg_temp.as_user(p_email);
  v_id := public.record_vendor_payment(p_vendor, p_amount, 'bank_transfer', 'REF', CURRENT_DATE, NULL, p_email, p_allocs, 'EGP', 1, p_prepay);
  PERFORM pg_temp.as_owner();
  RETURN 'ok:' || v_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.as_owner();
  RETURN 'err:' || SQLSTATE || ' ' || SQLERRM;
END $f$;
-- an order converted whole into a bill and approved, nothing received yet
CREATE FUNCTION pg_temp.approved_bill(p_vendor uuid, p_product uuid, p_qty int, p_cost numeric, p_no text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_po public.purchase_orders; v_vi public.vendor_invoices;
BEGIN
  PERFORM pg_temp.as_user('p04b-mgr1@test.local');
  v_po := public.create_purchase_order(p_vendor, jsonb_build_array(jsonb_build_object('product_id', p_product, 'qty_ordered', p_qty, 'unit_cost', p_cost)),
                                       '{"currency":"EGP"}'::jsonb, 'p04b-mgr1@test.local');
  PERFORM pg_temp.as_owner();
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po.id;
  PERFORM pg_temp.as_user('p04b-mgr1@test.local');
  v_vi := public.convert_po_to_vendor_invoice(v_po.id, 'p04b-mgr1@test.local');
  PERFORM public.update_vendor_invoice(v_vi.id, NULL, jsonb_build_object('supplier_invoice_no', p_no, 'supplier_invoice_date', '2026-09-27'), 'p04b-mgr1@test.local');
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi.id;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.as_user('p04b-admin@test.local');
  UPDATE public.vendor_invoices SET status = 'approved', approved_at = now() WHERE id = v_vi.id;
  PERFORM pg_temp.as_owner();
  RETURN v_vi.id;
END $f$;

DO $do$
DECLARE
  v_vendor uuid;
  v_wh  uuid := gen_random_uuid();
  pb    uuid := gen_random_uuid();
  ps    uuid := gen_random_uuid();
  v_vi  uuid;
  v_vi2 uuid;
  v_vi3 uuid;
  v_out text;
  v_pay uuid;
  v_row public.vendor_payments;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES
    ('p04b-mgr1@test.local', 'manager', 'active'), ('p04b-mgr2@test.local', 'manager', 'active'), ('p04b-admin@test.local', 'admin', 'active');
  INSERT INTO public.brands (brand_name) VALUES ('P04b Supplier') RETURNING id INTO v_vendor;
  INSERT INTO public.warehouses (id, name, code, warehouse_type) VALUES (v_wh, 'P04b WH', 'P04B-WH', 'main');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES
    (pb, 'P04B-B', 'P04b cable', 'hardware', 'bulk'),
    (ps, 'P04B-S', 'P04b install', 'service', 'bulk');
  DELETE FROM public.rma_config WHERE config_key IN ('vendor_payment_approval', 'purchase_price_tolerance_pct');
  INSERT INTO public.rma_config (config_key, config_value)
    SELECT 'default_currency', to_jsonb('EGP'::text) WHERE NOT EXISTS (SELECT 1 FROM public.rma_config WHERE config_key = 'default_currency');

  v_vi := pg_temp.approved_bill(v_vendor, pb, 10, 5, 'P04B-1');

  -- ══ 1. paying before the goods arrive ═════════════════════════════════════
  RAISE NOTICE '--- 1. prepayment ---';
  RAISE NOTICE '%', pg_temp.check('fixture: an approved bill with its goods still outstanding', public.rma_vi_goods_outstanding(v_vi));
  v_out := pg_temp.pay('p04b-mgr1@test.local', v_vendor, 20, jsonb_build_array(jsonb_build_object('invoice_id', v_vi, 'amount', 20)));
  RAISE NOTICE '%', pg_temp.check('paying it is refused unless it is a prepayment', v_out LIKE 'err:P0001%have not arrived yet%prepayment%', '-> ' || v_out);
  v_out := pg_temp.pay('p04b-mgr1@test.local', v_vendor, 20, jsonb_build_array(jsonb_build_object('invoice_id', v_vi, 'amount', 20)), true);
  v_pay := substr(v_out, 4)::uuid;
  RAISE NOTICE '%', pg_temp.check('as a prepayment it is paid, and marked so',
    v_out LIKE 'ok:%' AND (SELECT is_prepayment AND status = 'active' AND payment_code LIKE 'VP-%' FROM public.vendor_payments WHERE id = v_pay)
    AND (SELECT amount_paid FROM public.vendor_invoices WHERE id = v_vi) = 20, '-> ' || v_out);

  v_out := pg_temp.pay('p04b-mgr1@test.local', v_vendor, 10, '[]'::jsonb);
  v_pay := substr(v_out, 4)::uuid;
  v_out := pg_temp.call('p04b-mgr1@test.local', format('SELECT public.apply_vendor_payment_to_invoice(%L, %L, 10, %L)', v_pay, v_vi, 'p04b-mgr1@test.local'));
  RAISE NOTICE '%', pg_temp.check('an ordinary payment cannot be applied to it later either', v_out LIKE 'err:P0001%Only a payment marked as a prepayment%', '-> ' || v_out);

  PERFORM pg_temp.as_user('p04b-mgr1@test.local');
  PERFORM public.receive_vendor_invoice(v_vi, jsonb_build_array(jsonb_build_object('product_id', pb, 'warehouse_id', v_wh, 'qty', 10)), 'p04b-mgr1@test.local');
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call('p04b-mgr1@test.local', format('SELECT public.apply_vendor_payment_to_invoice(%L, %L, 10, %L)', v_pay, v_vi, 'p04b-mgr1@test.local'));
  RAISE NOTICE '%', pg_temp.check('once the goods are in, it can', v_out = 'ok' AND NOT public.rma_vi_goods_outstanding(v_vi), '-> ' || v_out);

  -- a bill for a service only, and a bill from goods receipts: nothing to wait for
  INSERT INTO public.vendor_invoices (id, vendor_id, status, currency, exchange_rate, total, subtotal, created_by, supplier_invoice_no, supplier_invoice_date, non_po_reason)
    VALUES (gen_random_uuid(), v_vendor, 'approved', 'EGP', 1, 50, 50, 'p04b-mgr1@test.local', 'P04B-SVC', '2026-09-27', 'Installation visit, no order')
    RETURNING id INTO v_vi2;
  INSERT INTO public.vendor_invoice_lines (vendor_invoice_id, line_no, product_id, product_name, qty_ordered, qty_received, unit_cost, discount_pct, tax_pct)
    VALUES (v_vi2, 0, ps, 'P04b install', 1, 0, 50, 0, 0);
  RAISE NOTICE '%', pg_temp.check('a service is never waited for', NOT public.rma_vi_goods_outstanding(v_vi2));

  -- ══ 2. a second person approves payments ══════════════════════════════════
  RAISE NOTICE '--- 2. approval ---';
  INSERT INTO public.rma_config (config_key, config_value) VALUES ('vendor_payment_approval', 'true'::jsonb);
  v_vi3 := pg_temp.approved_bill(v_vendor, pb, 4, 5, 'P04B-3');
  v_out := pg_temp.pay('p04b-mgr1@test.local', v_vendor, 20, jsonb_build_array(jsonb_build_object('invoice_id', v_vi3, 'amount', 20)));
  RAISE NOTICE '%', pg_temp.check('a bad allocation is still refused at once', v_out LIKE 'err:P0001%have not arrived yet%', '-> ' || v_out);
  v_out := pg_temp.pay('p04b-mgr1@test.local', v_vendor, 20, jsonb_build_array(jsonb_build_object('invoice_id', v_vi3, 'amount', 20)), true);
  v_pay := substr(v_out, 4)::uuid;
  SELECT * INTO v_row FROM public.vendor_payments WHERE id = v_pay;
  RAISE NOTICE '%', pg_temp.check('with the setting on, a payment waits: no number, nothing applied, its allocations kept',
    v_row.status = 'pending_approval' AND v_row.payment_code IS NULL AND v_row.unapplied_amount = 20
    AND (SELECT amount_paid FROM public.vendor_invoices WHERE id = v_vi3) = 0
    AND v_row.pending_allocations = jsonb_build_array(jsonb_build_object('invoice_id', v_vi3, 'amount', 20)), '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('a waiting payment is not on the vendor statement',
    NOT EXISTS (SELECT 1 FROM public.v_vendor_ledger WHERE id = v_pay));
  v_out := pg_temp.call('p04b-mgr1@test.local', format('SELECT public.approve_vendor_payment(%L, %L)', v_pay, 'p04b-mgr1@test.local'));
  RAISE NOTICE '%', pg_temp.check('the person who recorded it cannot approve it', v_out LIKE 'err:P0001%recorded a payment cannot approve it%', '-> ' || v_out);
  v_out := pg_temp.call('p04b-mgr2@test.local', format('SELECT public.approve_vendor_payment(%L, %L)', v_pay, 'p04b-mgr2@test.local'));
  SELECT * INTO v_row FROM public.vendor_payments WHERE id = v_pay;
  RAISE NOTICE '%', pg_temp.check('another manager approves it: numbered, active, applied, approver recorded',
    v_out = 'ok' AND v_row.status = 'active' AND v_row.payment_code LIKE 'VP-%' AND v_row.approved_by = 'p04b-mgr2@test.local'
    AND v_row.pending_allocations IS NULL AND v_row.unapplied_amount = 0
    AND (SELECT amount_paid FROM public.vendor_invoices WHERE id = v_vi3) = 20, '-> ' || v_out);
  v_out := pg_temp.call('p04b-mgr2@test.local', format('SELECT public.approve_vendor_payment(%L, %L)', v_pay, 'p04b-mgr2@test.local'));
  RAISE NOTICE '%', pg_temp.check('... once', v_out LIKE 'err:P0001%Only a payment waiting for approval%', '-> ' || v_out);

  v_out := pg_temp.pay('p04b-mgr1@test.local', v_vendor, 5, '[]'::jsonb);
  v_pay := substr(v_out, 4)::uuid;
  v_out := pg_temp.call('p04b-mgr1@test.local', format('SELECT public.apply_vendor_payment_to_invoice(%L, %L, 5, %L)', v_pay, v_vi, 'p04b-mgr1@test.local'));
  RAISE NOTICE '%', pg_temp.check('a waiting payment cannot be applied', v_out LIKE 'err:%must be active%', '-> ' || v_out);
  v_out := pg_temp.call('p04b-admin@test.local', format('SELECT public.void_vendor_payment(%L, %L, %L)', v_pay, 'Not agreed with the supplier', 'p04b-admin@test.local'));
  RAISE NOTICE '%', pg_temp.check('a waiting payment is turned down by voiding it, with no number used',
    v_out = 'ok' AND (SELECT status = 'voided' AND payment_code IS NULL FROM public.vendor_payments WHERE id = v_pay), '-> ' || v_out);

  RAISE NOTICE '%', pg_temp.check('nobody but the database runs the allocation step',
    NOT has_function_privilege('authenticated', 'public._vendor_payment_allocate(uuid, uuid, character, numeric, jsonb, boolean, text, boolean)', 'EXECUTE'));

  RAISE EXCEPTION 'P04B_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
