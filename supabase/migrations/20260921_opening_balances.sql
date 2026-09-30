-- 20260921_opening_balances.sql — B-03a: a new company's books as they stood
-- on the day before it starts (owner decisions 2026-09-30).
--
-- One batch per company, dated on the opening date, with three sections, each
-- imported whole (CSV on the screen) and checked row by row; a section with a
-- bad row stores nothing and names every bad row:
--   * accounts     the trial balance, by account code. Receivables, payables
--                  and inventory are CHECKED against the detail below, never
--                  posted from here: the detail posts them, one document at a
--                  time, so the ledger checks (20260917) match per document.
--   * receivables  each open customer invoice (owner decision: each document,
--   * payables     each open supplier bill      not one total per party)
--   * stock        by SKU and warehouse, at a unit cost (blank = unknown), with
--                  the serials of a serialized product.
-- Posting turns each open invoice into a real posted invoice and each bill into
-- an approved bill (flagged is_opening, numbered OB-<their number>), so aging,
-- statements, payments, credit notes and revaluation treat them like any
-- other; brings the stock in; and posts everything against Opening balance
-- equity (3900, role opening_balance_equity). A complete trial balance leaves
-- 3900 at nothing — that is the proof nothing is missing (owner decision).
--
-- Finance (administrators, accountants) builds, posts and reverses; managers
-- and accountants read. A posted batch can be reversed until its month is
-- closed (the period guard, 20260910, refuses the reversal after that — owner
-- decision) and only while nothing has used it: no opening invoice or bill
-- paid or credited, no opening unit or bin moved since.
--
-- Opening invoices are not revenue of the new books: the margin view, the
-- report invoice list and the financial and sales report functions leave them
-- out (rewritten in their live definitions, anchors counted). They cannot be
-- voided or cancelled on their own — credit them, or reverse the batch.


-- ── 1. documents know they are opening balances; stock moves can say so ──────
ALTER TABLE public.crm_invoices    ADD COLUMN IF NOT EXISTS is_opening boolean NOT NULL DEFAULT false;
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS is_opening boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.crm_invoices.is_opening IS
  'An open invoice brought in as an opening balance (20260921): posted against opening balance equity, not revenue.';
COMMENT ON COLUMN public.vendor_invoices.is_opening IS
  'An open bill brought in as an opening balance (20260921): posted against opening balance equity.';

ALTER TABLE public.stock_moves DROP CONSTRAINT IF EXISTS stock_moves_doc_type_check;
ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_doc_type_check CHECK (doc_type = ANY (ARRAY[
  'sales_order', 'invoice', 'credit_note', 'manual', 'vendor_invoice', 'rma_ticket', 'manufacturer_batch',
  'goods_receipt', 'customer_return', 'opening_balance']));

-- ── 2. tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.opening_balance_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opening_date    date NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed')),
  notes           text,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  posted_by       text,
  posted_at       timestamptz,
  reversed_by     text,
  reversed_at     timestamptz,
  reverse_reason  text
);
-- one batch being built or in force at a time
CREATE UNIQUE INDEX IF NOT EXISTS opening_balance_batches_one_live_idx
  ON public.opening_balance_batches ((true)) WHERE status IN ('draft', 'posted');

CREATE TABLE IF NOT EXISTS public.opening_balance_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id    uuid NOT NULL REFERENCES public.opening_balance_batches(id) ON DELETE CASCADE,
  line_no     integer NOT NULL,
  account_id  uuid NOT NULL REFERENCES public.gl_accounts(id),
  debit       numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit      numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo        text,
  CHECK ((debit = 0) <> (credit = 0)),
  UNIQUE (batch_id, line_no)
);

CREATE TABLE IF NOT EXISTS public.opening_balance_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           uuid NOT NULL REFERENCES public.opening_balance_batches(id) ON DELETE CASCADE,
  line_no            integer NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('receivable', 'payable')),
  customer_id        uuid REFERENCES public.customers(id),
  vendor_id          uuid REFERENCES public.brands(id),
  doc_no             text NOT NULL,
  doc_date           date NOT NULL,
  due_date           date,
  currency           text NOT NULL,
  exchange_rate      numeric NOT NULL CHECK (exchange_rate > 0),
  amount             numeric(14,2) NOT NULL CHECK (amount > 0),
  notes              text,
  crm_invoice_id     uuid REFERENCES public.crm_invoices(id),
  vendor_invoice_id  uuid REFERENCES public.vendor_invoices(id),
  CHECK ((kind = 'receivable' AND customer_id IS NOT NULL AND vendor_id IS NULL)
      OR (kind = 'payable' AND vendor_id IS NOT NULL AND customer_id IS NULL)),
  UNIQUE (batch_id, kind, line_no)
);

CREATE TABLE IF NOT EXISTS public.opening_balance_stock (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            uuid NOT NULL REFERENCES public.opening_balance_batches(id) ON DELETE CASCADE,
  line_no             integer NOT NULL,
  product_id          uuid NOT NULL REFERENCES public.products(id),
  warehouse_id        uuid NOT NULL REFERENCES public.warehouses(id),
  qty                 integer NOT NULL CHECK (qty > 0),
  unit_cost           numeric(14,4) CHECK (unit_cost >= 0),
  serials             text[] NOT NULL DEFAULT '{}',
  notes               text,
  unit_ids            uuid[] NOT NULL DEFAULT '{}',
  warehouse_stock_id  uuid REFERENCES public.warehouse_stock(id),
  UNIQUE (batch_id, line_no)
);

COMMENT ON TABLE public.opening_balance_batches IS
  'B-03a (20260921): a company''s opening balances, one batch in force at a time; procedure-only.';

ALTER TABLE public.opening_balance_batches   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opening_balance_accounts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opening_balance_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opening_balance_stock     ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.opening_balance_batches, public.opening_balance_accounts,
                    public.opening_balance_documents, public.opening_balance_stock FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.opening_balance_batches,
       public.opening_balance_accounts, public.opening_balance_documents, public.opening_balance_stock FROM authenticated;
GRANT SELECT ON TABLE public.opening_balance_batches, public.opening_balance_accounts,
                      public.opening_balance_documents, public.opening_balance_stock TO authenticated;
