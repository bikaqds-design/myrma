-- 20260798_margin_reporting.sql
-- Currency engine, stage 5 — profit and loss on what was sold.
--
-- ═══ What this answers ═══════════════════════════════════════════════════════
--
-- The question the whole engine was built for: what did each sale actually
-- make, in total and per sales rep. Stages 1-3 put a cost on the goods, stage 4
-- captured it on the invoice at the moment it shipped. This reads it back.
--
-- ═══ The rule these views obey ═══════════════════════════════════════════════
--
-- AN INVOICE WITH UNKNOWN COST IS NEVER COUNTED AS PROFIT.
--
-- This is the whole reason the earlier stages went to such trouble to keep
-- "unknown" distinct from "zero". An invoice for E£100,000 of goods whose cost
-- was never recorded has a margin of E£100,000 if you let it through, and it is
-- indistinguishable from a genuinely brilliant sale. One such invoice can carry
-- a rep's whole quarter.
--
-- So every aggregate here reports two revenues:
--
--   revenue_base          every posted invoice
--   costed_revenue_base   only invoices whose cost is complete
--
-- and margin is computed against the SECOND. margin_pct therefore means "of the
-- sales we can actually cost, this much was margin", which is a true statement,
-- rather than a number diluted by sales nobody can cost.
--
-- invoices_cost_unknown is carried on every row so the gap is never invisible.
-- A rep whose margin covers three of their twenty invoices should not have that
-- fact buried.
--
-- ═══ security_invoker ════════════════════════════════════════════════════════
--
-- Both views carry it. Without it a view runs as its OWNER and returns rows the
-- caller has no right to see — the root-cause RLS leak this project already had
-- once (20260778). Cost and margin are the most commercially sensitive figures
-- in the system, and a rep must not read another rep's numbers through a view
-- that forgot. The guard at the end refuses the migration if either loses it.
--
-- ═══ Applying ════════════════════════════════════════════════════════════════
-- Paste into the Supabase SQL editor. One transaction.
-- Verify with supabase/manual/20260841_verify_margin.sql.

-- ═══ 1. Margin per invoice ═══════════════════════════════════════════════════

DROP VIEW IF EXISTS public.v_sales_rep_performance;
DROP VIEW IF EXISTS public.v_invoice_margin;

CREATE VIEW public.v_invoice_margin WITH (security_invoker = true) AS
SELECT
  i.id,
  i.inv_code,
  i.customer_id,
  -- customers has no single name column: a B2B customer is its company_name,
  -- a B2C one its contact_person. Same rule quotationPdf.js and salesOrderPdf.js
  -- already use, so the name on a margin report matches the name on the
  -- document it came from.
  COALESCE(NULLIF(btrim(c.company_name), ''), c.contact_person) AS customer_name,
  i.assigned_rep,
  i.posted_at,
  i.doc_status,
  i.payment_status,
  -- Sales documents are always in the base currency (the rule set in
  -- CURRENCY_COSTING_PLAN), so total needs no conversion. cogs_base was
  -- converted once, at receipt, at the rate actually paid.
  i.total                                        AS revenue_base,
  i.cogs_base,
  i.cogs_unknown_qty,
  i.cogs_complete,
  -- NULL, not zero, when the cost is incomplete. A zero margin is a claim that
  -- the sale made nothing; NULL says we cannot tell, and propagates through
  -- every SUM and AVG instead of quietly dragging one toward a wrong answer.
  CASE WHEN i.cogs_complete THEN round(i.total - i.cogs_base, 2) END
                                                 AS margin_base,
  CASE WHEN i.cogs_complete AND i.total > 0
       THEN round(100.0 * (i.total - i.cogs_base) / i.total, 2) END
                                                 AS margin_pct
FROM public.crm_invoices i
LEFT JOIN public.customers c ON c.id = i.customer_id
WHERE i.doc_status = 'posted';

COMMENT ON VIEW public.v_invoice_margin IS
  'Margin on every posted invoice. margin_base is NULL where the cost of goods is incomplete — that is "cannot tell", not "made nothing".';

GRANT SELECT ON public.v_invoice_margin TO authenticated, service_role;

-- ═══ 2. Performance per sales rep ════════════════════════════════════════════

CREATE VIEW public.v_sales_rep_performance WITH (security_invoker = true) AS
SELECT
  COALESCE(m.assigned_rep, '(unassigned)')                       AS assigned_rep,
  count(*)                                                       AS invoices_total,
  count(*) FILTER (WHERE m.cogs_complete)                        AS invoices_costed,
  count(*) FILTER (WHERE NOT m.cogs_complete)                    AS invoices_cost_unknown,
  -- Everything sold, whether or not it can be costed.
  round(COALESCE(SUM(m.revenue_base), 0), 2)                     AS revenue_base,
  -- Only the part margin can honestly be measured against.
  round(COALESCE(SUM(m.revenue_base) FILTER (WHERE m.cogs_complete), 0), 2)
                                                                 AS costed_revenue_base,
  round(COALESCE(SUM(m.cogs_base) FILTER (WHERE m.cogs_complete), 0), 2)
                                                                 AS cogs_base,
  round(COALESCE(SUM(m.margin_base), 0), 2)                      AS margin_base,
  -- Margin over COSTED revenue, never over total revenue. Dividing by total
  -- would understate the rate by however much could not be costed, and would
  -- move whenever an unrelated invoice got a cost.
  CASE WHEN COALESCE(SUM(m.revenue_base) FILTER (WHERE m.cogs_complete), 0) > 0
       THEN round(100.0 * COALESCE(SUM(m.margin_base), 0)
                  / SUM(m.revenue_base) FILTER (WHERE m.cogs_complete), 2) END
                                                                 AS margin_pct,
  min(m.posted_at)                                               AS first_sale,
  max(m.posted_at)                                               AS last_sale
FROM public.v_invoice_margin m
GROUP BY COALESCE(m.assigned_rep, '(unassigned)');

COMMENT ON VIEW public.v_sales_rep_performance IS
  'Sales performance per rep. margin_pct is measured against costed_revenue_base, not revenue_base, so it means "of what we can cost, this much was margin". invoices_cost_unknown says how much is missing.';

GRANT SELECT ON public.v_sales_rep_performance TO authenticated, service_role;

-- ═══ Guards ══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_missing
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('v_invoice_margin', 'v_sales_rep_performance')
     AND COALESCE(array_to_string(c.reloptions, ','), '') NOT LIKE '%security_invoker=true%';

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to apply: % came back without security_invoker, which would expose every rep''s margin to every caller. Nothing has been changed.',
      v_missing;
  END IF;

  -- The invariant the whole design rests on. If an invoice with unknown cost
  -- can produce a margin, every number downstream is inflated by it.
  IF EXISTS (SELECT 1 FROM public.v_invoice_margin
              WHERE NOT cogs_complete AND margin_base IS NOT NULL) THEN
    RAISE EXCEPTION
      'Refusing to apply: an invoice with incomplete cost is reporting a margin.';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.v_invoice_margin', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.v_sales_rep_performance', 'SELECT') THEN
    RAISE EXCEPTION 'Refusing to apply: authenticated cannot read the margin views.';
  END IF;

  RAISE NOTICE 'Margin reporting available. Sales that cannot be costed are excluded from margin, never counted as profit.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260841_verify_margin.sql.
