-- Verify 20260809_lock_settled_financial_documents.sql  (audit BUG-002)
--
-- Runs inside one transaction that ends in a RAISE, so nothing is committed —
-- including the two fixture invoices it creates. A successful run ENDS IN AN
-- ERROR whose message is the verdict. Read the message, not the exit status.
--
-- Safe to run against production.
--
-- ── Why it builds its own fixtures ───────────────────────────────────────────
--
-- The checks need a posted invoice AND a draft invoice, both owned by the same
-- sales rep, and there is no guarantee the live data holds either. Creating
-- them at the top while the script is still unscoped makes the result the same
-- whatever state the database happens to be in. They are rolled back with
-- everything else.
--
-- ── What a PASS means for each check ─────────────────────────────────────────
--
--   P0001 (raise_exception)      the guard trigger refused  -> settled lock works
--   42501 (insufficient_privilege) a policy refused         -> WITH CHECK / admin-only works
--   success                       the write was allowed     -> legitimate path intact
--
-- The two are kept apart deliberately. A probe that accepts "any error" as a
-- refusal cannot tell a working guard from a missing column.

DO $verify$
DECLARE
  v_rep      text;
  v_other    text;
  v_manager  text;
  v_admin    text;
  v_customer uuid;
  v_draft    uuid;
  v_posted   uuid;
  v_cn       uuid;
  v_payment  uuid;
  v_out      text := '';
