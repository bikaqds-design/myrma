-- 20260864_report_summaries.sql
--
-- Server-side numbers for the Reports page. (Audit finding BUG-066, phase 6.)
--
-- Reports loaded every ticket, customer, time entry, invoice, quotation, sales
-- order, payment, deal and lead — and the Profitability tab every invoice
-- margin row — then filtered them to the date range and computed every KPI,
-- funnel, breakdown and table in the browser. The Data API returns at most
-- 1 000 rows per request, so past that each report described part of the
-- business as if it were all of it.
--
-- The range is [p_from, p_to]: the viewer's local start of the first day and
-- end of the last, sent from the browser, so the page's inRange() is unchanged.
-- Every other rule is the page's own, noted where it is not obvious.
--
--   rma_report_ticket_summary      Tickets tab KPIs + its filter options
--   rma_report_customer_summary    Customers tab KPIs
--   rma_report_customers           Customers tab rows (paged by the caller)
--   rma_report_technicians         Technicians tab rows
--   rma_report_pipeline            Pipeline tab: deal groups, ages, lost
--                                  reasons, lead sources
--   rma_report_sales               Sales tab: quotation KPIs, lineage funnel,
--                                  standalone documents, by rep
--   rma_report_financial           Financial tab KPIs
--   v_report_invoices              Financial tab rows (invoice + customer name)
--   rma_margin_totals              Profitability totals (raw sums)
--
-- SECURITY INVOKER throughout. Read-only; authenticated only.

-- ═══ Tickets ═════════════════════════════════════════════════════════════════
-- Resolution hours: a Completed ticket's updated_date minus created_date, to one
-- decimal, when positive; the average is of those rounded figures. SLA met: a
-- Completed ticket with a due date, updated on or before it. Overdue: a due
-- date before p_now on a ticket that is neither Completed nor Cancelled. Due
-- dates are read as UTC midnight, as `new Date('yyyy-mm-dd')` did. Options are
-- the values present in the range, sorted by code point like Array.sort().

CREATE OR REPLACE FUNCTION public.rma_report_ticket_summary(
  p_from timestamptz, p_to timestamptz, p_status text, p_priority text, p_technician text, p_now timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH ranged AS (
    SELECT * FROM public.rma_tickets t
     WHERE t.created_date IS NOT NULL AND t.created_date >= p_from AND t.created_date <= p_to
  ),
  filtered AS (
    SELECT * FROM ranged
     WHERE (coalesce(p_status, '') = '' OR ticket_status = p_status)
       AND (coalesce(p_priority, '') = '' OR priority = p_priority)
       AND (coalesce(p_technician, '') = '' OR assigned_technician = p_technician)
  ),
  completed AS (
    SELECT f.*,
           CASE WHEN f.updated_date > f.created_date
                THEN round((extract(epoch FROM (f.updated_date - f.created_date)) / 3600)::numeric, 1)
           END AS hrs
      FROM filtered f
     WHERE f.ticket_status = 'Completed'
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM filtered),
    'completed', (SELECT count(*) FROM completed),
    'avg_resolution_hours', (SELECT avg(hrs) FROM completed WHERE hrs IS NOT NULL),
    'completed_with_due', (SELECT count(*) FROM completed WHERE due_date IS NOT NULL),
    'sla_met', (SELECT count(*) FROM completed
                 WHERE due_date IS NOT NULL AND updated_date <= (due_date::timestamp AT TIME ZONE 'UTC')),
    'overdue', (SELECT count(*) FROM filtered
                 WHERE due_date IS NOT NULL
                   AND (due_date::timestamp AT TIME ZONE 'UTC') < coalesce(p_now, now())
                   AND ticket_status IS DISTINCT FROM 'Completed' AND ticket_status IS DISTINCT FROM 'Cancelled'),
    'statuses', coalesce((SELECT jsonb_agg(v ORDER BY v COLLATE "C") FROM (SELECT DISTINCT ticket_status AS v FROM ranged WHERE coalesce(ticket_status, '') <> '') s), '[]'::jsonb),
    'priorities', coalesce((SELECT jsonb_agg(v ORDER BY v COLLATE "C") FROM (SELECT DISTINCT priority AS v FROM ranged WHERE coalesce(priority, '') <> '') s), '[]'::jsonb),
    'technicians', coalesce((SELECT jsonb_agg(v ORDER BY v COLLATE "C") FROM (SELECT DISTINCT assigned_technician AS v FROM ranged WHERE coalesce(assigned_technician, '') <> '') s), '[]'::jsonb)
  );
