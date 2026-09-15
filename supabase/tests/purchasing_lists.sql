-- ############################################################################
-- #  DB TEST TIER — Purchasing lists, counts and spend (BUG-066, phase 5d)
-- #
-- #  20260862 moves the Purchasing page, its graph and pivot, the Vendors tab
-- #  and Vendor Details into the database. Pinned here, against whatever
-- #  documents exist (status and approval triggers guard the tables, so none
-- #  are inserted):
-- #
-- #    - rma_purchase_tab_holds: Archive holds archived, All and each type the
-- #      active ones, 'any' everything;
-- #    - v_purchase_documents_list keeps one row per document, names the
-- #      vendor, and totals in base currency the way docTotalBase does;
-- #    - rma_purchase_document_summary counts every tab and offers exactly the
-- #      statuses present in it;
-- #    - rma_purchase_document_buckets adds up, per group, to the list for the
-- #      same tab / status / vendor / search — including searches for the
-- #      characters LIKE treats specially — and buckets months in the time
-- #      zone asked for (UTC for a name it does not know);
-- #    - v_vendors_list keeps one row per brand with null sort keys for blanks;
-- #    - nothing is readable or callable by anon.
-- #
-- #  NOT in CI: the db-tests job is disabled (needs Docker). Run against the
-- #  hosted project inside a transaction that is rolled back.
-- ############################################################################

DO $$
DECLARE
  v_failures text[] := '{}';
  v_checks int := 0;
  v_tab text;
  v_term text;
  v_diff numeric;
  v_s jsonb;
