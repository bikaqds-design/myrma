-- 20260919_deposits_credit_limits.sql — W4 / A-06a: customer deposits and
-- enforced credit limits (database layer; the screens are A-06b).
--
-- Owner decisions (2026-09-30):
--   * a sale that would take a customer over their credit limit is REFUSED,
--     unless a manager or above approves it with a reason (kept on the
--     document);
--   * checked when a sales order is approved (stock is committed) and when an
--     invoice not raised from an order is posted (an order's invoices were
--     already counted with the order);
--   * the balance counted is unpaid invoices + approved orders not yet
--     invoiced, less unused payments, deposits and credit notes, all in the
--     base currency; customers.credit_limit is in the base currency and NULL
--     means no limit;
--   * a deposit (money taken before invoicing, optionally against a sales
--     order) is a liability — Customer deposits, role customer_deposits —
--     until it is applied to an invoice, when it moves to receivables.
--
-- A deposit is a payment with is_deposit: it is recorded through
-- record_payment (same permission, numbering, currency rules), applied and
-- voided with the payment functions that exist, and shown on the customer's
-- statement like any payment. Only its postings differ:
--   recorded   Dr cash / bank          Cr customer deposits
--   applied    Dr customer deposits    Cr receivables    (per application)
--   refunded   Dr customer deposits    Cr cash / bank
-- The application entry is booked under the payment (event deposit:<row>), so
-- the ledger checks (20260917) match it per document once receivables and
-- customer deposits are counted together — which they now are.

-- ── 1. deposits ──────────────────────────────────────────────────────────────
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS is_deposit boolean NOT NULL DEFAULT false;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS sales_order_id uuid REFERENCES public.sales_orders(id);
CREATE INDEX IF NOT EXISTS payments_sales_order_idx ON public.payments (sales_order_id) WHERE sales_order_id IS NOT NULL;
COMMENT ON COLUMN public.payments.is_deposit IS
  'A-06 (20260919): money taken before invoicing, booked to Customer deposits until applied. Set only by record_customer_deposit.';

-- record_payment is the one writer; record_customer_deposit tells it, for this
-- transaction only, that the payment is a deposit (a switch only that function
-- sets, like rma.po_amend)
CREATE OR REPLACE FUNCTION public.rma_payment_deposit_flag()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN RETURN NEW; END IF;
  IF current_setting('rma.payment_is_deposit', true) = 'on' THEN
    NEW.is_deposit := true;
    NEW.sales_order_id := NULLIF(current_setting('rma.payment_deposit_so', true), '')::uuid;
  ELSE
    NEW.is_deposit := false;
    NEW.sales_order_id := NULL;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_payment_deposit_flag() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_payments_deposit_flag ON public.payments;
CREATE TRIGGER trg_payments_deposit_flag BEFORE INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.rma_payment_deposit_flag();

