-- 20260858_pipeline_deal_functions.sql
--
-- Server-side reads for the Pipeline screen. (Audit finding BUG-066, phase 5c.)
--
-- The Pipeline loaded every deal in a pipeline — and every open activity of
-- every one of them — and did the rest in the browser: the search, the stage
-- and rep filters, the list's sort and paging, the Kanban columns and their
-- totals, the graph, the pivot and the activity grid. The Data API returns at
-- most 1 000 rows per request, so past that each view showed, and summed, part
-- of the pipeline as if it were all of it.
--
-- PostgREST filters, orders, pages and counts what these return; what it
-- cannot do by itself is here:
--
--   v_deals_list                  deals + the customer name the screen shows
--                                 and the keys its columns sort by
--   rma_deals_matching            the search, which matches that customer
--                                 name too (it lives in another table)
--   rma_deal_buckets              deal count and value per stage × rep ×
--                                 status × created month × close month; every
--                                 graph, pivot and column total is a sum of these
--   rma_deal_activity_values      per stage × rep, the value of deals whose
--                                 worst open activity is overdue / due today /
--                                 planned (the bar over each Kanban column)
--   rma_deal_activity_type_counts per stage × rep × type, activities and how
--                                 many are done, on open deals (the Activity
--                                 view's column headers)
--   rma_deal_reps                 the reps with deals in a pipeline (the filter)
--
-- All SECURITY INVOKER: the caller's RLS on deals, customers, pipelines and
-- activities applies exactly as the browser's own reads did (a sales rep sees
-- their own deals). Read-only; authenticated only.

-- ═══ The list view ═══════════════════════════════════════════════════════════
-- customer_name is what the screen shows for a deal's customer: the company,
-- or the contact person when there is no company name.
-- stage_order is the stage's position in its pipeline, so "sort by stage"
-- follows the board rather than the alphabet of stage ids.
-- title_sort / customer_sort are case-insensitive; value_sort counts a deal
-- with no value as 0, as the totals do.

CREATE OR REPLACE VIEW public.v_deals_list
WITH (security_invoker = true)
AS
SELECT d.*,
       coalesce(nullif(c.company_name, ''), nullif(c.contact_person, '')) AS customer_name,
       lower(coalesce(nullif(c.company_name, ''), nullif(c.contact_person, ''), '')) AS customer_sort,
       lower(coalesce(d.title, '')) AS title_sort,
       coalesce(d.value, 0) AS value_sort,
       (SELECT (s->>'order')::numeric
          FROM public.pipelines p
          CROSS JOIN LATERAL jsonb_array_elements(p.stages) s
         WHERE p.id = d.pipeline_id AND s->>'id' = d.stage
         LIMIT 1) AS stage_order
  FROM public.deals d
  LEFT JOIN public.customers c ON c.id = d.customer_id;

COMMENT ON VIEW public.v_deals_list IS
  'Deals with the customer name and sort keys the Pipeline list shows. (BUG-066.)';

-- ═══ The search ══════════════════════════════════════════════════════════════
-- Case-insensitive substring of title, deal code, assigned rep or customer
-- name, taken literally (% _ and \ are escaped). An empty term matches every
-- deal in the pipeline.

