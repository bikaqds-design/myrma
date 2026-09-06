-- Scope the storage write policies and give the bucket real limits.
-- (Audit finding BUG-003, part 1 of 2 — nothing here touches the read path.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- Three policies on storage.objects carried the expression `true`, with no
-- condition on the bucket, the path or the caller:
--
--   Allow authenticated uploads 1gfjb3d_0   INSERT  authenticated  true
--   Allow authenticated delete 1gfjb3d_0    DELETE  authenticated  true
--   Allow authenticated delete 1gfjb3d_1    SELECT  authenticated  true
--
-- So any signed-in account, `viewer` included, could upload a file of any size
-- and any type, and could delete or overwrite any object in any bucket —
-- another user's avatar, a customer's signed document, the company logo.
--
-- The bucket itself had no limits either: file_size_limit and
-- allowed_mime_types were both NULL, so the only checks were in the browser,
-- in a validateAttachment() that trusts `file.type` from the client and that
-- three of the eleven upload helpers never call at all.
--
-- The repository already contains the policy set this should have been —
-- 20260527_storage_bucket_policies.sql — but it was never applied. This is the
-- second place the audit found the migration files describing a database that
-- does not exist (see BUG-014).
--
-- ── What is safe to change here, and what waits ──────────────────────────────
--
-- Reads are deliberately untouched by this migration. The bucket is public, so
-- object CONTENT is served from /storage/v1/object/public/... without consulting
-- RLS at all; narrowing the SELECT policies changes who can ENUMERATE the
-- bucket, not who can fetch a known URL. That is a real and serious hole —
-- measured: an anonymous caller can currently list all 41 objects — but it is
-- the only part of this work with any chance of affecting what renders in the
-- app, so it goes in on its own in 20260812 where a rollback is unambiguous.
--
-- Turning the bucket private and moving to signed URLs is a larger project
-- again: every upload helper stores a getPublicUrl() result in a database
-- column, so roughly ten columns hold URLs that would all stop resolving. That
-- is tracked separately and is not attempted here.
--
-- ── Who legitimately writes ──────────────────────────────────────────────────
--
-- Uploads: eleven helpers in src/api/storage.js and src/api/branding.js, all
-- called from staff screens. Deletes: exactly two callers — removing a ticket
-- attachment (RMATickets/TicketForm.jsx) and the Trash sweep in
-- lib/documentTrash.js, which runs as whichever staff member opens the Vault.
-- Neither is owner-scoped in the interface, and a manager tidying up after a
-- colleague is normal, so these are scoped to non-viewer staff rather than to
-- the uploader.
--
-- Anonymous uploads into comments/ stay: that is the public tracker letting a
-- customer attach a photo to their own RMA thread. What changes for them is the
-- bucket limits below, which the storage API enforces for every caller
-- including anon — a far more reliable check than the RLS metadata condition
-- 20260527 proposed, because bucket limits are applied by storage-api before
-- the object row exists.

-- ═══ 1. Uploads ══════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow authenticated uploads 1gfjb3d_0" ON storage.objects;

CREATE POLICY staff_upload_attachments ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'rma-attachments'
    AND public.rma_is_staff()
    AND public.rma_user_role() <> 'viewer'
  );

-- ═══ 2. Overwrites ═══════════════════════════════════════════════════════════
-- uploadAvatar() and customers.uploadPhoto() both pass { upsert: true }, which
-- the storage API turns into an UPDATE of the existing object row. There was no
-- UPDATE policy at all, so replacing an avatar could only ever have failed.
-- Added scoped rather than left absent: the feature plainly intends to work,
-- and a policy identical to the upload one grants nothing further.

DROP POLICY IF EXISTS staff_overwrite_attachments ON storage.objects;

CREATE POLICY staff_overwrite_attachments ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'rma-attachments'
    AND public.rma_is_staff()
    AND public.rma_user_role() <> 'viewer'
  )
  WITH CHECK (
    bucket_id = 'rma-attachments'
    AND public.rma_is_staff()
    AND public.rma_user_role() <> 'viewer'
  );

-- ═══ 3. Deletes ══════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Allow authenticated delete 1gfjb3d_0" ON storage.objects;

