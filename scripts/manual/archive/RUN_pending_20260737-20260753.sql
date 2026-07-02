-- ############################################################################
-- #  PENDING MIGRATION BUNDLE — 20260737 → 20260753 (17 migrations)
-- #  Generated 2026-07-02 (rev 2 — fixed RAISE %% bug in 20260751).
-- #  Covers Sprint 7.6 / 8 / 9 + the 2026-07-02 audit hardening (CRIT-1/2/3,
-- #  HIGH-2). Concatenated in dependency order.
-- #
-- #  HOW TO RUN
-- #    Paste this whole file into the Supabase SQL Editor and run once. The
-- #    editor executes it as a SINGLE TRANSACTION, so it is all-or-nothing:
-- #    if any statement fails, NOTHING is applied and you can fix + re-run.
-- #    Every migration is idempotent, so re-running is safe.
-- #
-- #  BEFORE YOU RUN — the ONLY data dependency is 20260739 (serial uniqueness).
-- #    Run this diagnostic FIRST, in a separate query:
-- #
-- #      SELECT serial_number, COUNT(*) AS dup_count,
-- #             array_agg(id) AS unit_ids, array_agg(status) AS statuses
-- #      FROM public.inventory_units
-- #      WHERE serial_number IS NOT NULL AND serial_number <> ''
-- #        AND status <> 'closed'
-- #      GROUP BY serial_number HAVING COUNT(*) > 1
-- #      ORDER BY dup_count DESC;
-- #
-- #    • Zero rows  -> this bundle applies cleanly, run it.
-- #    • Rows found -> resolve them first (see
-- #      scripts/manual/20260740_inventory_units_dedupe_placeholder_serials.sql
-- #      for the known 2026-07-01 set), re-run the diagnostic until zero, THEN
-- #      run this bundle. If the duplicate IDs differ from that script's list,
-- #      STOP and resolve manually — do not force it.
-- #
-- #  AFTER IT APPLIES: run scripts/manual/VERIFY_audit_hardening.sql.
-- ############################################################################



-- ====================================================================
-- FILE: 20260737_inventory_units_add_product_id.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 7.6 — inventory_units.product_id (foundational prerequisite)
--
--  Discovered live 2026-07-01: reserve_units, release_units*, deliver_units*,
--  restore_units* (20260719_inventory_reservation.sql) and funnel_reserve_line
--  (20260732) were all written assuming inventory_units.product_id exists.
--  It never has — inventory_units predates the sales funnel and was built
--  purely for the RMA repair workflow, which only ever captured a free-text
--  product_name (see inventory.ts createUnitsFromTicket). Confirmed via a
--  live information_schema.columns query: 18 real columns, no product_id.
--
--  (*release_units/deliver_units/restore_units don't actually reference
--  product_id — only reserve_units and funnel_reserve_line do. But every
--  document-line reservation in the funnel goes through those two, so the
--  whole reservation subsystem has been unable to execute against real data
--  since its creation. This is the true root cause behind "full end-to-end
--  funnel testing is blocked" — deeper than the "no available stock" framing
--  in the original Sprint 7.5 retrospective.)
--
--  Nullable, no backfill (confirmed with user 2026-07-01): historical
--  RMA-workflow units only have a free-text product_name, and fuzzy-matching
--  that against products.product_name risks silently linking a unit to the
--  wrong catalog product. Old rows stay product_id = NULL — they were
--  already invisible to the reservation system, since it never worked.
--  Only units created going forward (Sprint 8's "Receive Stock", or a future
--  manual link action) get a real product_id.
--
--  This migration must run before 20260738_inventory_model_reconciliation.sql.
--  Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.inventory_units
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES public.products(id);

CREATE INDEX IF NOT EXISTS inv_units_product_id_idx
  ON public.inventory_units (product_id);