BEGIN
  -- ── Fixtures, built unscoped ───────────────────────────────────────────────
  SELECT user_email INTO v_rep
    FROM public.user_roles WHERE role = 'sales_rep' AND status = 'active' LIMIT 1;
  SELECT user_email INTO v_other
    FROM public.user_roles WHERE role = 'sales_rep' AND status = 'active'
     AND user_email <> coalesce(v_rep, '') LIMIT 1;
  SELECT user_email INTO v_manager
    FROM public.user_roles WHERE role = 'manager' AND status = 'active' LIMIT 1;
  SELECT user_email INTO v_admin
    FROM public.user_roles WHERE role IN ('admin', 'super_admin') AND status = 'active' LIMIT 1;
  SELECT id INTO v_customer FROM public.customers LIMIT 1;

  IF v_rep IS NULL OR v_admin IS NULL OR v_customer IS NULL THEN
    RAISE EXCEPTION 'Cannot verify: need an active sales_rep (%), an active admin (%) and a customer (%).',
      coalesce(v_rep, 'none'), coalesce(v_admin, 'none'), coalesce(v_customer::text, 'none');
  END IF;

  INSERT INTO public.crm_invoices
    (customer_id, doc_status, payment_status, line_items,
     subtotal, discount_amount, tax_amount, total, amount_paid,
     created_by, assigned_rep)
  VALUES (v_customer, 'draft', 'unpaid', '[]'::jsonb, 0, 0, 0, 0, 0, v_rep, v_rep)
  RETURNING id INTO v_draft;

  INSERT INTO public.crm_invoices
    (customer_id, doc_status, payment_status, line_items,
     subtotal, discount_amount, tax_amount, total, amount_paid,
     created_by, assigned_rep, posted_at)
  VALUES (v_customer, 'posted', 'unpaid', '[]'::jsonb, 0, 0, 0, 100, 0, v_rep, v_rep, now())
  RETURNING id INTO v_posted;

  -- An issued credit note, to exercise the second guarded table. Its generated
  -- column (affects_inventory) is what makes this an independent check rather
  -- than a repeat of the invoice one.
  INSERT INTO public.credit_notes
    (type, customer_id, reason, status, line_items,
     subtotal, tax_amount, total, applied_amount, remaining_balance,
     restock_status, created_by, assigned_rep, issued_at)
  VALUES ('correction', v_customer, 'probe', 'issued', '[]'::jsonb,
          0, 0, 0, 0, 0,
          'not_applicable', v_rep, v_rep, now())
  RETURNING id INTO v_cn;

  SELECT id INTO v_payment FROM public.payments LIMIT 1;

  PERFORM set_config('role', 'authenticated', true);

  -- ═══ 1. The rep who owns a POSTED invoice must not be able to rewrite it ═══
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_rep, 'role', 'authenticated')::text, true);

  BEGIN
    UPDATE public.crm_invoices
       SET payment_status = 'paid', amount_paid = total
     WHERE id = v_posted;
    v_out := v_out || 'FAIL posted-invoice rewrite: still allowed. ';
  EXCEPTION
    WHEN raise_exception THEN v_out := v_out || 'PASS posted-invoice rewrite refused (guard). ';
    WHEN insufficient_privilege THEN v_out := v_out || 'PASS posted-invoice rewrite refused (policy). ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE posted rewrite (SQLSTATE %s). ', SQLSTATE);
  END;

  BEGIN
    UPDATE public.crm_invoices SET total = 1, line_items = '[]'::jsonb WHERE id = v_posted;
    v_out := v_out || 'FAIL posted-invoice total: still allowed. ';
  EXCEPTION
    WHEN raise_exception THEN v_out := v_out || 'PASS posted-invoice total refused. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE posted total (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 1c. The inputs to a generated column must stay frozen ════════════════
  -- 20260810 exempts stored generated columns from the comparison, because they
  -- read as NULL in NEW inside a BEFORE trigger. That is only safe while the
  -- ordinary columns they are computed FROM remain protected. cogs_complete is
  -- derived from cogs_base and cogs_unknown_qty, so cogs_base is the thing to
  -- test: if this ever passes, the exemption has become a hole.
  BEGIN
    UPDATE public.crm_invoices SET cogs_base = 0, cogs_unknown_qty = 0 WHERE id = v_posted;
    v_out := v_out || 'FAIL cogs_base: writable on a posted invoice - generated-column exemption is too wide. ';
  EXCEPTION
    WHEN raise_exception THEN v_out := v_out || 'PASS cogs_base still frozen. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE cogs_base (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 2. Archiving a posted invoice must still work ════════════════════════
  -- The Sales Documents screen offers Archive at every status. If this fails
  -- the guard is too tight and the archive tab is broken.
  BEGIN
    UPDATE public.crm_invoices
       SET archived = true, archived_at = now(), archived_by = v_rep
     WHERE id = v_posted;
    v_out := v_out || 'PASS archive of a posted invoice still allowed. ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL archive of a posted invoice refused (SQLSTATE %s) - guard too tight. ', SQLSTATE);
  END;

  -- ═══ 2b. The same must hold for the other guarded table ═══════════════════
  -- credit_notes has its own generated column (affects_inventory), so archiving
  -- an issued credit note exercises the identical failure mode independently.
  BEGIN
    UPDATE public.credit_notes
       SET archived = true, archived_at = now(), archived_by = v_rep
     WHERE id = v_cn;
    v_out := v_out || 'PASS archive of an issued credit note still allowed. ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL archive of an issued credit note refused (SQLSTATE %s). ', SQLSTATE);
  END;

  BEGIN
    UPDATE public.credit_notes SET total = 999, reason = 'probe' WHERE id = v_cn;
    v_out := v_out || 'FAIL issued credit note still re-priceable. ';
  EXCEPTION
    WHEN raise_exception THEN v_out := v_out || 'PASS issued credit note frozen. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE credit note freeze (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 3. A DRAFT invoice must still be editable by its owner ═══════════════
  BEGIN
    UPDATE public.crm_invoices
       SET notes = 'probe', total = 5, line_items = '[]'::jsonb
     WHERE id = v_draft;
    v_out := v_out || 'PASS draft still editable by its rep. ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL draft edit refused (SQLSTATE %s) - guard too tight. ', SQLSTATE);
  END;

  -- ═══ 4. A rep must not hand a draft to someone else ═══════════════════════
  -- This already held before 20260809, because Postgres reuses USING as the
  -- check on the new row when WITH CHECK is omitted. It is asserted here as a
  -- regression guard on the explicit clauses the migration writes out: if
  -- someone later widens USING without thinking about the new row, this fails.
  IF v_other IS NULL THEN
    v_out := v_out || 'SKIP reassignment (only one active sales_rep). ';
  ELSE
    BEGIN
      UPDATE public.crm_invoices
         SET assigned_rep = v_other, created_by = v_other
       WHERE id = v_draft;
      v_out := v_out || 'FAIL reassignment: rep handed the document away. ';
    EXCEPTION
      WHEN insufficient_privilege THEN v_out := v_out || 'PASS reassignment refused (WITH CHECK). ';
      WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE reassignment (SQLSTATE %s). ', SQLSTATE);
    END;
  END IF;

  -- ═══ 5. payments accept no client UPDATE below admin ══════════════════════
  IF v_payment IS NULL THEN
    v_out := v_out || 'SKIP payments UPDATE (no payment row). ';
  ELSIF v_manager IS NULL THEN
    v_out := v_out || 'SKIP payments UPDATE (no active manager). ';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_manager, 'role', 'authenticated')::text, true);
    BEGIN
      UPDATE public.payments SET amount = 1 WHERE id = v_payment;
      IF FOUND THEN
        v_out := v_out || 'FAIL payments UPDATE: manager still rewrote a payment. ';
      ELSE
        v_out := v_out || 'PASS payments UPDATE filtered to zero rows for a manager. ';
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN v_out := v_out || 'PASS payments UPDATE refused for a manager. ';
      WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE payments UPDATE (SQLSTATE %s). ', SQLSTATE);
    END;
  END IF;

  -- ═══ 6. An administrator must still get through (restore path) ════════════
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated')::text, true);

  BEGIN
    UPDATE public.crm_invoices SET total = 42 WHERE id = v_posted;
    v_out := v_out || 'PASS admin restore path (posted invoice writable, rolled back). ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL admin restore path (SQLSTATE %s) - Backup & Restore is broken. ', SQLSTATE);
  END;

  RAISE EXCEPTION 'VERIFY 20260809 (rolled back) :: %', v_out;
END
$verify$;
