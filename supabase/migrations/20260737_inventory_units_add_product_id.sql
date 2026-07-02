-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 7.6 — inventory_units.product_id (foundational prerequisite)
--
--  Discovered live 2026-07-01: reserve_units, release_units*, deliver_units*,
--  restore_units* (20260719_inventory_reservation.sql) and funnel_reserve_line
--  (20260732) were all written assuming inventory_units.product_id exists.
--  It never has — inventory_units predates the sales funnel and was built
--  purely for the RMA repair workflow, which only ever captured a free-text
--  product_name (see inventory.ts createUnitsFromTicket). Confirmed via a
--  live information_schema.columns query: 18 real columns, no product_id.
--
--  (*release_units/deliver_units/restore_units don't actually reference
--  product_id — only reserve_units and funnel_reserve_line do. But every
--  document-line reservation in the funnel goes through those two, so the
--  whole reservation subsystem has been unable to execute against real data
--  since its creation. This is the true root cause behind "full end-to-end
--  funnel testing is blocked" — deeper than the "no available stock" framing
--  in the original Sprint 7.5 retrospective.)
--
--  Nullable, no backfill (confirmed with user 2026-07-01): historical
--  RMA-workflow units only have a free-text product_name, and fuzzy-matching
--  that against products.product_name risks silently linking a unit to the
--  wrong catalog product. Old rows stay product_id = NULL — they were
--  already invisible to the reservation system, since it never worked.
--  Only units created going forward (Sprint 8's "Receive Stock", or a future
--  manual link action) get a real product_id.
--
--  This migration must run before 20260738_inventory_model_reconciliation.sql.
--  Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.inventory_units
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES public.products(id);

CREATE INDEX IF NOT EXISTS inv_units_product_id_idx
  ON public.inventory_units (product_id);
