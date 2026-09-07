-- Drop the vestigial credential column.
-- (Audit finding BUG-039.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- `user_roles.password_hash` is left over from the Base44 era, before
-- authentication moved to Supabase Auth. Nothing writes it, nothing reads it,
-- and nothing authenticates against it — but it still held one live value:
--
--   SELECT count(password_hash) FROM user_roles;  -> 1
--
-- That value is 64 hex characters, i.e. an unsalted SHA-256. A password hashed
-- that way is cheap to attack offline, and people reuse passwords, so the risk
-- is not limited to this application. It was readable by any administrator
-- through `listAllRoles()` and was copied into every backup export (BUG-025).
--
-- A credential store nobody maintains is worse than no credential store: it
-- carries all of the risk and none of the benefit.
--
-- ── Why dropping is safe ─────────────────────────────────────────────────────
--
--   * No reference in `src/**` or `supabase/functions/**` — the only mention is
--     a comment in src/api/db/users.ts noting it is legacy.
--   * Authentication is entirely Supabase Auth. The guard below refuses to run
--     if any row that actually CARRIES a hash lacks a Supabase Auth account —
--     that being the only population for whom the column could still be
--     load-bearing.
--
--     A first version of this guard demanded an auth account for EVERY active
--     row and was refused: 10 active rows have none. They are all the
--     `@test.com` seed fixtures from 20260706 whose purge is deferred, and not
--     one of them carries a hash, so they cannot authenticate by any route and
--     dropping the column changes nothing for them. Measured before narrowing
--     the check rather than assumed.
--
-- This is deliberately irreversible: the point is to destroy the hash, so no
-- rollback restores the value. Recreating the column would give back an empty
-- one.

-- ═══ Guard: nothing authenticates via this column ════════════════════════════

DO $do$
DECLARE
  v_orphans integer;
  v_hashes  integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid='public.user_roles'::regclass
                    AND attname='password_hash' AND NOT attisdropped) THEN
    RAISE NOTICE 'user_roles.password_hash already dropped; nothing to do.';
    RETURN;
  END IF;

  -- The only population for whom this column could still matter: a row that
  -- holds a hash AND has no Supabase Auth account to sign in with instead.
  SELECT count(*) INTO v_orphans
    FROM public.user_roles r
   WHERE r.password_hash IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(r.user_email));

  SELECT count(password_hash) INTO v_hashes FROM public.user_roles;

  IF v_orphans > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: % row(s) hold a password_hash but have no auth.users account, so this column may still be their only credential. Nothing has been changed.',
      v_orphans;
  END IF;

  RAISE NOTICE 'Dropping password_hash (% value(s) will be destroyed).', v_hashes;
END
$do$;

-- ═══ Drop ════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_roles DROP COLUMN IF EXISTS password_hash;

-- ═══ Guard: it is gone ═══════════════════════════════════════════════════════

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid='public.user_roles'::regclass
                AND attname='password_hash' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Refusing to finish: user_roles.password_hash still exists.';
  END IF;
  RAISE NOTICE 'BUG-039: legacy password_hash column dropped.';
END
$do$;

-- ─── Note for the backup/restore path ────────────────────────────────────────
-- src/api/backup.js exports user_roles column-by-column via `select('*')`, so
-- it picks up the new shape automatically. An OLD backup file taken before this
-- migration still contains the hash — those files should be deleted rather than
-- kept, and that is BUG-025's remaining work.
