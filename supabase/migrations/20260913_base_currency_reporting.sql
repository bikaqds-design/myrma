-- ============================================================================
-- 20260913_base_currency_reporting.sql
-- A-05b part 2 — statements, aging and reports add money in the base currency.
-- ============================================================================
-- 20260912 put a currency and a rate on every sales document, but everything
-- that ADDS sales documents together still added their own-currency amounts:
-- a 1,000 USD invoice and a 1,000 EGP invoice made "2,000" on a customer's
-- statement, in the receivables aging, in the financial and sales reports and
-- in the month-end checklist, and the profitability report set a USD invoice's
-- total against a cost of goods in EGP. Supplier aging and the supplier
-- statement already converted (20260861 / amount_base). This converts the rest
-- the way the ledger does: round(amount × the document's own rate, 2).
--
--   * v_customer_ledger (the Billing tab statement) gains currency,
--     exchange_rate and amount_base, and a row per realised exchange
--     difference (entry_type 'exchange_difference', from each payment / credit
--     note application at a rate other than the invoice's — what
--     rma_gl_post_ar_fx posts to receivables). Summed in the base currency the
--     statement now equals the customer's receivable in the ledger: a USD
--     invoice at 51 paid at 53 nets to 0, not to −228.
--   * v_vendor_ledger gains the same exchange-difference rows
--     (rma_gl_post_ap_fx); its amounts were already in base.
--   * rma_ar_aging: each open invoice's remaining balance at its own rate, as
--     rma_ap_aging already does.
--   * rma_report_financial and rma_report_sales: every sum in base.
--   * v_report_invoices gains currency, exchange_rate, total_base and
--     amount_paid_base (the Reports invoice table shows the document's own
--     amounts with its currency).
--   * v_invoice_margin: revenue_base is the invoice's NET amount (total − tax)
--     at its rate. It was the gross total in the invoice's currency, so a
--     foreign invoice's margin mixed currencies and every invoice's margin
--     counted the VAT collected as profit. v_sales_rep_performance and
--     rma_margin_totals read this view and follow it.
--   * rma_period_close_checklist: its five money sums in base (rewritten in the
--     live definition, each anchor counted — 20260890's pattern).
--
-- Deal values (deals.value, the pipeline and the dashboard) are not converted:
-- a deal has no currency of its own yet. Pinned by
-- src/test/baseCurrencyReporting.test.js; supabase/tests/
-- base_currency_reporting.sql is the rolled-back reference script.
-- ============================================================================

-- ── 1. the customer statement ────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_customer_ledger WITH (security_invoker = true) AS
 SELECT crm_invoices.id,
    'invoice'::text AS entry_type,
    crm_invoices.inv_code AS entry_code,
    crm_invoices.customer_id,
    crm_invoices.total AS amount,
    crm_invoices.doc_status AS status,
    crm_invoices.due_date,
    COALESCE(crm_invoices.posted_at, crm_invoices.created_at) AS entry_date,
    crm_invoices.created_at,
    crm_invoices.currency,
    crm_invoices.exchange_rate,
    round(crm_invoices.total * COALESCE(crm_invoices.exchange_rate, 1), 2) AS amount_base
   FROM public.crm_invoices
  WHERE crm_invoices.doc_status = 'posted'::text
UNION ALL
 SELECT credit_notes.id,
    'credit_note'::text,
    credit_notes.cn_code,
    credit_notes.customer_id,
    - credit_notes.total,
    credit_notes.status,
    NULL::date,
    COALESCE(credit_notes.issued_at, credit_notes.created_at),
    credit_notes.created_at,
    credit_notes.currency,
    credit_notes.exchange_rate,
    - round(credit_notes.total * COALESCE(credit_notes.exchange_rate, 1), 2)
   FROM public.credit_notes
  WHERE credit_notes.status = ANY (ARRAY['issued'::text, 'applied'::text])
UNION ALL
 SELECT payments.id,
    'payment'::text,
    payments.payment_code,
    payments.customer_id,
    - payments.amount,
    payments.status,
    NULL::date,
    COALESCE(payments.payment_date::timestamp with time zone, payments.created_at),
    payments.created_at,
    payments.currency,
    payments.exchange_rate,
    - round(payments.amount * COALESCE(payments.exchange_rate, 1), 2)
   FROM public.payments
  WHERE payments.status = 'active'::text
UNION ALL
 SELECT customer_refunds.id,
    'refund'::text,
    customer_refunds.refund_code,
    customer_refunds.customer_id,
    customer_refunds.amount,
    customer_refunds.status,
    NULL::date,
    COALESCE(customer_refunds.refund_date::timestamp with time zone, customer_refunds.approved_at),
    customer_refunds.created_at,
    customer_refunds.currency,
    customer_refunds.exchange_rate,
    round(customer_refunds.amount * COALESCE(customer_refunds.exchange_rate, 1), 2)
   FROM public.customer_refunds
  WHERE customer_refunds.status = 'approved'::text
UNION ALL
 -- settled at a rate other than the invoice's: what rma_gl_post_ar_fx moved in
 -- receivables (a reversal row is negative and reverses its difference)
 SELECT fx.id,
    'exchange_difference'::text,
    fx.inv_code,
    fx.customer_id,
    0::numeric,
    'posted'::text,
    NULL::date,
    fx.applied_date,
    fx.applied_date,
    fx.currency,
    NULL::numeric,
    fx.diff
   FROM ( SELECT pa.id, i.inv_code, i.customer_id, i.currency, pa.applied_date,
            round(pa.amount_applied * COALESCE(p.exchange_rate, 1), 2)
              - round(pa.amount_applied * COALESCE(i.exchange_rate, 1), 2) AS diff
           FROM public.payment_applications pa
             JOIN public.payments p ON p.id = pa.payment_id
             JOIN public.crm_invoices i ON i.id = pa.invoice_id
         UNION ALL
         SELECT ca.id, i.inv_code, i.customer_id, i.currency, ca.applied_date,
            round(ca.amount_applied * COALESCE(cn.exchange_rate, 1), 2)
              - round(ca.amount_applied * COALESCE(i.exchange_rate, 1), 2)
           FROM public.credit_note_applications ca
             JOIN public.credit_notes cn ON cn.id = ca.credit_note_id
             JOIN public.crm_invoices i ON i.id = ca.invoice_id) fx
  WHERE fx.diff <> 0;

-- ── 2. the supplier statement: its exchange differences ──────────────────────
CREATE OR REPLACE VIEW public.v_vendor_ledger WITH (security_invoker = true) AS
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
   FROM public.vendor_invoices
  WHERE vendor_invoices.status = ANY (ARRAY['approved'::text, 'partially_received'::text, 'received'::text])
UNION ALL
 SELECT vendor_payments.id,
    'vendor_payment'::text,
    vendor_payments.payment_code,
    vendor_payments.vendor_id,
    - vendor_payments.amount,
    vendor_payments.currency,
    - vendor_payments.amount_base,
    vendor_payments.status,
    NULL::date,
    COALESCE(vendor_payments.payment_date::timestamp with time zone, vendor_payments.created_at),
    vendor_payments.created_at
   FROM public.vendor_payments
  WHERE vendor_payments.status = 'active'::text
UNION ALL
 -- paid at a rate other than the bill's: what rma_gl_post_ap_fx moved in payables
 SELECT fx.id,
    'exchange_difference'::text,
    fx.code,
    fx.vendor_id,
    0::numeric,
    fx.currency,
    fx.diff,
    'posted'::text,
    NULL::date,
    fx.applied_date,
    fx.applied_date
   FROM ( SELECT va.id, COALESCE(vi.vi_code, vi.supplier_invoice_no) AS code, vi.vendor_id, vi.currency, va.applied_date,
            round(va.amount_applied * COALESCE(vp.exchange_rate, 1), 2)
              - round(va.amount_applied * COALESCE(vi.exchange_rate, 1), 2) AS diff
           FROM public.vendor_payment_applications va
             JOIN public.vendor_payments vp ON vp.id = va.payment_id
             JOIN public.vendor_invoices vi ON vi.id = va.invoice_id) fx
  WHERE fx.diff <> 0;

-- ── 3. receivables aging in base (as rma_ap_aging) ───────────────────────────
CREATE OR REPLACE FUNCTION public.rma_ar_aging(p_today date)
 RETURNS TABLE(customer_id uuid, customer_name text, not_due numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric, no_due_date numeric, total numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH open_invoices AS (
    SELECT i.customer_id,
           public.rma_aging_bucket(i.due_date, p_today) AS bucket,
           round(coalesce(i.total, 0) - coalesce(i.amount_paid, 0), 2) AS remaining,
           coalesce(nullif(i.exchange_rate, 0), 1) AS rate
      FROM public.crm_invoices i
     WHERE i.doc_status = 'posted'
  ),
  based AS (
    -- open in the invoice's currency, then valued at the rate it was booked at
    SELECT customer_id, bucket, round(remaining * rate, 2) AS remaining_base
      FROM open_invoices
     WHERE remaining > 0.001
  )
  SELECT o.customer_id,
         coalesce(nullif(c.company_name, ''), nullif(c.contact_person, '')),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'not_due'), 0),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'd1_30'), 0),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'd31_60'), 0),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'd61_90'), 0),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'd90_plus'), 0),
         coalesce(sum(o.remaining_base) FILTER (WHERE o.bucket = 'no_due_date'), 0),
         sum(o.remaining_base)
    FROM based o
    LEFT JOIN public.customers c ON c.id = o.customer_id
   GROUP BY o.customer_id, c.company_name, c.contact_person;