-- ====================================================================
-- FILE: 20260738_inventory_model_reconciliation.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 7.6 — Inventory Model Reconciliation (schema/RPC only, no UI)
--
--  PREREQUISITE: 20260737_inventory_units_add_product_id.sql MUST run before
--  this migration. reserve_units/funnel_reserve_line reference
--  inventory_units.product_id, which has never existed in production until
--  that migration adds it (discovered live 2026-07-01 when this migration's
--  original serial-uniqueness index failed to create, prompting a schema
--  introspection that surfaced the missing column).
--
--  A0 (Critical — discovered live, not in the original audit): TWO column
--    references in reserve_units have never resolved against the real
--    table, meaning it has never successfully executed in production:
--      (a) `product_id` — inventory_units has no such column (confirmed via
--          information_schema.columns); it only has free-text `product_name`
--          from the original RMA-repair-ticket design. Fixed by 20260737.
--      (b) `ORDER BY created_at` — the real column is `created_date`. Fixed
--          below (this was the only place created_at was referenced; parts
--          RPCs and release/deliver/restore_units don't touch either column).
--    Postgres doesn't validate plpgsql column references at CREATE FUNCTION
--    time, so both defects applied silently in 20260719 and were only
--    caught now because a plain SQL SELECT (not plpgsql) fails immediately.
--
--  Fixes 3 findings from the 2026-07-01 architecture audit, all in the
--  stock-reservation path used by every Sales Order / Invoice approval:
--
--  A1 (Critical): inventory_units has two orthogonal status axes that were
--    getting conflated — `status` (physical/RMA lifecycle: active_rma /
--    company_stock / sent_to_manufacturer / closed) and `reservation_status`
--    (funnel state: available / reserved / delivered, added by 20260719).
--    Documented here via COMMENT ON COLUMN so this never gets re-confused.
--
--  A2 (Critical — overselling hole #1): funnel_reserve_line classified a
--    line as "service, no stock effect" whenever the product happened to
--    have zero inventory_units rows *right now* — indistinguishable from
--    "this product is legitimately sold out." Fixed by branching on the
--    existing products.product_type enum instead (no new column needed —
--    hardware/software/accessory already require serialized units via Zod
--    and a DB CHECK constraint, 20260526_check_constraints.sql:121-124).
--    Only product_type = 'service' is a no-op; everything else always goes
--    through reserve_units, which correctly raises "Insufficient stock" at
--    zero available — including for a brand-new or fully sold-out product.
--
--  A3 (High — overselling hole #2): reserve_units only excluded
--    status = 'closed', so a unit on the repair bench (active_rma) or out
--    at the manufacturer (sent_to_manufacturer) could be reserved and
--    delivered against a Sales Order. Restricted to the one status that
--    actually means "in our warehouse, sellable": company_stock.
--
--  A4 (Medium-High — moved to 20260739_inventory_serial_uniqueness.sql):
--    no uniqueness guard on serial_number. Split into its own migration
--    because it has a live-data dependency (duplicate serials already
--    exist) that the other fixes here don't — see that file for detail.
--
--  All changes are idempotent. No UI/page changes in this migration —
--  Sprint 8 (Inventory Redesign) builds on top of this.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A1: document the two-axis contract directly on the columns ──────────────

COMMENT ON COLUMN public.inventory_units.status IS
  'Physical/RMA repair lifecycle: active_rma (on the bench) | company_stock '
  '(sellable, in warehouse) | sent_to_manufacturer (out for repair) | closed '
  '(terminal). Orthogonal to reservation_status — never conflate the two.';

COMMENT ON COLUMN public.inventory_units.reservation_status IS
  'Funnel/sales state: available | reserved (see reserved_by_doc_id) | '
  'delivered. Orthogonal to status — a unit is only sellable for a new '
  'document when it is ALSO status = ''company_stock''.';

-- ── A2: funnel_reserve_line — classify by product_type, not row existence ───

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
  v_product_type text;
BEGIN
  SELECT product_type INTO v_product_type
  FROM public.products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_product_type = 'service' THEN
    RETURN; -- service lines never touch inventory
  END IF;

  -- hardware / software / accessory: always require serialized units.
  -- reserve_units raises "Insufficient stock" at 0 available — this is what
  -- fixes the silent no-op for a new/sold-out product (audit A2).
  PERFORM public.reserve_units(p_doc_type, p_doc_id, p_product_id, p_qty, p_actor_email);
END;
$$;

-- ── A3: reserve_units — restrict to the one sellable status ─────────────────

CREATE OR REPLACE FUNCTION public.reserve_units(
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
  v_unit       record;
  v_count      integer := 0;
  v_available  integer;
BEGIN
  -- Count available units first (fast check before locking)
  SELECT COUNT(*) INTO v_available
  FROM public.inventory_units
  WHERE product_id = p_product_id
    AND reservation_status = 'available'
    AND status = 'company_stock';

  IF v_available < p_qty THEN
    RAISE EXCEPTION 'Insufficient stock: need %, only % available for product %',
      p_qty, v_available, p_product_id
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_unit IN
    SELECT id FROM public.inventory_units
    WHERE product_id = p_product_id
      AND reservation_status = 'available'
      AND status = 'company_stock'
    ORDER BY created_date
    LIMIT p_qty
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.inventory_units
    SET
      reservation_status   = 'reserved',
      reserved_by_doc_type = p_doc_type,
      reserved_by_doc_id   = p_doc_id,
      reserved_at          = NOW(),
      reserved_by_email    = p_actor_email
    WHERE id = v_unit.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit.id, p_doc_type, p_doc_id, 'reserve', 1, 'available', 'reserved', p_actor_email);

    v_count := v_count + 1;
  END LOOP;

  IF v_count < p_qty THEN
    RAISE EXCEPTION 'Concurrent reservation conflict: secured only % of % units for product %',
      v_count, p_qty, p_product_id
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- A4 (serial-number uniqueness) is deferred to
-- 20260739_inventory_serial_uniqueness.sql — it has a live-data dependency
-- the fixes above don't.

-- >>> DATA-DEPENDENT: confirm the duplicate-serial diagnostic returns ZERO rows before this point (see header). <<<


-- ====================================================================
-- FILE: 20260739_inventory_serial_uniqueness.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 7.6 §4 — Serial-number uniqueness (A4) — DEFERRED
--
--  Split out from 20260738 because this has a live-data dependency the
--  other fixes don't: applying this migration failed on first attempt
--  (2026-07-01) with "Key (serial_number)=(1) is duplicated" — production
--  already has non-closed inventory_units rows sharing a serial number.
--
--  DO NOT APPLY until the duplicate(s) are resolved. Run this read-only
--  diagnostic first:
--
--    SELECT serial_number, COUNT(*) AS dup_count,
--           array_agg(id) AS unit_ids, array_agg(status) AS statuses
--    FROM public.inventory_units
--    WHERE serial_number IS NOT NULL
--      AND serial_number <> ''
--      AND status <> 'closed'
--    GROUP BY serial_number
--    HAVING COUNT(*) > 1
--    ORDER BY dup_count DESC;
--
--  For each duplicate group, either correct the serial_number on the
--  incorrect row(s), or set it to NULL/'' if the real serial isn't known,
--  or transition the stale row to status = 'closed' if it no longer
--  represents a live unit. Once the diagnostic returns zero rows, this
--  migration will apply cleanly.
--
--  Excludes NULL and '' (repair-ticket units without a captured serial
--  share both — inventory.ts createUnitsFromTicket) and 'closed' units
--  (historical/terminal — may legitimately repeat a serial that later
--  comes back through a new ticket).
--
--  receive_stock (Sprint 8) and receive_vendor_invoice (Sprint 9) will add
--  friendly per-serial duplicate errors when those RPCs are written — this
--  migration only adds the enforcement mechanism.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS inv_units_serial_unique_idx
  ON public.inventory_units (serial_number)
  WHERE serial_number IS NOT NULL
    AND serial_number <> ''
    AND status <> 'closed';


-- ====================================================================
-- FILE: 20260740_inventory_bulk_stock_schema.sql
-- ====================================================================
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


-- ====================================================================
-- FILE: 20260741_warehouse_stock_reservation_rpcs.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 8 Phase 8a — bulk-quantity reservation RPCs
--
--  The bulk-quantity counterpart to reserve/release/deliver/restore_units
--  (20260719), operating on warehouse_stock instead of individual
--  inventory_units rows.
--
--  Key design difference from the serialized case: an inventory_units row
--  carries its OWN reservation marker (reserved_by_doc_id), so
--  release_units/deliver_units can just query "everything this doc
--  reserved" directly off the row. A warehouse_stock row is a SHARED
--  counter — multiple documents can each have reserved a slice of the same
--  row's quantity concurrently — so there is no per-row marker for "how
--  much of this reservation belongs to document X." stock_moves is used as
--  the ledger of truth for that: each reserve event records exactly how
--  much was taken from which warehouse_stock row for which document, so
--  release/deliver can look up and reverse precisely that amount per row.
--
--  This makes release_warehouse_stock/deliver_warehouse_stock naturally
--  idempotent: the "net reserved not yet settled" query only returns rows
--  where reserve-minus-prior-release-or-deliver is still positive, so a
--  duplicate call finds nothing left to act on and safely no-ops — this
--  must be verified explicitly in the gate tests, not assumed.
--
--  Confirmed 2026-07-01: bulk reservation freely splits across whichever
--  warehouses have availability (no per-line warehouse pinning), matching
--  how serialized reservation already behaves.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── reserve_warehouse_stock ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reserve_warehouse_stock(
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
  v_row             record;
  v_remaining       integer := p_qty;
  v_take            integer;
  v_total_available integer;
BEGIN
  SELECT COALESCE(SUM(quantity - reserved_quantity), 0) INTO v_total_available
  FROM public.warehouse_stock
  WHERE product_id = p_product_id;

  IF v_total_available < p_qty THEN
    RAISE EXCEPTION 'Insufficient stock: need %, only % available for product %',
      p_qty, v_total_available, p_product_id
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_row IN
    SELECT id, quantity, reserved_quantity
    FROM public.warehouse_stock
    WHERE product_id = p_product_id
      AND (quantity - reserved_quantity) > 0
    ORDER BY (quantity - reserved_quantity) DESC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_remaining, v_row.quantity - v_row.reserved_quantity);

    UPDATE public.warehouse_stock
    SET reserved_quantity = reserved_quantity + v_take, updated_at = now()
    WHERE id = v_row.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_row.id, p_doc_type, p_doc_id, 'reserve', v_take, 'available', 'reserved', p_actor_email);

    v_remaining := v_remaining - v_take;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'Concurrent reservation conflict: could not secure % of % units for product %',
      v_remaining, p_qty, p_product_id
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ── release_warehouse_stock ───────────────────────────────────────────────────
-- Idempotent by construction — see header note above.
--
-- BUG FOUND IN GATE TESTING 2026-07-01: `sm.doc_id = p_doc_id` silently
-- matched zero rows whenever p_doc_id was NULL (SQL's NULL = NULL is NULL,
-- not true) — a real case, since 'manual' doc_type calls legitimately pass
-- NULL for doc_id. This made release_warehouse_stock a permanent no-op for
-- any NULL-doc_id reservation. Fixed with IS NOT DISTINCT FROM, which
-- treats NULL as a comparable value (matches NULL to NULL correctly).

CREATE OR REPLACE FUNCTION public.release_warehouse_stock(
  p_doc_type    text,
  p_doc_id      uuid,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT
      sm.ref_id AS warehouse_stock_id,
      SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
        - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) AS net_qty
    FROM public.stock_moves sm
    WHERE sm.doc_type = p_doc_type
      AND sm.doc_id IS NOT DISTINCT FROM p_doc_id
      AND sm.ref_type = 'warehouse_stock'
    GROUP BY sm.ref_id
    HAVING SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
         - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) > 0
  LOOP
    UPDATE public.warehouse_stock
    SET reserved_quantity = GREATEST(reserved_quantity - v_row.net_qty, 0), updated_at = now()
    WHERE id = v_row.warehouse_stock_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_row.warehouse_stock_id, p_doc_type, p_doc_id, 'release', v_row.net_qty, 'reserved', 'available', p_actor_email);
  END LOOP;
