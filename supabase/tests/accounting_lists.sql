-- ############################################################################
-- #  DB TEST TIER — Accounting lists and aging (BUG-066, phase 5d)
-- #
-- #  20260861 moves the Accounting page's payment lists and its receivable /
-- #  payable aging into the database. Pinned here:
-- #
-- #    - rma_aging_bucket matches src/lib/aging.js at every boundary: due today
-- #      or later is not_due; 1, 30 | 31, 60 | 61, 90 | 91+; no date;
-- #    - rma_ar_aging and rma_ap_aging equal an independent per-invoice
-- #      computation over the live invoices, on eight different "today"s chosen
-- #      so every invoice crosses bucket edges — AP in the base currency;
-- #    - the payment views keep one row per payment with the counterpart name;
-- #    - nothing is readable or callable by anon.
-- #
-- #  Invoices are not inserted: status-transition and approval triggers guard
-- #  them. The reconciliation runs over whatever invoices exist.
-- #
-- #  NOT in CI: the db-tests job is disabled (needs Docker). Run against the
-- #  hosted project (read-only; wrap in a transaction and RAISE at the end).
-- ############################################################################

DO $$
DECLARE
  v_failures text[] := '{}';
  v_checks int := 0;
  v_today date;
  v_base date := coalesce((SELECT min(due_date) FROM public.crm_invoices WHERE due_date IS NOT NULL), current_date);
  v_offsets int[] := ARRAY[-1, 0, 1, 30, 31, 60, 61, 91];
  v_off int;
  v_diff numeric;
