-- ############################################################################
-- #  SUPPLIER INVOICE IDENTITY AND PO AMENDMENT — BL-10 / I-06 (20260881)
-- #
-- #  Before:
-- #   * a supplier's own invoice number was not recorded at all, so the same
-- #     supplier invoice could be entered twice and paid twice;
-- #   * a manager could INSERT a vendor invoice already 'approved' (or a
-- #     purchase order already 'confirmed'), skipping the administrator's
-- #     approval, and then receive stock against it;
-- #   * a vendor invoice with no purchase order behind it needed no reason, and
-- #     its creator could approve it;
-- #   * a confirmed PO was locked (I-01) with a message telling people to "use
-- #     the amend action", which did not exist.
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/supplier_invoice_po_amendment.sql BL10_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- #  NOTE: staging already carries I-01 (PR #45), so "a direct edit of a
-- #  confirmed PO is refused" passes there because of I-01, not of this file.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;

CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  IF p_email IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', p_email, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
  BEGIN
    EXECUTE p_sql;
    out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 130);
  END;
  IF p_email IS NOT NULL THEN
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;
  RETURN out;
END $f$;

CREATE FUNCTION pg_temp.vi_status(p uuid) RETURNS text LANGUAGE sql AS $f$ SELECT status FROM public.vendor_invoices WHERE id = p $f$;
CREATE FUNCTION pg_temp.po_status(p uuid) RETURNS text LANGUAGE sql AS $f$ SELECT status FROM public.purchase_orders WHERE id = p $f$;