$function$;

-- ── 4. the financial and sales reports in base ───────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_report_financial(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- A draft is not revenue and a cancelled (voided) invoice is reversed. Only a
  -- posted invoice counts, and it counts in the period it was posted, not the
  -- one in which someone first typed it up. Every amount at the document's own
  -- rate, in the base currency (20260913).
  WITH inv AS (
    SELECT coalesce(total, 0) AS total, coalesce(amount_paid, 0) AS paid,
           coalesce(nullif(exchange_rate, 0), 1) AS rate
      FROM public.crm_invoices
     WHERE doc_status = 'posted'
       AND posted_at IS NOT NULL AND posted_at >= p_from AND posted_at <= p_to
  )
  SELECT jsonb_build_object(
    'invoices', (SELECT count(*) FROM inv),
    'total_invoiced', (SELECT coalesce(sum(round(total * rate, 2)), 0) FROM inv),
    'total_paid', (SELECT coalesce(sum(round(paid * rate, 2)), 0) FROM inv),
    'outstanding', (SELECT coalesce(sum(round(greatest(total - paid, 0) * rate, 2)), 0) FROM inv),
    'quotes_value', (SELECT coalesce(sum(round(coalesce(total, 0) * coalesce(nullif(exchange_rate, 0), 1), 2)), 0)
                       FROM public.quotations
                      WHERE created_at IS NOT NULL AND created_at >= p_from AND created_at <= p_to
                        AND status IS DISTINCT FROM 'cancelled' AND status IS DISTINCT FROM 'declined'
                        AND status IS DISTINCT FROM 'expired'),
    'currency', public.rma_base_currency()
  );
$function$;

CREATE OR REPLACE FUNCTION public.rma_report_sales(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- every value in the base currency, each document at its own rate (20260913)
  WITH qt AS (
    SELECT q.*, round(coalesce(q.total, 0) * coalesce(nullif(q.exchange_rate, 0), 1), 2) AS total_base
      FROM public.quotations q WHERE q.created_at IS NOT NULL AND q.created_at >= p_from AND q.created_at <= p_to
  ),
  so_r AS (
    SELECT * FROM public.sales_orders
     WHERE created_at IS NOT NULL AND created_at >= p_from AND created_at <= p_to AND status IS DISTINCT FROM 'cancelled'
  ),
  inv_r AS (
    SELECT i.*, round(coalesce(i.total, 0) * coalesce(nullif(i.exchange_rate, 0), 1), 2) AS total_base
      FROM public.crm_invoices i
     WHERE i.created_at IS NOT NULL AND i.created_at >= p_from AND i.created_at <= p_to AND i.doc_status IS DISTINCT FROM 'cancelled'
  ),
  pay_r AS (
    SELECT round(coalesce(p.amount, 0) * coalesce(nullif(p.exchange_rate, 0), 1), 2) AS amount_base FROM public.payments p
     WHERE coalesce(p.payment_date::timestamp AT TIME ZONE 'UTC', p.created_at) >= p_from
       AND coalesce(p.payment_date::timestamp AT TIME ZONE 'UTC', p.created_at) <= p_to
       AND p.status IS DISTINCT FROM 'voided'
  ),
  ofq AS (
    SELECT o.id, round(coalesce(o.total, 0) * coalesce(nullif(o.exchange_rate, 0), 1), 2) AS total_base
      FROM public.sales_orders o
     WHERE o.status IS DISTINCT FROM 'cancelled' AND o.quotation_id IN (SELECT id FROM qt)
  ),
  ifq AS (
    SELECT round(coalesce(i.total, 0) * coalesce(nullif(i.exchange_rate, 0), 1), 2) AS total_base
      FROM public.crm_invoices i
     WHERE i.doc_status IS DISTINCT FROM 'cancelled' AND i.so_id IN (SELECT id FROM ofq)
  )
  SELECT jsonb_build_object(
    'quotations', (SELECT jsonb_build_object(
        'count', count(*),
        'value', coalesce(sum(total_base), 0),
        'won', count(*) FILTER (WHERE status IN ('converted', 'accepted')),
        'lost', count(*) FILTER (WHERE status IN ('declined', 'expired'))) FROM qt),
    'invoiced', (SELECT jsonb_build_object('count', count(*), 'value', coalesce(sum(total_base), 0)) FROM inv_r),
    'collected', (SELECT jsonb_build_object('count', count(*), 'value', coalesce(sum(amount_base), 0)) FROM pay_r),
    'funnel_orders', (SELECT jsonb_build_object('count', count(*), 'value', coalesce(sum(total_base), 0)) FROM ofq),
    'funnel_invoices', (SELECT jsonb_build_object('count', count(*), 'value', coalesce(sum(total_base), 0)) FROM ifq),
    'standalone_orders', (SELECT count(*) FROM so_r WHERE quotation_id IS NULL OR quotation_id NOT IN (SELECT id FROM qt)),
    'standalone_invoices', (SELECT count(*) FROM inv_r WHERE so_id IS NULL OR so_id NOT IN (SELECT id FROM ofq)),
    'by_rep', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'rep', rep, 'raised', raised, 'won', won, 'lost', lost, 'value', v, 'won_value', wv) ORDER BY wv DESC, newest DESC NULLS LAST)
      FROM (SELECT nullif(assigned_rep, '') AS rep, count(*) AS raised,
                   count(*) FILTER (WHERE status IN ('converted', 'accepted')) AS won,
                   count(*) FILTER (WHERE status IN ('declined', 'expired')) AS lost,
                   coalesce(sum(total_base), 0) AS v,
                   coalesce(sum(total_base) FILTER (WHERE status IN ('converted', 'accepted')), 0) AS wv,
                   max(created_at) AS newest
              FROM qt GROUP BY 1) r), '[]'::jsonb),
    'currency', public.rma_base_currency()
  );