GRANT ALL ON TABLE public.opening_balance_batches, public.opening_balance_accounts,
                   public.opening_balance_documents, public.opening_balance_stock TO service_role;
DO $pol$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['opening_balance_batches', 'opening_balance_accounts', 'opening_balance_documents', 'opening_balance_stock'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'read_' || t, t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (COALESCE(public.rma_can_handle_cash(), false))',
                   'read_' || t, t);
  END LOOP;
END $pol$;
DROP TRIGGER IF EXISTS trg_audit_opening_balance_batches ON public.opening_balance_batches;
CREATE TRIGGER trg_audit_opening_balance_batches AFTER INSERT OR DELETE OR UPDATE ON public.opening_balance_batches
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();

-- ── 3. internal helpers ──────────────────────────────────────────────────────
-- money as text: digits with at most two decimals, never negative
CREATE OR REPLACE FUNCTION public._opening_balance_money(p text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT CASE WHEN btrim(COALESCE(p, '')) ~ '^[0-9]+(\.[0-9]{1,2})?$' THEN btrim(p)::numeric END
$fn$;

-- a customer by code or exact name, a supplier by name; NULL unless exactly one
CREATE OR REPLACE FUNCTION public._opening_balance_resolve_party(p_kind text, p_key text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v uuid[]; k text := lower(btrim(COALESCE(p_key, '')));
BEGIN
  IF k = '' THEN RETURN NULL; END IF;
  IF p_kind = 'receivable' THEN
    SELECT array_agg(id) INTO v FROM public.customers WHERE lower(btrim(customer_code)) = k;
    IF COALESCE(cardinality(v), 0) = 0 THEN
      SELECT array_agg(id) INTO v FROM public.customers WHERE lower(btrim(company_name)) = k;
    END IF;
  ELSE
    SELECT array_agg(id) INTO v FROM public.brands WHERE lower(btrim(brand_name)) = k;
  END IF;
  RETURN CASE WHEN cardinality(v) = 1 THEN v[1] END;
END $fn$;

-- a sellable warehouse by code or name; NULL unless exactly one
CREATE OR REPLACE FUNCTION public._opening_balance_resolve_warehouse(p_key text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(w.id))[1] END
    FROM public.warehouses w
   WHERE btrim(COALESCE(p_key, '')) <> ''
     AND (lower(btrim(w.code)) = lower(btrim(p_key)) OR lower(btrim(w.name)) = lower(btrim(p_key)))
$fn$;

CREATE OR REPLACE FUNCTION public._opening_balance_draft(p_batch uuid)
RETURNS public.opening_balance_batches LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v public.opening_balance_batches;
BEGIN
  IF NOT COALESCE(public.rma_is_finance(), false) THEN
    RAISE EXCEPTION 'Only administrators and accountants can enter opening balances.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v FROM public.opening_balance_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Opening balances % not found.', p_batch USING ERRCODE = 'P0001';
  END IF;
  RETURN v;
END $fn$;

-- the three control roles the detail posts, never the trial balance
CREATE OR REPLACE FUNCTION public._opening_balance_control_accounts()
RETURNS TABLE (role text, account_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT r.role, r.account_id FROM public.posting_rules r
   WHERE r.role IN ('accounts_receivable', 'accounts_payable', 'inventory')
$fn$;

-- ── 4. build ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_opening_balance_batch(p_opening_date date, p_notes text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v_id uuid; v_actor text := public.rma_current_user_email();
BEGIN
  IF NOT COALESCE(public.rma_is_finance(), false) THEN
    RAISE EXCEPTION 'Only administrators and accountants can enter opening balances.' USING ERRCODE = '42501';
  END IF;
  IF p_opening_date IS NULL OR p_opening_date > public.rma_today() THEN
    RAISE EXCEPTION 'Give the opening date: the last day of the old books, today or earlier.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.opening_balance_batches WHERE status IN ('draft', 'posted')) THEN
    RAISE EXCEPTION 'Opening balances are already being entered or in force; reverse or delete those first.' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.opening_balance_batches (opening_date, notes, created_by)
  VALUES (p_opening_date, NULLIF(btrim(COALESCE(p_notes, '')), ''), COALESCE(v_actor, 'system'))
  RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION public.delete_opening_balance_batch(p_batch uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v public.opening_balance_batches := public._opening_balance_draft(p_batch);
BEGIN
  IF v.status <> 'draft' THEN
    RAISE EXCEPTION 'Only opening balances not yet posted can be deleted; reverse posted ones.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.opening_balance_batches WHERE id = p_batch;
END $fn$;

-- Replaces one section of a draft with p_rows. Every row is checked; if any is
-- wrong nothing is stored and each wrong row is named (1 = the first row).
-- Returns {"stored": n, "errors": [{"row": i, "error": "..."}]}.
CREATE OR REPLACE FUNCTION public.set_opening_balance_rows(p_batch uuid, p_section text, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_b      public.opening_balance_batches := public._opening_balance_draft(p_batch);
  v_base   text := upper(public.rma_base_currency()::text);
  v_errs   jsonb := '[]'::jsonb;
  v_row    jsonb;
  i        integer := 0;
  v_msg    text;
  -- accounts
  v_acc    public.gl_accounts;
  v_dr     numeric; v_cr numeric;
  -- documents
  v_kind   text; v_party uuid; v_no text; v_date date; v_due date; v_cur text; v_rate numeric; v_amt numeric;
  v_seen   text[] := '{}';
  -- stock
  v_prod   public.products; v_wh uuid; v_qty integer; v_cost numeric; v_sns text[]; v_sn text; v_all_sns text[] := '{}';
  v_out    jsonb := '[]'::jsonb;
BEGIN
  IF v_b.status <> 'draft' THEN
    RAISE EXCEPTION 'These opening balances are % and can no longer change.', v_b.status USING ERRCODE = 'P0001';
  END IF;
  IF p_section NOT IN ('accounts', 'receivables', 'payables', 'stock') THEN
    RAISE EXCEPTION 'Unknown section %: accounts, receivables, payables or stock.', p_section USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Send the rows as a list.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'At most 5 000 rows per section.' USING ERRCODE = '22023';
  END IF;
  v_kind := CASE p_section WHEN 'receivables' THEN 'receivable' WHEN 'payables' THEN 'payable' END;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    i := i + 1;
    v_msg := NULL;

    IF jsonb_typeof(v_row) <> 'object' THEN
      v_msg := 'not a row';

    ELSIF p_section = 'accounts' THEN
      SELECT * INTO v_acc FROM public.gl_accounts WHERE code = btrim(v_row->>'account_code');
      v_dr := public._opening_balance_money(COALESCE(NULLIF(btrim(v_row->>'debit'), ''), '0'));
      v_cr := public._opening_balance_money(COALESCE(NULLIF(btrim(v_row->>'credit'), ''), '0'));
      IF NOT FOUND THEN
        v_msg := format('no account with code %s', COALESCE(v_row->>'account_code', '(blank)'));
      ELSIF NOT v_acc.is_postable OR NOT v_acc.is_active THEN
        v_msg := format('%s is a header or inactive account', v_acc.code);
      ELSIF v_acc.id = (SELECT account_id FROM public.posting_rules WHERE role = 'opening_balance_equity') THEN
        v_msg := format('%s is opening balance equity itself: leave it out, it takes the difference', v_acc.code);
      ELSIF v_dr IS NULL OR v_cr IS NULL THEN
        v_msg := 'debit and credit must be amounts with at most two decimals';
      ELSIF (v_dr = 0) = (v_cr = 0) THEN
        v_msg := 'give either a debit or a credit';
      ELSE
        v_out := v_out || jsonb_build_object('account_id', v_acc.id, 'debit', v_dr, 'credit', v_cr,
                                             'memo', NULLIF(btrim(COALESCE(v_row->>'memo', '')), ''));
      END IF;

    ELSIF p_section IN ('receivables', 'payables') THEN
      v_party := public._opening_balance_resolve_party(v_kind, v_row->>'party');
      v_no    := NULLIF(btrim(COALESCE(v_row->>'doc_no', '')), '');
      v_amt   := public._opening_balance_money(v_row->>'amount');
      v_cur   := upper(COALESCE(NULLIF(btrim(COALESCE(v_row->>'currency', '')), ''), v_base));
      BEGIN
        v_date := CASE WHEN btrim(COALESCE(v_row->>'doc_date', '')) ~ '^\d{4}-\d{2}-\d{2}$' THEN (v_row->>'doc_date')::date END;
        v_due  := CASE WHEN btrim(COALESCE(v_row->>'due_date', '')) = '' THEN NULL
                       WHEN btrim(v_row->>'due_date') ~ '^\d{4}-\d{2}-\d{2}$' THEN (v_row->>'due_date')::date
                       ELSE 'infinity'::date END;
      EXCEPTION WHEN OTHERS THEN v_date := NULL; v_due := 'infinity'::date;
      END;
      v_rate := CASE WHEN v_cur = v_base THEN 1
                     WHEN btrim(COALESCE(v_row->>'exchange_rate', '')) ~ '^[0-9]+(\.[0-9]+)?$' THEN (v_row->>'exchange_rate')::numeric
                     WHEN btrim(COALESCE(v_row->>'exchange_rate', '')) = '' THEN public.rma_exchange_rate(v_cur::character(3), v_b.opening_date)
                END;
      IF v_party IS NULL THEN
        v_msg := format('no single %s matches %s', CASE v_kind WHEN 'receivable' THEN 'customer (code or name)' ELSE 'supplier' END,
                        COALESCE(v_row->>'party', '(blank)'));
      ELSIF v_no IS NULL THEN
        v_msg := 'give the document number';
      ELSIF v_date IS NULL THEN
        v_msg := 'give the document date as YYYY-MM-DD';
      ELSIF v_date > v_b.opening_date THEN
        v_msg := format('dated after the opening date %s', v_b.opening_date);
      ELSIF v_due = 'infinity'::date THEN
        v_msg := 'the due date must be YYYY-MM-DD or blank';
      ELSIF v_amt IS NULL OR v_amt <= 0 THEN
        v_msg := 'the amount must be above zero, with at most two decimals';
      ELSIF v_cur !~ '^[A-Z]{3}$' THEN
        v_msg := format('%s is not a currency code', v_cur);
      ELSIF v_rate IS NULL OR v_rate <= 0 THEN
        v_msg := format('no exchange rate for %s: give one or enter it in Exchange rates', v_cur);
      ELSIF (v_party::text || '|' || lower(v_no)) = ANY (v_seen) THEN
        v_msg := format('%s is listed twice', v_no);
      ELSIF v_kind = 'payable' AND EXISTS (
              SELECT 1 FROM public.vendor_invoices vi
               WHERE vi.vendor_id = v_party AND vi.status <> 'cancelled' AND vi.supplier_invoice_no IS NOT NULL
                 AND public.rma_norm_supplier_no(vi.supplier_invoice_no) = public.rma_norm_supplier_no(v_no)) THEN
        v_msg := format('this supplier''s bill %s is already on file', v_no);
      ELSE
        v_seen := v_seen || (v_party::text || '|' || lower(v_no));
        v_out := v_out || jsonb_build_object('party', v_party, 'doc_no', v_no, 'doc_date', v_date, 'due_date', v_due,
                                             'currency', v_cur, 'exchange_rate', v_rate, 'amount', v_amt,
                                             'notes', NULLIF(btrim(COALESCE(v_row->>'notes', '')), ''));
      END IF;

    ELSE  -- stock
      SELECT * INTO v_prod FROM public.products WHERE lower(btrim(sku)) = lower(btrim(COALESCE(v_row->>'sku', '')));
      v_wh := public._opening_balance_resolve_warehouse(v_row->>'warehouse');
      v_qty := CASE WHEN btrim(COALESCE(v_row->>'qty', '')) ~ '^[0-9]{1,7}$' THEN (v_row->>'qty')::integer END;
      v_cost := CASE WHEN btrim(COALESCE(v_row->>'unit_cost', '')) = '' THEN NULL
                     WHEN btrim(v_row->>'unit_cost') ~ '^[0-9]+(\.[0-9]{1,4})?$' THEN (v_row->>'unit_cost')::numeric
                     ELSE -1 END;
      v_sns := ARRAY(SELECT btrim(x) FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(v_row->'serials') = 'array' THEN v_row->'serials' ELSE '[]'::jsonb END) x
                      WHERE btrim(x) <> '');
      IF v_prod.id IS NULL THEN
        v_msg := format('no product with SKU %s', COALESCE(v_row->>'sku', '(blank)'));
      ELSIF v_prod.product_type = 'service' THEN
        v_msg := format('%s is a service: services have no stock', v_prod.sku);
      ELSIF v_wh IS NULL THEN
        v_msg := format('no single warehouse matches %s', COALESCE(v_row->>'warehouse', '(blank)'));
      ELSIF NOT public._rma_warehouse_is_sellable(v_wh) THEN
        v_msg := format('%s is not a sellable warehouse (main or branch, active)', v_row->>'warehouse');
      ELSIF v_qty IS NULL OR v_qty <= 0 THEN
        v_msg := 'the quantity must be a whole number above zero';
      ELSIF v_cost = -1 THEN
        v_msg := 'the unit cost must be an amount with at most four decimals, or blank if unknown';
      ELSIF v_prod.stock_tracking_mode = 'bulk' AND cardinality(v_sns) > 0 THEN
        v_msg := format('%s is counted in bulk: no serial numbers', v_prod.sku);
      ELSIF v_prod.stock_tracking_mode <> 'bulk' AND cardinality(v_sns) <> v_qty THEN
        v_msg := format('%s is serialized: give %s serial numbers', v_prod.sku, v_qty);
      ELSIF v_prod.stock_tracking_mode <> 'bulk'
        AND (SELECT count(DISTINCT lower(s)) FROM unnest(v_sns) s) <> cardinality(v_sns) THEN
        v_msg := 'a serial number is repeated';
      ELSE
        FOREACH v_sn IN ARRAY v_sns LOOP
          IF lower(v_sn) = ANY (v_all_sns) THEN
            v_msg := format('serial %s is on another row', v_sn);
          ELSIF EXISTS (SELECT 1 FROM public.inventory_units u
                         WHERE lower(u.serial_number) = lower(v_sn) AND u.status <> 'closed') THEN
            v_msg := format('serial %s is already in stock', v_sn);
          END IF;
          EXIT WHEN v_msg IS NOT NULL;
        END LOOP;
        IF v_msg IS NULL THEN
          v_all_sns := v_all_sns || ARRAY(SELECT lower(s) FROM unnest(v_sns) s);
          v_out := v_out || jsonb_build_object('product_id', v_prod.id, 'warehouse_id', v_wh, 'qty', v_qty,
                                               'unit_cost', v_cost, 'serials', to_jsonb(v_sns),
                                               'notes', NULLIF(btrim(COALESCE(v_row->>'notes', '')), ''));
        END IF;
      END IF;
    END IF;

    IF v_msg IS NOT NULL THEN
      v_errs := v_errs || jsonb_build_object('row', i, 'error', v_msg);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_errs) > 0 THEN
    RETURN jsonb_build_object('stored', 0, 'errors', v_errs);
  END IF;

  IF p_section = 'accounts' THEN
    DELETE FROM public.opening_balance_accounts WHERE batch_id = p_batch;
    INSERT INTO public.opening_balance_accounts (batch_id, line_no, account_id, debit, credit, memo)
    SELECT p_batch, o.ord, (o.v->>'account_id')::uuid, (o.v->>'debit')::numeric, (o.v->>'credit')::numeric, o.v->>'memo'
      FROM jsonb_array_elements(v_out) WITH ORDINALITY o(v, ord);
  ELSIF p_section IN ('receivables', 'payables') THEN
    DELETE FROM public.opening_balance_documents WHERE batch_id = p_batch AND kind = v_kind;
    INSERT INTO public.opening_balance_documents
      (batch_id, line_no, kind, customer_id, vendor_id, doc_no, doc_date, due_date, currency, exchange_rate, amount, notes)
    SELECT p_batch, o.ord, v_kind,
           CASE WHEN v_kind = 'receivable' THEN (o.v->>'party')::uuid END,
           CASE WHEN v_kind = 'payable' THEN (o.v->>'party')::uuid END,
           o.v->>'doc_no', (o.v->>'doc_date')::date, (o.v->>'due_date')::date, o.v->>'currency',
           (o.v->>'exchange_rate')::numeric, (o.v->>'amount')::numeric, o.v->>'notes'
      FROM jsonb_array_elements(v_out) WITH ORDINALITY o(v, ord);
  ELSE
    DELETE FROM public.opening_balance_stock WHERE batch_id = p_batch;
    INSERT INTO public.opening_balance_stock (batch_id, line_no, product_id, warehouse_id, qty, unit_cost, serials, notes)
    SELECT p_batch, o.ord, (o.v->>'product_id')::uuid, (o.v->>'warehouse_id')::uuid, (o.v->>'qty')::integer,
           (o.v->>'unit_cost')::numeric, ARRAY(SELECT jsonb_array_elements_text(o.v->'serials')), o.v->>'notes'
      FROM jsonb_array_elements(v_out) WITH ORDINALITY o(v, ord);
  END IF;
  RETURN jsonb_build_object('stored', jsonb_array_length(v_out), 'errors', '[]'::jsonb);
END $fn$;

-- ── 5. the summary: does each control account agree with its detail? ─────────
-- equity_difference is what Opening balance equity would be left holding
-- (debit minus credit); 0 means the trial balance and the detail agree.
CREATE OR REPLACE FUNCTION public.rma_opening_balance_summary(p_batch uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_ar uuid; v_ap uuid; v_inv uuid;
  v_dr numeric; v_cr numeric; v_other numeric; v_tb_ar numeric; v_tb_ap numeric; v_tb_inv numeric;
  v_rec numeric; v_rec_n bigint; v_pay numeric; v_pay_n bigint;
  v_stock numeric; v_stock_n bigint; v_units bigint; v_uncosted bigint;
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Not allowed.' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_ar  FROM public.posting_rules WHERE role = 'accounts_receivable';
  SELECT account_id INTO v_ap  FROM public.posting_rules WHERE role = 'accounts_payable';
  SELECT account_id INTO v_inv FROM public.posting_rules WHERE role = 'inventory';

  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0),
         COALESCE(sum(debit - credit) FILTER (WHERE account_id NOT IN (v_ar, v_ap, v_inv)), 0),
         COALESCE(sum(debit - credit) FILTER (WHERE account_id = v_ar), 0),
         COALESCE(sum(credit - debit) FILTER (WHERE account_id = v_ap), 0),
         COALESCE(sum(debit - credit) FILTER (WHERE account_id = v_inv), 0)
    INTO v_dr, v_cr, v_other, v_tb_ar, v_tb_ap, v_tb_inv
    FROM public.opening_balance_accounts WHERE batch_id = p_batch;

  SELECT COALESCE(sum(round(amount * exchange_rate, 2)) FILTER (WHERE kind = 'receivable'), 0),
         count(*) FILTER (WHERE kind = 'receivable'),
         COALESCE(sum(round(amount * exchange_rate, 2)) FILTER (WHERE kind = 'payable'), 0),
         count(*) FILTER (WHERE kind = 'payable')
    INTO v_rec, v_rec_n, v_pay, v_pay_n
    FROM public.opening_balance_documents WHERE batch_id = p_batch;

  SELECT COALESCE(sum(round(qty * unit_cost, 2)) FILTER (WHERE unit_cost IS NOT NULL), 0), count(*),
         COALESCE(sum(qty), 0), COALESCE(sum(qty) FILTER (WHERE unit_cost IS NULL), 0)
    INTO v_stock, v_stock_n, v_units, v_uncosted
    FROM public.opening_balance_stock WHERE batch_id = p_batch;

  RETURN jsonb_build_object(
    'accounts', jsonb_build_object('rows', (SELECT count(*) FROM public.opening_balance_accounts WHERE batch_id = p_batch),
                                   'debit', v_dr, 'credit', v_cr),
    'tb_balanced', v_dr = v_cr,
    'receivables', jsonb_build_object('rows', v_rec_n, 'total_base', v_rec, 'trial_balance', v_tb_ar, 'difference', v_rec - v_tb_ar),
    'payables', jsonb_build_object('rows', v_pay_n, 'total_base', v_pay, 'trial_balance', v_tb_ap, 'difference', v_pay - v_tb_ap),
    'stock', jsonb_build_object('rows', v_stock_n, 'units', v_units, 'uncosted_units', v_uncosted,
                                'known_cost', v_stock, 'trial_balance', v_tb_inv, 'difference', v_stock - v_tb_inv),
    'other_accounts_net', v_other,
    'equity_difference', -(v_other + v_rec - v_pay + v_stock),
    'currency', public.rma_base_currency());
END $fn$;

-- ── 6. post ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_opening_balances(p_batch uuid)
RETURNS public.opening_balance_batches LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_b      public.opening_balance_batches := public._opening_balance_draft(p_batch);
  v_actor  text := COALESCE(public.rma_current_user_email(), 'system');
  v_d      date;
  v_lines  jsonb;
  v_other  numeric;
  v_r      record;
  v_code   text; v_n integer;
  v_id     uuid; v_base numeric;
  v_ws     uuid; v_unit uuid; v_sn text; v_units uuid[];
  v_stock  numeric := 0;
BEGIN
  IF v_b.status <> 'draft' THEN
    RAISE EXCEPTION 'These opening balances are already %.', v_b.status USING ERRCODE = 'P0001';
  END IF;
  v_d := v_b.opening_date;
  IF NOT EXISTS (SELECT 1 FROM public.opening_balance_accounts WHERE batch_id = p_batch)
     AND NOT EXISTS (SELECT 1 FROM public.opening_balance_documents WHERE batch_id = p_batch)
     AND NOT EXISTS (SELECT 1 FROM public.opening_balance_stock WHERE batch_id = p_batch) THEN
    RAISE EXCEPTION 'Nothing to post: enter at least one section first.' USING ERRCODE = 'P0001';
  END IF;

  -- a) the trial balance, without the control accounts the detail posts
  SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id', a.account_id, 'debit', a.debit, 'credit', a.credit,
                                               'memo', a.memo) ORDER BY a.line_no), '[]'::jsonb),
         COALESCE(sum(a.debit - a.credit), 0)
    INTO v_lines, v_other
    FROM public.opening_balance_accounts a
   WHERE a.batch_id = p_batch
     AND a.account_id NOT IN (SELECT account_id FROM public._opening_balance_control_accounts());
  IF jsonb_array_length(v_lines) > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('role', 'opening_balance_equity',
                 'debit', GREATEST(-v_other, 0), 'credit', GREATEST(v_other, 0)));
    PERFORM public._gl_post('opening_balance', p_batch, 'trial_balance', v_d, 'Opening balances',
                            'Opening trial balance at ' || v_d, v_lines);
  END IF;

  -- b) each open invoice / bill becomes a real document with its own entry
  PERFORM set_config('rma.opening_post', 'on', true);
  FOR v_r IN SELECT * FROM public.opening_balance_documents WHERE batch_id = p_batch ORDER BY kind, line_no LOOP
    v_base := round(v_r.amount * v_r.exchange_rate, 2);
    v_code := 'OB-' || v_r.doc_no; v_n := 1;
    IF v_r.kind = 'receivable' THEN
      WHILE EXISTS (SELECT 1 FROM public.crm_invoices WHERE inv_code = v_code) LOOP
        v_n := v_n + 1; v_code := 'OB-' || v_r.doc_no || '-' || v_n;
      END LOOP;
      INSERT INTO public.crm_invoices
        (inv_code, customer_id, doc_status, payment_status, line_items, subtotal, discount_amount, tax_amount, total,
         amount_paid, due_date, notes, created_by, posted_at, currency, exchange_rate, is_opening)
      VALUES (v_code, v_r.customer_id, 'posted', 'unpaid', '[]'::jsonb, v_r.amount, 0, 0, v_r.amount,
              0, COALESCE(v_r.due_date, v_r.doc_date),
              concat_ws(' — ', 'Opening balance: invoice ' || v_r.doc_no || ' of ' || v_r.doc_date, v_r.notes),
              v_actor, (v_r.doc_date + time '12:00') AT TIME ZONE 'UTC', v_r.currency, v_r.exchange_rate, true)
      RETURNING id INTO v_id;
      UPDATE public.opening_balance_documents SET crm_invoice_id = v_id WHERE id = v_r.id;
      PERFORM public._gl_post('crm_invoice', v_id, 'opening', v_d, v_code, 'Opening balance: invoice ' || v_r.doc_no,
        jsonb_build_array(
          jsonb_build_object('role', 'accounts_receivable', 'debit', v_base, 'customer_id', v_r.customer_id),
          jsonb_build_object('role', 'opening_balance_equity', 'credit', v_base)));
    ELSE
      WHILE EXISTS (SELECT 1 FROM public.vendor_invoices WHERE vi_code = v_code) LOOP
        v_n := v_n + 1; v_code := 'OB-' || v_r.doc_no || '-' || v_n;
      END LOOP;
      INSERT INTO public.vendor_invoices
        (vi_code, vendor_id, status, line_items, subtotal, discount_amount, tax_amount, total, invoice_date, due_date,
         notes, created_by, approved_at, approved_by, currency, exchange_rate,
         supplier_invoice_no, supplier_invoice_date, non_po_reason, is_opening)
      VALUES (v_code, v_r.vendor_id, 'approved', '[]'::jsonb, v_r.amount, 0, 0, v_r.amount, v_r.doc_date,
              COALESCE(v_r.due_date, v_r.doc_date),
              concat_ws(' — ', 'Opening balance: bill ' || v_r.doc_no || ' of ' || v_r.doc_date, v_r.notes),
              v_actor, (v_r.doc_date + time '12:00') AT TIME ZONE 'UTC', v_actor, v_r.currency, v_r.exchange_rate,
              v_r.doc_no, v_r.doc_date, 'Opening balance brought in from the previous books', true)
      RETURNING id INTO v_id;
      UPDATE public.opening_balance_documents SET vendor_invoice_id = v_id WHERE id = v_r.id;
      PERFORM public._gl_post('vendor_invoice', v_id, 'opening', v_d, v_code, 'Opening balance: bill ' || v_r.doc_no,
        jsonb_build_array(
          jsonb_build_object('role', 'opening_balance_equity', 'debit', v_base),
          jsonb_build_object('role', 'accounts_payable', 'credit', v_base, 'vendor_id', v_r.vendor_id)));
    END IF;
  END LOOP;
  PERFORM set_config('rma.opening_post', 'off', true);

  -- c) stock, at its cost (blank = unknown, never zero)
  FOR v_r IN
    SELECT s.*, p.product_name, p.stock_tracking_mode
      FROM public.opening_balance_stock s JOIN public.products p ON p.id = s.product_id
     WHERE s.batch_id = p_batch ORDER BY s.line_no
  LOOP
    IF v_r.stock_tracking_mode = 'bulk' THEN
      PERFORM set_config('rma.cost_stated', 'on', true);
      SELECT id INTO v_ws FROM public.warehouse_stock
       WHERE product_id = v_r.product_id AND warehouse_id = v_r.warehouse_id FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
        VALUES (v_r.product_id, v_r.warehouse_id, v_r.qty, 0,
                CASE WHEN v_r.unit_cost IS NULL THEN 0 ELSE round(v_r.unit_cost * v_r.qty, 4) END,
                CASE WHEN v_r.unit_cost IS NULL THEN v_r.qty ELSE 0 END)
        RETURNING id INTO v_ws;
      ELSIF v_r.unit_cost IS NULL THEN
        UPDATE public.warehouse_stock
           SET quantity = quantity + v_r.qty, uncosted_quantity = uncosted_quantity + v_r.qty, updated_at = now()
         WHERE id = v_ws;
      ELSE
        UPDATE public.warehouse_stock
           SET quantity = quantity + v_r.qty, total_cost_base = total_cost_base + round(v_r.unit_cost * v_r.qty, 4), updated_at = now()
         WHERE id = v_ws;
      END IF;
      INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
      VALUES ('warehouse_stock', v_ws, 'opening_balance', p_batch, 'receive', v_r.qty, NULL, 'available', v_actor);
      PERFORM set_config('rma.cost_stated', 'off', true);
      UPDATE public.opening_balance_stock SET warehouse_stock_id = v_ws WHERE id = v_r.id;
    ELSE
      v_units := '{}';
      FOREACH v_sn IN ARRAY v_r.serials LOOP
        BEGIN
          INSERT INTO public.inventory_units
            (product_id, product_name, serial_number, status, reservation_status, warehouse_id, unit_cost_base, created_date)
          VALUES (v_r.product_id, v_r.product_name, v_sn, 'company_stock', 'available', v_r.warehouse_id, v_r.unit_cost, now())
          RETURNING id INTO v_unit;
        EXCEPTION WHEN unique_violation THEN
          RAISE EXCEPTION 'Serial number % is already in use', v_sn USING ERRCODE = 'P0001';
        END;
        INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
        VALUES ('unit', v_unit, 'opening_balance', p_batch, 'receive', 1, NULL, 'available', v_actor);
        v_units := v_units || v_unit;
      END LOOP;
      UPDATE public.opening_balance_stock SET unit_ids = v_units WHERE id = v_r.id;
    END IF;
    IF v_r.unit_cost IS NOT NULL THEN
      v_stock := v_stock + round(v_r.unit_cost * v_r.qty, 2);
    END IF;
  END LOOP;
  IF v_stock > 0 THEN
    PERFORM public._gl_post('opening_balance', p_batch, 'stock', v_d, 'Opening balances', 'Opening stock at cost',
      jsonb_build_array(jsonb_build_object('role', 'inventory', 'debit', v_stock),
                        jsonb_build_object('role', 'opening_balance_equity', 'credit', v_stock)));
  END IF;

  UPDATE public.opening_balance_batches SET status = 'posted', posted_by = v_actor, posted_at = now()
   WHERE id = p_batch RETURNING * INTO v_b;
  RETURN v_b;