$fn$;

-- ═══ Customers ═══════════════════════════════════════════════════════════════
-- Customers created in the range, each with the tickets created in the range
-- that name it by id. Open = neither Completed nor Cancelled. Rows sort by
-- ticket count, then as the customer list does (newest first).

CREATE OR REPLACE FUNCTION public.rma_report_customers(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  id uuid,
  contact_person text,
  company_name text,
  customer_status text,
  created_date timestamptz,
  total_tickets bigint,
  open_tickets bigint,
  last_activity timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH stats AS (
    SELECT t.customer_id,
           count(*) AS total,
           count(*) FILTER (WHERE t.ticket_status IS DISTINCT FROM 'Completed' AND t.ticket_status IS DISTINCT FROM 'Cancelled') AS open,
           max(t.created_date) AS last_activity
      FROM public.rma_tickets t
     WHERE t.customer_id IS NOT NULL
       AND t.created_date IS NOT NULL AND t.created_date >= p_from AND t.created_date <= p_to
     GROUP BY t.customer_id
  )
  SELECT c.id, c.contact_person, c.company_name, c.customer_status, c.created_date,
         coalesce(s.total, 0), coalesce(s.open, 0), s.last_activity
    FROM public.customers c
    LEFT JOIN stats s ON s.customer_id = c.id
   WHERE c.created_date IS NOT NULL AND c.created_date >= p_from AND c.created_date <= p_to;
$fn$;

CREATE OR REPLACE FUNCTION public.rma_report_customer_summary(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'customers', (SELECT count(*) FROM public.rma_report_customers(p_from, p_to)),
    'active', (SELECT count(*) FROM public.rma_report_customers(p_from, p_to) WHERE customer_status = 'Active'),
    'returning', (SELECT count(*) FROM public.rma_report_customers(p_from, p_to) WHERE total_tickets > 1),
    'tickets', (SELECT count(*) FROM public.rma_tickets
                 WHERE created_date IS NOT NULL AND created_date >= p_from AND created_date <= p_to)
  );
$fn$;

-- ═══ Technicians ═════════════════════════════════════════════════════════════
-- One row per technician assigned a ticket in the range. Hours logged are
-- every time entry the technician logged (not only in the range), as before.

CREATE OR REPLACE FUNCTION public.rma_report_technicians(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  email text,
  assigned bigint,
  completed bigint,
  avg_resolution_hours numeric,
  hours_logged numeric,
  last_assigned timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH ranged AS (
    SELECT t.assigned_technician AS email, t.ticket_status, t.created_date,
           CASE WHEN t.ticket_status = 'Completed' AND t.updated_date > t.created_date
                THEN round((extract(epoch FROM (t.updated_date - t.created_date)) / 3600)::numeric, 1)
           END AS hrs
      FROM public.rma_tickets t
     WHERE coalesce(t.assigned_technician, '') <> ''
       AND t.created_date IS NOT NULL AND t.created_date >= p_from AND t.created_date <= p_to
  ),
  hours AS (
    SELECT e.user_email AS email, sum(coalesce(e.duration_min, 0))::numeric / 60 AS h
      FROM public.time_entries e
     WHERE coalesce(e.user_email, '') <> ''
     GROUP BY e.user_email
  )
  SELECT r.email,
         count(*),
         count(*) FILTER (WHERE r.ticket_status = 'Completed'),
         avg(r.hrs),
         coalesce(max(h.h), 0),
         max(r.created_date)
    FROM ranged r
    LEFT JOIN hours h ON h.email = r.email
   GROUP BY r.email;
$fn$;

-- ═══ Pipeline ════════════════════════════════════════════════════════════════
-- Deals and leads created in the range. Deal groups carry every count and value
-- the tab shows; ages are whole days (rounded, never negative) to p_now for open
-- deals and to won_at for won ones. A blank rep, reason or source is null.
-- Converted lead = status 'converted' or a converted_at.

CREATE OR REPLACE FUNCTION public.rma_report_pipeline(p_from timestamptz, p_to timestamptz, p_now timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH d AS (
    SELECT * FROM public.deals WHERE created_at IS NOT NULL AND created_at >= p_from AND created_at <= p_to
  ),
  l AS (
    SELECT * FROM public.leads WHERE created_at IS NOT NULL AND created_at >= p_from AND created_at <= p_to
  )
  SELECT jsonb_build_object(
    'deal_groups', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'pipeline_id', pipeline_id, 'stage', stage, 'status', status, 'rep', rep, 'count', n, 'value', v) ORDER BY newest DESC NULLS LAST)
      FROM (SELECT pipeline_id, stage, status, nullif(assigned_rep, '') AS rep, count(*) AS n,
                   coalesce(sum(coalesce(value, 0)), 0) AS v, max(created_at) AS newest
              FROM d GROUP BY 1, 2, 3, 4) g), '[]'::jsonb),
    'open_age_days_sum', (SELECT coalesce(sum(greatest(0, round(extract(epoch FROM (coalesce(p_now, now()) - created_at)) / 86400))), 0)
                            FROM d WHERE status = 'open'),
    'won_cycle', (SELECT jsonb_build_object('count', count(*),
                     'days_sum', coalesce(sum(greatest(0, round(extract(epoch FROM (won_at - created_at)) / 86400))), 0))
                    FROM d WHERE status = 'won' AND won_at IS NOT NULL),
    'lost_reasons', coalesce((SELECT jsonb_agg(jsonb_build_object('reason', reason, 'count', n) ORDER BY n DESC, newest DESC NULLS LAST)
      FROM (SELECT nullif(lost_reason, '') AS reason, count(*) AS n, max(created_at) AS newest
              FROM d WHERE status = 'lost' GROUP BY 1) r), '[]'::jsonb),
    'lead_sources', coalesce((SELECT jsonb_agg(jsonb_build_object('source', source, 'total', n, 'converted', c) ORDER BY n DESC, newest DESC NULLS LAST)
      FROM (SELECT nullif(source, '') AS source, count(*) AS n,
                   count(*) FILTER (WHERE status = 'converted' OR converted_at IS NOT NULL) AS c,
                   max(created_at) AS newest
              FROM l GROUP BY 1) s), '[]'::jsonb)
  );
