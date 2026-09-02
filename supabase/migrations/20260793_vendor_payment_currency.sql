-- 20260793_vendor_payment_currency.sql
-- Currency engine, stage 2b — vendor payments, and base-currency reporting.
--
-- ═══ What this fixes ═════════════════════════════════════════════════════════
--
-- 20260792 gave purchase orders and vendor invoices a currency and an exchange
-- rate. It left two holes that make the rest of purchasing quietly wrong the
-- moment the first foreign invoice exists:
--
--  1. vendor_payments has no currency at all. Its `amount` settles an invoice
--     through vendor_payment_applications, and the RPCs do
--     `amount_paid + applied >= total` — arithmetic that compares the payment
--     to the invoice directly. With no currency on the payment, paying E£1,000
--     against a $1,000 invoice marks that invoice PAID IN FULL. Nothing in the
--     database would object, and the vendor would still be owed roughly
--     E£47,500.
--
--  2. v_purchase_documents and v_vendor_ledger expose only `total` / `amount`,
--     in each document's own currency, with no indication of which currency
--     that is. Every screen reading them — the purchasing list, the graph
--     view, the pivot, vendor total-spend and the vendor ledger running
--     balance — sums those numbers into a single figure labelled EGP. A
--     $10,000 import would be added to the spend total as though it were
--     E£10,000, understating it by a factor of about forty-eight.
--
-- ═══ The rule this adopts ════════════════════════════════════════════════════
--
-- A vendor payment is made in the currency of the invoices it settles, and may
-- only be applied to invoices in that same currency. No cross-currency
-- settlement. That is both what actually happens — you pay a USD supplier in
-- USD — and the only rule under which `amount_paid` stays a number that can be
-- compared with `total`.
--
-- The payment carries its OWN exchange rate, not the invoice's. Currency is
-- bought on the day it is paid, so the base-currency cost of settling a USD
-- invoice is normally not equal to the base-currency value recorded when it was
-- received. That difference is a real FX gain or loss. This migration records
-- both figures honestly rather than forcing them to agree; booking the
-- difference to a gain/loss account is an accounting decision that has not been
-- made yet, and pretending the rates are the same would hide it forever.
--
-- ═══ Applying ════════════════════════════════════════════════════════════════
-- Paste into the Supabase SQL editor. The whole script is one transaction:
-- if any part fails nothing is applied.
-- Verify with supabase/manual/20260828_verify_vendor_payment_currency.sql.

-- ═══ 1. Currency and rate on vendor_payments ═════════════════════════════════

DO $do$
DECLARE
  v_base text;
BEGIN
  SELECT config_value #>> '{}' INTO v_base
    FROM public.rma_config WHERE config_key = 'default_currency';

  IF v_base IS NULL THEN
    RAISE EXCEPTION
      'rma_config.default_currency is not set. Apply 20260791_currency_foundation.sql first.';
  END IF;

  -- Existing rows predate any notion of currency, so they are base-currency
  -- payments by definition — nothing else could have been recorded.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'vendor_payments'
       AND column_name = 'currency'
  ) THEN
    EXECUTE format(
      'ALTER TABLE public.vendor_payments
         ADD COLUMN currency char(3) NOT NULL DEFAULT %L
           REFERENCES public.currencies(code)',
      v_base);
  END IF;
END
$do$;

ALTER TABLE public.vendor_payments
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8) NOT NULL DEFAULT 1
    CHECK (exchange_rate > 0);

-- Generated, so it cannot drift from the amount and rate it is derived from.
-- The same reasoning as total_base on the two document tables.
ALTER TABLE public.vendor_payments
  ADD COLUMN IF NOT EXISTS amount_base numeric(12,2)
    GENERATED ALWAYS AS (round(amount * exchange_rate, 2)) STORED;

COMMENT ON COLUMN public.vendor_payments.currency IS
  'The currency the payment was made in. Must match the currency of every invoice it is applied to.';
