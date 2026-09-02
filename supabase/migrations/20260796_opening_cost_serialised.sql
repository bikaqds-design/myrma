-- 20260796_opening_cost_serialised.sql
-- rma_set_opening_cost also values serialised stock.
--
-- ═══ Why ═════════════════════════════════════════════════════════════════════
--
-- 20260795 gave bulk stock a way to receive an opening cost and left serialised
-- units to a hand-written UPDATE per unit. The report then found 401 serialised
-- units in stock, none of them costed. Four hundred and one individual
-- statements is not a procedure anyone will follow, and a valuation nobody
-- performs is the same as no valuation.
--
-- Serialised units of the same product bought before costing existed have no
-- individually recoverable price anyway — the estimate is per product, exactly
-- as it is for bulk. So the function now takes a product and a warehouse and
-- values whatever is there, whichever way it is tracked.
--
-- ═══ What it will not do ═════════════════════════════════════════════════════
--
-- It only touches units the business still holds and that have no cost:
-- company_stock, and unit_cost_base IS NULL. A unit that already carries a real
-- landed cost from a vendor invoice keeps it — an opening estimate must never
-- overwrite a price that was actually paid.
--
-- Paste into the Supabase SQL editor. Verify with
-- supabase/manual/20260838_verify_opening_cost.sql.

-- 20260795 declared this RETURNS void. CREATE OR REPLACE cannot change a
-- return type, so it has to be dropped first. Dropping resets the function's
-- privileges to the default, which is EXECUTE for PUBLIC — the REVOKE and GRANT
-- below put the lockdown back, and the guard at the end refuses the migration
-- if either failed to take.
DROP FUNCTION IF EXISTS public.rma_set_opening_cost(uuid, uuid, numeric);

CREATE FUNCTION public.rma_set_opening_cost(
  p_product_id   uuid,
  p_warehouse_id uuid,
  p_unit_cost    numeric
)
RETURNS text          -- what it did, so the caller is not left guessing
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row    record;
  v_units  integer := 0;
  v_bulk   integer := 0;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to set stock costs' USING ERRCODE = 'P0001';
  END IF;

  IF p_unit_cost IS NULL OR p_unit_cost <= 0 THEN
    RAISE EXCEPTION
      'An opening cost must be a positive amount in base currency. Leave the stock uncosted rather than valuing it at zero — zero is a claim, and an unknown is not.'
      USING ERRCODE = 'P0001';
  END IF;

  -- ── Serialised units ────────────────────────────────────────────────────
  -- Only the ones with no cost. A unit that arrived on a vendor invoice
  -- already carries what was actually paid for it, and an estimate must not
  -- overwrite a fact.
  UPDATE public.inventory_units
     SET unit_cost_base = p_unit_cost
   WHERE product_id     = p_product_id
     AND warehouse_id   = p_warehouse_id
     AND status         = 'company_stock'
     AND unit_cost_base IS NULL;
  GET DIAGNOSTICS v_units = ROW_COUNT;

  -- ── Bulk stock ──────────────────────────────────────────────────────────
  SELECT * INTO v_row FROM public.warehouse_stock
   WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
   FOR UPDATE;

  IF FOUND AND v_row.uncosted_quantity > 0 THEN
    UPDATE public.warehouse_stock
       SET total_cost_base   = total_cost_base + round(p_unit_cost * v_row.uncosted_quantity, 4),
           uncosted_quantity = 0,
           updated_at        = now()
     WHERE id = v_row.id;
    v_bulk := v_row.uncosted_quantity;
  END IF;

  IF v_units = 0 AND v_bulk = 0 THEN
    RAISE EXCEPTION
      'Nothing here needs a cost: there is no uncosted stock of that product in that warehouse. Setting one would overwrite what was actually paid.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN format('valued %s serialised unit(s) and %s bulk unit(s) at %s each',
                v_units, v_bulk, p_unit_cost);
END
$fn$;

REVOKE ALL ON FUNCTION public.rma_set_opening_cost(uuid, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rma_set_opening_cost(uuid, uuid, numeric)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.rma_set_opening_cost(uuid, uuid, numeric) IS
  'Gives a cost to stock that has none, serialised or bulk, for one product in one warehouse. Never overwrites a cost that came from a vendor invoice.';

DO $do$
BEGIN
  IF NOT has_function_privilege('authenticated',
        'public.rma_set_opening_cost(uuid, uuid, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to apply: authenticated cannot execute rma_set_opening_cost.';
  END IF;
  IF has_function_privilege('public',
        'public.rma_set_opening_cost(uuid, uuid, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to apply: rma_set_opening_cost is callable by PUBLIC.';
  END IF;
  RAISE NOTICE 'rma_set_opening_cost now values serialised stock as well as bulk.';
END
$do$;
