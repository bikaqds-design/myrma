-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 1, Step 6 — activities table
--
--  related_id is a polymorphic reference (leads/deals/customers/contacts) —
--  no DB-level FK is possible across multiple target tables, so referential
--  integrity is enforced at the API layer: activities.create() must verify
--  the referenced row exists before insert. See data-model.md.
--
--  "Overdue" (due_date < now() AND completed_at IS NULL) is computed at
--  query time in activities.listOverdue(), not a stored column — avoids a
--  stale-flag bug that would otherwise need a cron job to stay correct.
--
--  RLS uses the same composite pattern as leads/deals: sales_rep is
--  excluded from rma_is_manager_or_above() by design, but needs to log
--  activities against their own records.
-- ═══════════════════════════════════════════════════════════════════════════


CREATE TABLE IF NOT EXISTS public.activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  related_type text NOT NULL,
  related_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  due_date timestamptz,
  completed_at timestamptz,
  assigned_rep uuid REFERENCES auth.users(id),
  outcome_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.activities
  DROP CONSTRAINT IF EXISTS chk_activity_related_type;
ALTER TABLE public.activities
  ADD CONSTRAINT chk_activity_related_type
  CHECK (related_type IN ('lead', 'deal', 'customer', 'contact')) NOT VALID;

ALTER TABLE public.activities
  DROP CONSTRAINT IF EXISTS chk_activity_type;
ALTER TABLE public.activities
  ADD CONSTRAINT chk_activity_type
  CHECK (type IN ('call', 'meeting', 'whatsapp', 'email', 'note', 'task')) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_activities_related_id    ON public.activities(related_id);
CREATE INDEX IF NOT EXISTS idx_activities_assigned_rep   ON public.activities(assigned_rep);
CREATE INDEX IF NOT EXISTS idx_activities_due_date       ON public.activities(due_date);
CREATE INDEX IF NOT EXISTS idx_activities_completed_at   ON public.activities(completed_at);


-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS activities_read ON public.activities;
CREATE POLICY activities_read ON public.activities
  FOR SELECT TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = auth.uid())
  );

DROP POLICY IF EXISTS activities_insert ON public.activities;
CREATE POLICY activities_insert ON public.activities
  FOR INSERT TO authenticated
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR public.rma_user_role() = 'sales_rep'
  );

DROP POLICY IF EXISTS activities_update ON public.activities;
CREATE POLICY activities_update ON public.activities
  FOR UPDATE TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = auth.uid())
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = auth.uid())
  );

DROP POLICY IF EXISTS admin_delete ON public.activities;
CREATE POLICY admin_delete ON public.activities
  FOR DELETE TO authenticated USING (public.rma_is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('chk_activity_related_type', 'chk_activity_type');
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'activities' ORDER BY policyname;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'activities' ORDER BY indexname;
