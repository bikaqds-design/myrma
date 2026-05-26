-- ============================================================================
-- CRIT-2: Enable Row Level Security on all tables
-- ============================================================================
-- Generated from audit 2026-05-26 (revised: helper functions moved to public schema)
--
-- STRATEGY:
--   • Authenticated users with a role in user_roles can read most tables.
--   • Anon role has NO direct table access (public /tracker must go through
--     an Edge Function using service_role).
--   • Write/delete restricted by role:
--       - super_admin / admin: everything
--       - manager:             products, customers, tickets, parts, inventory
--       - technician:          tickets they're assigned to, comments, time entries
--       - viewer:              read-only
--
-- RUN ORDER:
--   This file is idempotent. You can run it whole, or section by section.
--   Each section is independent; if one fails, the others still apply.
--
-- ROLLBACK:
--   To disable RLS on any table:  ALTER TABLE <tbl> DISABLE ROW LEVEL SECURITY;
--   To drop all policies on a table:  see commented section at end.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 0 — Helper functions in the `public` schema
-- ─────────────────────────────────────────────────────────────────────────────
-- Note: created in public (not auth) so the SQL editor has permission.
-- Uses auth.uid() and auth.jwt() which are always available.

CREATE OR REPLACE FUNCTION public.rma_current_user_email() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT auth.jwt() ->> 'email' $$;

CREATE OR REPLACE FUNCTION public.rma_user_role() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$
  SELECT role FROM public.user_roles
  WHERE user_email = (auth.jwt() ->> 'email')
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.rma_is_authenticated() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT auth.jwt() ->> 'email' IS NOT NULL $$;

CREATE OR REPLACE FUNCTION public.rma_is_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT public.rma_user_role() IN ('super_admin', 'admin') $$;

CREATE OR REPLACE FUNCTION public.rma_is_manager_or_above() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT public.rma_user_role() IN ('super_admin', 'admin', 'manager') $$;

CREATE OR REPLACE FUNCTION public.rma_is_staff() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT public.rma_user_role() IN ('super_admin', 'admin', 'manager', 'technician', 'viewer') $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — Admin-only tables (highest sensitivity)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'email_settings',
    'email_templates',
    'webhooks',
    'rma_config',
    'branding_settings',
    'custom_roles',
    'custom_field_definitions',
    'announcements'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS admin_all ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY admin_all ON public.%I FOR ALL TO authenticated USING (public.rma_is_admin()) WITH CHECK (public.rma_is_admin())',
        t
      );
    END IF;
  END LOOP;
END $$;

-- Announcements: readable by ALL authenticated staff, write by admin only
ALTER TABLE IF EXISTS public.announcements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_read ON public.announcements;
CREATE POLICY staff_read ON public.announcements
  FOR SELECT TO authenticated USING (public.rma_is_staff());


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — user_roles (auth-critical, special handling)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_read_own ON public.user_roles;
CREATE POLICY user_read_own ON public.user_roles
  FOR SELECT TO authenticated
  USING (user_email = public.rma_current_user_email() OR public.rma_is_admin());

DROP POLICY IF EXISTS admin_write ON public.user_roles;
CREATE POLICY admin_write ON public.user_roles
  FOR INSERT TO authenticated WITH CHECK (public.rma_is_admin());

DROP POLICY IF EXISTS admin_update ON public.user_roles;
CREATE POLICY admin_update ON public.user_roles
  FOR UPDATE TO authenticated USING (public.rma_is_admin()) WITH CHECK (public.rma_is_admin());