END;
$$;

-- ── deliver_warehouse_stock ───────────────────────────────────────────────────
-- Same net-qty-per-row lookup as release, but decrements BOTH quantity and
-- reserved_quantity (stock actually leaves the building).
-- Same NULL-doc_id fix as release_warehouse_stock above.

CREATE OR REPLACE FUNCTION public.deliver_warehouse_stock(
  p_doc_type    text,
  p_doc_id      uuid,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT
      sm.ref_id AS warehouse_stock_id,
      SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
        - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) AS net_qty
    FROM public.stock_moves sm
    WHERE sm.doc_type = p_doc_type
      AND sm.doc_id IS NOT DISTINCT FROM p_doc_id
      AND sm.ref_type = 'warehouse_stock'
    GROUP BY sm.ref_id
    HAVING SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
         - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) > 0
  LOOP
    UPDATE public.warehouse_stock
    SET quantity = quantity - v_row.net_qty,
        reserved_quantity = GREATEST(reserved_quantity - v_row.net_qty, 0),
        updated_at = now()
    WHERE id = v_row.warehouse_stock_id
      AND quantity >= v_row.net_qty;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot deliver % units from warehouse_stock % — quantity would go negative',
        v_row.net_qty, v_row.warehouse_stock_id
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_row.warehouse_stock_id, p_doc_type, p_doc_id, 'deliver', v_row.net_qty, 'reserved', 'delivered', p_actor_email);
  END LOOP;
END;
$$;

-- ── restore_warehouse_stock ───────────────────────────────────────────────────
-- Credit-note restock path (mirrors restore_units). Takes an explicit qty
-- since delivered stock has already left reserved_quantity entirely — the
-- caller (creditNotes.issue()) knows the qty from the credit note line
-- itself, same as restore_units takes explicit p_unit_ids.

CREATE OR REPLACE FUNCTION public.restore_warehouse_stock(
  p_product_id   uuid,
  p_warehouse_id uuid,
  p_qty          integer,
  p_doc_type     text,
  p_doc_id       uuid,
  p_actor_email  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.warehouse_stock
  WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity)
    VALUES (p_product_id, p_warehouse_id, p_qty, 0)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.warehouse_stock SET quantity = quantity + p_qty, updated_at = now() WHERE id = v_id;
  END IF;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
  VALUES
    ('warehouse_stock', v_id, p_doc_type, p_doc_id, 'restore', p_qty, 'delivered', 'available', p_actor_email);
END;
$$;


-- ====================================================================
-- FILE: 20260742_funnel_reserve_line_bulk_branch.sql
-- ====================================================================
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


-- ====================================================================
-- FILE: 20260743_receive_stock_rpc.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 8 Phase 8a — receive_stock (dual-mode)
--
--  Interim manual stock-entry path — Sprint 9's Purchase Module will
--  eventually replace this with vendor-invoice-driven receipt for both
--  modes. Branches by the product's stock_tracking_mode:
--    serialized → inserts one inventory_units row per call (one serial)
--    bulk       → upserts warehouse_stock.quantity for that product+warehouse
--
--  manager+ enforced server-side (rma_is_manager_or_above()), matching every
--  other write RPC in this sprint.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.receive_stock(
  p_product_id   uuid,
  p_warehouse_id uuid,
  p_actor_email  text,
  p_serial       text DEFAULT NULL,
  p_qty          integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tracking_mode text;
  v_product_name  text;
  v_unit_id       uuid;
  v_ws_id         uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to receive stock' USING ERRCODE = 'P0001';
  END IF;

  SELECT stock_tracking_mode, product_name INTO v_tracking_mode, v_product_name
  FROM public.products WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = 'P0001';
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    IF p_qty IS NULL OR p_qty <= 0 THEN
      RAISE EXCEPTION 'A positive quantity is required to receive bulk stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT id INTO v_ws_id FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity)
      VALUES (p_product_id, p_warehouse_id, p_qty, 0)
      RETURNING id INTO v_ws_id;
    ELSE
      UPDATE public.warehouse_stock SET quantity = quantity + p_qty, updated_at = now() WHERE id = v_ws_id;
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_ws_id, 'manual', NULL, 'receive', p_qty, NULL, 'available', p_actor_email);
  ELSE
    IF p_serial IS NULL OR btrim(p_serial) = '' THEN
      RAISE EXCEPTION 'A serial number is required to receive serialized stock' USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      INSERT INTO public.inventory_units
        (product_id, product_name, serial_number, status, reservation_status, warehouse_id, created_date)
      VALUES
        (p_product_id, v_product_name, p_serial, 'company_stock', 'available', p_warehouse_id, now())
      RETURNING id INTO v_unit_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Serial number % is already in use', p_serial USING ERRCODE = 'P0001';
    END;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit_id, 'manual', NULL, 'receive', 1, NULL, 'available', p_actor_email);
  END IF;
END;
$$;


