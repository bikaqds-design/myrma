-- ═══════════════════════════════════════════════════════════════════════════
--  Warehouse Module Redesign R1 — system RMA/transit/virtual locations
--
--  Adds 8 fixed, protected warehouse rows so RMA ticket stages (Received,
--  Under Repair, Repaired, Can't Repair, RMA Stock), Replacement holding, and
--  Scrap become real inventory locations instead of free-text ticket status —
--  the gap identified in the Warehouse Module redesign research: units
--  created from tickets have always had warehouse_id = NULL with no runtime
--  path back to sellable stock (resolve_units() has zero callers in src/).
--
--  is_system rows are protected by a trigger (below) — cannot be deleted,
--  renamed, re-coded, re-typed, or deactivated via the normal Warehouses UI.
--  manager/notes/description remain editable (harmless metadata).
--
--  warehouses.code has no existing UNIQUE constraint (live duplicates are
--  possible), so the new partial unique index only applies to is_system rows
--  — it can't fail against pre-existing non-system data, and it guarantees
--  the 8 system codes stay resolvable 1:1 for the RPCs in 20260766.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── warehouses.is_system ──────────────────────────────────────────────────

ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS warehouses_system_code_key
  ON public.warehouses (code)
  WHERE is_system;

-- ── protection trigger ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.protect_system_warehouse()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'System warehouse "%" cannot be deleted', OLD.code
      USING ERRCODE = 'P0001';
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.code IS DISTINCT FROM OLD.code
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.warehouse_type IS DISTINCT FROM OLD.warehouse_type
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION 'System warehouse "%" cannot be renamed, re-coded, re-typed, deactivated, or un-flagged', OLD.code
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_system_warehouse ON public.warehouses;
CREATE TRIGGER trg_protect_system_warehouse
  BEFORE UPDATE OR DELETE ON public.warehouses
  FOR EACH ROW
  WHEN (OLD.is_system)
  EXECUTE FUNCTION public.protect_system_warehouse();

-- ── archive_warehouse: add is_system guard ahead of the live-stock check ────
-- Body otherwise unamended since 20260745 (verbatim, plus the new guard).

CREATE OR REPLACE FUNCTION public.archive_warehouse(
  p_warehouse_id uuid,
  p_actor_email  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit_count  integer;
  v_stock_count integer;
  v_is_system   boolean;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to archive a warehouse' USING ERRCODE = 'P0001';
  END IF;

  SELECT is_system INTO v_is_system FROM public.warehouses WHERE id = p_warehouse_id;

  IF v_is_system THEN
    RAISE EXCEPTION 'System warehouses cannot be archived' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_unit_count
  FROM public.inventory_units
  WHERE warehouse_id = p_warehouse_id AND status <> 'closed';

  SELECT COUNT(*) INTO v_stock_count
  FROM public.warehouse_stock
  WHERE warehouse_id = p_warehouse_id AND quantity > 0;

  IF v_unit_count > 0 OR v_stock_count > 0 THEN
    RAISE EXCEPTION 'Cannot archive warehouse: % live serialized unit(s) and % bulk-stock product(s) still present',
      v_unit_count, v_stock_count
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.warehouses SET is_active = false WHERE id = p_warehouse_id;
END;
$$;

-- ── seed the 8 system locations (idempotent) ─────────────────────────────
-- RMA-* (Received/Repair/Repaired/Can't Repair/Stock) type 'rma'.
-- REPLACEMENT type 'transit' (units earmarked to go back out to a customer).
-- CREDIT-NOTE type 'rma' (holding pen pending CN-driven disposition, R2).
-- SCRAP type 'virtual' (write-off — excluded from sellable/physical totals).

INSERT INTO public.warehouses (name, code, warehouse_type, is_system, is_active, description)
SELECT v.name, v.code, v.warehouse_type, true, true, v.description
FROM (VALUES
  ('RMA - Received',        'RMA-RECEIVED',  'rma',       'Units just received on an RMA ticket, not yet triaged'),
  ('RMA - Under Repair',    'RMA-REPAIR',    'rma',       'Units currently being repaired'),
  ('RMA - Repaired',        'RMA-REPAIRED',  'rma',       'Units repaired, pending return or restock'),
  ('RMA - Can''t Repair',   'RMA-CANTREPAIR','rma',       'Units that could not be repaired'),
  ('RMA - Stock',           'RMA-STOCK',     'rma',       'Units resolved as Replacement/Credit Note, pending disposition'),
  ('Replacement Holding',   'REPLACEMENT',   'transit',   'Units earmarked to be sent out as a customer replacement'),
  ('Credit Note Holding',   'CREDIT-NOTE',   'rma',       'Units returned against an issued credit note'),
  ('Scrap',                 'SCRAP',         'virtual',   'Written-off units — never counted as sellable or physical stock')
) AS v(name, code, warehouse_type, description)
WHERE NOT EXISTS (
  SELECT 1 FROM public.warehouses w WHERE w.code = v.code AND w.is_system
);
