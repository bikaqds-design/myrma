-- ############################################################################
-- #  DB TEST TIER — purchase document lifecycle guard
-- #
-- #  Covers assert_purchase_status_transition
-- #  (20260773_purchase_status_transition_guard.sql), the trigger that stops a
-- #  purchase order or vendor invoice moving between states the lifecycle does
-- #  not allow. Before it, every transition was a bare client-side
-- #  .update({ status }) with no condition on the current status, so the UI was
-- #  the only thing preventing un-cancelling, reopening a received invoice, or
-- #  skipping approval.
-- #
-- #  RUN AGAINST: a fresh local Supabase Postgres (`supabase start`).
-- #    psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
-- #      -v ON_ERROR_STOP=1 -f supabase/tests/purchase_status_transitions.sql
-- #
-- #  STATUS: all 12 checks passed when this was run by hand against the live
-- #  database on 2026-08-10, immediately after 20260773 was applied. The suite
-- #  is self-seeding and self-cleaning; the run left no rows behind.
-- #
-- #  The db-tests CI job that would run this automatically is still parked (see
-- #  .github/workflows/ci.yml) because 13 Base44-legacy tables are created by no
-- #  migration. That blocks the job, not this file — nothing here depends on
-- #  those tables.
-- #
-- #  PREREQUISITES: none beyond the migrations. Seeds its own throwaway vendor
-- #  and documents, and hard-deletes them at the end.
-- ############################################################################

DO $$
DECLARE
  v_actor      text := 'ci.purchasing@test.com';
  v_vendor     uuid;
  v_po         uuid;
  v_vi         uuid;
  v_vi2        uuid;
  v_status     text;
  v_failures   text[] := '{}';
  v_check_count int := 0;