-- ====================================================================
-- FILE: 20260744_transfer_stock_rpc.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 8 Phase 8a — transfer_stock (atomic, dual-mode)
--
--  Replaces the current direct warehouse_id field mutation (Track B B1.2 gap
--  — "no reservation concept, transfer race risk") with a validated, atomic,
--  audit-logged transfer.
--
--  serialized → moves ONE unit's warehouse_id (identified by p_unit_id);
--    blocked unless reservation_status='available' — a unit promised to an
--    open Sales Order/Invoice can't be silently relocated out from under it.
--  bulk → decrements source / increments destination warehouse_stock.quantity
--    under row locks; blocked if insufficient AVAILABLE (quantity minus
--    reserved_quantity) at the source. Logs a stock_moves row on BOTH the
--    source and destination warehouse_stock rows so the Stock Movements tab
--    can show the transfer from either side.
--
--  from_status/to_status on the 'transfer' stock_moves rows carry the
--  warehouse UUIDs (as text) rather than a reservation-status transition —
--  a transfer doesn't change reservation_status (only 'available' stock can
--  be transferred), so recording which warehouses were involved is the
--  more useful audit fact here. No new columns needed — these are already
--  plain text with no CHECK constraint.
--
--  All-or-nothing: any failure raises before either side is touched.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.transfer_stock(
  p_product_id        uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id   uuid,
  p_actor_email       text,
  p_unit_id           uuid DEFAULT NULL,
  p_qty               integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tracking_mode text;
  v_unit          record;
  v_src           record;
  v_dst_id        uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to transfer stock' USING ERRCODE = 'P0001';
  END IF;

  IF p_from_warehouse_id = p_to_warehouse_id THEN
    RAISE EXCEPTION 'Source and destination warehouse must differ' USING ERRCODE = 'P0001';
  END IF;

  SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = 'P0001';
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    IF p_qty IS NULL OR p_qty <= 0 THEN
      RAISE EXCEPTION 'A positive quantity is required to transfer bulk stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_src FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_from_warehouse_id
    FOR UPDATE;

    IF NOT FOUND OR (v_src.quantity - v_src.reserved_quantity) < p_qty THEN
      RAISE EXCEPTION 'Insufficient available stock at source warehouse: need %, only % available',
        p_qty, COALESCE(v_src.quantity - v_src.reserved_quantity, 0)
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.warehouse_stock SET quantity = quantity - p_qty, updated_at = now() WHERE id = v_src.id;

    SELECT id INTO v_dst_id FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_to_warehouse_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity)
      VALUES (p_product_id, p_to_warehouse_id, p_qty, 0)
      RETURNING id INTO v_dst_id;
    ELSE
      UPDATE public.warehouse_stock SET quantity = quantity + p_qty, updated_at = now() WHERE id = v_dst_id;
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_src.id, 'manual', NULL, 'transfer', p_qty, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email),
      ('warehouse_stock', v_dst_id, 'manual', NULL, 'transfer', p_qty, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email);
  ELSE
    IF p_unit_id IS NULL THEN
      RAISE EXCEPTION 'A unit id is required to transfer serialized stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_unit FROM public.inventory_units WHERE id = p_unit_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit % not found', p_unit_id USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.reservation_status != 'available' THEN
      RAISE EXCEPTION 'Cannot transfer unit % — it is currently %, not available',
        p_unit_id, v_unit.reservation_status
        USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.warehouse_id IS DISTINCT FROM p_from_warehouse_id THEN
      RAISE EXCEPTION 'Unit % is not currently in the specified source warehouse', p_unit_id
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.inventory_units SET warehouse_id = p_to_warehouse_id WHERE id = p_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', p_unit_id, 'manual', NULL, 'transfer', 1, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email);
  END IF;
END;
$$;


-- ====================================================================
-- FILE: 20260745_adjust_archive_recalculate_rpcs.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 8 Phase 8a — adjust_stock, archive_warehouse, recalculate_stock
--
--  Three standalone, lower-complexity RPCs with no interdependencies on
--  each other. All manager+ enforced server-side.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── adjust_stock: manual correction, dual-mode ───────────────────────────────
-- serialized → change a unit's physical status (found/missing/damaged/etc.,
--   constrained by chk_inventory_status — an invalid value is rejected by
--   that existing CHECK, no extra validation needed here).
-- bulk → apply a signed quantity delta to warehouse_stock.quantity.

CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_product_id   uuid,
  p_warehouse_id uuid,
  p_actor_email  text,
  p_unit_id      uuid DEFAULT NULL,
  p_new_status   text DEFAULT NULL,
  p_qty_delta    integer DEFAULT NULL,
  p_reason       text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tracking_mode text;
  v_old_status    text;
  v_ws_id         uuid;
  v_old_qty       integer;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to adjust stock' USING ERRCODE = 'P0001';
  END IF;

  SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = 'P0001';
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    IF p_qty_delta IS NULL OR p_qty_delta = 0 THEN
      RAISE EXCEPTION 'A non-zero quantity delta is required to adjust bulk stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT id, quantity INTO v_ws_id, v_old_qty FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
    FOR UPDATE;

    IF NOT FOUND THEN
      IF p_qty_delta < 0 THEN
        RAISE EXCEPTION 'No stock exists at this warehouse to reduce' USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity)
      VALUES (p_product_id, p_warehouse_id, p_qty_delta, 0)
      RETURNING id INTO v_ws_id;
      v_old_qty := 0;
    ELSE
      IF v_old_qty + p_qty_delta < 0 THEN
        RAISE EXCEPTION 'Adjustment would take quantity negative (current %, delta %)', v_old_qty, p_qty_delta
          USING ERRCODE = 'P0001';
      END IF;
      UPDATE public.warehouse_stock SET quantity = quantity + p_qty_delta, updated_at = now() WHERE id = v_ws_id;
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_ws_id, 'manual', NULL, 'adjust', abs(p_qty_delta),
       v_old_qty::text, (v_old_qty + p_qty_delta)::text, p_actor_email);
  ELSE
    IF p_unit_id IS NULL OR p_new_status IS NULL THEN
      RAISE EXCEPTION 'A unit id and new status are required to adjust serialized stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT status INTO v_old_status FROM public.inventory_units WHERE id = p_unit_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit % not found', p_unit_id USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.inventory_units SET status = p_new_status, notes = COALESCE(p_reason, notes) WHERE id = p_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', p_unit_id, 'manual', NULL, 'adjust', 1, v_old_status, p_new_status, p_actor_email);
  END IF;
END;
$$;

-- ── archive_warehouse: soft-delete guard ──────────────────────────────────────
-- Blocks if any live stock still references this warehouse — serialized
-- units not already 'closed', or bulk quantity > 0.

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
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to archive a warehouse' USING ERRCODE = 'P0001';
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

-- ── recalculate_stock: reconciliation tool — bulk only, reserved_quantity only ──
-- Serialized availability is always a live COUNT(*), nothing to drift.
-- Deliberately does NOT replay `quantity` from the full stock_moves history
-- (a transfer touches two warehouse_stock rows and a fragile full-ledger
-- replay is not worth the risk for a manual, low-frequency admin tool).
-- Only recomputes reserved_quantity, using the exact same net-reserved
-- query already proven correct in release/deliver_warehouse_stock above —
-- reserved_quantity is the counter most likely to drift given the
-- multi-document, multi-warehouse splitting logic; quantity itself is a
-- directly-managed counter (receive/adjust) with no such risk.

CREATE OR REPLACE FUNCTION public.recalculate_stock(
  p_product_id   uuid,
  p_warehouse_id uuid,
  p_actor_email  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ws_id             uuid;
  v_computed_reserved integer;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to recalculate stock' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_ws_id FROM public.warehouse_stock
  WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No warehouse_stock row for this product/warehouse' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(
    CASE WHEN move_type = 'reserve' THEN qty
         WHEN move_type IN ('release', 'deliver') THEN -qty
         ELSE 0 END), 0)
  INTO v_computed_reserved
  FROM public.stock_moves
  WHERE ref_type = 'warehouse_stock' AND ref_id = v_ws_id;

  UPDATE public.warehouse_stock
  SET reserved_quantity = GREATEST(v_computed_reserved, 0), updated_at = now()
  WHERE id = v_ws_id;
END;
$$;


-- ====================================================================
-- FILE: 20260746_purchase_vendors.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 9 — Purchase Module: vendors
--
--  Vendor master data. RLS mirrors every other CRM entity in this project:
--  staff read, manager+ write.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.vendors (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text        NOT NULL,
  contact_person text,
  email          text,
  phone          text,
  tax_id         text,
  payment_terms  text,
  created_by     text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz
);

ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_vendors" ON public.vendors;
CREATE POLICY "staff_read_vendors"
  ON public.vendors FOR SELECT
  USING (public.rma_is_staff());

DROP POLICY IF EXISTS "manager_write_vendors" ON public.vendors;
CREATE POLICY "manager_write_vendors"
  ON public.vendors FOR ALL
  USING (public.rma_is_manager_or_above())
  WITH CHECK (public.rma_is_manager_or_above());


