-- 20260828_verify_vendor_payment_currency.sql
-- Read-only. Confirms 20260793 did what it claims. Writes nothing.
--
-- Paste into the Supabase SQL editor. Only the LAST statement's result is
-- shown, so this is one query returning one row per check.

WITH checks AS (

  -- ── The three new columns on vendor_payments ───────────────────────────────
  SELECT 1 AS n, 'vendor_payments.currency exists, NOT NULL, FK to currencies' AS what,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='vendor_payments'
        AND column_name='currency' AND is_nullable='NO') = 1
    AND EXISTS (
      SELECT 1 FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema)
      WHERE tc.table_name='vendor_payments' AND tc.constraint_type='FOREIGN KEY'
        AND kcu.column_name='currency') AS pass

  UNION ALL SELECT 2, 'vendor_payments.exchange_rate exists and must be positive',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='vendor_payments'
        AND column_name='exchange_rate' AND is_nullable='NO') = 1
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='public.vendor_payments'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) ILIKE '%exchange_rate > %')

  -- Generated, not merely present: a plain column could be written directly and
  -- drift from the amount and rate it is supposed to be derived from.
  UNION ALL SELECT 3, 'vendor_payments.amount_base is GENERATED ALWAYS STORED',
    (SELECT is_generated FROM information_schema.columns
      WHERE table_schema='public' AND table_name='vendor_payments'
        AND column_name='amount_base') = 'ALWAYS'

  UNION ALL SELECT 4, 'the base/foreign rate guard fires on vendor_payments',
    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid='public.vendor_payments'::regclass
               AND tgname='trg_guard_vendor_payment_rate' AND NOT tgisinternal)

  -- ── Cross-currency settlement is refused ───────────────────────────────────
  -- Checked by reading the function bodies. Both writers must carry the test;
  -- one of them missing it leaves the whole door open.
  UNION ALL SELECT 5, 'record_vendor_payment refuses a currency mismatch',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='record_vendor_payment')
      LIKE '%v_inv.currency IS DISTINCT FROM%'

  UNION ALL SELECT 6, 'apply_vendor_payment_to_invoice refuses a currency mismatch',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='apply_vendor_payment_to_invoice')
      LIKE '%v_inv.currency IS DISTINCT FROM%'

  -- By NAME, not by rendered type. PostgREST binds RPC arguments by name — the
  -- app sends p_currency and p_exchange_rate — so the names are what has to be
  -- true. The first version of this check matched a type string and failed
  -- against a correctly applied migration, which is a check testing the wrong
  -- thing rather than a fault it found.
  UNION ALL SELECT 7, 'record_vendor_payment takes p_currency and p_exchange_rate by name',
    (SELECT bool_and(
              pg_get_function_arguments(p.oid) LIKE '%p_currency%'
          AND pg_get_function_arguments(p.oid) LIKE '%p_exchange_rate%')
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='record_vendor_payment')

  -- The old 8-argument version must be gone. If DROP had missed it, both would
  -- exist and PostgREST would have to choose between two overloads — the call
  -- omitting the currency arguments would be ambiguous.
  UNION ALL SELECT 16, 'exactly one record_vendor_payment exists',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='record_vendor_payment') = 1

  UNION ALL SELECT 8, 'record_vendor_payment is still executable by authenticated',
    (SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND p.proname IN ('record_vendor_payment','apply_vendor_payment_to_invoice'))

  -- ── The views ──────────────────────────────────────────────────────────────
  UNION ALL SELECT 9, 'v_purchase_documents exposes currency and total_base',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='v_purchase_documents'
        AND column_name IN ('currency','exchange_rate','total_base')) = 3

  UNION ALL SELECT 10, 'v_vendor_ledger exposes currency and amount_base',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='v_vendor_ledger'
        AND column_name IN ('currency','amount_base')) = 2

  -- The one that must never regress. A view without security_invoker runs as
  -- its owner and returns rows the caller has no right to see.
  UNION ALL SELECT 11, 'both rebuilt views still run as the caller (security_invoker)',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
        AND c.relname IN ('v_purchase_documents','v_vendor_ledger')
        AND array_to_string(c.reloptions, ',') LIKE '%security_invoker=true%') = 2

  UNION ALL SELECT 12, 'authenticated can still read both views',
    has_table_privilege('authenticated','public.v_purchase_documents','SELECT')
    AND has_table_privilege('authenticated','public.v_vendor_ledger','SELECT')

  -- ── Data sanity ────────────────────────────────────────────────────────────
  -- Every existing payment was recorded before currencies existed, so it must
  -- have come out as base currency at par. A row that did not means the
  -- backfill default did not apply.
  UNION ALL SELECT 13, 'no vendor payment is left without a currency or at a wrong par rate',
    NOT EXISTS (
      SELECT 1 FROM public.vendor_payments p
       WHERE p.currency IS NULL
          OR (p.currency = (SELECT config_value #>> '{}' FROM public.rma_config
                             WHERE config_key='default_currency')
              AND p.exchange_rate <> 1))

  -- The condition the money is actually protected by: every application must
  -- join a payment and an invoice that agree on currency.
  UNION ALL SELECT 14, 'no existing application settles across currencies',
    NOT EXISTS (
      SELECT 1 FROM public.vendor_payment_applications a
        JOIN public.vendor_payments  p ON p.id = a.payment_id
        JOIN public.vendor_invoices  i ON i.id = a.invoice_id
       WHERE p.currency IS DISTINCT FROM i.currency)

  UNION ALL SELECT 15, 'amount_base equals amount x rate on every payment',
    NOT EXISTS (
      SELECT 1 FROM public.vendor_payments
       WHERE amount_base <> round(amount * exchange_rate, 2))
)
SELECT n, CASE WHEN pass THEN 'PASS' ELSE '*** FAIL ***' END AS result, what
FROM checks ORDER BY n;
