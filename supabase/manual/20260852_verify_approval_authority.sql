-- Verify 20260814_require_authority_to_approve.sql  (audit BUG-004, part 2)
--
-- Runs inside one transaction that ends in a RAISE, so nothing is committed —
-- including the three fixture documents it creates. A successful run ENDS IN AN
-- ERROR whose message is the verdict. Read the message, not the exit status.
--
-- Safe to run against production.
--
-- ── What each check is for ───────────────────────────────────────────────────
--
-- The pairs matter more than the individual lines. A rule that refuses everyone
-- is not a fix, it is an outage, so every "must be refused" check is followed by
-- the "must still be allowed" case that proves approval remains possible for
-- the role that is supposed to hold it.
--
--   1/2  vendor invoice   manager refused        admin allowed
--   3/4  purchase order   manager refused        admin allowed
--   5/6  quotation        sales rep refused      manager allowed
--   7    a manager's non-approval work is untouched (submit for approval)

DO $verify$
DECLARE
  v_manager  text;
  v_admin    text;
  v_rep      text;
  v_vendor   uuid;
  v_customer uuid;
  v_vi       uuid;
  v_po       uuid;
  v_qt       uuid;
  v_out      text := '';
BEGIN
  SELECT user_email INTO v_manager
    FROM public.user_roles WHERE role = 'manager' AND status = 'active' LIMIT 1;
  SELECT user_email INTO v_admin
    FROM public.user_roles WHERE role IN ('admin', 'super_admin') AND status = 'active' LIMIT 1;
  SELECT user_email INTO v_rep
    FROM public.user_roles WHERE role = 'sales_rep' AND status = 'active' LIMIT 1;
  SELECT id INTO v_vendor   FROM public.brands LIMIT 1;
  SELECT id INTO v_customer FROM public.customers LIMIT 1;

  IF v_manager IS NULL OR v_admin IS NULL OR v_vendor IS NULL OR v_customer IS NULL THEN
    RAISE EXCEPTION 'Cannot verify: need an active manager (%), admin (%), a vendor (%) and a customer (%).',
      coalesce(v_manager,'none'), coalesce(v_admin,'none'),
      coalesce(v_vendor::text,'none'), coalesce(v_customer::text,'none');
  END IF;

  INSERT INTO public.vendor_invoices
    (vendor_id, status, line_items, subtotal, discount_amount, tax_amount, total,
     currency, exchange_rate, created_by)
  VALUES (v_vendor, 'pending_approval', '[]'::jsonb, 0,0,0,0, 'EGP', 1, v_manager)
  RETURNING id INTO v_vi;

  INSERT INTO public.purchase_orders
    (po_code, vendor_id, status, line_items, subtotal, discount_amount, tax_amount, total,
     currency, exchange_rate, created_by)
  VALUES ('PO-PROBE-' || substr(gen_random_uuid()::text,1,8), v_vendor, 'sent', '[]'::jsonb,
          0,0,0,0, 'EGP', 1, v_manager)
  RETURNING id INTO v_po;

  INSERT INTO public.quotations
    (qt_code, customer_id, status, line_items, subtotal, discount_amount, tax_amount, total,
     created_by, assigned_rep)
  VALUES ('QT-PROBE-' || substr(gen_random_uuid()::text,1,8), v_customer, 'sent', '[]'::jsonb,
          0,0,0,0, coalesce(v_rep, v_manager), coalesce(v_rep, v_manager))
  RETURNING id INTO v_qt;

  PERFORM set_config('role', 'authenticated', true);

  -- ═══ 1. A manager must not approve a vendor invoice ════════════════════════
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_manager, 'role', 'authenticated')::text, true);
  BEGIN
    UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_vi;
    v_out := v_out || 'FAIL manager approved a vendor invoice. ';
  EXCEPTION
    WHEN raise_exception THEN v_out := v_out || 'PASS manager refused VI approval. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE VI manager (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 2. An administrator must still approve it ═════════════════════════════
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_vi;
    v_out := v_out || 'PASS admin approved the VI. ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL admin cannot approve a VI either (SQLSTATE %s) - approval is impossible. ', SQLSTATE);
  END;

  -- ═══ 3. A manager must not confirm a purchase order ════════════════════════
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_manager, 'role', 'authenticated')::text, true);
  BEGIN
    UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po;
    v_out := v_out || 'FAIL manager confirmed a purchase order. ';
  EXCEPTION
    WHEN raise_exception THEN v_out := v_out || 'PASS manager refused PO confirmation. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE PO manager (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 4. An administrator must still confirm it ═════════════════════════════
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po;
    v_out := v_out || 'PASS admin confirmed the PO. ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL admin cannot confirm a PO either (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 5. A sales rep must not accept a quotation ════════════════════════════
  IF v_rep IS NULL THEN
    v_out := v_out || 'SKIP quotation rep check (no active sales_rep). ';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_rep, 'role', 'authenticated')::text, true);
    BEGIN
      UPDATE public.quotations SET status = 'accepted' WHERE id = v_qt;
      v_out := v_out || 'FAIL rep accepted their own quotation. ';
    EXCEPTION
      WHEN raise_exception THEN v_out := v_out || 'PASS rep refused quotation acceptance. ';
      WHEN insufficient_privilege THEN v_out := v_out || 'PASS rep refused by policy. ';
      WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE quotation rep (SQLSTATE %s). ', SQLSTATE);
    END;
  END IF;

  -- ═══ 6. A manager must still accept it ═════════════════════════════════════
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_manager, 'role', 'authenticated')::text, true);
  BEGIN
    UPDATE public.quotations SET status = 'accepted' WHERE id = v_qt;
    v_out := v_out || 'PASS manager accepted the quotation. ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL manager cannot accept a quotation (SQLSTATE %s) - too tight. ', SQLSTATE);
  END;

  -- ═══ 7. A manager's ordinary purchasing work is untouched ══════════════════
  -- Raising a vendor invoice and sending it for approval must still be theirs.
  BEGIN
    INSERT INTO public.vendor_invoices
      (vendor_id, status, line_items, subtotal, discount_amount, tax_amount, total,
       currency, exchange_rate, created_by)
    VALUES (v_vendor, 'draft', '[]'::jsonb, 0,0,0,0, 'EGP', 1, v_manager)
    RETURNING id INTO v_vi;

    UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi;
    v_out := v_out || 'PASS manager can still raise and submit a VI for approval.';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL manager can no longer submit a VI for approval (SQLSTATE %s).', SQLSTATE);
  END;

  RAISE EXCEPTION 'VERIFY 20260814 (rolled back) :: %', v_out;
END
$verify$;
