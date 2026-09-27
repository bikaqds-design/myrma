-- supabase/tests/cash_and_bank.sql — 20260909, rolled back.
-- Cash payments post to the cash account, every other method to the bank.
-- #  node scripts/run-sql-test.mjs supabase/tests/cash_and_bank.sql CASHBANK_TEST_DONE

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT CASE WHEN p_ok THEN 'PASS  ' || p_label ELSE 'FAIL  ' || p_label || ' ' || COALESCE(p_detail, '') END
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
-- the account a posted document's money line went to
CREATE FUNCTION pg_temp.money_account(p_source text, p_id uuid, p_role_account uuid[]) RETURNS text LANGUAGE sql AS $f$
  SELECT a.code FROM public.journal_entries e JOIN public.journal_lines l ON l.entry_id = e.id
    JOIN public.gl_accounts a ON a.id = l.account_id
   WHERE e.source_type = p_source AND e.source_id = p_id AND l.account_id = ANY (p_role_account)
$f$;

DO $do$
DECLARE
  v_mgr   text := 'cashbank-mgr@test.local';
  v_cust  uuid;
  v_vend  uuid;
  v_cash  uuid;
  v_bank  uuid;
  v_p1    uuid;
  v_p2    uuid;
  v_vp    uuid;
  v_out   text;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('CashBank Co', 'CASHBANK-1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.brands (brand_name) VALUES ('CashBank Supplier') RETURNING id INTO v_vend;
  DELETE FROM public.rma_config WHERE config_key = 'vendor_payment_approval';

  -- ══ 1. the rules ══════════════════════════════════════════════════════════
  SELECT account_id INTO v_cash FROM public.posting_rules WHERE role = 'cash';
  SELECT account_id INTO v_bank FROM public.posting_rules WHERE role = 'bank';
  RAISE NOTICE '%', pg_temp.check('there is a bank rule, on a different account from cash',
    v_bank IS NOT NULL AND v_cash IS NOT NULL AND v_bank <> v_cash);
  RAISE NOTICE '%', pg_temp.check('default chart: bank is 1110 Bank, cash is 1100 Cash on hand',
    (SELECT code FROM public.gl_accounts WHERE id = v_bank) = '1110' AND (SELECT code FROM public.gl_accounts WHERE id = v_cash) = '1100',
    '-> bank ' || COALESCE((SELECT code FROM public.gl_accounts WHERE id = v_bank), 'none') || ', cash ' || COALESCE((SELECT code FROM public.gl_accounts WHERE id = v_cash), 'none'));
  RAISE NOTICE '%', pg_temp.check('only the cash method is cash',
    public.rma_gl_money_role('cash') = 'cash' AND public.rma_gl_money_role(' CASH ') = 'cash'
    AND public.rma_gl_money_role('bank_transfer') = 'bank' AND public.rma_gl_money_role('check') = 'bank'
    AND public.rma_gl_money_role('card') = 'bank' AND public.rma_gl_money_role(NULL) = 'bank');

  -- ══ 2. postings ═══════════════════════════════════════════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_p1 := public.record_payment(v_cust, 50, 'cash', NULL, CURRENT_DATE, NULL, v_mgr, '[]'::jsonb);
  v_p2 := public.record_payment(v_cust, 70, 'bank_transfer', 'TRF-1', CURRENT_DATE, NULL, v_mgr, '[]'::jsonb);
  v_vp := public.record_vendor_payment(v_vend, 30, 'check', 'CHQ-9', CURRENT_DATE, NULL, v_mgr, '[]'::jsonb, NULL, NULL, false);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a cash payment debits cash on hand',
    pg_temp.money_account('payment', v_p1, ARRAY[v_cash, v_bank]) = '1100', '-> ' || COALESCE(pg_temp.money_account('payment', v_p1, ARRAY[v_cash, v_bank]), 'none'));
  RAISE NOTICE '%', pg_temp.check('a bank transfer debits the bank',
    pg_temp.money_account('payment', v_p2, ARRAY[v_cash, v_bank]) = '1110', '-> ' || COALESCE(pg_temp.money_account('payment', v_p2, ARRAY[v_cash, v_bank]), 'none'));
  RAISE NOTICE '%', pg_temp.check('a supplier paid by cheque is paid from the bank',
    pg_temp.money_account('vendor_payment', v_vp, ARRAY[v_cash, v_bank]) = '1110', '-> ' || COALESCE(pg_temp.money_account('vendor_payment', v_vp, ARRAY[v_cash, v_bank]), 'none'));
  RAISE NOTICE '%', pg_temp.check('every entry still balances',
    NOT EXISTS (SELECT 1 FROM public.journal_lines l GROUP BY l.entry_id HAVING sum(l.debit) <> sum(l.credit)));
  RAISE NOTICE '%', pg_temp.check('refunds pick their account the same way',
    pg_get_functiondef('public.rma_gl_post_customer_refund'::regproc) LIKE '%rma_gl_money_role(NEW.method)%');

  -- ══ 3. the country templates ══════════════════════════════════════════════
  RAISE NOTICE '%', pg_temp.check('each country template: 1110 is cash, 1130 is bank',
    (SELECT count(*) FROM public.gl_chart_templates WHERE code = '1110' AND role = 'cash') = 3
    AND (SELECT count(*) FROM public.gl_chart_templates WHERE code = '1130' AND role = 'bank') = 3);
  RAISE NOTICE '%', pg_temp.check('each country template gives every posting role one account',
    NOT EXISTS (
      SELECT c.country_code, r.role
        FROM (SELECT DISTINCT country_code FROM public.gl_chart_templates) c
       CROSS JOIN (SELECT unnest(ARRAY['accounts_receivable','accounts_payable','inventory','goods_received_not_invoiced',
                     'sales_revenue','sales_tax_payable','purchase_tax_receivable','cost_of_goods_sold','purchase_price_variance',
                     'inventory_adjustment','cash','bank','customer_deposits','retained_earnings','opening_balance_equity',
                     'rounding','accrued_landed_costs']) AS role) r
       WHERE NOT EXISTS (SELECT 1 FROM public.gl_chart_templates t WHERE t.country_code = c.country_code AND t.role = r.role AND t.is_postable)));

  RAISE EXCEPTION 'CASHBANK_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
