-- The created_by stamp from 20260819 never fired. Same-day correction.
-- (Audit finding BUG-011, follow-up.)
--
-- ── What went wrong ──────────────────────────────────────────────────────────
--
-- 20260819 added rma_stamp_created_by() with this guard, copied from the
-- settled-document trigger in 20260809:
--
--   IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
--
-- It matched on every call, so the function returned NEW untouched and a forged
-- `created_by` survived. The verifier caught it immediately:
--
--   FAIL  created_by kept forged value: forged@example.com
--
-- The reason is that `current_user` inside a SECURITY DEFINER function is the
-- function's OWNER, not the caller's effective role. Measured directly rather
-- than reasoned about:
--
--   outside the trigger : current_user = authenticated, session_user = postgres
--   inside  the trigger : current_user = postgres
--
-- So the discriminator that works correctly in a SECURITY INVOKER guard is
-- always true in a SECURITY DEFINER one. 20260809's guard is unaffected — that
-- trigger function is not SECURITY DEFINER — but the idiom does not transfer,
-- and this file exists partly to record that.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- The guard's purpose was to let server-side callers keep their own value: the
-- automation path in src/api/db/system.ts writes `created_by: 'system'`, and an
-- Edge Function may legitimately name a non-user author. Presence of a JWT email
-- is a better discriminator and is immune to SECURITY DEFINER:
--
--   service role / Edge Function / pg_cron  -> no JWT  -> email NULL -> value kept
--   any signed-in browser write             -> JWT     -> stamped with the actor
--   SECURITY DEFINER RPC called by a user   -> JWT     -> stamped with the actor
--
-- The last line is deliberate: an RPC acting on a user's behalf should record
-- that user, not the definer.
--
-- Note the browser's literal 'system' is still overwritten, as intended — that
-- label was a client-side fiction and is exactly the string an impersonator
-- would send. A genuine system sender has to come from server-side code, which
-- has no JWT and is therefore left alone.

CREATE OR REPLACE FUNCTION public.rma_stamp_created_by()
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
    NEW.created_by := v_email;
  END IF;
  RETURN NEW;
END;
$fn$;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF pg_get_functiondef('public.rma_stamp_created_by'::regproc) LIKE '%current_user NOT IN%' THEN
    RAISE EXCEPTION 'Refusing to finish: the broken current_user guard is still present.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_notifications_stamp_created_by')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_ticket_resolutions_stamp_created_by') THEN
    RAISE EXCEPTION 'Refusing to finish: a stamp trigger is missing; apply 20260819 first.';
  END IF;
  RAISE NOTICE 'created_by stamping now active on notifications and ticket_resolutions.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- supabase/manual/20260857_verify_viewer_write_lockdown.sql -> 11 passed, 0 failed.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- Restoring the current_user guard re-breaks the stamp. If created_by stamping
-- must be disabled, drop the two triggers instead.
