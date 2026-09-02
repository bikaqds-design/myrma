-- 20260795_uncosted_stock.sql
-- Currency engine, stage 3b — stock whose cost is unknown stops pretending.
--
-- ═══ The problem, measured ═══════════════════════════════════════════════════
--
-- From the dry run in 20260835, on live data: receiving 4 units at a real
-- landed cost of E£5,335 into a bin already holding 6 units produced an average
-- of E£2,134 — 60% below what the new goods cost. The six were there before
-- costing existed, carrying a value of zero.
--
-- Zero is not a cost. It is the absence of one. But `total_cost_base / quantity`
-- cannot tell the difference, so an unknown behaves exactly like a real cost of
-- nothing, and the margin it produces looks like profit. Stage 4 would take that
-- number and write it into the accounts as cost of goods sold.
--
-- ═══ The fix ═════════════════════════════════════════════════════════════════
--
-- Count the units whose cost is unknown, and divide by the ones that are left:
--
--   avg_cost_base = total_cost_base / (quantity - uncosted_quantity)
--
-- The average then means "what a costed unit in this bin cost", which is a true
-- statement, and it no longer moves when uncosted stock sits beside it. A bin
-- that is entirely uncosted has no average at all — NULL, not zero, so that
-- anything reading it has to decide what to do about a missing cost instead of
-- silently multiplying by nothing.
--
-- ═══ How the count is maintained ═════════════════════════════════════════════
--
-- The same way the value is, in the same trigger: when quantity moves and
-- nobody said otherwise, the uncosted SHARE of the bin is preserved. Shipping
-- 5 units from a bin of 10 that is 60% unknown removes 3 unknown and 2 costed,
-- because with a weighted average there is no way to tell which physical units
-- left, and depleting either side first would be a claim the data cannot
-- support.
--
-- ═══ Applying ════════════════════════════════════════════════════════════════
-- Paste into the Supabase SQL editor. One transaction.
-- Verify with supabase/manual/20260837_verify_uncosted_stock.sql.

-- ═══ 1. The count ════════════════════════════════════════════════════════════

ALTER TABLE public.warehouse_stock
  ADD COLUMN IF NOT EXISTS uncosted_quantity integer NOT NULL DEFAULT 0;

-- Everything that has stock and no value predates costing, so all of it is
-- unknown. This is the backfill that makes the existing dilution visible rather
-- than fixing it — the cost still has to come from somewhere.
UPDATE public.warehouse_stock
   SET uncosted_quantity = quantity
 WHERE quantity > 0 AND total_cost_base = 0 AND uncosted_quantity = 0;

ALTER TABLE public.warehouse_stock
  DROP CONSTRAINT IF EXISTS chk_uncosted_within_quantity;
ALTER TABLE public.warehouse_stock
  ADD CONSTRAINT chk_uncosted_within_quantity
    CHECK (uncosted_quantity >= 0 AND uncosted_quantity <= quantity);

COMMENT ON COLUMN public.warehouse_stock.uncosted_quantity IS
  'How many of the units on hand have no known cost. Excluded from avg_cost_base, so an unknown never behaves like a cost of zero.';

-- ═══ 2. The average now divides by the costed units ══════════════════════════
-- A generated column cannot be altered in place, so it is dropped and rebuilt.
-- It holds no data of its own — it is derived from the two columns beside it.

ALTER TABLE public.warehouse_stock DROP COLUMN IF EXISTS avg_cost_base;

ALTER TABLE public.warehouse_stock
  ADD COLUMN avg_cost_base numeric(14,4)
    GENERATED ALWAYS AS (
      CASE WHEN (quantity - uncosted_quantity) > 0
           THEN round(total_cost_base / (quantity - uncosted_quantity), 4)
           -- NULL, deliberately. Zero would be a number, and every arithmetic
           -- that touched it would silently produce an answer. NULL propagates,
           -- so a report that forgets to handle it shows a blank rather than a
           -- confident and wrong margin.
           ELSE NULL
      END
    ) STORED;

COMMENT ON COLUMN public.warehouse_stock.avg_cost_base IS
  'Weighted average cost of the COSTED units in this bin. NULL means nothing here has a known cost — it is not zero.';

-- ═══ 3. The trigger keeps both the value and the count ═══════════════════════

