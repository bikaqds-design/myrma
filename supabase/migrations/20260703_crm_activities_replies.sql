-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 2.5 follow-up — threaded replies on chatter comments
--
--  parent_id lets a note (or any history entry) have replies, rendered
--  indented beneath it in LeadChatter.jsx. Self-referencing FK with
--  ON DELETE CASCADE so deleting a parent note also removes its replies
--  (there is no delete UI yet, but this keeps the table consistent if one is
--  added later, or if a row is cleaned up via the Data Cleanup tool).
-- ═══════════════════════════════════════════════════════════════════════════


ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.activities(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_activities_parent_id ON public.activities(parent_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'activities' AND column_name = 'parent_id';
