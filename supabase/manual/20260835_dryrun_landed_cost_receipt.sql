-- 20260835_dryrun_landed_cost_receipt.sql
-- End-to-end test of landed costing against the REAL functions, on the REAL
-- database, that PERSISTS NOTHING.
--
-- ═══ How it leaves no trace ══════════════════════════════════════════════════
--
-- Everything happens inside one transaction, and the last thing the script does
-- is RAISE EXCEPTION. That aborts the transaction, so every row it created is
-- rolled back — the purchase order, the vendor invoice, the freight charge, the
-- stock it received, the stock_moves, and the document number it burned.
--
-- The exception message IS the report. Postgres prints it, and nothing is left
-- in the database. An "ERROR" here is the expected, successful ending; read the
-- numbers in it.
--
-- ═══ What it proves ══════════════════════════════════════════════════════════
--
-- Two lines of very different value on one imported invoice, with freight, of
-- which only part is received:
--
--   line A: 10 x $100 = $1,000  |  line B: 10 x $300 = $3,000
--   freight: $400, apportioned BY VALUE -> $100 to A, $300 to B
--   per unit: A +$10 -> $110    |  B +$30 -> $330
--   at 48.50:  A = E£5,335.00   |  B = E£16,005.00
--
-- Then it receives only 4 of line A, and checks that the unit cost is still
-- 5,335 — the freight share must not depend on how much of the shipment turned
-- up. Apportioning across what arrived rather than what was ordered would give
-- 100/4 = $25 per unit and a cost of E£6,062.50.
--
-- ═══ Running it ══════════════════════════════════════════════════════════════
-- Paste and run. Expect an ERROR whose message is a table of results, every
-- line reading PASS.

-- The RPCs check who is calling. auth.jwt() reads this setting, so this makes
-- the transaction run as the administrator. SET LOCAL dies with the
-- transaction, exactly like everything else here.
SET LOCAL request.jwt.claims = '{"email":"bika.qds@gmail.com","role":"authenticated"}';

DO $do$
DECLARE
  v_rate      numeric := 48.50;
  v_charges   numeric := 400;
  v_vendor    uuid;
  v_wh        uuid;
  v_prod_a    uuid;
  v_prod_b    uuid;
  v_name_a    text;
  v_name_b    text;
  v_po        uuid;
  v_vi        uuid;
  v_cost_a    numeric;
  v_cost_b    numeric;
  v_qty_before   integer := 0;
  v_value_before numeric := 0;
  v_qty_after    integer;
  v_value_after  numeric;
  v_avg_after    numeric;
  v_mode_a       text;
  v_uncosted_after integer := 0;
  v_units        integer;
  v_unit_cost    numeric;
  v_report    text := '';
  v_fails     integer := 0;

