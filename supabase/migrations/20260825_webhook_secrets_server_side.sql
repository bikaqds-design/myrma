-- Take webhook signing secrets out of the browser.
-- (Audit finding BUG-009, database half.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- `webhooks.list()` in src/api/db/system.ts did `select('*')`, and
-- `src/pages/cp/Integrations.jsx:63` loaded the result straight into a form
-- input. So every administrator's browser held every webhook's `secret_key` —
-- the value a receiver uses to verify that a delivery genuinely came from us.
--
-- Fixing only the client would not close this. The `admin_all` policy grants
-- admins full access to the row, so an administrator could simply request
-- `GET /rest/v1/webhooks?select=secret_key` and read it back regardless of what
-- our own code selects. The privilege has to be removed at the database.
--
-- Nothing is being migrated: `SELECT count(*) FROM webhooks` is **0**, so no
-- secret has ever actually been exposed. This is being closed before the
-- feature is used rather than after.
--
-- ── What this does ───────────────────────────────────────────────────────────
--
--   1. Replaces `authenticated`'s table-level SELECT with an explicit
--      column-list grant that omits `secret_key`. Reads of the secret now come
--      only from the Edge Function, which uses the service role.
--
--      A column-level REVOKE alone does NOT work here, and the guard below
--      caught that on the first attempt: Postgres treats a table-level SELECT
--      grant as covering every column, and `REVOKE SELECT (secret_key)` against
--      it is silently a no-op. The table grant has to go first.
--   2. Adds `has_secret`, a stored generated column, so the Control Panel can
--      still show *whether* a secret is configured without being able to read
--      it. A generated column is its own column for privilege purposes, so it
--      stays readable while its source does not.
--
-- ── Consequence for callers, which is deliberate ─────────────────────────────
--
-- `SELECT *` on this table now fails for `authenticated` with "permission
-- denied for column secret_key" — Postgres refuses the whole statement rather
-- than silently dropping the column. That is the point: it turns a silent
-- disclosure into a loud failure, and any client that wants webhook rows must
-- name its columns. `webhooks.list()` was changed to do exactly that in the
-- same commit.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='webhooks') THEN
    RAISE EXCEPTION 'Refusing to apply: public.webhooks does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid='public.webhooks'::regclass
                    AND attname='secret_key' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Refusing to apply: webhooks.secret_key does not exist.';
  END IF;
END
$do$;

-- ═══ has_secret ══════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid='public.webhooks'::regclass
                AND attname='has_secret' AND NOT attisdropped) THEN
    RAISE NOTICE 'webhooks.has_secret already exists; nothing to do.';
  ELSE
    ALTER TABLE public.webhooks
      ADD COLUMN has_secret boolean
      GENERATED ALWAYS AS (secret_key IS NOT NULL AND secret_key <> '') STORED;
    RAISE NOTICE 'webhooks.has_secret added.';
  END IF;
END
$do$;

-- ═══ Revoke the secret from every client role ════════════════════════════════

-- Drop the blanket grant, then hand back every column except the secret.
-- `anon` holds no SELECT on this table at all, so there is nothing to revoke.
REVOKE SELECT ON public.webhooks FROM authenticated;

GRANT SELECT (
  id, name, url, events, is_active,
  last_triggered_at, created_by, created_date, updated_date, has_secret
) ON public.webhooks TO authenticated;

-- Writes are unaffected: an admin must still be able to SET a secret, they just
-- cannot read one back. UPDATE and INSERT privileges are left as they were.
--
-- MAINTENANCE NOTE: this grant is a fixed column list. A column added to
-- `webhooks` later will NOT be readable by the Control Panel until it is added
-- here. That is the trade for keeping one column private, and failing closed on
-- a new column is the safer direction.

-- ═══ Guard: the secret is unreadable, the rest still is ══════════════════════

DO $do$
DECLARE
  v_can_read_secret boolean;
  v_can_read_url    boolean;
  v_can_read_flag   boolean;
BEGIN
  v_can_read_secret := has_column_privilege('authenticated', 'public.webhooks', 'secret_key', 'SELECT');
  v_can_read_url    := has_column_privilege('authenticated', 'public.webhooks', 'url',        'SELECT');
  v_can_read_flag   := has_column_privilege('authenticated', 'public.webhooks', 'has_secret', 'SELECT');

  IF v_can_read_secret THEN
    RAISE EXCEPTION 'Refusing to finish: authenticated can still read webhooks.secret_key.';
  END IF;
  IF NOT v_can_read_url THEN
    RAISE EXCEPTION 'Refusing to finish: authenticated lost read access to webhooks.url - the Control Panel would break.';
  END IF;
  IF NOT v_can_read_flag THEN
    RAISE EXCEPTION 'Refusing to finish: authenticated cannot read webhooks.has_secret.';
  END IF;
  IF NOT has_column_privilege('service_role', 'public.webhooks', 'secret_key', 'SELECT') THEN
    RAISE EXCEPTION 'Refusing to finish: service_role cannot read secret_key - the dispatch function could not sign anything.';
  END IF;

  RAISE NOTICE 'BUG-009: webhook secrets are now server-side only; has_secret exposes presence without value.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Rolled-back probe as a live admin:
--   SELECT * FROM webhooks;            -> permission denied for column secret_key
--   SELECT id, url, has_secret ...     -> succeeds
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   GRANT SELECT (secret_key) ON public.webhooks TO authenticated;
--   ALTER TABLE public.webhooks DROP COLUMN has_secret;
-- which puts the signing secrets back in every admin's browser.
