-- Give the notification drain a credential, so it can actually run.
-- (Audit finding BUG-005. Apply AFTER 20260816, never before.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- The job scheduled by 20260604 posts to the notification-worker function with
-- these headers and nothing else:
--
--   {"Content-Type": "application/json", "x-trigger-source": "pg_cron"}
--
-- No Authorization. The function is deployed with verify_jwt on, so the API
-- gateway rejects the request before any of the function's own code runs. Every
-- execution since it was created has failed the same way:
--
--   SELECT status_code, count(*) FROM net._http_response GROUP BY 1;
--   -> 401, {"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}
--
-- The queueing half of the system is healthy and has been adding work the whole
-- time; only delivery was broken. Notifications have therefore gone out only
-- when somebody happened to use the app, because the browser fires the worker
-- after ticket events.
--
-- ── Why x-trigger-source is no longer enough ─────────────────────────────────
--
-- The function used to admit a caller who sent `x-trigger-source: pg_cron` with
-- no Authorization header at all — which is how this job was meant to get in,
-- and also meant anyone holding the publishable anon key could drain the queue.
-- That branch was removed in BUG-022, so the job now needs a real credential
-- like every other caller.
--
-- ── Two headers, two different jobs ──────────────────────────────────────────
--
--   Authorization   satisfies the API gateway's verify_jwt. Any valid project
--                   JWT does; the publishable anon key is the natural choice
--                   because it grants nothing on its own.
--   x-worker-secret what the FUNCTION authorises on. This is the real
--                   credential and the only one that matters.
--
-- Both are read from Vault at call time rather than written into the job body,
-- because cron.job is readable by anyone who can read the catalog.
--
-- ── Prerequisites, which this migration refuses to run without ───────────────
--
--   1. Set the secret on the function:
--        npx supabase secrets set WORKER_SECRET="$(openssl rand -hex 32)"
--      Keep the value; step 2 needs the same one. Note the function's check is
--      `workerSecret && providedSecret === workerSecret`, so if this is unset
--      the branch can never match and the job is refused — which is the right
--      direction to fail, but it means this step is not optional.
--
--   2. Put the same value in Vault, plus the anon key:
--        SELECT vault.create_secret('<same value>', 'notification_worker_secret',
--                                   'Shared secret the pg_cron drain presents to notification-worker');
--        SELECT vault.create_secret('<publishable anon key>', 'anon_key',
--                                   'Publishable key, used only to satisfy the Functions gateway');
--
--   3. Apply 20260816 first. It bounds the reminder loop and clears the 341-job
--      backlog. Running this migration before it delivers all of them at once.

-- ═══ Guard: prerequisites ════════════════════════════════════════════════════
-- Checked before anything is changed, so running this too early is a no-op with
-- an explanation rather than a broken schedule.

DO $do$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_backlog integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'notification_worker_secret') THEN
    v_missing := v_missing || 'notification_worker_secret';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'anon_key') THEN
    v_missing := v_missing || 'anon_key';
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: these Vault secrets do not exist yet: %. See the prerequisites at the top of this file. Nothing has been changed.',
      array_to_string(v_missing, ', ');
  END IF;

  SELECT count(*) INTO v_backlog
    FROM public.notification_queue
   WHERE status = 'pending' AND event_type = 'ticket.overdue';

  IF v_backlog > 10 THEN
    RAISE EXCEPTION
      'Refusing to apply: % overdue reminders are still queued. Apply 20260816 first — turning the drain on now would deliver all of them at once. Nothing has been changed.',
      v_backlog;
  END IF;
END
$do$;

-- ═══ Reschedule ══════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-notification-queue') THEN
    PERFORM cron.unschedule('drain-notification-queue');
  END IF;
END
$do$;

SELECT cron.schedule(
  'drain-notification-queue',
  '*/2 * * * *',
  $cron$
  SELECT net.http_post(
    url                   := 'https://ohkynosgscfygtjxbpxq.supabase.co/functions/v1/notification-worker',
    headers               := jsonb_build_object(
      'Content-Type',     'application/json',
      'Authorization',    'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key'),
      'x-worker-secret',  (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'notification_worker_secret'),
      'x-trigger-source', 'pg_cron'
    ),
    body                  := '{}'::jsonb,
    -- pg_net's default is 5000ms. The worker processes up to BATCH_SIZE (10)
    -- jobs per run with a 200ms rate-limit pause between WhatsApp sends, plus
    -- real external API latency (Meta, Resend) — comfortably over 5s. Found
    -- live on the first run after this went in: pg_net reported "Timeout of
    -- 5000 ms reached" while the function kept running server-side regardless
    -- (jobs completed several seconds after pg_net gave up waiting), so the
    -- timeout was purely a client-side observability gap, not a real failure —
    -- but it meant net._http_response could never show the 200 this file's own
    -- verification notes promised to look for. 30s is generous for one batch.
    timeout_milliseconds  := 30000
  );
  $cron$
);

-- ═══ Guard: the job now carries a credential ═════════════════════════════════

DO $do$
DECLARE
  v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'drain-notification-queue';

  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: the job was not scheduled. Nothing has been changed.';
  END IF;
  IF v_cmd NOT LIKE '%x-worker-secret%' OR v_cmd NOT LIKE '%Authorization%' THEN
    RAISE EXCEPTION 'Refusing to apply: the rescheduled job is missing a credential header. Nothing has been changed.';
  END IF;
  -- Neither secret may appear literally in the job body.
  IF v_cmd LIKE '%eyJ%' THEN
    RAISE EXCEPTION 'Refusing to apply: a key appears to be inlined in the job body instead of read from Vault. Nothing has been changed.';
  END IF;

  RAISE NOTICE 'Drain rescheduled with Vault-backed credentials. Watch net._http_response for 200s replacing the 401s.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Within about two minutes:
--
--   SELECT status_code, count(*), max(created) AS latest
--     FROM net._http_response GROUP BY 1 ORDER BY 3 DESC;
--
--   SELECT status, count(*) FROM notification_queue GROUP BY 1;
--
-- A 200 means the worker ran. A 401 now means the secret in Vault and the
-- secret on the function do not match — they are two separate stores and both
-- have to be set from the same value.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   SELECT cron.unschedule('drain-notification-queue');
-- which returns the system to "queued but never delivered" — the state this
-- migration exists to end, so prefer fixing the credential over rolling back.
