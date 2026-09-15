-- 20260863_dashboard_control_panel_summaries.sql
--
-- Server-side numbers for the Dashboard and the Control Panel. (Audit finding
-- BUG-066, phase 6.)
--
-- The Dashboard loaded every ticket, every inventory unit, every deal, every
-- lead and every overdue activity, and counted, bucketed and summed them in the
-- browser. The Control Panel home did the same with tickets, customers, users
-- and deals; Pipelines & Stages loaded every deal to count them per stage; Data
-- Cleanup loaded every ticket and every customer to find stale tickets, orphan
-- customers and duplicates. The Data API returns at most 1 000 rows per
-- request, so past that every one of those numbers covered part of the data as
-- if it were all of it.
--
--   rma_dashboard_ticket_summary     ticket counts by status/priority/tech,
--                                    overdue, SLA, RMA product stages, daily
--                                    created counts, top issues
--   rma_dashboard_crm                open pipeline value, won this month, leads
--                                    this month, open deals by stage, won by rep
--   rma_inventory_status_counts      inventory units per status + total
--   rma_control_panel_stats          the Control Panel home tiles
--   rma_pipeline_stage_counts        deals per pipeline × stage
--   rma_data_cleanup_summary         stale / orphan / duplicate counts
--   rma_orphan_customers             customers no ticket refers to
--   rma_duplicate_customers          customers sharing a display name
--
-- Every rule below is the one the page applied; the comments say which.
-- SECURITY INVOKER throughout: each caller's RLS applies exactly as it did to
-- the browser's own reads. Read-only; authenticated only.

-- ═══ Dashboard: tickets ══════════════════════════════════════════════════════
-- p_since: the range's start (null for "All"); a ticket with no created_date
-- is only in "All". Status counts and technicians come back in the order the
-- page met them (newest ticket first). Resolved = Completed, Closed, Cancelled. Overdue = not
-- resolved and due before the viewer's local today (a ticket due today is not
-- overdue until the day is over). Daily counts are by UTC date for the last 31
-- days, as the page matched created_date's date prefix. Top issues read every
-- ticket regardless of range.

