-- Stop the read-only role writing, and stop staff forging authorship.
-- (Audit finding BUG-011.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- `viewer` is documented as read-only. Six policies granted it writes, because
-- each was written as `rma_is_staff()` — and viewer is staff. Probed live on
-- 2026-09-06 as the real viewer account, everything rolled back:
--
--   UPDATE notifications SET title = <literal>          -> 155 rows (the whole table)
--   INSERT ticket_resolutions (type='refund', 9999)     -> 1 row
--   UPDATE rma_config WHERE key='appearance_settings'   -> 1 row
--
-- The notifications result is the sharp one. The same viewer's
-- `SELECT count(*) FROM notifications` returns 0 — the read policy is targeted —
-- yet the UPDATE policy is a bare `rma_is_staff()`, so they can rewrite all 155
-- rows they are not allowed to read. A write that reads no column never
-- consults the read policy.
--
--   Measurement note, because this nearly produced a false "not reproducible":
--   `UPDATE notifications SET title = title` returns 0 rows and looks like the
--   hole is closed. Assigning a column to itself makes the statement READ that
--   column, which pulls in the SELECT policy. Only a literal assignment tests
--   the UPDATE policy on its own.
--
-- Separately, `created_by` is free text on both `notifications` and
-- `ticket_resolutions`, so any staff account can attribute its writes to
-- someone else — or to 'system', which is what the automation path writes.
--
-- ── What this does ───────────────────────────────────────────────────────────
--
--   notifications.user_update_read      DROPPED outright. The only UPDATE path
--                                       in the app is mark_notifications_read(),
--                                       a SECURITY DEFINER RPC that bypasses RLS
--                                       and appends the caller's own address to
--                                       read_by. Verified: no direct UPDATE to
--                                       this table exists anywhere in src/.
--   notifications.staff_insert          narrowed to non-viewer staff.
--   ticket_resolutions insert/update    narrowed to the roles that actually
--                                       resolve tickets — technician, accountant,
--                                       manager, admin, super_admin. Excludes
--                                       viewer AND sales_rep (owner's decision,
--                                       2026-09-06). DELETE stays manager+.
--   rma_config.staff_write_appearance   DROPPED. Appearance is company-wide
--                                       (favicon, tab title, login background);
--                                       personal keys already live in
--                                       user_preferences. admin_all already
--                                       grants admins the write, and the only UI
--                                       that edits it — ControlPanel, App.jsx:1785
--                                       — is already gated to ADMIN/SUPER_ADMIN,
--                                       so this matches the client exactly.
--                                       staff_read_appearance_settings is KEPT:
--                                       every user must read the favicon/title.
--   notification_queue / email_queue    inserts narrowed to non-viewer staff, so
--                                       a read-only account cannot enqueue mail
--                                       or WhatsApp to arbitrary recipients.
--   created_by stamping                 BEFORE INSERT trigger on both tables,
--                                       modelled on stock_moves_stamp_actor.
--
-- ── Why the trigger stands aside for server-side writes ──────────────────────
--
-- `src/api/db/system.ts:405` inserts an automation notification with
-- `created_by: 'system'`. Stamping unconditionally would relabel it with
-- whoever's browser ran the rule, so the trigger only stamps a caller that
-- actually carries a JWT.
--
-- !! The version of this trigger ORIGINALLY SHIPPED IN THIS FILE WAS BROKEN and
-- !! is corrected by 20260820_fix_created_by_stamp_secdef.sql — apply that too.
-- !! It guarded on `current_user NOT IN ('authenticated','anon')`, copied from
-- !! the settled-document trigger in 20260809. That idiom does NOT transfer to a
-- !! SECURITY DEFINER function: inside one, current_user is the function's OWNER
-- !! ('postgres'), so the guard matched every time and nothing was ever stamped.
-- !! Measured: outside the trigger current_user = 'authenticated', inside it
-- !! 'postgres'. The corrected version keys off the presence of a JWT email,
-- !! which is immune to SECURITY DEFINER. The function body below is left as it
-- !! was written so the mistake stays legible in the history.
--
-- Note this means the browser's literal 'system' IS overwritten — deliberately.
-- That label was a client-side fiction; the row really was inserted by a user's
-- session, and 'system' is precisely the string an impersonator would send. A
-- genuine system sender must come from server-side code, which this leaves alone.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='mark_notifications_read') THEN
    v_missing := v_missing || 'mark_notifications_read() - the RPC that replaces the dropped UPDATE policy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
                  WHERE c.relname='rma_config' AND pol.polname='staff_read_appearance_settings') THEN
    v_missing := v_missing || 'rma_config.staff_read_appearance_settings - must survive so staff can still READ the branding';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
                  WHERE c.relname='rma_config' AND pol.polname='admin_all') THEN
    v_missing := v_missing || 'rma_config.admin_all - must exist so admins keep the appearance write';
  END IF;

  IF array_length(v_missing,1) > 0 THEN
    RAISE EXCEPTION 'Refusing to apply: missing %. Nothing has been changed.',
      array_to_string(v_missing, ' | ');
  END IF;