CREATE OR REPLACE FUNCTION public.rma_deals_matching(p_pipeline_id uuid, p_term text)
RETURNS SETOF public.v_deals_list
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH t AS (
    SELECT btrim(coalesce(p_term, '')) AS term,
           '%' || replace(replace(replace(btrim(coalesce(p_term, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pattern
  )
  SELECT v.*
    FROM public.v_deals_list v, t
   WHERE v.pipeline_id = p_pipeline_id
     AND (
       t.term = ''
       OR v.title ILIKE t.pattern
       OR v.deal_code ILIKE t.pattern
       OR v.assigned_rep ILIKE t.pattern
       OR v.customer_name ILIKE t.pattern
     );
$fn$;

-- ═══ Buckets: graph, pivot, column totals ════════════════════════════════════
-- Months are 'YYYY-MM': created_at in the viewer's time zone (the browser
-- labelled it in local time), expected_close_date as the date it is. An unknown
-- time zone name falls back to UTC rather than failing.

CREATE OR REPLACE FUNCTION public.rma_deal_buckets(p_pipeline_id uuid, p_term text, p_tz text)
RETURNS TABLE (
  stage text,
  assigned_rep text,
  status text,
  created_month text,
  close_month text,
  deal_count int,
  value_sum numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH z AS (
    SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN p_tz ELSE 'UTC' END AS tz
  )
  SELECT d.stage,
         d.assigned_rep,
         d.status,
         to_char(d.created_at AT TIME ZONE z.tz, 'YYYY-MM'),
         to_char(d.expected_close_date, 'YYYY-MM'),
         count(*)::int,
         coalesce(sum(d.value), 0)
    FROM public.rma_deals_matching(p_pipeline_id, p_term) d, z
   GROUP BY 1, 2, 3, 4, 5;
$fn$;

-- ═══ Activity state value per stage ══════════════════════════════════════════
-- A deal's state is its worst open activity that has a due date: overdue if
-- one is due before p_now, else today if one is due by p_today_end, else
-- planned. Deals with no dated open activity have no state. The viewer passes
-- p_now and p_today_end, because "today" is theirs.

CREATE OR REPLACE FUNCTION public.rma_deal_activity_values(
  p_pipeline_id uuid,
  p_term text,
  p_now timestamptz,
  p_today_end timestamptz
)
RETURNS TABLE (stage text, assigned_rep text, activity_state text, deal_count int, value_sum numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH per_deal AS (
    SELECT d.id, d.stage, d.assigned_rep, d.value,
           CASE
             WHEN bool_or(a.due_date < p_now) THEN 'overdue'
             WHEN bool_or(a.due_date <= p_today_end) THEN 'today'
             ELSE 'planned'
           END AS activity_state
      FROM public.rma_deals_matching(p_pipeline_id, p_term) d
      JOIN public.activities a
        ON a.related_type = 'deal' AND a.related_id = d.id
       AND a.completed_at IS NULL AND a.due_date IS NOT NULL
     GROUP BY d.id, d.stage, d.assigned_rep, d.value
  )
  SELECT stage, assigned_rep, activity_state, count(*)::int, coalesce(sum(value), 0)
    FROM per_deal
   GROUP BY 1, 2, 3;
$fn$;

-- ═══ Activities per type, for open deals ═════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_deal_activity_type_counts(p_pipeline_id uuid, p_term text)
RETURNS TABLE (stage text, assigned_rep text, activity_type text, activity_count int, done_count int)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT d.stage,
         d.assigned_rep,
         a.type,
         count(*)::int,
         (count(*) FILTER (WHERE a.completed_at IS NOT NULL))::int
    FROM public.rma_deals_matching(p_pipeline_id, p_term) d
    JOIN public.activities a
      ON a.related_type = 'deal' AND a.related_id = d.id
   WHERE d.status = 'open'
   GROUP BY 1, 2, 3;
$fn$;

-- ═══ Reps in a pipeline ══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_deal_reps(p_pipeline_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT coalesce(array_agg(DISTINCT assigned_rep ORDER BY assigned_rep), '{}')
    FROM public.deals
   WHERE pipeline_id = p_pipeline_id AND assigned_rep IS NOT NULL;
$fn$;

COMMENT ON FUNCTION public.rma_deals_matching(uuid, text) IS
  'Pipeline search: title, deal code, rep or customer name. (BUG-066.)';
COMMENT ON FUNCTION public.rma_deal_buckets(uuid, text, text) IS
  'Deal count and value per stage, rep, status, created month and close month. (BUG-066.)';
COMMENT ON FUNCTION public.rma_deal_activity_values(uuid, text, timestamptz, timestamptz) IS
  'Deal value by worst open-activity state, per stage and rep. (BUG-066.)';
COMMENT ON FUNCTION public.rma_deal_activity_type_counts(uuid, text) IS
  'Activities and completed activities per type on open deals. (BUG-066.)';
COMMENT ON FUNCTION public.rma_deal_reps(uuid) IS
  'Reps with deals in a pipeline. (BUG-066.)';

-- ═══ Grants ══════════════════════════════════════════════════════════════════

REVOKE ALL ON public.v_deals_list FROM PUBLIC, anon;
GRANT SELECT ON public.v_deals_list TO authenticated, service_role;

DO $grants$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.rma_deals_matching(uuid, text)',
    'public.rma_deal_buckets(uuid, text, text)',
    'public.rma_deal_activity_values(uuid, text, timestamptz, timestamptz)',
    'public.rma_deal_activity_type_counts(uuid, text)',
    'public.rma_deal_reps(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END
$grants$;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- Refuse to apply if the pieces the screen adds up do not add up.

DO $guard$
DECLARE
  p record;
BEGIN
  IF (SELECT count(*) FROM public.v_deals_list) <> (SELECT count(*) FROM public.deals) THEN
    RAISE EXCEPTION 'Refusing to apply: v_deals_list does not have one row per deal';
  END IF;
  FOR p IN SELECT id FROM public.pipelines LOOP
    IF (SELECT count(*) FROM public.rma_deals_matching(p.id, '')) <> (SELECT count(*) FROM public.deals WHERE pipeline_id = p.id) THEN
      RAISE EXCEPTION 'Refusing to apply: an empty search does not return the whole pipeline %', p.id;
    END IF;
    IF (SELECT coalesce(sum(deal_count), 0) FROM public.rma_deal_buckets(p.id, '', 'UTC'))
       <> (SELECT count(*) FROM public.deals WHERE pipeline_id = p.id)
    OR (SELECT coalesce(sum(value_sum), 0) FROM public.rma_deal_buckets(p.id, '', 'UTC'))
       <> (SELECT coalesce(sum(value), 0) FROM public.deals WHERE pipeline_id = p.id) THEN
      RAISE EXCEPTION 'Refusing to apply: buckets do not add up to pipeline %', p.id;
    END IF;
  END LOOP;
END
$guard$;
