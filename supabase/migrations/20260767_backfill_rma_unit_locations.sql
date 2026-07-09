-- ═══════════════════════════════════════════════════════════════════════════
--  Warehouse Module Redesign R1 — backfill existing RMA units into locations
--
--  Every inventory_units row created from a ticket before this migration has
--  warehouse_id = NULL (createUnitsFromTicket never set one — the gap this
--  whole redesign closes). This is a one-time DO block, not an RPC: it
--  touches live data directly, guarded by the same warehouse_id IS NULL
--  predicate that makes it safe to re-run (a second run finds nothing left
--  to place).
--
--  Matching: prefer the ticket's product entry with the same serial_number;
--  fall back to matching by product_name; fall back further to RMA-RECEIVED
--  if no product entry matches at all. Units on a Cancelled ticket are left
--  unplaced (documented orphan — a cancelled RMA has no real stage).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_unit          record;
  v_product       jsonb;
  v_status_text   text;
  v_target_code   text;
  v_target_id     uuid;
BEGIN
  FOR v_unit IN
    SELECT u.id, u.serial_number, u.product_name, u.rma_ticket_id, u.warehouse_id, t.products, t.ticket_status
    FROM public.inventory_units u
    JOIN public.rma_tickets t ON t.id = u.rma_ticket_id
    WHERE u.status = 'active_rma'
      AND u.warehouse_id IS NULL
      AND t.ticket_status <> 'Cancelled'
    FOR UPDATE OF u
  LOOP
    v_product := NULL;

    IF v_unit.serial_number IS NOT NULL AND v_unit.serial_number <> '' THEN
      SELECT elem INTO v_product
      FROM jsonb_array_elements(COALESCE(v_unit.products, '[]'::jsonb)) elem
      WHERE elem->>'serial_number' = v_unit.serial_number
      LIMIT 1;
    END IF;

    IF v_product IS NULL THEN
      SELECT elem INTO v_product
      FROM jsonb_array_elements(COALESCE(v_unit.products, '[]'::jsonb)) elem
      WHERE elem->>'product_name' = v_unit.product_name
      LIMIT 1;
    END IF;

    v_status_text := NULLIF(v_product->>'product_status', '');

    v_target_code := CASE v_status_text
      WHEN 'Under Repair'   THEN 'RMA-REPAIR'
      WHEN 'Repaired'       THEN 'RMA-REPAIRED'
      WHEN 'Can''t Repair'  THEN 'RMA-CANTREPAIR'
      WHEN 'Replacement'    THEN 'RMA-STOCK'
      WHEN 'Credit Note'    THEN 'RMA-STOCK'
      ELSE 'RMA-RECEIVED'
    END;

    SELECT id INTO v_target_id FROM public.warehouses WHERE code = v_target_code AND is_system LIMIT 1;

    UPDATE public.inventory_units SET warehouse_id = v_target_id WHERE id = v_unit.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit.id, 'rma_ticket', v_unit.rma_ticket_id, 'transfer', 1,
       'unassigned', v_target_id::text, 'system@backfill');
  END LOOP;
END $$;