COMMENT ON COLUMN public.vendor_payments.exchange_rate IS
  'Rate to the base currency ON THE PAYMENT DATE, which is normally not the rate the invoice was received at. The difference is an FX gain or loss.';
COMMENT ON COLUMN public.vendor_payments.amount_base IS
  'What the payment cost in base currency. Derived; never written directly.';

-- Same guard as the documents: base currency ⇒ rate exactly 1, foreign ⇒ not 1.
DROP TRIGGER IF EXISTS trg_guard_vendor_payment_rate ON public.vendor_payments;
CREATE TRIGGER trg_guard_vendor_payment_rate
  BEFORE INSERT OR UPDATE OF currency, exchange_rate ON public.vendor_payments
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_document_rate();

-- ═══ 2. Settlement may not cross currencies ══════════════════════════════════
-- Enforced inside both RPCs rather than by a constraint: the check is between
-- two tables, which a CHECK cannot see, and the RPCs are the only writers.

DROP FUNCTION IF EXISTS public.record_vendor_payment(uuid, numeric, text, text, date, text, text, jsonb);

CREATE FUNCTION public.record_vendor_payment(
  p_vendor_id        uuid,
  p_amount           numeric,
  p_method           text,
  p_reference_number text,
  p_payment_date     date,
  p_notes            text,
  p_actor_email      text,
  p_allocations      jsonb    DEFAULT '[]'::jsonb,
  p_currency         char(3)  DEFAULT NULL,
  p_exchange_rate    numeric  DEFAULT NULL
)
RETURNS uuid   -- vendor_payments id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_code  text;
  v_id    uuid;
  v_actor text;
  v_alloc record;
  v_sum   numeric(12,2) := 0;
  v_inv   record;
  v_base  text;
  v_cur   char(3);
  v_rate  numeric(18,8);
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to record vendor payments';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  SELECT config_value #>> '{}' INTO v_base
    FROM public.rma_config WHERE config_key = 'default_currency';

  -- Omitting the currency means a local payment. Callers written before this
  -- migration pass neither argument and keep working unchanged.
  v_cur  := COALESCE(p_currency, v_base);
  v_rate := COALESCE(p_exchange_rate, 1);

  v_code := public.nextval_for_type('vendor_payment');

  INSERT INTO public.vendor_payments (
    payment_code, vendor_id, amount, unapplied_amount,
    method, reference_number, payment_date, notes, created_by,
    currency, exchange_rate
  )
  VALUES (
    v_code, p_vendor_id, p_amount, p_amount,
    p_method, p_reference_number,
    COALESCE(p_payment_date, CURRENT_DATE),
    p_notes, v_actor,
    v_cur, v_rate
  )
  RETURNING id INTO v_id;

  FOR v_alloc IN
    SELECT
      (x->>'invoice_id')::uuid AS invoice_id,
      (x->>'amount')::numeric  AS amount
    FROM jsonb_array_elements(p_allocations) AS x
    WHERE (x->>'amount')::numeric > 0
  LOOP
    v_sum := v_sum + v_alloc.amount;
    IF v_sum > p_amount THEN
      RAISE EXCEPTION 'Allocations (%) exceed payment amount (%)', v_sum, p_amount;
    END IF;

    SELECT id, vendor_id, total, amount_paid, currency
      INTO v_inv
    FROM public.vendor_invoices
    WHERE id = v_alloc.invoice_id
      AND status IN ('approved', 'partially_received', 'received')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Vendor invoice % is not payable', v_alloc.invoice_id;
    END IF;
    IF v_inv.vendor_id <> p_vendor_id THEN
      RAISE EXCEPTION 'Vendor invoice % belongs to a different vendor', v_alloc.invoice_id;
    END IF;
    -- Without this, a payment of 1,000 in one currency marks an invoice of
    -- 1,000 in another paid in full.
    IF v_inv.currency IS DISTINCT FROM v_cur THEN
      RAISE EXCEPTION
        'Cannot settle a % invoice with a % payment. Record the payment in % instead.',
        v_inv.currency, v_cur, v_inv.currency
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.vendor_payment_applications (
      payment_id, invoice_id, amount_applied, applied_by
    )
    VALUES (v_id, v_alloc.invoice_id, v_alloc.amount, v_actor);

    UPDATE public.vendor_invoices
    SET
      amount_paid    = LEAST(amount_paid + v_alloc.amount, total),
      payment_status = CASE
        WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN 'paid'
        WHEN LEAST(amount_paid + v_alloc.amount, total) > 0     THEN 'partial'
        ELSE 'unpaid'
        END,
      paid_at = CASE
        WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN NOW()
        ELSE paid_at
        END,
      updated_at = NOW()
    WHERE id = v_alloc.invoice_id;
  END LOOP;

  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.apply_vendor_payment_to_invoice(
  p_payment_id  uuid,
  p_invoice_id  uuid,
  p_amount      numeric,
  p_actor_email text
)
RETURNS uuid   -- vendor_payment_applications id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_actor text;
  v_pay   record;
  v_inv   record;
  v_app   uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to apply vendor payments';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Applied amount must be positive';
  END IF;

  SELECT id, vendor_id, status, unapplied_amount, currency
    INTO v_pay
  FROM public.vendor_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor payment not found: %', p_payment_id;
  END IF;
  IF v_pay.status <> 'active' THEN
    RAISE EXCEPTION 'Vendor payment must be active to apply (current: %)', v_pay.status;
  END IF;
  IF p_amount > v_pay.unapplied_amount THEN
    RAISE EXCEPTION 'Amount % exceeds unapplied balance %', p_amount, v_pay.unapplied_amount;
  END IF;

  SELECT id, vendor_id, total, amount_paid, currency
    INTO v_inv
  FROM public.vendor_invoices
  WHERE id = p_invoice_id
    AND status IN ('approved', 'partially_received', 'received')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice % is not payable', p_invoice_id;
  END IF;
  IF v_inv.vendor_id <> v_pay.vendor_id THEN
    RAISE EXCEPTION 'Vendor invoice % belongs to a different vendor', p_invoice_id;
  END IF;
  IF v_inv.currency IS DISTINCT FROM v_pay.currency THEN
    RAISE EXCEPTION
      'Cannot settle a % invoice with a % payment. Record the payment in % instead.',
      v_inv.currency, v_pay.currency, v_inv.currency
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.vendor_payment_applications (
    payment_id, invoice_id, amount_applied, applied_by
  )
  VALUES (p_payment_id, p_invoice_id, p_amount, v_actor)
  RETURNING id INTO v_app;

  UPDATE public.vendor_invoices
  SET
    amount_paid    = LEAST(amount_paid + p_amount, total),
    payment_status = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN 'paid'
      WHEN LEAST(amount_paid + p_amount, total) > 0     THEN 'partial'
      ELSE 'unpaid'
      END,
    paid_at = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN NOW()
      ELSE paid_at
      END,
    updated_at = NOW()
  WHERE id = p_invoice_id;

  RETURN v_app;
