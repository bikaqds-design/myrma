-- 20260840_verify_cogs.sql
-- Read-only. Confirms 20260797. Writes nothing. One statement, so all of it
-- shows in the Supabase editor.

WITH checks AS (

  -- ── Storage ────────────────────────────────────────────────────────────────
  SELECT 1 AS n, 'crm_invoices.cogs_base exists' AS what,
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='crm_invoices'
               AND column_name='cogs_base') AS pass

  UNION ALL SELECT 2, 'crm_invoices.cogs_unknown_qty exists and cannot go negative',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='crm_invoices'
        AND column_name='cogs_unknown_qty' AND is_nullable='NO') = 1
    AND EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.crm_invoices'::regclass AND contype='c'
                   AND pg_get_constraintdef(oid) LIKE '%cogs_unknown_qty >= 0%')

  -- Derived, so it cannot be set to claim a complete cost that is not there.
  UNION ALL SELECT 3, 'cogs_complete is GENERATED ALWAYS STORED',
    (SELECT is_generated FROM information_schema.columns
      WHERE table_schema='public' AND table_name='crm_invoices'
        AND column_name='cogs_complete') = 'ALWAYS'

  UNION ALL SELECT 4, 'cogs_complete requires BOTH a cost and no unknown units',
    (SELECT generation_expression FROM information_schema.columns
      WHERE table_schema='public' AND table_name='crm_invoices'
        AND column_name='cogs_complete') LIKE '%cogs_unknown_qty%'

  -- ── The gap this closes ────────────────────────────────────────────────────
  -- deliver_warehouse_stock has existed since 20260741 with no caller. Without
  -- this, a bulk sale bills the customer and never removes the stock.
  UNION ALL SELECT 5, 'posting now delivers bulk stock, not just serialised units',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='post_invoice')
      LIKE '%deliver_warehouse_stock%'

  UNION ALL SELECT 6, 'voiding gives bulk stock back',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='void_invoice')
      LIKE '%restore_warehouse_stock%'

  -- ── Cost capture ───────────────────────────────────────────────────────────
  UNION ALL SELECT 7, 'posting captures the cost of goods sold',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='post_invoice')
      LIKE '%rma_invoice_cogs%'

  -- Order matters more than presence: delivering first destroys the very
  -- reservations and averages the cost is read from.
  --
  -- Matched on the CALL SITES, not the bare names. The first occurrence of
  -- 'deliver_units' in this function is inside a comment ("rolls back if
  -- deliver_units fails below") that sits ABOVE the cost read, so comparing
  -- bare names reported a failure against correct code. The same mistake was
  -- made in the JavaScript test and fixed there; this copy was missed.
  UNION ALL SELECT 8, 'the cost is read BEFORE the stock moves',
    (SELECT position('rma_invoice_cogs' in prosrc)
              < position('PERFORM public.deliver_units(' in prosrc)
        AND position('rma_invoice_cogs' in prosrc)
              < position('PERFORM public.deliver_warehouse_stock(' in prosrc)
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='post_invoice')

  UNION ALL SELECT 9, 'voiding clears the cost, so a cancelled sale leaves no margin',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='void_invoice')
      LIKE '%cogs_base        = NULL%'

  -- ── rma_invoice_cogs ───────────────────────────────────────────────────────
  UNION ALL SELECT 10, 'rma_invoice_cogs is guarded against non-staff callers',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='rma_invoice_cogs')
      LIKE '%rma_is_staff()%'

  UNION ALL SELECT 11, 'rma_invoice_cogs is not callable by the public role',
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='rma_invoice_cogs'
                   AND has_function_privilege('public', p.oid, 'EXECUTE'))

  -- A NULL average means unknown. Multiplying by it would silently drop those
  -- units from the cost instead of counting them as unknown.
  UNION ALL SELECT 12, 'bulk units with no known cost are counted, not skipped',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='rma_invoice_cogs')
      LIKE '%FILTER (WHERE ws.avg_cost_base IS NULL)%'

  UNION ALL SELECT 13, 'serialised units with no known cost are counted too',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='rma_invoice_cogs')
      LIKE '%FILTER (WHERE u.unit_cost_base IS NULL)%'

  -- ── Every guard the two rewritten functions had ────────────────────────────
  UNION ALL SELECT 14, 'post_invoice still refuses to bill unreserved serialised stock',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='post_invoice')
      LIKE '%v_reserved < v_expected%'

  UNION ALL SELECT 15, 'post_invoice still requires a draft and a manager',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='post_invoice')
      LIKE '%rma_is_manager_or_above()%'
    AND (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='post_invoice')
      LIKE '%doc_status <> ''draft''%'

  UNION ALL SELECT 16, 'void_invoice still refuses while payments or credit notes stand',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='void_invoice')
      LIKE '%Reverse payments before voiding%'
    AND (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='void_invoice')
      LIKE '%Reverse credit notes before voiding%'

  UNION ALL SELECT 17, 'void_invoice still restores serialised units',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='void_invoice')
      LIKE '%restore_units(%'

  UNION ALL SELECT 18, 'all three are still executable by the app',
    (SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND p.proname IN ('post_invoice','void_invoice','rma_invoice_cogs'))

  -- ── Data sanity ────────────────────────────────────────────────────────────
  -- Nothing has been posted since this applied, so no invoice should carry a
  -- cost yet. A non-null cogs_base here would mean it came from somewhere else.
  UNION ALL SELECT 19, 'no cancelled invoice carries a cost of goods sold',
    NOT EXISTS (SELECT 1 FROM public.crm_invoices
                 WHERE doc_status = 'cancelled' AND cogs_base IS NOT NULL)

  UNION ALL SELECT 20, 'no invoice claims a complete cost while units are unknown',
    NOT EXISTS (SELECT 1 FROM public.crm_invoices
                 WHERE cogs_complete AND cogs_unknown_qty > 0)
)
SELECT n, CASE WHEN pass THEN 'PASS' ELSE '*** FAIL ***' END AS result, what
FROM checks ORDER BY n;

-- ─────────────────────────────────────────────────────────────────────────────
-- After posting a real invoice, margin looks like this — and leads with
-- whether the cost is complete rather than with the number:
--
--   SELECT inv_code, assigned_rep, total, cogs_base,
--          CASE WHEN cogs_complete THEN total - cogs_base END AS margin_base,
--          CASE WHEN cogs_complete THEN 'complete'
--               ELSE cogs_unknown_qty || ' unit(s) of unknown cost' END AS basis
--     FROM public.crm_invoices
--    WHERE doc_status = 'posted'
--    ORDER BY posted_at DESC;
