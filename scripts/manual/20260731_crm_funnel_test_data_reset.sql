-- ═══════════════════════════════════════════════════════════════════════════
--  Manual test-data utility — NOT part of normal deployment history.
--
--  Wipes all Lead / Deal / Activity / Quotation / Sales Order / Invoice rows
--  and re-seeds a fresh, internally-consistent funnel using EXISTING
--  customers, products, and users (none of those three tables are touched).
--
--  Run this manually in the Supabase SQL Editor only when you want a clean
--  test baseline. Do NOT include it in an automated migration pipeline.
--
--  Seeded volumes (per the explicit ask):
--    30 leads   — random source/status across the full enum
--    50 deals   — random stage across the full Sales Pipeline (incl. won/lost)
--    25 quotations — 20 convert to a Sales Order (status='converted'),
--                    5 stay at one each of draft/sent/accepted/declined/expired
--    20 sales orders (from 20 of the 25 quotations) — 15 reach 'delivered'
--                    (eligible to invoice), 5 stay at one each of
--                    draft/sent/accepted/confirmed/cancelled
--    15 invoices (from the 15 'delivered' sales orders) — 3 draft, 2 cancelled,
--                    10 posted (4 unpaid / 3 partial / 3 paid), with due_date
--                    deliberately spread across the AR Aging buckets
--                    (Current / 31-60 / 61-90 / 90+) for Accounting v1 testing
--
--  Does NOT touch credit_notes or payments tables themselves (not in the
--  requested scope) — only deletes payment_applications rows that reference
--  the invoices being wiped, since that join table has an ON DELETE RESTRICT
--  FK to crm_invoices.id and would otherwise block the invoice deletion.
--  Any credit_notes that referenced a deleted invoice get source_invoice_id
--  set to NULL automatically (ON DELETE SET NULL) — they are not deleted.
--
--  Also resets inventory reservation state (inventory_units.reservation_status,
--  parts.reserved_quantity) back to a clean baseline, since the SO/Invoice
--  rows being deleted may have reserved/delivered real stock and those
--  tables are not FK-linked for cascade. stock_moves (append-only audit
--  ledger) is intentionally left untouched.
--
--  The new seeded Quotations/Sales Orders/Invoices are inserted as
--  historical-looking rows directly — this script does NOT call the real
--  reserve_units()/deliver_units() RPCs, so on-hand/reserved inventory counts
--  will not reflect these fake orders.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Reset ─────────────────────────────────────────────────────────────────

DELETE FROM public.payment_applications
WHERE invoice_id IN (SELECT id FROM public.crm_invoices);

DELETE FROM public.crm_invoices;
DELETE FROM public.sales_orders;
DELETE FROM public.quotations;
DELETE FROM public.activities;
DELETE FROM public.leads;   -- before deals: leads.converted_deal_id references deals(id)
DELETE FROM public.deals;

UPDATE public.inventory_units
SET reservation_status = 'available',
    reserved_by_doc_type = NULL,
    reserved_by_doc_id = NULL,
    reserved_at = NULL,
    reserved_by_email = NULL
WHERE reservation_status <> 'available' OR reserved_by_doc_id IS NOT NULL;

UPDATE public.parts
SET reserved_quantity = 0
WHERE reserved_quantity <> 0;


