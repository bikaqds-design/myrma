-- ============================================================================
-- CRIT-3 follow-up: storage.objects policies for rma-attachments bucket
-- ============================================================================
-- Restricts anonymous (public tracker) uploads to:
--   • Max 25 MB per file
--   • Allowed MIME types: JPEG, PNG, GIF, WebP, PDF
-- Grants anonymous read so attachment URLs served from the bucket work.
-- Authenticated staff are unrestricted (covered by existing auth policies).
--
-- Safe to re-run — uses DROP POLICY IF EXISTS before each CREATE.
-- ============================================================================

-- ── Anonymous upload: size + type gating ─────────────────────────────────────
DROP POLICY IF EXISTS "public_upload_small" ON storage.objects;
CREATE POLICY "public_upload_small" ON storage.objects
  FOR INSERT TO anon
  WITH CHECK (
    bucket_id = 'rma-attachments'
    AND (metadata->>'size')::bigint < 25 * 1024 * 1024
    AND lower(coalesce(metadata->>'mimetype', '')) IN (
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf'
    )
  );

-- ── Anonymous read: allow fetching uploaded attachments by URL ────────────────
DROP POLICY IF EXISTS "public_read" ON storage.objects;
CREATE POLICY "public_read" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'rma-attachments');

-- ── Authenticated staff: full access to their bucket ─────────────────────────
-- (If not already present — safe no-op if it exists under a different name.)
DROP POLICY IF EXISTS "authenticated_full" ON storage.objects;
CREATE POLICY "authenticated_full" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'rma-attachments')
  WITH CHECK (bucket_id = 'rma-attachments');
