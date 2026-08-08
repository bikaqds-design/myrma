-- ============================================================================
-- 20260771 — Restore the missing ticket_activity.details column
-- ============================================================================
-- Found during the sales-funnel manual QA run (2026-08-06, funnel row 38).
--
-- Symptom: the ACTIVITY TIMELINE section of every RMA ticket was permanently
-- empty — "No activity recorded yet." — even immediately after actions that
-- are supposed to log (ticket_created, credit_note_created, resolution_saved,
-- resolution_deleted, status changes).
--
-- Cause: `public.ticket_activity` has no `details` column, but every reader and
-- writer in the app expects one:
--   • src/api/db/tickets.ts  → TicketActivityRow.details, ticketActivity.log()
--   • src/pages/RMATickets/TicketDrawer.jsx  → logActivity(actionType, details)
--   • src/pages/RMATickets/TicketForm.jsx    → db.ticketActivity.log(...)
--   • src/pages/RMATickets/ActivityTimeline.jsx → renders entry.details
--
-- Every INSERT therefore failed with
--   PGRST204: Could not find the 'details' column of 'ticket_activity'
--            in the schema cache
-- and ticketActivity.log() swallows the error (captureException + return
-- undefined), so the failure was completely silent in the UI. Nothing was ever
-- written to the table.
--
-- Fix: add the column. Nullable with no default — `details` is genuinely
-- optional (log() is typed `details: string | null`), and existing rows, if
-- any, legitimately have nothing to backfill from.
-- ============================================================================

alter table public.ticket_activity
  add column if not exists details text;

-- PostgREST caches the schema; without this the 'details' column stays
-- invisible to the API until the next reload and inserts keep failing.
notify pgrst, 'reload schema';

-- ─── Verification ────────────────────────────────────────────────────────────
-- Expect one row back:
--
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'ticket_activity'
--      and column_name  = 'details';
--
-- Then, in the app: open any RMA ticket, save a resolution, and confirm the
-- entry appears under ACTIVITY TIMELINE.
