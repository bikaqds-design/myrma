-- 20260865_customer_product_history.sql
--
-- The Customer Details activity log and a product's RMA history, as lists the
-- database can page. (Audit finding BUG-066, phase 5d.)
--
-- The page read every ticket and every note for the customer — each capped at
-- the Data API's 1 000 rows — and merged them with the customer's own creation
-- into one timeline in the browser. A long-standing customer's log therefore
-- stopped at its first thousand tickets or notes without saying so.
--
--   v_customer_activity   one row per event: a ticket raised, a note added,
--                         the customer created — newest first by the caller
--   rma_product_tickets   the tickets any unit of a product came in on, once
--                         each — Product Details' RMA history, which read every
--                         unit's ticket id and then asked for all of those
--                         tickets in a single request
--   rma_products_by_name_keys  catalog products whose trimmed, lower-cased
--                         name is one of the keys — re-linking an RMA ticket's
--                         typed product names without reading the whole
--                         catalog (capped at 1 000 rows) to match them
--
-- A ticket's detail is its general description (the page read two columns the
-- ticket query never selected, so it always showed "—"). Events without a date
-- are left out, as the page dropped them.
--
-- SECURITY INVOKER: RLS on rma_tickets, customer_notes and customers applies.
-- Read-only; authenticated only.

CREATE OR REPLACE VIEW public.v_customer_activity
WITH (security_invoker = true)
AS
SELECT t.customer_id,
       'ticket'::text AS event_type,
       t.id AS ref_id,
       t.created_date AS event_at,
       t.rma_number AS code,
       t.general_description AS detail,
       NULL::text AS actor
  FROM public.rma_tickets t
 WHERE t.customer_id IS NOT NULL AND t.created_date IS NOT NULL
UNION ALL
SELECT n.customer_id,
       'note'::text,
       n.id,
       n.created_date,
       NULL::text,
       n.note,
       n.created_by
  FROM public.customer_notes n
 WHERE n.created_date IS NOT NULL
UNION ALL
SELECT c.id,
       'created'::text,
       c.id,
       c.created_date,
       NULL::text,
       NULL::text,
       c.created_by
  FROM public.customers c
 WHERE c.created_date IS NOT NULL;

COMMENT ON VIEW public.v_customer_activity IS
  'Customer Details activity log: tickets raised, notes added, customer created. (BUG-066.)';

CREATE OR REPLACE FUNCTION public.rma_product_tickets(p_product_id uuid)
RETURNS SETOF public.rma_tickets
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT t.*
    FROM public.rma_tickets t
   WHERE EXISTS (SELECT 1 FROM public.inventory_units u
                  WHERE u.rma_ticket_id = t.id AND u.product_id = p_product_id);
$fn$;

COMMENT ON FUNCTION public.rma_product_tickets(uuid) IS
  'Tickets any unit of a product arrived on, one row each. (BUG-066.)';

CREATE OR REPLACE FUNCTION public.rma_products_by_name_keys(p_keys text[])
RETURNS TABLE (id uuid, product_name text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT p.id, p.product_name
    FROM public.products p
   WHERE lower(regexp_replace(coalesce(p.product_name, ''), '^\s+|\s+$', '', 'g')) = ANY (p_keys);
$fn$;

COMMENT ON FUNCTION public.rma_products_by_name_keys(text[]) IS
  'Catalog products matching trimmed lower-case names, for re-linking RMA ticket lines. (BUG-066.)';

REVOKE ALL ON public.v_customer_activity FROM PUBLIC, anon;
GRANT SELECT ON public.v_customer_activity TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rma_product_tickets(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_product_tickets(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rma_products_by_name_keys(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_products_by_name_keys(text[]) TO authenticated, service_role;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM public.v_customer_activity)
     <> (SELECT count(*) FROM public.rma_tickets WHERE customer_id IS NOT NULL AND created_date IS NOT NULL)
      + (SELECT count(*) FROM public.customer_notes WHERE created_date IS NOT NULL)
      + (SELECT count(*) FROM public.customers WHERE created_date IS NOT NULL) THEN
    RAISE EXCEPTION 'Refusing to apply: v_customer_activity does not hold one row per event';
  END IF;
END
$guard$;
