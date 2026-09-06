-- Let admins actually cancel a queued notification.
-- (Found 2026-09-06 while scoping BUG-008; filed as BUG-080.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- `notification_queue` has `admin_read_notif_queue` (SELECT, admin) and
-- `staff_insert_notif_queue` (INSERT) but **no UPDATE policy at all**. RLS is
-- enabled, so an absent policy is a deny: nobody, including a super_admin, can
-- update a row from the browser.
--
-- The WhatsApp queue screen offers the action anyway. Both of these are
-- unconditional no-ops today:
--
--   src/api/db/whatsappNotifications.ts:352
--     .update({ status: 'cancelled' }).eq('id', id)          -- Cancel
--   src/api/db/whatsappNotifications.ts:357
--     .update({ status: 'cancelled' }).eq('status', status)  -- Cancel all
--
-- PostgREST reports an RLS-filtered UPDATE as `200 []`, and neither call site
-- inspects the row count, so the button reports success and nothing changes —
-- the same failure shape as BUG-008, which is how this surfaced.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- Add the missing UPDATE policy, scoped to admins to match the SELECT policy
-- that already governs this table. Deliberately not narrowed to
-- `status = 'cancelled'`: an admin managing a stuck queue also needs to requeue
-- a failed job, and a policy that only permitted cancellation would produce the
-- next silent no-op the moment that button is added.
--
-- The queue is drained by the notification-worker Edge Function using the
-- service role, which bypasses RLS entirely, so this does not affect delivery.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='notification_queue') THEN
    RAISE EXCEPTION 'Refusing to apply: public.notification_queue does not exist.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
              WHERE c.relname='notification_queue' AND pol.polcmd IN ('w','*')) THEN
    RAISE EXCEPTION
      'Refusing to apply: an UPDATE (or ALL) policy already exists on notification_queue. Review it before adding another.';
  END IF;
END
$do$;

-- ═══ The policy ══════════════════════════════════════════════════════════════

CREATE POLICY admin_update_notif_queue ON public.notification_queue
  FOR UPDATE TO public
  USING (public.rma_is_admin())
  WITH CHECK (public.rma_is_admin());

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
                  WHERE c.relname='notification_queue' AND pol.polname='admin_update_notif_queue') THEN
    RAISE EXCEPTION 'Refusing to finish: the policy was not created.';
  END IF;
  RAISE NOTICE 'notification_queue: admins can now cancel or requeue a job.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Rolled-back probe: as an admin, UPDATE a queued row -> 1 row; as a viewer or
-- technician -> 0 rows.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP POLICY admin_update_notif_queue ON public.notification_queue;
-- which returns the Cancel buttons to silently doing nothing.
