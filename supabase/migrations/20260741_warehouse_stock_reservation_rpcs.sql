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
