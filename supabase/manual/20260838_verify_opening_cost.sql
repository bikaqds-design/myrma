-- 20260838_verify_opening_cost.sql
-- Read-only. Confirms 20260796. Writes nothing.

WITH src AS (
  SELECT p.prosrc, p.oid FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rma_set_opening_cost'
),
checks AS (

  SELECT 1 AS n, 'rma_set_opening_cost values serialised units' AS what,
    (SELECT prosrc FROM src) LIKE '%UPDATE public.inventory_units%' AS pass

  UNION ALL SELECT 2, 'it still values bulk stock and clears the unknown count',
    (SELECT prosrc FROM src) LIKE '%uncosted_quantity = 0%'

  -- The one that protects real data. An opening estimate must never replace a
  -- landed cost that came off a vendor invoice.
  UNION ALL SELECT 3, 'it only touches units with no cost at all',
    (SELECT prosrc FROM src) LIKE '%unit_cost_base IS NULL%'

  UNION ALL SELECT 4, 'it only touches stock the business still holds',
    (SELECT prosrc FROM src) LIKE '%status         = ''company_stock''%'

  UNION ALL SELECT 5, 'it still refuses a cost of zero',
    (SELECT prosrc FROM src) LIKE '%p_unit_cost <= 0%'

  UNION ALL SELECT 6, 'it still requires manager or above',
    (SELECT prosrc FROM src) LIKE '%rma_is_manager_or_above()%'

  -- Silence would look like success on a mistyped id.
  UNION ALL SELECT 7, 'it refuses rather than doing nothing when there is nothing to cost',
    (SELECT prosrc FROM src) LIKE '%v_units = 0 AND v_bulk = 0%'

  UNION ALL SELECT 8, 'it reports what it valued',
    (SELECT prorettype::regtype::text FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='rma_set_opening_cost') = 'text'

  UNION ALL SELECT 9, 'authenticated can call it',
    has_function_privilege('authenticated', (SELECT oid FROM src), 'EXECUTE')

  UNION ALL SELECT 10, 'the public role cannot',
    NOT has_function_privilege('public', (SELECT oid FROM src), 'EXECUTE')

  -- Data sanity: nothing should have been valued yet.
  UNION ALL SELECT 11, 'no serialised unit carries a zero cost',
    NOT EXISTS (SELECT 1 FROM public.inventory_units WHERE unit_cost_base = 0)
)
SELECT n, CASE WHEN pass THEN 'PASS' ELSE '*** FAIL ***' END AS result, what
FROM checks ORDER BY n;