$function$;

-- ── 5. the Reports invoice table ─────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_report_invoices WITH (security_invoker = true) AS
 SELECT i.id,
    i.inv_code,
    i.customer_id,
    i.doc_status,
    i.payment_status,
    i.total,
    i.amount_paid,
    i.due_date,
    i.created_at,
    COALESCE(NULLIF(c.company_name, ''::text), NULLIF(c.contact_person, ''::text)) AS customer_name,
    i.currency,
    i.exchange_rate,
    round(COALESCE(i.total, 0) * COALESCE(i.exchange_rate, 1), 2) AS total_base,
    round(COALESCE(i.amount_paid, 0) * COALESCE(i.exchange_rate, 1), 2) AS amount_paid_base
   FROM public.crm_invoices i
     LEFT JOIN public.customers c ON c.id = i.customer_id;

-- ── 6. margin: net revenue, in base ──────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_invoice_margin WITH (security_invoker = true) AS
 SELECT m.id,
    m.inv_code,
    m.customer_id,
    m.customer_name,
    m.assigned_rep,
    m.posted_at,
    m.doc_status,
    m.payment_status,
    m.revenue_base,
    m.cogs_base,
    m.cogs_unknown_qty,
    m.cogs_complete,
        CASE
            WHEN m.cogs_complete THEN round(m.revenue_base - m.cogs_base, 2)
            ELSE NULL::numeric
        END AS margin_base,
        CASE
            WHEN m.cogs_complete AND m.revenue_base > 0::numeric THEN round(100.0 * (m.revenue_base - m.cogs_base) / m.revenue_base, 2)
            ELSE NULL::numeric
        END AS margin_pct,
    m.currency,
    m.exchange_rate
   FROM ( SELECT i.id, i.inv_code, i.customer_id,
            COALESCE(NULLIF(btrim(c.company_name), ''::text), c.contact_person) AS customer_name,
            i.assigned_rep, i.posted_at, i.doc_status, i.payment_status,
            -- what the ledger credits to sales: the total less its tax, at the invoice's rate
            round((COALESCE(i.total, 0) - COALESCE(i.tax_amount, 0)) * COALESCE(i.exchange_rate, 1), 2)::numeric(12,2) AS revenue_base,
            i.cogs_base, i.cogs_unknown_qty, i.cogs_complete, i.currency, i.exchange_rate
           FROM public.crm_invoices i
             LEFT JOIN public.customers c ON c.id = i.customer_id
          WHERE i.doc_status = 'posted'::text) m;

