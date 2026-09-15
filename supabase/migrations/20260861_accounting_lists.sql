-- 20260861_accounting_lists.sql
--
-- Server-side reads for the Accounting page. (Audit finding BUG-066, phase 5d.)
--
-- The page loaded every payment and every vendor payment (and every brand and
-- the payments' customers, to name the rows) and searched and listed them in
-- the browser; its two aging reports loaded every posted invoice and every
-- vendor invoice and bucketed and summed them there. The Data API returns at
-- most 1 000 rows per request, so past that the lists and — worse — the
-- receivable and payable totals covered part of the books as if they were all.
--
--   v_payments_list          payments + the customer name shown
--   v_vendor_payments_list   vendor payments + the vendor (brand) name shown
--   rma_ar_aging(today)      open receivables per customer, by aging bucket
--   rma_ap_aging(today)      open payables per vendor, by aging bucket, in the
--                            base currency
--
-- The aging buckets are src/lib/aging.js's, counted in calendar days from the
-- viewer's own today (p_today): not_due (due today or later), d1_30, d31_60,
-- d61_90, d90_plus, and no_due_date. An invoice's balance is its total less
-- what has been paid, rounded to the cent; nothing under a tenth of a cent is
-- open.
--
-- SECURITY INVOKER: the caller's RLS on payments, vendor payments, invoices,
-- vendor invoices, customers and brands applies as it did to the browser's
-- reads. Read-only; authenticated only.

-- ═══ Payment lists ═══════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_payments_list
WITH (security_invoker = true)
AS
SELECT p.*,
       coalesce(nullif(c.company_name, ''), nullif(c.contact_person, '')) AS customer_name
  FROM public.payments p
  LEFT JOIN public.customers c ON c.id = p.customer_id;

CREATE OR REPLACE VIEW public.v_vendor_payments_list
WITH (security_invoker = true)
AS
SELECT vp.*,
       nullif(b.brand_name, '') AS vendor_name
  FROM public.vendor_payments vp
  LEFT JOIN public.brands b ON b.id = vp.vendor_id;

COMMENT ON VIEW public.v_payments_list IS 'Payments with the customer name the Accounting page shows. (BUG-066.)';
COMMENT ON VIEW public.v_vendor_payments_list IS 'Vendor payments with the vendor name the Accounting page shows. (BUG-066.)';

-- ═══ The bucket of a due date ════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_aging_bucket(p_due date, p_today date)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT CASE
           WHEN p_due IS NULL THEN 'no_due_date'
           WHEN p_today - p_due <= 0 THEN 'not_due'
           WHEN p_today - p_due <= 30 THEN 'd1_30'
           WHEN p_today - p_due <= 60 THEN 'd31_60'
           WHEN p_today - p_due <= 90 THEN 'd61_90'
           ELSE 'd90_plus'
         END;
$fn$;

-- ═══ Receivables aging ═══════════════════════════════════════════════════════
-- Posted invoices with a balance, per customer.

CREATE OR REPLACE FUNCTION public.rma_ar_aging(p_today date)
RETURNS TABLE (
  customer_id uuid,
  customer_name text,
  not_due numeric,
  d1_30 numeric,
  d31_60 numeric,
  d61_90 numeric,
  d90_plus numeric,
  no_due_date numeric,
  total numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH open_invoices AS (
    SELECT i.customer_id,
           public.rma_aging_bucket(i.due_date, p_today) AS bucket,
           round(coalesce(i.total, 0) - coalesce(i.amount_paid, 0), 2) AS remaining
      FROM public.crm_invoices i
     WHERE i.doc_status = 'posted'
  )
  SELECT o.customer_id,
         coalesce(nullif(c.company_name, ''), nullif(c.contact_person, '')),
         coalesce(sum(o.remaining) FILTER (WHERE o.bucket = 'not_due'), 0),
         coalesce(sum(o.remaining) FILTER (WHERE o.bucket = 'd1_30'), 0),
         coalesce(sum(o.remaining) FILTER (WHERE o.bucket = 'd31_60'), 0),
         coalesce(sum(o.remaining) FILTER (WHERE o.bucket = 'd61_90'), 0),
         coalesce(sum(o.remaining) FILTER (WHERE o.bucket = 'd90_plus'), 0),
         coalesce(sum(o.remaining) FILTER (WHERE o.bucket = 'no_due_date'), 0),
         sum(o.remaining)
    FROM open_invoices o
    LEFT JOIN public.customers c ON c.id = o.customer_id
   WHERE o.remaining > 0.001
   GROUP BY o.customer_id, c.company_name, c.contact_person;
$fn$;

-- ═══ Payables aging ══════════════════════════════════════════════════════════
-- Approved-or-later vendor invoices with a balance, per vendor. A vendor
-- invoice carries its own currency, so each balance is converted at the
-- invoice's rate (1 when it has none) before any two are added — adding the
-- raw figures once put a USD balance into an EGP total as if the digits were
-- the same money.

CREATE OR REPLACE FUNCTION public.rma_ap_aging(p_today date)
RETURNS TABLE (
  vendor_id uuid,
  vendor_name text,
  not_due numeric,
  d1_30 numeric,
  d31_60 numeric,
  d61_90 numeric,
  d90_plus numeric,
  no_due_date numeric,
  total numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH open_invoices AS (
    SELECT vi.vendor_id,
           public.rma_aging_bucket(vi.due_date, p_today) AS bucket,
           round(coalesce(vi.total, 0) - coalesce(vi.amount_paid, 0), 2) AS remaining,
           coalesce(nullif(vi.exchange_rate, 0), 1) AS rate
      FROM public.vendor_invoices vi
     WHERE vi.status IN ('approved', 'partially_received', 'received')
  ),
  based AS (
    SELECT vendor_id, bucket, round(remaining * rate, 2) AS remaining_base
      FROM open_invoices
     WHERE remaining > 0.001
  )
  SELECT o.vendor_id,
         nullif(b.brand_name, ''),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'not_due'), 0),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'd1_30'), 0),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'd31_60'), 0),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'd61_90'), 0),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'd90_plus'), 0),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'no_due_date'), 0),
         sum(o.remaining_base)
    FROM based o
    LEFT JOIN public.brands b ON b.id = o.vendor_id
   GROUP BY o.vendor_id, b.brand_name;