CREATE OR REPLACE FUNCTION public.rma_dashboard_ticket_summary(p_since timestamptz, p_now timestamptz, p_tz text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH z AS (
    SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN p_tz ELSE 'UTC' END AS tz
  ),
  local_today AS (
    SELECT (coalesce(p_now, now()) AT TIME ZONE z.tz)::date AS d FROM z
  ),
  ranged AS (
    SELECT t.id, t.ticket_status, t.priority, t.assigned_technician, t.created_date, t.due_date, t.products,
           t.ticket_status IN ('Completed', 'Closed', 'Cancelled') AS resolved,
           (t.due_date IS NOT NULL AND t.due_date < (SELECT d FROM local_today)) AS past_due
      FROM public.rma_tickets t
     WHERE p_since IS NULL OR (t.created_date IS NOT NULL AND t.created_date >= p_since)
  ),
  products AS (
    SELECT r.ticket_status AS ts, e->>'product_status' AS ps
      FROM ranged r
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.products) = 'array' THEN r.products ELSE '[]'::jsonb END) e
     WHERE r.ticket_status IS DISTINCT FROM 'Cancelled'
  ),
  kept AS (
    SELECT * FROM products WHERE ts IS DISTINCT FROM 'Completed' OR ps IN ('Replacement', 'Credit Note')
  ),
  issues AS (
    SELECT regexp_replace(e->>'issue_description', '^\s+|\s+$', '', 'g') AS issue, t.created_date
      FROM public.rma_tickets t
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.products) = 'array' THEN t.products ELSE '[]'::jsonb END) e
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM ranged),
    'resolved', (SELECT count(*) FROM ranged WHERE resolved),
    'overdue', (SELECT count(*) FROM ranged WHERE NOT resolved AND past_due),
    'tracked', (SELECT count(*) FROM ranged WHERE due_date IS NOT NULL AND ticket_status IS DISTINCT FROM 'Cancelled'),
    'status_counts', coalesce((SELECT jsonb_agg(jsonb_build_object('status', ticket_status, 'count', n) ORDER BY newest DESC NULLS LAST, ticket_status) FROM (
        SELECT ticket_status, count(*) AS n, max(created_date) AS newest FROM ranged WHERE ticket_status IS NOT NULL GROUP BY 1) s), '[]'::jsonb),
    'priority_counts', coalesce((SELECT jsonb_object_agg(priority, n) FROM (
        SELECT priority, count(*) AS n FROM ranged WHERE coalesce(priority, '') <> '' GROUP BY 1) s), '{}'::jsonb),
    'technicians', coalesce((SELECT jsonb_agg(jsonb_build_object('tech', tech, 'total', total, 'closed', closed) ORDER BY newest DESC NULLS LAST, tech) FROM (
        SELECT nullif(assigned_technician, '') AS tech, count(*) AS total, count(*) FILTER (WHERE resolved) AS closed,
               max(created_date) AS newest
          FROM ranged GROUP BY 1) s), '[]'::jsonb),
    'daily_created', coalesce((SELECT jsonb_object_agg(day, n) FROM (
        SELECT to_char(created_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS n
          FROM ranged
         WHERE created_date >= coalesce(p_now, now()) - interval '31 days'
         GROUP BY 1) s), '{}'::jsonb),
    'products', jsonb_build_object(
      'received',     (SELECT count(*) FROM kept WHERE ts IS DISTINCT FROM 'Completed' AND (coalesce(ps, '') = '' OR ps = 'Received')),
      'under_repair', (SELECT count(*) FROM kept WHERE ts IS DISTINCT FROM 'Completed' AND ps = 'Under Repair'),
      'repaired',     (SELECT count(*) FROM kept WHERE ts IS DISTINCT FROM 'Completed' AND ps = 'Repaired'),
      'cant_repair',  (SELECT count(*) FROM kept WHERE ts IS DISTINCT FROM 'Completed' AND ps = 'Can''t Repair'),
      'rma_stock',    (SELECT count(*) FROM kept WHERE ps IN ('Replacement', 'Credit Note'))
    ),
    'top_issues', coalesce((SELECT jsonb_agg(jsonb_build_object('issue', issue, 'count', n) ORDER BY n DESC, last_seen DESC NULLS LAST, issue) FROM (
        SELECT issue, count(*) AS n, max(created_date) AS last_seen
          FROM issues WHERE coalesce(issue, '') <> ''
         GROUP BY issue ORDER BY n DESC, last_seen DESC NULLS LAST, issue LIMIT 5) s), '[]'::jsonb)
  );
$fn$;

COMMENT ON FUNCTION public.rma_dashboard_ticket_summary(timestamptz, timestamptz, text) IS
  'Dashboard ticket figures for tickets created since p_since (all when null). (BUG-066.)';

-- ═══ Dashboard: CRM ══════════════════════════════════════════════════════════
-- Open value and the stage breakdown are open deals; "this month" starts at
-- the viewer's local month start (p_month_start). A deal with no value counts
-- as 0; a won deal with no rep groups under null.

CREATE OR REPLACE FUNCTION public.rma_dashboard_crm(p_month_start timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'open_value', (SELECT coalesce(sum(coalesce(value, 0)), 0) FROM public.deals WHERE status = 'open'),
    'open_count', (SELECT count(*) FROM public.deals WHERE status = 'open'),
    'won_this_month', (SELECT count(*) FROM public.deals WHERE status = 'won' AND won_at >= p_month_start),
    'leads_this_month', (SELECT count(*) FROM public.leads WHERE created_at >= p_month_start),
    'open_by_stage', coalesce((SELECT jsonb_agg(jsonb_build_object('stage', stage, 'count', n, 'value', v)) FROM (
        SELECT stage, count(*) AS n, coalesce(sum(coalesce(value, 0)), 0) AS v
          FROM public.deals WHERE status = 'open' GROUP BY stage) s), '[]'::jsonb),
    'won_by_rep', coalesce((SELECT jsonb_agg(jsonb_build_object('rep', rep, 'count', n, 'value', v)) FROM (
        SELECT nullif(assigned_rep, '') AS rep, count(*) AS n, coalesce(sum(coalesce(value, 0)), 0) AS v
          FROM public.deals WHERE status = 'won' AND won_at >= p_month_start GROUP BY 1) s), '[]'::jsonb)
  );
