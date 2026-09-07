-- Stop the direct-mutation transfer path breaking reservations or reaching
-- system locations. (Audit finding BUG-032, the dangerous half.)
--
-- ── Scope, stated up front ───────────────────────────────────────────────────
--
-- BUG-032 has two halves. This migration closes one of them and deliberately
-- leaves the other open.
--
--   CLOSED here: `transferUnits()` can no longer move a unit that is RESERVED
--   for a sales order, and can no longer move one INTO a protected system
--   location. Those are the two behaviours that corrupt state.
--
--   STILL OPEN: these transfers write no `stock_moves` row, so the Warehouse
--   Dashboard and margin reporting still cannot see them. Closing that means
--   routing ByProductTab / CompanyStockTab / ProductDetailModal / WarehousesTab
--   through `transfer_stock` / `move_rma_units` / `promote_rma_unit` — the
--   "Warehouse Module R2" consolidation. The code comment on `transferUnits`
--   warns explicitly that "the feature sets differ; don't merge blindly" (the
--   RPC path has no equivalent of the System Pool / null-warehouse case), so
--   that is a design decision for the owner, not something to guess at inside
--   a migration.
--
-- ── Why a trigger and not a policy ───────────────────────────────────────────
--
-- BUG-010's guard already refuses direct client writes to the reservation and
-- costing columns, but `warehouse_id` was deliberately left writable there
-- precisely because these four screens depend on it. This adds the narrower
-- rule that makes leaving it writable safe.
--
-- SECURITY INVOKER, like every other guard in this database: `current_user` is
-- 'authenticated' for a browser PATCH and 'postgres' inside a SECURITY DEFINER
-- RPC. Inside a DEFINER function it would always read as the owner and the
-- guard would never fire — the mistake corrected in 20260820.
--
-- The stock RPCs therefore pass straight through, which is what lets the RMA
-- workflow keep moving units into system locations legitimately.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid='public.inventory_units'::regclass
                    AND attname='warehouse_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Refusing to apply: inventory_units.warehouse_id does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid='public.warehouses'::regclass
                    AND attname='is_system' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Refusing to apply: warehouses.is_system does not exist.';
  END IF;
END
$do$;

-- ═══ The guard ═══════════════════════════════════════════════════════════════
-- SECURITY INVOKER on purpose — see the note above.

CREATE OR REPLACE FUNCTION public.rma_guard_direct_warehouse_move()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_system_name text;
BEGIN
  -- Server-side callers (the stock RPCs, cron, the SQL editor) pass through.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Only interested in an actual relocation.
  IF NEW.warehouse_id IS NOT DISTINCT FROM OLD.warehouse_id THEN
    RETURN NEW;
  END IF;

  -- 1. A reserved unit belongs to a sales order until that order releases it.
  --    Moving it here is how stock disappears from under an order that still
  --    expects to deliver it.
  IF OLD.reservation_status = 'reserved' THEN
    RAISE EXCEPTION
      'This unit is reserved for a sales order and cannot be moved. Release the reservation first.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 2. System locations are the RMA workflow's own, maintained by
  --    move_rma_units / promote_rma_unit. A manual transfer must not reach them.
  IF NEW.warehouse_id IS NOT NULL THEN
    SELECT w.name INTO v_system_name
      FROM public.warehouses w
     WHERE w.id = NEW.warehouse_id AND w.is_system;

    IF v_system_name IS NOT NULL THEN
      RAISE EXCEPTION
        '"%" is a protected system location and cannot be the destination of a manual transfer. Use the RMA workflow.',
        v_system_name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_inventory_units_guard_warehouse_move ON public.inventory_units;
CREATE TRIGGER trg_inventory_units_guard_warehouse_move
  BEFORE UPDATE ON public.inventory_units
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_direct_warehouse_move();

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_inventory_units_guard_warehouse_move') THEN
    RAISE EXCEPTION 'Refusing to finish: the guard trigger was not created.';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='rma_guard_direct_warehouse_move') THEN
    RAISE EXCEPTION
      'Refusing to finish: the guard is SECURITY DEFINER, which makes its current_user check always true and silently disables it.';
  END IF;
  RAISE NOTICE 'BUG-032 (half): direct transfers can no longer move reserved units or reach system locations.';
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_inventory_units_guard_warehouse_move ON public.inventory_units;
