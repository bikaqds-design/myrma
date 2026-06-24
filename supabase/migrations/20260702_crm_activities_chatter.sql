-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 2.5 — chatter support on the activities table
--
--  Two additions to make the existing activities table serve as an Odoo-style
--  "chatter" feed on the lead detail page (and, later, deals):
--
--  1. New 'log' activity type — for SYSTEM-generated audit entries (status
--     changed, lead converted, rep reassigned). These render distinctly from
--     user-authored notes/calls/meetings, matching Odoo's field-tracking lines.
--     The UI stores a structured, pipe-encoded title (e.g. 'status_changed|new|
--     qualified') so the text stays translatable at render time — see
--     LeadChatter.jsx. NOT VALID keeps it consistent with the other CHECK
--     constraints on this table.
--
--  2. attachments jsonb column — array of {name, url, path, size, type},
--     mirroring the shape storage.uploadLeadAttachment() returns. JSONB ARRAY
--     (never an object) so order is preserved (CONSTITUTION.md §7.5a). Files
--     live in the existing rma-attachments bucket; this column only stores
--     their metadata.
-- ═══════════════════════════════════════════════════════════════════════════


ALTER TABLE public.activities
  DROP CONSTRAINT IF EXISTS chk_activity_type;
ALTER TABLE public.activities
  ADD CONSTRAINT chk_activity_type
  CHECK (type IN ('call', 'meeting', 'whatsapp', 'email', 'note', 'task', 'log')) NOT VALID;

ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_activity_type';
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'activities' AND column_name = 'attachments';
