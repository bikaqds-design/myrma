-- 20260852_ticket_list_functions.sql
--
-- What the RMA Tickets screen needs from the database to page on the server.
-- (Audit finding BUG-066, phase 2.)
--
-- The screen loaded every ticket and searched, filtered, sorted and paged in
-- the browser. The Data API returns at most 1 000 rows per request, so past
-- that the list silently loses tickets. Most of the screen's filters are plain
-- column matches PostgREST can express; four things are not, and live here:
--
--   rma_tickets_matching(term)      the search box. It also matches the serial
--                                   number and product name of every product on
--                                   the ticket, which sit inside the `products`
--                                   jsonb array — a PostgREST filter cannot
--                                   reach into an array of objects.
--   rma_ticket_filter_options()     the statuses and technicians in use, for the
--                                   filter drop-downs and the Kanban columns.
--   rma_ticket_customer_names(term) customer names on tickets, for the customer
--                                   filter's type-ahead.
--   rma_peek_next_ticket_number()   the number the insert trigger (20260832)
--                                   would assign now, for the form's preview.
--
-- All read-only. The first three are SECURITY INVOKER, so they see exactly the
-- rows the caller's policies allow and nothing more. The peek is SECURITY
-- DEFINER on purpose: the trigger it mirrors counts every ticket of the day,
-- and a preview computed from a narrower view would show a number the save
-- will not produce. It returns one generated string and no row data.

-- ═══ Search ══════════════════════════════════════════════════════════════════

-- Returns rma_tickets rows, so PostgREST can apply the other filters, the
-- sort, the range and an exact count on top: `.rpc(...).eq(...).order(...)`.
--
-- strpos on lower-cased text, not ILIKE: the term is matched literally, so a
-- search containing % or _ cannot turn into a wildcard, and nothing needs
-- escaping. A blank term returns every ticket.
CREATE OR REPLACE FUNCTION public.rma_tickets_matching(p_term text DEFAULT NULL)
RETURNS SETOF public.rma_tickets
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH q AS (SELECT lower(btrim(coalesce(p_term, ''))) AS term)
  SELECT t.*
    FROM public.rma_tickets t, q
   WHERE q.term = ''
      OR strpos(lower(coalesce(t.rma_number, '')), q.term) > 0
      OR strpos(lower(coalesce(t.customer_name, '')), q.term) > 0
      OR strpos(lower(coalesce(t.ticket_status, '')), q.term) > 0
      OR strpos(lower(coalesce(t.priority, '')), q.term) > 0
      OR strpos(lower(coalesce(t.assigned_technician, '')), q.term) > 0
      OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(t.products) = 'array' THEN t.products ELSE '[]'::jsonb END
                  ) AS p
            WHERE strpos(lower(coalesce(p->>'serial_number', '')), q.term) > 0
               OR strpos(lower(coalesce(p->>'product_name', '')), q.term) > 0
         );
$fn$;

COMMENT ON FUNCTION public.rma_tickets_matching(text) IS
  'Tickets matching the RMA Tickets search box: RMA number, customer, status, priority, technician, or any product serial/name. Literal, case-insensitive. SETOF rma_tickets so PostgREST filters, sorts and pages on top. (BUG-066.)';

-- ═══ Filter options ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_ticket_filter_options()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'statuses', coalesce((
      SELECT jsonb_agg(s ORDER BY s)
        FROM (SELECT DISTINCT ticket_status AS s FROM public.rma_tickets WHERE ticket_status IS NOT NULL) x
    ), '[]'::jsonb),
    'technicians', coalesce((
      SELECT jsonb_agg(s ORDER BY s)
        FROM (SELECT DISTINCT assigned_technician AS s FROM public.rma_tickets
               WHERE coalesce(btrim(assigned_technician), '') <> '') x
    ), '[]'::jsonb)
  );
$fn$;

COMMENT ON FUNCTION public.rma_ticket_filter_options() IS
  'Distinct ticket statuses and technicians in use, for the RMA Tickets filters and Kanban columns. (BUG-066.)';

-- ═══ Customer names on tickets ═══════════════════════════════════════════════

