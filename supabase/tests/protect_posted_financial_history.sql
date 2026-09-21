-- ############################################################################
-- #  PROTECT POSTED FINANCIAL HISTORY — BL-01 / I-01 (20260875)
-- #
-- #  Reproduces a signed-in admin call (same technique as
-- #  authenticated_role_probes.sql: spoof the JWT claims PostgREST would set,
-- #  SET LOCAL ROLE authenticated) against each of the four gaps the migration
-- #  closes, plus the two adjacent checks the backlog item names explicitly:
-- #  the financial report and a live restore.
-- #
-- #  HOW TO RUN: paste into the SQL editor (or execute_sql) against a project
-- #  that has 20260875 applied. ENDS WITH A FORCED ROLLBACK — nothing it
-- #  creates or changes is kept. Reference script, not run by CI (db-tests is
-- #  disabled) — see authenticated_role_probes.sql for why.
-- ############################################################################

CREATE FUNCTION pg_temp.probe(p_label text, p_email text, p_sql text, p_expect text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  n bigint;
  outcome text;
  ok boolean;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    outcome := 'ok:' || n;
  EXCEPTION WHEN OTHERS THEN
    outcome := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

  IF p_expect = 'p0001' THEN
    ok := outcome LIKE 'err:P0001%';
  ELSE -- 'ok'
    ok := outcome LIKE 'ok:%' AND outcome <> 'ok:0';
  END IF;

  RETURN format('%s  %-46s expect %-5s -> %s',
    CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_expect, outcome);
END $f$;

DO $do$
DECLARE
  v_admin      text := 'bl01-admin@test.local';
  v_customer   uuid := gen_random_uuid();
  v_vendor     uuid := gen_random_uuid();
  v_inv_draft1 uuid := gen_random_uuid();
  v_inv_draft2 uuid := gen_random_uuid();
  v_inv_posted uuid := gen_random_uuid();
  v_po         uuid := gen_random_uuid();
  v_vi         uuid := gen_random_uuid();
  v_qt_draft   uuid := gen_random_uuid();
  v_qt_sent    uuid := gen_random_uuid();
  v_so_draft   uuid := gen_random_uuid();
  v_so_sent    uuid := gen_random_uuid();
  v_report     jsonb;
  v_session    uuid;
BEGIN
  -- Fixtures. Written as the pooler/superuser role, which the guards already
  -- treat as an RPC-equivalent writer (current_user NOT IN ('authenticated',
  -- 'anon')), so they land regardless of status.
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_admin, 'admin', 'active');
  INSERT INTO public.customers (id, customer_code, customer_type) VALUES (v_customer, 'BL01-CUST', 'B2B');
  INSERT INTO public.brands (id, brand_name) VALUES (v_vendor, 'BL01 Vendor');

  INSERT INTO public.crm_invoices (id, customer_id, doc_status, total, amount_paid, created_by, posted_at)
  VALUES (v_inv_draft1, v_customer, 'draft', 500, 0, 'system@test', NULL),
         (v_inv_draft2, v_customer, 'draft', 700, 0, 'system@test', NULL),
         (v_inv_posted, v_customer, 'posted', 1000, 400, 'system@test', now());
  UPDATE public.crm_invoices SET inv_code = 'INV-2026-99001' WHERE id = v_inv_posted;

  INSERT INTO public.purchase_orders (id, po_code, vendor_id, status, created_by, currency)
  VALUES (v_po, 'PO-BL01TEST', v_vendor, 'confirmed', 'system@test', 'EGP');

  INSERT INTO public.vendor_invoices (id, vendor_id, status, created_by, currency)
  VALUES (v_vi, v_vendor, 'approved', 'system@test', 'EGP');

  INSERT INTO public.quotations (id, qt_code, customer_id, status, created_by)
  VALUES (v_qt_draft, 'QT-BL01A', v_customer, 'draft', 'system@test'),
         (v_qt_sent,  'QT-BL01B', v_customer, 'sent',  'system@test');

  INSERT INTO public.sales_orders (id, so_code, customer_id, status, created_by)
  VALUES (v_so_draft, 'SO-BL01A', v_customer, 'draft', 'system@test'),
         (v_so_sent,  'SO-BL01B', v_customer, 'sent',  'system@test');

  RAISE NOTICE '--- 1. Admin cannot delete or edit a posted/settled document ---';
  RAISE NOTICE '%', pg_temp.probe('DELETE posted invoice', v_admin,
    format('DELETE FROM public.crm_invoices WHERE id = %L', v_inv_posted), 'p0001');
  RAISE NOTICE '%', pg_temp.probe('UPDATE total on posted invoice', v_admin,
    format('UPDATE public.crm_invoices SET total = 9999 WHERE id = %L', v_inv_posted), 'p0001');
  RAISE NOTICE '%', pg_temp.probe('DELETE draft invoice (control)', v_admin,
    format('DELETE FROM public.crm_invoices WHERE id = %L', v_inv_draft1), 'ok');
  RAISE NOTICE '%', pg_temp.probe('DELETE sent quotation', v_admin,
    format('DELETE FROM public.quotations WHERE id = %L', v_qt_sent), 'p0001');
  RAISE NOTICE '%', pg_temp.probe('DELETE draft quotation (control)', v_admin,
    format('DELETE FROM public.quotations WHERE id = %L', v_qt_draft), 'ok');
  RAISE NOTICE '%', pg_temp.probe('DELETE sent sales order', v_admin,
    format('DELETE FROM public.sales_orders WHERE id = %L', v_so_sent), 'p0001');
  RAISE NOTICE '%', pg_temp.probe('DELETE draft sales order (control)', v_admin,
    format('DELETE FROM public.sales_orders WHERE id = %L', v_so_draft), 'ok');

  RAISE NOTICE '--- 2. Confirmed PO / approved VI: locked, status still writable ---';
  RAISE NOTICE '%', pg_temp.probe('UPDATE total on confirmed PO', v_admin,
    format('UPDATE public.purchase_orders SET total = 9999 WHERE id = %L', v_po), 'p0001');
  RAISE NOTICE '%', pg_temp.probe('Cancel a confirmed PO (control)', v_admin,
    format('UPDATE public.purchase_orders SET status = ''cancelled'' WHERE id = %L', v_po), 'ok');
  RAISE NOTICE '%', pg_temp.probe('UPDATE total on approved VI', v_admin,
    format('UPDATE public.vendor_invoices SET total = 9999 WHERE id = %L', v_vi), 'p0001');
  RAISE NOTICE '%', pg_temp.probe('Cancel an approved VI (control)', v_admin,
    format('UPDATE public.vendor_invoices SET status = ''cancelled'' WHERE id = %L', v_vi), 'ok');

  RAISE NOTICE '--- 3. rma_report_financial counts posted invoices by posted_at ---';
  v_report := public.rma_report_financial(now() - interval '1 hour', now() + interval '1 hour');
  IF (v_report ->> 'invoices')::int = 1
     AND (v_report ->> 'total_invoiced')::numeric = 1000
     AND (v_report ->> 'total_paid')::numeric = 400
     AND (v_report ->> 'outstanding')::numeric = 600
  THEN
    RAISE NOTICE 'PASS  rma_report_financial: 2 drafts ignored, posted invoice only -> %', v_report;
  ELSE
    RAISE NOTICE 'FAIL  rma_report_financial: expected invoices=1/total=1000/paid=400/outstanding=600, got %', v_report;
  END IF;

  RAISE NOTICE '--- 4. Restore still succeeds end to end ---';
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    v_session := public.rma_restore_begin();
    PERFORM public.rma_restore_stage(v_session, 'crm_invoices', jsonb_build_array(
      jsonb_build_object('id', v_inv_posted, 'customer_id', v_customer, 'doc_status', 'posted',
                          'total', 1000, 'amount_paid', 400, 'created_by', 'system@test')));
    PERFORM public.rma_restore_apply(v_session);
    RAISE NOTICE 'PASS  restore (begin/stage/apply) on a posted invoice succeeded';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'FAIL  restore raised: % %', SQLSTATE, SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

  RAISE EXCEPTION 'BL01_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
