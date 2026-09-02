-- 20260846_verify_kb_chat.sql
-- Read-only. Confirms 20260801 and 20260802. Writes nothing. One statement.

WITH checks AS (

  -- ── Documents ──────────────────────────────────────────────────────────────
  SELECT 1 AS n, 'product_documents exists' AS what,
    EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='product_documents') AS pass

  UNION ALL SELECT 2, 'it is staff-only — anon cannot read a single document',
    NOT has_table_privilege('anon', 'public.product_documents', 'SELECT')

  UNION ALL SELECT 3, 'row level security is on, with a read and a write policy',
    (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='product_documents')
    AND (SELECT count(*) FROM pg_policies
          WHERE schemaname='public' AND tablename='product_documents') >= 2

  -- Generated, so the index can never describe text the document no longer has.
  UNION ALL SELECT 4, 'the search vector is generated, not maintained by hand',
    (SELECT is_generated FROM information_schema.columns
      WHERE table_schema='public' AND table_name='product_documents'
        AND column_name='search_vector') = 'ALWAYS'

  UNION ALL SELECT 5, 'the full-text index exists, so search does not scan every row',
    EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname='public' AND indexname='product_documents_search_idx')

  -- 'simple' and not 'english': datasheets are part numbers and units, and
  -- English stemming would fold and stop-word away exactly the terms that matter.
  UNION ALL SELECT 6, 'the index uses the simple configuration, not English stemming',
    (SELECT generation_expression FROM information_schema.columns
      WHERE table_schema='public' AND table_name='product_documents'
        AND column_name='search_vector') LIKE '%simple%'

  UNION ALL SELECT 7, 'deleting a product takes its documents with it',
    EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid='public.product_documents'::regclass
         AND contype='f' AND confdeltype='c')

  -- ── Chat configuration ─────────────────────────────────────────────────────
  UNION ALL SELECT 8, 'the model and endpoint settings exist',
    (SELECT count(*) FROM public.rma_config
      WHERE config_key IN ('kb_llm_model','kb_llm_base_url')) = 2

  -- The one that matters most. rma_config is readable by every staff member
  -- and travels in every backup, so a key here is exposed twice over.
  UNION ALL SELECT 9, 'NO API KEY IS STORED IN THE DATABASE',
    NOT EXISTS (
      SELECT 1 FROM public.rma_config
       WHERE config_key ILIKE '%api_key%'
          OR config_key ILIKE '%secret%'
          OR (config_key LIKE 'kb_llm%' AND length(config_value #>> '{}') > 60))

  UNION ALL SELECT 10, 'no config value anywhere looks like a provider key',
    NOT EXISTS (
      SELECT 1 FROM public.rma_config
       WHERE config_value #>> '{}' ~ '^(sk-|nvapi-|gsk_)')

  -- ── Data sanity ────────────────────────────────────────────────────────────
  UNION ALL SELECT 11, 'every document records whether its text could be read',
    NOT EXISTS (SELECT 1 FROM public.product_documents WHERE extraction_status IS NULL)

  -- A document marked searchable with nothing to search would never appear in
  -- results, and nothing on screen would explain why.
  UNION ALL SELECT 12, 'nothing claims to be searchable while holding no text',
    NOT EXISTS (
      SELECT 1 FROM public.product_documents
       WHERE extraction_status = 'ok'
         AND (extracted_text IS NULL OR length(trim(extracted_text)) = 0))

  UNION ALL SELECT 13, 'every document points at a file',
    NOT EXISTS (
      SELECT 1 FROM public.product_documents
       WHERE storage_path IS NULL OR file_url IS NULL)
)
SELECT n, CASE WHEN pass THEN 'PASS' ELSE '*** FAIL ***' END AS result, what
FROM checks ORDER BY n;

-- ─────────────────────────────────────────────────────────────────────────────
-- The chat needs three things beyond these migrations, none of which SQL can
-- check:
--
--   1. supabase functions deploy kb-chat
--   2. supabase secrets set KB_LLM_API_KEY=...
--   3. a model identifier in System Setup, copied from your provider's console
--
-- Until 3 is set the chat says it is not configured rather than failing
-- obscurely. To see what is set:
--
--   SELECT config_key, config_value #>> '{}' AS value
--     FROM public.rma_config WHERE config_key LIKE 'kb_llm%';
--
-- How much of the library is actually searchable:
--
--   SELECT extraction_status, count(*)
--     FROM public.product_documents GROUP BY extraction_status ORDER BY 2 DESC;
