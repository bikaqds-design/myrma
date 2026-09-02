-- Remove the Base44-era policies that defeat the role model.
--
-- Found by dumping the live schema (Finding 4). These policies are in the
-- database and in no migration, which is why every previous audit missed them:
-- they were read from the repo, and the repo does not describe them.
--
-- ── 1. The critical one ──────────────────────────────────────────────────────
--
--   CREATE POLICY "Allow authenticated access" ON public.customers
--     FOR ALL TO PUBLIC USING (auth.role() = 'authenticated');
--
-- ...and the same on products, rma_tickets, ticket_comments and
-- user_permissions.
--
-- FOR ALL with only USING means Postgres reuses that expression as the WITH
-- CHECK, so it covers SELECT, INSERT, UPDATE and DELETE. Permissive policies
-- are OR'd together, so every staff_read / manager_insert / admin_delete
-- policy on those tables was decorative: any signed-in session satisfied the
-- broad one instead.
--
-- In practice, before this migration:
--   * a viewer could delete every customer, product and RMA ticket;
--   * a technician could rewrite any ticket, not only their assigned ones;
--   * auth.role() never consults user_roles, so a SUSPENDED account kept full
--     access to all five tables — which negates 20260786 exactly where it
--     matters most.
--
-- ── 2. Legacy admin policies that ignore status ──────────────────────────────
--
--   EXISTS (SELECT 1 FROM user_roles
--            WHERE user_email = auth.email()
--              AND role IN ('admin','super_admin'))
--
-- Same test as rma_is_admin(), minus the status and expiry check that
-- rma_user_role() now performs. A suspended admin still passed these on nine
-- tables. Each is dropped in favour of the rma_is_admin() policy that already
-- sits beside it.
--
-- ── 3. Blanket USING (true) reads and WITH CHECK (true) writes ───────────────
--
-- Several tables carry a policy that grants every authenticated user full read
-- — including user_roles, which exposes every colleague's email, role and
-- permission map to anyone who can sign in.
--
-- ── 4. Dormant anon policies ─────────────────────────────────────────────────
--
-- rma_tickets and ticket_comments carry FOR ... TO anon policies. They are
-- unreachable today only because neither table grants anything to anon — the
-- public tracker goes through the public-track edge function on the service
-- role instead. A policy that is safe only because a grant happens to be
-- missing is one GRANT away from exposing every ticket, so they go too.
--
-- ── Replacements ─────────────────────────────────────────────────────────────
--
-- Dropping a policy that currently permits something is a behaviour change.
-- Where the broad policy was the only thing allowing a legitimate action, a
-- narrow policy is added in its place — marked below. Test ticket creation,
-- comment editing and customer creation as a sales rep after applying.

-- ═══ 1. The blanket authenticated policies ═══════════════════════════════════

DROP POLICY IF EXISTS "Allow authenticated access" ON public.customers;
DROP POLICY IF EXISTS "Allow authenticated access" ON public.products;
DROP POLICY IF EXISTS "Allow authenticated access" ON public.rma_tickets;
DROP POLICY IF EXISTS "Allow authenticated access" ON public.ticket_comments;
DROP POLICY IF EXISTS "Allow authenticated access" ON public.user_permissions;