-- ====================================================================
-- FILE: 20260747_purchase_documents.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 9 — Purchase Module: proforma_invoices, purchase_orders, vendor_invoices
--
--  Document flow: Vendor -> Proforma Invoice (optional) -> Purchase Order ->
--  Vendor Invoice -> [Confirm & Receive] -> inventory_units/warehouse_stock.
--
--  Codes: PI-/PO- are random 8-digit (no legal weight, assigned at create,
--  matching QT-/SO-). VI- is gapless YYYY-NNNNN, assigned only at physical
--  receipt inside receive_vendor_invoice (not here) — see that migration.
--
--  vendor_invoices.line_items carries qty_ordered AND qty_received per line
--  so a PO arriving in multiple shipments is representable (partial receipt).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.proforma_invoices (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pi_code    text        UNIQUE NOT NULL,
  vendor_id  uuid        NOT NULL REFERENCES public.vendors(id),
  status     text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'cancelled')),
  line_items jsonb       NOT NULL DEFAULT '[]',
  total      numeric     NOT NULL DEFAULT 0,
  notes      text,
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  po_code              text        UNIQUE NOT NULL,
  vendor_id            uuid        NOT NULL REFERENCES public.vendors(id),
  proforma_invoice_id  uuid        REFERENCES public.proforma_invoices(id),
  status               text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'confirmed', 'cancelled')),
  line_items           jsonb       NOT NULL DEFAULT '[]',
  total                numeric     NOT NULL DEFAULT 0,
  expected_delivery_date date,
  notes                text,
  created_by           text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz
);

CREATE TABLE IF NOT EXISTS public.vendor_invoices (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vi_code            text        UNIQUE,
  purchase_order_id  uuid        REFERENCES public.purchase_orders(id),
  vendor_id          uuid        NOT NULL REFERENCES public.vendors(id),
  status             text        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'confirmed', 'partially_received', 'received', 'cancelled')),
  line_items         jsonb       NOT NULL DEFAULT '[]',
  total              numeric     NOT NULL DEFAULT 0,
  invoice_date       date,
  notes              text,
  created_by         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_at       timestamptz,
  received_at        timestamptz
);

-- RLS: staff read, manager+ write — same tier as vendors and every other
-- CRM document table in this project.
ALTER TABLE public.proforma_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_invoices   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_proforma_invoices" ON public.proforma_invoices;
CREATE POLICY "staff_read_proforma_invoices" ON public.proforma_invoices FOR SELECT USING (public.rma_is_staff());
DROP POLICY IF EXISTS "manager_write_proforma_invoices" ON public.proforma_invoices;
CREATE POLICY "manager_write_proforma_invoices" ON public.proforma_invoices FOR ALL
  USING (public.rma_is_manager_or_above()) WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS "staff_read_purchase_orders" ON public.purchase_orders;
CREATE POLICY "staff_read_purchase_orders" ON public.purchase_orders FOR SELECT USING (public.rma_is_staff());
DROP POLICY IF EXISTS "manager_write_purchase_orders" ON public.purchase_orders;
CREATE POLICY "manager_write_purchase_orders" ON public.purchase_orders FOR ALL
  USING (public.rma_is_manager_or_above()) WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS "staff_read_vendor_invoices" ON public.vendor_invoices;
CREATE POLICY "staff_read_vendor_invoices" ON public.vendor_invoices FOR SELECT USING (public.rma_is_staff());
DROP POLICY IF EXISTS "manager_write_vendor_invoices" ON public.vendor_invoices;
CREATE POLICY "manager_write_vendor_invoices" ON public.vendor_invoices FOR ALL
  USING (public.rma_is_manager_or_above()) WITH CHECK (public.rma_is_manager_or_above());

-- ── Register the vendor_invoice sequence type ────────────────────────────────

INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
VALUES ('vendor_invoice', 0, EXTRACT(YEAR FROM NOW())::integer)
ON CONFLICT (seq_type) DO NOTHING;

-- nextval_for_type's prefix CASE has an ELSE UPPER(p_seq_type) fallback,
-- which would produce 'VENDOR_INVOICE', not 'VI' — must add an explicit
-- WHEN clause. Re-declaring the whole function (idempotent, same body as
-- 20260712 otherwise).
CREATE OR REPLACE FUNCTION public.nextval_for_type(p_seq_type text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year     integer := EXTRACT(YEAR FROM NOW())::integer;
  v_next     integer;
  v_prefix   text;
BEGIN
  UPDATE public.document_sequences
  SET
    last_value = CASE WHEN seq_year = v_year THEN last_value + 1 ELSE 1 END,
    seq_year   = v_year
  WHERE seq_type = p_seq_type
  RETURNING last_value INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Unknown sequence type: %', p_seq_type;
  END IF;

  v_prefix := CASE p_seq_type
    WHEN 'invoice'        THEN 'INV'
    WHEN 'credit_note'    THEN 'CN'
    WHEN 'payment'        THEN 'PAY'
    WHEN 'vendor_invoice' THEN 'VI'
    ELSE UPPER(p_seq_type)
  END;

  RETURN v_prefix || '-' || v_year::text || '-' || LPAD(v_next::text, 5, '0');
END;
$$;

-- ── stock_moves: extend doc_type (vendor_invoice) ────────────────────────────
-- A vendor_invoice.id is a distinct concept from a sales crm_invoices.id —
-- reusing doc_type='invoice' would make doc_id ambiguous between the two
-- and break the Stock Movements tab's "click to view" link (which routes
-- sales-document doc_types to /sales/:type/:id).

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.stock_moves'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%doc_type%';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.stock_moves DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;

ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_doc_type_check
  CHECK (doc_type IN ('sales_order', 'invoice', 'credit_note', 'manual', 'vendor_invoice'));


