-- ═══════════════════════════════════════════════════════════════════════════
--  Warehouse Module Redesign R1 — stock_moves: extend doc_type (rma_ticket)
--
--  move_rma_units (20260766) writes one stock_moves row per unit whenever an
--  RMA ticket's product status change relocates a unit between the new
--  system RMA locations. doc_id is the rma_tickets.id — a distinct concept
--  from every existing doc_type, so it gets its own value rather than
--  overloading 'manual' (which would make the Stock Movements tab unable to
--  link back to the originating ticket).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.stock_moves'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%doc_type%';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.stock_moves DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;

ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_doc_type_check
  CHECK (doc_type IN ('sales_order', 'invoice', 'credit_note', 'manual', 'vendor_invoice', 'rma_ticket'));
