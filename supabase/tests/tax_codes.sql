-- ############################################################################
-- #  TAX CODES AND THE VAT RETURN — A-04a (20260911)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/tax_codes.sql A04_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line.
-- #
-- #  BL-15's acceptance: an invoice with lines at 14 % and 0 % gives tax per
-- #  code, and changing the code's rate later does not change it. Documents are
-- #  written through the real RPCs and posted the way the RPCs post them (as the
-- #  owner; the tax check is a trigger, so it fires for any writer). The VAT
-- #  return is compared before and after, because staging has other entries.
-- ############################################################################

SELECT set_config('a04.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN COALESCE(p_ok, false) THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN COALESCE(p_ok, false) THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('a04.log', COALESCE(current_setting('a04.log', true), '') || E'\n' || l, false);
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
-- run SQL as a signed-in client; 'ok' or the error
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
-- run SQL as the owner; 'ok' or the error
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN 'err:' || SQLSTATE || ' ' || left(SQLERRM, 220);
END $f$;
CREATE FUNCTION pg_temp.inv_lines(p_inv uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT string_agg(COALESCE(tax_code, '-') || '@' || tax_pct::numeric(5,2), ' ' ORDER BY line_no) FROM public.crm_invoice_lines WHERE crm_invoice_id = p_inv
$f$;
CREATE FUNCTION pg_temp.post(p_inv uuid, p_code text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.try(format('UPDATE public.crm_invoices SET doc_status = ''posted'', inv_code = %L, posted_at = now() WHERE id = %L', p_code, p_inv))
$f$;

CREATE TEMP TABLE vat_before (side text, tax_code text, rate numeric, net numeric, tax numeric);
CREATE TEMP TABLE vat_after  (side text, tax_code text, rate numeric, net numeric, tax numeric);
CREATE TEMP TABLE led (at text, output_tax numeric, input_tax numeric);
GRANT ALL ON vat_before, vat_after, led TO authenticated;  -- filled while signed in

DO $do$
DECLARE
  v_acct  text := 'a04-acct@test.local';
  v_mgr   text := 'a04-mgr@test.local';
  v_admin text := 'a04-admin@test.local';
  v_tech  text := 'a04-tech@test.local';
  v_cust  uuid;
  v_vend  uuid;
  v_svc1  uuid;
  v_svc2  uuid;
  v_a     uuid;
  v_b     uuid;
  v_c     uuid;
  v_cn    uuid;
  v_vi    uuid;
  v_qt    uuid;
  v_so    uuid;
  v_out   text;
  v_d     date := public.rma_today();
  v_n     integer;
  v_x     numeric;
  v_y     numeric;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES
    (v_acct, 'accountant', 'active'), (v_mgr, 'manager', 'active'), (v_admin, 'admin', 'active'), (v_tech, 'technician', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('A04 Co', 'A04-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.brands (brand_name) VALUES ('A04 Supplier') RETURNING id INTO v_vend;
  INSERT INTO public.products (sku, product_name, product_type) VALUES ('A04-S1', 'A04 support', 'service') RETURNING id INTO v_svc1;
  INSERT INTO public.products (sku, product_name, product_type) VALUES ('A04-S2', 'A04 training', 'service') RETURNING id INTO v_svc2;

  PERFORM pg_temp.as_user(v_acct);
  INSERT INTO vat_before SELECT side, tax_code, rate, net_amount, tax_amount FROM public.rma_vat_return(v_d, v_d);
  INSERT INTO led SELECT 'before', * FROM public.rma_vat_return_ledger(v_d, v_d);
  PERFORM pg_temp.as_owner();

  -- ══ 1. the starting codes ══════════════════════════════════════════════════
  PERFORM pg_temp.check('seeded: standard 14% (the default tax rate), zero-rated, exempt, out of scope',
    EXISTS (SELECT 1 FROM public.tax_codes WHERE code = 'VAT14' AND kind = 'standard' AND rate = 14 AND is_default)
    AND EXISTS (SELECT 1 FROM public.tax_codes WHERE code = 'ZERO' AND kind = 'zero' AND is_default)
    AND EXISTS (SELECT 1 FROM public.tax_codes WHERE code = 'EXEMPT' AND kind = 'exempt' AND NOT is_default)
    AND EXISTS (SELECT 1 FROM public.tax_codes WHERE code = 'OOS' AND kind = 'out_of_scope'));
  PERFORM pg_temp.check('every existing line has a code',
    NOT EXISTS (SELECT 1 FROM public.crm_invoice_lines WHERE tax_code IS NULL)
    AND NOT EXISTS (SELECT 1 FROM public.vendor_invoice_lines WHERE tax_code IS NULL)
    AND NOT EXISTS (SELECT 1 FROM public.credit_note_lines WHERE tax_code IS NULL));

  -- ══ 2. who writes codes ════════════════════════════════════════════════════
  v_out := pg_temp.call(v_tech, 'SELECT count(*) FROM public.tax_codes');
  PERFORM pg_temp.check('staff read the codes', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, $s$INSERT INTO public.tax_codes (code, name, kind, rate) VALUES ('VAT5', 'Five', 'reduced', 5)$s$);
  PERFORM pg_temp.check('a manager cannot add one', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$INSERT INTO public.tax_codes (code, name, kind, rate) VALUES ('ZERO5', 'Bad', 'zero', 5)$s$);
  PERFORM pg_temp.check('a zero-rated code must have rate 0', v_out LIKE 'err:23514%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$INSERT INTO public.tax_codes (code, name, kind, rate, is_default) VALUES ('VAT14B', 'Twin', 'standard', 14, true)$s$);
  PERFORM pg_temp.check('one default code per rate', v_out LIKE 'err:23505%', '-> ' || v_out);

  -- ══ 3. an invoice at 14 % and exempt ═══════════════════════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_a := (public.create_crm_invoice(v_cust, jsonb_build_array(
            jsonb_build_object('product_id', v_svc1, 'qty', 2, 'unit_price', 100, 'tax_pct', 14),
            jsonb_build_object('product_id', v_svc2, 'qty', 1, 'unit_price', 50, 'tax_pct', 14, 'tax_code', 'EXEMPT')),
          NULL, NULL, NULL, NULL, NULL, v_mgr)).id;
  -- C is saved now, before the rate changes (section 5)
  v_c := (public.create_crm_invoice(v_cust, jsonb_build_array(
            jsonb_build_object('product_id', v_svc1, 'qty', 1, 'unit_price', 100, 'tax_pct', 14)),
          NULL, NULL, NULL, NULL, NULL, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('a line with only a rate takes the default code; a named code sets the rate',
    pg_temp.inv_lines(v_a) = 'VAT14@14.00 EXEMPT@0.00', '-> ' || pg_temp.inv_lines(v_a));
  PERFORM pg_temp.check('its tax is worked out per line: 28 on the 14 % line, none on the exempt one',
    (SELECT tax_amount = 28 AND total = 278 FROM public.crm_invoices WHERE id = v_a),
    '-> ' || (SELECT tax_amount || ' / ' || total FROM public.crm_invoices WHERE id = v_a));

  -- a screen sends the lines back without codes: they keep theirs
  PERFORM pg_temp.as_user(v_mgr);
  PERFORM public.update_crm_invoice(v_a, jsonb_build_array(
            jsonb_build_object('product_id', v_svc1, 'qty', 2, 'unit_price', 100, 'tax_pct', 14),
            jsonb_build_object('product_id', v_svc2, 'qty', 1, 'unit_price', 50, 'tax_pct', 0)), '{}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('saving from a screen that sends no codes keeps each line''s code',
    pg_temp.inv_lines(v_a) = 'VAT14@14.00 EXEMPT@0.00', '-> ' || pg_temp.inv_lines(v_a));

  v_out := pg_temp.post(v_a, 'INV-A04-A');
  PERFORM pg_temp.check('it posts', v_out = 'ok', '-> ' || v_out);

  -- ══ 4. a rate no code carries ══════════════════════════════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_b := (public.create_crm_invoice(v_cust, jsonb_build_array(
            jsonb_build_object('product_id', v_svc1, 'qty', 1, 'unit_price', 100, 'tax_pct', 7)),
          NULL, NULL, NULL, NULL, NULL, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.post(v_b, 'INV-A04-B');
  PERFORM pg_temp.check('an invoice with a line no code covers is not posted', v_out LIKE 'err:P0001%no tax code has the rate 7%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$INSERT INTO public.tax_codes (code, name, kind, rate, is_default) VALUES ('VAT7', 'Reduced 7%', 'reduced', 7, true)$s$);
  PERFORM pg_temp.check('an accountant adds a 7 % code', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.post(v_b, 'INV-A04-B');
  PERFORM pg_temp.check('now it posts, and the line has the code',
    v_out = 'ok' AND pg_temp.inv_lines(v_b) = 'VAT7@7.00', '-> ' || v_out || ' / ' || COALESCE(pg_temp.inv_lines(v_b), '-'));

  -- ══ 5. the rate changes (BL-15) ════════════════════════════════════════════
  v_out := pg_temp.call(v_acct, $s$UPDATE public.tax_codes SET rate = 15, name = 'Standard rate 15%' WHERE code = 'VAT14'$s$);
  PERFORM pg_temp.check('an accountant changes the standard rate to 15 %; the old rate is kept in its history',
    v_out = 'ok' AND (SELECT count(*) FROM public.tax_code_rates WHERE code = 'VAT14') = 2, '-> ' || v_out);
  PERFORM pg_temp.check('the posted invoice is unchanged: 14 % on its line, 28 of tax',
    pg_temp.inv_lines(v_a) = 'VAT14@14.00 EXEMPT@0.00' AND (SELECT tax_amount FROM public.crm_invoices WHERE id = v_a) = 28);
  v_out := pg_temp.post(v_c, 'INV-A04-C');
  PERFORM pg_temp.check('a draft saved at the old rate is not posted until it is saved again',
    v_out LIKE 'err:P0001%tax code VAT14 is now 15%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_mgr);
  PERFORM public.update_crm_invoice(v_c, jsonb_build_array(
            jsonb_build_object('product_id', v_svc1, 'qty', 1, 'unit_price', 100, 'tax_pct', 14)), '{}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.post(v_c, 'INV-A04-C');
  PERFORM pg_temp.check('saved again it takes 15 % and posts',
    v_out = 'ok' AND pg_temp.inv_lines(v_c) = 'VAT14@15.00' AND (SELECT tax_amount FROM public.crm_invoices WHERE id = v_c) = 15,
    '-> ' || v_out || ' / ' || pg_temp.inv_lines(v_c));

  -- ══ 6. credit notes follow what they credit ════════════════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_cn := (public.create_credit_note('rebate', v_cust, 'A04 rebate', 'rebate', jsonb_build_array(
             jsonb_build_object('product_name', 'Rebate at the old rate', 'qty', 1, 'unit_price', 10, 'tax_pct', 14, 'tax_code', 'VAT14'),
             jsonb_build_object('product_name', 'Rebate, rate not given', 'qty', 1, 'unit_price', 10, 'tax_pct', 3, 'tax_code', 'VAT14')),
           NULL, NULL, NULL, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('a credit note keeps a rate its code has had (14 %), else takes today''s (15 %)',
    (SELECT string_agg(tax_code || '@' || tax_pct, ' ' ORDER BY line_no) FROM public.credit_note_lines WHERE credit_note_id = v_cn) = 'VAT14@14.00 VAT14@15.00',
    '-> ' || (SELECT string_agg(tax_code || '@' || tax_pct, ' ' ORDER BY line_no) FROM public.credit_note_lines WHERE credit_note_id = v_cn));
  v_out := pg_temp.try(format('UPDATE public.credit_notes SET status = ''issued'', cn_code = ''CN-A04-1'', issued_at = now() WHERE id = %L', v_cn));
  PERFORM pg_temp.check('it is issued', v_out = 'ok', '-> ' || v_out);

  -- ══ 7. an inactive code ════════════════════════════════════════════════════
  v_out := pg_temp.call(v_acct, $s$UPDATE public.tax_codes SET is_default = false, is_active = false WHERE code = 'VAT7'$s$);
  PERFORM pg_temp.as_user(v_mgr);
  BEGIN
    PERFORM public.create_crm_invoice(v_cust, jsonb_build_array(
      jsonb_build_object('product_id', v_svc1, 'qty', 1, 'unit_price', 1, 'tax_code', 'VAT7')), NULL, NULL, NULL, NULL, NULL, v_mgr);
    v_out := 'ok';
  EXCEPTION WHEN OTHERS THEN v_out := 'err:' || SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('a new invoice cannot use an inactive code', v_out LIKE 'err:P0001%no longer in use%', '-> ' || v_out);

  -- ══ 8. a used code keeps its meaning ═══════════════════════════════════════
  v_out := pg_temp.call(v_acct, $s$UPDATE public.tax_codes SET kind = 'reduced' WHERE code = 'VAT14'$s$);
  PERFORM pg_temp.check('its kind cannot change', v_out LIKE 'err:P0001%kind cannot change%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$DELETE FROM public.tax_codes WHERE code = 'EXEMPT'$s$);
  PERFORM pg_temp.check('it cannot be deleted', v_out LIKE 'err:P0001%cannot be deleted%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$UPDATE public.tax_codes SET code = 'STD' WHERE code = 'VAT14'$s$);
  PERFORM pg_temp.check('its code cannot change', v_out LIKE 'err:P0001%cannot change%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$INSERT INTO public.tax_codes (code, name, kind, rate) VALUES ('TMP9', 'Tmp', 'reduced', 9)$s$);
  v_out := v_out || '/' || pg_temp.call(v_acct, $s$DELETE FROM public.tax_codes WHERE code = 'TMP9'$s$);
  PERFORM pg_temp.check('an unused code can be deleted', v_out = 'ok/ok', '-> ' || v_out);

  -- ══ 9. conversions carry the code ══════════════════════════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_qt := (public.create_quotation(v_cust, NULL, jsonb_build_array(
             jsonb_build_object('product_id', v_svc2, 'product_name', 'A04 training', 'qty', 1, 'unit_price', 40, 'tax_code', 'EXEMPT')),
           v_d + 30, NULL, NULL, NULL, NULL, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  UPDATE public.quotations SET status = 'accepted' WHERE id = v_qt;
  PERFORM pg_temp.as_user(v_mgr);
  v_so := public.convert_quotation_to_so(v_qt, v_mgr, NULL);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('a quotation''s exempt line stays exempt on its sales order (not re-derived as zero-rated)',
    (SELECT tax_code FROM public.sales_order_lines WHERE sales_order_id = v_so) = 'EXEMPT');

  -- ══ 10. a supplier bill at 15 %, in another currency at 2 ═════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := (public.create_vendor_invoice(v_vend, jsonb_build_array(
             jsonb_build_object('product_id', v_svc1, 'qty_ordered', 4, 'unit_cost', 25, 'tax_pct', 15)),
           jsonb_build_object('currency', 'USD', 'exchange_rate', 2, 'non_po_reason', 'Services with no purchase order'), v_mgr)).id;
  PERFORM public.update_vendor_invoice(v_vi, NULL, jsonb_build_object('supplier_invoice_no', 'A04-SUP-1', 'supplier_invoice_date', v_d), v_mgr);
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.as_user(v_admin);
  UPDATE public.vendor_invoices SET status = 'approved', approved_at = now() WHERE id = v_vi;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('the bill''s line took the standard code at 15 %',
    (SELECT tax_code || '@' || tax_pct FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v_vi) = 'VAT14@15.00');

  -- ══ 11. the VAT return ═════════════════════════════════════════════════════
  PERFORM pg_temp.as_user(v_acct);
  INSERT INTO vat_after SELECT side, tax_code, rate, net_amount, tax_amount FROM public.rma_vat_return(v_d, v_d);
  INSERT INTO led SELECT 'after', * FROM public.rma_vat_return_ledger(v_d, v_d);
  PERFORM pg_temp.as_owner();

  -- what this script added, per side / code / rate
  CREATE TEMP TABLE vat_delta AS
    SELECT COALESCE(a.side, b.side) side, COALESCE(a.tax_code, b.tax_code) tax_code, COALESCE(a.rate, b.rate) rate,
           COALESCE(a.net, 0) - COALESCE(b.net, 0) net, COALESCE(a.tax, 0) - COALESCE(b.tax, 0) tax
      FROM vat_after a FULL JOIN vat_before b ON a.side = b.side AND a.tax_code IS NOT DISTINCT FROM b.tax_code AND a.rate = b.rate;
  SELECT string_agg(side || ':' || tax_code || '@' || rate::numeric(5,2) || '=' || net || '/' || tax, ' ' ORDER BY side, tax_code, rate)
    INTO v_out FROM vat_delta WHERE net <> 0 OR tax <> 0;
  PERFORM pg_temp.check('the return splits the tax by code and rate (invoices less the credit, the bill in base currency)',
    v_out = 'input:VAT14@15.00=200.00/30.00 output:EXEMPT@0.00=50.00/0.00 output:VAT14@14.00=190.00/26.60 output:VAT14@15.00=90.00/13.50 output:VAT7@7.00=100.00/7.00',
    '-> ' || COALESCE(v_out, 'nothing'));

  SELECT (SELECT output_tax FROM led WHERE at = 'after') - (SELECT output_tax FROM led WHERE at = 'before'),
         (SELECT input_tax FROM led WHERE at = 'after') - (SELECT input_tax FROM led WHERE at = 'before') INTO v_x, v_y;
  PERFORM pg_temp.check('it ties to the ledger: output 47.10, input 30.00',
    v_x = (SELECT sum(tax) FROM vat_delta WHERE side = 'output') AND v_y = (SELECT sum(tax) FROM vat_delta WHERE side = 'input')
    AND v_x = 47.10 AND v_y = 30,
    '-> ledger ' || v_x || ' / ' || v_y || ', return ' || (SELECT sum(tax) FROM vat_delta WHERE side = 'output') || ' / ' || (SELECT sum(tax) FROM vat_delta WHERE side = 'input'));

  v_out := pg_temp.call(v_tech, format('SELECT * FROM public.rma_vat_return(%L, %L)', v_d, v_d));
  PERFORM pg_temp.check('a technician cannot read the return', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, format('SELECT * FROM public.rma_vat_return(%L, %L)', v_d, v_d - 1));
  PERFORM pg_temp.check('a period must end on or after its start', v_out LIKE 'err:22023%', '-> ' || v_out);
  PERFORM pg_temp.check('anon runs neither report',
    NOT has_function_privilege('anon', 'public.rma_vat_return(date, date)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_vat_return_ledger(date, date)', 'EXECUTE'));
  v_out := pg_temp.call(v_acct, $s$INSERT INTO public.tax_code_rates (code, rate) VALUES ('VAT14', 99)$s$);
  PERFORM pg_temp.check('nobody writes the rate history by hand', v_out LIKE 'err:42501%', '-> ' || v_out);

  RAISE EXCEPTION 'A04_TEST_DONE %', current_setting('a04.log', true);
END $do$;
