-- Server-side serial number search across JSONB products array.
-- Replaces full-table client-side fetch in serialHistory.getBySerial().
-- ILIKE makes the match case-insensitive; SECURITY DEFINER runs under
-- the function owner so RLS on rma_tickets is respected via USING policies.

CREATE OR REPLACE FUNCTION public.rma_search_by_serial(serial text)
RETURNS TABLE (
  id                  uuid,
  rma_number          text,
  customer_name       text,
  ticket_status       text,
  priority            text,
  assigned_technician text,
  created_date        timestamptz,
  due_date            date,
  products            jsonb
) LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    id, rma_number, customer_name, ticket_status, priority,
    assigned_technician, created_date, due_date, products
  FROM rma_tickets
  WHERE EXISTS (
    SELECT 1
    FROM jsonb_array_elements(products) AS p
    WHERE p->>'serial_number' ILIKE serial
  )
  ORDER BY created_date DESC;
$$;

GRANT EXECUTE ON FUNCTION public.rma_search_by_serial(text) TO anon, authenticated;