-- ====================================================================
-- FILE: 20260748_inventory_units_vendor_invoice_fk.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 9 — Purchase Module: inventory_units.vendor_invoice_id
--
--  Traces every serialized unit back to the vendor invoice it was received
--  against. Nullable — units that predate this sprint (RMA-workflow-created,
--  or received via Sprint 8's interim manual receive_stock) have no vendor
--  invoice to point to.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.inventory_units
  ADD COLUMN IF NOT EXISTS vendor_invoice_id uuid REFERENCES public.vendor_invoices(id);

CREATE INDEX IF NOT EXISTS inv_units_vendor_invoice_idx
  ON public.inventory_units (vendor_invoice_id);


-- ====================================================================
-- FILE: 20260749_receive_vendor_invoice_rpc.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 9 — receive_vendor_invoice (atomic, dual-mode)
--
--  Replaces Sprint 8's interim manual receive_stock as the permanent,
--  auditable path for new stock: every unit/quantity received here traces
--  back to a specific vendor_invoices.id.
--
--  p_receipt_lines shape (jsonb array), one element per product being
--  received in this call:
--    serialized: {"product_id": "...", "warehouse_id": "...", "serials": ["SN1","SN2"]}
--    bulk:       {"product_id": "...", "warehouse_id": "...", "qty": 10}
--  (branches on the product's stock_tracking_mode, same convention as
--  Sprint 8's receive_stock — extended here since Sprint 9 was originally
--  specced serial-only, before the bulk-tracking mode existed)
--
--  - Locks the VI row FOR UPDATE, requires status IN ('confirmed',
--    'partially_received'), enforces rma_is_manager_or_above()
--  - Rejects any serial that's already a live unit (Sprint 7.6 §4 — the
--    partial unique index on serial_number does this automatically; caught
--    here for a friendly per-serial error instead of a raw 23505)
--  - Increments each line's qty_received in vendor_invoices.line_items
--    (JSONB rebuilt via jsonb_agg — arrays preserve order, unlike objects)
--  - Assigns vi_code via nextval_for_type('vendor_invoice') only on the
--    FIRST receipt (idempotent — a later partial receipt reuses the code)
--  - Status becomes 'received' once every line's qty_received >= qty_ordered,
--    else 'partially_received' (Sprint 9 audit A8 — multi-shipment receiving)
--  - One transaction: either the whole receipt call lands, or none of it does
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.receive_vendor_invoice(
  p_vi_id         uuid,
  p_receipt_lines jsonb,
  p_actor_email   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vi                 record;
  v_receipt             jsonb;
  v_product_id          uuid;
  v_warehouse_id        uuid;
  v_tracking_mode       text;
  v_serial              text;
  v_unit_id             uuid;
  v_ws_id               uuid;
  v_received_this_line  integer;
  v_receipt_totals      jsonb := '[]'::jsonb;
  v_final_line_items    jsonb;
  v_all_complete        boolean;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to receive a vendor invoice' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_vi FROM public.vendor_invoices WHERE id = p_vi_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice % not found', p_vi_id USING ERRCODE = 'P0001';
  END IF;
  IF v_vi.status NOT IN ('confirmed', 'partially_received') THEN
    RAISE EXCEPTION 'Vendor invoice must be confirmed before receiving (current status: %)', v_vi.status
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_receipt IN SELECT * FROM jsonb_array_elements(p_receipt_lines)
  LOOP
    v_product_id   := (v_receipt->>'product_id')::uuid;
    v_warehouse_id := (v_receipt->>'warehouse_id')::uuid;

    SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = v_product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % not found', v_product_id USING ERRCODE = 'P0001';
    END IF;

    IF v_tracking_mode = 'bulk' THEN
      v_received_this_line := (v_receipt->>'qty')::integer;
      IF v_received_this_line IS NULL OR v_received_this_line <= 0 THEN
        RAISE EXCEPTION 'A positive qty is required for bulk product %', v_product_id USING ERRCODE = 'P0001';
      END IF;

      SELECT id INTO v_ws_id FROM public.warehouse_stock
      WHERE product_id = v_product_id AND warehouse_id = v_warehouse_id
      FOR UPDATE;

      IF NOT FOUND THEN
        INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity)
        VALUES (v_product_id, v_warehouse_id, v_received_this_line, 0)
        RETURNING id INTO v_ws_id;
      ELSE
        UPDATE public.warehouse_stock
        SET quantity = quantity + v_received_this_line, updated_at = now()
        WHERE id = v_ws_id;
      END IF;

      INSERT INTO public.stock_moves
        (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
      VALUES
        ('warehouse_stock', v_ws_id, 'vendor_invoice', p_vi_id, 'receive', v_received_this_line, NULL, 'available', p_actor_email);
    ELSE
      v_received_this_line := 0;
      FOR v_serial IN SELECT jsonb_array_elements_text(COALESCE(v_receipt->'serials', '[]'::jsonb))
      LOOP
        BEGIN
          INSERT INTO public.inventory_units
            (product_id, product_name, serial_number, status, reservation_status, warehouse_id, vendor_invoice_id, created_date)
          SELECT v_product_id, p.product_name, v_serial, 'company_stock', 'available', v_warehouse_id, p_vi_id, now()
          FROM public.products p WHERE p.id = v_product_id
          RETURNING id INTO v_unit_id;
        EXCEPTION WHEN unique_violation THEN
          RAISE EXCEPTION 'Serial number % is already in use', v_serial USING ERRCODE = 'P0001';
        END;

        INSERT INTO public.stock_moves
          (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
        VALUES
          ('unit', v_unit_id, 'vendor_invoice', p_vi_id, 'receive', 1, NULL, 'available', p_actor_email);

        v_received_this_line := v_received_this_line + 1;
      END LOOP;
    END IF;

    v_receipt_totals := v_receipt_totals ||
      jsonb_build_object('product_id', v_product_id::text, 'received', v_received_this_line);
  END LOOP;

  -- Fold each receipt's received qty onto the matching line's qty_received.
  -- Lines with no matching receipt this call are left untouched.
  SELECT jsonb_agg(
    CASE
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_receipt_totals) r WHERE r->>'product_id' = line->>'product_id')
      THEN jsonb_set(
        line,
        '{qty_received}',
        to_jsonb(
          COALESCE((line->>'qty_received')::integer, 0) +
          (SELECT SUM((r->>'received')::integer) FROM jsonb_array_elements(v_receipt_totals) r
           WHERE r->>'product_id' = line->>'product_id')
        )
      )
      ELSE line
    END
  )
  INTO v_final_line_items
  FROM jsonb_array_elements(v_vi.line_items) line;

  SELECT bool_and(COALESCE((line->>'qty_received')::integer, 0) >= COALESCE((line->>'qty_ordered')::integer, 0))
  INTO v_all_complete
  FROM jsonb_array_elements(v_final_line_items) line;

  UPDATE public.vendor_invoices
  SET
    line_items = v_final_line_items,
    vi_code    = COALESCE(vi_code, public.nextval_for_type('vendor_invoice')),
    status     = CASE WHEN v_all_complete THEN 'received' ELSE 'partially_received' END,
    received_at = COALESCE(received_at, now())
  WHERE id = p_vi_id;
END;
$$;


-- ====================================================================
-- FILE: 20260750_purchase_documents_view.sql
-- ====================================================================
-- ═══════════════════════════════════════════════════════════════════════════
--  v_purchase_documents: unified view powering the "All" tab on /purchasing.
--  Same UNION-of-tables pattern as v_sales_documents (20260720) — inherits
--  RLS from the underlying tables since it's a plain view (no SECURITY
--  DEFINER), same as that one.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_purchase_documents AS

  SELECT
    id,
    'proforma_invoice' AS doc_type,
    pi_code            AS doc_code,
    vendor_id,
    created_by,
    status             AS doc_status,
    total,
    created_at,
    updated_at,
    NULL::date         AS type_specific_date,
    NULL::text         AS type_specific_date_label
  FROM public.proforma_invoices

  UNION ALL

  SELECT
    id,
    'purchase_order'      AS doc_type,
    po_code                AS doc_code,
    vendor_id,
    created_by,
    status                 AS doc_status,
    total,
    created_at,
    updated_at,
    expected_delivery_date AS type_specific_date,
    'expected_delivery_date' AS type_specific_date_label
  FROM public.purchase_orders

  UNION ALL

  SELECT
    id,
    'vendor_invoice'  AS doc_type,
    vi_code           AS doc_code,
    vendor_id,
    created_by,
    status            AS doc_status,
    total,
    created_at,
    NULL::timestamptz AS updated_at,
    invoice_date      AS type_specific_date,
    'invoice_date'    AS type_specific_date_label
  FROM public.vendor_invoices;


-- ====================================================================
-- FILE: 20260751_harden_money_rpcs.sql
-- ====================================================================
-- ============================================================================
-- AUDIT 2026-07-02 — Money-layer hardening
-- Closes CRIT-1 (SECURITY DEFINER money RPCs had no role guard / no REVOKE),
-- CRIT-2 (record_payment did not validate allocation sum or customer match),
-- CRIT-3 (actor identity was client-supplied / spoofable),
-- HIGH-2 (non-atomic client-side applyToInvoice → transactional RPCs).
--
-- Idempotent: CREATE OR REPLACE + guarded DO blocks. Safe to re-run.
-- ============================================================================


