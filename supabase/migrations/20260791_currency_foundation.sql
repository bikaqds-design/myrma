-- Currency foundation: a currency list, a base currency, and honest precision.
--
-- Stage 1 of CURRENCY_COSTING_PLAN.md. Deliberately behaviour-free: nothing
-- converts anything yet. What it fixes is that the system currently holds three
-- disagreeing opinions about what currency its money is in —
--
--   Dashboard, Reports, Control Panel home   '$'
--   every PDF                                'EGP'
--   the RMA resolution form                  'USD'
--
-- — and two money columns out of every three have no decimal scale.
--
-- ── The scale problem ────────────────────────────────────────────────────────
--
-- The sales chain uses numeric(12,2). Purchasing uses bare `numeric`, which in
-- Postgres means arbitrary precision, not "some sensible default". So
-- purchase_orders.total and vendor_invoices.total can hold 1234.5678 and no
-- rounding anywhere will ever clean it up — it just prints differently
-- depending on which formatter reaches it first.
--
-- Narrowing the type rounds existing values to 2dp. That is the correct
-- outcome, but it is a data change, so the DO block below reports how many rows
-- actually move before it happens rather than doing it silently.

-- ═══ 1. The currency list ════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.currencies (
  code       char(3)     PRIMARY KEY,          -- ISO 4217
  name       text        NOT NULL,
  symbol     text        NOT NULL,
  -- Minor-unit digits. 2 for almost everything, 0 for JPY and KWD-style
  -- currencies with 3. Stored rather than assumed so formatting is driven by
  -- data instead of a hardcoded 2.
  decimals   smallint    NOT NULL DEFAULT 2 CHECK (decimals BETWEEN 0 AND 4),
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.currencies IS
  'ISO 4217 currencies this installation can transact in. A table rather than a config list so documents can reference a real row and formatting can read decimals from data.';

INSERT INTO public.currencies (code, name, symbol, decimals) VALUES
  ('EGP', 'Egyptian Pound',      'E£',  2),
  ('USD', 'US Dollar',           '$',   2),
  ('EUR', 'Euro',                '€',   2),
  ('GBP', 'Pound Sterling',      '£',   2),
  ('AED', 'UAE Dirham',          'د.إ', 2),
  ('SAR', 'Saudi Riyal',         'ر.س', 2),
  ('CNY', 'Chinese Yuan',        '¥',   2),
  ('JPY', 'Japanese Yen',        '¥',   0),
  ('TRY', 'Turkish Lira',        '₺',   2)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.currencies ENABLE ROW LEVEL SECURITY;

-- Every staff member needs to read these to render any money value.
DROP POLICY IF EXISTS currencies_staff_read ON public.currencies;
CREATE POLICY currencies_staff_read ON public.currencies
  FOR SELECT TO authenticated USING (public.rma_is_staff());

DROP POLICY IF EXISTS currencies_admin_write ON public.currencies;
CREATE POLICY currencies_admin_write ON public.currencies
  FOR ALL TO authenticated
  USING (public.rma_is_admin()) WITH CHECK (public.rma_is_admin());

REVOKE ALL ON public.currencies FROM PUBLIC, anon;
GRANT SELECT ON public.currencies TO authenticated;
GRANT ALL    ON public.currencies TO service_role, postgres;

-- ═══ 2. The base currency ════════════════════════════════════════════════════
-- Lives in rma_config alongside the other installation settings.

INSERT INTO public.rma_config (config_key, config_value, updated_by)
VALUES ('default_currency', '"EGP"'::jsonb, 'migration/20260791')
ON CONFLICT (config_key) DO NOTHING;

/**
 * Refuse to change the base currency once anything has been transacted.
 *
 * Configurable at setup is right. Configurable afterwards is a trap: every
 * stored base-currency amount was converted at a rate relative to the old base,
 * and nothing records which. Switching would leave a table of numbers whose
 * meaning silently changed, with no way to tell corrected rows from stale ones.
 */
CREATE OR REPLACE FUNCTION public.rma_guard_base_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_docs integer;
BEGIN
  IF NEW.config_key <> 'default_currency' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.config_value IS NOT DISTINCT FROM OLD.config_value THEN
    RETURN NEW;   -- a no-op save from the settings form
  END IF;

  SELECT
      (SELECT count(*) FROM public.crm_invoices)
    + (SELECT count(*) FROM public.quotations)
    + (SELECT count(*) FROM public.sales_orders)
    + (SELECT count(*) FROM public.purchase_orders)
    + (SELECT count(*) FROM public.vendor_invoices)
    + (SELECT count(*) FROM public.payments)
    + (SELECT count(*) FROM public.vendor_payments)
    INTO v_docs;

  IF v_docs > 0 THEN
    RAISE EXCEPTION
      'The base currency cannot be changed: % transaction document(s) already exist and their stored amounts were recorded against the current base. Changing it would silently reinterpret every one of them.',
      v_docs
      USING ERRCODE = 'P0001';
  END IF;

  -- Must be a currency this installation actually knows about.
  IF NOT EXISTS (
    SELECT 1 FROM public.currencies
     WHERE code = btrim(NEW.config_value #>> '{}') AND is_active
  ) THEN
    RAISE EXCEPTION 'Unknown or inactive currency: %', NEW.config_value #>> '{}'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_guard_base_currency ON public.rma_config;
CREATE TRIGGER trg_guard_base_currency
  BEFORE INSERT OR UPDATE ON public.rma_config
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_base_currency();

-- ═══ 3. Give the purchasing money columns their missing scale ════════════════

DO $do$
DECLARE
  v_affected integer;
BEGIN
  SELECT
      (SELECT count(*) FROM public.purchase_orders
        WHERE total <> round(total, 2) OR subtotal <> round(subtotal, 2)
           OR discount_amount <> round(discount_amount, 2)
           OR tax_amount <> round(tax_amount, 2))
    + (SELECT count(*) FROM public.vendor_invoices
        WHERE total <> round(total, 2) OR subtotal <> round(subtotal, 2)
           OR discount_amount <> round(discount_amount, 2)
           OR tax_amount <> round(tax_amount, 2))
    INTO v_affected;

  IF v_affected > 0 THEN
    RAISE NOTICE 'Rounding % row(s) whose purchasing totals carried more than 2 decimal places.', v_affected;
  ELSE
    RAISE NOTICE 'No purchasing totals needed rounding; the type change is cosmetic.';
  END IF;
END
$do$;

-- Postgres refuses to retype a column a view selects, and two views select
-- `total`: v_purchase_documents (from both tables) and v_vendor_ledger (from
-- vendor_invoices). They have to be dropped and rebuilt around the change.
--
-- Both carry `security_invoker = true`, added by 20260778 because a view
-- WITHOUT it runs as its owner and bypasses RLS entirely — that was the
-- root-cause RLS leak in this project. Recreating them without that option
-- would silently reopen it, so the definitions below reproduce it verbatim and
-- the guard at the end refuses the migration if either comes back missing it.

DROP VIEW IF EXISTS public.v_purchase_documents;
DROP VIEW IF EXISTS public.v_vendor_ledger;

ALTER TABLE public.purchase_orders
  ALTER COLUMN total           TYPE numeric(12,2),
  ALTER COLUMN subtotal        TYPE numeric(12,2),
  ALTER COLUMN discount_amount TYPE numeric(12,2),
  ALTER COLUMN tax_amount      TYPE numeric(12,2);

ALTER TABLE public.vendor_invoices
  ALTER COLUMN total           TYPE numeric(12,2),
  ALTER COLUMN subtotal        TYPE numeric(12,2),
  ALTER COLUMN discount_amount TYPE numeric(12,2),
  ALTER COLUMN tax_amount      TYPE numeric(12,2);

CREATE VIEW public.v_purchase_documents WITH (security_invoker = true) AS
 SELECT purchase_orders.id,
    'purchase_order'::text AS doc_type,
    purchase_orders.po_code AS doc_code,
    purchase_orders.vendor_id,
    purchase_orders.created_by,
    purchase_orders.status AS doc_status,
    NULL::text AS payment_status,
    purchase_orders.total,
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
    vendor_payments.status,
    NULL::date AS due_date,
    COALESCE(vendor_payments.payment_date::timestamp with time zone, vendor_payments.created_at) AS entry_date,
    vendor_payments.created_at
   FROM vendor_payments
  WHERE vendor_payments.status = 'active'::text;

-- The grants the dropped views had. Without these the app gets a permission
-- error on every purchasing list, which looks like an outage rather than a
-- missing GRANT.
GRANT SELECT ON public.v_purchase_documents TO authenticated, service_role;
GRANT SELECT ON public.v_vendor_ledger      TO authenticated, service_role;

-- Refuse the whole migration if either view came back without security_invoker.
DO $do$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_missing
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('v_purchase_documents', 'v_vendor_ledger')
     AND COALESCE(array_to_string(c.reloptions, ','), '') NOT LIKE '%security_invoker=true%';

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to apply: % came back without security_invoker, which would let them bypass RLS and read rows the caller cannot. Nothing has been changed.',
      v_missing;
  END IF;

  RAISE NOTICE 'Both purchasing views rebuilt with security_invoker intact.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260826_verify_currency_foundation.sql.
