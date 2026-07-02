-- ============================================================================
-- AUDIT 2026-07-02 — CRIT-3 (inventory ledger): server-derived actor
--
-- Every inventory RPC (receive_stock, transfer_stock, adjust_stock,
-- reserve/deliver/release/restore_units, *_warehouse_stock, *_parts,
-- receive_vendor_invoice, …) writes stock_moves.actor_email from a
-- client-supplied p_actor_email parameter — i.e. the audit "who" is spoofable,
-- exactly as in the money layer (closed for payments/credit notes in 20260751).
--
-- Rather than rewrite ~14 functions in-place — several of which were already
-- amended by later migrations (reserve_units.ORDER BY created_date in 20260738,
-- funnel_reserve_line's bulk branch in 20260742), so a blind full-body
-- CREATE OR REPLACE risks reintroducing fixed bugs — we enforce the correct
-- actor at the SINGLE append point: stock_moves is INSERT-only, so a
-- BEFORE INSERT trigger that overwrites actor_email with the JWT identity
-- covers every current and future ledger write in one place.
--
-- When there is a real authenticated caller (rma_current_user_email() is not
-- null), that identity wins over whatever the RPC passed. When there is no JWT
-- (a genuine service_role / system context), the passed-in value is kept so the
-- NOT NULL column is still satisfied. This is the same "trust the JWT, not the
-- parameter" contract applied to payments/credit notes.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.stock_moves_stamp_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_email text;
BEGIN
  v_jwt_email := public.rma_current_user_email();
  IF v_jwt_email IS NOT NULL AND v_jwt_email <> '' THEN
    NEW.actor_email := v_jwt_email;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_moves_stamp_actor ON public.stock_moves;
CREATE TRIGGER trg_stock_moves_stamp_actor
  BEFORE INSERT ON public.stock_moves
  FOR EACH ROW
  EXECUTE FUNCTION public.stock_moves_stamp_actor();
