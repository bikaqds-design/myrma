-- ============================================================================
-- 20260774 — Stop a customer delete from destroying their RMA history
-- ============================================================================
-- NOT YET APPLIED. This encodes a policy decision, so read the trade-off below
-- and decide before running it.
--
-- ── What happens today ──────────────────────────────────────────────────────
--
-- Deleting a customer takes their entire service history with them. There are
-- two independent paths and both do it:
--
--   1. delete_customer_cascade() / delete_customers_cascade() (migration
--      20260524) deliberately delete the customer's inventory_units,
--      ticket_comments, ticket_activity and rma_tickets before the customer
--      row. That was an explicit decision at the time — the point of the RPC
--      was to make the cascade atomic rather than half-finished.
--
--   2. A plain DELETE on public.customers cascades through the
--      rma_tickets.customer_id foreign key on its own, without the RPC.
--
-- Path 2 is how this was found: a single DELETE against one customer removed
-- the customer, one RMA ticket and its inventory unit, in one statement, with
-- nothing to confirm and no way back.
--
-- ── Why this is worth reconsidering ─────────────────────────────────────────
--
-- The database already protects the customer's *financial* history and always
-- has. Every sales document uses ON DELETE RESTRICT:
--
--   quotations.customer_id    → RESTRICT  (20260714)
--   sales_orders.customer_id  → RESTRICT  (20260715)
--   crm_invoices.customer_id  → RESTRICT  (20260716)
--
-- So a customer with a single quotation cannot be deleted at all, while a
-- customer with ten years of RMA tickets can be deleted without warning. That
-- asymmetry looks accidental rather than reasoned: an RMA ticket carries
-- warranty claims, serial numbers, repair outcomes and stock movements, which
-- is the record you would most want if a dispute arrived a year later.
--
-- Deleting the ticket also strands its stock. inventory_units rows are removed
-- with it, but the stock_moves ledger that recorded those units arriving is
-- append-only and stays behind, now referencing units that no longer exist.
--
-- ── What this migration does ────────────────────────────────────────────────
--
-- Switches rma_tickets.customer_id to ON DELETE RESTRICT, matching the sales
-- documents, and makes the two cascade RPCs refuse rather than delete. After
-- it, removing a customer who has tickets requires dealing with the tickets
-- first — which is the same rule the app already applies to quotations.
--
-- ── The trade-off you are accepting ─────────────────────────────────────────
--
-- Bulk-deleting imported or duplicate customers becomes harder: any customer
-- that ever had a ticket must have it reassigned or deleted first. If routine
-- cleanup of junk customer records matters more than retaining service
-- history, do not apply this — keep the cascade and rely on the confirmation
-- dialog, which now states exactly how many tickets a delete will destroy.
--
-- A middle option, if you want it, is archiving: add customers.archived and
-- hide archived customers from the list instead of deleting them. That keeps
-- both the history and the cleanup, and is a larger change than this file.
-- ============================================================================

-- ── 1. Foreign key: cascade → restrict ──────────────────────────────────────
ALTER TABLE public.rma_tickets
  DROP CONSTRAINT IF EXISTS rma_tickets_customer_id_fkey;

ALTER TABLE public.rma_tickets
  ADD CONSTRAINT rma_tickets_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES public.customers(id)
  ON DELETE RESTRICT;

-- ── 2. Teach the cascade RPCs to refuse ─────────────────────────────────────
-- Left in place rather than dropped: the app calls them, and a clear error is
-- better than a missing function. They still delete customer-scoped records
-- (notes) for a customer who has no tickets.

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

  DELETE FROM customer_notes WHERE customer_id = ANY(p_customer_ids);
  DELETE FROM customers      WHERE id          = ANY(p_customer_ids);
END;
$$;

-- ─── Verification ────────────────────────────────────────────────────────────
--   DELETE FROM public.customers WHERE id = '<a customer with tickets>';
--   -- ERROR: update or delete on table "customers" violates foreign key
--   --        constraint "rma_tickets_customer_id_fkey" on table "rma_tickets"
--
--   SELECT delete_customer_cascade('<a customer with tickets>');
--   -- ERROR: Cannot delete "Speed Technology System": 1 RMA ticket(s) reference
--   --        this customer. …
--
--   SELECT delete_customer_cascade('<a customer with none>');   -- succeeds
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- Restore the cascade FK and re-apply 20260524 to bring the deleting RPCs back:
--
--   ALTER TABLE public.rma_tickets DROP CONSTRAINT rma_tickets_customer_id_fkey;
--   ALTER TABLE public.rma_tickets
--     ADD CONSTRAINT rma_tickets_customer_id_fkey
--     FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;
