-- ────────────────────────────────────────────────────────────────────────────
-- CRM Sprint 6 — allow 'approval' as an activity type
--
-- The Activities pool doubles as a document-approval inbox: quotations, sales
-- orders, invoices and credit notes each raise an `approval`-type activity when
-- submitted for approval. Without this value in chk_activity_type the INSERT is
-- rejected by Postgres (the app swallowed the error, so approvals silently
-- never appeared).
--
-- Extends the constraint last set in 20260702_crm_activities_chatter.sql.
-- Idempotent: drop-then-add.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.activities
  DROP CONSTRAINT IF EXISTS chk_activity_type;

ALTER TABLE public.activities
  ADD CONSTRAINT chk_activity_type
  CHECK (type IN ('call', 'meeting', 'whatsapp', 'email', 'note', 'task', 'log', 'approval'))
  NOT VALID;

-- Verify (run manually):
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_activity_type';
