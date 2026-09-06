-- Verify 20260815_assert_sales_status_transitions.sql  (audit BUG-034)
--
-- Runs inside one transaction that ends in a RAISE, so nothing is committed —
-- including the fixture documents it creates. A successful run ENDS IN AN ERROR
-- whose message is the verdict. Read the message, not the exit status.
--
-- Safe to run against production.
--
-- ── The pairs are the point ──────────────────────────────────────────────────
--
-- Every "must be refused" check is followed by the legitimate path it must not
-- have taken with it. A transition map that refuses everything is not a fix,
-- and the failure mode of a map is nearly always over-tightening rather than
-- under-tightening — 20260809 had exactly that fault and it took a verification
-- run to catch.
--
--   1/2  invoice     draft -> posted refused      draft -> cancelled allowed
--   3    credit note draft -> issued refused (no client status write exists)
--   4/5  quotation   converted -> cancelled refused   draft -> sent allowed
--   6    quotation   reopen from declined -> sent allowed (both screens use it)
--   7    the RPC context is untouched
--   8    an administrator still passes, for Backup & Restore

DO $verify$
DECLARE
  v_rep      text;
  v_admin    text;
  v_customer uuid;
  v_inv      uuid;
  v_inv2     uuid;
  v_cn       uuid;
  v_qt_conv  uuid;
  v_qt_conv2 uuid;
  v_qt_draft uuid;
  v_qt_decl  uuid;
  v_out      text := '';
