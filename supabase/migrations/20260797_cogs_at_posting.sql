-- 20260797_cogs_at_posting.sql
-- Currency engine, stage 4 — what the sale cost, recorded when it ships.
--
-- ═══ Two things, because they are the same edit ══════════════════════════════
--
-- 1. BULK STOCK IS NEVER DELIVERED.
--
--    funnel_reserve_line reserves bulk stock when a sales order is approved.
--    Nothing ever delivers it. deliver_warehouse_stock and
--    release_warehouse_stock have existed since 20260741 and have NO CALLER
--    anywhere in the codebase — the only references are their own definitions,
--    a REVOKE in 20260788 whose comment calls them "primitives, called by the
--    guarded RPCs above them", and a test that calls them directly. A test that
--    invokes a function itself proves the function works, not that the
--    application uses it.
--
--    So for a bulk product: the customer is invoiced, AR goes up, and the
--    quantity never leaves the warehouse. reserved_quantity climbs on every
--    sale and never falls, until it equals quantity and no further bulk sale of
--    that product can be reserved at all. This is the same defect 20260775
--    fixed for serialised lines, still open on the bulk path.
--
-- 2. NOTHING RECORDS WHAT A SALE COST.
--
--    Stages 1-3b put a cost on the goods. This is where it is read: at posting,
--    against the stock actually being handed over.
--
-- They are one migration because post_invoice has to be rewritten either way,
-- and because COGS must be measured BEFORE the stock moves — after delivery
-- there is nothing left to measure.
--
-- ═══ Why the figure is stored, not derived ═══════════════════════════════════
--
-- cogs_base is written onto the invoice at posting and never recomputed. The
-- cost of what was sold is a fact about the day it shipped. Deriving it later
-- from a moving average would report a different profit for the same sale every
-- time stock is revalued, and last quarter's accounts would change under you.
--
-- ═══ Unknown cost is not zero cost ═══════════════════════════════════════════
--
-- cogs_unknown_qty counts units that went out with no known cost. An invoice
-- with unknown units has a cogs_base covering only part of what it shipped, so
-- its margin is an overstatement, and cogs_complete says so. Reporting must
-- lead with that flag rather than with the number.
--
-- ═══ Applying ════════════════════════════════════════════════════════════════
-- Paste into the Supabase SQL editor. One transaction.
-- Verify with supabase/manual/20260840_verify_cogs.sql.

-- ═══ 1. Where the cost of a sale is recorded ═════════════════════════════════

ALTER TABLE public.crm_invoices
  ADD COLUMN IF NOT EXISTS cogs_base numeric(12,2);

ALTER TABLE public.crm_invoices
  ADD COLUMN IF NOT EXISTS cogs_unknown_qty integer NOT NULL DEFAULT 0
    CHECK (cogs_unknown_qty >= 0);

ALTER TABLE public.crm_invoices DROP COLUMN IF EXISTS cogs_complete;
ALTER TABLE public.crm_invoices
  ADD COLUMN cogs_complete boolean
    GENERATED ALWAYS AS (cogs_base IS NOT NULL AND cogs_unknown_qty = 0) STORED;

COMMENT ON COLUMN public.crm_invoices.cogs_base IS
  'Cost of the goods this invoice shipped, in base currency, captured at posting. NULL means not posted, or voided. Never recomputed.';
COMMENT ON COLUMN public.crm_invoices.cogs_unknown_qty IS
  'Units shipped whose cost was unknown. Above zero means cogs_base covers only part of the sale and any margin from it is overstated.';
COMMENT ON COLUMN public.crm_invoices.cogs_complete IS
  'True only when every unit shipped had a known cost. Derived; margin reporting must lead with this, not with the number.';

-- ═══ 2. What an invoice's stock costs, right now ═════════════════════════════
-- Read from the reservations, which is what post_invoice is about to deliver.
-- Called by post_invoice and by the screen that previews a posting, so both
-- come from one implementation rather than two that happen to agree.