BEGIN
  INSERT INTO public.brands (brand_name) VALUES ('CI Lifecycle Vendor') RETURNING id INTO v_vendor;

  -- ══ Vendor invoices ═══════════════════════════════════════════════════════

  -- ── CHECK 1: the happy path is untouched ──
  -- draft -> pending_approval -> approved must all pass. A guard that blocks
  -- legitimate work is worse than no guard.
  v_check_count := v_check_count + 1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
    VALUES (v_vendor, 'draft', '[]'::jsonb, 100, v_actor) RETURNING id INTO v_vi;
  BEGIN
    UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi;
    UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_vi;
    SELECT status INTO v_status FROM public.vendor_invoices WHERE id = v_vi;
    IF v_status <> 'approved' THEN
      v_failures := array_append(v_failures,
        format('CHECK 1 (happy path): expected approved, got %s', v_status));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_failures := array_append(v_failures,
      format('CHECK 1 (happy path): the normal draft->pending_approval->approved flow was REJECTED: %s', SQLERRM));
  END;

  -- ── CHECK 2: draft may not skip approval ──
  -- Needs its own invoice: v_vi is approved by now, and walking it back to
  -- draft is itself refused (CHECK 3).
  v_check_count := v_check_count + 1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
    VALUES (v_vendor, 'draft', '[]'::jsonb, 100, v_actor) RETURNING id INTO v_vi2;
  BEGIN
    UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_vi2;
    v_failures := array_append(v_failures,
      'CHECK 2 (skip approval): draft -> approved was NOT rejected');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    NULL; -- expected
  END;

  -- ── CHECK 3: approved may not be reopened for editing ──
  -- Reopening makes the line items editable again with no second approval.
  -- v_vi is still 'approved' from CHECK 1.
  v_check_count := v_check_count + 1;
  BEGIN
    UPDATE public.vendor_invoices SET status = 'draft' WHERE id = v_vi;
    v_failures := array_append(v_failures,
      'CHECK 3 (reopen approved): approved -> draft was NOT rejected');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    NULL;
  END;

  -- ── CHECK 4: received is terminal ──
  -- The damaging one: a received invoice already created inventory_units, so
  -- reopening and re-receiving books the same delivery into stock twice.
  v_check_count := v_check_count + 1;
  UPDATE public.vendor_invoices SET status = 'received' WHERE id = v_vi;
  BEGIN
    UPDATE public.vendor_invoices SET status = 'draft' WHERE id = v_vi;
    v_failures := array_append(v_failures,
      'CHECK 4 (received terminal): received -> draft was NOT rejected');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    NULL;
  END;

  -- ── CHECK 5: a received invoice may not be cancelled ──
  -- Stock has arrived; cancelling drops the document out of every spend figure
  -- while the stock stays, leaving it unexplained.
  v_check_count := v_check_count + 1;
  BEGIN
    UPDATE public.vendor_invoices SET status = 'cancelled' WHERE id = v_vi;
    v_failures := array_append(v_failures,
      'CHECK 5 (cancel after receipt): received -> cancelled was NOT rejected');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    NULL;
  END;

  -- ── CHECK 6: cancelled is terminal (no un-cancelling) ──
  -- Analytics read cancelled as "never committed"; reviving one rewrites history.
  v_check_count := v_check_count + 1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
    VALUES (v_vendor, 'cancelled', '[]'::jsonb, 50, v_actor) RETURNING id INTO v_vi;
  BEGIN
    UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_vi;
    v_failures := array_append(v_failures,
      'CHECK 6 (un-cancel): cancelled -> approved was NOT rejected');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    NULL;
  END;

  -- ── CHECK 7: non-status columns are unaffected at a terminal status ──
  -- The trigger is BEFORE UPDATE OF status; archiving a received or cancelled
  -- document must still work.
  v_check_count := v_check_count + 1;
  BEGIN
    UPDATE public.vendor_invoices SET archived = true, notes = 'ci archive' WHERE id = v_vi;
  EXCEPTION WHEN OTHERS THEN
    v_failures := array_append(v_failures,
      format('CHECK 7 (non-status write): archiving a cancelled invoice was REJECTED: %s', SQLERRM));
  END;

  -- ── CHECK 8: a same-value status write passes ──
  -- The document forms send the whole row back on save, so this is routine.
  v_check_count := v_check_count + 1;
  BEGIN
    UPDATE public.vendor_invoices SET status = 'cancelled' WHERE id = v_vi;
  EXCEPTION WHEN OTHERS THEN
    v_failures := array_append(v_failures,
      format('CHECK 8 (same-value write): cancelled -> cancelled was REJECTED: %s', SQLERRM));
  END;

  -- ══ Purchase orders ═══════════════════════════════════════════════════════

  -- ── CHECK 9: the PO happy path is untouched ──
  v_check_count := v_check_count + 1;
  -- po_code is UNIQUE NOT NULL with no default, so every PO needs a distinct one.
  INSERT INTO public.purchase_orders (po_code, vendor_id, status, line_items, total, created_by)
    VALUES ('PO-CI-LIFECYCLE-1', v_vendor, 'draft', '[]'::jsonb, 200, v_actor) RETURNING id INTO v_po;
  BEGIN
    UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po;
    UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po;
    UPDATE public.purchase_orders SET status = 'partially_completed' WHERE id = v_po;
    UPDATE public.purchase_orders SET status = 'completed' WHERE id = v_po;
    SELECT status INTO v_status FROM public.purchase_orders WHERE id = v_po;
    IF v_status <> 'completed' THEN
      v_failures := array_append(v_failures,
        format('CHECK 9 (PO happy path): expected completed, got %s', v_status));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_failures := array_append(v_failures,
      format('CHECK 9 (PO happy path): the normal draft->sent->confirmed->partially_completed->completed flow was REJECTED: %s', SQLERRM));
  END;

  -- ── CHECK 10: completed is terminal ──
  v_check_count := v_check_count + 1;
  BEGIN
    UPDATE public.purchase_orders SET status = 'cancelled' WHERE id = v_po;
    v_failures := array_append(v_failures,
      'CHECK 10 (completed terminal): completed -> cancelled was NOT rejected');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    NULL;
  END;

  -- ── CHECK 11: a part-delivered PO may not be cancelled ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.purchase_orders (po_code, vendor_id, status, line_items, total, created_by)
    VALUES ('PO-CI-LIFECYCLE-2', v_vendor, 'partially_completed', '[]'::jsonb, 200, v_actor) RETURNING id INTO v_po;
  BEGIN
    UPDATE public.purchase_orders SET status = 'cancelled' WHERE id = v_po;
    v_failures := array_append(v_failures,
      'CHECK 11 (cancel part-delivered PO): partially_completed -> cancelled was NOT rejected');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    NULL;
  END;

  -- ── CHECK 12: rejection back to draft still works ──
  -- purchaseOrders.rejectToDraft is a real UI path and must survive the guard.
  v_check_count := v_check_count + 1;
  INSERT INTO public.purchase_orders (po_code, vendor_id, status, line_items, total, created_by)
    VALUES ('PO-CI-LIFECYCLE-3', v_vendor, 'sent', '[]'::jsonb, 200, v_actor) RETURNING id INTO v_po;
  BEGIN
    UPDATE public.purchase_orders SET status = 'draft' WHERE id = v_po;
  EXCEPTION WHEN OTHERS THEN
    v_failures := array_append(v_failures,
      format('CHECK 12 (reject to draft): sent -> draft was REJECTED: %s', SQLERRM));
  END;

  -- ── Cleanup ──
  -- Deletes are by vendor, so v_vi2 and every other seeded row go with them.
  DELETE FROM public.purchase_orders WHERE vendor_id = v_vendor;
  DELETE FROM public.vendor_invoices WHERE vendor_id = v_vendor;
  DELETE FROM public.brands WHERE id = v_vendor;

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % purchase-lifecycle check(s) FAILED:\n%',
      array_length(v_failures, 1), v_check_count, array_to_string(v_failures, E'\n');
  END IF;

  RAISE NOTICE 'All % purchase-lifecycle checks passed', v_check_count;
END $$;