-- ── 2. Seed ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  -- Reference pools (existing data only — customers/products/users untouched)
  v_pipeline_id   uuid;
  v_customer_ids  uuid[];
  v_product_ids   uuid[];
  v_product_names text[];
  v_rep_emails    text[];

  -- Static enums
  v_lead_sources    text[] := ARRAY['walk-in','phone','referral','exhibition','website','whatsapp'];
  v_lead_statuses   text[] := ARRAY['new','contacted','qualified','nurturing','inactive','converted','disqualified'];
  v_deal_stages     text[] := ARRAY['new_lead','contacted','needs_assessment','quote_sent','negotiation','won','lost'];
  v_deal_probs      int[]  := ARRAY[10,20,40,60,75,100,0];
  v_deal_statuses   text[] := ARRAY['open','open','open','open','open','won','lost'];
  v_qt_other_status text[] := ARRAY['draft','sent','accepted','declined','expired'];
  v_so_other_status text[] := ARRAY['draft','sent','accepted','confirmed','cancelled'];

  -- Per-invoice due-date offset in days from today (negative = overdue, positive = not yet due).
  -- m1-5 (draft/cancelled) and m13-15 (paid) are excluded from the Aging report regardless,
  -- so only m6-9 (unpaid) and m10-12 (partial) are tuned to hit each bucket on purpose:
  -- m6/m10 -> Current, m7/m11 -> 31-60, m8/m12 -> 61-90, m9 -> 90+.
  v_inv_due_offsets int[] := ARRAY[20, 25, 15, -18, -22, -10, -40, -75, -110, 15, -45, -80, 10, -5, 20];

  -- Loop vars
  i int; j int; k int; m int;
  v_customer_id  uuid;
  v_rep          text;
  v_status       text;
  v_stage_idx    int;
  v_lines        jsonb;
  v_subtotal     numeric;
  v_qty          int;
  v_unit_price   numeric;
  v_line_count   int;
  v_prod_idx     int;
  v_code         text;
  v_new_id       uuid;
  v_due_offset   int;

  -- Quotation tracking (25 created; first 20 become Sales Orders)
  v_qt_ids        uuid[]  := '{}';
  v_qt_customers  uuid[]  := '{}';
  v_qt_reps       text[]  := '{}';
  v_qt_lines      jsonb[] := '{}';
  v_qt_subtotals  numeric[] := '{}';

  -- Sales Order tracking (20 created; first 15 become Invoices)
  v_so_ids        uuid[]  := '{}';
  v_so_customers  uuid[]  := '{}';
  v_so_reps       text[]  := '{}';
  v_so_lines      jsonb[] := '{}';
  v_so_subtotals  numeric[] := '{}';