CREATE OR REPLACE FUNCTION public.rma_invoice_cogs(p_invoice_id uuid)
RETURNS TABLE (cogs_base numeric, unknown_qty integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_inv         record;
  v_ser_cost    numeric := 0;
  v_ser_unknown integer := 0;
  v_bulk_cost   numeric := 0;
  v_bulk_unknown integer := 0;
BEGIN
  -- SECURITY DEFINER, so it reads past RLS. Cost is commercially sensitive.
  IF NOT public.rma_is_staff() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_inv FROM public.crm_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id USING ERRCODE = 'P0001';
  END IF;

  IF v_inv.so_id IS NULL THEN
    RETURN QUERY SELECT 0::numeric, 0;
    RETURN;
  END IF;

  -- ── Serialised: each unit carries its own actual cost ───────────────────
  SELECT COALESCE(SUM(u.unit_cost_base), 0),
         COUNT(*) FILTER (WHERE u.unit_cost_base IS NULL)
    INTO v_ser_cost, v_ser_unknown
    FROM public.inventory_units u
   WHERE u.reserved_by_doc_type = 'sales_order'
     AND u.reserved_by_doc_id   = v_inv.so_id
     AND u.reservation_status   = 'reserved';

  -- ── Bulk: the reserved quantity per bin, at that bin's average ──────────
  -- Net reserved is computed the same way deliver_warehouse_stock computes it,
  -- so the quantity costed here is exactly the quantity about to ship.
  -- A bin whose average is NULL has no known cost, and those units are counted
  -- as unknown rather than multiplied by nothing.
  WITH reserved AS (
    SELECT sm.ref_id AS ws_id,
           SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
         - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) AS qty
      FROM public.stock_moves sm
     WHERE sm.doc_type = 'sales_order'
       AND sm.doc_id   IS NOT DISTINCT FROM v_inv.so_id
       AND sm.ref_type = 'warehouse_stock'
     GROUP BY sm.ref_id
    HAVING SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
         - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) > 0
  )
  SELECT COALESCE(SUM(r.qty * ws.avg_cost_base) FILTER (WHERE ws.avg_cost_base IS NOT NULL), 0),
         COALESCE(SUM(r.qty) FILTER (WHERE ws.avg_cost_base IS NULL), 0)::integer
    INTO v_bulk_cost, v_bulk_unknown
    FROM reserved r
    JOIN public.warehouse_stock ws ON ws.id = r.ws_id;

  RETURN QUERY SELECT
    round(COALESCE(v_ser_cost, 0) + COALESCE(v_bulk_cost, 0), 2),
    COALESCE(v_ser_unknown, 0) + COALESCE(v_bulk_unknown, 0);
END
$fn$;

