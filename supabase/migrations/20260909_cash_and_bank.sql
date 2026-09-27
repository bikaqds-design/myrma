-- ============================================================================
-- 20260909_cash_and_bank.sql
-- A-01 follow-up: cash and bank post to separate accounts.
-- ============================================================================
-- Owner decision (2026-09-27): split cash and bank now, rather than posting
-- every payment to one account until bank accounts exist (A-07).
--
--   1. New posting role `bank`. A payment, refund or supplier payment made by
--      method 'cash' posts to the `cash` role; any other method (bank
--      transfer, cheque, card, other) posts to `bank`.
--   2. Rules. `bank` takes the account the `cash` role points at today, so a
--      transfer keeps landing where it always did. `cash` then moves to the
--      chart's cash-on-hand account — 1100 in the default chart, 1110 in the
--      country templates — when that account exists, is postable and active;
--      otherwise it stays where it is and the tenant sets it in Control Panel.
--   3. Country templates (20260908): 1110 Cash on hand carries `cash`, 1130
--      Bank – current account carries `bank`.
--   4. rma_gl_post_payment / rma_gl_post_customer_refund /
--      rma_gl_post_vendor_payment pick the role through rma_gl_money_role(method)
--      (rewritten in their live definitions, each anchor counted first).
--
-- Entries already posted keep their accounts (the journal is immutable).
-- Pinned by src/test/cashBankSplit.test.js; supabase/tests/cash_and_bank.sql is
-- the rolled-back reference script.
-- ============================================================================

-- ── 1. the role ─────────────────────────────────────────────────────────────
ALTER TABLE public.posting_rules DROP CONSTRAINT IF EXISTS posting_rules_role_check;
ALTER TABLE public.posting_rules ADD CONSTRAINT posting_rules_role_check CHECK (role IN (
  'accounts_receivable', 'accounts_payable', 'inventory', 'goods_received_not_invoiced',
  'sales_revenue', 'sales_tax_payable', 'purchase_tax_receivable', 'cost_of_goods_sold',
  'purchase_price_variance', 'inventory_adjustment', 'cash', 'bank', 'customer_deposits',
  'retained_earnings', 'opening_balance_equity', 'rounding', 'accrued_landed_costs'));

CREATE OR REPLACE FUNCTION public.rma_gl_money_role(p_method text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT CASE WHEN lower(btrim(COALESCE(p_method, ''))) = 'cash' THEN 'cash' ELSE 'bank' END
$fn$;
REVOKE ALL ON FUNCTION public.rma_gl_money_role(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_gl_money_role(text) TO authenticated, service_role;

-- ── 2. the rules ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_cash_acct uuid;
  v_hand_code text;
  v_hand      uuid;
BEGIN
  SELECT account_id INTO v_cash_acct FROM public.posting_rules WHERE role = 'cash';

  -- bank: where money already went
  IF v_cash_acct IS NOT NULL THEN
    INSERT INTO public.posting_rules (role, account_id) VALUES ('bank', v_cash_acct)
    ON CONFLICT (role) DO NOTHING;
  END IF;

  -- cash: the chart's cash-on-hand account, if it has one to give
  v_hand_code := CASE WHEN EXISTS (SELECT 1 FROM public.rma_config
                                    WHERE config_key = 'chart_template' AND COALESCE(config_value #>> '{}', '') <> '')
                      THEN '1110' ELSE '1100' END;
  SELECT id INTO v_hand FROM public.gl_accounts
   WHERE code = v_hand_code AND is_postable AND is_active AND id IS DISTINCT FROM v_cash_acct;
  IF v_hand IS NOT NULL AND v_cash_acct IS NOT NULL
     AND (SELECT account_id FROM public.posting_rules WHERE role = 'bank') = v_cash_acct THEN
    UPDATE public.posting_rules SET account_id = v_hand WHERE role = 'cash';
  END IF;
  RAISE NOTICE '20260909: bank -> %, cash -> %',
    (SELECT a.code FROM public.posting_rules r JOIN public.gl_accounts a ON a.id = r.account_id WHERE r.role = 'bank'),
    (SELECT a.code FROM public.posting_rules r JOIN public.gl_accounts a ON a.id = r.account_id WHERE r.role = 'cash');
END $$;

-- ── 3. the country templates ────────────────────────────────────────────────
UPDATE public.gl_chart_templates SET role = 'bank' WHERE code = '1130' AND country_code IN ('EG', 'AE', 'SA');
UPDATE public.gl_chart_templates SET role = 'cash' WHERE code = '1110' AND country_code IN ('EG', 'AE', 'SA');

-- ── 4. the postings choose by method ────────────────────────────────────────
DO $$
DECLARE
  v_def  text;
  r      record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.rma_gl_post_payment',
       $o$jsonb_build_object('role', 'cash', 'debit', NEW.amount)$o$,
       $n$jsonb_build_object('role', public.rma_gl_money_role(NEW.method), 'debit', NEW.amount)$n$),
      ('public.rma_gl_post_customer_refund',
       $o$jsonb_build_object('role', 'cash', 'credit', NEW.amount)$o$,
       $n$jsonb_build_object('role', public.rma_gl_money_role(NEW.method), 'credit', NEW.amount)$n$),
      ('public.rma_gl_post_vendor_payment',
       $o$public._gl_line('cash', -v_amt)$o$,
       $n$public._gl_line(public.rma_gl_money_role(NEW.method), -v_amt)$n$)
    ) AS t(fn, old_text, new_text)
  LOOP
    SELECT replace(pg_get_functiondef(r.fn::regproc), E'\r\n', E'\n') INTO v_def;
    IF strpos(v_def, r.new_text) > 0 THEN
      CONTINUE; -- already applied
    END IF;
    IF (length(v_def) - length(replace(v_def, r.old_text, ''))) / length(r.old_text) <> 1 THEN
      RAISE EXCEPTION '20260909: % does not read as expected; not changed', r.fn;
    END IF;
    EXECUTE replace(v_def, r.old_text, r.new_text);
  END LOOP;

  -- nothing may still post a payment straight to the cash role
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('rma_gl_post_payment', 'rma_gl_post_customer_refund', 'rma_gl_post_vendor_payment')
                AND (pg_get_functiondef(p.oid) LIKE '%''role'', ''cash''%' OR pg_get_functiondef(p.oid) LIKE '%_gl_line(''cash''%')) THEN
    RAISE EXCEPTION 'Refusing to finish: a payment posting still names the cash role directly';
  END IF;
END $$;
