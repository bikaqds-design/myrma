-- 20260859_activities_list_view.sql
--
-- Server-side reads for the Activities page and the Tech Calendar.
-- (Audit finding BUG-066, phase 5c.)
--
-- The Activities page loaded every planned activity, every completed one,
-- every lead and every deal, then named, searched, filtered, sorted, counted
-- and paged in the browser. The Tech Calendar loaded every ticket and every
-- planned activity to draw one week. The Data API returns at most 1 000 rows
-- per request, so past that both showed part of the data as if it were all.
--
-- PostgREST filters, orders, pages and counts what these return; what it
-- cannot do by itself is here:
--
--   v_activities_list        activities + what the page shows for each: its
--                            source (the document type for an approval), the
--                            customer name and record code (from the lead, the
--                            deal's customer, the customer, or the approval
--                            title), whether the lead/deal it links to exists,
--                            and case-insensitive sort keys
--   rma_activity_assignees   the assignees the Activities filter offers
--   rma_calendar_assignees   the people the Tech Calendar can show a week for
--
-- All SECURITY INVOKER: the caller's RLS on activities, leads, deals and
-- customers applies exactly as the browser's own reads did. Read-only;
-- authenticated only.

-- ═══ The list view ═══════════════════════════════════════════════════════════
-- An approval's title is `approval|docType|docId|code|total|customer`
-- (parseApprovalTitle in src/pages/Activities/index.jsx); every other activity
-- is named from the record it belongs to.

CREATE OR REPLACE VIEW public.v_activities_list
WITH (security_invoker = true)
AS
SELECT a.*,
       CASE WHEN a.type = 'approval'
            THEN coalesce(nullif(split_part(a.title, '|', 2), ''), 'quotation')
            ELSE coalesce(a.related_type, 'deal')
       END AS source,
       x.customer_name,
       lower(x.customer_name) AS customer_sort,
       lower(coalesce(a.title, '')) AS title_sort,
       CASE WHEN a.type = 'approval' THEN coalesce(nullif(split_part(a.title, '|', 4), ''), '—')
            WHEN a.related_type = 'lead' THEN l.lead_code
            WHEN a.related_type = 'deal' THEN d.deal_code
       END AS source_code,
       CASE WHEN a.related_type = 'lead' THEN l.id IS NOT NULL
            WHEN a.related_type = 'deal' THEN d.id IS NOT NULL
            ELSE false
       END AS related_exists
  FROM public.activities a
  LEFT JOIN public.leads l ON a.related_type = 'lead' AND l.id = a.related_id
  LEFT JOIN public.deals d ON a.related_type = 'deal' AND d.id = a.related_id
  LEFT JOIN public.customers c
         ON c.id = CASE a.related_type WHEN 'deal' THEN d.customer_id WHEN 'customer' THEN a.related_id END
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN a.type = 'approval' THEN coalesce(nullif(split_part(a.title, '|', 6), ''), '—')
             WHEN a.related_type = 'lead' THEN coalesce(nullif(l.company_name, ''), nullif(l.full_name, ''))
             WHEN a.related_type IN ('deal', 'customer') THEN coalesce(nullif(c.company_name, ''), nullif(c.contact_person, ''))
           END AS customer_name
  ) x;

COMMENT ON VIEW public.v_activities_list IS
  'Activities with the source, customer name, record code and sort keys the Activities page shows. (BUG-066.)';

-- ═══ Assignees for the Activities filter ═════════════════════════════════════
-- Planned (open, dated) or completed activities, not system logs; a rep scoped
-- to their own work gets only themselves.

CREATE OR REPLACE FUNCTION public.rma_activity_assignees(p_completed boolean, p_owner text DEFAULT NULL)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT coalesce(array_agg(DISTINCT assigned_rep ORDER BY assigned_rep), '{}')
    FROM public.activities
   WHERE type <> 'log'
     AND assigned_rep IS NOT NULL
     AND (p_owner IS NULL OR assigned_rep = p_owner)
     AND CASE WHEN p_completed THEN completed_at IS NOT NULL
              ELSE completed_at IS NULL AND due_date IS NOT NULL
         END;
$fn$;

-- ═══ People on the Tech Calendar ═════════════════════════════════════════════
-- Ticket technicians and the reps with planned activities: a row is one
-- person's week.

CREATE OR REPLACE FUNCTION public.rma_calendar_assignees()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT coalesce(array_agg(DISTINCT person ORDER BY person), '{}')
    FROM (
      SELECT assigned_technician AS person FROM public.rma_tickets WHERE assigned_technician IS NOT NULL AND assigned_technician <> ''
      UNION
      SELECT assigned_rep FROM public.activities
       WHERE assigned_rep IS NOT NULL AND assigned_rep <> ''
         AND completed_at IS NULL AND type <> 'log' AND due_date IS NOT NULL
    ) p;
$fn$;

COMMENT ON FUNCTION public.rma_activity_assignees(boolean, text) IS
  'Assignees of planned or completed activities, for the Activities filter. (BUG-066.)';
COMMENT ON FUNCTION public.rma_calendar_assignees() IS
  'Ticket technicians and reps with planned activities, for the Tech Calendar. (BUG-066.)';

-- ═══ Grants ══════════════════════════════════════════════════════════════════

REVOKE ALL ON public.v_activities_list FROM PUBLIC, anon;
GRANT SELECT ON public.v_activities_list TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.rma_activity_assignees(boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_activity_assignees(boolean, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rma_calendar_assignees() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_calendar_assignees() TO authenticated, service_role;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $guard$
BEGIN
  IF (SELECT count(*) FROM public.v_activities_list) <> (SELECT count(*) FROM public.activities) THEN
    RAISE EXCEPTION 'Refusing to apply: v_activities_list does not have one row per activity';
  END IF;
END
$guard$;