END;
$fn$;

-- ═══ 3. The reporting views carry currency and base amounts ══════════════════
--
-- Both are rebuilt, so both must come back WITH (security_invoker = true).
-- Without it a view runs as its owner and reads rows the caller cannot — the
-- root-cause RLS leak this project already had once (20260778). The guard at
-- the end refuses the migration if either loses it.

DROP VIEW IF EXISTS public.v_purchase_documents;
DROP VIEW IF EXISTS public.v_vendor_ledger;

CREATE VIEW public.v_purchase_documents WITH (security_invoker = true) AS
 SELECT purchase_orders.id,
    'purchase_order'::text AS doc_type,
    purchase_orders.po_code AS doc_code,
    purchase_orders.vendor_id,
    purchase_orders.created_by,
    purchase_orders.status AS doc_status,
    NULL::text AS payment_status,
    purchase_orders.total,
    -- The document's own currency, and the same figure in base currency.
    -- Screens show `total` with `currency`; anything that ADDS documents
    -- together must use total_base, because adding `total` across currencies
    -- produces a number that means nothing.
    purchase_orders.currency,
    purchase_orders.exchange_rate,
    purchase_orders.total_base,
    purchase_orders.created_at,
    purchase_orders.updated_at,
    purchase_orders.expected_delivery_date AS type_specific_date,
    'expected_delivery_date'::text AS type_specific_date_label,
    purchase_orders.archived,
    purchase_orders.archived_at
   FROM purchase_orders
