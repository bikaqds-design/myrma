-- 20260804_fix_product_documents_updated_trigger.sql
--
-- product_documents could not be updated. At all.
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- 20260801 created the table with an `updated_at` column and then attached
-- set_updated_date(), which assigns NEW.updated_date. That column does not
-- exist on this table, so the trigger raised
--
--     record "new" has no field "updated_date"
--
-- on every UPDATE. Not a warning, not a silent no-op — the write failed.
--
-- The table was only ever inserted into and deleted from, which is why nothing
-- noticed: uploading a document works, deleting one works, and no screen edits
-- one yet. Two things were broken and invisible:
--
--   * productDocuments.update() — renaming a document, changing its type or
--     description — would have thrown for the first person to try it.
--   * A restore could never write this table. The rows are in the backup file
--     and would fail to land, so the Knowledge Center would come back empty of
--     document metadata after a recovery.
--
-- Found by the backup/restore drill: rewriting every restorable table with its
-- own values inside a rolled-back transaction, which is what a restore does.
-- Fifty-two tables accepted it; this one did not.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- set_updated_at_col() already exists and sets NEW.updated_at. It is what
-- notification_settings and whatsapp_templates use. Nothing new is invented
-- here; the wrong function is simply swapped for the right one.

BEGIN;

DROP TRIGGER IF EXISTS product_documents_updated_at ON public.product_documents;

CREATE TRIGGER product_documents_updated_at
  BEFORE UPDATE ON public.product_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at_col();

COMMIT;

-- ═══ Verification ════════════════════════════════════════════════════════════
-- Both rows must report PASS. The second actually performs an update and rolls
-- it back, so it proves the fix rather than inspecting it.

SELECT
  CASE WHEN p.proname = 'set_updated_at_col' THEN 'PASS' ELSE 'FAIL' END AS result,
  'trigger calls set_updated_at_col' AS what,
  p.proname AS actual
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE c.relname = 'product_documents' AND t.tgname = 'product_documents_updated_at';

DO $verify$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    UPDATE public.product_documents SET id = id;
    ok := true;
  EXCEPTION WHEN OTHERS THEN
    ok := false;
  END;
  -- Raised either way, so the update above never persists.
  RAISE EXCEPTION 'VERIFY: an update to product_documents is %',
    CASE WHEN ok THEN 'PASS (accepted)' ELSE 'FAIL (still refused)' END;
END
$verify$;