CREATE OR REPLACE FUNCTION public.rma_hold_unit_cost()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_costed_old integer;
  v_avg        numeric;
BEGIN
  -- Only when quantity moved and the caller stated neither a value nor a
  -- count. A caller that sets either knows something this function does not.
  IF NEW.quantity IS DISTINCT FROM OLD.quantity
     AND NEW.total_cost_base   IS NOT DISTINCT FROM OLD.total_cost_base
     AND NEW.uncosted_quantity IS NOT DISTINCT FROM OLD.uncosted_quantity
  THEN
    IF OLD.quantity > 0 THEN
      -- Preserve the unknown share. There is no way to tell which physical
      -- units left a bin held at weighted average, so depleting the known or
      -- the unknown side first would assert something the data cannot support.
      NEW.uncosted_quantity := LEAST(
        NEW.quantity,
        GREATEST(0, round(OLD.uncosted_quantity::numeric * NEW.quantity / OLD.quantity)::integer));

      v_costed_old := OLD.quantity - OLD.uncosted_quantity;
      v_avg := CASE WHEN v_costed_old > 0
                    THEN OLD.total_cost_base / v_costed_old
                    ELSE 0 END;
      NEW.total_cost_base := round(v_avg * (NEW.quantity - NEW.uncosted_quantity), 4);
    ELSE
      -- Growing from empty with no cost stated: the goods arrived through a
      -- path that never knew what they cost, so say so rather than record 0.
      NEW.uncosted_quantity := NEW.quantity;
      NEW.total_cost_base   := 0;
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

-- ═══ 4. A manual receipt has no price, and now admits it ═════════════════════
-- receive_stock takes no cost — there is no document behind it. Before this it
-- inherited the bin's average, quietly claiming the new goods cost the same as
-- whatever was already there. Signature unchanged, so the GRANTs are preserved.

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
      INSERT INTO public.warehouse_stock
        (product_id, warehouse_id, quantity, reserved_quantity, uncosted_quantity)
      VALUES (p_product_id, p_warehouse_id, p_qty, 0, p_qty)
      RETURNING id INTO v_ws_id;
    ELSE
      -- Setting uncosted_quantity explicitly keeps rma_hold_unit_cost() out of
      -- the way: these units are added as unknown rather than being assumed to
      -- cost whatever the bin already averages.
      UPDATE public.warehouse_stock
      SET quantity          = quantity + p_qty,
          uncosted_quantity = uncosted_quantity + p_qty,
          updated_at        = now()
      WHERE id = v_ws_id;
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
      -- unit_cost_base is left NULL: unknown, not free.
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

-- ═══ 5. Setting an opening cost ══════════════════════════════════════════════
-- The other half of the answer: uncosted stock has to eventually be given a
-- cost, and that is a decision a person makes from the purchase records. This
-- makes it one safe call rather than a hand-written UPDATE that could set the
-- value and forget the count.