REVOKE ALL ON FUNCTION public.rma_invoice_cogs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rma_invoice_cogs(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.rma_invoice_cogs(uuid) IS
  'Cost of the stock currently reserved for an invoice''s sales order, in base currency, plus how many of those units have no known cost.';

-- ═══ 3. Posting captures the cost and delivers BOTH kinds of stock ═══════════
-- Body taken verbatim from 20260775 with only the two additions; the
-- reservation precondition, the role check, the draft check and the gapless
-- code assignment are the originals.

CREATE OR REPLACE FUNCTION public.post_invoice(
  p_invoice_id  uuid,
  p_actor_email text
)
RETURNS text   -- assigned inv_code
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv       record;
  v_code      text;
  v_expected  integer;
  v_reserved  integer;
  v_cogs      numeric := 0;   -- 20260797
  v_unknown   integer := 0;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  SELECT * INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.doc_status <> 'draft' THEN
    RAISE EXCEPTION 'Invoice is already % — cannot post again', v_inv.doc_status;
  END IF;

  -- ── Precondition: the serialized stock this invoice bills must be reserved ──
  IF v_inv.so_id IS NOT NULL THEN
    -- How many serialized units do this invoice's lines actually bill for?
    SELECT COALESCE(SUM((li ->> 'qty')::numeric), 0)::integer
      INTO v_expected
    FROM jsonb_array_elements(COALESCE(v_inv.line_items, '[]'::jsonb)) AS li
    JOIN public.products p
      ON p.id = NULLIF(li ->> 'product_id', '')::uuid
    WHERE p.stock_tracking_mode = 'serialized';

    IF v_expected > 0 THEN
      -- How many are actually held for the linked SO right now?
      SELECT COUNT(*)
        INTO v_reserved
      FROM public.inventory_units
      WHERE reserved_by_doc_type = 'sales_order'
        AND reserved_by_doc_id   = v_inv.so_id
        AND reservation_status   = 'reserved';

      IF v_reserved < v_expected THEN
        RAISE EXCEPTION
          'Cannot post this invoice: it bills % serialized unit(s) but only % are reserved on sales order %. Posting would charge the customer for stock the system never hands over.',
          v_expected, v_reserved, v_inv.so_id
          USING HINT = 'Voiding a posted invoice releases its reservations. A sales order in that state cannot currently re-reserve stock from the UI — raise a new sales order for the goods still owed.';
      END IF;
    END IF;
  END IF;

  -- Assign gapless code inside this tx; rolls back if deliver_units fails below
  v_code := public.nextval_for_type('invoice');

  UPDATE public.crm_invoices
  SET
    inv_code   = v_code,
    doc_status = 'posted',
    posted_at  = NOW(),
    updated_at = NOW()
  WHERE id = p_invoice_id;

  -- ── Cost of goods sold, captured BEFORE the stock moves ──────────────────
  -- It has to be read first: delivering serialised units changes their
  -- reservation, and delivering bulk stock changes the very average the cost
  -- is read from. Afterwards there is nothing left to measure.
  --
  -- Captured on the invoice rather than computed on demand later, because the
  -- cost of what was sold is a fact about the day it shipped. Re-deriving it
  -- next quarter from a moving average would report a different profit for the
  -- same sale every time stock is revalued.
  IF v_inv.so_id IS NOT NULL THEN
    SELECT c.cogs_base, c.unknown_qty
      INTO v_cogs, v_unknown
      FROM public.rma_invoice_cogs(p_invoice_id) c;
  END IF;

  UPDATE public.crm_invoices
  SET cogs_base       = COALESCE(v_cogs, 0),
      cogs_unknown_qty = COALESCE(v_unknown, 0)
  WHERE id = p_invoice_id;

  -- Deliver inventory reserved by the linked SO — same transaction (Invariant I1)
  IF v_inv.so_id IS NOT NULL THEN
    PERFORM public.deliver_units('sales_order', v_inv.so_id, p_actor_email);

    -- 20260797: bulk stock was reserved by funnel_reserve_line when the sales
    -- order was approved and then never delivered by anything — the customer
    -- was billed and the quantity never left the warehouse, while
    -- reserved_quantity grew until no further bulk sale of that product could
    -- be reserved at all. deliver_warehouse_stock existed and had no caller
    -- anywhere in the codebase.
    PERFORM public.deliver_warehouse_stock('sales_order', v_inv.so_id, p_actor_email);
  END IF;

  RETURN v_code;
END;
$$;

-- ═══ 4. Voiding gives back bulk stock too ════════════════════════════════════
-- Body taken verbatim from 20260754 with only the restore loop and the COGS
-- reset added; the payment and credit-note preconditions are the originals.

CREATE OR REPLACE FUNCTION public.void_invoice(
  p_invoice_id  uuid,
  p_reason      text,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv      record;
  v_unit_ids uuid[];
  v_bulk     record;   -- 20260797
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to void invoices';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A void reason is required';
  END IF;

  SELECT * INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.doc_status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted invoices can be voided (current: %)', v_inv.doc_status;
  END IF;

  IF (
    SELECT COALESCE(SUM(amount_applied), 0)
    FROM public.payment_applications WHERE invoice_id = p_invoice_id
  ) > 0 THEN
    RAISE EXCEPTION 'Reverse payments before voiding';
  END IF;

  IF (
    SELECT COALESCE(SUM(amount_applied), 0)
    FROM public.credit_note_applications WHERE invoice_id = p_invoice_id
  ) > 0 THEN
    RAISE EXCEPTION 'Reverse credit notes before voiding';
  END IF;

  IF v_inv.so_id IS NOT NULL THEN
    SELECT array_agg(DISTINCT ref_id) INTO v_unit_ids
    FROM public.stock_moves
    WHERE doc_type  = 'sales_order'
      AND doc_id    = v_inv.so_id
      AND move_type = 'deliver'
      AND ref_type  = 'unit';

    IF v_unit_ids IS NOT NULL AND array_length(v_unit_ids, 1) > 0 THEN
      PERFORM public.restore_units(
        v_unit_ids, 'invoice', p_invoice_id, p_actor_email, 'available'
      );
    END IF;
  END IF;

  -- 20260797: the mirror of the delivery gap. Serialised units were restored
  -- above and bulk stock was not, so voiding an invoice for bulk goods left the
  -- quantity permanently gone from the warehouse.
  --
  -- The goods come back at the bin's CURRENT average, not at what they cost
  -- when they shipped. That is inherent to a weighted average — nothing records
  -- which physical units these were — and if the bin is now empty they return
  -- as uncosted, which is the honest answer rather than a guess.
  IF v_inv.so_id IS NOT NULL THEN
    FOR v_bulk IN
      SELECT ws.product_id, ws.warehouse_id, SUM(sm.qty)::integer AS qty
        FROM public.stock_moves sm
        JOIN public.warehouse_stock ws ON ws.id = sm.ref_id
       WHERE sm.doc_type  = 'sales_order'
         AND sm.doc_id    = v_inv.so_id
         AND sm.ref_type  = 'warehouse_stock'
         AND sm.move_type = 'deliver'
       GROUP BY ws.product_id, ws.warehouse_id
      HAVING SUM(sm.qty) > 0
    LOOP
      PERFORM public.restore_warehouse_stock(
        v_bulk.product_id, v_bulk.warehouse_id, v_bulk.qty,
        'invoice', p_invoice_id, p_actor_email);
    END LOOP;
  END IF;

  UPDATE public.crm_invoices
  SET
    doc_status     = 'cancelled',
    payment_status = 'reversed',
    void_reason    = p_reason,
    -- The sale did not happen, so there is no cost of goods sold. Leaving the
    -- figure behind would keep the voided invoice in every margin total.
    cogs_base        = NULL,
    cogs_unknown_qty = 0,
    updated_at     = NOW()
  WHERE id = p_invoice_id;
END;
$$;

-- ═══ Guards ══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_bad text;
BEGIN
  IF (SELECT is_generated FROM information_schema.columns
       WHERE table_schema='public' AND table_name='crm_invoices'
         AND column_name='cogs_complete') IS DISTINCT FROM 'ALWAYS' THEN
    RAISE EXCEPTION 'Refusing to apply: cogs_complete is not a generated column.';
  END IF;

  -- The whole point of part 1. If post_invoice still has no call to
  -- deliver_warehouse_stock, bulk stock is still never delivered.
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='post_invoice')
      NOT LIKE '%deliver_warehouse_stock%' THEN
    RAISE EXCEPTION 'Refusing to apply: post_invoice still does not deliver bulk stock.';
  END IF;

  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='void_invoice')
      NOT LIKE '%restore_warehouse_stock%' THEN
    RAISE EXCEPTION 'Refusing to apply: void_invoice still does not give bulk stock back.';
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('post_invoice', 'void_invoice', 'rma_invoice_cogs')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to apply: authenticated cannot execute %.', v_bad;
  END IF;

  RAISE NOTICE 'Bulk stock now delivers on posting and returns on void; cost of goods sold is captured at posting.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260840_verify_cogs.sql.
