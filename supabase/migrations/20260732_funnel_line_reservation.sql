-- funnel_reserve_line: classify a document-line product and reserve the
-- appropriate inventory in one call. Used by approve_sales_order (migration
-- 20260733) so approval handles any product mix without failing on non-
-- serialized lines.
--
-- Classification (derived from catalog at reservation time — no new column):
--   serialized  → product has inventory_units rows → reserve_units RPC
--   service/non-stock → no inventory_units rows → silent no-op
--
-- Note: the fungible-parts path (reserve_parts) is intentionally absent.
-- The `parts` table has no product_id FK to the products catalog — parts are
-- a separate RMA-repair SKU system (ticket_parts). Document lines always
-- reference the products catalog. If a product has no inventory_units it is
-- treated as non-stock/service.

CREATE OR REPLACE FUNCTION public.funnel_reserve_line(
  p_doc_type    text,
  p_doc_id      uuid,
  p_product_id  uuid,
  p_qty         integer,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.inventory_units
    WHERE product_id = p_product_id
      AND status NOT IN ('closed')
    LIMIT 1
  ) THEN
    -- Serialised: use the existing unit-level reserve RPC
    PERFORM public.reserve_units(p_doc_type, p_doc_id, p_product_id, p_qty, p_actor_email);
  END IF;
  -- Non-stock / service: return without action
END;
$$;