-- ── 7. the month-end checklist's money in base ───────────────────────────────
DO $$
DECLARE
  v_def  text;
  v_from text[] := ARRAY[
    E'''draft_sales_invoices''::text, count(*), COALESCE(sum(total), 0)::numeric',
    E'''unissued_credit_notes''::text, count(*), COALESCE(sum(total), 0)::numeric',
    E'''unapproved_supplier_invoices''::text, count(*), COALESCE(sum(total), 0)::numeric',
    E'''pending_supplier_payments''::text, count(*), COALESCE(sum(vp.amount), 0)::numeric',
    E'''pending_refunds''::text, count(*), COALESCE(sum(r.amount), 0)::numeric'];
  v_to   text[] := ARRAY[
    E'''draft_sales_invoices''::text, count(*), COALESCE(sum(round(total * COALESCE(exchange_rate, 1), 2)), 0)::numeric',
    E'''unissued_credit_notes''::text, count(*), COALESCE(sum(round(total * COALESCE(exchange_rate, 1), 2)), 0)::numeric',
    E'''unapproved_supplier_invoices''::text, count(*), COALESCE(sum(total_base), 0)::numeric',
    E'''pending_supplier_payments''::text, count(*), COALESCE(sum(vp.amount_base), 0)::numeric',
    E'''pending_refunds''::text, count(*), COALESCE(sum(round(r.amount * COALESCE(r.exchange_rate, 1), 2)), 0)::numeric'];
  i int;
BEGIN
  v_def := replace(pg_get_functiondef('public.rma_period_close_checklist(date)'::regprocedure), E'\r\n', E'\n');
  FOR i IN 1 .. array_length(v_from, 1) LOOP
    IF (length(v_def) - length(replace(v_def, v_from[i], ''))) / length(v_from[i]) <> 1 THEN
      RAISE EXCEPTION 'Refusing to apply: rma_period_close_checklist does not read as expected at %', v_from[i];
    END IF;
    v_def := replace(v_def, v_from[i], v_to[i]);
  END LOOP;
  EXECUTE v_def;
END $$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.rma_period_close_checklist(date)'::regprocedure);
BEGIN
  IF v_def ~ 'sum\((total|vp\.amount|r\.amount)\)' THEN
    RAISE EXCEPTION 'Refusing to finish: the close checklist still adds document-currency amounts';
  END IF;
  IF pg_get_viewdef('public.v_customer_ledger'::regclass) !~ 'amount_base'
     OR pg_get_viewdef('public.v_customer_ledger'::regclass) !~ 'exchange_difference'
     OR pg_get_functiondef('public.rma_ar_aging(date)'::regprocedure) !~ 'remaining_base' THEN
    RAISE EXCEPTION 'Refusing to finish: the statement or the aging is not in base';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('public.v_customer_ledger'::regclass, 'public.v_vendor_ledger'::regclass,
               'public.v_report_invoices'::regclass, 'public.v_invoice_margin'::regclass)
              AND NOT COALESCE(reloptions, '{}') @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'Refusing to finish: a replaced view lost security_invoker';
  END IF;
END $$;