END $fn$;

-- ── 7. reverse ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reverse_opening_balances(p_batch uuid, p_reason text)
RETURNS public.opening_balance_batches LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_b      public.opening_balance_batches := public._opening_balance_draft(p_batch);
  v_actor  text := COALESCE(public.rma_current_user_email(), 'system');
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_bad    text;
  v_r      record;
  v_known  numeric;
BEGIN
  IF v_b.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted opening balances can be reversed; these are %.', v_b.status USING ERRCODE = 'P0001';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Say why they are reversed (at least 10 characters).' USING ERRCODE = 'P0001';
  END IF;

  -- nothing may have used them
  SELECT string_agg(COALESCE(i.inv_code, vi.vi_code), ', ') INTO v_bad
    FROM public.opening_balance_documents d
    LEFT JOIN public.crm_invoices i ON i.id = d.crm_invoice_id
    LEFT JOIN public.vendor_invoices vi ON vi.id = d.vendor_invoice_id
   WHERE d.batch_id = p_batch
     AND (COALESCE(i.amount_paid, 0) <> 0 OR COALESCE(vi.amount_paid, 0) <> 0
          OR EXISTS (SELECT 1 FROM public.credit_notes cn WHERE cn.source_invoice_id = d.crm_invoice_id
                        AND cn.status NOT IN ('voided', 'draft')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Already paid or credited, so the opening balances can no longer be reversed: %. Undo those first.', v_bad
      USING ERRCODE = 'P0001';
  END IF;
  SELECT string_agg(DISTINCT p.sku, ', ') INTO v_bad
    FROM public.opening_balance_stock s JOIN public.products p ON p.id = s.product_id
   WHERE s.batch_id = p_batch
     AND (EXISTS (SELECT 1 FROM unnest(s.unit_ids) u(id) JOIN public.inventory_units iu ON iu.id = u.id
                   WHERE iu.status <> 'company_stock' OR iu.reservation_status <> 'available'
                      OR iu.warehouse_id IS DISTINCT FROM s.warehouse_id)
          OR EXISTS (SELECT 1 FROM public.stock_moves m
                      WHERE ((m.ref_type = 'unit' AND m.ref_id = ANY (s.unit_ids))
                          OR (m.ref_type = 'warehouse_stock' AND m.ref_id = s.warehouse_stock_id))
                        AND m.doc_id IS DISTINCT FROM p_batch
                        AND m.created_at >= v_b.posted_at));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Opening stock has moved since, so the opening balances can no longer be reversed: %.', v_bad
      USING ERRCODE = 'P0001';
  END IF;

  -- the documents, then their entries
  PERFORM set_config('rma.opening_reverse', 'on', true);
  FOR v_r IN SELECT * FROM public.opening_balance_documents WHERE batch_id = p_batch LOOP
    IF v_r.crm_invoice_id IS NOT NULL THEN
      UPDATE public.crm_invoices SET doc_status = 'cancelled', void_reason = 'Opening balances reversed: ' || v_reason, updated_at = now()
       WHERE id = v_r.crm_invoice_id;
      PERFORM public._gl_reverse('crm_invoice', v_r.crm_invoice_id, 'opening', 'opening_reversed', v_b.opening_date,
                                 'Opening balances reversed: ' || v_reason);
    ELSE
      UPDATE public.vendor_invoices SET status = 'cancelled', updated_at = now() WHERE id = v_r.vendor_invoice_id;
      PERFORM public._gl_reverse('vendor_invoice', v_r.vendor_invoice_id, 'opening', 'opening_reversed', v_b.opening_date,
                                 'Opening balances reversed: ' || v_reason);
    END IF;
  END LOOP;
  PERFORM set_config('rma.opening_reverse', 'off', true);

  -- the stock goes out again, at the cost it came in at
  FOR v_r IN SELECT * FROM public.opening_balance_stock WHERE batch_id = p_batch LOOP
    IF v_r.warehouse_stock_id IS NOT NULL THEN
      PERFORM set_config('rma.cost_stated', 'on', true);
      UPDATE public.warehouse_stock
         SET quantity = quantity - v_r.qty,
             total_cost_base = CASE WHEN v_r.unit_cost IS NULL THEN total_cost_base
                                    ELSE GREATEST(total_cost_base - round(v_r.unit_cost * v_r.qty, 4), 0) END,
             uncosted_quantity = CASE WHEN v_r.unit_cost IS NULL THEN GREATEST(uncosted_quantity - v_r.qty, 0) ELSE uncosted_quantity END,
             updated_at = now()
       WHERE id = v_r.warehouse_stock_id;
      INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
      VALUES ('warehouse_stock', v_r.warehouse_stock_id, 'opening_balance', p_batch, 'adjust', v_r.qty, 'available', NULL, v_actor);
      PERFORM set_config('rma.cost_stated', 'off', true);
    ELSE
      UPDATE public.inventory_units SET status = 'closed' WHERE id = ANY (v_r.unit_ids);
      INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
      SELECT 'unit', u, 'opening_balance', p_batch, 'adjust', 1, 'available', 'closed', v_actor FROM unnest(v_r.unit_ids) u;
    END IF;
  END LOOP;

  PERFORM public._gl_reverse('opening_balance', p_batch, 'trial_balance', 'trial_balance_reversed', v_b.opening_date,
                             'Opening balances reversed: ' || v_reason);
  PERFORM public._gl_reverse('opening_balance', p_batch, 'stock', 'stock_reversed', v_b.opening_date,
                             'Opening stock reversed: ' || v_reason);

  UPDATE public.opening_balance_batches
     SET status = 'reversed', reversed_by = v_actor, reversed_at = now(), reverse_reason = v_reason
   WHERE id = p_batch RETURNING * INTO v_b;
  RETURN v_b;
END $fn$;

-- ── 8. an opening document is not voided or cancelled on its own ─────────────
CREATE OR REPLACE FUNCTION public.rma_guard_opening_document()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF current_setting('rma.opening_reverse', true) = 'on' OR current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'crm_invoices' THEN
    IF OLD.is_opening AND NEW.doc_status IS DISTINCT FROM OLD.doc_status THEN
      RAISE EXCEPTION 'An opening-balance invoice is not voided on its own: credit it with a credit note, or reverse the opening balances.'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.is_opening AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'An opening-balance bill is not cancelled on its own: reverse the opening balances.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.is_opening IS DISTINCT FROM OLD.is_opening THEN
    RAISE EXCEPTION 'Whether a document is an opening balance cannot change.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_crm_invoices_opening ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_opening BEFORE UPDATE OF doc_status, is_opening ON public.crm_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_opening_document();
DROP TRIGGER IF EXISTS trg_vendor_invoices_opening ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_opening BEFORE UPDATE OF status, is_opening ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_opening_document();

-- ── 9. opening invoices are not revenue of the new books ─────────────────────
DO $rw$
DECLARE
  v_def text; v_anchor text; v_n integer;
BEGIN
  -- v_invoice_margin
  v_def := replace(pg_get_viewdef('public.v_invoice_margin'::regclass, true), E'\r\n', E'\n');
  v_anchor := 'WHERE i.doc_status = ''posted''::text) m';
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN RAISE EXCEPTION 'v_invoice_margin: anchor found % times', v_n; END IF;
  v_def := replace(v_def, v_anchor, 'WHERE i.doc_status = ''posted''::text AND NOT i.is_opening) m');
  EXECUTE 'CREATE OR REPLACE VIEW public.v_invoice_margin WITH (security_invoker = true) AS ' || rtrim(v_def, E'; \n');

  -- v_report_invoices: the Financial report's invoice list
  v_def := rtrim(replace(pg_get_viewdef('public.v_report_invoices'::regclass, true), E'\r\n', E'\n'), E'; \n');
  IF v_def ~* '\mWHERE\M' THEN RAISE EXCEPTION 'v_report_invoices: it already has a WHERE; rewrite by hand'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_report_invoices WITH (security_invoker = true) AS ' || v_def
          || E'\n  WHERE NOT i.is_opening';

  -- rma_report_financial
  SELECT replace(pg_get_functiondef(p.oid), E'\r\n', E'\n') INTO v_def FROM pg_proc p
   WHERE p.oid = 'public.rma_report_financial(timestamptz, timestamptz)'::regprocedure;
  v_anchor := E'WHERE doc_status = ''posted''\n';
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN RAISE EXCEPTION 'rma_report_financial: anchor found % times', v_n; END IF;
  EXECUTE replace(v_def, v_anchor, E'WHERE doc_status = ''posted'' AND NOT is_opening\n');

  -- rma_report_sales: the invoices raised in the period
  SELECT replace(pg_get_functiondef(p.oid), E'\r\n', E'\n') INTO v_def FROM pg_proc p
   WHERE p.proname = 'rma_report_sales' AND p.pronamespace = 'public'::regnamespace;
  v_anchor := 'WHERE i.created_at IS NOT NULL AND i.created_at >= p_from AND i.created_at <= p_to AND i.doc_status IS DISTINCT FROM ''cancelled''';
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN RAISE EXCEPTION 'rma_report_sales: anchor found % times', v_n; END IF;
  EXECUTE replace(v_def, v_anchor, v_anchor || ' AND NOT i.is_opening');

  -- every one of them now says so
  IF pg_get_viewdef('public.v_invoice_margin'::regclass) NOT LIKE '%is_opening%'
     OR pg_get_viewdef('public.v_report_invoices'::regclass) NOT LIKE '%is_opening%'
     OR (SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.proname = 'rma_report_financial') NOT LIKE '%is_opening%'
     OR (SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.proname = 'rma_report_sales') NOT LIKE '%is_opening%' THEN
    RAISE EXCEPTION 'A report still counts opening invoices';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE relname IN ('v_invoice_margin', 'v_report_invoices')
         AND 'security_invoker=true' = ANY (reloptions)) <> 2 THEN
    RAISE EXCEPTION 'A replaced view lost security_invoker';
  END IF;
END $rw$;

-- ── 10. grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._opening_balance_money(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._opening_balance_resolve_party(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._opening_balance_resolve_warehouse(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._opening_balance_draft(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._opening_balance_control_accounts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_guard_opening_document() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._opening_balance_money(text), public._opening_balance_resolve_party(text, text),
  public._opening_balance_resolve_warehouse(text), public._opening_balance_draft(uuid),
  public._opening_balance_control_accounts() TO service_role;

REVOKE ALL ON FUNCTION public.create_opening_balance_batch(date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_opening_balance_batch(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_opening_balance_rows(uuid, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rma_opening_balance_summary(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_opening_balances(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_opening_balances(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_opening_balance_batch(date, text), public.delete_opening_balance_batch(uuid),
  public.set_opening_balance_rows(uuid, text, jsonb), public.rma_opening_balance_summary(uuid),
  public.post_opening_balances(uuid), public.reverse_opening_balances(uuid, text) TO authenticated, service_role;

-- ── 11. Backup & Restore: the batch after the bank statements ────────────────
CREATE OR REPLACE FUNCTION public.rma_restore_manifest()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'currencies', 'countries', 'country_area_codes', 'rma_config', 'gl_accounts', 'posting_rules',
    'tax_codes', 'tax_code_rates', 'exchange_rates',
    'brands', 'categories',
    'subcategories', 'warehouses', 'pipelines', 'parts', 'custom_field_definitions',
    'custom_roles', 'user_roles', 'user_preferences', 'announcements', 'kb_articles',
    'branding_settings', 'email_templates', 'whatsapp_templates', 'notification_settings',
    'notification_preferences', 'products', 'product_images', 'product_documents',
    'company_documents', 'customers', 'contacts', 'customer_notes', 'deals', 'leads',
    'rma_tickets', 'ticket_comments', 'ticket_activity', 'ticket_parts', 'ticket_resolutions',
    'time_entries', 'purchase_orders', 'purchase_order_lines', 'vendor_invoices',
    'vendor_invoice_lines', 'vendor_invoice_charges', 'vendor_payments',
    'vendor_payment_applications', 'goods_receipts', 'goods_receipt_lines',
    'vendor_invoice_receipt_lines', 'purchase_cost_adjustments', 'manufacturer_batches',
    'inventory_units', 'warehouse_stock', 'goods_receipt_line_units', 'goods_receipt_line_bins',
    'quotations', 'quotation_lines', 'sales_orders', 'sales_order_lines', 'deliveries',
    'delivery_lines', 'delivery_line_units', 'delivery_line_bins', 'customer_returns',
    'customer_return_lines', 'customer_return_line_units', 'customer_return_line_bins',
    'crm_invoices', 'crm_invoice_lines', 'invoices', 'payments', 'payment_applications',
    'credit_notes', 'credit_note_lines', 'credit_note_applications', 'customer_refunds',
    'journal_entries', 'journal_lines', 'accounting_periods', 'period_reopen_requests',
    'fx_revaluations', 'fx_revaluation_lines', 'bank_statements', 'bank_statement_lines',
    'opening_balance_batches', 'opening_balance_accounts', 'opening_balance_documents', 'opening_balance_stock',
    'activities', 'notifications', 'user_activity_log'
  ]::text[]
$function$;

