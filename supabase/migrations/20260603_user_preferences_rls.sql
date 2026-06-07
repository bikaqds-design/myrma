-- ============================================================
-- S9-2a: RLS for user_preferences table
-- Each user can only read and write their own preferences row.
--
-- S9-2d: Allow all authenticated staff to read + write the
-- appearance_settings row in rma_config so non-admin users get
-- cross-device appearance sync.
-- ============================================================

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_own_preferences_select" ON public.user_preferences;
DROP POLICY IF EXISTS "user_own_preferences_insert" ON public.user_preferences;
DROP POLICY IF EXISTS "user_own_preferences_update" ON public.user_preferences;
DROP POLICY IF EXISTS "user_own_preferences_delete" ON public.user_preferences;

-- Users may read only their own row
CREATE POLICY "user_own_preferences_select"
  ON public.user_preferences
  FOR SELECT
  USING (user_email = public.rma_current_user_email());

-- Users may insert only a row for themselves
CREATE POLICY "user_own_preferences_insert"
  ON public.user_preferences
  FOR INSERT
  WITH CHECK (user_email = public.rma_current_user_email());

-- Users may update only their own row
CREATE POLICY "user_own_preferences_update"
  ON public.user_preferences
  FOR UPDATE
  USING (user_email = public.rma_current_user_email());

-- Users may delete only their own row
CREATE POLICY "user_own_preferences_delete"
  ON public.user_preferences
  FOR DELETE
  USING (user_email = public.rma_current_user_email());

-- ── rma_config appearance_settings (S9-2d) ───────────────────
-- Allow all staff to read + write the appearance_settings row so
-- non-admin users get cross-device sync for their theme settings.
-- Admin retains full access via the existing admin_all policy.

DROP POLICY IF EXISTS "staff_read_appearance_settings" ON public.rma_config;
DROP POLICY IF EXISTS "staff_write_appearance_settings" ON public.rma_config;

CREATE POLICY "staff_read_appearance_settings"
  ON public.rma_config
  FOR SELECT
  USING (
    public.rma_is_staff()
    AND config_key = 'appearance_settings'
  );

CREATE POLICY "staff_write_appearance_settings"
  ON public.rma_config
  FOR ALL
  USING (
    public.rma_is_staff()
    AND config_key = 'appearance_settings'
  )
  WITH CHECK (
    public.rma_is_staff()
    AND config_key = 'appearance_settings'
  );