$fn$;

COMMENT ON FUNCTION public.rma_aging_bucket(date, date) IS 'Aging bucket of a due date on a given day (src/lib/aging.js). (BUG-066.)';
COMMENT ON FUNCTION public.rma_ar_aging(date) IS 'Open receivables per customer by aging bucket. (BUG-066.)';
COMMENT ON FUNCTION public.rma_ap_aging(date) IS 'Open payables per vendor by aging bucket, in base currency. (BUG-066.)';

-- ═══ Grants ══════════════════════════════════════════════════════════════════

REVOKE ALL ON public.v_payments_list, public.v_vendor_payments_list FROM PUBLIC, anon;
GRANT SELECT ON public.v_payments_list, public.v_vendor_payments_list TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.rma_aging_bucket(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_aging_bucket(date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rma_ar_aging(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_ar_aging(date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rma_ap_aging(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_ap_aging(date) TO authenticated, service_role;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- The views keep every row; the reports total exactly the open balances.

DO $guard$
BEGIN
  IF (SELECT count(*) FROM public.v_payments_list) <> (SELECT count(*) FROM public.payments)
     OR (SELECT count(*) FROM public.v_vendor_payments_list) <> (SELECT count(*) FROM public.vendor_payments) THEN
    RAISE EXCEPTION 'Refusing to apply: a payments view does not have one row per payment';
  END IF;
  IF (SELECT coalesce(sum(total), 0) FROM public.rma_ar_aging(current_date))
     <> (SELECT coalesce(sum(r), 0) FROM (SELECT round(coalesce(total, 0) - coalesce(amount_paid, 0), 2) AS r
                                           FROM public.crm_invoices WHERE doc_status = 'posted') x WHERE r > 0.001) THEN
    RAISE EXCEPTION 'Refusing to apply: receivables aging does not total the open posted invoices';
  END IF;
  IF (SELECT coalesce(sum(not_due + d1_30 + d31_60 + d61_90 + d90_plus + no_due_date - total), 0) FROM public.rma_ar_aging(current_date)) <> 0
     OR (SELECT coalesce(sum(not_due + d1_30 + d31_60 + d61_90 + d90_plus + no_due_date - total), 0) FROM public.rma_ap_aging(current_date)) <> 0 THEN
    RAISE EXCEPTION 'Refusing to apply: aging buckets do not add up to their totals';
  END IF;
END
$guard$;