$fn$;

-- ═══ Sales ═══════════════════════════════════════════════════════════════════
-- Quotations, orders and invoices created in the range; payments dated in it
-- (payment_date read as UTC midnight, else created_at). Won quotations are
-- converted or accepted, lost ones declined or expired. The funnel follows
-- lineage from the range's quotations through EVERY non-cancelled order and
-- invoice, whenever raised; "standalone" counts the range's live orders and
-- invoices that do not descend from it.

CREATE OR REPLACE FUNCTION public.rma_report_sales(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH qt AS (
    SELECT * FROM public.quotations WHERE created_at IS NOT NULL AND created_at >= p_from AND created_at <= p_to
  ),
  so_r AS (
    SELECT * FROM public.sales_orders
     WHERE created_at IS NOT NULL AND created_at >= p_from AND created_at <= p_to AND status IS DISTINCT FROM 'cancelled'
  ),
  inv_r AS (
    SELECT * FROM public.crm_invoices
     WHERE created_at IS NOT NULL AND created_at >= p_from AND created_at <= p_to AND doc_status IS DISTINCT FROM 'cancelled'
  ),
  pay_r AS (
    SELECT * FROM public.payments p
     WHERE coalesce(p.payment_date::timestamp AT TIME ZONE 'UTC', p.created_at) >= p_from
       AND coalesce(p.payment_date::timestamp AT TIME ZONE 'UTC', p.created_at) <= p_to
       AND p.status IS DISTINCT FROM 'voided'
  ),
  ofq AS (
    SELECT o.id, o.total FROM public.sales_orders o
     WHERE o.status IS DISTINCT FROM 'cancelled' AND o.quotation_id IN (SELECT id FROM qt)
  ),
  ifq AS (
    SELECT i.total FROM public.crm_invoices i
     WHERE i.doc_status IS DISTINCT FROM 'cancelled' AND i.so_id IN (SELECT id FROM ofq)
  )
  SELECT jsonb_build_object(
    'quotations', (SELECT jsonb_build_object(
        'count', count(*),
        'value', coalesce(sum(coalesce(total, 0)), 0),
        'won', count(*) FILTER (WHERE status IN ('converted', 'accepted')),
        'lost', count(*) FILTER (WHERE status IN ('declined', 'expired'))) FROM qt),
    'invoiced', (SELECT jsonb_build_object('count', count(*), 'value', coalesce(sum(coalesce(total, 0)), 0)) FROM inv_r),
    'collected', (SELECT jsonb_build_object('count', count(*), 'value', coalesce(sum(coalesce(amount, 0)), 0)) FROM pay_r),
    'funnel_orders', (SELECT jsonb_build_object('count', count(*), 'value', coalesce(sum(coalesce(total, 0)), 0)) FROM ofq),
    'funnel_invoices', (SELECT jsonb_build_object('count', count(*), 'value', coalesce(sum(coalesce(total, 0)), 0)) FROM ifq),
    'standalone_orders', (SELECT count(*) FROM so_r WHERE quotation_id IS NULL OR quotation_id NOT IN (SELECT id FROM qt)),
    'standalone_invoices', (SELECT count(*) FROM inv_r WHERE so_id IS NULL OR so_id NOT IN (SELECT id FROM ofq)),
    'by_rep', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'rep', rep, 'raised', raised, 'won', won, 'lost', lost, 'value', v, 'won_value', wv) ORDER BY wv DESC, newest DESC NULLS LAST)
      FROM (SELECT nullif(assigned_rep, '') AS rep, count(*) AS raised,
                   count(*) FILTER (WHERE status IN ('converted', 'accepted')) AS won,
                   count(*) FILTER (WHERE status IN ('declined', 'expired')) AS lost,
                   coalesce(sum(coalesce(total, 0)), 0) AS v,
                   coalesce(sum(coalesce(total, 0)) FILTER (WHERE status IN ('converted', 'accepted')), 0) AS wv,
                   max(created_at) AS newest
              FROM qt GROUP BY 1) r), '[]'::jsonb)
  );