CREATE OR REPLACE FUNCTION public.record_customer_deposit(
  p_customer_id uuid, p_amount numeric, p_method text, p_reference_number text, p_payment_date date,
  p_notes text, p_sales_order_id uuid, p_currency text, p_exchange_rate numeric, p_actor_email text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_so  public.sales_orders;
  v_cur text := NULLIF(upper(btrim(p_currency)), '');
  v_id  uuid;
BEGIN
  IF p_sales_order_id IS NOT NULL THEN
    SELECT * INTO v_so FROM public.sales_orders WHERE id = p_sales_order_id;
    IF NOT FOUND OR v_so.customer_id IS DISTINCT FROM p_customer_id THEN
      RAISE EXCEPTION 'That sales order is not this customer''s.' USING ERRCODE = 'P0001';
    END IF;
    IF v_so.status IN ('cancelled', 'declined') THEN
      RAISE EXCEPTION 'A deposit cannot be taken on a % sales order.', v_so.status USING ERRCODE = 'P0001';
    END IF;
    IF v_cur IS NOT NULL AND v_cur <> upper(v_so.currency::text) THEN
      RAISE EXCEPTION 'A deposit on this order is taken in its currency, %.', upper(v_so.currency::text) USING ERRCODE = 'P0001';
    END IF;
    v_cur := upper(v_so.currency::text);
  END IF;

  PERFORM set_config('rma.payment_is_deposit', 'on', true);
  PERFORM set_config('rma.payment_deposit_so', COALESCE(p_sales_order_id::text, ''), true);
  -- record_payment checks the permission (accounting.record_payment), the
  -- role, the amount and the currency, numbers it and posts it
  v_id := public.record_payment(p_customer_id, p_amount, p_method, p_reference_number, p_payment_date, p_notes,
                                p_actor_email, '[]'::jsonb, v_cur, p_exchange_rate);
  PERFORM set_config('rma.payment_is_deposit', 'off', true);
  PERFORM set_config('rma.payment_deposit_so', '', true);
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.record_customer_deposit(uuid, numeric, text, text, date, text, uuid, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_customer_deposit(uuid, numeric, text, text, date, text, uuid, text, numeric, text) TO authenticated, service_role;

-- ── 2. deposit postings ──────────────────────────────────────────────────────
-- the payment and refund postings name the deposits account for a deposit
-- (rewritten in their live definitions, each anchor counted once)
DO $rw$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  v_def := replace(pg_get_functiondef('public.rma_gl_post_payment()'::regprocedure), E'\r\n', E'\n');
  v_old := $$jsonb_build_object('role', 'accounts_receivable', 'credit', v_amt, 'customer_id', NEW.customer_id)$$;
  v_new := $$jsonb_build_object('role', CASE WHEN COALESCE(NEW.is_deposit, false) THEN 'customer_deposits' ELSE 'accounts_receivable' END, 'credit', v_amt, 'customer_id', NEW.customer_id)$$;
  IF position('customer_deposits' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION '20260919: rma_gl_post_payment does not read as expected';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;

  v_def := replace(pg_get_functiondef('public.rma_gl_post_customer_refund()'::regprocedure), E'\r\n', E'\n');
  v_old := $$jsonb_build_object('role', 'accounts_receivable', 'debit', v_amt, 'customer_id', NEW.customer_id)$$;
  v_new := $$jsonb_build_object('role', CASE WHEN EXISTS (SELECT 1 FROM public.payments p WHERE p.id = NEW.payment_id AND p.is_deposit) THEN 'customer_deposits' ELSE 'accounts_receivable' END, 'debit', v_amt, 'customer_id', NEW.customer_id)$$;
  IF position('customer_deposits' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION '20260919: rma_gl_post_customer_refund does not read as expected';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
END
$rw$;

-- applying (or reversing) a deposit moves it between deposits and receivables,
-- at the deposit's rate; the exchange difference against the invoice's rate is
-- posted on receivables as before (rma_gl_post_ar_fx)
CREATE OR REPLACE FUNCTION public.rma_gl_post_deposit_application()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_pay public.payments;
  v_amt numeric;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN RETURN NULL; END IF;
  SELECT * INTO v_pay FROM public.payments WHERE id = NEW.payment_id;
  IF NOT FOUND OR NOT v_pay.is_deposit THEN RETURN NULL; END IF;
  v_amt := round(COALESCE(NEW.amount_applied, 0) * COALESCE(v_pay.exchange_rate, 1), 2);
  IF v_amt = 0 THEN RETURN NULL; END IF;
  PERFORM public._gl_post('payment', v_pay.id, 'deposit:' || NEW.id, public.rma_today(), v_pay.payment_code,
    CASE WHEN v_amt > 0 THEN 'Deposit ' ELSE 'Deposit application reversed ' END || COALESCE(v_pay.payment_code, v_pay.id::text),
    jsonb_build_array(
      jsonb_build_object('role', 'customer_deposits', CASE WHEN v_amt > 0 THEN 'debit' ELSE 'credit' END, abs(v_amt), 'customer_id', v_pay.customer_id),
      jsonb_build_object('role', 'accounts_receivable', CASE WHEN v_amt > 0 THEN 'credit' ELSE 'debit' END, abs(v_amt), 'customer_id', v_pay.customer_id)));
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_gl_post_deposit_application() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_payment_applications_deposit_gl ON public.payment_applications;
CREATE TRIGGER trg_payment_applications_deposit_gl AFTER INSERT ON public.payment_applications
  FOR EACH ROW EXECUTE FUNCTION public.rma_gl_post_deposit_application();

-- ── 3. credit exposure ───────────────────────────────────────────────────────
-- In the base currency: posted invoices' unpaid balance + approved orders not
-- yet invoiced − unused payments and deposits − credit notes' remaining balance.
CREATE OR REPLACE FUNCTION public._rma_credit_exposure(p_customer_id uuid)
RETURNS TABLE(open_invoices numeric, open_orders numeric, unused_credits numeric, exposure numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  WITH inv AS (
    SELECT COALESCE(sum(round((i.total - COALESCE(i.amount_paid, 0)) * COALESCE(i.exchange_rate, 1), 2)), 0) AS v
      FROM public.crm_invoices i
     WHERE i.customer_id = p_customer_id AND i.doc_status = 'posted'
  ), ord AS (
    SELECT COALESCE(sum(round(GREATEST(o.total - COALESCE((
             SELECT sum(x.total) FROM public.crm_invoices x
              WHERE x.doc_status <> 'cancelled'
                AND (x.so_id = o.id OR x.delivery_id IN (SELECT d.id FROM public.deliveries d WHERE d.sales_order_id = o.id))), 0), 0)
             * COALESCE(o.exchange_rate, 1), 2)), 0) AS v
      FROM public.sales_orders o
     WHERE o.customer_id = p_customer_id AND o.status IN ('confirmed', 'delivered')
  ), cr AS (
    SELECT COALESCE((SELECT sum(round(p.unapplied_amount * COALESCE(p.exchange_rate, 1), 2)) FROM public.payments p
                      WHERE p.customer_id = p_customer_id AND p.status = 'active'), 0)
         + COALESCE((SELECT sum(round(c.remaining_balance * COALESCE(c.exchange_rate, 1), 2)) FROM public.credit_notes c
                      WHERE c.customer_id = p_customer_id AND c.status IN ('issued', 'applied')), 0) AS v
  )
  SELECT inv.v, ord.v, cr.v, inv.v + ord.v - cr.v FROM inv, ord, cr
$fn$;
REVOKE ALL ON FUNCTION public._rma_credit_exposure(uuid) FROM PUBLIC, anon, authenticated;

-- what the screens show: the limit, what counts against it and what is left
CREATE OR REPLACE FUNCTION public.rma_customer_credit_status(p_customer_id uuid)
RETURNS TABLE(credit_limit numeric, open_invoices numeric, open_orders numeric, unused_credits numeric,
              exposure numeric, available numeric, currency text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_limit numeric;
BEGIN
  IF NOT COALESCE(public.rma_is_staff(), false) THEN
    RAISE EXCEPTION 'Not allowed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.credit_limit INTO v_limit FROM public.customers c WHERE c.id = p_customer_id;
  RETURN QUERY
  SELECT v_limit, e.open_invoices, e.open_orders, e.unused_credits, e.exposure,
         CASE WHEN v_limit IS NULL THEN NULL ELSE v_limit - e.exposure END, public.rma_base_currency()::text
    FROM public._rma_credit_exposure(p_customer_id) e;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_customer_credit_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_customer_credit_status(uuid) TO authenticated, service_role;

-- ── 4. the limit is enforced ─────────────────────────────────────────────────
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS credit_override_reason text;
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS credit_override_by text;
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS credit_override_at timestamptz;
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS credit_override_total numeric(14, 2);
ALTER TABLE public.crm_invoices ADD COLUMN IF NOT EXISTS credit_override_reason text;
ALTER TABLE public.crm_invoices ADD COLUMN IF NOT EXISTS credit_override_by text;
ALTER TABLE public.crm_invoices ADD COLUMN IF NOT EXISTS credit_override_at timestamptz;
ALTER TABLE public.crm_invoices ADD COLUMN IF NOT EXISTS credit_override_total numeric(14, 2);

CREATE OR REPLACE FUNCTION public.rma_guard_credit_limit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_limit  numeric;
  v_name   text;
  v_exp    numeric;
  v_amount numeric;
  v_what   text;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN RETURN NEW; END IF;
  IF COALESCE(public.rma_current_user_email(), '') = '' THEN RETURN NEW; END IF;  -- the database itself

  IF TG_TABLE_NAME = 'sales_orders' THEN
    IF NOT (NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' AND OLD.status IS DISTINCT FROM 'delivered') THEN
      RETURN NEW;
    END IF;
    v_what := 'sales order';
  ELSE
    IF NOT (NEW.doc_status = 'posted' AND OLD.doc_status IS DISTINCT FROM 'posted') THEN RETURN NEW; END IF;
    -- an order's invoice was counted with the order when it was approved
    IF NEW.so_id IS NOT NULL OR NEW.delivery_id IS NOT NULL THEN RETURN NEW; END IF;
    v_what := 'invoice';
  END IF;

  SELECT c.credit_limit, c.company_name INTO v_limit, v_name FROM public.customers c WHERE c.id = NEW.customer_id;
  IF v_limit IS NULL THEN RETURN NEW; END IF;

  v_amount := round(COALESCE(NEW.total, 0) * COALESCE(NEW.exchange_rate, 1), 2);
  SELECT e.exposure INTO v_exp FROM public._rma_credit_exposure(NEW.customer_id) e;
  IF v_exp + v_amount <= v_limit THEN RETURN NEW; END IF;

  -- a manager's approval, for this amount or more
  IF NEW.credit_override_reason IS NOT NULL AND COALESCE(NEW.credit_override_total, -1) >= COALESCE(NEW.total, 0) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'This % takes % over its credit limit: % already owed or on order, plus % on this %, is more than the limit of % %.',
      v_what, COALESCE(v_name, 'the customer'), to_char(v_exp, 'FM999G999G999G990D00'), to_char(v_amount, 'FM999G999G999G990D00'),
      v_what, to_char(v_limit, 'FM999G999G999G990D00'), public.rma_base_currency()
    USING ERRCODE = 'P0001', HINT = 'credit_limit: a manager can approve it with a reason.';
END $fn$;
REVOKE ALL ON FUNCTION public.rma_guard_credit_limit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_sales_orders_credit_limit ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_credit_limit BEFORE UPDATE OF status ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_credit_limit();
DROP TRIGGER IF EXISTS trg_crm_invoices_credit_limit ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_credit_limit BEFORE UPDATE OF doc_status ON public.crm_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_credit_limit();

-- a manager approves going over the limit, with a reason, for the document as
-- it stands (a larger total needs a new approval)
CREATE OR REPLACE FUNCTION public.approve_credit_override(p_doc_type text, p_doc_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_me     text := public.rma_current_user_email();
  v_n      integer;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Only a manager or above can approve a sale over the credit limit.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters.' USING ERRCODE = 'P0001';
  END IF;
  IF p_doc_type = 'sales_order' THEN
    UPDATE public.sales_orders
       SET credit_override_reason = v_reason, credit_override_by = v_me, credit_override_at = now(), credit_override_total = total
     WHERE id = p_doc_id AND status IN ('draft', 'sent');
  ELSIF p_doc_type = 'invoice' THEN
    UPDATE public.crm_invoices
       SET credit_override_reason = v_reason, credit_override_by = v_me, credit_override_at = now(), credit_override_total = total
     WHERE id = p_doc_id AND doc_status = 'draft';
  ELSE
    RAISE EXCEPTION 'Unknown document type %.', p_doc_type USING ERRCODE = 'P0001';
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'Only a sales order waiting for approval or a draft invoice can be approved over the limit.' USING ERRCODE = 'P0001';
  END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.approve_credit_override(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_credit_override(text, uuid, text) TO authenticated, service_role;

-- ── 5. the ledger checks count deposits with receivables (20260917's two
--      functions, re-created with the deposits account added) ──────────────
CREATE OR REPLACE FUNCTION public._rma_subledger_rows(p_area text)
RETURNS TABLE(doc_type text, doc_id uuid, doc_code text, party_id uuid, party_name text, doc_date date,
              subledger_amount numeric, ledger_amount numeric, difference numeric, in_ledger boolean, before_ledger boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_account uuid;
  v_accounts uuid[];
  v_start   timestamptz;
BEGIN
  SELECT r.account_id INTO v_account FROM public.posting_rules r
   WHERE r.role = CASE p_area WHEN 'receivables' THEN 'accounts_receivable' WHEN 'payables' THEN 'accounts_payable' END;
  -- 20260919: receivables are counted with customer deposits (a deposit sits there until applied)
  v_accounts := ARRAY[v_account] || CASE WHEN p_area = 'receivables'
    THEN ARRAY(SELECT r.account_id FROM public.posting_rules r WHERE r.role = 'customer_deposits') ELSE ARRAY[]::uuid[] END;
  -- when the ledger first posted to this control account (sales and purchase
  -- postings started on different days)
  SELECT min(e.created_at) INTO v_start
    FROM public.journal_entries e WHERE EXISTS (SELECT 1 FROM public.journal_lines l WHERE l.entry_id = e.id AND l.account_id = ANY (v_accounts));

  IF p_area = 'receivables' THEN
    RETURN QUERY
    WITH sub AS (
      SELECT v.id, max(v.entry_type) AS t, max(v.entry_code) AS code, max(v.customer_id::text)::uuid AS party,
             min(public._rma_tenant_date(v.entry_date)) AS d, min(v.entry_date) AS ts, sum(v.amount_base) AS amt
        FROM public.v_customer_ledger v GROUP BY v.id
    ), led AS (
      SELECT e.source_id AS id, max(e.source_type) AS t, max(e.source_code) AS code,
             min(e.entry_date) AS d, sum(l.debit - l.credit) AS amt
        FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ANY (v_accounts) AND e.source_id IS NOT NULL
       GROUP BY e.source_id
    )
    SELECT COALESCE(s.t, g.t), COALESCE(s.id, g.id), COALESCE(s.code, g.code), s.party, c.company_name,
           COALESCE(s.d, g.d), COALESCE(s.amt, 0)::numeric, COALESCE(g.amt, 0)::numeric,
           (COALESCE(s.amt, 0) - COALESCE(g.amt, 0))::numeric,
           g.id IS NOT NULL, (g.id IS NULL AND (v_start IS NULL OR s.ts < v_start))
      FROM sub s FULL JOIN led g ON g.id = s.id
      LEFT JOIN public.customers c ON c.id = s.party;

  ELSIF p_area = 'payables' THEN
    RETURN QUERY
    WITH sub AS (
      SELECT v.id, max(v.entry_type) AS t, max(v.entry_code) AS code, max(v.vendor_id::text)::uuid AS party,
             min(public._rma_tenant_date(v.entry_date)) AS d, min(v.entry_date) AS ts, sum(v.amount_base) AS amt
        FROM public.v_vendor_ledger v GROUP BY v.id
    ), led AS (
      SELECT e.source_id AS id, max(e.source_type) AS t, max(e.source_code) AS code,
             min(e.entry_date) AS d, sum(l.credit - l.debit) AS amt
        FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ANY (v_accounts) AND e.source_id IS NOT NULL
       GROUP BY e.source_id
    )
    SELECT COALESCE(s.t, g.t), COALESCE(s.id, g.id), COALESCE(s.code, g.code), s.party, b.brand_name,
           COALESCE(s.d, g.d), COALESCE(s.amt, 0)::numeric, COALESCE(g.amt, 0)::numeric,
           (COALESCE(s.amt, 0) - COALESCE(g.amt, 0))::numeric,
           g.id IS NOT NULL, (g.id IS NULL AND (v_start IS NULL OR s.ts < v_start))
      FROM sub s FULL JOIN led g ON g.id = s.id
      LEFT JOIN public.brands b ON b.id = s.party;
  ELSE
    RAISE EXCEPTION 'Unknown area %: use receivables or payables.', p_area USING ERRCODE = 'P0001';
  END IF;
END $fn$;
REVOKE ALL ON FUNCTION public._rma_subledger_rows(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rma_subledger_reconciliation()
RETURNS TABLE(area text, account_id uuid, account_code text, account_name text, account_name_ar text,
              ledger_balance numeric, subledger_balance numeric, difference numeric,
              documents_differing bigint, documents_before_ledger bigint, uncosted_units numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_area text;
  v_role text;
  v_acc  public.gl_accounts;
  v_led  numeric;
  v_sub  numeric;
  v_diff bigint;
  v_pre  bigint;
  v_unc  numeric;
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Only managers and accountants can read the ledger checks.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOREACH v_area IN ARRAY ARRAY['receivables', 'payables', 'inventory'] LOOP
    v_role := CASE v_area WHEN 'receivables' THEN 'accounts_receivable' WHEN 'payables' THEN 'accounts_payable' ELSE 'inventory' END;
    SELECT a.* INTO v_acc FROM public.posting_rules r JOIN public.gl_accounts a ON a.id = r.account_id WHERE r.role = v_role;

    SELECT COALESCE(sum(CASE WHEN v_area = 'payables' THEN l.credit - l.debit ELSE l.debit - l.credit END), 0)
      INTO v_led FROM public.journal_lines l
     WHERE l.account_id = v_acc.id
        OR (v_area = 'receivables' AND l.account_id IN (SELECT r.account_id FROM public.posting_rules r WHERE r.role = 'customer_deposits'));

    IF v_area = 'inventory' THEN
      SELECT COALESCE((SELECT sum(u.unit_cost_base) FROM public.inventory_units u
                        WHERE u.status = 'company_stock' AND u.reservation_status IN ('available', 'reserved')), 0)
           + COALESCE((SELECT sum(w.total_cost_base) FROM public.warehouse_stock w), 0),
             COALESCE((SELECT count(*) FROM public.inventory_units u
                        WHERE u.status = 'company_stock' AND u.reservation_status IN ('available', 'reserved')
                          AND u.unit_cost_base IS NULL), 0)
           + COALESCE((SELECT sum(w.uncosted_quantity) FROM public.warehouse_stock w), 0)
        INTO v_sub, v_unc;
      v_diff := NULL; v_pre := NULL;
    ELSE
      SELECT COALESCE(sum(x.subledger_amount), 0),
             count(*) FILTER (WHERE x.difference <> 0),
             count(*) FILTER (WHERE x.difference <> 0 AND x.before_ledger)
        INTO v_sub, v_diff, v_pre
        FROM public._rma_subledger_rows(v_area) x;
      v_unc := NULL;
    END IF;

    area := v_area; account_id := v_acc.id; account_code := v_acc.code;
    account_name := v_acc.name; account_name_ar := v_acc.name_ar;
    ledger_balance := v_led; subledger_balance := v_sub; difference := v_sub - v_led;
    documents_differing := v_diff; documents_before_ledger := v_pre; uncosted_units := v_unc;
    RETURN NEXT;
  END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_subledger_reconciliation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_subledger_reconciliation() TO authenticated, service_role;

-- ── 6. checks ────────────────────────────────────────────────────────────────
DO $chk$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.record_customer_deposit(uuid, numeric, text, text, date, text, uuid, text, numeric, text)',
                           'public.rma_customer_credit_status(uuid)', 'public.approve_credit_override(text, uuid, text)',
                           'public._rma_credit_exposure(uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION '20260919: anon can execute %', f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._rma_credit_exposure(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '20260919: _rma_credit_exposure is client-callable';
  END IF;
  IF position('customer_deposits' IN pg_get_functiondef('public.rma_gl_post_payment()'::regprocedure)) = 0
     OR position('customer_deposits' IN pg_get_functiondef('public.rma_gl_post_customer_refund()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '20260919: a deposit would still post to receivables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.posting_rules WHERE role = 'customer_deposits') THEN
    RAISE EXCEPTION '20260919: customer_deposits has no account';
  END IF;
END
$chk$;