BEGIN
  SELECT user_email INTO v_rep
    FROM public.user_roles WHERE role = 'sales_rep' AND status = 'active' LIMIT 1;
  IF v_rep IS NULL THEN
    SELECT user_email INTO v_rep
      FROM public.user_roles WHERE role = 'manager' AND status = 'active' LIMIT 1;
  END IF;
  SELECT user_email INTO v_admin
    FROM public.user_roles WHERE role IN ('admin', 'super_admin') AND status = 'active' LIMIT 1;
  SELECT id INTO v_customer FROM public.customers LIMIT 1;

  IF v_rep IS NULL OR v_admin IS NULL OR v_customer IS NULL THEN
    RAISE EXCEPTION 'Cannot verify: need an active rep/manager (%), admin (%) and a customer (%).',
      coalesce(v_rep,'none'), coalesce(v_admin,'none'), coalesce(v_customer::text,'none');
  END IF;

  INSERT INTO public.crm_invoices
    (customer_id, doc_status, payment_status, line_items,
     subtotal, discount_amount, tax_amount, total, amount_paid, created_by, assigned_rep)
  VALUES (v_customer, 'draft', 'unpaid', '[]'::jsonb, 0,0,0,100,0, v_rep, v_rep)
  RETURNING id INTO v_inv;

  -- A second draft invoice, so the cancel check does not depend on the posting
  -- check above having been refused. The first version of this script reused one
  -- row and reported a confusing cascade: check 1 posted it, so check 2's cancel
  -- was refused by the settled-document guard rather than tested on a draft.
  INSERT INTO public.crm_invoices
    (customer_id, doc_status, payment_status, line_items,
     subtotal, discount_amount, tax_amount, total, amount_paid, created_by, assigned_rep)
  VALUES (v_customer, 'draft', 'unpaid', '[]'::jsonb, 0,0,0,100,0, v_rep, v_rep)
  RETURNING id INTO v_inv2;

  INSERT INTO public.credit_notes
    (type, customer_id, reason, status, line_items,
     subtotal, tax_amount, total, applied_amount, remaining_balance,
     restock_status, created_by, assigned_rep)
  VALUES ('correction', v_customer, 'probe', 'draft', '[]'::jsonb,
          0,0,50,0,0, 'not_applicable', v_rep, v_rep)
  RETURNING id INTO v_cn;

  INSERT INTO public.quotations
    (qt_code, customer_id, status, line_items, subtotal, discount_amount, tax_amount, total, created_by, assigned_rep)
  VALUES ('QT-PROBE-C-' || substr(gen_random_uuid()::text,1,6), v_customer, 'converted', '[]'::jsonb, 0,0,0,0, v_rep, v_rep)
  RETURNING id INTO v_qt_conv;

  INSERT INTO public.quotations
    (qt_code, customer_id, status, line_items, subtotal, discount_amount, tax_amount, total, created_by, assigned_rep)
  VALUES ('QT-PROBE-A-' || substr(gen_random_uuid()::text,1,6), v_customer, 'converted', '[]'::jsonb, 0,0,0,0, v_rep, v_rep)
  RETURNING id INTO v_qt_conv2;

  INSERT INTO public.quotations
    (qt_code, customer_id, status, line_items, subtotal, discount_amount, tax_amount, total, created_by, assigned_rep)
  VALUES ('QT-PROBE-D-' || substr(gen_random_uuid()::text,1,6), v_customer, 'draft', '[]'::jsonb, 0,0,0,0, v_rep, v_rep)
  RETURNING id INTO v_qt_draft;

  INSERT INTO public.quotations
    (qt_code, customer_id, status, line_items, subtotal, discount_amount, tax_amount, total, created_by, assigned_rep)
  VALUES ('QT-PROBE-X-' || substr(gen_random_uuid()::text,1,6), v_customer, 'declined', '[]'::jsonb, 0,0,0,0, v_rep, v_rep)
  RETURNING id INTO v_qt_decl;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_rep, 'role', 'authenticated')::text, true);

  -- ═══ 1. The posting bypass ═════════════════════════════════════════════════
  BEGIN
    UPDATE public.crm_invoices SET doc_status = 'posted', posted_at = now() WHERE id = v_inv;
    v_out := v_out || 'FAIL draft invoice still postable by hand. ';
  EXCEPTION
    WHEN raise_exception THEN v_out := v_out || 'PASS draft -> posted refused. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE post (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 2. Cancelling a draft must still work ═════════════════════════════════
  BEGIN
    UPDATE public.crm_invoices SET doc_status = 'cancelled' WHERE id = v_inv2;
    v_out := v_out || 'PASS draft -> cancelled still allowed. ';
  EXCEPTION
    WHEN OTHERS THEN v_out := v_out || format('FAIL cancelling a draft refused (SQLSTATE %s) - too tight. ', SQLSTATE);
  END;

  -- ═══ 3. The credit-note issuing bypass ═════════════════════════════════════
  BEGIN
    UPDATE public.credit_notes SET status = 'issued', issued_at = now() WHERE id = v_cn;
    v_out := v_out || 'FAIL draft credit note still issuable by hand. ';
  EXCEPTION
    WHEN raise_exception THEN v_out := v_out || 'PASS draft -> issued refused. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE issue (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 4. A converted quotation is terminal ══════════════════════════════════
  BEGIN
    UPDATE public.quotations SET status = 'cancelled' WHERE id = v_qt_conv;
    v_out := v_out || 'FAIL converted quotation still cancellable, orphaning its sales order. ';
  EXCEPTION
    WHEN raise_exception THEN v_out := v_out || 'PASS converted quotation is terminal. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE converted (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 5. Sending a draft quotation for approval must still work ═════════════
  BEGIN
    UPDATE public.quotations SET status = 'sent' WHERE id = v_qt_draft;
    v_out := v_out || 'PASS draft -> sent still allowed. ';
  EXCEPTION
    WHEN OTHERS THEN v_out := v_out || format('FAIL send for approval refused (SQLSTATE %s) - too tight. ', SQLSTATE);
  END;

  -- ═══ 6. Reopen from declined must still work ═══════════════════════════════
  -- Both the Sales Documents screen and the deal screen offer Reopen only from
  -- cancelled/declined, and it sets 'sent'.
  BEGIN
    UPDATE public.quotations SET status = 'sent' WHERE id = v_qt_decl;
    v_out := v_out || 'PASS declined -> sent (reopen) still allowed. ';
  EXCEPTION
    WHEN OTHERS THEN v_out := v_out || format('FAIL reopen refused (SQLSTATE %s) - too tight. ', SQLSTATE);
  END;

  -- ═══ 7. The RPC context is untouched ═══════════════════════════════════════
  RESET ROLE;
  BEGIN
    UPDATE public.crm_invoices SET doc_status = 'posted' WHERE id = v_inv;
    v_out := v_out || 'PASS the RPC context can still post. ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL the RPC context is blocked (SQLSTATE %s) - post_invoice would break. ', SQLSTATE);
  END;

  -- ═══ 8. Administrators pass, for Backup & Restore ══════════════════════════
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    UPDATE public.quotations SET status = 'cancelled' WHERE id = v_qt_conv2;
    v_out := v_out || 'PASS admin restore path still writes status.';
  EXCEPTION
    WHEN OTHERS THEN v_out := v_out || format('FAIL admin restore path blocked (SQLSTATE %s).', SQLSTATE);
  END;

  RAISE EXCEPTION 'VERIFY 20260815 (rolled back) :: %', v_out;
END
$verify$;
