-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 7.6 — Inventory Model Reconciliation (schema/RPC only, no UI)
--
--  PREREQUISITE: 20260737_inventory_units_add_product_id.sql MUST run before
--  this migration. reserve_units/funnel_reserve_line reference
--  inventory_units.product_id, which has never existed in production until
--  that migration adds it (discovered live 2026-07-01 when this migration's
--  original serial-uniqueness index failed to create, prompting a schema
--  introspection that surfaced the missing column).
--
--  A0 (Critical — discovered live, not in the original audit): TWO column
--    references in reserve_units have never resolved against the real
--    table, meaning it has never successfully executed in production:
--      (a) `product_id` — inventory_units has no such column (confirmed via
--          information_schema.columns); it only has free-text `product_name`
--          from the original RMA-repair-ticket design. Fixed by 20260737.
--      (b) `ORDER BY created_at` — the real column is `created_date`. Fixed
--          below (this was the only place created_at was referenced; parts
--          RPCs and release/deliver/restore_units don't touch either column).
--    Postgres doesn't validate plpgsql column references at CREATE FUNCTION
--    time, so both defects applied silently in 20260719 and were only
--    caught now because a plain SQL SELECT (not plpgsql) fails immediately.
--
--  Fixes 3 findings from the 2026-07-01 architecture audit, all in the
--  stock-reservation path used by every Sales Order / Invoice approval:
--
--  A1 (Critical): inventory_units has two orthogonal status axes that were
--    getting conflated — `status` (physical/RMA lifecycle: active_rma /
--    company_stock / sent_to_manufacturer / closed) and `reservation_status`
--    (funnel state: available / reserved / delivered, added by 20260719).
--    Documented here via COMMENT ON COLUMN so this never gets re-confused.
--
--  A2 (Critical — overselling hole #1): funnel_reserve_line classified a
--    line as "service, no stock effect" whenever the product happened to
--    have zero inventory_units rows *right now* — indistinguishable from
--    "this product is legitimately sold out." Fixed by branching on the
--    existing products.product_type enum instead (no new column needed —
--    hardware/software/accessory already require serialized units via Zod
--    and a DB CHECK constraint, 20260526_check_constraints.sql:121-124).
--    Only product_type = 'service' is a no-op; everything else always goes
--    through reserve_units, which correctly raises "Insufficient stock" at
--    zero available — including for a brand-new or fully sold-out product.
--
--  A3 (High — overselling hole #2): reserve_units only excluded
--    status = 'closed', so a unit on the repair bench (active_rma) or out
--    at the manufacturer (sent_to_manufacturer) could be reserved and
--    delivered against a Sales Order. Restricted to the one status that
--    actually means "in our warehouse, sellable": company_stock.
--
--  A4 (Medium-High — moved to 20260739_inventory_serial_uniqueness.sql):
--    no uniqueness guard on serial_number. Split into its own migration
--    because it has a live-data dependency (duplicate serials already
--    exist) that the other fixes here don't — see that file for detail.
--
--  All changes are idempotent. No UI/page changes in this migration —
--  Sprint 8 (Inventory Redesign) builds on top of this.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A1: document the two-axis contract directly on the columns ──────────────

COMMENT ON COLUMN public.inventory_units.status IS
  'Physical/RMA repair lifecycle: active_rma (on the bench) | company_stock '
  '(sellable, in warehouse) | sent_to_manufacturer (out for repair) | closed '
  '(terminal). Orthogonal to reservation_status — never conflate the two.';

COMMENT ON COLUMN public.inventory_units.reservation_status IS
  'Funnel/sales state: available | reserved (see reserved_by_doc_id) | '
  'delivered. Orthogonal to status — a unit is only sellable for a new '
  'document when it is ALSO status = ''company_stock''.';

-- ── A2: funnel_reserve_line — classify by product_type, not row existence ───

CREATE OR REPLACE FUNCTION public.funnel_reserve_line(
  p_doc_type    text,
  p_doc_id      uuid,
  p_product_id  uuid,
  p_qty         integer,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_type text;
BEGIN
  SELECT product_type INTO v_product_type
  FROM public.products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_product_type = 'service' THEN
    RETURN; -- service lines never touch inventory
  END IF;

  -- hardware / software / accessory: always require serialized units.
  -- reserve_units raises "Insufficient stock" at 0 available — this is what
  -- fixes the silent no-op for a new/sold-out product (audit A2).
  PERFORM public.reserve_units(p_doc_type, p_doc_id, p_product_id, p_qty, p_actor_email);
END;
$$;

-- ── A3: reserve_units — restrict to the one sellable status ─────────────────

CREATE OR REPLACE FUNCTION public.reserve_units(
  p_doc_type    text,
  p_doc_id      uuid,
  p_product_id  uuid,
  p_qty         integer,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit       record;
  v_count      integer := 0;
  v_available  integer;
BEGIN
  -- Count available units first (fast check before locking)
  SELECT COUNT(*) INTO v_available
  FROM public.inventory_units
  WHERE product_id = p_product_id
    AND reservation_status = 'available'
    AND status = 'company_stock';

  IF v_available < p_qty THEN
    RAISE EXCEPTION 'Insufficient stock: need %, only % available for product %',
      p_qty, v_available, p_product_id
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_unit IN
    SELECT id FROM public.inventory_units
    WHERE product_id = p_product_id
      AND reservation_status = 'available'
      AND status = 'company_stock'
    ORDER BY created_date
    LIMIT p_qty
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.inventory_units
    SET
      reservation_status   = 'reserved',
      reserved_by_doc_type = p_doc_type,
      reserved_by_doc_id   = p_doc_id,
      reserved_at          = NOW(),
      reserved_by_email    = p_actor_email
    WHERE id = v_unit.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit.id, p_doc_type, p_doc_id, 'reserve', 1, 'available', 'reserved', p_actor_email);

    v_count := v_count + 1;
  END LOOP;

  IF v_count < p_qty THEN
    RAISE EXCEPTION 'Concurrent reservation conflict: secured only % of % units for product %',
      v_count, p_qty, p_product_id
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- A4 (serial-number uniqueness) is deferred to
-- 20260739_inventory_serial_uniqueness.sql — it has a live-data dependency
-- the fixes above don't.