BEGIN
  -- ── CHECK 1: bucket boundaries ──────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF public.rma_aging_bucket(NULL, '2026-09-15') <> 'no_due_date'
     OR public.rma_aging_bucket('2026-09-16', '2026-09-15') <> 'not_due'
     OR public.rma_aging_bucket('2026-09-15', '2026-09-15') <> 'not_due'
     OR public.rma_aging_bucket('2026-09-14', '2026-09-15') <> 'd1_30'
     OR public.rma_aging_bucket('2026-08-16', '2026-09-15') <> 'd1_30'
     OR public.rma_aging_bucket('2026-08-15', '2026-09-15') <> 'd31_60'
     OR public.rma_aging_bucket('2026-07-17', '2026-09-15') <> 'd31_60'
     OR public.rma_aging_bucket('2026-07-16', '2026-09-15') <> 'd61_90'
     OR public.rma_aging_bucket('2026-06-17', '2026-09-15') <> 'd61_90'
     OR public.rma_aging_bucket('2026-06-16', '2026-09-15') <> 'd90_plus' THEN
    v_failures := array_append(v_failures, 'CHECK 1: rma_aging_bucket does not match src/lib/aging.js at the boundaries');
  END IF;

  -- ── CHECK 2: receivables aging = per-invoice computation, on many days ──────
  v_checks := v_checks + 1;
  FOREACH v_off IN ARRAY v_offsets LOOP
    v_today := v_base + v_off;
    WITH expected AS (
      SELECT customer_id, bucket, sum(remaining) AS amt
        FROM (
          SELECT i.customer_id,
                 CASE WHEN i.due_date IS NULL THEN 'no_due_date'
                      WHEN v_today - i.due_date <= 0 THEN 'not_due'
                      WHEN v_today - i.due_date <= 30 THEN 'd1_30'
                      WHEN v_today - i.due_date <= 60 THEN 'd31_60'
                      WHEN v_today - i.due_date <= 90 THEN 'd61_90'
                      ELSE 'd90_plus' END AS bucket,
                 round(coalesce(i.total, 0) - coalesce(i.amount_paid, 0), 2) AS remaining
            FROM public.crm_invoices i
           WHERE i.doc_status = 'posted'
        ) x
       WHERE remaining > 0.001
       GROUP BY 1, 2
    ),
    actual AS (
      SELECT a.customer_id, b.bucket, b.amt
        FROM public.rma_ar_aging(v_today) a
       CROSS JOIN LATERAL (VALUES ('not_due', a.not_due), ('d1_30', a.d1_30), ('d31_60', a.d31_60),
                                  ('d61_90', a.d61_90), ('d90_plus', a.d90_plus), ('no_due_date', a.no_due_date)) b(bucket, amt)
       WHERE b.amt <> 0
    )
    SELECT coalesce(sum(abs(coalesce(e.amt, 0) - coalesce(a.amt, 0))), 0) INTO v_diff
      FROM expected e FULL JOIN actual a USING (customer_id, bucket);
    IF v_diff <> 0 THEN
      v_failures := array_append(v_failures, format('CHECK 2: receivables aging on %s differs by %s', v_today, v_diff));
    END IF;
  END LOOP;

  -- ── CHECK 3: payables aging = per-invoice computation in base currency ──────
  v_checks := v_checks + 1;
  FOREACH v_off IN ARRAY v_offsets LOOP
    v_today := coalesce((SELECT min(due_date) FROM public.vendor_invoices WHERE due_date IS NOT NULL), current_date) + v_off;
    WITH expected AS (
      SELECT vendor_id, bucket, sum(round(remaining * rate, 2)) AS amt
        FROM (
          SELECT vi.vendor_id,
                 CASE WHEN vi.due_date IS NULL THEN 'no_due_date'
                      WHEN v_today - vi.due_date <= 0 THEN 'not_due'
                      WHEN v_today - vi.due_date <= 30 THEN 'd1_30'
                      WHEN v_today - vi.due_date <= 60 THEN 'd31_60'
                      WHEN v_today - vi.due_date <= 90 THEN 'd61_90'
                      ELSE 'd90_plus' END AS bucket,
                 round(coalesce(vi.total, 0) - coalesce(vi.amount_paid, 0), 2) AS remaining,
                 CASE WHEN coalesce(vi.exchange_rate, 0) = 0 THEN 1 ELSE vi.exchange_rate END AS rate
            FROM public.vendor_invoices vi
           WHERE vi.status IN ('approved', 'partially_received', 'received')
        ) x
       WHERE remaining > 0.001
       GROUP BY 1, 2
    ),
    actual AS (
      SELECT a.vendor_id, b.bucket, b.amt
        FROM public.rma_ap_aging(v_today) a
       CROSS JOIN LATERAL (VALUES ('not_due', a.not_due), ('d1_30', a.d1_30), ('d31_60', a.d31_60),
                                  ('d61_90', a.d61_90), ('d90_plus', a.d90_plus), ('no_due_date', a.no_due_date)) b(bucket, amt)
       WHERE b.amt <> 0
    )
    SELECT coalesce(sum(abs(coalesce(e.amt, 0) - coalesce(a.amt, 0))), 0) INTO v_diff
      FROM expected e FULL JOIN actual a USING (vendor_id, bucket);
    IF v_diff <> 0 THEN
      v_failures := array_append(v_failures, format('CHECK 3: payables aging on %s differs by %s', v_today, v_diff));
    END IF;
  END LOOP;

  -- ── CHECK 4: each report row's buckets add up to its total ──────────────────
  v_checks := v_checks + 1;
  IF EXISTS (SELECT 1 FROM public.rma_ar_aging(current_date) WHERE not_due + d1_30 + d31_60 + d61_90 + d90_plus + no_due_date <> total)
     OR EXISTS (SELECT 1 FROM public.rma_ap_aging(current_date) WHERE not_due + d1_30 + d31_60 + d61_90 + d90_plus + no_due_date <> total) THEN
    v_failures := array_append(v_failures, 'CHECK 4: a row''s buckets do not add up to its total');
  END IF;

  -- ── CHECK 5: payment views ──────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF (SELECT count(*) FROM public.v_payments_list) <> (SELECT count(*) FROM public.payments)
     OR (SELECT count(*) FROM public.v_vendor_payments_list) <> (SELECT count(*) FROM public.vendor_payments)
     OR EXISTS (SELECT 1 FROM public.v_payments_list p JOIN public.customers c ON c.id = p.customer_id
                 WHERE p.customer_name IS DISTINCT FROM coalesce(nullif(c.company_name, ''), nullif(c.contact_person, '')))
     OR EXISTS (SELECT 1 FROM public.v_vendor_payments_list p JOIN public.brands b ON b.id = p.vendor_id
                 WHERE p.vendor_name IS DISTINCT FROM nullif(b.brand_name, '')) THEN
    v_failures := array_append(v_failures, 'CHECK 5: a payments view drops rows or names them wrongly');
  END IF;

  -- ── CHECK 6: access ─────────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF has_table_privilege('anon', 'public.v_payments_list', 'SELECT')
     OR has_table_privilege('anon', 'public.v_vendor_payments_list', 'SELECT')
     OR has_function_privilege('anon', 'public.rma_ar_aging(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_ap_aging(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rma_ar_aging(date)', 'EXECUTE') THEN
    v_failures := array_append(v_failures, 'CHECK 6: grants on the Accounting views/functions are wrong');
  END IF;

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % accounting check(s) FAILED:\n%',
      array_length(v_failures, 1), v_checks, array_to_string(v_failures, E'\n');
  END IF;
  RAISE NOTICE 'All % accounting checks passed', v_checks;
END $$;