BEGIN
  SELECT array_agg(id) INTO v_customer_ids FROM public.customers;
  SELECT array_agg(id), array_agg(product_name) INTO v_product_ids, v_product_names FROM public.products;
  SELECT array_agg(user_email) INTO v_rep_emails FROM public.user_roles;
  SELECT id INTO v_pipeline_id FROM public.pipelines ORDER BY created_at LIMIT 1;

  IF v_customer_ids IS NULL OR array_length(v_customer_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No customers found — seed at least one customer before running this script';
  END IF;
  IF v_product_ids IS NULL OR array_length(v_product_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No products found — seed at least one product before running this script';
  END IF;
  IF v_rep_emails IS NULL OR array_length(v_rep_emails, 1) IS NULL THEN
    RAISE EXCEPTION 'No users found in user_roles — seed at least one user before running this script';
  END IF;
  IF v_pipeline_id IS NULL THEN
    RAISE EXCEPTION 'No pipeline found — pipelines table is empty';
  END IF;

  -- ── 30 Leads ────────────────────────────────────────────────────────────
  FOR i IN 1..30 LOOP
    v_rep := v_rep_emails[1 + floor(random() * array_length(v_rep_emails, 1))::int];
    v_customer_id := v_customer_ids[1 + floor(random() * array_length(v_customer_ids, 1))::int];
    v_status := v_lead_statuses[1 + floor(random() * array_length(v_lead_statuses, 1))::int];

    INSERT INTO public.leads (
      full_name, company_name, phone, email, source, status,
      assigned_rep, notes, lead_code, created_by, created_at,
      converted_at, converted_customer_id
    ) VALUES (
      'Test Lead ' || i,
      CASE WHEN i % 3 = 0 THEN 'Test Company ' || i ELSE NULL END,
      '+9665' || lpad((10000000 + floor(random() * 89999999))::bigint::text, 8, '0'),
      'testlead' || i || '@example.com',
      v_lead_sources[1 + floor(random() * array_length(v_lead_sources, 1))::int],
      v_status,
      v_rep,
      'Seeded test lead #' || i,
      'LD-' || (10000000 + floor(random() * 89999999))::bigint::text,
      v_rep,
      now() - (floor(random() * 90) * interval '1 day'),
      CASE WHEN v_status = 'converted' THEN now() - (floor(random() * 30) * interval '1 day') ELSE NULL END,
      CASE WHEN v_status = 'converted' THEN v_customer_id ELSE NULL END
    );
  END LOOP;

  -- ── 50 Deals ────────────────────────────────────────────────────────────
  FOR i IN 1..50 LOOP
    v_rep := v_rep_emails[1 + floor(random() * array_length(v_rep_emails, 1))::int];
    v_customer_id := v_customer_ids[1 + floor(random() * array_length(v_customer_ids, 1))::int];
    v_stage_idx := 1 + floor(random() * array_length(v_deal_stages, 1))::int;

    INSERT INTO public.deals (
      title, customer_id, pipeline_id, stage, value, probability,
      assigned_rep, status, deal_code, lost_reason, won_at, lost_at,
      notes, created_by, created_at
    ) VALUES (
      'Test Deal ' || i,
      v_customer_id,
      v_pipeline_id,
      v_deal_stages[v_stage_idx],
      round((5000 + random() * 95000)::numeric, 2),
      v_deal_probs[v_stage_idx],
      v_rep,
      v_deal_statuses[v_stage_idx],
      'OPP-' || (10000000 + floor(random() * 89999999))::bigint::text,
      CASE WHEN v_deal_stages[v_stage_idx] = 'lost'
        THEN (ARRAY['Price too high','Chose competitor','Budget cut','No response','Project cancelled'])[1 + floor(random() * 5)]
        ELSE NULL END,
      CASE WHEN v_deal_stages[v_stage_idx] = 'won' THEN now() - (floor(random() * 60) * interval '1 day') ELSE NULL END,
      CASE WHEN v_deal_stages[v_stage_idx] = 'lost' THEN now() - (floor(random() * 60) * interval '1 day') ELSE NULL END,
      'Seeded test deal #' || i,
      v_rep,
      now() - (floor(random() * 120) * interval '1 day')
    );
  END LOOP;

  -- ── 25 Quotations (1..20 will convert to a Sales Order) ────────────────
  FOR i IN 1..25 LOOP
    v_rep := v_rep_emails[1 + floor(random() * array_length(v_rep_emails, 1))::int];
    v_customer_id := v_customer_ids[1 + floor(random() * array_length(v_customer_ids, 1))::int];

    v_lines := '[]'::jsonb;
    v_subtotal := 0;
    v_line_count := 1 + floor(random() * 3)::int;
    FOR j IN 1..v_line_count LOOP
      v_prod_idx := 1 + floor(random() * array_length(v_product_ids, 1))::int;
      v_qty := 1 + floor(random() * 5)::int;
      v_unit_price := round((100 + random() * 4900)::numeric, 2);
      v_lines := v_lines || jsonb_build_object(
        'product_id', v_product_ids[v_prod_idx],
        'product_name', v_product_names[v_prod_idx],
        'qty', v_qty,
        'unit_price', v_unit_price,
        'discount_pct', NULL,
        'tax_pct', NULL
      );
      v_subtotal := v_subtotal + (v_qty * v_unit_price);
    END LOOP;

    v_status := CASE WHEN i <= 20 THEN 'converted' ELSE v_qt_other_status[i - 20] END;
    v_new_id := gen_random_uuid();

    INSERT INTO public.quotations (
      id, qt_code, deal_id, customer_id, status, line_items,
      subtotal, discount_amount, tax_amount, total,
      validity_until, payment_terms, reference_po, notes,
      assigned_rep, created_by, created_at, updated_at
    ) VALUES (
      v_new_id,
      'QT-' || (10000000 + floor(random() * 89999999))::bigint::text,
      NULL,
      v_customer_id,
      v_status,
      v_lines,
      round(v_subtotal, 2), 0, round(v_subtotal * 0.15, 2), round(v_subtotal * 1.15, 2),
      (now() + interval '30 days')::date,
      '30 days net',
      'PO-' || (1000 + i),
      'Seeded test quotation #' || i,
      v_rep, v_rep,
      now() - (floor(random() * 60) * interval '1 day'), now()
    );

    IF i <= 20 THEN
      v_qt_ids       := v_qt_ids       || v_new_id;
      v_qt_customers := v_qt_customers || v_customer_id;
      v_qt_reps      := v_qt_reps      || v_rep;
      v_qt_lines     := v_qt_lines     || v_lines;
      v_qt_subtotals := v_qt_subtotals || round(v_subtotal, 2);
    END IF;
  END LOOP;

  -- ── 20 Sales Orders, from the 20 converted Quotations (1..15 reach 'delivered') ──
  FOR k IN 1..20 LOOP
    v_status := CASE WHEN k <= 15 THEN 'delivered' ELSE v_so_other_status[k - 15] END;
    v_new_id := gen_random_uuid();

    INSERT INTO public.sales_orders (
      id, so_code, quotation_id, customer_id, status, line_items,
      subtotal, discount_amount, tax_amount, total,
      delivery_date, payment_terms, reference_po, notes,
      assigned_rep, created_by, created_at, updated_at,
      confirmed_at, delivered_at
    ) VALUES (
      v_new_id,
      'SO-' || (10000000 + floor(random() * 89999999))::bigint::text,
      v_qt_ids[k],
      v_qt_customers[k],
      v_status,
      v_qt_lines[k],
      v_qt_subtotals[k], 0, round(v_qt_subtotals[k] * 0.15, 2), round(v_qt_subtotals[k] * 1.15, 2),
      (now() - interval '5 days')::date,
      '30 days net',
      'PO-' || (2000 + k),
      'Seeded test sales order #' || k,
      v_qt_reps[k], v_qt_reps[k],
      now() - (floor(random() * 45) * interval '1 day'), now(),
      CASE WHEN v_status IN ('confirmed', 'delivered') THEN now() - (floor(20 + random() * 20) * interval '1 day') ELSE NULL END,
      CASE WHEN v_status = 'delivered' THEN now() - (floor(random() * 15) * interval '1 day') ELSE NULL END
    );

    IF k <= 15 THEN
      v_so_ids       := v_so_ids       || v_new_id;
      v_so_customers := v_so_customers || v_qt_customers[k];
      v_so_reps      := v_so_reps      || v_qt_reps[k];
      v_so_lines     := v_so_lines     || v_qt_lines[k];
      v_so_subtotals := v_so_subtotals || v_qt_subtotals[k];
    END IF;
  END LOOP;

  -- ── 15 Invoices, from the 15 'delivered' Sales Orders ──────────────────
  -- m 1-3: draft · m 4-5: cancelled · m 6-15: posted (4 unpaid / 3 partial / 3 paid)
  FOR m IN 1..15 LOOP
    v_code := NULL;
    v_due_offset := v_inv_due_offsets[m];

    IF m <= 3 THEN
      -- draft
      INSERT INTO public.crm_invoices (
        id, inv_code, so_id, customer_id, doc_status, payment_status, line_items,
        subtotal, discount_amount, tax_amount, total, amount_paid,
        due_date, payment_terms, reference_po, notes, void_reason,
        assigned_rep, created_by, created_at, updated_at, posted_at, paid_at
      ) VALUES (
        gen_random_uuid(), NULL, v_so_ids[m], v_so_customers[m], 'draft', 'unpaid', v_so_lines[m],
        v_so_subtotals[m], 0, round(v_so_subtotals[m] * 0.15, 2), round(v_so_subtotals[m] * 1.15, 2), 0,
        (now() + (v_due_offset * interval '1 day'))::date, '30 days net', 'PO-' || (3000 + m),
        'Seeded test invoice #' || m, NULL,
        v_so_reps[m], v_so_reps[m], now() - interval '5 days', now(), NULL, NULL
      );

    ELSIF m <= 5 THEN
      -- cancelled (must have been posted first — assign a code)
      SELECT public.nextval_for_type('invoice') INTO v_code;
      INSERT INTO public.crm_invoices (
        id, inv_code, so_id, customer_id, doc_status, payment_status, line_items,
        subtotal, discount_amount, tax_amount, total, amount_paid,
        due_date, payment_terms, reference_po, notes, void_reason,
        assigned_rep, created_by, created_at, updated_at, posted_at, paid_at
      ) VALUES (
        gen_random_uuid(), v_code, v_so_ids[m], v_so_customers[m], 'cancelled', 'reversed', v_so_lines[m],
        v_so_subtotals[m], 0, round(v_so_subtotals[m] * 0.15, 2), round(v_so_subtotals[m] * 1.15, 2), 0,
        (now() + (v_due_offset * interval '1 day'))::date, '30 days net', 'PO-' || (3000 + m),
        'Seeded test invoice #' || m, 'Seeded test cancellation',
        v_so_reps[m], v_so_reps[m], now() - interval '20 days', now(),
        now() - interval '18 days', NULL
      );

    ELSE
      -- posted: m 6-9 unpaid, m 10-12 partial, m 13-15 paid
      SELECT public.nextval_for_type('invoice') INTO v_code;
      INSERT INTO public.crm_invoices (
        id, inv_code, so_id, customer_id, doc_status, payment_status, line_items,
        subtotal, discount_amount, tax_amount, total, amount_paid,
        due_date, payment_terms, reference_po, notes, void_reason,
        assigned_rep, created_by, created_at, updated_at, posted_at, paid_at
      ) VALUES (
        gen_random_uuid(), v_code, v_so_ids[m], v_so_customers[m], 'posted',
        CASE WHEN m <= 9 THEN 'unpaid' WHEN m <= 12 THEN 'partial' ELSE 'paid' END,
        v_so_lines[m],
        v_so_subtotals[m], 0, round(v_so_subtotals[m] * 0.15, 2), round(v_so_subtotals[m] * 1.15, 2),
        CASE WHEN m <= 9 THEN 0
             WHEN m <= 12 THEN round(v_so_subtotals[m] * 1.15 * 0.4, 2)
             ELSE round(v_so_subtotals[m] * 1.15, 2) END,
        (now() + (v_due_offset * interval '1 day'))::date, '30 days net', 'PO-' || (3000 + m),
        'Seeded test invoice #' || m, NULL,
        v_so_reps[m], v_so_reps[m], now() - interval '25 days', now(),
        now() - interval '22 days',
        CASE WHEN m > 12 THEN now() - interval '2 days' ELSE NULL END
      );
    END IF;
  END LOOP;

  RAISE NOTICE 'Seed complete: 30 leads, 50 deals, 25 quotations (20 converted), 20 sales orders (15 delivered), 15 invoices (3 draft / 2 cancelled / 10 posted)';
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES — run after the script to confirm counts
-- ─────────────────────────────────────────────────────────────────────────────
SELECT 'leads' AS table_name, count(*) FROM public.leads
UNION ALL SELECT 'deals', count(*) FROM public.deals
UNION ALL SELECT 'quotations', count(*) FROM public.quotations
UNION ALL SELECT 'sales_orders', count(*) FROM public.sales_orders
UNION ALL SELECT 'crm_invoices', count(*) FROM public.crm_invoices;

SELECT status, count(*) FROM public.leads GROUP BY status ORDER BY status;
SELECT stage, status, count(*) FROM public.deals GROUP BY stage, status ORDER BY stage;
SELECT status, count(*) FROM public.quotations GROUP BY status ORDER BY status;
SELECT status, count(*) FROM public.sales_orders GROUP BY status ORDER BY status;
SELECT doc_status, payment_status, count(*) FROM public.crm_invoices GROUP BY doc_status, payment_status ORDER BY doc_status, payment_status;
