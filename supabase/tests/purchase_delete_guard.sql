-- ############################################################################
-- #  PURCHASE DELETE GUARD (20260892)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/purchase_delete_guard.sql PDG_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;

CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  IF p_email IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
  BEGIN
    EXECUTE p_sql;
    out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 160);
  END;
  IF p_email IS NOT NULL THEN
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;
  RETURN out;
END $f$;

DO $do$
DECLARE
  v_mgr  text := 'pdg-mgr@test.local';
  v_v1   uuid := gen_random_uuid();
  v_po   uuid := gen_random_uuid();
  v_po2  uuid := gen_random_uuid();
  v_vi   uuid := gen_random_uuid();
  v_vi2  uuid := gen_random_uuid();
  v_out  text;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active');
  INSERT INTO public.brands (id, brand_name) VALUES (v_v1, 'PDG Vendor');
  -- as the owner: fixtures in the states that matter
  INSERT INTO public.purchase_orders (id, po_code, vendor_id, status, line_items, currency, created_by) VALUES
    (v_po,  'PO-PDG-CONF',  v_v1, 'draft', '[]', 'EGP', v_mgr),
    (v_po2, 'PO-PDG-DRAFT', v_v1, 'draft', '[]', 'EGP', v_mgr);
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po;
  INSERT INTO public.purchase_order_revisions (po_id, rev_no, snapshot, reason, created_by)
  VALUES (v_po, 1, '{}'::jsonb, 'history that must survive', v_mgr);
  INSERT INTO public.vendor_invoices (id, vendor_id, status, line_items, currency, created_by, supplier_invoice_no) VALUES
    (v_vi,  v_v1, 'draft', '[]', 'EGP', v_mgr, 'PDG-1'),
    (v_vi2, v_v1, 'draft', '[]', 'EGP', v_mgr, 'PDG-2');
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi;
  UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_vi;

  v_out := pg_temp.call(v_mgr, format('DELETE FROM public.purchase_orders WHERE id = %L', v_po));
  RAISE NOTICE '%', pg_temp.check('a manager cannot delete a confirmed purchase order', v_out LIKE 'err:P0001%'
    AND EXISTS (SELECT 1 FROM public.purchase_orders WHERE id = v_po), '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('...so its amendment history survives',
    EXISTS (SELECT 1 FROM public.purchase_order_revisions WHERE po_id = v_po));
  v_out := pg_temp.call(v_mgr, format('DELETE FROM public.vendor_invoices WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('a manager cannot delete an approved vendor invoice', v_out LIKE 'err:P0001%'
    AND EXISTS (SELECT 1 FROM public.vendor_invoices WHERE id = v_vi), '-> ' || v_out);

  v_out := pg_temp.call(v_mgr, format('DELETE FROM public.purchase_orders WHERE id = %L', v_po2));
  RAISE NOTICE '%', pg_temp.check('a draft purchase order can still be deleted', v_out = 'ok'
    AND NOT EXISTS (SELECT 1 FROM public.purchase_orders WHERE id = v_po2), '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('DELETE FROM public.vendor_invoices WHERE id = %L', v_vi2));
  RAISE NOTICE '%', pg_temp.check('a draft vendor invoice can still be deleted', v_out = 'ok'
    AND NOT EXISTS (SELECT 1 FROM public.vendor_invoices WHERE id = v_vi2), '-> ' || v_out);

  v_out := pg_temp.call(NULL, format('DELETE FROM public.purchase_orders WHERE id = %L', v_po));
  RAISE NOTICE '%', pg_temp.check('the owner (an RPC, Backup & Restore) is unaffected', v_out = 'ok', '-> ' || v_out);

  RAISE EXCEPTION 'PDG_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
