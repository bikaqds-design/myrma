-- inventory_reservation: adds the two-stage stock model to existing tables.
--
-- Serialised units (inventory_units): reservation is a STATUS on each row.
--   on-hand  = COUNT(rows not in 'delivered' state)
--   reserved = COUNT(rows with reservation_status = 'reserved')
--   available = on-hand - reserved
--
-- Fungible parts (parts): reservation is a COUNTER column.
--   available = quantity - reserved_quantity
--
-- Four SECURITY DEFINER RPCs handle all stock transitions atomically and
-- write to the stock_moves ledger. Never call these RPCs from client-side
-- read-modify-write loops — always go through the API module methods.

-- ── inventory_units: add reservation columns ─────────────────────────────────
ALTER TABLE public.inventory_units
  ADD COLUMN IF NOT EXISTS reservation_status   text        NOT NULL DEFAULT 'available'
    CHECK (reservation_status IN ('available','reserved','delivered')),
  ADD COLUMN IF NOT EXISTS reserved_by_doc_type text,
  ADD COLUMN IF NOT EXISTS reserved_by_doc_id   uuid,
  ADD COLUMN IF NOT EXISTS reserved_at          timestamptz,
  ADD COLUMN IF NOT EXISTS reserved_by_email    text;

CREATE INDEX IF NOT EXISTS inv_units_reservation_idx
  ON public.inventory_units (reservation_status);
CREATE INDEX IF NOT EXISTS inv_units_reserved_by_idx
  ON public.inventory_units (reserved_by_doc_id)
  WHERE reserved_by_doc_id IS NOT NULL;

-- ── parts: add reserved_quantity counter ─────────────────────────────────────
ALTER TABLE public.parts
  ADD COLUMN IF NOT EXISTS reserved_quantity integer NOT NULL DEFAULT 0
    CHECK (reserved_quantity >= 0);

-- ── RPC: reserve_units ───────────────────────────────────────────────────────
-- Called by salesOrders.confirm() and crmInvoices.post() (direct path).
-- Selects N available units of a product FOR UPDATE SKIP LOCKED,
-- flips them to 'reserved', stamps the doc, writes stock_moves rows.
-- Raises an exception with shortfall detail if stock is insufficient.
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
    AND status NOT IN ('closed');

  IF v_available < p_qty THEN
    RAISE EXCEPTION 'Insufficient stock: need %, only % available for product %',
      p_qty, v_available, p_product_id
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_unit IN
    SELECT id FROM public.inventory_units
    WHERE product_id = p_product_id
      AND reservation_status = 'available'
      AND status NOT IN ('closed')
    ORDER BY created_at
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

-- ── RPC: release_units ───────────────────────────────────────────────────────
-- Called by salesOrders.cancel(). Releases all units reserved by the given doc.
CREATE OR REPLACE FUNCTION public.release_units(
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
  v_unit record;
BEGIN
  FOR v_unit IN
    SELECT id FROM public.inventory_units
    WHERE reserved_by_doc_type = p_doc_type
      AND reserved_by_doc_id   = p_doc_id
      AND reservation_status   = 'reserved'
    FOR UPDATE
  LOOP
    UPDATE public.inventory_units
    SET
      reservation_status   = 'available',
      reserved_by_doc_type = NULL,
      reserved_by_doc_id   = NULL,
      reserved_at          = NULL,
      reserved_by_email    = NULL
    WHERE id = v_unit.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit.id, p_doc_type, p_doc_id, 'release', 1, 'reserved', 'available', p_actor_email);
  END LOOP;
END;
$$;