CREATE POLICY staff_delete_attachments ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'rma-attachments'
    AND public.rma_is_staff()
    AND public.rma_user_role() <> 'viewer'
  );

-- ═══ 4. Bucket limits ════════════════════════════════════════════════════════
-- Enforced by storage-api for every upload, whatever the caller's role, and
-- therefore the only one of these checks a modified client cannot skip.
--
-- 25 MB matches MAX_ATTACHMENT_SIZE in src/api/storage.js. The largest object
-- in the bucket today is 1.05 MB, so nothing existing is near it.
--
-- The type list is the app's own ALLOWED_ATTACHMENT_TYPES plus the two icon
-- types the favicon picker accepts, plus avif and bmp because several pickers
-- use accept="image/*" and resizeImage() only re-encodes jpeg, png and webp —
-- everything else reaches storage as whatever the browser produced.
--
-- image/svg+xml is deliberately NOT here. An SVG is a script carrier, and this
-- bucket is public, so it would be hosted and executable on the storage origin.
-- The favicon input's accept attribute is narrowed to match in the same commit.
-- Adding a format later is a one-line change to this array.

UPDATE storage.buckets
   SET file_size_limit = 25 * 1024 * 1024,
       allowed_mime_types = ARRAY[
         'image/jpeg',
         'image/png',
         'image/gif',
         'image/webp',
         'image/avif',
         'image/bmp',
         'image/x-icon',
         'image/vnd.microsoft.icon',
         'application/pdf',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'text/plain',
         'text/csv'
       ]
 WHERE id = 'rma-attachments';

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_bad    text[] := ARRAY[]::text[];
  v_bucket record;
  r        record;
BEGIN
  -- 1. No write policy may still be unconditional.
  FOR r IN
    SELECT p.polname AS pol, p.polcmd AS cmd
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'storage' AND c.relname = 'objects'
       AND p.polcmd IN ('a', 'w', 'd')
       AND coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') NOT LIKE '%bucket_id%'
  LOOP
    v_bad := v_bad || format('write policy %s is not scoped to a bucket', r.pol);
  END LOOP;

  -- 2. The bucket must now carry both limits.
  SELECT file_size_limit, allowed_mime_types INTO v_bucket
    FROM storage.buckets WHERE id = 'rma-attachments';

  IF v_bucket.file_size_limit IS NULL THEN
    v_bad := v_bad || 'bucket still has no file_size_limit';
  END IF;
  IF v_bucket.allowed_mime_types IS NULL THEN
    v_bad := v_bad || 'bucket still has no allowed_mime_types';
  END IF;

  -- 3. Every MIME type already in the bucket must remain uploadable, or the
  --    next edit of an existing record fails on a file type it accepted before.
  FOR r IN
    SELECT DISTINCT o.metadata->>'mimetype' AS mt
      FROM storage.objects o
     WHERE o.bucket_id = 'rma-attachments'
       AND o.metadata->>'mimetype' IS NOT NULL
  LOOP
    IF NOT (r.mt = ANY(v_bucket.allowed_mime_types)) THEN
      v_bad := v_bad || format('%s is already stored but is no longer allowed', r.mt);
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'Refusing to apply: %. Nothing has been changed.', array_to_string(v_bad, '; ');
  END IF;

  RAISE NOTICE 'Storage writes scoped to non-viewer staff on rma-attachments; bucket limited to 25 MB and 15 MIME types.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260849_verify_storage_write_lockdown.sql.
-- Then, in the app: upload a ticket attachment as a technician (should work)
-- and confirm a viewer has no upload control.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP POLICY staff_upload_attachments    ON storage.objects;
--   DROP POLICY staff_overwrite_attachments ON storage.objects;
--   DROP POLICY staff_delete_attachments    ON storage.objects;
--   CREATE POLICY "Allow authenticated uploads 1gfjb3d_0" ON storage.objects
--     FOR INSERT TO authenticated WITH CHECK (true);
--   CREATE POLICY "Allow authenticated delete 1gfjb3d_0" ON storage.objects
--     FOR DELETE TO authenticated USING (true);
--   UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL
--    WHERE id = 'rma-attachments';