END
$do$;

-- ═══ Actor stamping ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_stamp_created_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_email text;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  v_email := public.rma_current_user_email();
  IF v_email IS NOT NULL AND v_email <> '' THEN
    NEW.created_by := v_email;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_notifications_stamp_created_by ON public.notifications;
CREATE TRIGGER trg_notifications_stamp_created_by
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.rma_stamp_created_by();

DROP TRIGGER IF EXISTS trg_ticket_resolutions_stamp_created_by ON public.ticket_resolutions;
CREATE TRIGGER trg_ticket_resolutions_stamp_created_by
  BEFORE INSERT ON public.ticket_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.rma_stamp_created_by();

-- ═══ notifications ═══════════════════════════════════════════════════════════

DROP POLICY IF EXISTS user_update_read ON public.notifications;

DROP POLICY IF EXISTS staff_insert ON public.notifications;
CREATE POLICY staff_insert ON public.notifications
  FOR INSERT TO public
  WITH CHECK (public.rma_is_staff() AND public.rma_user_role() <> 'viewer');

-- ═══ ticket_resolutions ══════════════════════════════════════════════════════

DROP POLICY IF EXISTS staff_write_resolutions ON public.ticket_resolutions;
CREATE POLICY staff_write_resolutions ON public.ticket_resolutions
  FOR INSERT TO public
  WITH CHECK (public.rma_user_role() IN
    ('super_admin', 'admin', 'manager', 'technician', 'accountant'));

DROP POLICY IF EXISTS staff_write_update_resolutions ON public.ticket_resolutions;
CREATE POLICY staff_write_update_resolutions ON public.ticket_resolutions
  FOR UPDATE TO public
  USING (public.rma_user_role() IN
    ('super_admin', 'admin', 'manager', 'technician', 'accountant'));

-- ═══ rma_config appearance ═══════════════════════════════════════════════════
-- admin_all keeps the admin write; staff_read_appearance_settings keeps the read.

DROP POLICY IF EXISTS staff_write_appearance_settings ON public.rma_config;

-- ═══ outbound queues ═════════════════════════════════════════════════════════

DROP POLICY IF EXISTS staff_insert_notif_queue ON public.notification_queue;
CREATE POLICY staff_insert_notif_queue ON public.notification_queue
  FOR INSERT TO public
  WITH CHECK (public.rma_is_staff() AND public.rma_user_role() <> 'viewer');

DROP POLICY IF EXISTS staff_insert_email_queue ON public.email_queue;
CREATE POLICY staff_insert_email_queue ON public.email_queue
  FOR INSERT TO public
  WITH CHECK (public.rma_is_staff() AND public.rma_user_role() <> 'viewer');

-- ═══ Guard: the holes are closed and the reads survived ══════════════════════

DO $do$
DECLARE
  v_problems text[] := ARRAY[]::text[];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
              WHERE c.relname='notifications' AND pol.polname='user_update_read') THEN
    v_problems := v_problems || 'notifications.user_update_read still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
              WHERE c.relname='rma_config' AND pol.polname='staff_write_appearance_settings') THEN
    v_problems := v_problems || 'rma_config.staff_write_appearance_settings still exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
              WHERE c.relname='rma_config' AND pol.polname='staff_read_appearance_settings') THEN
    v_problems := v_problems || 'rma_config.staff_read_appearance_settings was lost - staff can no longer read the branding';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_notifications_stamp_created_by') THEN
    v_problems := v_problems || 'notifications created_by stamp trigger missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_ticket_resolutions_stamp_created_by') THEN
    v_problems := v_problems || 'ticket_resolutions created_by stamp trigger missing';
  END IF;

  IF array_length(v_problems,1) > 0 THEN
    RAISE EXCEPTION 'Refusing to finish: %', array_to_string(v_problems, ' | ');
  END IF;

  RAISE NOTICE 'BUG-011 closed: viewer writes removed on 6 policies; created_by stamped on notifications and ticket_resolutions.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- supabase/manual/20260857_verify_viewer_write_lockdown.sql
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- Re-create the six policies with `rma_is_staff()` and drop the two triggers.
-- That restores a read-only role's ability to rewrite every notification in the
-- system, so prefer fixing forward.