-- ── RPC: deliver_units ───────────────────────────────────────────────────────
-- Called by crmInvoices.post(). Moves reserved units to 'delivered' (on-hand
-- decrements). For the direct-invoice path (no SO), also handles units still
-- in 'available' state (reserve + deliver in one step).
CREATE OR REPLACE FUNCTION public.deliver_units(
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
  v_unit record;
BEGIN
  FOR v_unit IN
    SELECT id, reservation_status FROM public.inventory_units
    WHERE reserved_by_doc_type = p_doc_type
      AND reserved_by_doc_id   = p_doc_id
      AND reservation_status   IN ('reserved', 'available')
    FOR UPDATE
  LOOP
    UPDATE public.inventory_units
    SET
      reservation_status   = 'delivered',
      reserved_by_doc_type = NULL,
      reserved_by_doc_id   = NULL,
      reserved_at          = NULL,
      reserved_by_email    = NULL
    WHERE id = v_unit.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit.id, p_doc_type, p_doc_id, 'deliver', 1,
       v_unit.reservation_status, 'delivered', p_actor_email);
  END LOOP;
END;
$$;

-- ── RPC: restore_units ───────────────────────────────────────────────────────
-- Called by creditNotes.issue() when type = 'rma_return' and restock = true.
-- Brings delivered units back to 'available'. For damaged/scrapped returns,
-- the app layer sets restock=false and calls this RPC with p_to_status='active_rma'.
CREATE OR REPLACE FUNCTION public.restore_units(
  p_unit_ids    uuid[],
  p_doc_type    text,
  p_doc_id      uuid,
  p_actor_email text,
  p_to_status   text DEFAULT 'available'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit_id uuid;
BEGIN
  FOREACH v_unit_id IN ARRAY p_unit_ids
  LOOP
    UPDATE public.inventory_units
    SET
      reservation_status = p_to_status,
      status             = CASE
                             WHEN p_to_status = 'active_rma' THEN 'active_rma'
                             ELSE status
                           END
    WHERE id = v_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit_id, p_doc_type, p_doc_id, 'restore', 1, 'delivered', p_to_status, p_actor_email);
  END LOOP;
END;
$$;

-- ── RPC: reserve_parts ───────────────────────────────────────────────────────
-- Parts use a counter model (not individual rows). Atomically increments
-- reserved_quantity; raises an exception if available < requested.
CREATE OR REPLACE FUNCTION public.reserve_parts(
  p_doc_type    text,
  p_doc_id      uuid,
  p_part_id     uuid,
  p_qty         integer,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_qty      integer;
  v_reserved integer;
BEGIN
  SELECT quantity, reserved_quantity
  INTO v_qty, v_reserved
  FROM public.parts
  WHERE id = p_part_id
  FOR UPDATE;

  IF (v_qty - v_reserved) < p_qty THEN
    RAISE EXCEPTION 'Insufficient parts: need %, only % available for part %',
      p_qty, (v_qty - v_reserved), p_part_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.parts
  SET reserved_quantity = reserved_quantity + p_qty
  WHERE id = p_part_id;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, actor_email)
  VALUES
    ('part', p_part_id, p_doc_type, p_doc_id, 'reserve', p_qty, p_actor_email);
END;
$$;

-- ── RPC: deliver_parts ───────────────────────────────────────────────────────
-- Called on invoice post: decrements quantity AND reserved_quantity together.
CREATE OR REPLACE FUNCTION public.deliver_parts(
  p_doc_type    text,
  p_doc_id      uuid,
  p_part_id     uuid,
  p_qty         integer,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.parts
  SET
    quantity          = quantity          - p_qty,
    reserved_quantity = GREATEST(reserved_quantity - p_qty, 0)
  WHERE id = p_part_id
    AND quantity >= p_qty;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot deliver % units of part % — insufficient quantity', p_qty, p_part_id
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, actor_email)
  VALUES
    ('part', p_part_id, p_doc_type, p_doc_id, 'deliver', p_qty, p_actor_email);
END;
$$;

-- ── RPC: restore_parts ───────────────────────────────────────────────────────
-- Called on credit note issue (rma_return type only).
CREATE OR REPLACE FUNCTION public.restore_parts(
  p_doc_type    text,
  p_doc_id      uuid,
  p_part_id     uuid,
  p_qty         integer,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.parts
  SET quantity = quantity + p_qty
  WHERE id = p_part_id;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, actor_email)
  VALUES
    ('part', p_part_id, p_doc_type, p_doc_id, 'restore', p_qty, p_actor_email);
END;
$$;
