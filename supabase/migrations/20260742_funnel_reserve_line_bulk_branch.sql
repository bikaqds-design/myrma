-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 8 Phase 8a — funnel_reserve_line: add the bulk branch
--
--  Extends the 2-way branch from 20260738 (service no-op / serialized
--  reserve_units) to a 3-way branch, adding stock_tracking_mode = 'bulk'.
--  Deliberately the smallest possible diff from 20260738's version — this
--  exact function has already had two real production bugs found in it
--  this session (missing product_id column, wrong created_at column name),
--  so the service/serialized paths are left untouched byte-for-byte and
--  only one new branch is added.
-- ═══════════════════════════════════════════════════════════════════════════

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
DECLARE
  v_product_type  text;
  v_tracking_mode text;
BEGIN
  SELECT product_type, stock_tracking_mode INTO v_product_type, v_tracking_mode
  FROM public.products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_product_type = 'service' THEN
    RETURN; -- service lines never touch inventory
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    PERFORM public.reserve_warehouse_stock(p_doc_type, p_doc_id, p_product_id, p_qty, p_actor_email);
  ELSE
    -- 'serialized' (default) — always requires individual units.
    -- reserve_units raises "Insufficient stock" at 0 available (fixes the
    -- silent no-op from before Sprint 7.6, audit A2). Unchanged from 20260738.
    PERFORM public.reserve_units(p_doc_type, p_doc_id, p_product_id, p_qty, p_actor_email);
  END IF;
END;
$$;