$fn$;

-- ═══ Financial ═══════════════════════════════════════════════════════════════
-- Invoices created in the range; cancelled ones are out of every money total
-- but stay in the table. Quotes value leaves out cancelled, declined and
-- expired quotations.

CREATE OR REPLACE FUNCTION public.rma_report_financial(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH inv AS (
    SELECT * FROM public.crm_invoices WHERE created_at IS NOT NULL AND created_at >= p_from AND created_at <= p_to
  )
  SELECT jsonb_build_object(
    'invoices', (SELECT count(*) FROM inv),
    'total_invoiced', (SELECT coalesce(sum(coalesce(total, 0)), 0) FROM inv WHERE doc_status IS DISTINCT FROM 'cancelled'),
    'total_paid', (SELECT coalesce(sum(coalesce(amount_paid, 0)), 0) FROM inv WHERE doc_status IS DISTINCT FROM 'cancelled'),
    'outstanding', (SELECT coalesce(sum(greatest(coalesce(total, 0) - coalesce(amount_paid, 0), 0)), 0)
                      FROM inv WHERE doc_status IS DISTINCT FROM 'cancelled'),
    'quotes_value', (SELECT coalesce(sum(coalesce(total, 0)), 0) FROM public.quotations
                      WHERE created_at IS NOT NULL AND created_at >= p_from AND created_at <= p_to
                        AND status IS DISTINCT FROM 'cancelled' AND status IS DISTINCT FROM 'declined'
                        AND status IS DISTINCT FROM 'expired')
  );
$fn$;

CREATE OR REPLACE VIEW public.v_report_invoices
WITH (security_invoker = true)
AS
SELECT i.id, i.inv_code, i.customer_id, i.doc_status, i.payment_status, i.total, i.amount_paid,
       i.due_date, i.created_at,
       coalesce(nullif(c.company_name, ''), nullif(c.contact_person, '')) AS customer_name
  FROM public.crm_invoices i
  LEFT JOIN public.customers c ON c.id = i.customer_id;

COMMENT ON VIEW public.v_report_invoices IS 'Invoices with the customer name the Financial report shows. (BUG-066.)';

-- ═══ Profitability ═══════════════════════════════════════════════════════════
-- Raw sums over v_invoice_margin; the page rounds them exactly as
-- summariseMargin always did. Only an invoice whose cost is complete (and whose
-- margin is known) contributes to costed revenue, cost and margin.

CREATE OR REPLACE FUNCTION public.rma_margin_totals()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'invoices', count(*),
    'invoices_costed', count(*) FILTER (WHERE cogs_complete AND margin_base IS NOT NULL),
    'revenue_base', coalesce(sum(coalesce(revenue_base, 0)), 0),
    'costed_revenue_base', coalesce(sum(coalesce(revenue_base, 0)) FILTER (WHERE cogs_complete AND margin_base IS NOT NULL), 0),
    'cogs_base', coalesce(sum(coalesce(cogs_base, 0)) FILTER (WHERE cogs_complete AND margin_base IS NOT NULL), 0),
    'margin_base', coalesce(sum(coalesce(margin_base, 0)) FILTER (WHERE cogs_complete AND margin_base IS NOT NULL), 0)
  )
  FROM public.v_invoice_margin;
