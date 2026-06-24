-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 2 — add nurturing/inactive to the lead status list
--
--  Researched current CRM best practice (HubSpot/Salesforce/RevOps guidance:
--  5-7 action-oriented statuses). Adds:
--  - nurturing: still being actively worked, not yet ready to convert
--  - inactive:  gone cold / no response, kept around for possible reactivation
--  converted/disqualified are unchanged — Convert and Disqualify actions in
--  the UI are untouched by this migration.
-- ═══════════════════════════════════════════════════════════════════════════


ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS chk_lead_status;
ALTER TABLE public.leads
  ADD CONSTRAINT chk_lead_status
  CHECK (status IN (
    'new', 'contacted', 'qualified', 'nurturing', 'inactive', 'converted', 'disqualified'
  )) NOT VALID;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_lead_status';
