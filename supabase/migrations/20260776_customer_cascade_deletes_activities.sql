-- Customer deletion must take its activities with it.
--
-- `activities.related_id` is polymorphic — it points at a deal, lead, customer,
-- purchase order or vendor invoice depending on `related_type` — so Postgres
-- cannot put a foreign key on it, and nothing stops a parent being deleted out
-- from under its own history.
--
-- delete_customer_cascade and delete_customers_cascade currently remove
-- customer_notes and the customer row, and leave every activity behind. Those
-- rows survive as records pointing at nothing: invisible in the UI, counted by
-- every unqualified query over activities, and impossible to attribute to
-- anything afterwards. There are 38 customer-related activities today.
--
-- This was found by a live sweep that turned up exactly one such orphan, from a
-- deal deleted during a QA session. The equivalent gap on the deal and lead
-- delete paths is fixed in application code (activities.deleteForRelated);
-- customers delete through these SECURITY DEFINER RPCs instead, so the fix has
-- to happen here.
--
-- The RMA-ticket guard from 20260774 is preserved exactly — deleting a customer
-- that still has tickets must keep failing, and must keep failing *before*
-- anything is removed.

CREATE OR REPLACE FUNCTION delete_customer_cascade(p_customer_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tickets integer;
  v_name    text;
BEGIN
  SELECT count(*) INTO v_tickets FROM rma_tickets WHERE customer_id = p_customer_id;

  IF v_tickets > 0 THEN
    SELECT COALESCE(company_name, contact_person, id::text) INTO v_name
    FROM customers WHERE id = p_customer_id;

    RAISE EXCEPTION
      'Cannot delete "%": % RMA ticket(s) reference this customer. Delete or reassign the tickets first — their serials, repair outcomes and stock history would go with them.',
      COALESCE(v_name, p_customer_id::text), v_tickets
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM activities
   WHERE related_type = 'customer' AND related_id = p_customer_id;
  DELETE FROM customer_notes WHERE customer_id = p_customer_id;
  DELETE FROM customers      WHERE id          = p_customer_id;
END;
$$;

CREATE OR REPLACE FUNCTION delete_customers_cascade(p_customer_ids UUID[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tickets   integer;
  v_customers integer;
BEGIN
  SELECT count(*), count(DISTINCT customer_id)
    INTO v_tickets, v_customers
  FROM rma_tickets
  WHERE customer_id = ANY(p_customer_ids);

  IF v_tickets > 0 THEN
    RAISE EXCEPTION
      'Cannot delete: % of the selected customers have % RMA ticket(s) between them. Delete or reassign those tickets first.',
      v_customers, v_tickets
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM activities
   WHERE related_type = 'customer' AND related_id = ANY(p_customer_ids);
  DELETE FROM customer_notes WHERE customer_id = ANY(p_customer_ids);
  DELETE FROM customers      WHERE id          = ANY(p_customer_ids);
END;
$$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Should return 0 both before and after any customer deletion:
--
--   SELECT count(*) FROM activities a
--    WHERE a.related_type = 'customer'
--      AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = a.related_id);
