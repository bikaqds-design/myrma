-- ############################################################################
-- #  DB TEST TIER — Knowledge Center folder tree (BUG-066, phase 5b)
-- #
-- #  20260855_knowledge_explorer_views.sql moved the Vault's folder tree out of
-- #  the browser (src/lib/knowledgeTree.js) and into views. This pins what the
-- #  JavaScript tests pinned, against the database:
-- #
-- #    - a product nests Brand > Category > Subcategory only while each link
-- #      agrees with the one above, and falls back one level when it does not;
-- #    - every product appears exactly once;
-- #    - folder sizes (count, bytes, latest change) roll up through every
-- #      ancestor, trashed documents excluded, and an empty folder is 0 / null;
-- #    - categories list before products under a brand;
-- #  plus what the database adds: child counts, the document path and label,
-- #  folder stats, the search (text, SKU, literal wildcards) and access.
-- #
-- #  NOT in CI: the db-tests job is disabled (needs Docker). Run against the
-- #  hosted project with the cleanup block replaced by an unconditional RAISE,
-- #  so the transaction rolls back and nothing is kept.
-- ############################################################################

DO $$
DECLARE
  v_tag   text := floor(random() * 1000000)::text;
  b_a uuid; b_x uuid;
  c_m uuid; c_s uuid; c_o uuid;
  s_27 uuid; s_f uuid;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid;
  d1 uuid; d2 uuid; d3 uuid; d4 uuid;
  r record;
  v_n bigint;
  v_stats jsonb;
  v_failures text[] := '{}';
  v_checks int := 0;
