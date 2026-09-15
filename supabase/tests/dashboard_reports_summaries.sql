-- ############################################################################
-- #  DB TEST TIER — Dashboard, Reports, Control Panel, Customer/Product
-- #  history (BUG-066, phases 5d and 6)
-- #
-- #  20260863, 20260864 and 20260865 replace in-browser counting over whole
-- #  tables with database functions. Each check below recomputes a figure the
-- #  plain way — straight from the tables, written independently of the
-- #  function — over whatever data exists, and requires the two to agree:
-- #
-- #    1  dashboard ticket summary, for "All" and for a range
-- #    2  dashboard CRM figures
-- #    3  inventory units per status
-- #    4  Control Panel tiles
-- #    5  deals per pipeline × stage
-- #    6  Data Cleanup: stale tickets, orphan customers, duplicate groups
-- #    7  Reports: ticket KPIs with and without filters
-- #    8  Reports: customers rows and KPIs
-- #    9  Reports: technicians
-- #   10  Reports: pipeline deal groups, lost reasons, lead sources
-- #   11  Reports: sales quotations, lineage funnel, standalone, collected
-- #   12  Reports: financial totals and the invoice view
-- #   13  Profitability totals
-- #   14  customer activity log, product ticket history, name-key lookup
-- #   15  nothing is readable or callable by anon
-- #
-- #  NOT in CI: the db-tests job is disabled (needs Docker). Run against the
-- #  hosted project inside a transaction that is rolled back.
-- ############################################################################

DO $$
DECLARE
  v_failures text[] := '{}';
  v_checks int := 0;
  v_j jsonb;
  v_since timestamptz := now() - interval '45 days';
  v_from timestamptz := now() - interval '400 days';
  v_to timestamptz := now();
  v_today date := (now() AT TIME ZONE 'Africa/Cairo')::date;
  v_n bigint;
  v_st text;