BEGIN
  -- ── CHECK 1: which documents a tab holds ───────────────────────────────────
  v_checks := v_checks + 1;
  IF NOT public.rma_purchase_tab_holds('archive', 'purchase_order', true)
     OR public.rma_purchase_tab_holds('archive', 'purchase_order', false)
     OR NOT public.rma_purchase_tab_holds('all', 'vendor_invoice', false)
     OR public.rma_purchase_tab_holds('all', 'vendor_invoice', true)
     OR NOT public.rma_purchase_tab_holds('vendor_invoice', 'vendor_invoice', NULL)
     OR public.rma_purchase_tab_holds('vendor_invoice', 'purchase_order', false)
     OR public.rma_purchase_tab_holds('purchase_order', 'purchase_order', true)
     OR NOT public.rma_purchase_tab_holds('any', 'purchase_order', true)
     OR NOT public.rma_purchase_tab_holds('any', 'vendor_invoice', false) THEN
    v_failures := array_append(v_failures, 'CHECK 1: rma_purchase_tab_holds puts a document in the wrong tab');
  END IF;

  -- ── CHECK 2: the list view ─────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF (SELECT count(*) FROM public.v_purchase_documents_list) <> (SELECT count(*) FROM public.v_purchase_documents)
     OR EXISTS (SELECT 1 FROM public.v_purchase_documents_list l
                  LEFT JOIN public.brands b ON b.id = l.vendor_id
                 WHERE l.vendor_name IS DISTINCT FROM nullif(b.brand_name, '')
                    OR l.vendor_sort IS DISTINCT FROM lower(nullif(b.brand_name, ''))
                    OR l.doc_code_sort <> lower(coalesce(l.doc_code, ''))
                    OR l.total_base_value <> CASE WHEN l.total_base IS NOT NULL THEN l.total_base
                                                  ELSE coalesce(l.total, 0) * CASE WHEN coalesce(l.exchange_rate, 0) = 0 THEN 1 ELSE l.exchange_rate END
                                             END) THEN
    v_failures := array_append(v_failures, 'CHECK 2: v_purchase_documents_list drops a row or names / totals it wrongly');
  END IF;

  -- ── CHECK 3: tab counts and status options ─────────────────────────────────
  v_checks := v_checks + 1;
  FOREACH v_tab IN ARRAY ARRAY['all', 'purchase_order', 'vendor_invoice', 'archive'] LOOP
    v_s := public.rma_purchase_document_summary(v_tab);
    IF (v_s->'counts'->>v_tab)::int <> (SELECT count(*) FROM public.v_purchase_documents d
                                          WHERE public.rma_purchase_tab_holds(v_tab, d.doc_type, d.archived))
       OR (v_s->'counts'->>'total')::int <> (SELECT count(*) FROM public.v_purchase_documents)
       OR (v_s->'statuses') <> coalesce((SELECT jsonb_agg(DISTINCT d.doc_status ORDER BY d.doc_status)
                                           FROM public.v_purchase_documents d
                                          WHERE public.rma_purchase_tab_holds(v_tab, d.doc_type, d.archived)
                                            AND coalesce(d.doc_status, '') <> ''), '[]'::jsonb) THEN
      v_failures := array_append(v_failures, format('CHECK 3: summary for tab %s is wrong: %s', v_tab, v_s));
    END IF;
  END LOOP;

  -- ── CHECK 4: buckets add up to the list, per tab and per group ─────────────
  v_checks := v_checks + 1;
  FOREACH v_tab IN ARRAY ARRAY['all', 'purchase_order', 'vendor_invoice', 'archive', 'any'] LOOP
    WITH expected AS (
      SELECT doc_type, doc_status, vendor_id, count(*)::numeric AS n, sum(total_base_value) AS s
        FROM public.v_purchase_documents_list
       WHERE public.rma_purchase_tab_holds(v_tab, doc_type, archived)
       GROUP BY 1, 2, 3
    ),
    actual AS (
      SELECT doc_type, doc_status, vendor_id, sum(doc_count)::numeric AS n, sum(spend) AS s
        FROM public.rma_purchase_document_buckets(v_tab, NULL, NULL, NULL, 'UTC')
       GROUP BY 1, 2, 3
    )
    SELECT coalesce(sum(abs(coalesce(e.n, 0) - coalesce(a.n, 0)) + abs(coalesce(e.s, 0) - coalesce(a.s, 0))), 0) INTO v_diff
      FROM expected e FULL JOIN actual a
        ON a.doc_type = e.doc_type AND a.doc_status IS NOT DISTINCT FROM e.doc_status AND a.vendor_id IS NOT DISTINCT FROM e.vendor_id;
    IF v_diff <> 0 THEN
      v_failures := array_append(v_failures, format('CHECK 4: buckets for tab %s differ from the list by %s', v_tab, v_diff));
    END IF;
  END LOOP;

  -- ── CHECK 5: status, vendor and search narrow buckets like the list ────────
  v_checks := v_checks + 1;
  FOREACH v_term IN ARRAY ARRAY['po-', 'VI-2026', 'asr', 'a', '%', '_', '\', 'zz-no-match'] LOOP
    SELECT abs(
             (SELECT coalesce(sum(doc_count), 0) FROM public.rma_purchase_document_buckets('any', NULL, NULL, v_term, 'UTC'))
             - (SELECT count(*) FROM public.v_purchase_documents_list
                 WHERE doc_code ILIKE '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
                    OR vendor_name ILIKE '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%')
           ) INTO v_diff;
    IF v_diff <> 0 THEN
      v_failures := array_append(v_failures, format('CHECK 5: search %L counts %s documents off', v_term, v_diff));
    END IF;
  END LOOP;
  IF EXISTS (
       SELECT 1 FROM (SELECT DISTINCT doc_status, vendor_id FROM public.v_purchase_documents_list) s
        WHERE (SELECT coalesce(sum(doc_count), 0) FROM public.rma_purchase_document_buckets('any', s.doc_status, s.vendor_id, NULL, 'UTC'))
              <> (SELECT count(*) FROM public.v_purchase_documents_list l
                   WHERE l.doc_status = s.doc_status AND l.vendor_id IS NOT DISTINCT FROM s.vendor_id)
          AND s.vendor_id IS NOT NULL AND s.doc_status IS NOT NULL
     )
     OR (SELECT coalesce(sum(doc_count), 0) FROM public.rma_purchase_document_buckets('any', '', NULL, '   ', 'UTC'))
        <> (SELECT count(*) FROM public.v_purchase_documents_list) THEN
    v_failures := array_append(v_failures, 'CHECK 5: a status/vendor filter (or a blank one) narrows buckets differently from the list');
  END IF;

  -- ── CHECK 6: months in the requested time zone ─────────────────────────────
  v_checks := v_checks + 1;
  IF EXISTS (
       SELECT 1
         FROM (SELECT created_month, sum(doc_count) AS n FROM public.rma_purchase_document_buckets('any', NULL, NULL, NULL, 'Africa/Cairo') GROUP BY 1) a
         FULL JOIN (SELECT to_char(created_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM') AS created_month, count(*) AS n
                      FROM public.v_purchase_documents_list GROUP BY 1) e USING (created_month)
        WHERE coalesce(a.n, 0) <> coalesce(e.n, 0)
     )
     OR EXISTS (
       SELECT 1
         FROM (SELECT created_month, sum(doc_count) AS n FROM public.rma_purchase_document_buckets('any', NULL, NULL, NULL, 'Not/AZone') GROUP BY 1) a
         FULL JOIN (SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS created_month, count(*) AS n
                      FROM public.v_purchase_documents_list GROUP BY 1) e USING (created_month)
        WHERE coalesce(a.n, 0) <> coalesce(e.n, 0)
     ) THEN
    v_failures := array_append(v_failures, 'CHECK 6: created months are not bucketed in the requested time zone (or UTC for an unknown one)');
  END IF;

  -- ── CHECK 7: vendors view ──────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF (SELECT count(*) FROM public.v_vendors_list) <> (SELECT count(*) FROM public.brands)
     OR EXISTS (SELECT 1 FROM public.v_vendors_list
                 WHERE brand_name_sort IS DISTINCT FROM lower(nullif(brand_name, ''))
                    OR contact_person_sort IS DISTINCT FROM lower(nullif(contact_person, ''))
                    OR email_sort IS DISTINCT FROM lower(nullif(email, ''))
                    OR phone_sort IS DISTINCT FROM lower(nullif(phone, ''))
                    OR payment_terms_sort IS DISTINCT FROM lower(nullif(payment_terms, ''))) THEN
    v_failures := array_append(v_failures, 'CHECK 7: v_vendors_list drops a brand or builds a sort key wrongly');
  END IF;

  -- ── CHECK 8: access ────────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF has_table_privilege('anon', 'public.v_purchase_documents_list', 'SELECT')
     OR has_table_privilege('anon', 'public.v_vendors_list', 'SELECT')
     OR has_function_privilege('anon', 'public.rma_purchase_document_summary(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_purchase_document_buckets(text, text, uuid, text, text)', 'EXECUTE')
     OR NOT has_table_privilege('authenticated', 'public.v_purchase_documents_list', 'SELECT')
     OR NOT has_function_privilege('authenticated', 'public.rma_purchase_document_buckets(text, text, uuid, text, text)', 'EXECUTE') THEN
    v_failures := array_append(v_failures, 'CHECK 8: grants on the Purchasing views/functions are wrong');
  END IF;

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % purchasing check(s) FAILED:\n%',
      array_length(v_failures, 1), v_checks, array_to_string(v_failures, E'\n');
  END IF;
  RAISE NOTICE 'All % purchasing checks passed', v_checks;
END $$;
