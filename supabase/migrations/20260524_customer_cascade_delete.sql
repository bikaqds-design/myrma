-- Migration: atomic customer cascade-delete via server-side RPC
-- Run this in the Supabase SQL Editor (or via `supabase db push`).
--
-- Replaces the multi-step client-side delete in db.customers.delete / bulkDelete
-- with a single transactional function so the database is never left in a
-- partial state if the browser tab closes mid-delete.

-- ── Single customer ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION delete_customer_cascade(p_customer_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_ids UUID[];
BEGIN
  -- Collect the customer's ticket IDs
  SELECT array_agg(id) INTO v_ticket_ids
  FROM rma_tickets
  WHERE customer_id = p_customer_id;

  -- Delete child records of those tickets
  IF v_ticket_ids IS NOT NULL THEN
    DELETE FROM inventory_units  WHERE rma_ticket_id = ANY(v_ticket_ids);
    DELETE FROM ticket_comments  WHERE ticket_id      = ANY(v_ticket_ids);
    DELETE FROM ticket_activity  WHERE ticket_id      = ANY(v_ticket_ids);
    DELETE FROM rma_tickets      WHERE id             = ANY(v_ticket_ids);
  END IF;

  -- Delete customer-scoped records
  DELETE FROM customer_notes WHERE customer_id = p_customer_id;

  -- Finally, delete the customer row
  DELETE FROM customers WHERE id = p_customer_id;
END;
$$;

-- ── Bulk customers ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION delete_customers_cascade(p_customer_ids UUID[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_ids UUID[];
BEGIN
  SELECT array_agg(id) INTO v_ticket_ids
  FROM rma_tickets
  WHERE customer_id = ANY(p_customer_ids);

  IF v_ticket_ids IS NOT NULL THEN
    DELETE FROM inventory_units  WHERE rma_ticket_id = ANY(v_ticket_ids);
    DELETE FROM ticket_comments  WHERE ticket_id      = ANY(v_ticket_ids);
    DELETE FROM ticket_activity  WHERE ticket_id      = ANY(v_ticket_ids);
    DELETE FROM rma_tickets      WHERE id             = ANY(v_ticket_ids);
  END IF;

  DELETE FROM customer_notes WHERE customer_id = ANY(p_customer_ids);
  DELETE FROM customers      WHERE id          = ANY(p_customer_ids);
END;
$$;

-- Grant execution to the anon and authenticated roles used by the app
GRANT EXECUTE ON FUNCTION delete_customer_cascade(UUID)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_customers_cascade(UUID[]) TO anon, authenticated;