DO $do$
DECLARE
  v_mgr   text := 'bl10-mgr@test.local';
  v_adm   text := 'bl10-admin@test.local';
  v_adm2  text := 'bl10-admin2@test.local';
  v_tech  text := 'bl10-tech@test.local';
  v_v1    uuid := gen_random_uuid();
  v_v2    uuid := gen_random_uuid();
  v_p1    uuid := gen_random_uuid();
  v_p2    uuid := gen_random_uuid();
  v_vi    uuid;
  v_vi2   uuid;
  v_po    uuid;
  v_out   text;
  v_row   record;
  v_n     integer;
  v_a     text;
  ins_vi  text := $q$INSERT INTO public.vendor_invoices (id, vendor_id, status, line_items, total, subtotal, currency, created_by, supplier_invoice_no, supplier_invoice_date, purchase_order_id, non_po_reason)
                     VALUES (%L, %L, %L, '[]', %s, %s, 'EGP', %L, %L, %s, %L, %L)$q$;
  -- since 20260889 a client creates a vendor invoice only through create_vendor_invoice;
  -- ins_vi (run as the owner) sets up fixtures, new_vi tests the creation rules
  new_vi  text := $q$SELECT public.create_vendor_invoice(%L, jsonb_build_array(jsonb_build_object('product_id', %L, 'qty_ordered', 1, 'unit_cost', %s)),
                     jsonb_build_object('currency', 'EGP', 'supplier_invoice_no', %L, 'supplier_invoice_date', %s, 'non_po_reason', %L), 'ignored')$q$;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_mgr, 'manager', 'active'), (v_adm, 'admin', 'active'), (v_adm2, 'admin', 'active'), (v_tech, 'technician', 'active');
  INSERT INTO public.brands (id, brand_name) VALUES (v_v1, 'BL10 Vendor One'), (v_v2, 'BL10 Vendor Two');
  INSERT INTO public.products (id, sku, product_name, product_type)
  VALUES (v_p1, 'BL10-P1', 'BL10 product 1', 'hardware'), (v_p2, 'BL10-P2', 'BL10 product 2', 'hardware');

  -- ══ 1. Supplier invoice number: required, and unique per supplier and year ══
  RAISE NOTICE '--- 1. Supplier invoice identity ---';
  v_out := pg_temp.call(v_mgr, format(new_vi, v_v1, v_p1, 1000, 'INV-778', 'current_date', 'stock top-up'));
  SELECT id INTO v_vi FROM public.vendor_invoices WHERE vendor_id = v_v1 AND supplier_invoice_no = 'INV-778';
  RAISE NOTICE '%', pg_temp.check('a draft vendor invoice with a supplier number is created', v_out = 'ok' AND v_vi IS NOT NULL, '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''pending_approval'' WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('and can be submitted for approval', v_out = 'ok' AND pg_temp.vi_status(v_vi) = 'pending_approval', '-> ' || v_out);

  v_out := pg_temp.call(v_mgr, format(new_vi, v_v1, v_p1, 5000, 'INV-778', 'current_date', 'stock top-up'));
  RAISE NOTICE '%', pg_temp.check('entering INV-778 twice for the same supplier is refused', v_out LIKE 'err:P0001%INV-778%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format(new_vi, v_v1, v_p1, 5000, '  inv- 778 ', 'current_date', 'stock top-up'));
  RAISE NOTICE '%', pg_temp.check('...however it is spaced or capitalised', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format(new_vi, v_v2, v_p1, 5000, 'INV-778', 'current_date', 'stock top-up'));
  RAISE NOTICE '%', pg_temp.check('the same number from a DIFFERENT supplier is fine', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format(new_vi, v_v1, v_p1, 5000, 'INV-778', '(current_date - interval ''400 days'')::date', 'stock top-up'));
  RAISE NOTICE '%', pg_temp.check('the same number is a duplicate whatever invoice date is typed (the year is the year it was entered)', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- the database itself, not just the friendly check
  v_out := pg_temp.call(NULL, format(ins_vi, gen_random_uuid(), v_v1, 'draft', 5000, 5000, 'owner', 'INV-778', 'current_date', NULL, 'stock top-up'));
  RAISE NOTICE '%', pg_temp.check('the unique index holds even for an RPC or a restore', v_out LIKE 'err:23505%', '-> ' || v_out);

  -- a cancelled invoice frees its number
  PERFORM pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''cancelled'' WHERE id = %L', v_vi));
  v_out := pg_temp.call(v_mgr, format(new_vi, v_v1, v_p1, 1000, 'INV-778', 'current_date', 'stock top-up'));
  RAISE NOTICE '%', pg_temp.check('cancelling a vendor invoice frees its supplier number', pg_temp.vi_status(v_vi) = 'cancelled' AND v_out = 'ok', '-> ' || v_out);

  -- required from pending_approval
  v_vi := gen_random_uuid();
  PERFORM pg_temp.call(NULL, format(ins_vi, v_vi, v_v2, 'draft', 300, 300, v_mgr, NULL, 'NULL', NULL, 'reason for non po'));
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''pending_approval'' WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('a draft with no supplier number cannot be submitted for approval', v_out LIKE 'err:P0001%' AND pg_temp.vi_status(v_vi) = 'draft', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET supplier_invoice_no = ''   '', status = ''pending_approval'' WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('a blank supplier number does not count', v_out LIKE 'err:P0001%', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('...but a draft may be saved without one while it is being written',
    (SELECT count(*) FROM public.vendor_invoices WHERE id = v_vi) = 1);

  -- ══ 2. Near-duplicates ═══════════════════════════════════════════════════
  RAISE NOTICE '--- 2. A different number, but the same bill ---';
  v_vi := gen_random_uuid();
  PERFORM pg_temp.call(NULL, format(ins_vi, v_vi, v_v2, 'draft', 10000, 10000, v_mgr, 'A-1001', 'current_date', NULL, 'stock top-up'));
  PERFORM pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''pending_approval'' WHERE id = %L', v_vi));
  v_vi2 := gen_random_uuid();
  PERFORM pg_temp.call(NULL, format(ins_vi, v_vi2, v_v2, 'draft', 10050, 10050, v_mgr, 'A-1002', 'current_date', NULL, 'stock top-up'));
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''pending_approval'' WHERE id = %L', v_vi2));
  RAISE NOTICE '%', pg_temp.check('same supplier, amount within 1%, close in time, another number: needs a reason', v_out LIKE 'err:P0001%' AND pg_temp.vi_status(v_vi2) = 'draft', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET duplicate_override_reason = ''short'', status = ''pending_approval'' WHERE id = %L', v_vi2));
  RAISE NOTICE '%', pg_temp.check('a token reason is not enough', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET duplicate_override_reason = ''Second delivery, billed separately by the supplier'', status = ''pending_approval'' WHERE id = %L', v_vi2));
  RAISE NOTICE '%', pg_temp.check('with a real reason it goes through, and the reason is kept', v_out = 'ok' AND pg_temp.vi_status(v_vi2) = 'pending_approval'
    AND (SELECT duplicate_override_reason FROM public.vendor_invoices WHERE id = v_vi2) LIKE 'Second delivery%', '-> ' || v_out);

  v_vi2 := gen_random_uuid();
  PERFORM pg_temp.call(NULL, format(ins_vi, v_vi2, v_v2, 'draft', 12000, 12000, v_mgr, 'A-1003', 'current_date', NULL, 'stock top-up'));
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''pending_approval'' WHERE id = %L', v_vi2));
  RAISE NOTICE '%', pg_temp.check('a clearly different amount is not flagged', v_out = 'ok', '-> ' || v_out);
  v_vi2 := gen_random_uuid();
  PERFORM pg_temp.call(NULL, format(ins_vi, v_vi2, v_v1, 'draft', 10000, 10000, v_mgr, 'A-2001', 'current_date', NULL, 'stock top-up'));
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''pending_approval'' WHERE id = %L', v_vi2));
  RAISE NOTICE '%', pg_temp.check('the same amount from a DIFFERENT supplier is not flagged', v_out = 'ok', '-> ' || v_out);

  -- ══ 3. A vendor invoice cannot be created already approved ═══════════════
  RAISE NOTICE '--- 3. Creating past the approval ---';
  FOREACH v_a IN ARRAY ARRAY['pending_approval', 'approved', 'partially_received', 'received'] LOOP
    v_out := pg_temp.call(v_mgr, format(ins_vi, gen_random_uuid(), v_v1, v_a, 100, 100, v_mgr, 'X-' || v_a, 'current_date', NULL, 'stock top-up'));
    RAISE NOTICE '%', pg_temp.check(format('a manager cannot insert a vendor invoice already "%s" (no client INSERT since 20260889)', v_a), v_out LIKE 'err:%', '-> ' || v_out);
  END LOOP;
  v_out := pg_temp.call(v_mgr, $q$INSERT INTO public.purchase_orders (vendor_id, status, line_items, total, subtotal, currency, created_by, po_code) VALUES ($q$ || quote_literal(v_v1) || $q$, 'confirmed', '[]', 1, 1, 'EGP', 'x', 'PO-T-CONF')$q$);
  -- since 20260888 no client INSERTs a purchase order at all (create_purchase_order does)
  RAISE NOTICE '%', pg_temp.check('nor a purchase order already "confirmed"', v_out LIKE 'err:%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_purchase_order(%L, %L::jsonb, '{"currency":"EGP"}'::jsonb, %L)$q$, v_v1,
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_ordered', 1, 'unit_cost', 1)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a draft purchase order is created through create_purchase_order (control)', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(NULL, format(ins_vi, gen_random_uuid(), v_v1, 'approved', 100, 100, 'restore', 'RESTORED-1', 'current_date', NULL, 'stock top-up'));
  RAISE NOTICE '%', pg_temp.check('an RPC / restore can still insert historical documents', v_out = 'ok', '-> ' || v_out);

  -- ══ 4. A vendor invoice with no purchase order ═══════════════════════════
  RAISE NOTICE '--- 4. Non-PO vendor invoices ---';
  v_vi := gen_random_uuid();
  PERFORM pg_temp.call(NULL, format(ins_vi, v_vi, v_v2, 'draft', 777, 777, v_mgr, 'NP-1', 'current_date', NULL, NULL));
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''pending_approval'' WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('with no PO and no reason it cannot be submitted', v_out LIKE 'err:P0001%' AND pg_temp.vi_status(v_vi) = 'draft', '-> ' || v_out);
  -- the reason is written through the form (update_vendor_invoice, 20260889), then it is submitted
  PERFORM pg_temp.call(v_mgr, format($q$SELECT public.update_vendor_invoice(%L, NULL, '{"non_po_reason":"Emergency freight, no time for a PO"}'::jsonb, 'x')$q$, v_vi));
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''pending_approval'' WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('with a reason it can', v_out = 'ok', '-> ' || v_out);

  -- its creator, even as an administrator, cannot approve it
  v_vi := gen_random_uuid();
  PERFORM pg_temp.call(NULL, format(ins_vi, v_vi, v_v2, 'draft', 888, 888, v_adm, 'NP-2', 'current_date', NULL, 'Emergency freight, no time for a PO'));
  PERFORM pg_temp.call(v_adm, format('UPDATE public.vendor_invoices SET status = ''pending_approval'' WHERE id = %L', v_vi));
  v_out := pg_temp.call(v_adm, format('UPDATE public.vendor_invoices SET status = ''approved'' WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('an administrator cannot approve a non-PO invoice they created', v_out LIKE 'err:P0001%' AND pg_temp.vi_status(v_vi) = 'pending_approval', '-> ' || v_out);
  v_out := pg_temp.call(v_adm2, format('UPDATE public.vendor_invoices SET status = ''approved'' WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('a second administrator can', v_out = 'ok' AND pg_temp.vi_status(v_vi) = 'approved', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('who approved it is recorded from the login', (SELECT approved_by FROM public.vendor_invoices WHERE id = v_vi) = v_adm2, '-> ' || coalesce((SELECT approved_by FROM public.vendor_invoices WHERE id = v_vi), '<null>'));
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET approved_by = ''someone@else'' WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('a client cannot rewrite the approver afterwards', (SELECT approved_by FROM public.vendor_invoices WHERE id = v_vi) = v_adm2, '-> ' || v_out);
  -- a manager still cannot approve at all (existing rule)
  v_vi := gen_random_uuid();
  PERFORM pg_temp.call(NULL, format(ins_vi, v_vi, v_v2, 'draft', 999, 999, v_mgr, 'NP-3', 'current_date', NULL, 'Emergency freight, no time for a PO'));
  PERFORM pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''pending_approval'' WHERE id = %L', v_vi));
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''approved'' WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('a manager still cannot approve a vendor invoice (existing rule)', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 5. Amending a confirmed purchase order ═══════════════════════════════
  RAISE NOTICE '--- 5. PO amendment ---';
  v_po := gen_random_uuid();
  INSERT INTO public.purchase_orders (id, po_code, vendor_id, status, line_items, subtotal, discount_amount, tax_amount, total, currency, created_by)
  VALUES (v_po, 'PO-T-AMEND', v_v1, 'confirmed',
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'product_name', 'p1', 'qty_ordered', 10, 'unit_cost', 100, 'discount_pct', 0, 'tax_pct', 14),
                      jsonb_build_object('product_id', v_p2, 'product_name', 'p2', 'qty_ordered', 5,  'unit_cost', 200, 'discount_pct', 10, 'tax_pct', 0)),
    2000, 100, 140, 2040, 'EGP', v_mgr);
  RAISE NOTICE '%', pg_temp.check('the fixture starts at revision 1', (SELECT revision_no FROM public.purchase_orders WHERE id = v_po) = 1);

  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.purchase_orders SET line_items = jsonb_set(line_items, '{0,unit_cost}', '90') WHERE id = %L$q$, v_po));
  RAISE NOTICE '%', pg_temp.check('changing a unit cost on a confirmed PO directly is refused (I-01)', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.purchase_orders SET status = 'pending_confirmation' WHERE id = %L$q$, v_po));
  RAISE NOTICE '%', pg_temp.check('nor can anyone reopen it by setting the status (that would unlock editing)', v_out LIKE 'err:P0001%' AND pg_temp.po_status(v_po) = 'confirmed', '-> ' || v_out);

  v_out := pg_temp.call(v_tech, format($q$SELECT public.amend_purchase_order(%L, '{"payment_terms":"net 60"}'::jsonb, 'A long enough reason here', %L)$q$, v_po, v_tech));
  RAISE NOTICE '%', pg_temp.check('a technician cannot amend', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, '{"payment_terms":"net 60"}'::jsonb, 'short', %L)$q$, v_po, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a reason of at least 10 characters is required', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, '{"vendor_id":"%s"}'::jsonb, 'Switching supplier mid-order', %L)$q$, v_po, v_v2, v_mgr));
  RAISE NOTICE '%', pg_temp.check('the supplier cannot be changed by amendment', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, '{"currency":"USD"}'::jsonb, 'Switching currency mid-order', %L)$q$, v_po, v_mgr));
  RAISE NOTICE '%', pg_temp.check('nor the currency', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, '{"status":"draft"}'::jsonb, 'Trying to change the status', %L)$q$, v_po, v_mgr));
  RAISE NOTICE '%', pg_temp.check('nor anything not on the allowed list (status)', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- terms only: stays confirmed, revision recorded
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, '{"payment_terms":"net 60"}'::jsonb, 'Supplier agreed longer payment terms', %L)$q$, v_po, v_mgr));
  SELECT * INTO v_row FROM public.purchase_orders WHERE id = v_po;
  RAISE NOTICE '%', pg_temp.check('a terms-only amendment applies and the order stays confirmed', v_out = 'ok' AND v_row.payment_terms = 'net 60' AND v_row.status = 'confirmed', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('...as revision 2', v_row.revision_no = 2, '-> ' || v_row.revision_no);
  SELECT * INTO v_row FROM public.purchase_order_revisions WHERE po_id = v_po AND rev_no = 1;
  RAISE NOTICE '%', pg_temp.check('revision 1 was snapshotted as it stood, with the reason and who', v_row.snapshot ->> 'payment_terms' IS NULL
    AND v_row.reason = 'Supplier agreed longer payment terms' AND v_row.created_by = v_mgr, '-> ' || coalesce(v_row.reason, '<none>'));

  -- quantity DOWN, same prices: value falls, so no re-approval
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, %L::jsonb, 'Ordered fewer of product one', %L)$q$, v_po,
    jsonb_build_object('line_items', jsonb_build_array(
      jsonb_build_object('product_id', v_p1, 'product_name', 'p1', 'qty_ordered', 8, 'unit_cost', 100, 'discount_pct', 0, 'tax_pct', 14),
      jsonb_build_object('product_id', v_p2, 'product_name', 'p2', 'qty_ordered', 5, 'unit_cost', 200, 'discount_pct', 10, 'tax_pct', 0)))::text, v_mgr));
  SELECT * INTO v_row FROM public.purchase_orders WHERE id = v_po;
  RAISE NOTICE '%', pg_temp.check('fewer units at the same prices keeps it confirmed', v_out = 'ok' AND v_row.status = 'confirmed' AND v_row.revision_no = 3, '-> ' || v_out || ' / ' || v_row.status || ' rev ' || v_row.revision_no);
  RAISE NOTICE '%', pg_temp.check('the totals are recomputed from the lines (8×100 + 5×200 less 10% + 14% on the first)',
    v_row.subtotal = 1800 AND v_row.discount_amount = 100 AND v_row.tax_amount = 112 AND v_row.total = 1812,
    '-> ' || v_row.subtotal || ' / ' || v_row.discount_amount || ' / ' || v_row.tax_amount || ' / ' || v_row.total);

  -- price change: back to pending_confirmation, rev bumps
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, %L::jsonb, 'Supplier raised the price of product two', %L)$q$, v_po,
    jsonb_build_object('line_items', jsonb_build_array(
      jsonb_build_object('product_id', v_p1, 'product_name', 'p1', 'qty_ordered', 8, 'unit_cost', 100, 'discount_pct', 0, 'tax_pct', 14),
      jsonb_build_object('product_id', v_p2, 'product_name', 'p2', 'qty_ordered', 5, 'unit_cost', 210, 'discount_pct', 10, 'tax_pct', 0)))::text, v_mgr));
  SELECT * INTO v_row FROM public.purchase_orders WHERE id = v_po;
  RAISE NOTICE '%', pg_temp.check('a price change sends it back to pending_confirmation for an administrator', v_out = 'ok' AND v_row.status = 'pending_confirmation' AND v_row.revision_no = 4, '-> ' || v_out || ' / ' || v_row.status);
  SELECT count(*)::integer INTO v_n FROM public.purchase_order_revisions WHERE po_id = v_po;
  RAISE NOTICE '%', pg_temp.check('three revisions are on file (1, 2, 3)', v_n = 3, '-> ' || v_n);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, '{"payment_terms":"net 90"}'::jsonb, 'Amending again while pending', %L)$q$, v_po, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a PO that is no longer confirmed is edited normally, not amended', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('UPDATE public.purchase_orders SET revision_no = 1 WHERE id = %L', v_po));
  RAISE NOTICE '%', pg_temp.check('a client cannot rewrite the revision number', (SELECT revision_no FROM public.purchase_orders WHERE id = v_po) = 4, '-> ' || v_out);
  v_out := pg_temp.call(v_adm, format($q$UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = %L$q$, v_po));
  RAISE NOTICE '%', pg_temp.check('an administrator re-confirms it', v_out = 'ok' AND pg_temp.po_status(v_po) = 'confirmed', '-> ' || v_out);

  -- value increase with prices unchanged (more units) also needs re-approval
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, %L::jsonb, 'Ordering more units at the same prices', %L)$q$, v_po,
    jsonb_build_object('line_items', jsonb_build_array(
      jsonb_build_object('product_id', v_p1, 'product_name', 'p1', 'qty_ordered', 20, 'unit_cost', 100, 'discount_pct', 0, 'tax_pct', 14),
      jsonb_build_object('product_id', v_p2, 'product_name', 'p2', 'qty_ordered', 5, 'unit_cost', 210, 'discount_pct', 10, 'tax_pct', 0)))::text, v_mgr));
  RAISE NOTICE '%', pg_temp.check('more units (the value goes up) needs re-approval', v_out = 'ok' AND pg_temp.po_status(v_po) = 'pending_confirmation', '-> ' || v_out);

  -- the client's own totals are not believed: lower the price but claim a lower total than the lines give
  PERFORM pg_temp.call(v_adm, format($q$UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = %L$q$, v_po));
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, %L::jsonb, 'Trying to slip a bigger order through', %L)$q$, v_po,
    jsonb_build_object('total', 1, 'subtotal', 1, 'line_items', jsonb_build_array(
      jsonb_build_object('product_id', v_p1, 'product_name', 'p1', 'qty_ordered', 999, 'unit_cost', 100, 'discount_pct', 0, 'tax_pct', 0)))::text, v_mgr));
  SELECT * INTO v_row FROM public.purchase_orders WHERE id = v_po;
  RAISE NOTICE '%', pg_temp.check('a small "total" sent with large lines is ignored: the value is judged from the lines, so re-approval is required',
    v_out = 'ok' AND v_row.status = 'pending_confirmation' AND v_row.total = 99900, '-> ' || v_out || ' / total ' || v_row.total);

  -- bad lines
  PERFORM pg_temp.call(v_adm, format($q$UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = %L$q$, v_po));
  FOREACH v_a IN ARRAY ARRAY['{"product_id":"%s","qty_ordered":"abc","unit_cost":5}', '{"product_id":"%s","qty_ordered":-1,"unit_cost":5}', '{"product_id":"%s","qty_ordered":1,"unit_cost":"1e3"}', '{"qty_ordered":1,"unit_cost":5}'] LOOP
    v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, %L::jsonb, 'Malformed line on purpose', %L)$q$, v_po,
      jsonb_build_object('line_items', jsonb_build_array(format(v_a, v_p1)::jsonb))::text, v_mgr));
    RAISE NOTICE '%', pg_temp.check('a malformed line is refused: ' || left(v_a, 40), v_out LIKE 'err:P0001%' AND pg_temp.po_status(v_po) = 'confirmed', '-> ' || v_out);
  END LOOP;

  -- an invoice already raised against the PO
  v_vi := gen_random_uuid();
  PERFORM pg_temp.call(NULL, format(ins_vi, v_vi, v_v1, 'draft', 100, 100, v_mgr, 'PO-LINKED-1', 'current_date', v_po, NULL));
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, '{"payment_terms":"net 30"}'::jsonb, 'Amending with an invoice open', %L)$q$, v_po, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a PO with a live vendor invoice against it cannot be amended', v_out LIKE 'err:P0001%', '-> ' || v_out);
  PERFORM pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET status = ''cancelled'' WHERE id = %L', v_vi));
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, '{"payment_terms":"net 30"}'::jsonb, 'Amending after cancelling it', %L)$q$, v_po, v_mgr));
  RAISE NOTICE '%', pg_temp.check('...but once that invoice is cancelled it can', v_out = 'ok', '-> ' || v_out);

  -- ══ 6. Grants, revisions table ═══════════════════════════════════════════
  RAISE NOTICE '--- 6. Access ---';
  RAISE NOTICE '%', pg_temp.check('anon cannot amend', NOT has_function_privilege('anon', 'public.amend_purchase_order(uuid, jsonb, text, text)', 'EXECUTE'));
  RAISE NOTICE '%', pg_temp.check('the revisions table refuses client writes',
    NOT has_table_privilege('authenticated', 'public.purchase_order_revisions', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.purchase_order_revisions', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.purchase_order_revisions', 'DELETE'));
  v_out := pg_temp.call(v_mgr, 'SELECT count(*) FROM public.purchase_order_revisions');
  RAISE NOTICE '%', pg_temp.check('a manager can read the revision history', v_out = 'ok', '-> ' || v_out);
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_tech, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*)::integer INTO v_n FROM public.purchase_order_revisions;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('a technician sees none of it', v_n = 0 AND (SELECT count(*) FROM public.purchase_order_revisions) > 0, '-> ' || v_n);

  -- ══ 7. Security review findings (bypasses of sections 1-4) ═══════════════
  RAISE NOTICE '--- 7. Review findings ---';
  v_vi := gen_random_uuid();
  PERFORM pg_temp.call(NULL, format(ins_vi, v_vi, v_v2, 'draft', 3000, 3000, v_adm, 'S7-1', 'current_date', NULL, 'Emergency freight, no time for a PO'));
  PERFORM pg_temp.call(v_adm, format('UPDATE public.vendor_invoices SET status = ''pending_approval'' WHERE id = %L', v_vi));
  v_out := pg_temp.call(v_adm, format('UPDATE public.vendor_invoices SET status = ''approved'', created_by = %L WHERE id = %L', v_adm2, v_vi));
  RAISE NOTICE '%', pg_temp.check('rewriting created_by in the approving statement does not defeat self-approval', v_out LIKE 'err:%' AND pg_temp.vi_status(v_vi) = 'pending_approval', '-> ' || v_out);
  v_po := gen_random_uuid();
  INSERT INTO public.purchase_orders (id, po_code, vendor_id, status, line_items, subtotal, discount_amount, tax_amount, total, currency, created_by)
  VALUES (v_po, 'PO-BL10-S7', v_v2, 'confirmed', '[]', 1, 0, 0, 1, 'EGP', v_adm);
  v_out := pg_temp.call(v_adm, format('UPDATE public.vendor_invoices SET status = ''approved'', purchase_order_id = %L WHERE id = %L', v_po, v_vi));
  RAISE NOTICE '%', pg_temp.check('pointing it at a PO in the approving statement does not either', v_out LIKE 'err:%' AND pg_temp.vi_status(v_vi) = 'pending_approval', '-> ' || v_out);
  v_out := pg_temp.call(v_adm2, format('UPDATE public.vendor_invoices SET status = ''approved'' WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('a second administrator still approves it', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_adm2, format('UPDATE public.vendor_invoices SET total = 4100 WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('an approved invoice''s total cannot be edited', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_adm2, format('UPDATE public.vendor_invoices SET supplier_invoice_no = NULL WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('nor can its supplier number be blanked', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_adm2, format('UPDATE public.vendor_invoices SET line_items = ''[{"x":1}]'' WHERE id = %L', v_vi));
  RAISE NOTICE '%', pg_temp.check('nor its lines', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_vi2 := gen_random_uuid();
  v_out := pg_temp.call(v_mgr, format(new_vi, v_v2, v_p1, 3000, 'S7-1', quote_literal('2020-01-01'), 'Emergency freight, no time for a PO'));
  RAISE NOTICE '%', pg_temp.check('the same number with a different invoice date is still a duplicate', v_out LIKE 'err:%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format(new_vi, v_v2, v_p1, 3000, 'S7' || chr(160) || '-1', 'current_date', 'Emergency freight, no time for a PO'));
  RAISE NOTICE '%', pg_temp.check('a non-breaking space does not make it a different number', v_out LIKE 'err:%', '-> ' || v_out);

  RAISE EXCEPTION 'BL10_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