-- The customer filter matches ticket.customer_name exactly, so the only useful
-- suggestions are names that appear on tickets.
CREATE OR REPLACE FUNCTION public.rma_ticket_customer_names(p_term text DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT DISTINCT t.customer_name
    FROM public.rma_tickets t
   WHERE coalesce(btrim(t.customer_name), '') <> ''
     AND strpos(lower(t.customer_name), lower(btrim(coalesce(p_term, '')))) > 0
   ORDER BY t.customer_name
   LIMIT greatest(1, least(coalesce(p_limit, 20), 100));
$fn$;

COMMENT ON FUNCTION public.rma_ticket_customer_names(text, integer) IS
  'Distinct customer names on tickets containing the term, for the RMA Tickets customer filter. (BUG-066.)';

-- ═══ Next-number preview ═════════════════════════════════════════════════════

-- Same date, prefix and serial rule as rma_assign_ticket_number(). No lock: it
-- is a preview, and the trigger still assigns the real number at save time.
CREATE OR REPLACE FUNCTION public.rma_peek_next_ticket_number()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH p AS (SELECT 'RMA-' || to_char(now(), 'DDMMYYYY') || '-' AS prefix)
  SELECT p.prefix || lpad((
           coalesce(max(substring(t.rma_number from '[0-9]+$')::integer), 0) + 1
         )::text, 4, '0')
    FROM p
    LEFT JOIN public.rma_tickets t
      ON t.rma_number LIKE p.prefix || '%'
     AND t.rma_number ~ ('^' || p.prefix || '[0-9]+$')
   GROUP BY p.prefix;
$fn$;

COMMENT ON FUNCTION public.rma_peek_next_ticket_number() IS
  'The RMA number the insert trigger would assign now. Preview only; rma_assign_ticket_number() assigns the real one. (BUG-066.)';

-- ═══ Access ══════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.rma_tickets_matching(text)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rma_ticket_filter_options()               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rma_ticket_customer_names(text, integer)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rma_peek_next_ticket_number()             FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_tickets_matching(text)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.rma_ticket_filter_options()              TO authenticated;
GRANT EXECUTE ON FUNCTION public.rma_ticket_customer_names(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rma_peek_next_ticket_number()            TO authenticated;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_total   bigint;
  v_all     bigint;
  v_sample  record;
  v_peek    text;
  v_opts    jsonb;
BEGIN
  SELECT count(*) INTO v_total FROM public.rma_tickets;
  SELECT count(*) INTO v_all FROM public.rma_tickets_matching(NULL);
  IF v_all <> v_total THEN
    RAISE EXCEPTION 'Refusing to apply: a blank search returned % of % tickets', v_all, v_total;
  END IF;
  IF (SELECT count(*) FROM public.rma_tickets_matching('   ')) <> v_total THEN
    RAISE EXCEPTION 'Refusing to apply: a whitespace-only search must return every ticket';
  END IF;

  -- A ticket must be findable by its own RMA number, and by a product serial
  -- when it has one — the case a PostgREST filter could not express.
  SELECT t.id, t.rma_number, p->>'serial_number' AS serial
    INTO v_sample
    FROM public.rma_tickets t
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(t.products) = 'array' THEN t.products ELSE '[]'::jsonb END
    ) p ON coalesce(p->>'serial_number', '') <> ''
   ORDER BY (p->>'serial_number') IS NULL, t.created_date DESC
   LIMIT 1;
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.rma_tickets_matching(lower(v_sample.rma_number)) m WHERE m.id = v_sample.id) THEN
      RAISE EXCEPTION 'Refusing to apply: ticket % is not found by its own RMA number', v_sample.rma_number;
    END IF;
    IF v_sample.serial IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.rma_tickets_matching(upper(v_sample.serial)) m WHERE m.id = v_sample.id) THEN
      RAISE EXCEPTION 'Refusing to apply: ticket % is not found by its product serial', v_sample.rma_number;
    END IF;
  END IF;

  -- Wildcards are literal.
  IF EXISTS (SELECT 1 FROM public.rma_tickets_matching('%')) AND NOT EXISTS (
       SELECT 1 FROM public.rma_tickets WHERE rma_number LIKE '%\%%' OR customer_name LIKE '%\%%'
          OR ticket_status LIKE '%\%%' OR priority LIKE '%\%%' OR assigned_technician LIKE '%\%%'
          OR products::text LIKE '%\%%') THEN
    RAISE EXCEPTION 'Refusing to apply: a search for %% matched as a wildcard';
  END IF;

  v_opts := public.rma_ticket_filter_options();
  IF jsonb_typeof(v_opts->'statuses') <> 'array' OR jsonb_typeof(v_opts->'technicians') <> 'array' THEN
    RAISE EXCEPTION 'Refusing to apply: filter options have the wrong shape: %', v_opts;
  END IF;
  IF v_total > 0 AND jsonb_array_length(v_opts->'statuses') = 0 THEN
    RAISE EXCEPTION 'Refusing to apply: tickets exist but no statuses were reported';
  END IF;

  v_peek := public.rma_peek_next_ticket_number();
  IF v_peek !~ ('^RMA-' || to_char(now(), 'DDMMYYYY') || '-[0-9]{4,}$') THEN
    RAISE EXCEPTION 'Refusing to apply: next-number preview has the wrong shape: %', v_peek;
  END IF;
END
$do$;
