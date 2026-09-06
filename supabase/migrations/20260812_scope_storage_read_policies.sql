-- Stop anonymous enumeration of the attachment bucket.
-- (Audit finding BUG-003, part 2 of 2 — the read side.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- Two SELECT policies on storage.objects carried the expression `true`:
--
--   Allow public read 1gfjb3d_0          SELECT  PUBLIC         true
--   Allow authenticated delete 1gfjb3d_1 SELECT  authenticated  true   (misnamed)
--
-- The first applies to PUBLIC, which includes anon. So anybody holding the
-- publishable anon key — it ships in the browser bundle, so that is everybody —
-- could walk the whole bucket through the Storage list endpoint.
--
-- Measured at the HTTP layer, not inferred:
--
--   POST /storage/v1/object/list/rma-attachments  {"prefix":"","limit":100}
--   with only the anon key                        -> 15 entries
--   ...then {"prefix":"comments"}                 -> 1 entry
--
-- Walking the tree that way yields every object path: customer documents,
-- repair photos on RMA folders, avatars, brand and product assets.
--
-- ── What this does and does not fix ──────────────────────────────────────────
--
-- It closes ENUMERATION. It does not make the files secret, and this migration
-- would be misread if that were assumed.
--
-- The bucket has public = true, and for a public bucket storage-api serves the
-- bytes without consulting RLS at all. Measured, because the whole safety of
-- this change rests on it:
--
--   GET /storage/v1/object/public/rma-attachments/branding/<file>.png
--     with NO headers whatsoever  -> HTTP 200, 66396 bytes, image/png
--   GET /storage/v1/object/rma-attachments/branding/<file>.png
--     with NO headers whatsoever  -> HTTP 200, 66396 bytes
--
-- No key, therefore no role, therefore no policy was ever evaluated. That cuts
-- both ways, and both matter here:
--
--   * Nothing this migration does can break image rendering, PDF generation or
--     any stored getPublicUrl() link. They never depended on these policies.
--   * Anyone who already KNOWS a path keeps full access to it. Guessing one is
--     impractical (a millisecond timestamp and a random suffix), but a URL that
--     has been shared, logged, or sat in a browser history stays live.
--
-- Closing that second hole means making the bucket private and moving roughly
-- ten URL-bearing database columns onto signed URLs. That is a separate project
-- and is deliberately not attempted here; this migration is the part that can
-- be done today without touching application code.
--
-- ── Why the app is unaffected ────────────────────────────────────────────────
--
-- The client never uses the Storage read API: grep for `.list(`, `.download(`
-- and `createSignedUrl` across src/ returns nothing. Every read is an <img src>
-- or an <a href> against a public URL. No edge function touches storage either.
-- So the only caller these policies serve is a human with an API client.

-- ═══ 1. The blanket PUBLIC read ══════════════════════════════════════════════
-- This is the enumeration hole.

DROP POLICY IF EXISTS "Allow public read 1gfjb3d_0" ON storage.objects;

-- ═══ 2. The blanket authenticated read ═══════════════════════════════════════
-- Named "delete" but declared FOR SELECT — one of the pair of confusingly named
-- policies the Supabase dashboard generates. Replaced with a scoped equivalent
-- so staff keep API read access to the bucket they work in, and an authenticated
-- session with no user_roles row (a signed-up account nobody provisioned) gets
-- nothing.

DROP POLICY IF EXISTS "Allow authenticated delete 1gfjb3d_1" ON storage.objects;

CREATE POLICY staff_read_attachments ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'rma-attachments'
    AND public.rma_is_staff()
  );

COMMENT ON POLICY staff_read_attachments ON storage.objects IS
  'Storage API reads (list/info) for staff, scoped to the one bucket. Object CONTENT is served without RLS while the bucket is public, so this governs enumeration, not secrecy.';

-- ═══ 3. What is deliberately left ════════════════════════════════════════════
-- `anon can read comment attachments` (SELECT, anon, comments/ only) stays.
--
-- Strictly it is not needed: the public tracker renders attachments from public
-- URLs, which need no policy, and getPublicUrl() is string construction with no
-- network call. But the customer-facing upload path in that same folder is the
-- one flow here that is not staff-operated and not easy to exercise from SQL,
-- and breaking a customer's ability to attach a photo to their own RMA thread
-- is a worse outcome than the residue this leaves.
--
-- The residue, stated plainly so it is not mistaken for closed: an anonymous
-- caller can still enumerate the comments/ folder — one object today — and
-- fetch what it finds. Revisit when the bucket goes private, at which point
-- this policy and the anon upload policy should be reviewed together.

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  r        record;
  v_bad    text[] := ARRAY[]::text[];
  v_public boolean;
BEGIN
  -- 1. No SELECT policy may still be unconditional.
  FOR r IN
    SELECT p.polname AS pol
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'storage' AND c.relname = 'objects'
       AND p.polcmd IN ('r', '*')
       AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') NOT LIKE '%bucket_id%'
  LOOP
    v_bad := v_bad || format('SELECT policy %s is still unscoped', r.pol);
  END LOOP;

  -- 2. Staff must retain a read path, or an API client used by an admin breaks.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'storage' AND c.relname = 'objects'
       AND p.polname = 'staff_read_attachments'
  ) THEN
    v_bad := v_bad || 'staff_read_attachments was not created';
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'Refusing to apply: %. Nothing has been changed.', array_to_string(v_bad, '; ');
  END IF;

  -- 3. Not a failure, but the reader should know which regime they are in: if
  --    the bucket has since been made private, the reasoning in this file's
  --    header about content being served without RLS no longer holds.
  SELECT public INTO v_public FROM storage.buckets WHERE id = 'rma-attachments';
  IF v_public THEN
    RAISE NOTICE 'Enumeration closed. NOTE: the bucket is still public, so anyone who already knows an object path can still fetch it — see the header.';
  ELSE
    RAISE NOTICE 'Enumeration closed, and the bucket is private — content is no longer served without RLS.';
  END IF;
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- SQL:  supabase/manual/20260850_verify_storage_read_lockdown.sql
-- HTTP: re-run the list call from this file's header with only the anon key.
--       Before: 15 entries at the root prefix. After: 0.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP POLICY staff_read_attachments ON storage.objects;
--   CREATE POLICY "Allow public read 1gfjb3d_0" ON storage.objects
--     FOR SELECT TO public USING (true);
--   CREATE POLICY "Allow authenticated delete 1gfjb3d_1" ON storage.objects
--     FOR SELECT TO authenticated USING (true);
