-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 8 Phase 8a — bulk-quantity stock schema foundation
--
--  Adds the second stock-tracking model confirmed 2026-07-01: products can be
--  either 'serialized' (existing model — one inventory_units row per physical
--  unit, unchanged) or 'bulk' (new — a quantity counter per warehouse, mirrors
--  parts.quantity/reserved_quantity but with a warehouse dimension parts has
--  never had). product_type ('service' vs not) still governs whether a line
--  touches inventory at all; stock_tracking_mode governs HOW non-service
--  stock is tracked. Default 'serialized' — zero behavior change for
--  existing products unless explicitly switched to 'bulk'.
--
--  Also extends warehouses (type/manager/notes) and stock_moves
--  (move_type: receive/transfer; ref_type: warehouse_stock) — both needed by
--  the RPCs in the migrations that follow this one.
--
--  Pure DDL, idempotent, no runtime logic — lower risk than the RPC
--  migrations that follow. Constraint drops use a catalog lookup (not a
--  guessed name) — this session already found two real bugs from assuming
--  column/constraint identity without checking against the live schema.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── products.stock_tracking_mode ─────────────────────────────────────────────

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS stock_tracking_mode text NOT NULL DEFAULT 'serialized'
    CHECK (stock_tracking_mode IN ('serialized', 'bulk'));

-- ── warehouse_stock: bulk-quantity counterpart to inventory_units ───────────

CREATE TABLE IF NOT EXISTS public.warehouse_stock (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        uuid        NOT NULL REFERENCES public.products(id),
  warehouse_id      uuid        NOT NULL REFERENCES public.warehouses(id),
  quantity          integer     NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reserved_quantity integer     NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0 AND reserved_quantity <= quantity),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS warehouse_stock_product_idx ON public.warehouse_stock (product_id);
CREATE INDEX IF NOT EXISTS warehouse_stock_warehouse_idx ON public.warehouse_stock (warehouse_id);

ALTER TABLE public.warehouse_stock ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_warehouse_stock" ON public.warehouse_stock;
CREATE POLICY "staff_read_warehouse_stock"
  ON public.warehouse_stock FOR SELECT
  USING (public.rma_is_staff());

DROP POLICY IF EXISTS "manager_write_warehouse_stock" ON public.warehouse_stock;
CREATE POLICY "manager_write_warehouse_stock"
  ON public.warehouse_stock FOR ALL
  USING (public.rma_is_manager_or_above())
  WITH CHECK (public.rma_is_manager_or_above());

-- ── warehouses: type / manager / notes ───────────────────────────────────────
-- (is_active already exists — no new column needed for archive itself)

ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS warehouse_type text
    CHECK (warehouse_type IN ('main', 'branch', 'service_center', 'rma', 'transit', 'virtual')),
  ADD COLUMN IF NOT EXISTS manager text,
  ADD COLUMN IF NOT EXISTS notes text;

-- ── stock_moves: extend move_type (receive, transfer) ────────────────────────

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.stock_moves'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%move_type%';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.stock_moves DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;

ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_move_type_check
  CHECK (move_type IN ('reserve', 'deliver', 'release', 'restore', 'adjust', 'receive', 'transfer'));

-- ── stock_moves: extend ref_type (warehouse_stock) ───────────────────────────
-- A warehouse_stock row is a distinct concept from a `parts` row — both are
-- quantity counters, but reusing 'part' for warehouse_stock would make
-- ref_id ambiguous (parts.id vs warehouse_stock.id). New value avoids that.

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.stock_moves'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%ref_type%';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.stock_moves DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;

ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_ref_type_check
  CHECK (ref_type IN ('unit', 'part', 'warehouse_stock'));