-- Replacement: sales reps create customers as part of the CRM flow. The
-- surviving policies only let managers insert, so without this a rep loses an
-- ability the blanket policy was granting. Matches leads and deals.
DROP POLICY IF EXISTS sales_insert_customers ON public.customers;
CREATE POLICY sales_insert_customers ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK (public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep');

-- Replacement: only managers could insert an RMA ticket once the blanket
-- policy is gone. Technicians and sales reps raise tickets routinely; viewers
-- do not.
DROP POLICY IF EXISTS staff_insert_tickets ON public.rma_tickets;
CREATE POLICY staff_insert_tickets ON public.rma_tickets
  FOR INSERT TO authenticated
  WITH CHECK (public.rma_is_staff() AND public.rma_user_role() <> 'viewer');

-- Replacement: ticket_comments had no UPDATE policy of its own. Editing your
-- own comment, or a manager correcting one, stays possible.
DROP POLICY IF EXISTS staff_update_comments ON public.ticket_comments;
CREATE POLICY staff_update_comments ON public.ticket_comments
  FOR UPDATE TO authenticated
  USING (public.rma_is_manager_or_above() OR user_email = public.rma_current_user_email())
  WITH CHECK (public.rma_is_manager_or_above() OR user_email = public.rma_current_user_email());

-- user_permissions is a Base44 leftover the application no longer reads. Left
-- in place rather than dropped, but closed to everyone except admins.
DROP POLICY IF EXISTS legacy_user_permissions_admin ON public.user_permissions;
CREATE POLICY legacy_user_permissions_admin ON public.user_permissions
  FOR ALL TO authenticated
  USING (public.rma_is_admin()) WITH CHECK (public.rma_is_admin());

-- ═══ 2. Legacy admin policies that skip the status check ═════════════════════

DROP POLICY IF EXISTS "Admins can insert branding"        ON public.branding_settings;
DROP POLICY IF EXISTS "Admins can update branding"        ON public.branding_settings;
DROP POLICY IF EXISTS "Admins can manage brands"          ON public.brands;
DROP POLICY IF EXISTS "Admins can manage categories"      ON public.categories;
DROP POLICY IF EXISTS "Admins can manage subcategories"   ON public.subcategories;
DROP POLICY IF EXISTS "Admins can manage product images"  ON public.product_images;
DROP POLICY IF EXISTS "Admins can manage email settings"  ON public.email_settings;
DROP POLICY IF EXISTS "Admins can manage email templates" ON public.email_templates;
DROP POLICY IF EXISTS "Admins can read email queue"       ON public.email_queue;
DROP POLICY IF EXISTS insert_custom_roles                 ON public.custom_roles;
DROP POLICY IF EXISTS update_custom_roles                 ON public.custom_roles;
DROP POLICY IF EXISTS delete_custom_roles                 ON public.custom_roles;
DROP POLICY IF EXISTS insert_user_roles                   ON public.user_roles;
DROP POLICY IF EXISTS update_user_roles                   ON public.user_roles;
DROP POLICY IF EXISTS delete_user_roles                   ON public.user_roles;

-- branding_settings, brands, categories, subcategories, email_settings,
-- email_templates, custom_roles and user_roles each already carry an
-- rma_is_admin() policy, so nothing is lost. product_images and email_queue
-- did not — replacements below.

DROP POLICY IF EXISTS product_images_admin_write ON public.product_images;
CREATE POLICY product_images_admin_write ON public.product_images
  FOR ALL TO authenticated
  USING (public.rma_is_admin()) WITH CHECK (public.rma_is_admin());

DROP POLICY IF EXISTS email_queue_admin_read ON public.email_queue;
CREATE POLICY email_queue_admin_read ON public.email_queue
  FOR SELECT TO authenticated USING (public.rma_is_admin());

-- ═══ 3. Blanket reads and writes ═════════════════════════════════════════════

-- Every signed-in user could read every colleague's email, role and permission
-- map. user_read_own already covers "my own row, or I am an admin", but the
-- notification handlers look up another rep's phone from user_roles, so staff
-- keep read access to the roster rather than losing it entirely.
DROP POLICY IF EXISTS read_user_roles ON public.user_roles;
DROP POLICY IF EXISTS staff_read_user_roles ON public.user_roles;
CREATE POLICY staff_read_user_roles ON public.user_roles
  FOR SELECT TO authenticated USING (public.rma_is_staff());

-- Custom role definitions are resolved at sign-in for any user holding one.
DROP POLICY IF EXISTS read_custom_roles ON public.custom_roles;
DROP POLICY IF EXISTS staff_read_custom_roles ON public.custom_roles;
CREATE POLICY staff_read_custom_roles ON public.custom_roles
  FOR SELECT TO authenticated USING (public.rma_is_staff());

-- The audit trail is an admin surface; admin_read and auth_insert already
-- cover it correctly.
DROP POLICY IF EXISTS read_activity_log   ON public.user_activity_log;
DROP POLICY IF EXISTS insert_activity_log ON public.user_activity_log;

-- staff_read and staff_insert already exist on ticket_activity.
DROP POLICY IF EXISTS "Allow authenticated users to read activity"   ON public.ticket_activity;
DROP POLICY IF EXISTS "Allow authenticated users to insert activity" ON public.ticket_activity;

-- staff_read already exists on each of these.
DROP POLICY IF EXISTS "Anyone can view brands"          ON public.brands;
DROP POLICY IF EXISTS "Anyone can view categories"      ON public.categories;
DROP POLICY IF EXISTS "Anyone can view subcategories"   ON public.subcategories;
DROP POLICY IF EXISTS "Anyone can view product images"  ON public.product_images;

DROP POLICY IF EXISTS product_images_staff_read ON public.product_images;
CREATE POLICY product_images_staff_read ON public.product_images
  FOR SELECT TO authenticated USING (public.rma_is_staff());

-- Branding renders the shell for every signed-in user, so this one is
-- deliberately kept broad — but narrowed from "true" to actual staff.
DROP POLICY IF EXISTS "Anyone can read branding" ON public.branding_settings;
DROP POLICY IF EXISTS staff_read_branding ON public.branding_settings;
CREATE POLICY staff_read_branding ON public.branding_settings
  FOR SELECT TO authenticated USING (public.rma_is_staff());

DROP POLICY IF EXISTS "Anyone can read email templates" ON public.email_templates;
DROP POLICY IF EXISTS staff_read_email_templates ON public.email_templates;
CREATE POLICY staff_read_email_templates ON public.email_templates
  FOR SELECT TO authenticated USING (public.rma_is_staff());

-- Anyone signed in could enqueue an arbitrary email. The queue is drained by
-- the worker on the service role, which bypasses RLS, so staff-only insertion
-- does not affect delivery.
DROP POLICY IF EXISTS "System can insert into email queue" ON public.email_queue;
DROP POLICY IF EXISTS staff_insert_email_queue ON public.email_queue;
CREATE POLICY staff_insert_email_queue ON public.email_queue
  FOR INSERT TO authenticated WITH CHECK (public.rma_is_staff());

-- ═══ 4. Dormant anon policies ════════════════════════════════════════════════

DROP POLICY IF EXISTS "anon can read tickets for tracker" ON public.rma_tickets;
DROP POLICY IF EXISTS "anon can post customer comments"   ON public.ticket_comments;
DROP POLICY IF EXISTS "anon can read public comments"     ON public.ticket_comments;

-- Duplicate of notif_logs_staff_read, but TO PUBLIC rather than authenticated.
DROP POLICY IF EXISTS staff_read_notif_logs ON public.notification_logs;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- Refuse the whole migration if it would leave a core table with no read path.

DO $do$
DECLARE
  v_tbl text;
  v_n   integer;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'customers','products','rma_tickets','ticket_comments','user_roles',
    'custom_roles','brands','categories','subcategories','product_images',
    'branding_settings','email_templates'
  ] LOOP
    SELECT count(*) INTO v_n
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = v_tbl
       AND p.polcmd IN ('r', '*');
    IF v_n = 0 THEN
      RAISE EXCEPTION
        'Refusing to apply: % would have no SELECT policy left, making it unreadable to everyone. Nothing has been changed.', v_tbl;
    END IF;
  END LOOP;

  RAISE NOTICE 'Legacy permissive policies removed. Test ticket creation, comment editing, and customer creation as a sales rep.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260822_verify_no_blanket_policies.sql — it should
-- return zero rows.
