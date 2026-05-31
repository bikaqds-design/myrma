-- ============================================================================
-- BUG-B (2026-05-31) — Ticket creation fails: rma_tickets_ticket_status_check
-- ============================================================================
-- Symptom (reported in prod): "Failed to save ticket: new row for relation
-- 'rma_tickets' violates check constraint 'rma_tickets_ticket_status_check'".
--
-- Root cause: 20260526_check_constraints.sql hard-coded the status vocabulary
-- into a CHECK constraint:
--     CHECK (ticket_status IN ('Open','In Progress','Pending','Resolved',
--                              'Closed','Cancelled'))
-- but the app ships a *configurable* status feature (Control Panel → RMA Config
-- → Statuses, gated by the `manage_statuses` permission). Any deployment that
-- added or renamed a status now creates tickets the DB rejects — a structural
-- conflict between the rigid constraint and the configurable-status feature.
--
-- Fix: drop the rigid CHECK constraints on the status columns. The app remains
-- the source of truth for the status/priority vocabulary (validated in the UI
-- against the configured lists). RLS still controls who may write; this only
-- removes the value-whitelist that conflicts with custom statuses.
--
-- We KEEP a NOT-EMPTY guard so blank/garbage statuses still can't be stored
-- (catches the "empty status" failure mode without freezing the vocabulary).
--
-- ROLLBACK (re-add the fixed whitelist):
--   ALTER TABLE public.rma_tickets ADD CONSTRAINT rma_tickets_ticket_status_check
--     CHECK (ticket_status IN ('Open','In Progress','Pending','Resolved','Closed','Cancelled'));
-- ============================================================================

-- Drop the hard-coded value whitelist on ticket_status …
ALTER TABLE public.rma_tickets DROP CONSTRAINT IF EXISTS rma_tickets_ticket_status_check;

-- … and on the legacy `status` column if that variant exists.
ALTER TABLE public.rma_tickets DROP CONSTRAINT IF EXISTS rma_tickets_status_check;

-- Keep a minimal sanity guard: a status must be a non-empty string.
-- (CHECK passes on NULL, so this only blocks '' / whitespace, not custom values.)
ALTER TABLE public.rma_tickets DROP CONSTRAINT IF EXISTS rma_tickets_ticket_status_nonempty;
ALTER TABLE public.rma_tickets
  ADD CONSTRAINT rma_tickets_ticket_status_nonempty
  CHECK (ticket_status IS NULL OR length(btrim(ticket_status)) > 0);

-- NOTE: priority still has its CHECK from 20260526. If you also use custom
-- priorities and hit rma_tickets_priority_check, drop it the same way:
--   ALTER TABLE public.rma_tickets DROP CONSTRAINT IF EXISTS rma_tickets_priority_check;
