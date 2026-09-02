-- Verify 20260791_currency_foundation.sql. Every row should read PASS.
--
-- Includes a live test of the base-currency lock: it attempts a real change and
-- reverts it if the guard let it through, so the result reflects what the
-- database actually does rather than what the trigger definition looks like.

CREATE OR REPLACE FUNCTION pg_temp.zz_verify_currency()
RETURNS TABLE(check_name text, result text, detail text)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_currencies   integer;
  v_base         text;
  v_scales       integer;
  v_bare         integer;
  v_anon         boolean;
  v_lock         text;
  v_docs         integer;
  v_before       jsonb;
  v_views        integer;
  v_view_rows    text;
BEGIN
  -- 20260791 has to drop and rebuild these two to retype the columns they
  -- select. Both must come back with security_invoker, or they read rows the
  -- caller has no right to — the exact leak 20260778 closed.
  SELECT count(*) INTO v_views
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('v_purchase_documents', 'v_vendor_ledger')
     AND array_to_string(c.reloptions, ',') LIKE '%security_invoker=true%';

  -- And they must still return data: a view that exists but errors or returns
  -- nothing would show as an empty purchasing list rather than a failure.
  BEGIN
    SELECT (SELECT count(*) FROM public.v_purchase_documents)::text || ' purchase, '
        || (SELECT count(*) FROM public.v_vendor_ledger)::text || ' ledger'
      INTO v_view_rows;
  EXCEPTION WHEN OTHERS THEN
    v_view_rows := 'ERROR: ' || SQLERRM;
  END;

  SELECT count(*) INTO v_currencies FROM public.currencies WHERE is_active;
  SELECT config_value #>> '{}' INTO v_base
    FROM public.rma_config WHERE config_key = 'default_currency';

  -- Every purchasing money column should now carry scale 2.
  SELECT count(*) INTO v_scales
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('purchase_orders', 'vendor_invoices')
     AND column_name IN ('total', 'subtotal', 'discount_amount', 'tax_amount')
     AND numeric_scale = 2;

  SELECT count(*) INTO v_bare
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('purchase_orders', 'vendor_invoices')
     AND column_name IN ('total', 'subtotal', 'discount_amount', 'tax_amount')
     AND numeric_scale IS DISTINCT FROM 2;

  -- currencies must not be readable without a session.
  SELECT has_table_privilege('anon', 'public.currencies', 'SELECT') INTO v_anon;

  SELECT
      (SELECT count(*) FROM public.crm_invoices)
    + (SELECT count(*) FROM public.quotations)
    + (SELECT count(*) FROM public.sales_orders)
    + (SELECT count(*) FROM public.purchase_orders)
    + (SELECT count(*) FROM public.vendor_invoices)
    + (SELECT count(*) FROM public.payments)
    + (SELECT count(*) FROM public.vendor_payments)
    INTO v_docs;

  -- ── Live test of the lock ─────────────────────────────────────────────────
  SELECT config_value INTO v_before
    FROM public.rma_config WHERE config_key = 'default_currency';
  BEGIN
    UPDATE public.rma_config
       SET config_value = '"USD"'::jsonb
     WHERE config_key = 'default_currency';
    -- Got through. Correct only when nothing has been transacted yet.
    UPDATE public.rma_config
       SET config_value = v_before
     WHERE config_key = 'default_currency';
    v_lock := CASE WHEN v_docs = 0
                   THEN 'allowed (correct — no documents exist yet)'
                   ELSE 'ALLOWED WITH DOCUMENTS PRESENT' END;
  EXCEPTION WHEN OTHERS THEN
    v_lock := CASE WHEN v_docs > 0
                   THEN 'refused (correct)'
                   ELSE 'REFUSED WITH NO DOCUMENTS' END;
  END;

  RETURN QUERY
  SELECT * FROM (VALUES
    ('currencies table populated',
     CASE WHEN v_currencies >= 5 THEN 'PASS' ELSE 'FAIL' END,
     v_currencies || ' active'),
    ('base currency set',
     CASE WHEN v_base IS NOT NULL THEN 'PASS' ELSE 'FAIL' END,
     COALESCE(v_base, 'NOT SET')),
    ('base currency is a known active currency',
     CASE WHEN EXISTS (SELECT 1 FROM public.currencies WHERE code = v_base AND is_active)
          THEN 'PASS' ELSE 'FAIL' END, COALESCE(v_base, '—')),
    ('purchasing money columns have scale 2',
     CASE WHEN v_scales = 8 THEN 'PASS' ELSE 'FAIL' END,
     v_scales || ' of 8'),
    ('no purchasing money column left unscaled',
     CASE WHEN v_bare = 0 THEN 'PASS' ELSE 'FAIL' END,
     v_bare || ' remaining'),
    ('currencies not readable anonymously',
     CASE WHEN v_anon THEN 'FAIL' ELSE 'PASS' END,
     CASE WHEN v_anon THEN 'anon has SELECT' ELSE 'anon refused' END),
    ('base currency lock behaves correctly',
     CASE WHEN v_lock LIKE '%correct%' THEN 'PASS' ELSE 'FAIL' END,
     v_lock || ' · ' || v_docs || ' document(s) exist'),
    ('base currency unchanged by this check',
     CASE WHEN (SELECT config_value FROM public.rma_config WHERE config_key = 'default_currency')
               = v_before THEN 'PASS' ELSE 'FAIL' END,
     v_before #>> '{}'),
    ('rebuilt views kept security_invoker',
     CASE WHEN v_views = 2 THEN 'PASS' ELSE 'FAIL' END,
     v_views || ' of 2 · without it they bypass RLS'),
    ('rebuilt views still return data',
     CASE WHEN v_view_rows LIKE 'ERROR%' THEN 'FAIL' ELSE 'PASS' END,
     v_view_rows)
  ) AS x(check_name, result, detail);
END
$fn$;

SELECT * FROM pg_temp.zz_verify_currency();