BEGIN
  -- ── Fixtures ────────────────────────────────────────────────────────────────
  INSERT INTO public.brands (brand_name) VALUES ('CI KX AOC ' || v_tag) RETURNING id INTO b_a;
  INSERT INTO public.brands (brand_name) VALUES ('CI KX XPG ' || v_tag) RETURNING id INTO b_x;
  INSERT INTO public.categories (brand_id, category_name) VALUES (b_a, 'CI KX Monitor ' || v_tag) RETURNING id INTO c_m;
  INSERT INTO public.categories (brand_id, category_name) VALUES (b_x, 'CI KX SSD ' || v_tag) RETURNING id INTO c_s;
  INSERT INTO public.categories (brand_id, category_name) VALUES (b_a, 'CI KX Other ' || v_tag) RETURNING id INTO c_o;
  INSERT INTO public.subcategories (category_id, subcategory_name) VALUES (c_m, 'CI KX 27in ' || v_tag) RETURNING id INTO s_27;
  INSERT INTO public.subcategories (category_id, subcategory_name) VALUES (c_o, 'CI KX Foreign ' || v_tag) RETURNING id INTO s_f;

  -- p1 agrees all the way down; p2 has no subcategory; p3 no category;
  -- p4's category belongs to another brand; p5's subcategory to another
  -- category; p6 has no brand at all.
  INSERT INTO public.products (sku, product_name, product_type, status, brand_id, category_id, subcategory_id)
    VALUES ('CI-KX-P1-' || v_tag, 'CI KX Monitor One', 'hardware', 'active', b_a, c_m, s_27) RETURNING id INTO p1;
  INSERT INTO public.products (sku, product_name, product_type, status, brand_id, category_id, subcategory_id)
    VALUES ('CI-KX-P2-' || v_tag, 'CI KX SSD Two', 'hardware', 'active', b_x, c_s, NULL) RETURNING id INTO p2;
  INSERT INTO public.products (sku, product_name, product_type, status, brand_id, category_id, subcategory_id)
    VALUES ('CI-KX-P3-' || v_tag, 'CI KX Loose Three', 'hardware', 'active', b_a, NULL, NULL) RETURNING id INTO p3;
  INSERT INTO public.products (sku, product_name, product_type, status, brand_id, category_id, subcategory_id)
    VALUES ('CI-KX-P4-' || v_tag, 'CI KX Mismatched Four', 'hardware', 'active', b_a, c_s, NULL) RETURNING id INTO p4;
  INSERT INTO public.products (sku, product_name, product_type, status, brand_id, category_id, subcategory_id)
    VALUES ('CI-KX-P5-' || v_tag, 'CI KX Foreign Sub Five', 'hardware', 'active', b_a, c_m, s_f) RETURNING id INTO p5;
  INSERT INTO public.products (sku, product_name, product_type, status, brand_id, category_id, subcategory_id)
    VALUES ('CI-KX-P6-' || v_tag, 'CI KX Brandless Six', 'hardware', 'active', NULL, NULL, NULL) RETURNING id INTO p6;

  INSERT INTO public.product_documents (product_id, title, doc_type, file_name, file_url, storage_path, file_size, extraction_status, extracted_text, updated_at)
    VALUES (p1, 'CI KX Leaflet', 'datasheet', 'a.pdf', 'https://example.invalid/a.pdf', 'ci/a.pdf', 1000, 'ok', 'monitor leaflet', '2026-01-01T00:00:00Z') RETURNING id INTO d1;
  INSERT INTO public.product_documents (product_id, title, doc_type, file_name, file_url, storage_path, file_size, extraction_status, updated_at)
    VALUES (p1, 'CI KX Manual', 'manual', 'b.pdf', 'https://example.invalid/b.pdf', 'ci/b.pdf', 2000, 'failed', '2026-03-01T00:00:00Z') RETURNING id INTO d2;
  INSERT INTO public.product_documents (product_id, title, doc_type, file_name, file_url, storage_path, file_size, extraction_status, extracted_text, updated_at)
    VALUES (p2, 'CI KX SSD Sheet', 'datasheet', 'c.pdf', 'https://example.invalid/c.pdf', 'ci/c.pdf', 500, 'ok', 'unicornkx' || v_tag || ' widget', '2026-02-01T00:00:00Z') RETURNING id INTO d3;
  INSERT INTO public.product_documents (product_id, title, doc_type, file_name, file_url, storage_path, file_size, extraction_status, updated_at, deleted_at, deleted_by)
    VALUES (p1, 'CI KX Trashed', 'other', 'd.pdf', 'https://example.invalid/d.pdf', 'ci/d.pdf', 9999, 'ok', '2026-06-01T00:00:00Z', now(), 'ci@test.com') RETURNING id INTO d4;

  -- ── CHECK 1: placement ───────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  FOR r IN
    SELECT n.id, n.parent_id, n.path, x.want_parent, x.want_path, x.label
      FROM public.v_knowledge_nodes n
      JOIN (VALUES
        (p1::text, s_27::text, ARRAY[b_a::text, c_m::text, s_27::text, p1::text], 'agrees all the way down'),
        (p2::text, c_s::text,  ARRAY[b_x::text, c_s::text, p2::text],              'no subcategory'),
        (p3::text, b_a::text,  ARRAY[b_a::text, p3::text],                         'no category'),
        (p4::text, b_a::text,  ARRAY[b_a::text, p4::text],                         'category of another brand falls back to the brand'),
        (p5::text, c_m::text,  ARRAY[b_a::text, c_m::text, p5::text],              'subcategory of another category falls back to the category'),
        (p6::text, '__root__', ARRAY[p6::text],                                    'no brand sits at the root')
      ) AS x(id, want_parent, want_path, label) ON x.id = n.id
  LOOP
    IF r.parent_id IS DISTINCT FROM r.want_parent OR r.path IS DISTINCT FROM r.want_path THEN
      v_failures := array_append(v_failures, format('CHECK 1 (%s): parent %s path %s, expected %s %s', r.label, r.parent_id, r.path, r.want_parent, r.want_path));
    END IF;
  END LOOP;

  -- ── CHECK 2: every product exactly once ──────────────────────────────────────
  v_checks := v_checks + 1;
  SELECT count(*) INTO v_n FROM public.v_knowledge_nodes WHERE id IN (p1::text, p2::text, p3::text, p4::text, p5::text, p6::text);
  IF v_n <> 6 THEN
    v_failures := array_append(v_failures, format('CHECK 2: %s product folders for 6 products', v_n));
  END IF;
  IF (SELECT count(*) FROM public.v_knowledge_nodes WHERE kind = 'product') <> (SELECT count(*) FROM public.products) THEN
    v_failures := array_append(v_failures, 'CHECK 2b: product folders do not match the catalogue one-for-one');
  END IF;

  -- ── CHECK 3: roll-ups ────────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  FOR r IN
    SELECT n.id, n.doc_count, n.doc_bytes, n.modified, x.cnt, x.bytes, x.modified AS want_modified, x.label
      FROM public.v_knowledge_nodes n
      JOIN (VALUES
        (p1::text,   2, 3000::bigint, '2026-03-01T00:00:00Z'::timestamptz, 'product with two live documents and one trashed'),
        (s_27::text, 2, 3000::bigint, '2026-03-01T00:00:00Z'::timestamptz, 'subcategory'),
        (c_m::text,  2, 3000::bigint, '2026-03-01T00:00:00Z'::timestamptz, 'category'),
        (b_a::text,  2, 3000::bigint, '2026-03-01T00:00:00Z'::timestamptz, 'brand'),
        (b_x::text,  1, 500::bigint,  '2026-02-01T00:00:00Z'::timestamptz, 'other brand'),
        (c_o::text,  0, 0::bigint,    NULL::timestamptz,                   'empty folder is zero, not null')
      ) AS x(id, cnt, bytes, modified, label) ON x.id = n.id
  LOOP
    IF r.doc_count <> r.cnt OR r.doc_bytes <> r.bytes OR r.modified IS DISTINCT FROM r.want_modified THEN
      v_failures := array_append(v_failures, format('CHECK 3 (%s): %s docs / %s bytes / %s, expected %s / %s / %s',
        r.label, r.doc_count, r.doc_bytes, r.modified, r.cnt, r.bytes, r.want_modified));
    END IF;
  END LOOP;

  -- ── CHECK 4: child counts and order ──────────────────────────────────────────
  v_checks := v_checks + 1;
  IF (SELECT child_count FROM public.v_knowledge_nodes WHERE id = b_a::text) <> 4 THEN
    v_failures := array_append(v_failures, 'CHECK 4a: AOC should hold 2 categories and 2 loose products');
  END IF;
  IF (SELECT child_count FROM public.v_knowledge_nodes WHERE id = c_m::text) <> 2 THEN
    v_failures := array_append(v_failures, 'CHECK 4b: Monitor should hold its subcategory and the foreign-sub product');
  END IF;
  IF (SELECT array_agg(kind ORDER BY kind_rank, name, id) FROM public.v_knowledge_nodes WHERE parent_id = b_a::text)
     IS DISTINCT FROM ARRAY['category', 'category', 'product', 'product'] THEN
    v_failures := array_append(v_failures, 'CHECK 4c: categories must list before products under a brand');
  END IF;

  -- ── CHECK 5: document path and label ─────────────────────────────────────────
  v_checks := v_checks + 1;
  SELECT path, folder_path, product_sku INTO r FROM public.v_knowledge_documents WHERE id = d1;
  IF r.path IS DISTINCT FROM ARRAY[b_a::text, c_m::text, s_27::text, p1::text]
     OR r.folder_path IS DISTINCT FROM format('CI KX AOC %s / CI KX Monitor %s / CI KX 27in %s / CI KX Monitor One', v_tag, v_tag, v_tag)
     OR r.product_sku IS DISTINCT FROM 'CI-KX-P1-' || v_tag THEN
    v_failures := array_append(v_failures, format('CHECK 5: document path %s label %s', r.path, r.folder_path));
  END IF;

  -- ── CHECK 6: folder stats ────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  v_stats := public.rma_knowledge_folder_stats(b_a::text);
  IF (v_stats->>'total')::int <> 2 OR (v_stats->>'unsearchable')::int <> 1
     OR (v_stats->'by_type'->>'datasheet')::int <> 1 OR (v_stats->'by_type'->>'manual')::int <> 1
     OR v_stats->'by_type' ? 'other' THEN
    v_failures := array_append(v_failures, format('CHECK 6a: AOC stats %s (trashed documents must not count)', v_stats));
  END IF;
  v_stats := public.rma_knowledge_folder_stats(c_o::text);
  IF (v_stats->>'total')::int <> 0 OR v_stats->'by_type' <> '{}'::jsonb THEN
    v_failures := array_append(v_failures, format('CHECK 6b: empty folder stats %s', v_stats));
  END IF;
  IF (public.rma_knowledge_folder_stats('__root__')->>'total')::bigint <> (SELECT count(*) FROM public.product_documents WHERE deleted_at IS NULL) THEN
    v_failures := array_append(v_failures, 'CHECK 6c: root stats do not cover the whole live library');
  END IF;

  -- ── CHECK 7: search ──────────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF NOT EXISTS (SELECT 1 FROM public.rma_knowledge_documents_matching('unicornkx' || v_tag) WHERE id = d3) THEN
    v_failures := array_append(v_failures, 'CHECK 7a: a word from the document text does not find it');
  END IF;
  SELECT count(*) INTO v_n FROM public.rma_knowledge_documents_matching('CI-KX-P1-' || v_tag) WHERE deleted_at IS NULL;
  IF v_n <> 2 THEN
    v_failures := array_append(v_failures, format('CHECK 7b: searching the SKU found %s live documents, expected the product''s 2', v_n));
  END IF;
  IF EXISTS (SELECT 1 FROM public.rma_knowledge_documents_matching('%') WHERE id IN (d1, d2, d3)) THEN
    v_failures := array_append(v_failures, 'CHECK 7c: a literal % acted as a wildcard');
  END IF;
  IF EXISTS (SELECT 1 FROM public.rma_knowledge_documents_matching('   ')) THEN
    v_failures := array_append(v_failures, 'CHECK 7d: a blank search matched documents');
  END IF;

  -- ── CHECK 8: access ──────────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  FOR r IN
    SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relname IN ('v_knowledge_product_placement', 'v_knowledge_nodes', 'v_knowledge_documents')
  LOOP
    IF NOT coalesce('security_invoker=true' = ANY (r.reloptions), false) THEN
      v_failures := array_append(v_failures, format('CHECK 8a: %s is not security_invoker', r.relname));
    END IF;
    IF has_table_privilege('anon', 'public.' || r.relname, 'SELECT') THEN
      v_failures := array_append(v_failures, format('CHECK 8b: anon can read %s', r.relname));
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.rma_knowledge_documents_matching(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_knowledge_folder_stats(text)', 'EXECUTE') THEN
    v_failures := array_append(v_failures, 'CHECK 8c: anon can call a knowledge function');
  END IF;

  -- ── Cleanup ─────────────────────────────────────────────────────────────────
  DELETE FROM public.product_documents WHERE id IN (d1, d2, d3, d4);
  DELETE FROM public.products WHERE id IN (p1, p2, p3, p4, p5, p6);
  DELETE FROM public.subcategories WHERE id IN (s_27, s_f);
  DELETE FROM public.categories WHERE id IN (c_m, c_s, c_o);
  DELETE FROM public.brands WHERE id IN (b_a, b_x);

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % knowledge-explorer check(s) FAILED:\n%',
      array_length(v_failures, 1), v_checks, array_to_string(v_failures, E'\n');
  END IF;

  RAISE NOTICE 'All % knowledge-explorer checks passed', v_checks;
END $$;
