-- ############################################################################
-- #  DB TEST TIER — Inventory list views (BUG-066, phase 5)
-- #
-- #  20260854_inventory_list_views.sql moved the Inventory screen's grouping
-- #  and stock arithmetic out of the browser and into views. This file pins
-- #  what those views compute, with the rules that src/lib/stockSummary.ts and
-- #  its tests used to pin in JavaScript (that code is gone with the whole-table
-- #  loads it served):
-- #
-- #    - RMA units are never sellable, but are physically present;
-- #    - company stock splits into available / reserved / delivered;
-- #    - a delivered unit is not stock on hand: not in Main, branches,
-- #      physical total or the per-warehouse count (20260874);
-- #    - SCRAP is not physical stock; closed units count nowhere;
-- #    - a warehouse with no type, or no warehouse at all, is Main;
-- #    - branches are summed per branch; RMA units per SYSTEM location only.
-- #
-- #  Plus what the views add: bulk products, unmatched RMA rows, services left
-- #  out, All Units grouping and brand-by-name, the Stock Movements label,
-- #  bulk reservations netted per document, per-warehouse counts, and access.
-- #
-- #  Same shape as the other files: collect failures, RAISE naming each. Own
-- #  throwaway fixtures, removed at the end.
-- #
-- #  NOT in CI: the db-tests job that ran these files is disabled (it needs
-- #  Docker; see .github/workflows/ci.yml). On 2026-09-14 this block was run
-- #  against the hosted project with the cleanup replaced by an unconditional
-- #  RAISE, so the transaction rolled back and no fixture row was kept — all
-- #  10 checks passed (after correcting CHECK 1d's expected value to 11). Re-run 2026-09-17 after 20260874 (delivered units not on hand): 10 of 10. Run
-- #  it the same way after changing the views.
-- ############################################################################

DO $$
DECLARE
  v_tag        text := floor(random() * 1000000)::text;
  v_main       uuid;  v_branch uuid;  v_legacy uuid;
  v_received   uuid;  v_repair uuid;  v_scrap  uuid;
  v_brand_old  uuid;  v_brand_new uuid;
  v_ser        uuid;  v_bulk uuid;  v_svc uuid;  v_notype uuid;
  v_grp_old    uuid;  v_grp_new uuid;
  v_ws_main    uuid;  v_ws_branch uuid;  v_ws_scrap uuid;
  v_unit_sn    uuid;  v_unit_nosn uuid;
  v_doc1       uuid := gen_random_uuid();
  v_doc2       uuid := gen_random_uuid();
  v_missing    uuid := gen_random_uuid();
  v_unmatched  text;
  v_group      text;
  v_serial     text;
  r            record;
  v_n          bigint;
  v_label      text;
  v_failures   text[] := '{}';
  v_checks     int := 0;
