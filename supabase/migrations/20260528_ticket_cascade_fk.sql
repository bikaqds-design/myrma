-- ============================================================================
-- C-2 — Atomic ticket cascade delete via ON DELETE CASCADE foreign keys
-- ============================================================================
-- Audit finding: db.rmaTickets.delete() ran 4 sequential DELETE statements from
-- application code. Partial failure left orphans.
--
-- Inspection (2026-05-28) showed:
--   • ticket_activity.ticket_id  → rma_tickets.id   FK exists, ON DELETE CASCADE ✅
--   • ticket_comments.ticket_id  → rma_tickets.id   FK exists, ON DELETE CASCADE ✅
--   • inventory_units.rma_ticket_id → rma_tickets.id   *** MISSING ENTIRELY ***
--
-- This migration only adds the missing FK on inventory_units. The other two
-- tables already cascade — Postgres has been cleaning them up automatically;
-- the JS-level deletes were redundant and are being removed in the same commit.
--
-- PREREQUISITE:
--   Run the orphan-check query in AUDIT_LOG.md and confirm count = 0.
--   ADD CONSTRAINT will fail loudly if orphan rows exist.
--
-- ROLLBACK:
--   ALTER TABLE public.inventory_units
--     DROP CONSTRAINT IF EXISTS inventory_units_rma_ticket_id_fkey;
-- ============================================================================

-- Idempotent: drop the FK if it somehow already exists under this name, then
-- re-add it with the CASCADE rule.
ALTER TABLE public.inventory_units
  DROP CONSTRAINT IF EXISTS inventory_units_rma_ticket_id_fkey;

ALTER TABLE public.inventory_units
  ADD  CONSTRAINT inventory_units_rma_ticket_id_fkey
       FOREIGN KEY (rma_ticket_id)
       REFERENCES  public.rma_tickets(id)
       ON DELETE CASCADE;


-- ─── Verification ────────────────────────────────────────────────────────────
-- After running, re-run the inspection query from AUDIT_LOG.md. Expected output:
--
--   constraint_name                          | child_table      | on_delete
--   -----------------------------------------+------------------+-----------
--   inventory_units_rma_ticket_id_fkey       | inventory_units  | CASCADE
--   ticket_activity_ticket_id_fkey           | ticket_activity  | CASCADE
--   ticket_comments_ticket_id_fkey           | ticket_comments  | CASCADE