UNION ALL
 SELECT vendor_invoices.id,
    'vendor_invoice'::text AS doc_type,
    vendor_invoices.vi_code AS doc_code,
    vendor_invoices.vendor_id,
    vendor_invoices.created_by,
    vendor_invoices.status AS doc_status,
    vendor_invoices.payment_status,
    vendor_invoices.total,
    vendor_invoices.currency,
    vendor_invoices.exchange_rate,
    vendor_invoices.total_base,
    vendor_invoices.created_at,
    NULL::timestamp with time zone AS updated_at,
    vendor_invoices.due_date AS type_specific_date,
    'due_date'::text AS type_specific_date_label,
    vendor_invoices.archived,
    vendor_invoices.archived_at
   FROM vendor_invoices;

CREATE VIEW public.v_vendor_ledger WITH (security_invoker = true) AS
 SELECT vendor_invoices.id,
    'vendor_invoice'::text AS entry_type,
    vendor_invoices.vi_code AS entry_code,
    vendor_invoices.vendor_id,
    vendor_invoices.total AS amount,
    vendor_invoices.currency,
    vendor_invoices.total_base AS amount_base,
    vendor_invoices.status,
    vendor_invoices.due_date,
    COALESCE(vendor_invoices.approved_at, vendor_invoices.created_at) AS entry_date,
    vendor_invoices.created_at
   FROM vendor_invoices
  WHERE vendor_invoices.status = ANY (ARRAY['approved'::text, 'partially_received'::text, 'received'::text])
UNION ALL
 SELECT vendor_payments.id,
    'vendor_payment'::text AS entry_type,
    vendor_payments.payment_code AS entry_code,
    vendor_payments.vendor_id,
    - vendor_payments.amount AS amount,
    vendor_payments.currency,
    - vendor_payments.amount_base AS amount_base,
    vendor_payments.status,
    NULL::date AS due_date,
    COALESCE(vendor_payments.payment_date::timestamp with time zone, vendor_payments.created_at) AS entry_date,
    vendor_payments.created_at
   FROM vendor_payments
  WHERE vendor_payments.status = 'active'::text;

-- The grants the dropped views had. Without these every purchasing list gets a
-- permission error, which looks like an outage rather than a missing GRANT.
GRANT SELECT ON public.v_purchase_documents TO authenticated, service_role;
GRANT SELECT ON public.v_vendor_ledger      TO authenticated, service_role;

-- ═══ Guards ══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_missing text;
  v_broken  text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_missing
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('v_purchase_documents', 'v_vendor_ledger')
     AND COALESCE(array_to_string(c.reloptions, ','), '') NOT LIKE '%security_invoker=true%';

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to apply: % came back without security_invoker, which would let them bypass RLS. Nothing has been changed.',
      v_missing;
  END IF;

  -- record_vendor_payment was dropped and recreated with two extra parameters.
  -- If it came back without EXECUTE for authenticated, every vendor payment in
  -- the application fails on the next deploy.
  SELECT string_agg(p.proname, ', ') INTO v_broken
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('record_vendor_payment', 'apply_vendor_payment_to_invoice')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_broken IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to apply: authenticated cannot execute %. Vendor payments would fail for every user.',
      v_broken;
  END IF;

  RAISE NOTICE 'Vendor payment currency applied; both purchasing views rebuilt with security_invoker intact.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260828_verify_vendor_payment_currency.sql.
