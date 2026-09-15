-- ############################################################################
-- #  DB TEST TIER — Sales Documents list (BUG-066, phase 5d)
-- #
-- #  20260860: v_sales_documents_list names each document's customer and
-- #  carries the list's sort keys; rma_sales_document_summary gives the tab
-- #  counts and filter options the page used to count in the browser.
-- #
-- #    - one row per document; the customer is the company, else the contact;
-- #    - an owner's documents are those assigned to them OR raised by them;
-- #    - archived documents count only under Archive; the type tabs add up to All;
-- #    - statuses are those in the selected tab, reps span every document;
-- #    - nothing is readable or callable by anon.
-- #
-- #  NOT in CI: the db-tests job is disabled (needs Docker). Run against the
-- #  hosted project with the cleanup replaced by an unconditional RAISE.
-- ############################################################################

DO $$
DECLARE
  v_tag text := floor(random() * 1000000)::text;
  v_owner text := 'owner.' || v_tag || '@ci.test';
  v_other text := 'other.' || v_tag || '@ci.test';
  c_company uuid; c_person uuid;
  q_active uuid; q_archived uuid; cn_active uuid;
  r record;
  v_sum jsonb;
  v_failures text[] := '{}';
  v_checks int := 0;
BEGIN
  INSERT INTO public.customers (customer_code, customer_type, company_name)
    VALUES ('CI-SD-' || v_tag, 'B2B', 'CI Zed Co ' || v_tag) RETURNING id INTO c_company;
  INSERT INTO public.customers (customer_code, customer_type, company_name, contact_person)
    VALUES ('CI-SP-' || v_tag, 'B2C', '', 'CI Person ' || v_tag) RETURNING id INTO c_person;

  INSERT INTO public.quotations (qt_code, customer_id, status, total, created_by, assigned_rep)
    VALUES ('QT-CI' || v_tag, c_company, 'sent', 150, v_other, v_owner) RETURNING id INTO q_active;
  INSERT INTO public.quotations (qt_code, customer_id, status, total, created_by, assigned_rep, archived)
    VALUES ('qt-ci-arch' || v_tag, c_person, 'declined', 90, v_owner, v_other, true) RETURNING id INTO q_archived;
  INSERT INTO public.credit_notes (type, customer_id, status, total, reason, created_by, assigned_rep)
    VALUES ('rebate', c_person, 'draft', 40, 'CI', v_other, v_other) RETURNING id INTO cn_active;

  -- ── CHECK 1: one row per document ───────────────────────────────────────────
  v_checks := v_checks + 1;
  IF (SELECT count(*) FROM public.v_sales_documents_list) <> (SELECT count(*) FROM public.v_sales_documents) THEN
    v_failures := array_append(v_failures, 'CHECK 1: v_sales_documents_list does not have one row per document');
  END IF;

  -- ── CHECK 2: customer names and sort keys ───────────────────────────────────
  v_checks := v_checks + 1;
  SELECT customer_name, customer_sort, doc_code_sort, total_sort INTO r FROM public.v_sales_documents_list WHERE id = q_active;
  IF r.customer_name IS DISTINCT FROM 'CI Zed Co ' || v_tag OR r.customer_sort IS DISTINCT FROM lower('CI Zed Co ' || v_tag)
     OR r.doc_code_sort IS DISTINCT FROM lower('QT-CI' || v_tag) OR r.total_sort IS DISTINCT FROM 150::numeric THEN
    v_failures := array_append(v_failures, format('CHECK 2a: %s', row_to_json(r)));
  END IF;
  IF (SELECT customer_name FROM public.v_sales_documents_list WHERE id = cn_active) IS DISTINCT FROM 'CI Person ' || v_tag THEN
    v_failures := array_append(v_failures, 'CHECK 2b: an empty company name does not fall back to the contact person');
  END IF;

  -- ── CHECK 3: an owner's tab counts ──────────────────────────────────────────
  v_checks := v_checks + 1;
  v_sum := public.rma_sales_document_summary('quotation', v_owner);
  IF v_sum->'counts' IS DISTINCT FROM '{"all": 1, "quotation": 1, "sales_order": 0, "invoice": 0, "credit_note": 0, "archive": 1}'::jsonb THEN
    v_failures := array_append(v_failures, format('CHECK 3: owner counts %s (assigned OR raised; archived only under Archive)', v_sum->'counts'));
  END IF;

  -- ── CHECK 4: filter options ─────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF v_sum->'statuses' IS DISTINCT FROM '["sent"]'::jsonb THEN
    v_failures := array_append(v_failures, format('CHECK 4a: statuses in the quotation tab %s', v_sum->'statuses'));
  END IF;
  IF v_sum->'reps' IS DISTINCT FROM jsonb_build_array(v_other, v_owner) THEN
    v_failures := array_append(v_failures, format('CHECK 4b: reps across the owner''s documents %s', v_sum->'reps'));
  END IF;
  IF public.rma_sales_document_summary('archive', v_owner)->'statuses' IS DISTINCT FROM '["declined"]'::jsonb THEN
    v_failures := array_append(v_failures, 'CHECK 4c: archive tab statuses are not the archived documents''');
  END IF;

  -- ── CHECK 5: everyone's counts add up ───────────────────────────────────────
  v_checks := v_checks + 1;
  v_sum := public.rma_sales_document_summary('all');
  IF (v_sum->'counts'->>'all')::int + (v_sum->'counts'->>'archive')::int <> (SELECT count(*) FROM public.v_sales_documents)
     OR (v_sum->'counts'->>'all')::int <> (v_sum->'counts'->>'quotation')::int + (v_sum->'counts'->>'sales_order')::int
                                          + (v_sum->'counts'->>'invoice')::int + (v_sum->'counts'->>'credit_note')::int THEN
    v_failures := array_append(v_failures, format('CHECK 5: counts do not add up %s', v_sum->'counts'));
  END IF;

  -- ── CHECK 6: access ─────────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF has_table_privilege('anon', 'public.v_sales_documents_list', 'SELECT')
     OR has_function_privilege('anon', 'public.rma_sales_document_summary(text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rma_sales_document_summary(text, text)', 'EXECUTE') THEN
    v_failures := array_append(v_failures, 'CHECK 6: grants on the Sales Documents view/function are wrong');
  END IF;

  DELETE FROM public.credit_notes WHERE id = cn_active;
  DELETE FROM public.quotations WHERE id IN (q_active, q_archived);
  DELETE FROM public.customers WHERE id IN (c_company, c_person);

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % sales document check(s) FAILED:\n%',
      array_length(v_failures, 1), v_checks, array_to_string(v_failures, E'\n');
  END IF;
  RAISE NOTICE 'All % sales document checks passed', v_checks;
END $$;