BEGIN
  -- ── Preconditions ───────────────────────────────────────────────────────
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION
      'Impersonation did not take: rma_is_manager_or_above() is false. Check that bika.qds@gmail.com is still an active manager or above in user_roles.';
  END IF;

  -- Ordered by id throughout: these picks are only choosing fixtures, and the
  -- created-timestamp column is named differently from table to table
  -- (created_date here, not created_at).
  SELECT id INTO v_vendor FROM public.brands
   WHERE brand_name ILIKE '%QA Throwaway%' LIMIT 1;
  IF v_vendor IS NULL THEN
    SELECT id INTO v_vendor FROM public.brands ORDER BY id LIMIT 1;
  END IF;

  SELECT id INTO v_wh FROM public.warehouses
   WHERE COALESCE(is_system, false) = false
   ORDER BY id LIMIT 1;
  IF v_wh IS NULL THEN
    RAISE EXCEPTION 'No ordinary (non-system) warehouse to receive into.';
  END IF;

  -- Any two products. Apportionment does not care how stock is tracked, so the
  -- first three checks work either way; only the receipt branches on it.
  -- Bulk is preferred for line A because it exercises the weighted average,
  -- which is the part with arithmetic in it — a serialised unit just carries
  -- its own cost. An earlier version demanded two BULK products and simply
  -- refused to run on this database, which tested nothing at all.
  SELECT id, product_name, stock_tracking_mode
    INTO v_prod_a, v_name_a, v_mode_a
    FROM public.products
   ORDER BY (stock_tracking_mode = 'bulk') DESC, id
   LIMIT 1;

  SELECT id, product_name INTO v_prod_b, v_name_b
    FROM public.products WHERE id <> v_prod_a ORDER BY id LIMIT 1;

  IF v_prod_a IS NULL OR v_prod_b IS NULL THEN
    RAISE EXCEPTION 'Need two products to test apportionment; found fewer.';
  END IF;

  v_report := v_report || format(
    E'
  fixtures: line A = %s (tracked: %s)
            line B = %s
',
    left(v_name_a, 34), v_mode_a, left(v_name_b, 34));

  -- ── Build the documents ─────────────────────────────────────────────────
  INSERT INTO public.purchase_orders
    (po_code, vendor_id, status, line_items, subtotal, discount_amount, tax_amount, total,
     currency, exchange_rate, created_by)
  VALUES
    ('DRYRUN-PO', v_vendor, 'confirmed',
     jsonb_build_array(
       jsonb_build_object('product_id', v_prod_a, 'product_name', v_name_a,
                          'qty_ordered', 10, 'qty_received', 0, 'unit_cost', 100),
       jsonb_build_object('product_id', v_prod_b, 'product_name', v_name_b,
                          'qty_ordered', 10, 'qty_received', 0, 'unit_cost', 300)),
     4000, 0, 0, 4000, 'USD', v_rate, 'dryrun')
  RETURNING id INTO v_po;

  INSERT INTO public.vendor_invoices
    (purchase_order_id, vendor_id, status, line_items, subtotal, discount_amount, tax_amount, total,
     currency, exchange_rate, amount_paid, payment_status, created_by)
  VALUES
    (v_po, v_vendor, 'approved',
     jsonb_build_array(
       jsonb_build_object('product_id', v_prod_a, 'product_name', v_name_a,
                          'qty_ordered', 10, 'qty_received', 0, 'unit_cost', 100),
       jsonb_build_object('product_id', v_prod_b, 'product_name', v_name_b,
                          'qty_ordered', 10, 'qty_received', 0, 'unit_cost', 300)),
     4000, 0, 0, 4000, 'USD', v_rate, 0, 'unpaid', 'dryrun')
  RETURNING id INTO v_vi;

  INSERT INTO public.vendor_invoice_charges
    (vendor_invoice_id, charge_type, description, amount, created_by)
  VALUES (v_vi, 'freight', 'dry run', v_charges, 'dryrun');

  -- ── 1. What the costing function says, before anything is received ──────
  SELECT unit_cost_base INTO v_cost_a
    FROM public.rma_vi_landed_unit_costs(v_vi) WHERE product_id = v_prod_a;
  SELECT unit_cost_base INTO v_cost_b
    FROM public.rma_vi_landed_unit_costs(v_vi) WHERE product_id = v_prod_b;

  v_report := v_report || format(
    E'\n  line A  10 x $100 + share of $400 freight, at %s\n    expected E£5335.0000   got E£%s   %s',
    v_rate, v_cost_a, CASE WHEN v_cost_a = 5335.0000 THEN 'PASS' ELSE '*** FAIL ***' END);
  IF v_cost_a <> 5335.0000 THEN v_fails := v_fails + 1; END IF;

  v_report := v_report || format(
    E'\n  line B  10 x $300 + share of $400 freight, at %s\n    expected E£16005.0000  got E£%s   %s',
    v_rate, v_cost_b, CASE WHEN v_cost_b = 16005.0000 THEN 'PASS' ELSE '*** FAIL ***' END);
  IF v_cost_b <> 16005.0000 THEN v_fails := v_fails + 1; END IF;

  -- Freight must be split by value, not by unit count. Both lines have 10
  -- units, so an even split would put $20 per unit on each and make the two
  -- costs 5820 and 15520.
  v_report := v_report || format(
    E'\n  freight split by VALUE, not by unit count\n    B-A difference expected E£10670.0000   got E£%s   %s',
    v_cost_b - v_cost_a,
    CASE WHEN v_cost_b - v_cost_a = 10670.0000 THEN 'PASS' ELSE '*** FAIL ***' END);
  IF v_cost_b - v_cost_a <> 10670.0000 THEN v_fails := v_fails + 1; END IF;

  -- ── 2. Receive PART of line A ───────────────────────────────────────────
  -- Only 4 of the 10 ordered. The freight share is spread over what was
  -- ORDERED, so the unit cost must be the same 5,335 it would be on a full
  -- delivery. Apportioning across what actually arrived would give 100/4 = $25
  -- a unit and a cost of E£6,062.50 — 13% too high, and wrong in a direction
  -- nothing downstream would question.
  IF v_mode_a = 'bulk' THEN

    SELECT quantity, total_cost_base INTO v_qty_before, v_value_before
      FROM public.warehouse_stock WHERE product_id = v_prod_a AND warehouse_id = v_wh;
    v_qty_before   := COALESCE(v_qty_before, 0);
    v_value_before := COALESCE(v_value_before, 0);

    PERFORM public.receive_vendor_invoice(
      v_vi,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_prod_a, 'warehouse_id', v_wh, 'qty', 4)),
      'dryrun');

    SELECT quantity, total_cost_base, avg_cost_base, COALESCE(uncosted_quantity, 0)
      INTO v_qty_after, v_value_after, v_avg_after, v_uncosted_after
      FROM public.warehouse_stock WHERE product_id = v_prod_a AND warehouse_id = v_wh;

    v_report := v_report || format(
      E'\n\n  received 4 of line A into bulk stock\n    quantity   %s -> %s   %s',
      v_qty_before, v_qty_after,
      CASE WHEN v_qty_after = v_qty_before + 4 THEN 'PASS' ELSE '*** FAIL ***' END);
    IF v_qty_after <> v_qty_before + 4 THEN v_fails := v_fails + 1; END IF;

    v_report := v_report || format(
      E'\n    value adds 4 x E£5335 = E£21340.0000\n      before E£%s  after E£%s  delta E£%s   %s',
      v_value_before, v_value_after, v_value_after - v_value_before,
      CASE WHEN v_value_after - v_value_before = 21340.0000 THEN 'PASS' ELSE '*** FAIL ***' END);
    IF v_value_after - v_value_before <> 21340.0000 THEN v_fails := v_fails + 1; END IF;

    v_report := v_report || format(
      E'\n\n  a partial receipt does not concentrate the freight\n    per unit of the 4 received: E£%s (must be 5335, never 6062.50)   %s',
      (v_value_after - v_value_before) / 4,
      CASE WHEN (v_value_after - v_value_before) / 4 = 5335.0000 THEN 'PASS' ELSE '*** FAIL ***' END);
    IF (v_value_after - v_value_before) / 4 <> 5335.0000 THEN v_fails := v_fails + 1; END IF;

    -- The derived average must agree with value over quantity.
    v_report := v_report || format(
      E'\n\n  avg_cost_base is derived, not stored\n    E£%s  vs  value/qty E£%s   %s',
      v_avg_after, round(v_value_after / NULLIF(v_qty_after - v_uncosted_after, 0), 4),
      v_uncosted_after, v_qty_after,
      CASE WHEN v_avg_after IS NOT DISTINCT FROM round(v_value_after / NULLIF(v_qty_after - v_uncosted_after, 0), 4)
           THEN 'PASS' ELSE '*** FAIL ***' END);
    IF v_avg_after IS DISTINCT FROM round(v_value_after / NULLIF(v_qty_after - v_uncosted_after, 0), 4) THEN v_fails := v_fails + 1; END IF;

  ELSE
    -- Serialised: every unit carries its own cost, so there is no average to
    -- check — but each of the four rows must carry exactly the landed cost.
    PERFORM public.receive_vendor_invoice(
      v_vi,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_prod_a, 'warehouse_id', v_wh,
        'serials', jsonb_build_array(
          'DRYRUN-SN-1', 'DRYRUN-SN-2', 'DRYRUN-SN-3', 'DRYRUN-SN-4'))),
      'dryrun');

    SELECT count(*), min(unit_cost_base), max(unit_cost_base)
      INTO v_units, v_unit_cost, v_avg_after
      FROM public.inventory_units WHERE vendor_invoice_id = v_vi;

    v_report := v_report || format(
      E'\n\n  received 4 of line A as serialised units\n    units created: %s   %s',
      v_units, CASE WHEN v_units = 4 THEN 'PASS' ELSE '*** FAIL ***' END);
    IF v_units <> 4 THEN v_fails := v_fails + 1; END IF;

    v_report := v_report || format(
      E'\n    every unit costed at E£5335.0000\n      min E£%s  max E£%s   %s',
      v_unit_cost, v_avg_after,
      CASE WHEN v_unit_cost = 5335.0000 AND v_avg_after = 5335.0000
           THEN 'PASS' ELSE '*** FAIL ***' END);
    IF v_unit_cost <> 5335.0000 OR v_avg_after <> 5335.0000 THEN v_fails := v_fails + 1; END IF;

    v_report := v_report || format(
      E'\n\n  a partial receipt does not concentrate the freight\n    per unit of the 4 received: E£%s (must be 5335, never 6062.50)   %s',
      v_unit_cost,
      CASE WHEN v_unit_cost = 5335.0000 THEN 'PASS' ELSE '*** FAIL ***' END);
    IF v_unit_cost <> 5335.0000 THEN v_fails := v_fails + 1; END IF;
  END IF;

  -- ── 4. Charges lock once the goods are in ───────────────────────────────
  BEGIN
    INSERT INTO public.vendor_invoice_charges
      (vendor_invoice_id, charge_type, amount, created_by)
    VALUES (v_vi, 'customs', 50, 'dryrun');
    v_report := v_report || E'\n\n  charges refused after receipt\n    *** FAIL *** the insert was ALLOWED';
    v_fails := v_fails + 1;
  EXCEPTION WHEN OTHERS THEN
    v_report := v_report || E'\n\n  charges refused after receipt\n    PASS  (' || SQLERRM || ')';
  END;

  -- ── Done: abort, so none of this survives ───────────────────────────────
  RAISE EXCEPTION E'\n\n===== LANDED COST DRY RUN =====\n%\n\n  %\n\nNothing was saved: this transaction is being rolled back on purpose.\n',
    v_report,
    CASE WHEN v_fails = 0
         THEN 'ALL CHECKS PASSED'
         ELSE v_fails || ' CHECK(S) FAILED — see above' END;
END
$do$;
