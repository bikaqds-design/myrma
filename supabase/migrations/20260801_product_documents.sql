-- 20260801_product_documents.sql
-- Knowledge Center, part 1 — documents attached to products.
--
-- ═══ What this is ════════════════════════════════════════════════════════════
--
-- Datasheets, manuals and specification sheets, attached to the product they
-- describe. The file itself goes to the existing storage bucket; this table
-- records what it is, which product it belongs to, and — the part that matters
-- — the TEXT extracted from it.
--
-- ═══ Why the extracted text is the point ═════════════════════════════════════
--
-- A PDF in a bucket is findable only by whoever remembers its filename. The
-- extracted text is what makes "which board supports DDR5" a question the
-- system can answer, first through Postgres full-text search and later by
-- handing the relevant passages to a language model.
--
-- Extraction happens in the browser at upload time (pdfjs). It can fail — a
-- scanned datasheet is images of text, not text — and that is recorded rather
-- than hidden: extraction_status says whether the document is searchable, so
-- nobody wonders why a document they can see never appears in results.
--
-- ═══ On file privacy ═════════════════════════════════════════════════════════
--
-- The storage bucket is public: every uploaded file is readable by anyone with
-- the URL, with no login. That was a deliberate decision for this module —
-- vendor datasheets are published marketing material. It is recorded here
-- because it will NOT be true of every document someone later wants to store,
-- and this table is where they will try to put them.
--
-- ═══ Applying ════════════════════════════════════════════════════════════════
-- Paste into the Supabase SQL editor. One transaction.
-- Verify with supabase/manual/20260845_verify_product_documents.sql.

CREATE TABLE IF NOT EXISTS public.product_documents (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        uuid        NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,

  title             text        NOT NULL,
  doc_type          text        NOT NULL DEFAULT 'datasheet'
                                  CHECK (doc_type IN
                                    ('datasheet','manual','warranty','certificate','drawing','other')),
  description       text,

  -- Where the file lives. `storage_path` is the durable reference; `file_url`
  -- is the convenience copy of the public URL, which would have to be rebuilt
  -- if the bucket ever stopped being public.
  file_name         text        NOT NULL,
  file_url          text        NOT NULL,
  storage_path      text        NOT NULL,
  file_size         integer,
  mime_type         text,

  -- The searchable body of the document.
  extracted_text    text,
  -- 'pending' before extraction, 'ok' when text came out, 'empty' when the file
  -- parsed but held no text (a scan), 'failed' when it could not be read, and
  -- 'unsupported' for a type nothing can extract. Recorded because a document
  -- that silently never appears in search is worse than one labelled as such.
  extraction_status text        NOT NULL DEFAULT 'pending'
                                  CHECK (extraction_status IN
                                    ('pending','ok','empty','failed','unsupported')),
  page_count        integer,

  uploaded_by       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.product_documents IS
  'Datasheets and manuals attached to a product. extracted_text is what makes them searchable and what a language model is later given to read.';
COMMENT ON COLUMN public.product_documents.extraction_status IS
  'Whether the text could be read. A scanned datasheet is images of text and comes out empty — saying so is better than the document silently never appearing in search.';

CREATE INDEX IF NOT EXISTS product_documents_product_idx
  ON public.product_documents (product_id);
CREATE INDEX IF NOT EXISTS product_documents_type_idx
  ON public.product_documents (doc_type);

-- ═══ Full-text search ════════════════════════════════════════════════════════
-- Generated, so it can never fall out of step with the text it indexes. The
-- title is weighted above the body: a document called "B660M Manual" should
-- beat one that mentions B660M once in a compatibility table.

ALTER TABLE public.product_documents
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(extracted_text, '')), 'C')
    ) STORED;

CREATE INDEX IF NOT EXISTS product_documents_search_idx
  ON public.product_documents USING GIN (search_vector);

-- 'simple' and not 'english': these are datasheets full of part numbers and
-- units. English stemming would fold "buses" into "bus" and stop-word away
-- terms that matter here, and the documents are not all in English anyway.

-- ═══ Row level security ══════════════════════════════════════════════════════
-- Staff only, as decided. Nothing is exposed to the customer portal or the
-- public tracker.

ALTER TABLE public.product_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_documents_staff_read ON public.product_documents;
CREATE POLICY product_documents_staff_read ON public.product_documents
  FOR SELECT TO authenticated USING (public.rma_is_staff());

-- Managers and above may add and remove. A datasheet is reference material the
-- whole team relies on; letting anyone replace one invites quiet drift.
DROP POLICY IF EXISTS product_documents_manager_write ON public.product_documents;
CREATE POLICY product_documents_manager_write ON public.product_documents
  FOR ALL TO authenticated
  USING (public.rma_is_manager_or_above())
  WITH CHECK (public.rma_is_manager_or_above());

REVOKE ALL ON public.product_documents FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_documents TO authenticated;

-- updated_at, using the trigger function this schema already has.
DROP TRIGGER IF EXISTS product_documents_updated_at ON public.product_documents;
CREATE TRIGGER product_documents_updated_at
  BEFORE UPDATE ON public.product_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_date();

-- ═══ Guards ══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF (SELECT is_generated FROM information_schema.columns
       WHERE table_schema='public' AND table_name='product_documents'
         AND column_name='search_vector') IS DISTINCT FROM 'ALWAYS' THEN
    RAISE EXCEPTION 'Refusing to apply: search_vector is not generated, so it could drift from the text.';
  END IF;

  IF has_table_privilege('anon', 'public.product_documents', 'SELECT') THEN
    RAISE EXCEPTION 'Refusing to apply: product_documents is readable by anon. It was specified as staff-only.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND indexname='product_documents_search_idx'
  ) THEN
    RAISE EXCEPTION 'Refusing to apply: the full-text index was not created; search would sequentially scan every document.';
  END IF;

  RAISE NOTICE 'product_documents ready. Files remain in the PUBLIC storage bucket by design.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260845_verify_product_documents.sql.
