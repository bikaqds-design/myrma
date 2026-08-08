-- ─── Backfill product_id on RMA-ticket inventory units ────────────────────
--
-- Warehouse Module R1 shipped with a gap found in manual QA on 2026-08-05
-- (WAREHOUSE_R1_TEST_CHECKLIST.md §2 note, §8): units created from an RMA
-- ticket recorded only `product_name`, never `product_id`. `get_stock_summary`
-- / getStockSummary group units by `product_id`, so every RMA-ticket unit fell
-- into the "Not in catalog" bucket and no catalog product could ever show a
-- non-zero RMA count on the Warehouse Dashboard — even when the ticket named a
-- real product.
--
-- The write path is fixed in src/lib/rmaUnitCreate.ts + createUnitsFromTicket.
-- This migration repairs the rows already in the table.
--
-- Matching rules, deliberately conservative:
--   * only rows that still have no product_id are touched;
--   * match is case-insensitive on trimmed product_name;
--   * a name matching two or more catalog products is SKIPPED, not guessed —
--     mis-attributing a unit is worse than leaving it uncategorised;
--   * non-catalog names simply stay NULL, which is the correct answer for an
--     RMA on something the shop never sold.
--
-- Idempotent: re-running matches nothing, because every row it can fix has a
-- product_id by then.

DO $$
DECLARE
  v_updated integer;
  v_remaining integer;
BEGIN
  WITH unique_catalog AS (
    -- No aggregate over id: Postgres has no min()/max() for uuid. The HAVING
    -- clause already restricts each group to exactly one row, so taking the
    -- first element of array_agg is the whole group.
    SELECT lower(btrim(product_name)) AS name_key,
           (array_agg(id))[1]         AS product_id
    FROM public.products
    WHERE product_name IS NOT NULL
      AND btrim(product_name) <> ''
    GROUP BY lower(btrim(product_name))
    HAVING count(*) = 1          -- ambiguous names are left alone
  )
  UPDATE public.inventory_units u
     SET product_id = c.product_id
    FROM unique_catalog c
   WHERE u.product_id IS NULL
     AND u.product_name IS NOT NULL
     AND lower(btrim(u.product_name)) = c.name_key;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  SELECT count(*) INTO v_remaining
  FROM public.inventory_units
  WHERE product_id IS NULL
    AND status = 'active_rma';

  RAISE NOTICE 'backfill_rma_unit_product_id: linked % unit(s); % active_rma unit(s) remain unlinked (expected for genuinely non-catalog products)',
    v_updated, v_remaining;
END;
$$;
