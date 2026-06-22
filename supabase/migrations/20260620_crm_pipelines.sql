-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 1, Step 3 — pipelines table + seed data
--
--  stages is a JSONB ARRAY, never an object — order is significant (it
--  defines Kanban column order in Sprint 3). See CONSTITUTION.md §7.5a and
--  specs/002-crm-upgrade/research.md §3: Postgres JSONB does not preserve
--  object key order, so this must stay an ordered array end-to-end.
--
--  Stage names below are the study's defaults, not yet confirmed with the
--  QDS sales team (see CRM_UPGRADE_PLAN.md Architecture Lock). Renaming a
--  stage later is a data UPDATE, not a schema change — low cost to adjust.
-- ═══════════════════════════════════════════════════════════════════════════


CREATE TABLE IF NOT EXISTS public.pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  stages jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);


-- ── Seed: B2B Dealer Pipeline ───────────────────────────────────────────────

INSERT INTO public.pipelines (name, stages) VALUES (
  'B2B Dealer Pipeline',
  jsonb_build_array(
    jsonb_build_object('id', 'new_lead',          'name', 'New Lead',          'order', 1, 'probability_default', 10,  'is_won', false, 'is_lost', false),
    jsonb_build_object('id', 'contacted',          'name', 'Contacted',          'order', 2, 'probability_default', 20,  'is_won', false, 'is_lost', false),
    jsonb_build_object('id', 'needs_assessment',   'name', 'Needs Assessment',   'order', 3, 'probability_default', 40,  'is_won', false, 'is_lost', false),
    jsonb_build_object('id', 'quote_sent',         'name', 'Quote Sent',         'order', 4, 'probability_default', 60,  'is_won', false, 'is_lost', false),
    jsonb_build_object('id', 'negotiation',        'name', 'Negotiation',        'order', 5, 'probability_default', 75,  'is_won', false, 'is_lost', false),
    jsonb_build_object('id', 'won',                'name', 'Won',                'order', 6, 'probability_default', 100, 'is_won', true,  'is_lost', false),
    jsonb_build_object('id', 'lost',               'name', 'Lost',               'order', 7, 'probability_default', 0,   'is_won', false, 'is_lost', true)
  )
)
ON CONFLICT (name) DO NOTHING;


-- ── Seed: B2C Retail Pipeline ────────────────────────────────────────────────

INSERT INTO public.pipelines (name, stages) VALUES (
  'B2C Retail Pipeline',
  jsonb_build_array(
    jsonb_build_object('id', 'new_inquiry',  'name', 'New Inquiry', 'order', 1, 'probability_default', 10,  'is_won', false, 'is_lost', false),
    jsonb_build_object('id', 'contacted',    'name', 'Contacted',    'order', 2, 'probability_default', 30,  'is_won', false, 'is_lost', false),
    jsonb_build_object('id', 'quote_sent',   'name', 'Quote Sent',   'order', 3, 'probability_default', 60,  'is_won', false, 'is_lost', false),
    jsonb_build_object('id', 'won',          'name', 'Won',          'order', 4, 'probability_default', 100, 'is_won', true,  'is_lost', false),
    jsonb_build_object('id', 'lost',         'name', 'Lost',         'order', 5, 'probability_default', 0,   'is_won', false, 'is_lost', true)
  )
)
ON CONFLICT (name) DO NOTHING;


-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.pipelines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_read ON public.pipelines;
CREATE POLICY staff_read ON public.pipelines
  FOR SELECT TO authenticated USING (public.rma_is_staff());

DROP POLICY IF EXISTS admin_insert ON public.pipelines;
CREATE POLICY admin_insert ON public.pipelines
  FOR INSERT TO authenticated WITH CHECK (public.rma_is_admin());

DROP POLICY IF EXISTS admin_update ON public.pipelines;
CREATE POLICY admin_update ON public.pipelines
  FOR UPDATE TO authenticated
  USING (public.rma_is_admin())
  WITH CHECK (public.rma_is_admin());

DROP POLICY IF EXISTS admin_delete ON public.pipelines;
CREATE POLICY admin_delete ON public.pipelines
  FOR DELETE TO authenticated USING (public.rma_is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT name, jsonb_array_length(stages) AS stage_count FROM pipelines ORDER BY name;
-- SELECT name, jsonb_pretty(stages) FROM pipelines WHERE name = 'B2B Dealer Pipeline';
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'pipelines' ORDER BY policyname;