DROP POLICY IF EXISTS admin_delete ON public.user_roles;
CREATE POLICY admin_delete ON public.user_roles
  FOR DELETE TO authenticated USING (public.rma_is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — Reference data (everyone reads, admins write)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'brands',
    'categories',
    'subcategories',
    'warehouses'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

      EXECUTE format('DROP POLICY IF EXISTS staff_read ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY staff_read ON public.%I FOR SELECT TO authenticated USING (public.rma_is_staff())',
        t
      );

      EXECUTE format('DROP POLICY IF EXISTS admin_write ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY admin_write ON public.%I FOR INSERT TO authenticated WITH CHECK (public.rma_is_admin())',
        t
      );

      EXECUTE format('DROP POLICY IF EXISTS admin_update ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY admin_update ON public.%I FOR UPDATE TO authenticated USING (public.rma_is_admin()) WITH CHECK (public.rma_is_admin())',
        t
      );

      EXECUTE format('DROP POLICY IF EXISTS admin_delete ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY admin_delete ON public.%I FOR DELETE TO authenticated USING (public.rma_is_admin())',
        t
      );
    END IF;
  END LOOP;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4 — Core operational data (products, customers)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products', 'customers', 'customer_notes'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

      EXECUTE format('DROP POLICY IF EXISTS staff_read ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY staff_read ON public.%I FOR SELECT TO authenticated USING (public.rma_is_staff())',
        t
      );

      EXECUTE format('DROP POLICY IF EXISTS manager_insert ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY manager_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.rma_is_manager_or_above())',
        t
      );

      EXECUTE format('DROP POLICY IF EXISTS manager_update ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY manager_update ON public.%I FOR UPDATE TO authenticated USING (public.rma_is_manager_or_above()) WITH CHECK (public.rma_is_manager_or_above())',
        t
      );

      EXECUTE format('DROP POLICY IF EXISTS admin_delete ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY admin_delete ON public.%I FOR DELETE TO authenticated USING (public.rma_is_admin())',
        t
      );
    END IF;
  END LOOP;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5 — RMA tickets
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS public.rma_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_read ON public.rma_tickets;
CREATE POLICY staff_read ON public.rma_tickets
  FOR SELECT TO authenticated USING (public.rma_is_staff());

DROP POLICY IF EXISTS manager_insert ON public.rma_tickets;
CREATE POLICY manager_insert ON public.rma_tickets
  FOR INSERT TO authenticated WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS staff_update ON public.rma_tickets;
CREATE POLICY staff_update ON public.rma_tickets
  FOR UPDATE TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'technician' AND assigned_technician = public.rma_current_user_email())
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'technician' AND assigned_technician = public.rma_current_user_email())
  );

