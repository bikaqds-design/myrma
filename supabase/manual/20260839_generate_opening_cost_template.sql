-- 20260839_generate_opening_cost_template.sql
-- Read-only. Writes the opening-valuation script for you, ready to fill in.
--
-- ═══ What it does ════════════════════════════════════════════════════════════
--
-- Returns ONE text value: a complete SQL script with one rma_set_opening_cost
-- call per uncosted bin, each annotated with the product, the warehouse and
-- how many units it covers. Copy it out, replace every NULL with what that
-- product actually cost per unit in base currency, delete the lines you cannot
-- price, and run what is left.
--
-- Editing a column of numbers is a job someone will finish. Assembling sixty
-- statements by hand is one they will abandon half way, and a half-done
-- valuation is worse than none — it leaves some products costed and some not,
-- with nothing recording which is which.
--
-- ═══ Test data is separated, not priced ══════════════════════════════════════
--
-- Products whose names look like fixtures (test1, test2, test 3, QA …) are put
-- in a second section under a warning rather than the main list. Giving a test
-- widget an opening cost is work spent making fake data look real; those rows
-- want deleting before launch, not valuing.
--
-- The pattern is a guess based on naming, so nothing is hidden — everything
-- appears, just under the right heading. Check the second list before acting
-- on either.

WITH stock AS (
  SELECT
    w.product_id, w.warehouse_id, p.product_name,
    COALESCE(wh.name, '(no warehouse)') AS warehouse,
    w.uncosted_quantity AS qty, 'bulk'::text AS kind
  FROM public.warehouse_stock w
  JOIN public.products   p  ON p.id  = w.product_id
  LEFT JOIN public.warehouses wh ON wh.id = w.warehouse_id
  WHERE w.uncosted_quantity > 0

  UNION ALL

  SELECT
    u.product_id, u.warehouse_id, p.product_name,
    COALESCE(wh.name, '(no warehouse)'),
    count(*)::integer, 'serialised'
  FROM public.inventory_units u
  JOIN public.products   p  ON p.id  = u.product_id
  LEFT JOIN public.warehouses wh ON wh.id = u.warehouse_id
  WHERE u.status = 'company_stock' AND u.unit_cost_base IS NULL
  GROUP BY u.product_id, u.warehouse_id, p.product_name, wh.name
),
flagged AS (
  SELECT *,
    (product_name ~* '^(test|qa )' OR product_name ~* '\y(widget|dummy|sample)\y') AS looks_like_test
  FROM stock
),
lines AS (
  SELECT
    looks_like_test,
    string_agg(
      format(
        E'SELECT public.rma_set_opening_cost(%L, %L, NULL);  -- %s x %s  |  %s @ %s',
        product_id, warehouse_id, qty, kind, left(product_name, 44), warehouse),
      E'\n' ORDER BY qty DESC, product_name)                       AS body,
    SUM(qty)   AS units,
    count(*)   AS bins
  FROM flagged
  GROUP BY looks_like_test
)
SELECT
  E'-- ════════════════════════════════════════════════════════════════════\n'
  || E'--  OPENING STOCK VALUATION\n'
  || E'--  Replace every NULL with the cost per unit in base currency.\n'
  || E'--  Delete any line you cannot price — leaving it uncosted is honest;\n'
  || E'--  a guessed number is not, and zero is refused outright.\n'
  || E'--  Safe to run more than once: it never overwrites a cost that came\n'
  || E'--  from a vendor invoice.\n'
  || E'-- ════════════════════════════════════════════════════════════════════\n\n'
  || COALESCE(
       (SELECT format(E'-- %s real bin(s), %s unit(s)\n\n%s\n', bins, units, body)
          FROM lines WHERE NOT looks_like_test),
       E'-- Nothing real is uncosted.\n')
  || COALESCE(
       (SELECT format(
          E'\n\n-- ════════════════════════════════════════════════════════════════════\n'
          || E'--  LOOKS LIKE TEST DATA — %s bin(s), %s unit(s)\n'
          || E'--  Do not value these. Costing a fixture is effort spent making\n'
          || E'--  fake data look real. Delete them before launch instead; they\n'
          || E'--  are matched by name, so check the list before acting on it.\n'
          || E'-- ════════════════════════════════════════════════════════════════════\n\n%s\n',
          bins, units, body)
          FROM lines WHERE looks_like_test),
       '')
  AS opening_cost_script;