$fn$;

-- ═══ Grants ══════════════════════════════════════════════════════════════════

REVOKE ALL ON public.v_report_invoices FROM PUBLIC, anon;
GRANT SELECT ON public.v_report_invoices TO authenticated, service_role;

DO $grants$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.rma_report_ticket_summary(timestamptz, timestamptz, text, text, text, timestamptz)',
    'public.rma_report_customers(timestamptz, timestamptz)',
    'public.rma_report_customer_summary(timestamptz, timestamptz)',
    'public.rma_report_technicians(timestamptz, timestamptz)',
    'public.rma_report_pipeline(timestamptz, timestamptz, timestamptz)',
    'public.rma_report_sales(timestamptz, timestamptz)',
    'public.rma_report_financial(timestamptz, timestamptz)',
    'public.rma_margin_totals()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END
$grants$;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $guard$
DECLARE
  v_from timestamptz := '-infinity';
  v_to timestamptz := 'infinity';
BEGIN
  IF (public.rma_report_ticket_summary(v_from, v_to, NULL, NULL, NULL, now())->>'total')::bigint
       <> (SELECT count(*) FROM public.rma_tickets WHERE created_date IS NOT NULL)
     OR (SELECT count(*) FROM public.rma_report_customers(v_from, v_to))
       <> (SELECT count(*) FROM public.customers WHERE created_date IS NOT NULL)
     OR (SELECT coalesce(sum((g->>'count')::bigint), 0) FROM jsonb_array_elements(public.rma_report_pipeline(v_from, v_to, now())->'deal_groups') g)
       <> (SELECT count(*) FROM public.deals WHERE created_at IS NOT NULL)
     OR (public.rma_report_financial(v_from, v_to)->>'invoices')::bigint
       <> (SELECT count(*) FROM public.crm_invoices WHERE created_at IS NOT NULL)
     OR (SELECT count(*) FROM public.v_report_invoices) <> (SELECT count(*) FROM public.crm_invoices)
     OR (public.rma_margin_totals()->>'invoices')::bigint <> (SELECT count(*) FROM public.v_invoice_margin) THEN
    RAISE EXCEPTION 'Refusing to apply: a report summary does not cover every row';
  END IF;
END
$guard$;
