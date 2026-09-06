-- Verify 20260812_scope_storage_read_policies.sql  (audit BUG-003, part 2)
--
-- Runs inside one transaction that ends in a RAISE, so nothing is committed. A
-- successful run ENDS IN AN ERROR whose message is the verdict. Read the
-- message, not the exit status.
--
-- Safe to run against production. Read-only apart from the rollback-protected
-- session settings it uses to impersonate each identity.
--
-- ── What this measures, and what it cannot ───────────────────────────────────
--
-- These counts are the RLS layer: how many rows of storage.objects each
-- identity can see. That is exactly what the Storage list endpoint is built on,
-- so it is the right proxy for "can this caller enumerate the bucket".
--
-- It is NOT a test of whether the files are secret. While the bucket is public,
-- object content is served with no key and no role at all, so anyone who
-- already knows a path keeps access regardless of every policy here. The
-- migration header records the measurement showing that. Do not read a PASS
-- below as "the attachments are private".
--
-- Run BEFORE the migration and you should see the failures it exists to fix
-- (anon seeing everything); run after and every line should read PASS.

DO $verify$
DECLARE
  v_tech      text;
  v_total     integer;
  v_comments  integer;
  v_anon      integer;
  v_staff     integer;
  v_stranger  integer;
  v_out       text := '';
BEGIN
  -- ── Baselines, read unscoped ───────────────────────────────────────────────
  SELECT user_email INTO v_tech
    FROM public.user_roles WHERE role = 'technician' AND status = 'active' LIMIT 1;

  IF v_tech IS NULL THEN
    RAISE EXCEPTION 'Cannot verify: no active technician to test staff access with.';
  END IF;

  SELECT count(*) INTO v_total
    FROM storage.objects WHERE bucket_id = 'rma-attachments';
  SELECT count(*) INTO v_comments
    FROM storage.objects
   WHERE bucket_id = 'rma-attachments'
     AND (storage.foldername(name))[1] = 'comments';

  -- ═══ 1. Anonymous: the enumeration hole this migration closes ══════════════
  -- Expected after the fix: only the comments/ folder, which is left open on
  -- purpose so the customer-facing tracker upload path is not disturbed.
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', NULL, true);
  SELECT count(*) INTO v_anon
    FROM storage.objects WHERE bucket_id = 'rma-attachments';

  IF v_anon = v_comments THEN
    v_out := v_out || format('PASS anon sees only comments/ (%s of %s). ', v_anon, v_total);
  ELSIF v_anon = 0 THEN
    v_out := v_out || format('PASS anon sees nothing (0 of %s) - stricter than required. ', v_total);
  ELSE
    v_out := v_out || format('FAIL anon can still enumerate %s of %s objects. ', v_anon, v_total);
  END IF;

  -- ═══ 2. Staff must keep API read access ════════════════════════════════════
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_tech, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_staff
    FROM storage.objects WHERE bucket_id = 'rma-attachments';

  IF v_staff = v_total THEN
    v_out := v_out || format('PASS a technician still sees all %s objects. ', v_staff);
  ELSE
    v_out := v_out || format('FAIL a technician sees %s of %s - staff read was over-narrowed. ', v_staff, v_total);
  END IF;

  -- ═══ 3. A signed-in account with no user_roles row gets nothing ════════════
  -- There is one such account in auth.users today (BUG-018): an auth user the
  -- two-step create flow never provisioned a role for.
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', 'no-such-user-probe@example.invalid', 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_stranger
    FROM storage.objects WHERE bucket_id = 'rma-attachments';

  IF v_stranger = 0 THEN
    v_out := v_out || 'PASS an unprovisioned account sees nothing.';
  ELSE
    v_out := v_out || format('FAIL an unprovisioned account sees %s objects.', v_stranger);
  END IF;

  RAISE EXCEPTION 'VERIFY 20260812 (rolled back) :: %', v_out;
END
$verify$;

-- ─── HTTP follow-up: the actual attack path ──────────────────────────────────
-- The counts above are the RLS layer. Confirm the endpoint an attacker would
-- really use, with nothing but the publishable anon key:
--
--   curl -s -X POST \
--     'https://<project>.supabase.co/storage/v1/object/list/rma-attachments' \
--     -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--     -H 'Content-Type: application/json' \
--     -d '{"prefix":"","limit":100}'
--
--   Before this migration: 15 entries (the full top-level folder tree).
--   After:                 0 entries.
--
-- And the part that does NOT change while the bucket is public — a known path
-- is still fetchable with no credentials at all:
--
--   curl -sI 'https://<project>.supabase.co/storage/v1/object/public/rma-attachments/<known path>'
--     -> HTTP 200, before and after.
--
-- That is expected, and is the remaining work: private bucket plus signed URLs.