CREATE OR REPLACE FUNCTION public.rma_set_opening_cost(
  p_product_id   uuid,
  p_warehouse_id uuid,
  p_unit_cost    numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row record;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to set stock costs' USING ERRCODE = 'P0001';
  END IF;

  IF p_unit_cost IS NULL OR p_unit_cost <= 0 THEN
    RAISE EXCEPTION
      'An opening cost must be a positive amount in base currency. Leave the stock uncosted rather than valuing it at zero — zero is a claim, and an unknown is not.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM public.warehouse_stock
   WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No stock of that product in that warehouse' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.uncosted_quantity = 0 THEN
    RAISE EXCEPTION
      'Every unit here already has a cost. Setting an opening cost would overwrite what was actually paid.'
      USING ERRCODE = 'P0001';
  END IF;

  -- The previously unknown units join the costed ones at the stated price; any
  -- units that already had a real cost keep it, and the two blend.
  UPDATE public.warehouse_stock
     SET total_cost_base   = total_cost_base + round(p_unit_cost * v_row.uncosted_quantity, 4),
         uncosted_quantity = 0,
         updated_at        = now()
   WHERE id = v_row.id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rma_set_opening_cost(uuid, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rma_set_opening_cost(uuid, uuid, numeric)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.rma_set_opening_cost(uuid, uuid, numeric) IS
  'Gives a cost to the units in one bin that have none. Sets value and clears the unknown count together, so the two cannot disagree.';

-- ═══ 6. A transfer carries the uncertainty too ═══════════════════════════════
-- transfer_stock sets the value itself, so rma_hold_unit_cost() stands aside
-- and would never touch the count. Moving value out of a partly-unknown bin
-- while leaving every uncosted unit behind would turn the source into a bin of
-- pure unknowns and give the destination a confidence it has not earned. The
-- unknown units move in proportion, for the same reason they deplete in
-- proportion: with a weighted average, nothing records which physical units
-- these are.
--
-- Body taken from 20260794 with only the count added; the system-warehouse
-- assertions, the tracking-mode branch and the reservation checks are the
-- originals.

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
  v_moved         numeric;   -- 20260794: value leaving the source, at its average
  v_unk_moved     integer;   -- 20260795: how many of those units have no known cost
  v_costed_src    integer;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to transfer stock' USING ERRCODE = 'P0001';
  END IF;

  -- ── NEW in 20260770 ──────────────────────────────────────────────────────
  PERFORM public.assert_not_system_warehouse(p_to_warehouse_id, 'destination');
  PERFORM public.assert_not_system_warehouse(p_from_warehouse_id, 'source');
  -- ─────────────────────────────────────────────────────────────────────────

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

    -- Read before the update: avg_cost_base is derived from the very columns
    -- about to change. Goods worth 500 each must arrive at the destination
    -- worth 500 each, not be silently revalued to whatever it already averages.
    --
    -- The unknown units travel too, in proportion. Moving value while leaving
    -- every uncosted unit behind would quietly convert the source into a bin of
    -- pure unknowns and hand the destination a certainty it has not got.
    v_unk_moved := LEAST(
      p_qty,
      GREATEST(0, round(COALESCE(v_src.uncosted_quantity, 0)::numeric * p_qty / v_src.quantity)::integer));
    v_costed_src := v_src.quantity - COALESCE(v_src.uncosted_quantity, 0);
    v_moved := round(
      CASE WHEN v_costed_src > 0 THEN v_src.total_cost_base / v_costed_src ELSE 0 END
      * (p_qty - v_unk_moved), 4);

    UPDATE public.warehouse_stock
    SET quantity = quantity - p_qty,
        uncosted_quantity = GREATEST(uncosted_quantity - v_unk_moved, 0),
        total_cost_base = GREATEST(total_cost_base - v_moved, 0),
        updated_at = now()
    WHERE id = v_src.id;

    SELECT id INTO v_dst_id FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_to_warehouse_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.warehouse_stock
        (product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
      VALUES (p_product_id, p_to_warehouse_id, p_qty, 0, v_moved, v_unk_moved)
      RETURNING id INTO v_dst_id;
    ELSE
      -- Setting these columns keeps rma_hold_unit_cost() out of the way, so the
      -- arriving goods blend in at their own cost rather than the destination's,
      -- and carry their own uncertainty with them.
      UPDATE public.warehouse_stock
      SET quantity = quantity + p_qty,
          total_cost_base = total_cost_base + v_moved,
          uncosted_quantity = uncosted_quantity + v_unk_moved,
          updated_at = now()
      WHERE id = v_dst_id;
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

-- ═══ Guards ══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_bad text;
BEGIN
  IF (SELECT is_generated FROM information_schema.columns
       WHERE table_schema='public' AND table_name='warehouse_stock'
         AND column_name='avg_cost_base') IS DISTINCT FROM 'ALWAYS' THEN
    RAISE EXCEPTION 'Refusing to apply: avg_cost_base came back as a writable column.';
  END IF;

  -- The whole point: a bin with stock but no costed units must report NULL,
  -- never 0. If any row shows 0 while every unit is unknown, the rebuild of the
  -- generated column did not take.
  IF EXISTS (SELECT 1 FROM public.warehouse_stock
              WHERE quantity > 0 AND uncosted_quantity = quantity
                AND avg_cost_base IS NOT NULL) THEN
    RAISE EXCEPTION 'Refusing to apply: fully uncosted stock is still reporting a numeric average.';
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('receive_stock', 'rma_set_opening_cost')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to apply: authenticated cannot execute %.', v_bad;
  END IF;

  RAISE NOTICE 'Uncosted stock is now counted separately. avg_cost_base is NULL where nothing has a known cost.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260837_verify_uncosted_stock.sql.