BEGIN
  v_unmatched := 'CI Unmatched ' || v_tag;
  v_group     := 'CI Grouped ' || v_tag;
  v_serial    := 'CI-LV-SN-' || v_tag;

  -- ── Fixtures ────────────────────────────────────────────────────────────────
  SELECT id INTO v_received FROM public.warehouses WHERE code = 'RMA-RECEIVED' AND is_system;
  SELECT id INTO v_repair   FROM public.warehouses WHERE code = 'RMA-REPAIR'   AND is_system;
  SELECT id INTO v_scrap    FROM public.warehouses WHERE code = 'SCRAP'        AND is_system;

  INSERT INTO public.warehouses (name, code, warehouse_type) VALUES ('CI LV Main ' || v_tag, 'CI-LV-MAIN-' || v_tag, 'main') RETURNING id INTO v_main;
  INSERT INTO public.warehouses (name, code, warehouse_type) VALUES ('CI LV Branch ' || v_tag, 'CI-LV-BR-' || v_tag, 'branch') RETURNING id INTO v_branch;
  INSERT INTO public.warehouses (name) VALUES ('CI LV Legacy ' || v_tag) RETURNING id INTO v_legacy;

  INSERT INTO public.brands (brand_name) VALUES ('CI LV Brand Old ' || v_tag) RETURNING id INTO v_brand_old;
  INSERT INTO public.brands (brand_name) VALUES ('CI LV Brand New ' || v_tag) RETURNING id INTO v_brand_new;

  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode)
    VALUES ('CI-LV-SER-' || v_tag, 'CI LV Serialized ' || v_tag, 'hardware', 'active', 'serialized') RETURNING id INTO v_ser;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode)
    VALUES ('CI-LV-BULK-' || v_tag, 'CI LV Bulk ' || v_tag, 'hardware', 'active', 'bulk') RETURNING id INTO v_bulk;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode)
    VALUES ('CI-LV-SVC-' || v_tag, 'CI LV Service ' || v_tag, 'service', 'active', 'serialized') RETURNING id INTO v_svc;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode)
    VALUES ('CI-LV-NOTYPE-' || v_tag, 'CI LV No Type ' || v_tag, NULL, 'active', 'serialized') RETURNING id INTO v_notype;
  -- Two catalogue products share the grouped name: the older one's brand wins.
  INSERT INTO public.products (sku, product_name, product_type, status, brand_id, created_date)
    VALUES ('CI-LV-GRP-OLD-' || v_tag, v_group, 'hardware', 'active', v_brand_old, now() - interval '2 days') RETURNING id INTO v_grp_old;
  INSERT INTO public.products (sku, product_name, product_type, status, brand_id, created_date)
    VALUES ('CI-LV-GRP-NEW-' || v_tag, v_group, 'hardware', 'active', v_brand_new, now()) RETURNING id INTO v_grp_new;

  -- Serialized product units.
  INSERT INTO public.inventory_units (product_id, product_name, status, reservation_status, warehouse_id)
  SELECT v_ser, 'CI LV Serialized ' || v_tag, s, rs, w
  FROM (VALUES
    ('company_stock', 'available', v_main),
    ('company_stock', 'available', v_main),
    ('company_stock', 'reserved',  v_main),
    ('company_stock', 'delivered', v_main),
    ('company_stock', 'available', v_branch),
    ('company_stock', 'available', v_branch),
    ('company_stock', 'available', v_legacy),
    ('company_stock', 'available', NULL::uuid),
    ('company_stock', 'available', v_scrap),
    ('active_rma',    'available', v_received),
    ('active_rma',    'available', v_received),
    ('active_rma',    'available', v_repair),
    ('active_rma',    'available', v_scrap),
    ('active_rma',    'available', v_main),
    ('closed',        'available', v_main)
  ) AS x(s, rs, w);

  -- Unmatched RMA units: one at a system location, one unplaced.
  INSERT INTO public.inventory_units (product_id, product_name, status, reservation_status, warehouse_id) VALUES
    (NULL, v_unmatched, 'active_rma', 'available', v_received),
    (NULL, v_unmatched, 'active_rma', 'available', NULL);

  -- All Units grouping fixtures.
  INSERT INTO public.inventory_units (product_name, status, resolution_type, warehouse_id) VALUES
    (v_group, 'company_stock', 'replacement', v_main),
    (v_group, 'company_stock', 'credit_note', v_main),
    (v_group, 'company_stock', NULL, v_main),
    (v_group, 'active_rma', NULL, v_received),
    (v_group, 'sent_to_manufacturer', NULL, NULL),
    (v_group, 'closed', NULL, NULL);

  -- Bulk stock rows.
  INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity) VALUES (v_bulk, v_main, 10, 3) RETURNING id INTO v_ws_main;
  INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity) VALUES (v_bulk, v_branch, 5, 0) RETURNING id INTO v_ws_branch;
  INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity) VALUES (v_bulk, v_scrap, 2, 0) RETURNING id INTO v_ws_scrap;

  -- Movement ledger fixtures.
  INSERT INTO public.inventory_units (product_id, product_name, serial_number, status, warehouse_id)
    VALUES (v_notype, 'CI LV Labelled', v_serial, 'company_stock', v_main) RETURNING id INTO v_unit_sn;
  INSERT INTO public.inventory_units (product_id, product_name, status, warehouse_id)
    VALUES (v_notype, 'CI LV Unlabelled', 'company_stock', v_main) RETURNING id INTO v_unit_nosn;

  INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, actor_email) VALUES
    ('unit', v_unit_sn,   'manual', NULL, 'adjust', 1, 'ci@test.com'),
    ('unit', v_unit_nosn, 'manual', NULL, 'adjust', 1, 'ci@test.com'),
    ('unit', v_missing,   'manual', NULL, 'adjust', 1, 'ci@test.com'),
    ('warehouse_stock', v_ws_main, 'sales_order', v_doc1, 'reserve', 3, 'ci@test.com'),
    ('warehouse_stock', v_ws_main, 'sales_order', v_doc1, 'release', 1, 'ci@test.com'),
    ('warehouse_stock', v_ws_main, 'sales_order', v_doc2, 'reserve', 2, 'ci@test.com'),
    ('warehouse_stock', v_ws_main, 'sales_order', v_doc2, 'deliver', 2, 'ci@test.com');

  -- ── CHECK 1: serialized product — the stockSummary rules ────────────────────
  v_checks := v_checks + 1;
  SELECT * INTO r FROM public.v_product_stock_summary WHERE product_id = v_ser::text;
  IF r IS NULL THEN
    v_failures := array_append(v_failures, 'CHECK 1: serialized product has no summary row');
  ELSE
    -- Available is company stock only: 2 main + 2 branch + legacy + unplaced + scrap = 7.
    -- The RMA units read 'available' too and must not be counted.
    IF r.available <> 7 THEN v_failures := array_append(v_failures, format('CHECK 1a: available %s, expected 7 (RMA units must not be sellable)', r.available)); END IF;
    IF r.reserved <> 1 OR r.delivered <> 1 THEN v_failures := array_append(v_failures, format('CHECK 1b: reserved/delivered %s/%s, expected 1/1', r.reserved, r.delivered)); END IF;
    -- Main: 3 on hand in the main warehouse (the delivered one is not, 20260874)
    -- + the untyped warehouse + the unit with no warehouse.
    IF r.main_qty <> 5 THEN v_failures := array_append(v_failures, format('CHECK 1c: main_qty %s, expected 5 (a delivered unit is not on hand)', r.main_qty)); END IF;
    -- Physical: the 7 on-hand company-stock units outside SCRAP (the delivered
    -- one excluded, 20260874) + the 3 RMA units at
    -- non-SCRAP system locations. Not the RMA unit parked in a normal
    -- warehouse, nothing in SCRAP, nothing closed.
    IF r.physical_total <> 10 THEN v_failures := array_append(v_failures, format('CHECK 1d: physical_total %s, expected 10', r.physical_total)); END IF;
    IF r.branches <> jsonb_build_array(jsonb_build_object('warehouse_id', v_branch, 'name', 'CI LV Branch ' || v_tag, 'code', 'CI-LV-BR-' || v_tag, 'qty', 2))
       OR r.branch_total <> 2 THEN
      v_failures := array_append(v_failures, format('CHECK 1e: branches %s / %s, expected the one branch with 2', r.branches, r.branch_total));
    END IF;
    -- RMA per system location, SCRAP included in the breakdown; the unit in a normal warehouse is not at an RMA stage.
    SELECT coalesce(sum((e->>'count')::int), 0) INTO v_n FROM jsonb_array_elements(r.rma) e;
    IF r.rma_total <> 4 OR v_n <> 4 OR jsonb_array_length(r.rma) <> 3 THEN
      v_failures := array_append(v_failures, format('CHECK 1f: rma %s (total %s), expected RECEIVED 2, REPAIR 1, SCRAP 1', r.rma, r.rma_total));
    END IF;
    IF NOT r.in_catalog OR r.stock_tracking_mode <> 'serialized' THEN
      v_failures := array_append(v_failures, 'CHECK 1g: serialized row flags wrong');
    END IF;
  END IF;

  -- ── CHECK 2: bulk product ────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  SELECT * INTO r FROM public.v_product_stock_summary WHERE product_id = v_bulk::text;
  IF r IS NULL THEN
    v_failures := array_append(v_failures, 'CHECK 2: bulk product has no summary row');
  ELSIF r.available <> 14 OR r.reserved <> 3 OR r.delivered <> 0 OR r.main_qty <> 10
     OR r.physical_total <> 15 OR r.branch_total <> 5 OR r.rma <> '[]'::jsonb OR r.rma_total <> 0
     OR r.stock_tracking_mode <> 'bulk' THEN
    v_failures := array_append(v_failures, format(
      'CHECK 2: bulk row available=%s reserved=%s delivered=%s main=%s physical=%s branches=%s rma=%s, expected 14/3/0/10/15/5/[]',
      r.available, r.reserved, r.delivered, r.main_qty, r.physical_total, r.branch_total, r.rma));
  END IF;

  -- ── CHECK 3: services are left out; a product with no type is not a service ─
  v_checks := v_checks + 1;
  IF EXISTS (SELECT 1 FROM public.v_product_stock_summary WHERE product_id = v_svc::text) THEN
    v_failures := array_append(v_failures, 'CHECK 3a: a service product appears on the stock dashboard');
  END IF;
  SELECT * INTO r FROM public.v_product_stock_summary WHERE product_id = v_notype::text;
  IF r IS NULL THEN
    v_failures := array_append(v_failures, 'CHECK 3b: a product with no type is missing from the dashboard');
  ELSIF r.available <> 2 OR r.physical_total <> 2 THEN
    v_failures := array_append(v_failures, format('CHECK 3b: no-type product available/physical %s/%s, expected 2/2', r.available, r.physical_total));
  END IF;

  -- ── CHECK 4: unmatched RMA units ─────────────────────────────────────────────
  v_checks := v_checks + 1;
  SELECT * INTO r FROM public.v_product_stock_summary WHERE product_id = 'unmatched:' || v_unmatched;
  IF r IS NULL THEN
    v_failures := array_append(v_failures, 'CHECK 4: unmatched RMA units have no row');
  ELSIF r.in_catalog OR r.available <> 0 OR r.main_qty <> 0 OR r.branch_total <> 0
     OR r.rma_total <> 1 OR r.physical_total <> 1 OR jsonb_array_length(r.rma) <> 1 THEN
    -- The unplaced unit is not at a real RMA stage: counted nowhere.
    v_failures := array_append(v_failures, format('CHECK 4: unmatched row %s, expected RMA 1 at RMA-RECEIVED only', row_to_json(r)));
  END IF;

  -- ── CHECK 5: All Units grouping ──────────────────────────────────────────────
  v_checks := v_checks + 1;
  SELECT * INTO r FROM public.v_inventory_product_groups WHERE product_name = v_group;
  IF r IS NULL THEN
    v_failures := array_append(v_failures, 'CHECK 5: grouped product has no row');
  ELSIF r.total <> 6 OR r.company_stock <> 3 OR r.active_rma <> 1 OR r.sent_to_manufacturer <> 1 OR r.closed <> 1
     OR r.replacement <> 1 OR r.credit_note <> 2 THEN
    -- credit_note is every company-stock unit that is not a replacement, including no resolution.
    v_failures := array_append(v_failures, format('CHECK 5a: group counts %s', row_to_json(r)));
  ELSIF r.brand <> 'CI LV Brand Old ' || v_tag THEN
    v_failures := array_append(v_failures, format('CHECK 5b: brand %s, expected the OLDEST product''s brand', r.brand));
  END IF;
  IF (SELECT coalesce(sum(total), 0) FROM public.v_inventory_product_groups) <> (SELECT count(*) FROM public.inventory_units) THEN
    v_failures := array_append(v_failures, 'CHECK 5c: group totals do not add up to the unit count');
  END IF;

  -- ── CHECK 6: v_inventory_units carries the brand and grouping key ────────────
  v_checks := v_checks + 1;
  IF (SELECT count(*) FROM public.v_inventory_units WHERE group_name = v_group AND brand_name = 'CI LV Brand Old ' || v_tag) <> 6 THEN
    v_failures := array_append(v_failures, 'CHECK 6: v_inventory_units brand/group_name wrong for the grouped units');
  END IF;

  -- ── CHECK 7: Stock Movements labels ──────────────────────────────────────────
  v_checks := v_checks + 1;
  SELECT ref_label INTO v_label FROM public.v_stock_moves_listing WHERE ref_id = v_unit_sn;
  IF v_label IS DISTINCT FROM 'CI LV Labelled (' || v_serial || ')' THEN
    v_failures := array_append(v_failures, format('CHECK 7a: unit label %s', v_label));
  END IF;
  SELECT ref_label INTO v_label FROM public.v_stock_moves_listing WHERE ref_id = v_unit_nosn;
  IF v_label IS DISTINCT FROM 'CI LV Unlabelled' THEN
    v_failures := array_append(v_failures, format('CHECK 7b: unit-without-serial label %s', v_label));
  END IF;
  SELECT ref_label INTO v_label FROM public.v_stock_moves_listing WHERE ref_id = v_ws_main LIMIT 1;
  IF v_label IS DISTINCT FROM 'CI LV Bulk ' || v_tag || ' @ CI LV Main ' || v_tag THEN
    v_failures := array_append(v_failures, format('CHECK 7c: stock-row label %s', v_label));
  END IF;
  SELECT ref_label INTO v_label FROM public.v_stock_moves_listing WHERE ref_id = v_missing;
  IF v_label IS DISTINCT FROM v_missing::text THEN
    v_failures := array_append(v_failures, format('CHECK 7d: label for a vanished unit %s, expected its id', v_label));
  END IF;

  -- ── CHECK 8: bulk reservations netted per document ───────────────────────────
  v_checks := v_checks + 1;
  IF (SELECT qty FROM public.v_bulk_stock_reservations WHERE product_id = v_bulk AND doc_id = v_doc1) IS DISTINCT FROM 2 THEN
    v_failures := array_append(v_failures, 'CHECK 8a: reserve 3 then release 1 should leave 2 reserved');
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_bulk_stock_reservations WHERE doc_id = v_doc2) THEN
    v_failures := array_append(v_failures, 'CHECK 8b: a fully delivered reservation is still listed');
  END IF;

  -- ── CHECK 9: per-warehouse counts ────────────────────────────────────────────
  v_checks := v_checks + 1;
  -- The main warehouse holds 11 fixture units: 4 company stock of the serialized
  -- product (one delivered), 1 RMA, 1 closed, 3 grouped, 2 labelled. The
  -- delivered unit has left the building (20260874), so 10.
  IF (SELECT unit_count FROM public.v_warehouse_unit_counts WHERE warehouse_id = v_main) IS DISTINCT FROM 10 THEN
    v_failures := array_append(v_failures, format('CHECK 9: main warehouse unit count %s, expected 10 (the delivered unit excluded)',
      (SELECT unit_count FROM public.v_warehouse_unit_counts WHERE warehouse_id = v_main)));
  END IF;

  -- ── CHECK 10: access — invoker rights, no anon ───────────────────────────────
  v_checks := v_checks + 1;
  FOR r IN
    SELECT c.relname, c.reloptions
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('v_inventory_units', 'v_inventory_product_groups', 'v_product_stock_summary',
                         'v_stock_moves_listing', 'v_bulk_stock_reservations', 'v_warehouse_unit_counts')
  LOOP
    IF NOT coalesce('security_invoker=true' = ANY (r.reloptions), false) THEN
      v_failures := array_append(v_failures, format('CHECK 10a: %s is not security_invoker — it would bypass RLS', r.relname));
    END IF;
    IF has_table_privilege('anon', 'public.' || r.relname, 'SELECT') THEN
      v_failures := array_append(v_failures, format('CHECK 10b: anon can read %s', r.relname));
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.' || r.relname, 'SELECT') THEN
      v_failures := array_append(v_failures, format('CHECK 10c: authenticated cannot read %s', r.relname));
    END IF;
  END LOOP;

  -- ── Cleanup ─────────────────────────────────────────────────────────────────
  DELETE FROM public.stock_moves WHERE ref_id IN (v_unit_sn, v_unit_nosn, v_missing, v_ws_main, v_ws_branch, v_ws_scrap);
  DELETE FROM public.warehouse_stock WHERE product_id = v_bulk;
  DELETE FROM public.inventory_units
   WHERE product_id IN (v_ser, v_notype) OR product_name IN (v_unmatched, v_group);
  DELETE FROM public.products WHERE id IN (v_ser, v_bulk, v_svc, v_notype, v_grp_old, v_grp_new);
  DELETE FROM public.brands WHERE id IN (v_brand_old, v_brand_new);
  DELETE FROM public.warehouses WHERE id IN (v_main, v_branch, v_legacy);

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % inventory-list-view check(s) FAILED:\n%',
      array_length(v_failures, 1), v_checks, array_to_string(v_failures, E'\n');
  END IF;

  RAISE NOTICE 'All % inventory-list-view checks passed', v_checks;
END $$;
