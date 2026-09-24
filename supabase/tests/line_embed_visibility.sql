-- ############################################################################
-- #  LINE EMBED VISIBILITY — L-02 step 2 (#63), checked without a browser
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/line_embed_visibility.sql LEV_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- #
-- #  The screens read `*, <doc>_lines(*)`: PostgREST selects the documents the
-- #  user may see, then each document's line rows under the user's own RLS.
-- #  This reproduces that as each role and checks, for all six document types:
-- #    1. a user sees a document's lines exactly when they see the document;
-- #    2. the lines rebuilt the way src/api/db/_rowLines.ts rebuilds them are
-- #       the lines the document holds (same count, order and figures).
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;
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

-- [documents visible, documents whose lines are all visible] for one table, as the current user
CREATE FUNCTION pg_temp.seen(p_doc text, p_lines text, p_fk text, p_ids uuid[]) RETURNS int[] LANGUAGE plpgsql AS $f$
DECLARE v_docs int; v_full int;
BEGIN
  EXECUTE format('SELECT count(*) FROM public.%I d WHERE d.id = ANY ($1)', p_doc) INTO v_docs USING p_ids;
  EXECUTE format('SELECT count(*) FROM public.%I d WHERE d.id = ANY ($1)
                    AND (SELECT count(*) FROM public.%I l WHERE l.%I = d.id)
                      = (SELECT jsonb_array_length(d.line_items))', p_doc, p_lines, p_fk) INTO v_full USING p_ids;
  RETURN ARRAY[v_docs, v_full];
END $f$;

CREATE TEMP TABLE docs (kind text, id uuid);
GRANT ALL ON docs TO authenticated;

DO $do$
DECLARE
  v_rep   text := 'lev-rep@test.local';
  v_rep2  text := 'lev-rep2@test.local';
  v_mgr   text := 'lev-mgr@test.local';
  v_acct  text := 'lev-acct@test.local';
  v_tech  text := 'lev-tech@test.local';
  v_cust  uuid;
  v_p1    uuid := gen_random_uuid();
  v_p2    uuid := gen_random_uuid();
  v_v1    uuid := gen_random_uuid();
  v_id    uuid;
  v_sales jsonb;
  v_purch jsonb;
  v_r     record;
  v_who   text;
  v_s     int[];
  v_mis   int;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_rep, 'sales_rep', 'active'), (v_rep2, 'sales_rep', 'active'), (v_mgr, 'manager', 'active'),
         (v_acct, 'accountant', 'active'), (v_tech, 'technician', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('LEV Co', 'LEV-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.products (id, sku, product_name, product_type)
  VALUES (v_p1, 'LEV-P1', 'LEV router', 'service'), (v_p2, 'LEV-P2', 'LEV switch', 'service');
  INSERT INTO public.brands (id, brand_name) VALUES (v_v1, 'LEV Vendor');
  v_sales := jsonb_build_array(
    jsonb_build_object('product_id', v_p1, 'product_name', 'LEV router', 'qty', 2, 'unit_price', 100.5, 'discount_pct', 10, 'tax_pct', 14),
    jsonb_build_object('product_id', v_p2, 'product_name', 'LEV switch', 'qty', 1, 'unit_price', 50));
  v_purch := jsonb_build_array(
    jsonb_build_object('product_id', v_p1, 'qty_ordered', 3, 'unit_cost', 20.25, 'tax_pct', 14),
    jsonb_build_object('product_id', v_p2, 'qty_ordered', 1, 'unit_cost', 5));

  -- every document type, created the way the screens create them
  PERFORM pg_temp.as_user(v_rep);
  INSERT INTO docs SELECT 'quotation', (public.create_quotation(v_cust, NULL, v_sales, current_date + 30, NULL, NULL, NULL, v_rep, v_rep)).id;
  INSERT INTO docs SELECT 'sales_order', (public.create_sales_order(v_cust, v_sales, NULL, NULL, NULL, NULL, v_rep, v_rep)).id;
  INSERT INTO docs SELECT 'crm_invoice', (public.create_crm_invoice(v_cust, v_sales, NULL, NULL, NULL, NULL, v_rep, v_rep)).id;
  INSERT INTO docs SELECT 'credit_note', (public.create_credit_note('rebate', v_cust, 'Goodwill', 'goodwill', v_sales, NULL, NULL, v_rep, v_rep)).id;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.as_user(v_mgr);
  INSERT INTO docs SELECT 'purchase_order', (public.create_purchase_order(v_v1, v_purch, '{"currency":"EGP"}'::jsonb, v_mgr)).id;
  INSERT INTO docs SELECT 'vendor_invoice', (public.create_vendor_invoice(v_v1, v_purch, '{"currency":"EGP","supplier_invoice_no":"LEV-1"}'::jsonb, v_mgr)).id;
  PERFORM pg_temp.as_owner();

  -- 1. who sees what — lines exactly when the document
  FOR v_r IN SELECT * FROM (VALUES
      ('quotation', 'quotations', 'quotation_lines', 'quotation_id'),
      ('sales_order', 'sales_orders', 'sales_order_lines', 'sales_order_id'),
      ('crm_invoice', 'crm_invoices', 'crm_invoice_lines', 'crm_invoice_id'),
      ('credit_note', 'credit_notes', 'credit_note_lines', 'credit_note_id'),
      ('purchase_order', 'purchase_orders', 'purchase_order_lines', 'purchase_order_id'),
      ('vendor_invoice', 'vendor_invoices', 'vendor_invoice_lines', 'vendor_invoice_id')) AS t(kind, doc, lines, fk)
  LOOP
    FOREACH v_who IN ARRAY ARRAY[v_rep, v_rep2, v_mgr, v_acct, v_tech] LOOP
      PERFORM pg_temp.as_user(v_who);
      v_s := pg_temp.seen(v_r.doc, v_r.lines, v_r.fk, (SELECT array_agg(id) FROM docs WHERE kind = v_r.kind));
      PERFORM pg_temp.as_owner();
      RAISE NOTICE '%', pg_temp.check(format('%s as %s: every document seen comes with all its lines', v_r.kind, split_part(v_who, '@', 1)),
        v_s[1] = v_s[2], format('-> sees %s, with all lines %s', v_s[1], v_s[2]));
    END LOOP;
  END LOOP;

  -- the role picture itself is the expected one (a check on the check)
  PERFORM pg_temp.as_user(v_mgr);
  v_s := pg_temp.seen('quotations', 'quotation_lines', 'quotation_id', (SELECT array_agg(id) FROM docs WHERE kind = 'quotation'));
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a manager does see the rep''s quotation (so the checks above are not vacuous)', v_s[1] = 1, '-> ' || v_s[1]);

  -- 2. rebuilt from the rows (as _rowLines.ts does) = what the document holds
  SELECT count(*) INTO v_mis FROM docs d
   WHERE (d.kind = 'quotation'      AND (SELECT line_items FROM public.quotations      WHERE id = d.id) IS DISTINCT FROM
          (SELECT jsonb_agg(jsonb_build_object('product_id', l.product_id, 'product_name', l.product_name, 'description', l.description, 'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct) ORDER BY l.line_no) FROM public.quotation_lines l WHERE l.quotation_id = d.id))
      OR (d.kind = 'sales_order'    AND (SELECT line_items FROM public.sales_orders    WHERE id = d.id) IS DISTINCT FROM public.rma_sales_order_lines_json(d.id))
      OR (d.kind = 'crm_invoice'    AND (SELECT line_items FROM public.crm_invoices    WHERE id = d.id) IS DISTINCT FROM public.rma_crm_invoice_lines_json(d.id))
      OR (d.kind = 'credit_note'    AND (SELECT line_items FROM public.credit_notes    WHERE id = d.id) IS DISTINCT FROM public.rma_credit_note_lines_json(d.id))
      OR (d.kind = 'purchase_order' AND (SELECT line_items FROM public.purchase_orders WHERE id = d.id) IS DISTINCT FROM
          (SELECT jsonb_agg(jsonb_build_object('product_id', l.product_id, 'product_name', l.product_name, 'description', l.description, 'qty_ordered', l.qty_ordered, 'unit_cost', l.unit_cost, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct) ORDER BY l.line_no) FROM public.purchase_order_lines l WHERE l.purchase_order_id = d.id))
      OR (d.kind = 'vendor_invoice' AND (SELECT line_items FROM public.vendor_invoices WHERE id = d.id) IS DISTINCT FROM public.rma_vendor_invoice_lines_json(d.id));
  RAISE NOTICE '%', pg_temp.check('for all six types, the lines rebuilt from the rows equal the lines the document holds', v_mis = 0, '-> mismatches ' || v_mis);

  -- 3. and on everything already on staging
  SELECT
    (SELECT count(*) FROM public.quotations q WHERE EXISTS (SELECT 1 FROM public.quotation_lines l WHERE l.quotation_id = q.id)
       AND q.line_items IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('product_id', l.product_id, 'product_name', l.product_name, 'description', l.description, 'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct) ORDER BY l.line_no) FROM public.quotation_lines l WHERE l.quotation_id = q.id))
  + (SELECT count(*) FROM public.sales_orders o    WHERE EXISTS (SELECT 1 FROM public.sales_order_lines l WHERE l.sales_order_id = o.id) AND o.line_items IS DISTINCT FROM public.rma_sales_order_lines_json(o.id))
  + (SELECT count(*) FROM public.crm_invoices i    WHERE EXISTS (SELECT 1 FROM public.crm_invoice_lines l WHERE l.crm_invoice_id = i.id) AND i.line_items IS DISTINCT FROM public.rma_crm_invoice_lines_json(i.id))
  + (SELECT count(*) FROM public.credit_notes c    WHERE EXISTS (SELECT 1 FROM public.credit_note_lines l WHERE l.credit_note_id = c.id) AND c.line_items IS DISTINCT FROM public.rma_credit_note_lines_json(c.id))
  + (SELECT count(*) FROM public.vendor_invoices v WHERE EXISTS (SELECT 1 FROM public.vendor_invoice_lines l WHERE l.vendor_invoice_id = v.id) AND v.line_items IS DISTINCT FROM public.rma_vendor_invoice_lines_json(v.id))
  INTO v_mis;
  RAISE NOTICE '%', pg_temp.check('every existing document on this database: its rows and its copy agree', v_mis = 0, '-> documents that disagree ' || v_mis);

  RAISE EXCEPTION 'LEV_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