DROP POLICY IF EXISTS admin_delete ON public.rma_tickets;
CREATE POLICY admin_delete ON public.rma_tickets
  FOR DELETE TO authenticated USING (public.rma_is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 6 — Ticket comments and activity
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_comments', 'ticket_activity'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

      EXECUTE format('DROP POLICY IF EXISTS staff_read ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY staff_read ON public.%I FOR SELECT TO authenticated USING (public.rma_is_staff())',
        t
      );

      EXECUTE format('DROP POLICY IF EXISTS staff_insert ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY staff_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.rma_is_staff() AND public.rma_user_role() <> ''viewer'')',
        t
      );

      EXECUTE format('DROP POLICY IF EXISTS admin_delete ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY admin_delete ON public.%I FOR DELETE TO authenticated USING (public.rma_is_admin())',
        t
      );
    END IF;
  END LOOP;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 7 — Inventory units, parts, batches
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inventory_units',
    'manufacturer_batches',
    'parts',
    'ticket_parts'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

      EXECUTE format('DROP POLICY IF EXISTS staff_read ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY staff_read ON public.%I FOR SELECT TO authenticated USING (public.rma_is_staff())',
        t
      );

      EXECUTE format('DROP POLICY IF EXISTS staff_write ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY staff_write ON public.%I FOR INSERT TO authenticated WITH CHECK (public.rma_is_staff() AND public.rma_user_role() <> ''viewer'')',
        t
      );

      EXECUTE format('DROP POLICY IF EXISTS staff_update ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY staff_update ON public.%I FOR UPDATE TO authenticated USING (public.rma_is_staff() AND public.rma_user_role() <> ''viewer'') WITH CHECK (public.rma_is_staff() AND public.rma_user_role() <> ''viewer'')',
        t
      );

      EXECUTE format('DROP POLICY IF EXISTS admin_delete ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY admin_delete ON public.%I FOR DELETE TO authenticated USING (public.rma_is_admin())',
        t
      );
    END IF;
  END LOOP;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 8 — Time entries (per-user)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS public.time_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_read_own ON public.time_entries;
CREATE POLICY user_read_own ON public.time_entries
  FOR SELECT TO authenticated
  USING (user_email = public.rma_current_user_email() OR public.rma_is_manager_or_above());

DROP POLICY IF EXISTS user_insert_own ON public.time_entries;
CREATE POLICY user_insert_own ON public.time_entries
  FOR INSERT TO authenticated
  WITH CHECK (user_email = public.rma_current_user_email() AND public.rma_is_staff());

DROP POLICY IF EXISTS user_update_own ON public.time_entries;
CREATE POLICY user_update_own ON public.time_entries
  FOR UPDATE TO authenticated
  USING (user_email = public.rma_current_user_email() OR public.rma_is_manager_or_above())
  WITH CHECK (user_email = public.rma_current_user_email() OR public.rma_is_manager_or_above());

DROP POLICY IF EXISTS admin_delete ON public.time_entries;
CREATE POLICY admin_delete ON public.time_entries
  FOR DELETE TO authenticated
  USING (public.rma_is_admin() OR user_email = public.rma_current_user_email());


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 9 — Invoices
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS public.invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_read ON public.invoices;
CREATE POLICY staff_read ON public.invoices
  FOR SELECT TO authenticated USING (public.rma_is_staff());

DROP POLICY IF EXISTS manager_write ON public.invoices;
CREATE POLICY manager_write ON public.invoices
  FOR INSERT TO authenticated WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS manager_update ON public.invoices;
CREATE POLICY manager_update ON public.invoices
  FOR UPDATE TO authenticated USING (public.rma_is_manager_or_above()) WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS admin_delete ON public.invoices;
CREATE POLICY admin_delete ON public.invoices
  FOR DELETE TO authenticated USING (public.rma_is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 10 — Notifications (per-user)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_read_targeted ON public.notifications;
CREATE POLICY user_read_targeted ON public.notifications
  FOR SELECT TO authenticated
  USING (
    public.rma_is_staff() AND (
      target_roles IS NULL
      OR array_length(target_roles, 1) IS NULL
      OR public.rma_user_role() = ANY(target_roles)
      OR (target_emails IS NOT NULL AND public.rma_current_user_email() = ANY(target_emails))
    )
  );

DROP POLICY IF EXISTS staff_insert ON public.notifications;
CREATE POLICY staff_insert ON public.notifications
  FOR INSERT TO authenticated WITH CHECK (public.rma_is_staff());

DROP POLICY IF EXISTS user_update_read ON public.notifications;
CREATE POLICY user_update_read ON public.notifications
  FOR UPDATE TO authenticated
  USING (public.rma_is_staff())
  WITH CHECK (public.rma_is_staff());

DROP POLICY IF EXISTS admin_delete ON public.notifications;
CREATE POLICY admin_delete ON public.notifications
  FOR DELETE TO authenticated USING (public.rma_is_admin());


-- Notification preferences — per-user
ALTER TABLE IF EXISTS public.notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_own ON public.notification_preferences;
CREATE POLICY user_own ON public.notification_preferences
  FOR ALL TO authenticated
  USING (user_email = public.rma_current_user_email() OR public.rma_is_admin())
  WITH CHECK (user_email = public.rma_current_user_email() OR public.rma_is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 11 — Audit log
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE IF EXISTS public.user_activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_read ON public.user_activity_log;
CREATE POLICY admin_read ON public.user_activity_log
  FOR SELECT TO authenticated USING (public.rma_is_admin());

DROP POLICY IF EXISTS auth_insert ON public.user_activity_log;
CREATE POLICY auth_insert ON public.user_activity_log
  FOR INSERT TO authenticated WITH CHECK (public.rma_is_authenticated());


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 12 — Revoke anon access EVERYWHERE
-- ─────────────────────────────────────────────────────────────────────────────
-- The /tracker route MUST go through an Edge Function. No direct anon access.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES (run these to confirm policies are in place)
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT schemaname, tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
-- SELECT schemaname, tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;


-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (commented — uncomment per-table as needed)
-- ─────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE public.rma_tickets DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.customers   DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.products    DISABLE ROW LEVEL SECURITY;
-- … etc.