$fn$;

COMMENT ON FUNCTION public.rma_dashboard_crm(timestamptz) IS
  'Dashboard CRM figures: open pipeline, won and leads this month, stage and rep breakdowns. (BUG-066.)';

-- ═══ Inventory units per status ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_inventory_status_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'active_rma',           count(*) FILTER (WHERE status = 'active_rma'),
    'company_stock',        count(*) FILTER (WHERE status = 'company_stock'),
    'sent_to_manufacturer', count(*) FILTER (WHERE status = 'sent_to_manufacturer'),
    'closed',               count(*) FILTER (WHERE status = 'closed'),
    'total',                count(*)
  )
  FROM public.inventory_units;
$fn$;

-- ═══ Control Panel home ══════════════════════════════════════════════════════
-- Open = Open, In Progress, On Hold. Overdue here is the Control Panel's own
-- rule: a due date before now (the date read as UTC midnight, as the page did)
-- on a ticket that is not Closed or Cancelled. A deal is mis-staged when its
-- pipeline exists but does not define its stage.

CREATE OR REPLACE FUNCTION public.rma_control_panel_stats(p_now timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'open_tickets', (SELECT count(*) FROM public.rma_tickets WHERE ticket_status IN ('Open', 'In Progress', 'On Hold')),
    'overdue', (SELECT count(*) FROM public.rma_tickets
                 WHERE due_date IS NOT NULL
                   AND (due_date::timestamp AT TIME ZONE 'UTC') < coalesce(p_now, now())
                   AND ticket_status IS DISTINCT FROM 'Closed' AND ticket_status IS DISTINCT FROM 'Cancelled'),
    'customers', (SELECT count(*) FROM public.customers),
    'users', (SELECT count(*) FROM public.user_roles),
    'open_deals', (SELECT count(*) FROM public.deals WHERE status = 'open'),
    'open_deal_value', (SELECT coalesce(sum(coalesce(value, 0)), 0) FROM public.deals WHERE status = 'open'),
    'mis_staged', (SELECT count(*) FROM public.deals d JOIN public.pipelines p ON p.id = d.pipeline_id
                    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.stages) = 'array' THEN p.stages ELSE '[]'::jsonb END) s
                                       WHERE s->>'id' = d.stage))
  );
$fn$;

-- ═══ Pipelines & Stages ══════════════════════════════════════════════════════
-- Every deal on a pipeline, won and lost included: a closed deal still occupies
-- its stage.

