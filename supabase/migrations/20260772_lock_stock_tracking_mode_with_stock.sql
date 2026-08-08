-- ============================================================================
-- 20260772 — Refuse to change products.stock_tracking_mode while stock exists
-- ============================================================================
-- Companion to exposing the tracking-mode selector in the product form
-- (gap found during the Purchase Module QA run, 2026-08-07: the column was
-- read by 8 components but written by no UI, so all 405 products sat on the
-- 'serialized' default and the entire bulk half of the system was unreachable).
--
-- Why this needs a database guard and not just a disabled <select>:
--
--   The two tracking models store stock in DIFFERENT TABLES —
--     serialized → public.inventory_units  (one row per physical unit)
--     bulk       → public.warehouse_stock  (a quantity per warehouse)
--
--   Every reader (getStockSummary, ReceiveStockModal, BulkStockActionModal,
--   StockBreakdownModal, BranchesDrawer, receive_vendor_invoice, receive_stock,
--   funnel_reserve_line) picks its table from the product's CURRENT mode.
--   Flipping the mode migrates nothing. It simply points every query at the
--   other, empty table: the stock disappears from every screen and every
--   availability check while the rows still sit in the database. A subsequent
--   sale would then oversell against a phantom zero balance.
--
--   That is a silent data-integrity failure, so the UI is not allowed to be
--   the only thing standing in the way — same discipline as
--   assert_not_system_warehouse (20260770).
--
-- The rule: the mode may change freely while the product holds no live stock
-- on either side, and is frozen once it does. Emptying the product (selling,
-- scrapping or adjusting the last unit away) unfreezes it again.
--
-- 'Live' matches getStockSummary's definition — inventory_units rows in
-- 'company_stock' or 'active_rma'. Units that are sold, scrapped or closed do
-- not pin the mode; they are history, not stock.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assert_tracking_mode_change_is_safe()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_units integer;
  v_bulk  integer;
BEGIN
  -- Only interested in an actual change of the mode.
  IF NEW.stock_tracking_mode IS NOT DISTINCT FROM OLD.stock_tracking_mode THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_units
  FROM public.inventory_units
  WHERE product_id = NEW.id
    AND status IN ('company_stock', 'active_rma');

  SELECT COALESCE(sum(quantity), 0) INTO v_bulk
  FROM public.warehouse_stock
  WHERE product_id = NEW.id;

  IF v_units > 0 OR v_bulk > 0 THEN
    RAISE EXCEPTION
      'Cannot change stock tracking mode for "%": % serialized unit(s) and % bulk in stock. Move or remove the stock first — switching modes would hide it.',
      NEW.product_name, v_units, v_bulk
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_tracking_mode_change_is_safe ON public.products;

CREATE TRIGGER trg_assert_tracking_mode_change_is_safe
  BEFORE UPDATE OF stock_tracking_mode ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_tracking_mode_change_is_safe();

-- ─── Verification ────────────────────────────────────────────────────────────
-- A product with no stock may switch freely:
--
--   UPDATE public.products SET stock_tracking_mode = 'bulk'
--    WHERE id = '<a product with zero units>';           -- succeeds
--
-- A product holding stock is refused:
--
--   UPDATE public.products SET stock_tracking_mode = 'bulk'
--    WHERE id = '<a product with live units>';
--   -- ERROR: Cannot change stock tracking mode for "…": 5 serialized unit(s)
--   --        and 0 bulk in stock. …
--
-- Updating any other column on a stocked product is unaffected (the trigger is
-- scoped to UPDATE OF stock_tracking_mode and also re-checks IS DISTINCT FROM).
