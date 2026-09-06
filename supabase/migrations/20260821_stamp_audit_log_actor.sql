-- Make the audit trail non-forgeable.
-- (Audit finding BUG-019.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- `user_activity_log.auth_insert` is `WITH CHECK (rma_is_authenticated())` and
-- `user_email` is free text, so any signed-in account can write:
--
--   POST /rest/v1/user_activity_log
--   {"user_email":"admin@example.com","action_type":"payment_voided", ...}
--
-- The log admins rely on can therefore be poisoned, or used to frame a
-- colleague. 627 rows, 5 distinct actors today.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- A BEFORE INSERT trigger stamps `user_email` from the JWT, the same shape as
-- the existing `stock_moves_stamp_actor` and as `rma_stamp_created_by` added in
-- 20260819/20260820. The policy is left alone: any authenticated staff member
-- may still append to the log, they simply cannot choose whose name is on it.
--
-- The discriminator is the presence of a JWT email, NOT `current_user`. Inside a
-- SECURITY DEFINER function `current_user` is the function's owner ('postgres'),
-- so a `current_user NOT IN ('authenticated','anon')` guard is always true there
-- and silently disables the whole trigger — measured on 2026-09-06, and the
-- reason 20260820 exists. Server-side callers (service role, Edge Functions,
-- pg_cron) carry no JWT, so they keep whatever they set.
--
-- ── Known interaction, deliberately left for the client fix ──────────────────
--
-- `src/api/db/audit.ts` queues failed writes to localStorage and replays them on
-- the next successful write (`auditFlushQueue`, line 36). The queue is
-- per-browser, not per-user, so entries enqueued by A can be flushed while B is
-- signed in. Today that records A's name in B's session; with this trigger it
-- records B's. Both are wrong, and neither is a forgery — the fix belongs on the
-- client, in two parts that ship with the next front-end deploy:
--
--   1. `App.jsx:790-793` calls `auth.signOut()` and THEN logs 'logout'. After
--      sign-out there is no session, so that insert is always refused and always
--      queued. Logging before sign-out removes the main source of queued rows.
--   2. `auditFlushQueue` should drop entries whose `user_email` is not the
--      current user rather than replaying them under someone else's identity.
--
-- Until those ship, a queued entry replayed by a different user is attributed to
-- the replayer instead of the original actor. That is a change in behaviour and
-- is recorded here rather than discovered later.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='user_activity_log') THEN
    RAISE EXCEPTION 'Refusing to apply: public.user_activity_log does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid='public.user_activity_log'::regclass
                    AND attname='user_email' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Refusing to apply: user_activity_log.user_email does not exist.';
  END IF;
END
$do$;

-- ═══ Stamp ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_stamp_activity_actor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_email text;
BEGIN
  v_email := public.rma_current_user_email();
  IF v_email IS NOT NULL AND v_email <> '' THEN
    NEW.user_email := v_email;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_user_activity_log_stamp_actor ON public.user_activity_log;
CREATE TRIGGER trg_user_activity_log_stamp_actor
  BEFORE INSERT ON public.user_activity_log
  FOR EACH ROW EXECUTE FUNCTION public.rma_stamp_activity_actor();

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_user_activity_log_stamp_actor') THEN
    RAISE EXCEPTION 'Refusing to finish: the stamp trigger was not created.';
  END IF;
  IF pg_get_functiondef('public.rma_stamp_activity_actor'::regproc) LIKE '%current_user NOT IN%' THEN
    RAISE EXCEPTION 'Refusing to finish: current_user guard present - it is always true inside SECURITY DEFINER.';
  END IF;
  RAISE NOTICE 'BUG-019: user_activity_log.user_email is now stamped from the JWT.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- supabase/manual/20260858_verify_audit_log_stamp.sql
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_user_activity_log_stamp_actor ON public.user_activity_log;
-- which restores a forgeable audit trail.
