-- 20260842_dryrun_currency_settings.sql
-- Tests what the Currency & Costing screen writes, against the REAL policies
-- and the REAL guard, and PERSISTS NOTHING.
--
-- ═══ How it leaves no trace ══════════════════════════════════════════════════
--
-- One transaction, ending in RAISE EXCEPTION. That aborts it, so every change
-- is rolled back: the currency it adds, the toggle it flips, the config value
-- it sets. The exception message IS the report — an "ERROR" here is the
-- expected, successful ending. Read the numbers in it.
--
-- ═══ What it proves ══════════════════════════════════════════════════════════
--
--  1. An admin can do what the screen offers: activate, deactivate, add.
--  2. The base currency is genuinely protected, not just hidden in the UI —
--     the database refuses to change it while documents exist. If that guard
--     were absent, a read-only field would be the only thing standing between
--     an administrator and silently reinterpreting every amount in the system.
--  3. Deactivating a currency never removes the row, so documents raised in it
--     keep their foreign key.
--  4. purchase_tax_in_cost is a real config value the screen can set.
--
-- Paste and run. Expect an ERROR whose message is a table of results.

SET LOCAL request.jwt.claims = '{"email":"bika.qds@gmail.com","role":"authenticated"}';

DO $do$
DECLARE
  v_base      text;
  v_docs      integer;
  v_before    boolean;
  v_after     boolean;
  v_exists    boolean;
  v_refused   boolean := false;
  v_msg       text := '';
  v_report    text := '';
  v_fails     integer := 0;
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION
      'Impersonation did not take, or this account is not an admin. currencies_admin_write requires rma_is_admin().';
  END IF;

  SELECT config_value #>> '{}' INTO v_base
    FROM public.rma_config WHERE config_key = 'default_currency';

  SELECT (SELECT count(*) FROM public.crm_invoices)
       + (SELECT count(*) FROM public.quotations)
       + (SELECT count(*) FROM public.sales_orders)
       + (SELECT count(*) FROM public.purchase_orders)
       + (SELECT count(*) FROM public.vendor_invoices)
       + (SELECT count(*) FROM public.payments)
       + (SELECT count(*) FROM public.vendor_payments)
    INTO v_docs;

  v_report := format(E'\n  base currency: %s   transaction documents: %s\n', v_base, v_docs);

  -- ── 1. Deactivate and reactivate a non-base currency ────────────────────
  SELECT is_active INTO v_before FROM public.currencies WHERE code = 'USD';

  UPDATE public.currencies SET is_active = false WHERE code = 'USD';
  SELECT is_active INTO v_after FROM public.currencies WHERE code = 'USD';
  SELECT EXISTS (SELECT 1 FROM public.currencies WHERE code = 'USD') INTO v_exists;

  v_report := v_report || format(
    E'\n  an admin can deactivate a currency\n    USD is_active %s -> %s   %s',
    v_before, v_after, CASE WHEN v_after = false THEN 'PASS' ELSE '*** FAIL ***' END);
  IF v_after IS DISTINCT FROM false THEN v_fails := v_fails + 1; END IF;

  -- The row must survive. Documents carry a foreign key to currencies(code);
  -- deleting instead of deactivating would orphan every one of them.
  v_report := v_report || format(
    E'\n  deactivating does not delete the row\n    USD still present: %s   %s',
    v_exists, CASE WHEN v_exists THEN 'PASS' ELSE '*** FAIL ***' END);
  IF NOT v_exists THEN v_fails := v_fails + 1; END IF;

  UPDATE public.currencies SET is_active = true WHERE code = 'USD';
  SELECT is_active INTO v_after FROM public.currencies WHERE code = 'USD';
  v_report := v_report || format(
    E'\n  and can turn it back on\n    USD is_active -> %s   %s',
    v_after, CASE WHEN v_after THEN 'PASS' ELSE '*** FAIL ***' END);
  IF NOT v_after THEN v_fails := v_fails + 1; END IF;

  -- ── 2. Add a currency, exactly as the form does ─────────────────────────
  INSERT INTO public.currencies (code, name, symbol, decimals)
  VALUES ('ZZZ', 'Dry Run Currency', 'Z', 2);
  SELECT EXISTS (SELECT 1 FROM public.currencies WHERE code = 'ZZZ') INTO v_exists;
  v_report := v_report || format(
    E'\n\n  an admin can add a currency\n    ZZZ created: %s   %s',
    v_exists, CASE WHEN v_exists THEN 'PASS' ELSE '*** FAIL ***' END);
  IF NOT v_exists THEN v_fails := v_fails + 1; END IF;

  -- decimals is CHECKed between 0 and 4; a JPY-style 0 must be allowed.
  BEGIN
    INSERT INTO public.currencies (code, name, symbol, decimals)
    VALUES ('ZZY', 'Zero Decimals', 'Z', 0);
    v_report := v_report || E'\n  zero-decimal currencies are allowed\n    PASS';
  EXCEPTION WHEN OTHERS THEN
    v_report := v_report || E'\n  zero-decimal currencies are allowed\n    *** FAIL *** ' || SQLERRM;
    v_fails := v_fails + 1;
  END;

  -- ── 3. The base currency is protected by the DATABASE ───────────────────
  -- The screen shows it read-only. This proves that is a reflection of a real
  -- rule rather than the only thing enforcing it.
  BEGIN
    UPDATE public.rma_config
       SET config_value = to_jsonb('USD'::text)
     WHERE config_key = 'default_currency';
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
    v_msg := SQLERRM;
  END;

  v_report := v_report || format(
    E'\n\n  the database refuses to change the base currency\n    refused: %s   %s',
    v_refused,
    CASE WHEN v_refused OR v_docs = 0 THEN 'PASS' ELSE '*** FAIL ***' END);
  IF NOT v_refused AND v_docs > 0 THEN v_fails := v_fails + 1; END IF;
  IF v_refused THEN
    v_report := v_report || E'\n    reason: ' || left(v_msg, 150);
  ELSIF v_docs = 0 THEN
    v_report := v_report || E'\n    (no documents exist, so a change is legitimately still allowed)';
  END IF;

  -- ── 4. The purchase-tax setting is writable ─────────────────────────────
  UPDATE public.rma_config
     SET config_value = to_jsonb(true)
   WHERE config_key = 'purchase_tax_in_cost';

  SELECT (config_value #>> '{}')::boolean INTO v_after
    FROM public.rma_config WHERE config_key = 'purchase_tax_in_cost';

  v_report := v_report || format(
    E'\n\n  purchase_tax_in_cost can be set\n    now: %s   %s',
    v_after, CASE WHEN v_after THEN 'PASS' ELSE '*** FAIL ***' END);
  IF v_after IS DISTINCT FROM true THEN v_fails := v_fails + 1; END IF;

  -- ── 5. And it actually changes what a receipt would cost ───────────────
  -- Not just a stored flag.
  --
  -- Two earlier drafts of this section were both weaker than they looked. The
  -- first only checked that a taxed invoice existed and reported PASS without
  -- computing anything. The second computed properly but SKIPPED, because no
  -- vendor invoice in this database carries a tax percentage — a skipped check
  -- is an untested claim wearing a green tick.
  --
  -- So it builds its own invoice. The whole transaction is rolled back, so
  -- creating one costs nothing and makes the check deterministic: 10 units at
  -- 100 with 14% tax and no charges must cost exactly 100 with the setting off
  -- and exactly 114 with it on.
  DECLARE
    v_vendor    uuid;
    v_prod      uuid;
    v_name      text;
    v_vi        uuid;
    v_cost_off  numeric;
    v_cost_on   numeric;
  BEGIN
    SELECT id INTO v_vendor FROM public.brands
     WHERE brand_name ILIKE '%QA Throwaway%' LIMIT 1;
    IF v_vendor IS NULL THEN
      SELECT id INTO v_vendor FROM public.brands ORDER BY id LIMIT 1;
    END IF;

    SELECT id, product_name INTO v_prod, v_name
      FROM public.products ORDER BY id LIMIT 1;

    IF v_vendor IS NULL OR v_prod IS NULL THEN
      RAISE EXCEPTION 'Cannot build the tax fixture: no vendor or no product exists.';
    END IF;

    INSERT INTO public.vendor_invoices
      (vendor_id, status, line_items, subtotal, discount_amount, tax_amount, total,
       currency, exchange_rate, amount_paid, payment_status, created_by)
    VALUES
      (v_vendor, 'draft',
       jsonb_build_array(jsonb_build_object(
         'product_id', v_prod, 'product_name', v_name,
         'qty_ordered', 10, 'qty_received', 0,
         'unit_cost', 100, 'tax_pct', 14)),
       1000, 0, 140, 1140, v_base, 1, 0, 'unpaid', 'dryrun')
    RETURNING id INTO v_vi;

    UPDATE public.rma_config SET config_value = to_jsonb(false)
     WHERE config_key = 'purchase_tax_in_cost';
    SELECT c.unit_cost_base INTO v_cost_off
      FROM public.rma_vi_landed_unit_costs(v_vi) c WHERE c.product_id = v_prod LIMIT 1;

    UPDATE public.rma_config SET config_value = to_jsonb(true)
     WHERE config_key = 'purchase_tax_in_cost';
    SELECT c.unit_cost_base INTO v_cost_on
      FROM public.rma_vi_landed_unit_costs(v_vi) c WHERE c.product_id = v_prod LIMIT 1;

    v_report := v_report || format(
      E'\n\n  the tax setting reaches the costing function\n    10 x 100 at 14%% tax:  excluded E£%s   included E£%s',
      v_cost_off, v_cost_on);

    v_report := v_report || format(
      E'\n    tax excluded gives the net price (expected 100.0000)   %s',
      CASE WHEN v_cost_off = 100.0000 THEN 'PASS' ELSE '*** FAIL ***' END);
    IF v_cost_off IS DISTINCT FROM 100.0000 THEN v_fails := v_fails + 1; END IF;

    v_report := v_report || format(
      E'\n    tax included adds it (expected 114.0000)              %s',
      CASE WHEN v_cost_on = 114.0000 THEN 'PASS' ELSE '*** FAIL *** the flag changed nothing' END);
    IF v_cost_on IS DISTINCT FROM 114.0000 THEN v_fails := v_fails + 1; END IF;
  END;

  RAISE EXCEPTION E'\n\n===== CURRENCY SETTINGS DRY RUN =====\n%\n\n  %\n\nNothing was saved: this transaction is being rolled back on purpose.\n',
    v_report,
    CASE WHEN v_fails = 0 THEN 'ALL CHECKS PASSED' ELSE v_fails || ' CHECK(S) FAILED — see above' END;
END
$do$;