BEGIN
  -- ── CHECK 1: dashboard ticket summary ──────────────────────────────────────
  v_checks := v_checks + 1;
  v_j := public.rma_dashboard_ticket_summary(NULL, now(), 'Africa/Cairo');
  IF (v_j->>'total')::bigint <> (SELECT count(*) FROM rma_tickets)
     OR (v_j->>'resolved')::bigint <> (SELECT count(*) FROM rma_tickets WHERE ticket_status IN ('Completed', 'Closed', 'Cancelled'))
     OR (v_j->>'overdue')::bigint <> (SELECT count(*) FROM rma_tickets
                                        WHERE due_date < v_today
                                          AND (ticket_status IS NULL OR ticket_status NOT IN ('Completed', 'Closed', 'Cancelled')))
     OR (v_j->>'tracked')::bigint <> (SELECT count(*) FROM rma_tickets WHERE due_date IS NOT NULL AND ticket_status IS DISTINCT FROM 'Cancelled')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'status_counts') x
                 WHERE (x->>'count')::bigint <> (SELECT count(*) FROM rma_tickets WHERE ticket_status = x->>'status'))
     OR (SELECT count(*) FROM jsonb_array_elements(v_j->'status_counts')) <> (SELECT count(DISTINCT ticket_status) FROM rma_tickets)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'technicians') x
                 WHERE (x->>'total')::bigint <> (SELECT count(*) FROM rma_tickets WHERE nullif(assigned_technician, '') IS NOT DISTINCT FROM x->>'tech'))
     OR ((v_j->'products'->>'rma_stock')::bigint) <> (
          SELECT count(*) FROM rma_tickets t, jsonb_array_elements(CASE WHEN jsonb_typeof(t.products) = 'array' THEN t.products ELSE '[]' END) e
           WHERE t.ticket_status IS DISTINCT FROM 'Cancelled' AND e->>'product_status' IN ('Replacement', 'Credit Note'))
     OR ((v_j->'products'->>'received')::bigint) <> (
          SELECT count(*) FROM rma_tickets t, jsonb_array_elements(CASE WHEN jsonb_typeof(t.products) = 'array' THEN t.products ELSE '[]' END) e
           WHERE t.ticket_status IS DISTINCT FROM 'Cancelled' AND t.ticket_status IS DISTINCT FROM 'Completed'
             AND coalesce(e->>'product_status', '') IN ('', 'Received')) THEN
    v_failures := array_append(v_failures, format('CHECK 1: dashboard ticket summary (all) is wrong: %s', v_j));
  END IF;
  v_j := public.rma_dashboard_ticket_summary(v_since, now(), 'Africa/Cairo');
  IF (v_j->>'total')::bigint <> (SELECT count(*) FROM rma_tickets WHERE created_date >= v_since)
     OR (SELECT coalesce(sum((value)::bigint), 0) FROM jsonb_each_text(v_j->'daily_created'))
        <> (SELECT count(*) FROM rma_tickets WHERE created_date >= v_since AND created_date >= now() - interval '31 days') THEN
    v_failures := array_append(v_failures, 'CHECK 1: dashboard ticket summary for a range is wrong');
  END IF;

  -- ── CHECK 2: dashboard CRM ─────────────────────────────────────────────────
  v_checks := v_checks + 1;
  v_j := public.rma_dashboard_crm(date_trunc('month', now()));
  IF (v_j->>'open_value')::numeric <> (SELECT coalesce(sum(coalesce(value, 0)), 0) FROM deals WHERE status = 'open')
     OR (v_j->>'won_this_month')::bigint <> (SELECT count(*) FROM deals WHERE status = 'won' AND won_at >= date_trunc('month', now()))
     OR (v_j->>'leads_this_month')::bigint <> (SELECT count(*) FROM leads WHERE created_at >= date_trunc('month', now()))
     OR (SELECT coalesce(sum((x->>'count')::bigint), 0) FROM jsonb_array_elements(v_j->'open_by_stage') x)
        <> (SELECT count(*) FROM deals WHERE status = 'open')
     OR (SELECT coalesce(sum((x->>'value')::numeric), 0) FROM jsonb_array_elements(v_j->'open_by_stage') x)
        <> (SELECT coalesce(sum(coalesce(value, 0)), 0) FROM deals WHERE status = 'open') THEN
    v_failures := array_append(v_failures, format('CHECK 2: dashboard CRM figures are wrong: %s', v_j));
  END IF;

  -- ── CHECK 3: inventory units per status ────────────────────────────────────
  v_checks := v_checks + 1;
  v_j := public.rma_inventory_status_counts();
  IF (v_j->>'total')::bigint <> (SELECT count(*) FROM inventory_units)
     OR (v_j->>'active_rma')::bigint <> (SELECT count(*) FROM inventory_units WHERE status = 'active_rma')
     OR (v_j->>'company_stock')::bigint <> (SELECT count(*) FROM inventory_units WHERE status = 'company_stock') THEN
    v_failures := array_append(v_failures, 'CHECK 3: inventory status counts are wrong');
  END IF;

  -- ── CHECK 4: Control Panel tiles ───────────────────────────────────────────
  v_checks := v_checks + 1;
  v_j := public.rma_control_panel_stats(now());
  IF (v_j->>'open_tickets')::bigint <> (SELECT count(*) FROM rma_tickets WHERE ticket_status IN ('Open', 'In Progress', 'On Hold'))
     OR (v_j->>'overdue')::bigint <> (SELECT count(*) FROM rma_tickets
                                        WHERE due_date IS NOT NULL AND due_date::timestamp < (now() AT TIME ZONE 'UTC')
                                          AND coalesce(ticket_status, '') NOT IN ('Closed', 'Cancelled'))
     OR (v_j->>'customers')::bigint <> (SELECT count(*) FROM customers)
     OR (v_j->>'users')::bigint <> (SELECT count(*) FROM user_roles)
     OR (v_j->>'mis_staged')::bigint <> (
          SELECT count(*) FROM deals d JOIN pipelines p ON p.id = d.pipeline_id
           WHERE d.stage IS NULL OR NOT (p.stages @> jsonb_build_array(jsonb_build_object('id', d.stage)))) THEN
    v_failures := array_append(v_failures, format('CHECK 4: control panel stats are wrong: %s', v_j));
  END IF;

  -- ── CHECK 5: deals per pipeline × stage ────────────────────────────────────
  v_checks := v_checks + 1;
  IF EXISTS (SELECT 1 FROM public.rma_pipeline_stage_counts() s
              WHERE s.deal_count <> (SELECT count(*) FROM deals d WHERE d.pipeline_id = s.pipeline_id AND d.stage IS NOT DISTINCT FROM s.stage))
     OR (SELECT coalesce(sum(deal_count), 0) FROM public.rma_pipeline_stage_counts()) <> (SELECT count(*) FROM deals WHERE pipeline_id IS NOT NULL) THEN
    v_failures := array_append(v_failures, 'CHECK 5: pipeline stage counts are wrong');
  END IF;

  -- ── CHECK 6: Data Cleanup ──────────────────────────────────────────────────
  v_checks := v_checks + 1;
  v_j := public.rma_data_cleanup_summary(now() - interval '90 days', now() - interval '30 days');
  IF (v_j->>'stale_completed')::bigint <> (SELECT count(*) FROM rma_tickets WHERE ticket_status = 'Completed' AND updated_date < now() - interval '90 days')
     OR (v_j->>'stale_cancelled')::bigint <> (SELECT count(*) FROM rma_tickets WHERE ticket_status = 'Cancelled' AND updated_date < now() - interval '30 days')
     OR (v_j->>'orphans')::bigint <> (
          SELECT count(*) FROM customers c
           WHERE c.id NOT IN (SELECT customer_id FROM rma_tickets WHERE customer_id IS NOT NULL)
             AND coalesce(CASE WHEN c.customer_type = 'B2B' AND c.company_name <> '' THEN c.company_name ELSE c.contact_person END, '')
                 NOT IN (SELECT customer_name FROM rma_tickets WHERE coalesce(customer_name, '') <> ''))
     OR (v_j->>'duplicate_groups')::bigint <> (
          SELECT count(*) FROM (
            SELECT btrim(lower(coalesce(nullif(company_name, ''), nullif(contact_person, ''), ''))) AS k
              FROM customers GROUP BY 1 HAVING count(*) > 1 AND btrim(lower(coalesce(nullif(company_name, ''), nullif(contact_person, ''), ''))) <> '') g)
     OR EXISTS (SELECT 1 FROM public.rma_duplicate_customers() d WHERE d.group_size < 2) THEN
    v_failures := array_append(v_failures, format('CHECK 6: data cleanup summary is wrong: %s', v_j));
  END IF;

  -- ── CHECK 7: Reports tickets ───────────────────────────────────────────────
  v_checks := v_checks + 1;
  v_j := public.rma_report_ticket_summary(v_from, v_to, NULL, NULL, NULL, now());
  IF (v_j->>'total')::bigint <> (SELECT count(*) FROM rma_tickets WHERE created_date BETWEEN v_from AND v_to)
     OR (v_j->>'completed')::bigint <> (SELECT count(*) FROM rma_tickets WHERE created_date BETWEEN v_from AND v_to AND ticket_status = 'Completed')
     OR (v_j->>'sla_met')::bigint <> (SELECT count(*) FROM rma_tickets
                                        WHERE created_date BETWEEN v_from AND v_to AND ticket_status = 'Completed' AND due_date IS NOT NULL
                                          AND updated_date <= due_date::timestamp AT TIME ZONE 'UTC')
     OR (v_j->>'overdue')::bigint <> (SELECT count(*) FROM rma_tickets
                                        WHERE created_date BETWEEN v_from AND v_to AND due_date IS NOT NULL
                                          AND due_date::timestamp AT TIME ZONE 'UTC' < now()
                                          AND coalesce(ticket_status, '') NOT IN ('Completed', 'Cancelled'))
     OR coalesce((v_j->>'avg_resolution_hours')::numeric, -1) <> coalesce((
          SELECT avg(round((extract(epoch FROM updated_date - created_date) / 3600)::numeric, 1)) FROM rma_tickets
           WHERE created_date BETWEEN v_from AND v_to AND ticket_status = 'Completed' AND updated_date > created_date), -1)
     OR jsonb_array_length(v_j->'statuses') <> (SELECT count(DISTINCT ticket_status) FROM rma_tickets WHERE created_date BETWEEN v_from AND v_to AND ticket_status <> '') THEN
    v_failures := array_append(v_failures, format('CHECK 7: report ticket summary is wrong: %s', v_j));
  END IF;
  SELECT ticket_status INTO v_st FROM rma_tickets WHERE ticket_status IS NOT NULL LIMIT 1;
  IF (public.rma_report_ticket_summary(v_from, v_to, v_st, NULL, NULL, now())->>'total')::bigint
     <> (SELECT count(*) FROM rma_tickets WHERE created_date BETWEEN v_from AND v_to AND ticket_status = v_st) THEN
    v_failures := array_append(v_failures, 'CHECK 7: the status filter narrows the ticket summary wrongly');
  END IF;

  -- ── CHECK 8: Reports customers ─────────────────────────────────────────────
  v_checks := v_checks + 1;
  v_j := public.rma_report_customer_summary(v_from, v_to);
  IF (v_j->>'customers')::bigint <> (SELECT count(*) FROM customers WHERE created_date BETWEEN v_from AND v_to)
     OR (v_j->>'active')::bigint <> (SELECT count(*) FROM customers WHERE created_date BETWEEN v_from AND v_to AND customer_status = 'Active')
     OR (v_j->>'tickets')::bigint <> (SELECT count(*) FROM rma_tickets WHERE created_date BETWEEN v_from AND v_to)
     OR EXISTS (SELECT 1 FROM public.rma_report_customers(v_from, v_to) r
                 WHERE r.total_tickets <> (SELECT count(*) FROM rma_tickets t WHERE t.customer_id = r.id AND t.created_date BETWEEN v_from AND v_to)
                    OR r.open_tickets <> (SELECT count(*) FROM rma_tickets t WHERE t.customer_id = r.id AND t.created_date BETWEEN v_from AND v_to
                                            AND coalesce(t.ticket_status, '') NOT IN ('Completed', 'Cancelled'))) THEN
    v_failures := array_append(v_failures, format('CHECK 8: report customers are wrong: %s', v_j));
  END IF;

  -- ── CHECK 9: Reports technicians ───────────────────────────────────────────
  v_checks := v_checks + 1;
  IF (SELECT coalesce(sum(assigned), 0) FROM public.rma_report_technicians(v_from, v_to))
       <> (SELECT count(*) FROM rma_tickets WHERE created_date BETWEEN v_from AND v_to AND coalesce(assigned_technician, '') <> '')
     OR EXISTS (SELECT 1 FROM public.rma_report_technicians(v_from, v_to) r
                 WHERE r.hours_logged <> (SELECT coalesce(sum(coalesce(duration_min, 0)), 0)::numeric / 60 FROM time_entries WHERE user_email = r.email)) THEN
    v_failures := array_append(v_failures, 'CHECK 9: report technicians are wrong');
  END IF;

  -- ── CHECK 10: Reports pipeline ─────────────────────────────────────────────
  v_checks := v_checks + 1;
  v_j := public.rma_report_pipeline(v_from, v_to, now());
  IF (SELECT coalesce(sum((g->>'count')::bigint), 0) FROM jsonb_array_elements(v_j->'deal_groups') g)
       <> (SELECT count(*) FROM deals WHERE created_at BETWEEN v_from AND v_to)
     OR (SELECT coalesce(sum((g->>'value')::numeric), 0) FROM jsonb_array_elements(v_j->'deal_groups') g WHERE g->>'status' = 'won')
       <> (SELECT coalesce(sum(coalesce(value, 0)), 0) FROM deals WHERE created_at BETWEEN v_from AND v_to AND status = 'won')
     OR (SELECT coalesce(sum((r->>'count')::bigint), 0) FROM jsonb_array_elements(v_j->'lost_reasons') r)
       <> (SELECT count(*) FROM deals WHERE created_at BETWEEN v_from AND v_to AND status = 'lost')
     OR (SELECT coalesce(sum((s->>'total')::bigint), 0) FROM jsonb_array_elements(v_j->'lead_sources') s)
       <> (SELECT count(*) FROM leads WHERE created_at BETWEEN v_from AND v_to)
     OR (SELECT coalesce(sum((s->>'converted')::bigint), 0) FROM jsonb_array_elements(v_j->'lead_sources') s)
       <> (SELECT count(*) FROM leads WHERE created_at BETWEEN v_from AND v_to AND (status = 'converted' OR converted_at IS NOT NULL))
     OR (v_j->>'open_age_days_sum')::numeric
       <> (SELECT coalesce(sum(greatest(0, round(extract(epoch FROM now() - created_at) / 86400))), 0) FROM deals
            WHERE created_at BETWEEN v_from AND v_to AND status = 'open') THEN
    v_failures := array_append(v_failures, 'CHECK 10: report pipeline figures are wrong');
  END IF;

  -- ── CHECK 11: Reports sales ────────────────────────────────────────────────
  v_checks := v_checks + 1;
  v_j := public.rma_report_sales(v_from, v_to);
  IF (v_j->'quotations'->>'count')::bigint <> (SELECT count(*) FROM quotations WHERE created_at BETWEEN v_from AND v_to)
     OR (v_j->'quotations'->>'won')::bigint <> (SELECT count(*) FROM quotations WHERE created_at BETWEEN v_from AND v_to AND status IN ('converted', 'accepted'))
     OR (v_j->'funnel_orders'->>'count')::bigint <> (
          SELECT count(*) FROM sales_orders o JOIN quotations q ON q.id = o.quotation_id
           WHERE q.created_at BETWEEN v_from AND v_to AND coalesce(o.status, '') <> 'cancelled')
     OR (v_j->'funnel_invoices'->>'count')::bigint <> (
          SELECT count(*) FROM crm_invoices i
            JOIN sales_orders o ON o.id = i.so_id AND coalesce(o.status, '') <> 'cancelled'
            JOIN quotations q ON q.id = o.quotation_id AND q.created_at BETWEEN v_from AND v_to
           WHERE coalesce(i.doc_status, '') <> 'cancelled')
     OR (v_j->'collected'->>'value')::numeric <> (
          SELECT coalesce(sum(coalesce(amount, 0)), 0) FROM payments
           WHERE coalesce(status, '') <> 'voided'
             AND coalesce(payment_date::timestamp AT TIME ZONE 'UTC', created_at) BETWEEN v_from AND v_to)
     OR (v_j->>'standalone_orders')::bigint + (v_j->'funnel_orders'->>'count')::bigint
        < (SELECT count(*) FROM sales_orders WHERE created_at BETWEEN v_from AND v_to AND coalesce(status, '') <> 'cancelled'
             AND quotation_id IN (SELECT id FROM quotations WHERE created_at BETWEEN v_from AND v_to))
     OR (SELECT coalesce(sum((r->>'raised')::bigint), 0) FROM jsonb_array_elements(v_j->'by_rep') r)
        <> (SELECT count(*) FROM quotations WHERE created_at BETWEEN v_from AND v_to) THEN
    v_failures := array_append(v_failures, format('CHECK 11: report sales figures are wrong: %s', v_j));
  END IF;

  -- ── CHECK 12: Reports financial ────────────────────────────────────────────
  v_checks := v_checks + 1;
  v_j := public.rma_report_financial(v_from, v_to);
  IF (v_j->>'invoices')::bigint <> (SELECT count(*) FROM crm_invoices WHERE created_at BETWEEN v_from AND v_to)
     OR (v_j->>'total_invoiced')::numeric <> (SELECT coalesce(sum(coalesce(total, 0)), 0) FROM crm_invoices WHERE created_at BETWEEN v_from AND v_to AND coalesce(doc_status, '') <> 'cancelled')
     OR (v_j->>'outstanding')::numeric <> (SELECT coalesce(sum(greatest(coalesce(total, 0) - coalesce(amount_paid, 0), 0)), 0) FROM crm_invoices
                                             WHERE created_at BETWEEN v_from AND v_to AND coalesce(doc_status, '') <> 'cancelled')
     OR (SELECT count(*) FROM v_report_invoices) <> (SELECT count(*) FROM crm_invoices)
     OR EXISTS (SELECT 1 FROM v_report_invoices r JOIN customers c ON c.id = r.customer_id
                 WHERE r.customer_name IS DISTINCT FROM coalesce(nullif(c.company_name, ''), nullif(c.contact_person, ''))) THEN
    v_failures := array_append(v_failures, format('CHECK 12: report financial figures are wrong: %s', v_j));
  END IF;

  -- ── CHECK 13: Profitability totals ─────────────────────────────────────────
  v_checks := v_checks + 1;
  v_j := public.rma_margin_totals();
  IF (v_j->>'invoices')::bigint <> (SELECT count(*) FROM v_invoice_margin)
     OR (v_j->>'revenue_base')::numeric <> (SELECT coalesce(sum(revenue_base), 0) FROM v_invoice_margin)
     OR (v_j->>'margin_base')::numeric <> (SELECT coalesce(sum(margin_base), 0) FROM v_invoice_margin WHERE cogs_complete AND margin_base IS NOT NULL) THEN
    v_failures := array_append(v_failures, format('CHECK 13: margin totals are wrong: %s', v_j));
  END IF;

  -- ── CHECK 14: customer activity, product tickets, name keys ────────────────
  v_checks := v_checks + 1;
  IF EXISTS (SELECT 1 FROM customers c
              WHERE (SELECT count(*) FROM v_customer_activity a WHERE a.customer_id = c.id)
                    <> (SELECT count(*) FROM rma_tickets t WHERE t.customer_id = c.id AND t.created_date IS NOT NULL)
                     + (SELECT count(*) FROM customer_notes n WHERE n.customer_id = c.id AND n.created_date IS NOT NULL)
                     + CASE WHEN c.created_date IS NOT NULL THEN 1 ELSE 0 END)
     OR EXISTS (SELECT 1 FROM (SELECT DISTINCT product_id FROM inventory_units WHERE product_id IS NOT NULL) p
                 WHERE (SELECT count(*) FROM public.rma_product_tickets(p.product_id))
                       <> (SELECT count(DISTINCT u.rma_ticket_id) FROM inventory_units u JOIN rma_tickets t ON t.id = u.rma_ticket_id
                            WHERE u.product_id = p.product_id))
     OR EXISTS (SELECT 1 FROM products p
                 WHERE coalesce(btrim(p.product_name), '') <> ''
                   AND NOT EXISTS (SELECT 1 FROM public.rma_products_by_name_keys(ARRAY[lower(btrim(p.product_name))]) k WHERE k.id = p.id)) THEN
    v_failures := array_append(v_failures, 'CHECK 14: customer activity, product tickets or name-key lookup is wrong');
  END IF;

  -- ── CHECK 15: access ───────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  SELECT count(*) INTO v_n
    FROM (VALUES
      ('public.rma_dashboard_ticket_summary(timestamptz, timestamptz, text)'),
      ('public.rma_dashboard_crm(timestamptz)'),
      ('public.rma_inventory_status_counts()'),
      ('public.rma_control_panel_stats(timestamptz)'),
      ('public.rma_pipeline_stage_counts()'),
      ('public.rma_orphan_customers()'),
      ('public.rma_duplicate_customers()'),
      ('public.rma_data_cleanup_summary(timestamptz, timestamptz)'),
      ('public.rma_report_ticket_summary(timestamptz, timestamptz, text, text, text, timestamptz)'),
      ('public.rma_report_customers(timestamptz, timestamptz)'),
      ('public.rma_report_customer_summary(timestamptz, timestamptz)'),
      ('public.rma_report_technicians(timestamptz, timestamptz)'),
      ('public.rma_report_pipeline(timestamptz, timestamptz, timestamptz)'),
      ('public.rma_report_sales(timestamptz, timestamptz)'),
      ('public.rma_report_financial(timestamptz, timestamptz)'),
      ('public.rma_margin_totals()'),
      ('public.rma_product_tickets(uuid)'),
      ('public.rma_products_by_name_keys(text[])')
    ) f(sig)
   WHERE has_function_privilege('anon', f.sig, 'EXECUTE') OR NOT has_function_privilege('authenticated', f.sig, 'EXECUTE');
  IF v_n > 0
     OR has_table_privilege('anon', 'public.v_report_invoices', 'SELECT')
     OR has_table_privilege('anon', 'public.v_customer_activity', 'SELECT') THEN
    v_failures := array_append(v_failures, format('CHECK 15: %s function(s) or a view have the wrong grants', v_n));
  END IF;

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % summary check(s) FAILED:\n%', array_length(v_failures, 1), v_checks, array_to_string(v_failures, E'\n');
  END IF;
  RAISE NOTICE 'All % summary checks passed', v_checks;
END $$;
