-- BUG-067: a rate limit on the public tracker that actually persists.
--
-- ── What was there ──────────────────────────────────────────────────────────
--
-- Two limits, neither of them real:
--
--   1. The browser counted failed lookups in localStorage and locked itself for
--      15 minutes after 10. Clearing site data resets it, which takes a second
--      and no tools. It is a courtesy to honest users, not a defence, and the
--      code always said so.
--   2. The `public-track` function kept a per-IP token bucket in a module-level
--      Map. Edge functions are many short-lived instances: the bucket is empty
--      on every cold start, and two concurrent instances each grant the full
--      allowance. The comment there said "good enough for casual abuse" and
--      deferred a Redis-backed limiter.
--
-- So the only thing standing between someone and enumerating RMA numbers was
-- how often their requests happened to land on a warm instance.
--
-- ── What this is instead ────────────────────────────────────────────────────
--
-- The counter lives in the database the function is already talking to, so
-- there is no new dependency and no second system to pay for or operate. One
-- fixed window per caller, incremented atomically by an upsert so two instances
-- racing cannot both read 14 and both write 15.
--
-- ── Addresses are not stored ────────────────────────────────────────────────
--
-- The key is a SHA-256 of the address and a secret salt, computed in the
-- function. Hashing alone would be theatre — the whole IPv4 space is four
-- billion hashes, i.e. minutes of work — so the salt is what makes the digest
-- non-reversible. This table therefore holds no personal data: it cannot be
-- turned back into a list of who looked up what, only "this same unknown caller
-- again". That matters because the tracker is public and its users are
-- customers who never agreed to anything.

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'Refusing to apply: the service_role role does not exist, so nothing could call this.';
  END IF;
END
$do$;

-- ═══ The counter ═════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.public_track_rate_limit (
  ip_hash       text PRIMARY KEY,
  window_start  timestamptz NOT NULL DEFAULT now(),
  request_count integer     NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.public_track_rate_limit IS
  'Fixed-window request counts for the public RMA tracker, keyed by a salted hash of the caller''s address. No personal data: the hash is not reversible without the salt, which lives only in the Edge Function environment. (BUG-067.)';

-- RLS on with no policies at all: service_role bypasses RLS, and it is the only
-- thing that should ever read this. Belt and braces alongside the revokes.
ALTER TABLE public.public_track_rate_limit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.public_track_rate_limit FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_public_track_rate_limit_updated
  ON public.public_track_rate_limit (updated_at);

-- ═══ One hit ═════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_public_track_hit(
  p_ip_hash        text,
  p_limit          integer DEFAULT 15,
  p_window_seconds integer DEFAULT 60
)
RETURNS TABLE (allowed boolean, reset_in integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_now    timestamptz := now();
  v_window interval;
  v_row    public.public_track_rate_limit%ROWTYPE;
BEGIN
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN
    RAISE EXCEPTION 'rma_public_track_hit requires a key.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Clamp rather than trust: these arrive from the function's own code today,
  -- but a limit of 2 000 000 passed by accident would silently disable this.
  p_limit          := least(greatest(coalesce(p_limit, 15), 1), 10000);
  p_window_seconds := least(greatest(coalesce(p_window_seconds, 60), 1), 3600);
  v_window := make_interval(secs => p_window_seconds);

  -- One statement, so two instances racing cannot both read the same count.
  -- The window rolls over inside the UPDATE rather than in a separate check.
  INSERT INTO public.public_track_rate_limit AS r (ip_hash, window_start, request_count, updated_at)
       VALUES (p_ip_hash, v_now, 1, v_now)
  ON CONFLICT (ip_hash) DO UPDATE
     SET request_count = CASE WHEN r.window_start < v_now - v_window THEN 1
                              ELSE r.request_count + 1 END,
         window_start  = CASE WHEN r.window_start < v_now - v_window THEN v_now
                              ELSE r.window_start END,
         updated_at    = v_now
  RETURNING * INTO v_row;

  allowed  := v_row.request_count <= p_limit;
  reset_in := greatest(0, ceil(extract(epoch FROM (v_row.window_start + v_window) - v_now))::integer);

  -- Housekeeping, roughly once in a hundred calls. A dedicated cron job for a
  -- table that holds a few thousand rows of nothing is more moving parts than
  -- the problem deserves.
  IF random() < 0.01 THEN
    DELETE FROM public.public_track_rate_limit WHERE updated_at < v_now - interval '1 day';
  END IF;

  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_public_track_hit(text, integer, integer) FROM PUBLIC, anon, authenticated;
-- service_role is not a superuser; 20260841 removed the blanket default grants,
-- so this has to be said explicitly or the function is unreachable.
GRANT EXECUTE ON FUNCTION public.rma_public_track_hit(text, integer, integer) TO service_role;

-- ═══ Guard: it must count, and it must refuse ════════════════════════════════

DO $do$
DECLARE
  v_key   text := 'selftest-' || gen_random_uuid()::text;
  v_ok    boolean;
  v_reset integer;
  v_i     integer;
BEGIN
  FOR v_i IN 1..3 LOOP
    SELECT allowed, reset_in INTO v_ok, v_reset FROM public.rma_public_track_hit(v_key, 3, 60);
    IF NOT v_ok THEN
      RAISE EXCEPTION 'Refusing to finish: call % of 3 was refused under a limit of 3.', v_i;
    END IF;
  END LOOP;

  SELECT allowed, reset_in INTO v_ok, v_reset FROM public.rma_public_track_hit(v_key, 3, 60);
  IF v_ok THEN
    RAISE EXCEPTION 'Refusing to finish: the 4th call under a limit of 3 was allowed. The counter does not count.';
  END IF;
  IF v_reset <= 0 OR v_reset > 60 THEN
    RAISE EXCEPTION 'Refusing to finish: reset_in was %, which cannot be right for a 60s window.', v_reset;
  END IF;

  DELETE FROM public.public_track_rate_limit WHERE ip_hash = v_key;
  RAISE NOTICE 'BUG-067: rate limiter installed; 3 allowed then refused, reset_in %s.', v_reset;
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP FUNCTION public.rma_public_track_hit(text, integer, integer);
--   DROP TABLE public.public_track_rate_limit;
--   (and redeploy the previous public-track, which falls back to its in-memory
--    bucket on its own if the function is missing)
