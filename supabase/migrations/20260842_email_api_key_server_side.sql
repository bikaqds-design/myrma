-- Take the Resend API key out of administrators' browsers.
-- (Audit finding BUG-059.)
--
-- !! APPLY TOGETHER WITH THE FRONT-END DEPLOY THAT CHANGES src/api/email.js !!
-- The front-end in production before that deploy loads settings with
-- `select('*')`, which this migration makes Postgres refuse (verified — see
-- below). Apply this immediately after that deploy is live, not before.
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- `email_settings.api_key` holds the live Resend key (production has one row and
-- a 36-character key). The `admin_all` policy gives administrators the whole row,
-- `getEmailSettings()` requested `select('*')`, and the Email Settings tab put the
-- key into an input field. So the key sat in every administrator's browser, where
-- any script injected into the app could read it, and the help text beside the
-- field said it was "never exposed to the frontend".
--
-- Fixing only the client would not close it: an administrator's session can ask
-- PostgREST for `?select=api_key` directly. The privilege has to go.
--
-- ── What this does (the BUG-009 webhook-secret pattern) ──────────────────────
--
--   1. Adds `has_api_key`, a stored generated column, so the screen can show
--      THAT a key is saved without being able to read it.
--   2. Replaces authenticated's table-level SELECT with a column list that omits
--      api_key. A column-level REVOKE alone is a silent no-op against a
--      table-level grant, so the table grant goes first.
--   3. Leaves INSERT and UPDATE alone: an administrator can still set a new key,
--      just not read one back. `send-email` reads it with the service role.
--
-- ── Verified before being written (rolled-back probe, 7 passed, 0 failed) ────
--   the admin reads settings and has_api_key = true; SELECT api_key is refused;
--   select('*') is refused; saving without the key succeeds and the key survives;
--   the admin can replace the key; RETURNING * is refused, so clients must name
--   columns after a write; service_role can still read api_key.

DO $do$
BEGIN
  IF to_regclass('public.email_settings') IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: public.email_settings does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.email_settings'::regclass AND attname = 'api_key' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Refusing to apply: email_settings.api_key does not exist.';
  END IF;
END
$do$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.email_settings'::regclass AND attname = 'has_api_key' AND NOT attisdropped) THEN
    RAISE NOTICE 'email_settings.has_api_key already exists.';
  ELSE
    ALTER TABLE public.email_settings
      ADD COLUMN has_api_key boolean
      GENERATED ALWAYS AS (api_key IS NOT NULL AND btrim(api_key) <> '') STORED;
  END IF;
END
$do$;

REVOKE SELECT ON public.email_settings FROM authenticated;

GRANT SELECT (id, provider, from_email, from_name, is_active, updated_by, updated_date, has_api_key)
  ON public.email_settings TO authenticated;

-- MAINTENANCE NOTE: a fixed column list. A column added to email_settings later
-- is not readable by the settings screen until it is added here — failing closed
-- on a new column is the safer direction for a table that holds credentials.

DO $do$
BEGIN
  IF has_column_privilege('authenticated', 'public.email_settings', 'api_key', 'SELECT') THEN
    RAISE EXCEPTION 'Refusing to finish: authenticated can still read email_settings.api_key.';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.email_settings', 'has_api_key', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.email_settings', 'from_email', 'SELECT') THEN
    RAISE EXCEPTION 'Refusing to finish: the settings screen lost read access to the columns it shows.';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.email_settings', 'api_key', 'UPDATE') THEN
    RAISE EXCEPTION 'Refusing to finish: administrators could no longer set a new key.';
  END IF;
  IF NOT has_column_privilege('service_role', 'public.email_settings', 'api_key', 'SELECT') THEN
    RAISE EXCEPTION 'Refusing to finish: service_role cannot read api_key, so send-email would stop working.';
  END IF;
  RAISE NOTICE 'BUG-059: the Resend key is server-side only; has_api_key shows presence without value.';
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   GRANT SELECT (api_key) ON public.email_settings TO authenticated;
--   ALTER TABLE public.email_settings DROP COLUMN has_api_key;
-- which puts the key back in every administrator's browser.