-- ── CRIT-3 helper contract ──────────────────────────────────────────────────
-- Inside a SECURITY DEFINER function auth.jwt() still reflects the CALLING
-- user's request claims (PostgREST sets request.jwt.claims per request,
-- independent of the definer role), so public.rma_current_user_email() and the
-- role helpers evaluate against the real caller. We therefore DERIVE the actor
-- server-side and only fall back to the passed-in value for genuine
-- service-role/system callers that carry no JWT email.


-- ── record_payment (hardened) ────────────────────────────────────────────────
-- CRIT-1: manager+ guard. CRIT-2: per-allocation running-sum + customer-match
-- + posted checks with FOR UPDATE. CRIT-3: server-derived actor.
CREATE OR REPLACE FUNCTION public.record_payment(
  p_customer_id      uuid,
  p_amount           numeric,
  p_method           text,
  p_reference_number text,
  p_payment_date     date,
  p_notes            text,
  p_actor_email      text,
  p_allocations      jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid   -- payment id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code   text;
  v_id     uuid;
  v_actor  text;
  v_alloc  record;
  v_sum    numeric(12,2) := 0;
  v_inv    record;
BEGIN
  -- CRIT-1: authorization
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to record payments';
  END IF;

  -- CRIT-3: trust the JWT, not the parameter
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  v_code := public.nextval_for_type('payment');

  INSERT INTO public.payments (
    payment_code, customer_id, amount, unapplied_amount,
    method, reference_number, payment_date, notes, created_by
  )
  VALUES (
    v_code, p_customer_id, p_amount, p_amount,
    p_method, p_reference_number,
    COALESCE(p_payment_date, CURRENT_DATE),
    p_notes, v_actor
  )
  RETURNING id INTO v_id;

  -- Apply allocations atomically (Invariant A2)
  FOR v_alloc IN
    SELECT
      (x->>'invoice_id')::uuid AS invoice_id,
      (x->>'amount')::numeric  AS amount
    FROM jsonb_array_elements(p_allocations) AS x
    WHERE (x->>'amount')::numeric > 0
  LOOP
    -- CRIT-2: allocations may never exceed the payment amount
    v_sum := v_sum + v_alloc.amount;
    IF v_sum > p_amount THEN
      RAISE EXCEPTION
        'Allocations (%) exceed payment amount (%)', v_sum, p_amount;
    END IF;

    -- CRIT-2 + M1: lock the invoice, verify it exists, is posted, and belongs
    -- to the paying customer
    SELECT id, customer_id, total, amount_paid
      INTO v_inv
    FROM public.crm_invoices
    WHERE id = v_alloc.invoice_id
      AND doc_status = 'posted'
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % is not a posted invoice', v_alloc.invoice_id;
    END IF;

    IF v_inv.customer_id <> p_customer_id THEN
      RAISE EXCEPTION
        'Invoice % belongs to a different customer', v_alloc.invoice_id;
    END IF;

    -- Insert application row; sync_payment_balance trigger recomputes unapplied
    INSERT INTO public.payment_applications (
      payment_id, invoice_id, amount_applied, applied_by
    )
    VALUES (v_id, v_alloc.invoice_id, v_alloc.amount, v_actor);

    UPDATE public.crm_invoices
    SET
      amount_paid    = LEAST(amount_paid + v_alloc.amount, total),
      payment_status = CASE
        WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN 'paid'
        WHEN LEAST(amount_paid + v_alloc.amount, total) > 0     THEN 'partial'
        ELSE 'unpaid'
        END,
      paid_at = CASE
        WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN NOW()
        ELSE paid_at
        END,
      updated_at = NOW()
    WHERE id = v_alloc.invoice_id;
  END LOOP;

  RETURN v_id;
END;
$$;


-- ── issue_credit_note (hardened) ─────────────────────────────────────────────
-- CRIT-1: manager+ guard. CRIT-3: server-derived actor. Body otherwise
-- identical to 20260735 (assign code, apply to source invoice in same tx).
CREATE OR REPLACE FUNCTION public.issue_credit_note(
  p_cn_id       uuid,
  p_actor_email text
)
RETURNS text   -- assigned cn_code
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cn            record;
  v_code          text;
  v_actor         text;
  v_inv_remaining numeric(12,2);
  v_apply_amount  numeric(12,2);
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to issue credit notes';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  SELECT * INTO v_cn
  FROM public.credit_notes
  WHERE id = p_cn_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id;
  END IF;

  IF v_cn.status <> 'draft' THEN
    RAISE EXCEPTION 'Credit note is already % — cannot issue again', v_cn.status;
  END IF;

  v_code := public.nextval_for_type('credit_note');

  UPDATE public.credit_notes
  SET
    cn_code           = v_code,
    status            = 'issued',
    remaining_balance = v_cn.total,
    issued_at         = NOW(),
    updated_at        = NOW()
  WHERE id = p_cn_id;

  IF v_cn.source_invoice_id IS NOT NULL THEN
    SELECT GREATEST(total - amount_paid, 0) INTO v_inv_remaining
    FROM public.crm_invoices
    WHERE id = v_cn.source_invoice_id
      AND doc_status = 'posted'
    FOR UPDATE;

    IF FOUND AND v_inv_remaining > 0 THEN
      v_apply_amount := LEAST(v_cn.total, v_inv_remaining);

      INSERT INTO public.credit_note_applications (
        credit_note_id, invoice_id, amount_applied, applied_by
      )
      VALUES (p_cn_id, v_cn.source_invoice_id, v_apply_amount, v_actor);

      UPDATE public.crm_invoices
      SET
        amount_paid    = LEAST(amount_paid + v_apply_amount, total),
        payment_status = CASE
          WHEN LEAST(amount_paid + v_apply_amount, total) >= total THEN 'paid'
          WHEN LEAST(amount_paid + v_apply_amount, total) > 0     THEN 'partial'
          ELSE 'unpaid'
          END,
        paid_at = CASE
          WHEN LEAST(amount_paid + v_apply_amount, total) >= total THEN NOW()
          ELSE paid_at
          END,
        updated_at = NOW()
      WHERE id = v_cn.source_invoice_id;
    END IF;
  END IF;

  RETURN v_code;
END;
$$;


-- ── sync_payment_balance (de-clamped) ────────────────────────────────────────
-- CRIT-2 backstop: compute the TRUE unapplied balance (no GREATEST clamp) so
-- that any over-allocation — even via a direct payment_applications INSERT that
-- bypasses record_payment — drives unapplied_amount negative and trips the
-- CHECK constraint below, aborting the transaction.
CREATE OR REPLACE FUNCTION public.sync_payment_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment_id uuid;
  v_amount     numeric(12,2);
  v_applied    numeric(12,2);
BEGIN
  v_payment_id := COALESCE(NEW.payment_id, OLD.payment_id);

  SELECT amount INTO v_amount
  FROM public.payments WHERE id = v_payment_id;

  SELECT COALESCE(SUM(amount_applied), 0) INTO v_applied
  FROM public.payment_applications WHERE payment_id = v_payment_id;

  UPDATE public.payments
  SET unapplied_amount = v_amount - v_applied,
      updated_at = NOW()
  WHERE id = v_payment_id;

  RETURN NULL;
END;
$$;


-- ── CRIT-2: unapplied_amount may never go negative ───────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_payments_unapplied_nonneg'
      AND conrelid = 'public.payments'::regclass
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT chk_payments_unapplied_nonneg
      CHECK (unapplied_amount >= 0);
  END IF;
END $$;


-- ── apply_payment_to_invoice (new, transactional) ────────────────────────────
-- HIGH-2: replaces the non-atomic read-then-write in payments.applyToInvoice.
-- Guards, validates unapplied balance + customer + posted, applies and updates
-- the invoice balance in one transaction (trigger recomputes unapplied).
CREATE OR REPLACE FUNCTION public.apply_payment_to_invoice(
  p_payment_id  uuid,
  p_invoice_id  uuid,
  p_amount      numeric,
  p_actor_email text
)
RETURNS uuid   -- payment_applications id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor text;
  v_pay   record;
  v_inv   record;
  v_app   uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to apply payments';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Applied amount must be positive';
  END IF;

  SELECT id, customer_id, status, unapplied_amount
    INTO v_pay
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found: %', p_payment_id;
  END IF;
  IF v_pay.status <> 'active' THEN
    RAISE EXCEPTION 'Payment must be active to apply (current: %)', v_pay.status;
  END IF;
  IF p_amount > v_pay.unapplied_amount THEN
    RAISE EXCEPTION 'Amount % exceeds unapplied balance %',
      p_amount, v_pay.unapplied_amount;
  END IF;

  SELECT id, customer_id, total, amount_paid
    INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
    AND doc_status = 'posted'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % is not a posted invoice', p_invoice_id;
  END IF;
  IF v_inv.customer_id <> v_pay.customer_id THEN
    RAISE EXCEPTION 'Invoice % belongs to a different customer', p_invoice_id;
  END IF;

  INSERT INTO public.payment_applications (
    payment_id, invoice_id, amount_applied, applied_by
  )
  VALUES (p_payment_id, p_invoice_id, p_amount, v_actor)
  RETURNING id INTO v_app;

  UPDATE public.crm_invoices
  SET
    amount_paid    = LEAST(amount_paid + p_amount, total),
    payment_status = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN 'paid'
      WHEN LEAST(amount_paid + p_amount, total) > 0     THEN 'partial'
      ELSE 'unpaid'
      END,
    paid_at = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN NOW()
      ELSE paid_at
      END,
    updated_at = NOW()
  WHERE id = p_invoice_id;

  RETURN v_app;
END;
$$;


-- ── apply_credit_note_to_invoice (new, transactional) ────────────────────────
-- HIGH-2: replaces the non-atomic (and invoice-balance-missing) client path in
-- creditNotes.applyToInvoice. Same guard/validation/atomicity shape.
CREATE OR REPLACE FUNCTION public.apply_credit_note_to_invoice(
  p_cn_id       uuid,
  p_invoice_id  uuid,
  p_amount      numeric,
  p_actor_email text
)
RETURNS uuid   -- credit_note_applications id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor text;
  v_cn    record;
  v_inv   record;
  v_app   uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to apply credit notes';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Applied amount must be positive';
  END IF;

  SELECT id, customer_id, status, remaining_balance
    INTO v_cn
  FROM public.credit_notes
  WHERE id = p_cn_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id;
  END IF;
  IF v_cn.status <> 'issued' THEN
    RAISE EXCEPTION 'Credit note must be issued to apply (current: %)', v_cn.status;
  END IF;
  IF p_amount > v_cn.remaining_balance THEN
    RAISE EXCEPTION 'Amount % exceeds remaining balance %',
      p_amount, v_cn.remaining_balance;
  END IF;

  SELECT id, customer_id, total, amount_paid
    INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
    AND doc_status = 'posted'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % is not a posted invoice', p_invoice_id;
  END IF;
  IF v_inv.customer_id <> v_cn.customer_id THEN
    RAISE EXCEPTION 'Invoice % belongs to a different customer', p_invoice_id;
  END IF;

  INSERT INTO public.credit_note_applications (
    credit_note_id, invoice_id, amount_applied, applied_by
  )
  VALUES (p_cn_id, p_invoice_id, p_amount, v_actor)
  RETURNING id INTO v_app;

  UPDATE public.crm_invoices
  SET
    amount_paid    = LEAST(amount_paid + p_amount, total),
    payment_status = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN 'paid'
      WHEN LEAST(amount_paid + p_amount, total) > 0     THEN 'partial'
      ELSE 'unpaid'
      END,
    paid_at = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN NOW()
      ELSE paid_at
      END,
    updated_at = NOW()
  WHERE id = p_invoice_id;

  RETURN v_app;
END;
$$;


-- ── CRIT-1: lock down EXECUTE ────────────────────────────────────────────────
-- Default Postgres grants EXECUTE to PUBLIC. Revoke, then grant only to real
-- authenticated users (and service_role for server-side callers). anon can no
-- longer reach these via /rest/v1/rpc/*.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.record_payment(uuid, numeric, text, text, date, text, text, jsonb)',
    'public.issue_credit_note(uuid, text)',
    'public.apply_payment_to_invoice(uuid, uuid, numeric, text)',
    'public.apply_credit_note_to_invoice(uuid, uuid, numeric, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    BEGIN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
  END LOOP;
END $$;


-- ====================================================================
-- FILE: 20260752_lockdown_rpc_execute.sql
-- ====================================================================
-- ============================================================================
-- AUDIT 2026-07-02 — CRIT-1 (execute lockdown, comprehensive)
--
-- Postgres grants EXECUTE on functions to PUBLIC by default, which in Supabase
-- means both the `anon` and `authenticated` roles can reach every function via
-- /rest/v1/rpc/<name>. The Sprint 8/9 inventory RPCs carry internal
-- rma_is_manager_or_above() guards (so a guest is rejected at runtime), but
-- relying on the in-body guard alone is fragile: any future RPC that forgets
-- the guard is silently world-callable. This migration makes "not callable by
-- anon" the default posture for every client RPC.
--
-- Approach: enumerate each client-invoked RPC by name (from a grep of
-- supabase.rpc(...) calls in src/), resolve every overload via pg_proc, then
-- REVOKE ALL from PUBLIC + anon and GRANT EXECUTE to authenticated +
-- service_role. Idempotent — safe to re-run.
--
-- NOTE: the public.rma_* RLS helper functions are intentionally NOT in this
-- list. They are evaluated inside RLS policies for authenticated users and must
-- keep their default grants; anon has no table access so never triggers them.
-- ============================================================================

DO $$
DECLARE
  v_names text[] := ARRAY[
    'adjust_part_quantity',
    'adjust_stock',
    'apply_credit_note_to_invoice',
    'apply_payment_to_invoice',
    'approve_sales_order',
    'archive_warehouse',
    'cancel_sales_order',
    'convert_quotation_to_so',
    'crm_convert_lead',
    'delete_customer_cascade',
    'delete_customers_cascade',
    'generate_doc_code',
    'issue_credit_note',
    'mark_notifications_read',
    'post_invoice',
    'recalculate_stock',
    'receive_stock',
    'receive_vendor_invoice',
    'record_payment',
    'reject_sales_order',
    'restore_units',
    'rma_search_by_serial',
    'transfer_stock',
    'void_invoice'
  ];
  v_sig text;
BEGIN
  FOR v_sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(v_names)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    EXCEPTION WHEN undefined_object THEN NULL;  -- role may not exist off-Supabase
    END;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_sig);
    BEGIN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
  END LOOP;
END $$;


-- ====================================================================
-- FILE: 20260753_stock_moves_actor_from_jwt.sql
-- ====================================================================
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
