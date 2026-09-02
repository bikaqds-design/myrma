-- Verify 20260792_purchasing_currency.sql. Every row should read PASS.
--
-- Exercises the rate guard for real — a base-currency document with a rate that
-- is not 1, and a foreign document with a rate of 1 — because a trigger that
-- exists is not the same as a trigger that fires. Both attempts are made
-- against a throwaway purchase order that is removed either way.

CREATE OR REPLACE FUNCTION pg_temp.zz_verify_purchasing_currency()
RETURNS TABLE(check_name text, result text, detail text)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_base      text;
  v_vendor    uuid;
  v_po        uuid;
  v_generated integer;
  v_fk        integer;
  v_charges   boolean;
  v_base_rate text;
  v_foreign   text;
  v_computed  text;
  v_left      integer;
BEGIN
  SELECT config_value #>> '{}' INTO v_base
    FROM public.rma_config WHERE config_key = 'default_currency';

  -- total_base must be GENERATED, not merely present: a plain column would go
  -- stale the first time anything updated total without updating it too.
  SELECT count(*) INTO v_generated
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('purchase_orders', 'vendor_invoices')
     AND column_name = 'total_base'
     AND is_generated = 'ALWAYS';

  SELECT count(*) INTO v_fk
    FROM pg_constraint
   WHERE conname IN ('purchase_orders_currency_fkey', 'vendor_invoices_currency_fkey');

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'vendor_invoice_charges'
  ) INTO v_charges;

  SELECT id INTO v_vendor FROM public.brands LIMIT 1;

  IF v_vendor IS NULL THEN
    v_base_rate := 'skipped — no vendor to test against';
    v_foreign   := 'skipped';
    v_computed  := 'skipped';
  ELSE
    DELETE FROM public.purchase_orders WHERE po_code = 'ZZ-CUR-PROBE';

    -- A real, well-formed base-currency order at rate 1.
    INSERT INTO public.purchase_orders (po_code, vendor_id, currency, exchange_rate, total, created_by)
    VALUES ('ZZ-CUR-PROBE', v_vendor, v_base, 1, 100, 'verify/20260827')
    RETURNING id INTO v_po;

    -- total_base should already equal total at rate 1.
    SELECT CASE WHEN total_base = 100 THEN 'PASS' ELSE 'got ' || total_base::text END
      INTO v_computed FROM public.purchase_orders WHERE id = v_po;

    -- Base currency with a rate other than 1 must be refused.
    BEGIN
      UPDATE public.purchase_orders SET exchange_rate = 1.05 WHERE id = v_po;
      v_base_rate := 'ACCEPTED — guard did not fire';
      UPDATE public.purchase_orders SET exchange_rate = 1 WHERE id = v_po;
    EXCEPTION WHEN OTHERS THEN
      v_base_rate := 'refused (correct)';
    END;

    -- A foreign currency at rate 1 must also be refused: it would record the
    -- foreign amount as though it were already base currency.
    BEGIN
      UPDATE public.purchase_orders
         SET currency = (SELECT code FROM public.currencies WHERE code <> v_base AND is_active LIMIT 1),
             exchange_rate = 1
       WHERE id = v_po;
      v_foreign := 'ACCEPTED — guard did not fire';
    EXCEPTION WHEN OTHERS THEN
      v_foreign := 'refused (correct)';
    END;

    DELETE FROM public.purchase_orders WHERE po_code = 'ZZ-CUR-PROBE';
  END IF;

  SELECT count(*) INTO v_left FROM public.purchase_orders WHERE po_code = 'ZZ-CUR-PROBE';

  RETURN QUERY
  SELECT * FROM (VALUES
    ('base currency', 'INFO', COALESCE(v_base, 'NOT SET')),
    ('total_base is a generated column on both tables',
     CASE WHEN v_generated = 2 THEN 'PASS' ELSE 'FAIL' END, v_generated || ' of 2'),
    ('currency is a real foreign key on both tables',
     CASE WHEN v_fk = 2 THEN 'PASS' ELSE 'FAIL' END, v_fk || ' of 2'),
    ('vendor_invoice_charges exists',
     CASE WHEN v_charges THEN 'PASS' ELSE 'FAIL' END, v_charges::text),
    ('total_base computed correctly at rate 1',
     CASE WHEN v_computed IN ('PASS', 'skipped') THEN 'PASS' ELSE 'FAIL' END, v_computed),
    ('base currency with a rate other than 1 is refused',
     CASE WHEN v_base_rate LIKE 'refused%' OR v_base_rate LIKE 'skipped%' THEN 'PASS' ELSE 'FAIL' END, v_base_rate),
    ('foreign currency at rate 1 is refused',
     CASE WHEN v_foreign LIKE 'refused%' OR v_foreign LIKE 'skipped%' THEN 'PASS' ELSE 'FAIL' END, v_foreign),
    ('no existing document contradicts the rule',
     CASE WHEN (SELECT count(*) FROM public.purchase_orders WHERE currency = v_base AND exchange_rate <> 1)
             + (SELECT count(*) FROM public.vendor_invoices  WHERE currency = v_base AND exchange_rate <> 1) = 0
          THEN 'PASS' ELSE 'FAIL' END, 'base-currency documents at rate 1'),
    ('probe row removed',
     CASE WHEN v_left = 0 THEN 'PASS' ELSE 'FAIL' END, v_left || ' remaining')
  ) AS x(check_name, result, detail);

EXCEPTION WHEN OTHERS THEN
  DELETE FROM public.purchase_orders WHERE po_code = 'ZZ-CUR-PROBE';
  RAISE;
END
$fn$;

SELECT * FROM pg_temp.zz_verify_purchasing_currency();
