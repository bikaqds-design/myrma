-- 20260857_leads_list_view.sql
--
-- The Leads list, sortable by name in the database. (Audit finding BUG-066,
-- phase 5c.)
--
-- The Leads screen loaded every lead and filtered, sorted and paged them in
-- the browser. The Data API returns at most 1 000 rows per request, so past
-- that the list, its tab counts and its Kanban showed part of the leads as if
-- they were all of them. Paging in the database is plain PostgREST except for
-- one thing: the Name column sorts by what it shows in bold — the company, or
-- the person when there is no company — case-insensitively. PostgREST cannot
-- order by an expression, so this view carries that key as `sort_name`.
--
-- security_invoker: the caller's RLS on leads applies (a sales rep still sees
-- only their own leads). SELECT to authenticated only. Writes stay on leads.

CREATE OR REPLACE VIEW public.v_leads_list
WITH (security_invoker = true) AS
SELECT
  l.*,
  lower(coalesce(nullif(l.company_name, ''), l.full_name, '')) AS sort_name
FROM public.leads l;

COMMENT ON VIEW public.v_leads_list IS
  'Leads with the Name-column sort key (company, else person, lower-cased), for the paged Leads list. (BUG-066.)';

REVOKE ALL ON public.v_leads_list FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_leads_list TO authenticated, service_role;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM public.v_leads_list) <> (SELECT count(*) FROM public.leads) THEN
    RAISE EXCEPTION 'Refusing to apply: v_leads_list does not have one row per lead';
  END IF;
END
$guard$;
