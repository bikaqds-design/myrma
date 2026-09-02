-- 20260841_verify_margin.sql
-- Read-only. Confirms 20260798. Writes nothing. One statement, so all of it
-- shows in the Supabase editor.

WITH checks AS (

  SELECT 1 AS n, 'both margin views exist' AS what,
    (SELECT count(*) FROM information_schema.views
      WHERE table_schema='public'
        AND table_name IN ('v_invoice_margin','v_sales_rep_performance')) = 2 AS pass

  -- The one that must never regress. A view without security_invoker runs as
  -- its owner and hands every caller every rep's margin.
  UNION ALL SELECT 2, 'both views run as the caller (security_invoker)',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
        AND c.relname IN ('v_invoice_margin','v_sales_rep_performance')
        AND array_to_string(c.reloptions, ',') LIKE '%security_invoker=true%') = 2

  UNION ALL SELECT 3, 'authenticated can read both',
    has_table_privilege('authenticated','public.v_invoice_margin','SELECT')
    AND has_table_privilege('authenticated','public.v_sales_rep_performance','SELECT')

  -- ── The invariant the whole design rests on ────────────────────────────────
  UNION ALL SELECT 4, 'no invoice with unknown cost reports a margin',
    NOT EXISTS (SELECT 1 FROM public.v_invoice_margin
                 WHERE NOT cogs_complete AND margin_base IS NOT NULL)

  -- Structural, not textual. pg_get_viewdef returns Postgres's REWRITTEN form,
  -- not the source that was submitted, so matching source text against it is
  -- guesswork — it failed here against a correct view. A CASE with no ELSE
  -- produces a nullable column; a COALESCE to zero would not.
  UNION ALL SELECT 5, 'margin_base is a nullable column, so it can say "cannot tell"',
    (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='v_invoice_margin'
        AND column_name='margin_base') = 'YES'
    AND (SELECT is_nullable FROM information_schema.columns
          WHERE table_schema='public' AND table_name='v_invoice_margin'
            AND column_name='margin_pct') = 'YES'

  UNION ALL SELECT 6, 'only posted invoices are counted',
    NOT EXISTS (SELECT 1 FROM public.v_invoice_margin WHERE doc_status <> 'posted')

  -- ── Per-rep arithmetic ─────────────────────────────────────────────────────
  -- The subtle one, checked by ARITHMETIC rather than by reading the view text.
  -- Dividing margin by TOTAL revenue understates the rate by however much could
  -- not be costed, and makes a rep's percentage move when an unrelated invoice
  -- of theirs gets a cost. Two halves: the rate must equal margin over COSTED
  -- revenue, and on any rep where the two revenues differ it must NOT equal
  -- margin over total revenue.
  UNION ALL SELECT 7, 'margin_pct is measured against costed revenue, not total revenue',
    NOT EXISTS (
      SELECT 1 FROM public.v_sales_rep_performance
       WHERE costed_revenue_base > 0
         AND abs(margin_pct - (100.0 * margin_base / costed_revenue_base)) > 0.02)
    AND NOT EXISTS (
      SELECT 1 FROM public.v_sales_rep_performance
       WHERE costed_revenue_base > 0
         AND revenue_base > costed_revenue_base
         AND margin_base <> 0
         AND abs(margin_pct - (100.0 * margin_base / revenue_base)) < 0.001)

  UNION ALL SELECT 8, 'every rep row carries how many invoices could not be costed',
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='v_sales_rep_performance'
               AND column_name='invoices_cost_unknown')

  UNION ALL SELECT 9, 'both revenues are reported, so the gap is visible',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='v_sales_rep_performance'
        AND column_name IN ('revenue_base','costed_revenue_base')) = 2

  -- Arithmetic consistency, checked against the data rather than the text.
  UNION ALL SELECT 10, 'costed revenue never exceeds total revenue',
    NOT EXISTS (SELECT 1 FROM public.v_sales_rep_performance
                 WHERE costed_revenue_base > revenue_base + 0.01)

  UNION ALL SELECT 11, 'the costed and uncosted invoice counts add up',
    NOT EXISTS (SELECT 1 FROM public.v_sales_rep_performance
                 WHERE invoices_costed + invoices_cost_unknown <> invoices_total)

  UNION ALL SELECT 12, 'margin equals costed revenue minus cost, on every rep',
    NOT EXISTS (SELECT 1 FROM public.v_sales_rep_performance
                 WHERE abs(margin_base - (costed_revenue_base - cogs_base)) > 0.01)

  UNION ALL SELECT 13, 'a rep with nothing costed reports no margin percentage',
    NOT EXISTS (SELECT 1 FROM public.v_sales_rep_performance
                 WHERE costed_revenue_base = 0 AND margin_pct IS NOT NULL)

  -- ── Per-invoice arithmetic ─────────────────────────────────────────────────
  UNION ALL SELECT 14, 'margin equals revenue minus cost on every costed invoice',
    NOT EXISTS (SELECT 1 FROM public.v_invoice_margin
                 WHERE cogs_complete
                   AND abs(margin_base - (revenue_base - cogs_base)) > 0.01)

  UNION ALL SELECT 15, 'an invoice with no revenue reports no margin percentage',
    NOT EXISTS (SELECT 1 FROM public.v_invoice_margin
                 WHERE revenue_base = 0 AND margin_pct IS NOT NULL)
)
SELECT n, CASE WHEN pass THEN 'PASS' ELSE '*** FAIL ***' END AS result, what
FROM checks ORDER BY n;

-- ─────────────────────────────────────────────────────────────────────────────
-- What the numbers look like once invoices are posted. Expect everything to be
-- cost-unknown until stock received through a vendor invoice is sold.
--
--   SELECT assigned_rep, invoices_total, invoices_cost_unknown,
--          revenue_base, costed_revenue_base, cogs_base, margin_base, margin_pct
--     FROM public.v_sales_rep_performance
--    ORDER BY revenue_base DESC;