CREATE OR REPLACE FUNCTION public.rma_pipeline_stage_counts()
RETURNS TABLE (pipeline_id uuid, stage text, deal_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT d.pipeline_id, d.stage, count(*)
    FROM public.deals d
   WHERE d.pipeline_id IS NOT NULL
   GROUP BY 1, 2;
$fn$;

-- ═══ Data Cleanup ════════════════════════════════════════════════════════════
-- A customer is linked when a ticket refers to it by id OR by its display name
-- (the company for a B2B customer that has one, otherwise the contact person) —
-- the union, so legacy name-only tickets never mark a customer orphaned
-- (BUG-012). Duplicates share a display name, case- and space-insensitively.

CREATE OR REPLACE FUNCTION public.rma_orphan_customers()
RETURNS SETOF public.customers
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT c.*
    FROM public.customers c
   WHERE NOT EXISTS (SELECT 1 FROM public.rma_tickets t WHERE t.customer_id = c.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.rma_tickets t
        WHERE coalesce(t.customer_name, '') <> ''
          AND t.customer_name = CASE WHEN c.customer_type = 'B2B' AND coalesce(c.company_name, '') <> ''
                                     THEN c.company_name ELSE c.contact_person END
     );
$fn$;

CREATE OR REPLACE FUNCTION public.rma_duplicate_customers()
RETURNS TABLE (
  group_key text,
  group_size bigint,
  group_newest timestamptz,
  id uuid,
  company_name text,
  contact_person text,
  email text,
  mobile text,
  created_date timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH keyed AS (
    SELECT c.*,
           regexp_replace(lower(coalesce(nullif(c.company_name, ''), nullif(c.contact_person, ''), '')), '^\s+|\s+$', '', 'g') AS k
      FROM public.customers c
  ),
  groups AS (
    SELECT k, count(*) AS n, max(created_date) AS newest FROM keyed WHERE k <> '' GROUP BY k HAVING count(*) > 1
  )
  SELECT g.k, g.n, g.newest, c.id, c.company_name, c.contact_person, c.email, c.mobile, c.created_date
    FROM keyed c JOIN groups g ON g.k = c.k;
$fn$;

CREATE OR REPLACE FUNCTION public.rma_data_cleanup_summary(p_completed_before timestamptz, p_cancelled_before timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'stale_completed', (SELECT count(*) FROM public.rma_tickets
                         WHERE ticket_status = 'Completed' AND updated_date IS NOT NULL AND updated_date < p_completed_before),
    'stale_cancelled', (SELECT count(*) FROM public.rma_tickets
                         WHERE ticket_status = 'Cancelled' AND updated_date IS NOT NULL AND updated_date < p_cancelled_before),
    'orphans', (SELECT count(*) FROM public.rma_orphan_customers()),
    'duplicate_groups', (SELECT count(DISTINCT group_key) FROM public.rma_duplicate_customers())
  );
$fn$;

-- ═══ Grants ══════════════════════════════════════════════════════════════════

DO $grants$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.rma_dashboard_ticket_summary(timestamptz, timestamptz, text)',
    'public.rma_dashboard_crm(timestamptz)',
    'public.rma_inventory_status_counts()',
    'public.rma_control_panel_stats(timestamptz)',
    'public.rma_pipeline_stage_counts()',
    'public.rma_orphan_customers()',
    'public.rma_duplicate_customers()',
    'public.rma_data_cleanup_summary(timestamptz, timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END
$grants$;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $guard$
DECLARE
  v_t jsonb := public.rma_dashboard_ticket_summary(NULL, now(), 'UTC');
  v_c jsonb := public.rma_control_panel_stats(now());
BEGIN
  IF (v_t->>'total')::bigint <> (SELECT count(*) FROM public.rma_tickets)
     OR (SELECT coalesce(sum((x->>'count')::bigint), 0) FROM jsonb_array_elements(v_t->'status_counts') x)
        <> (SELECT count(*) FROM public.rma_tickets WHERE ticket_status IS NOT NULL)
     OR (SELECT coalesce(sum((x->>'total')::bigint), 0) FROM jsonb_array_elements(v_t->'technicians') x)
        <> (SELECT count(*) FROM public.rma_tickets) THEN
    RAISE EXCEPTION 'Refusing to apply: dashboard ticket summary does not add up (%)', v_t;
  END IF;
  IF (public.rma_inventory_status_counts()->>'total')::bigint <> (SELECT count(*) FROM public.inventory_units)
     OR (SELECT coalesce(sum(deal_count), 0) FROM public.rma_pipeline_stage_counts())
        <> (SELECT count(*) FROM public.deals WHERE pipeline_id IS NOT NULL)
     OR (v_c->>'customers')::bigint <> (SELECT count(*) FROM public.customers) THEN
    RAISE EXCEPTION 'Refusing to apply: inventory, stage or control panel counts do not add up';
  END IF;
END
$guard$;
