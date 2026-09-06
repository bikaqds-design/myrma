-- 20260809000001_company_documents.sql
-- Knowledge Center, part 4 -- documents that belong to the company, not a product.
--
-- === What this is ============================================================
--
-- Price lists, policies, certificates, forms -- reference material for the
-- whole business rather than one part number. product_documents cannot hold
-- these: product_id is NOT NULL there, on purpose (a document with no
-- product would be unreachable from the folder tree that indexes it). Rather
-- than weaken that constraint for a handful of unrelated documents, this is
-- its own table, mirroring product_documents' shape wherever the same
-- reasoning applies (full-text search, staff-only RLS, trash) and dropping
-- what does not (there is no product, brand or category to file one under,
-- so doc_type and the catalogue joins do not carry over).
--
-- === Trash is part of this from the start =====================================
--
-- product_documents shipped without deleted_at/deleted_by and needed a
-- second migration (20260808) to add soft-delete after the fact. Nothing
-- here justifies repeating that: the same reasoning applies to every
-- document a person can remove, so the columns are in the initial shape.
--
-- === Applying =================================================================
-- Paste into the Supabase SQL editor. One transaction.

CREATE TABLE IF NOT EXISTS public.company_documents (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  title             text        NOT NULL,
  description       text,

  file_name         text        NOT NULL,
  file_url          text        NOT NULL,
  storage_path      text        NOT NULL,
  file_size         integer,
  mime_type         text,

  extracted_text    text,
  extraction_status text        NOT NULL DEFAULT 'pending'
                                  CHECK (extraction_status IN
                                    ('pending','ok','empty','failed','unsupported')),
  page_count        integer,

  uploaded_by       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- Soft-delete, same 5-day-recoverable Trash as product_documents. See
  -- src/lib/documentTrash.js for the lazy on-visit purge and why.
  deleted_at        timestamptz,
  deleted_by        text
);

COMMENT ON TABLE public.company_documents IS
  'Documents that belong to the company as a whole, not to any one product -- price lists, policies, certificates, forms.';

CREATE INDEX IF NOT EXISTS company_documents_deleted_at_idx
  ON public.company_documents (deleted_at);

-- === Full-text search =========================================================

ALTER TABLE public.company_documents
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(extracted_text, '')), 'C')
    ) STORED;

CREATE INDEX IF NOT EXISTS company_documents_search_idx
  ON public.company_documents USING GIN (search_vector);

-- === Row level security =======================================================
-- Same policy shape as product_documents: staff read, manager-or-above write.

ALTER TABLE public.company_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_documents_staff_read ON public.company_documents;
CREATE POLICY company_documents_staff_read ON public.company_documents
  FOR SELECT TO authenticated USING (public.rma_is_staff());

DROP POLICY IF EXISTS company_documents_manager_write ON public.company_documents;
CREATE POLICY company_documents_manager_write ON public.company_documents
  FOR ALL TO authenticated
  USING (public.rma_is_manager_or_above())
  WITH CHECK (public.rma_is_manager_or_above());

REVOKE ALL ON public.company_documents FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_documents TO authenticated;

-- updated_at -- set_updated_at_col, not set_updated_date. product_documents
-- shipped with the wrong one (20260801) and every UPDATE raised until
-- 20260804 fixed it; the right function is used here from the start.
DROP TRIGGER IF EXISTS company_documents_updated_at ON public.company_documents;
CREATE TRIGGER company_documents_updated_at
  BEFORE UPDATE ON public.company_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_col();

-- === Guards ====================================================================

DO $do$
BEGIN
  IF (SELECT is_generated FROM information_schema.columns
       WHERE table_schema='public' AND table_name='company_documents'
         AND column_name='search_vector') IS DISTINCT FROM 'ALWAYS' THEN
    RAISE EXCEPTION 'Refusing to apply: search_vector is not generated, so it could drift from the text.';
  END IF;

  IF has_table_privilege('anon', 'public.company_documents', 'SELECT') THEN
    RAISE EXCEPTION 'Refusing to apply: company_documents is readable by anon. It was specified as staff-only.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND indexname='company_documents_search_idx'
  ) THEN
    RAISE EXCEPTION 'Refusing to apply: the full-text index was not created; search would sequentially scan every document.';
  END IF;

  -- Proves the trigger actually works, unlike product_documents' first
  -- attempt -- rolled back, so nothing persists.
  BEGIN
    INSERT INTO public.company_documents
      (title, file_name, file_url, storage_path, extraction_status)
      VALUES ('guard-check', 'x', 'x', 'x', 'pending');
    UPDATE public.company_documents SET title = title WHERE title = 'guard-check';
    DELETE FROM public.company_documents WHERE title = 'guard-check';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Refusing to apply: insert/update/delete smoke test failed -- %', SQLERRM;
  END;

  RAISE NOTICE 'company_documents ready.';
END
$do$;
