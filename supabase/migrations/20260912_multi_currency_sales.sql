-- ############################################################################
-- #  20260912 — foreign currency on sales documents; realised exchange
-- #  differences on customers and suppliers (A-05a, S-20 / P-14)
-- #
-- #  Owner decisions (2026-09-28):
-- #    · rates come from a table finance keeps, and a document's rate can be
-- #      changed until it is posted (by whoever may edit the document);
-- #    · a customer has a default currency, which a new document starts in;
-- #    · realised gains and losses now; month-end revaluation comes with the
-- #      financial reports (A-08).
-- #
-- #  1. exchange_rates (finance writes) and rma_exchange_rate(currency, date):
-- #     the latest rate on or before the date; the base currency is 1.
-- #  2. customers.currency — a customer's default.
-- #  3. currency + exchange_rate on quotations, sales orders, invoices, credit
-- #     notes, payments and refunds. A BEFORE INSERT trigger fills them: from the
-- #     document it comes from (order ← quotation, invoice ← order, credit note ←
-- #     invoice, refund ← credit note / payment), else the customer's default;
-- #     the rate from the table (a credit note and a refund take their source's
-- #     rate, so they reverse exactly what was booked). No rate on file for a
-- #     foreign currency refuses the document with a readable message. Amounts on
-- #     the documents stay in the document's currency.
-- #  4. set_document_currency(type, id, currency, rate) changes a draft's
-- #     currency or rate (the document's author; the rules of its update RPC).
-- #     record_payment takes an optional currency and rate.
-- #  5. A payment or credit note settles only invoices in its own currency.
-- #  6. The ledger posts in the base currency: invoices, credit notes, payments
-- #     and refunds at their own rate. Applying a payment or credit note to an
-- #     invoice booked at another rate posts the difference to exchange gains or
-- #     losses — for supplier payments too, whose difference stayed in payables
-- #     until now. The VAT return converts output tax at each document's rate.
-- #
-- #  Not here (A-05b): the screens, and customer statements / aging in base.
-- #  Pinned by src/test/multiCurrencySales.test.js; supabase/tests/
-- #  multi_currency_sales.sql is the rolled-back reference script.
-- ############################################################################

-- ── 0. the base currency ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_base_currency()
RETURNS char(3) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT COALESCE(
    (SELECT upper(btrim(config_value #>> '{}'))::char(3) FROM public.rma_config
      WHERE config_key = 'default_currency' AND btrim(config_value #>> '{}') ~* '^[a-z]{3}$'),
    'EGP')::char(3)
$fn$;
REVOKE ALL ON FUNCTION public.rma_base_currency() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_base_currency() TO authenticated, service_role;

-- ── 1. exchange rates ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.exchange_rates (
  currency   char(3) NOT NULL REFERENCES public.currencies(code),
  rate_date  date NOT NULL,
  rate       numeric(18,8) NOT NULL CHECK (rate > 0),
  note       text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (currency, rate_date)
);
COMMENT ON TABLE public.exchange_rates IS
  'Base-currency units per one unit of the currency, from a date (A-05). The rate for a day is the latest on or before it. Written by administrators and accountants.';
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.exchange_rates FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.exchange_rates FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.exchange_rates TO authenticated;
GRANT ALL ON TABLE public.exchange_rates TO service_role;
DROP POLICY IF EXISTS "read_exchange_rates" ON public.exchange_rates;
CREATE POLICY "read_exchange_rates" ON public.exchange_rates FOR SELECT USING (COALESCE(public.rma_is_staff(), false));
DROP POLICY IF EXISTS "finance_write_exchange_rates" ON public.exchange_rates;
CREATE POLICY "finance_write_exchange_rates" ON public.exchange_rates FOR ALL
  USING (COALESCE(public.rma_is_finance(), false)) WITH CHECK (COALESCE(public.rma_is_finance(), false));
DROP TRIGGER IF EXISTS trg_audit_exchange_rates ON public.exchange_rates;
CREATE TRIGGER trg_audit_exchange_rates AFTER INSERT OR DELETE OR UPDATE ON public.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();
DROP TRIGGER IF EXISTS trg_audit_truncate_exchange_rates ON public.exchange_rates;
CREATE TRIGGER trg_audit_truncate_exchange_rates AFTER TRUNCATE ON public.exchange_rates
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_truncate();

CREATE OR REPLACE FUNCTION public.rma_guard_exchange_rate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.currency = public.rma_base_currency() THEN
    RAISE EXCEPTION '% is the base currency: its rate is always 1.', NEW.currency USING ERRCODE = 'P0001';
  END IF;
  NEW.created_by := COALESCE(public.rma_current_user_email(), NEW.created_by);
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_guard_exchange_rate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_exchange_rates_guard ON public.exchange_rates;
CREATE TRIGGER trg_exchange_rates_guard BEFORE INSERT OR UPDATE ON public.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_exchange_rate();

CREATE OR REPLACE FUNCTION public.rma_exchange_rate(p_currency char, p_date date DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT CASE WHEN upper(p_currency) = public.rma_base_currency() THEN 1::numeric
              ELSE (SELECT r.rate FROM public.exchange_rates r
                     WHERE r.currency = upper(p_currency) AND r.rate_date <= COALESCE(p_date, public.rma_today())
                     ORDER BY r.rate_date DESC LIMIT 1) END
$fn$;
REVOKE ALL ON FUNCTION public.rma_exchange_rate(char, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_exchange_rate(char, date) TO authenticated, service_role;

-- ── 2. a customer's default currency ─────────────────────────────────────────
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS currency char(3) REFERENCES public.currencies(code);

-- ── 3. currency and rate on the sales side ───────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotations', 'sales_orders', 'crm_invoices', 'credit_notes', 'payments', 'customer_refunds'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS currency char(3) REFERENCES public.currencies(code)', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8)', t);
    -- every document written so far is in the base currency
    EXECUTE format('UPDATE public.%I SET currency = public.rma_base_currency() WHERE currency IS NULL', t);
    EXECUTE format('UPDATE public.%I SET exchange_rate = 1 WHERE exchange_rate IS NULL', t);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN currency SET NOT NULL', t);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN exchange_rate SET NOT NULL', t);
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_exchange_rate_positive');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (exchange_rate > 0)', t, t || '_exchange_rate_positive');
  END LOOP;
END $$;

-- The currency and rate a new document takes.
CREATE OR REPLACE FUNCTION public.rma_doc_currency_defaults()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_base  char(3) := public.rma_base_currency();
  v_cur   char(3);
  v_rate  numeric;
  v_date  date := public.rma_today();
  v_fixed boolean := false;   -- the rate is the source's, not the table's
  v_row   jsonb;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    -- a restore writes rows as they were; one from a backup taken before this
    -- migration has no currency, and was in the base currency
    NEW.currency := COALESCE(NEW.currency, v_base);
    NEW.exchange_rate := COALESCE(NEW.exchange_rate, 1);
    RETURN NEW;
  END IF;
  -- where the document comes from (read through jsonb: each table has its own
  -- link columns, and a plpgsql field reference fails on a table without it)
  v_row := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'sales_orders' AND v_row->>'quotation_id' IS NOT NULL THEN
    SELECT currency, exchange_rate INTO v_cur, v_rate FROM public.quotations WHERE id = (v_row->>'quotation_id')::uuid;
    v_fixed := true;
  ELSIF TG_TABLE_NAME = 'crm_invoices' AND v_row->>'so_id' IS NOT NULL THEN
    SELECT currency INTO v_cur FROM public.sales_orders WHERE id = (v_row->>'so_id')::uuid;   -- the invoice's own rate: its day
  ELSIF TG_TABLE_NAME = 'credit_notes' AND v_row->>'source_invoice_id' IS NOT NULL THEN
    SELECT currency, exchange_rate INTO v_cur, v_rate FROM public.crm_invoices WHERE id = (v_row->>'source_invoice_id')::uuid;
    v_fixed := true;
  ELSIF TG_TABLE_NAME = 'customer_refunds' THEN
    IF v_row->>'credit_note_id' IS NOT NULL THEN
      SELECT currency, exchange_rate INTO v_cur, v_rate FROM public.credit_notes WHERE id = (v_row->>'credit_note_id')::uuid;
    ELSE
      SELECT currency, exchange_rate INTO v_cur, v_rate FROM public.payments WHERE id = (v_row->>'payment_id')::uuid;
    END IF;
    v_fixed := true;
  END IF;
  IF TG_TABLE_NAME = 'payments' THEN
    v_date := COALESCE((v_row->>'payment_date')::date, v_date);
  END IF;

  IF v_fixed THEN
    -- a derived document is always in its source's currency and at its rate
    NEW.currency := COALESCE(v_cur, NEW.currency, v_base);
    NEW.exchange_rate := COALESCE(v_rate, NEW.exchange_rate, 1);
  ELSE
    NEW.currency := upper(COALESCE(NEW.currency, v_cur,
                                   (SELECT c.currency FROM public.customers c WHERE c.id = NEW.customer_id), v_base));
  END IF;
  IF NEW.currency = v_base THEN
    NEW.exchange_rate := 1;
  ELSIF NEW.exchange_rate IS NULL THEN
    NEW.exchange_rate := public.rma_exchange_rate(NEW.currency, v_date);
    IF NEW.exchange_rate IS NULL THEN
      RAISE EXCEPTION 'There is no exchange rate for % on or before %. Add one in Accounting › Exchange rates, or give the rate on the document.',
        NEW.currency, v_date USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_doc_currency_defaults() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotations', 'sales_orders', 'crm_invoices', 'credit_notes', 'payments', 'customer_refunds'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_currency ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_currency BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.rma_doc_currency_defaults()', t, t);
  END LOOP;
END $$;

-- ── 4. changing a draft's currency or rate ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_document_currency(p_doc_type text, p_id uuid, p_currency text, p_rate numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_me     text := public.rma_current_user_email();
  v_tbl    text;
  v_status text;
  v_owner  boolean;
  v_cur    char(3);
  v_new    char(3) := upper(btrim(COALESCE(p_currency, '')));
  v_rate   numeric;
  v_locked text;
  v_doc    record;
BEGIN
  v_tbl := CASE p_doc_type WHEN 'quotation' THEN 'quotations' WHEN 'sales_order' THEN 'sales_orders'
                           WHEN 'invoice' THEN 'crm_invoices' WHEN 'credit_note' THEN 'credit_notes' END;
  IF v_tbl IS NULL THEN
    RAISE EXCEPTION 'Unknown document type %.', p_doc_type USING ERRCODE = '22023';
  END IF;
  EXECUTE format('SELECT * FROM public.%I WHERE id = $1 FOR UPDATE', v_tbl) INTO v_doc USING p_id;
  IF v_doc IS NULL THEN
    RAISE EXCEPTION 'That document does not exist.' USING ERRCODE = 'P0001';
  END IF;
  -- who may edit it: the rules of its update RPC (20260781 / 20260847)
  v_owner := COALESCE(lower(to_jsonb(v_doc)->>'assigned_rep') = lower(v_me) OR lower(to_jsonb(v_doc)->>'created_by') = lower(v_me), false);
  IF NOT COALESCE(public.rma_is_manager_or_above()
                  OR (p_doc_type <> 'credit_note' AND public.rma_user_role() = 'sales_rep' AND v_owner), false) THEN
    RAISE EXCEPTION 'Not authorized to change this document''s currency.' USING ERRCODE = '42501';
  END IF;
  v_status := CASE WHEN p_doc_type = 'invoice' THEN to_jsonb(v_doc)->>'doc_status' ELSE to_jsonb(v_doc)->>'status' END;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Only a draft''s currency or rate can change.' USING ERRCODE = 'P0001';
  END IF;
  v_cur := (to_jsonb(v_doc)->>'currency')::char(3);
  IF v_new = '' THEN v_new := v_cur; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = v_new AND is_active) THEN
    RAISE EXCEPTION 'Unknown or inactive currency %.', v_new USING ERRCODE = 'P0001';
  END IF;
  -- a document made from another keeps its currency (and a credit note its rate)
  v_locked := CASE
    WHEN p_doc_type = 'sales_order' AND to_jsonb(v_doc)->>'quotation_id' IS NOT NULL THEN 'currency'
    WHEN p_doc_type = 'invoice' AND to_jsonb(v_doc)->>'so_id' IS NOT NULL THEN 'currency'
    WHEN p_doc_type = 'credit_note' AND to_jsonb(v_doc)->>'source_invoice_id' IS NOT NULL THEN 'both' END;
  IF v_locked IS NOT NULL AND v_new <> v_cur THEN
    RAISE EXCEPTION 'This document keeps the currency of the document it was made from (%).', v_cur USING ERRCODE = 'P0001';
  END IF;
  IF v_locked = 'both' THEN
    RAISE EXCEPTION 'A credit note against an invoice keeps the invoice''s rate.' USING ERRCODE = 'P0001';
  END IF;
  IF v_new = public.rma_base_currency() THEN
    v_rate := 1;
  ELSE
    v_rate := COALESCE(p_rate, public.rma_exchange_rate(v_new, public.rma_today()));
    IF v_rate IS NULL THEN
      RAISE EXCEPTION 'There is no exchange rate for % on or before %. Add one in Accounting › Exchange rates, or give the rate.',
        v_new, public.rma_today() USING ERRCODE = 'P0001';
    END IF;
    IF v_rate <= 0 OR v_rate > 1000000 THEN
      RAISE EXCEPTION 'An exchange rate is a positive number.' USING ERRCODE = '22023';
    END IF;
  END IF;
  EXECUTE format('UPDATE public.%I SET currency = $1, exchange_rate = $2 WHERE id = $3', v_tbl) USING v_new, v_rate, p_id;
  RETURN jsonb_build_object('currency', v_new, 'exchange_rate', v_rate);
END $fn$;
REVOKE ALL ON FUNCTION public.set_document_currency(text, uuid, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_document_currency(text, uuid, text, numeric) TO authenticated, service_role;

-- record_payment takes an optional currency and rate (rewrite of its live
-- definition, each anchor counted; the old signature is replaced).
DO $$
DECLARE
  v_def  text;
  v_head text := 'p_actor_email text, p_allocations jsonb DEFAULT ''[]''::jsonb)';
  v_ins  text := E'method, reference_number, payment_date, notes, created_by\n  )';
  v_val  text := E'p_notes, v_actor\n  )';
BEGIN
  IF to_regprocedure('public.record_payment(uuid,numeric,text,text,date,text,text,jsonb,text,numeric)') IS NOT NULL THEN
    RETURN;  -- already applied
  END IF;
  v_def := replace(pg_get_functiondef('public.record_payment(uuid,numeric,text,text,date,text,text,jsonb)'::regprocedure), E'\r\n', E'\n');
  IF (length(v_def) - length(replace(v_def, v_head, ''))) / length(v_head) <> 1
     OR (length(v_def) - length(replace(v_def, v_ins, ''))) / length(v_ins) <> 1
     OR (length(v_def) - length(replace(v_def, v_val, ''))) / length(v_val) <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: record_payment does not read as expected';
  END IF;
  v_def := replace(v_def, v_head, 'p_actor_email text, p_allocations jsonb DEFAULT ''[]''::jsonb, p_currency text DEFAULT NULL, p_exchange_rate numeric DEFAULT NULL)');
  v_def := replace(v_def, v_ins, E'method, reference_number, payment_date, notes, created_by, currency, exchange_rate\n  )');
  v_def := replace(v_def, v_val, E'p_notes, v_actor,\n    NULLIF(upper(btrim(COALESCE(p_currency, \'\'))), \'\')::char(3), p_exchange_rate\n  )');
  DROP FUNCTION public.record_payment(uuid, numeric, text, text, date, text, text, jsonb);
  EXECUTE v_def;
END $$;
REVOKE ALL ON FUNCTION public.record_payment(uuid, numeric, text, text, date, text, text, jsonb, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment(uuid, numeric, text, text, date, text, text, jsonb, text, numeric) TO authenticated, service_role;

-- ── 5. a payment or credit note settles invoices in its own currency ─────────
CREATE OR REPLACE FUNCTION public.rma_guard_application_currency()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_src char(3);
  v_inv char(3);
  v_what text;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NEW;
  END IF;
  SELECT currency INTO v_inv FROM public.crm_invoices WHERE id = NEW.invoice_id;
  IF TG_TABLE_NAME = 'payment_applications' THEN
    SELECT currency INTO v_src FROM public.payments WHERE id = NEW.payment_id; v_what := 'payment';
  ELSE
    SELECT currency INTO v_src FROM public.credit_notes WHERE id = NEW.credit_note_id; v_what := 'credit note';
  END IF;
  IF v_src IS DISTINCT FROM v_inv THEN
    RAISE EXCEPTION 'This % is in % and the invoice in %: a % settles invoices in its own currency.', v_what, v_src, v_inv, v_what
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_guard_application_currency() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_payment_applications_currency ON public.payment_applications;
CREATE TRIGGER trg_payment_applications_currency BEFORE INSERT ON public.payment_applications
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_application_currency();
DROP TRIGGER IF EXISTS trg_credit_note_applications_currency ON public.credit_note_applications;
CREATE TRIGGER trg_credit_note_applications_currency BEFORE INSERT ON public.credit_note_applications
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_application_currency();

-- ── 6. the ledger ────────────────────────────────────────────────────────────
-- two new posting roles, on the country charts' codes
ALTER TABLE public.posting_rules DROP CONSTRAINT IF EXISTS posting_rules_role_check;
ALTER TABLE public.posting_rules ADD CONSTRAINT posting_rules_role_check CHECK (role IN (
  'accounts_receivable', 'accounts_payable', 'inventory', 'goods_received_not_invoiced',
  'sales_revenue', 'sales_tax_payable', 'purchase_tax_receivable', 'cost_of_goods_sold',
  'purchase_price_variance', 'inventory_adjustment', 'cash', 'bank', 'customer_deposits',
  'retained_earnings', 'opening_balance_equity', 'rounding', 'accrued_landed_costs',
  'fx_gain', 'fx_loss'));
UPDATE public.gl_chart_templates SET role = 'fx_gain' WHERE code = '4910';
UPDATE public.gl_chart_templates SET role = 'fx_loss' WHERE code = '6520';
DO $$
DECLARE
  v_inc uuid := (SELECT id FROM public.gl_accounts WHERE code = '4000' AND NOT is_postable);
  v_exp uuid := (SELECT id FROM public.gl_accounts WHERE code = '6000' AND NOT is_postable);
BEGIN
  INSERT INTO public.gl_accounts (id, code, name, name_ar, account_type, parent_id, is_postable)
  VALUES (md5('gl_account:4910')::uuid, '4910', 'Foreign exchange gains', 'أرباح فروق العملة', 'income', v_inc, true)
  ON CONFLICT (code) DO NOTHING;
  INSERT INTO public.gl_accounts (id, code, name, name_ar, account_type, parent_id, is_postable)
  VALUES (md5('gl_account:6520')::uuid, '6520', 'Foreign exchange losses', 'خسائر فروق العملة', 'expense', v_exp, true)
  ON CONFLICT (code) DO NOTHING;
  INSERT INTO public.posting_rules (role, account_id)
  SELECT 'fx_gain', id FROM public.gl_accounts WHERE code = '4910' AND is_postable AND is_active
  ON CONFLICT (role) DO NOTHING;
  INSERT INTO public.posting_rules (role, account_id)
  SELECT 'fx_loss', id FROM public.gl_accounts WHERE code = '6520' AND is_postable AND is_active
  ON CONFLICT (role) DO NOTHING;
END $$;

-- invoices, credit notes, payments and refunds post at their own rate
CREATE OR REPLACE FUNCTION public.rma_gl_post_crm_invoice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_rate  numeric := COALESCE(NEW.exchange_rate, 1);
  v_total numeric := round(COALESCE(NEW.total, 0) * COALESCE(NEW.exchange_rate, 1), 2);
  v_tax   numeric := round(COALESCE(NEW.tax_amount, 0) * COALESCE(NEW.exchange_rate, 1), 2);
  v_memo  text := 'Invoice ' || COALESCE(NEW.inv_code, NEW.id::text)
                  || CASE WHEN COALESCE(NEW.exchange_rate, 1) <> 1 THEN ' (' || NEW.currency || ' at ' || NEW.exchange_rate::text || ')' ELSE '' END;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;

  IF NEW.doc_status = 'posted' THEN
    PERFORM public._gl_post('crm_invoice', NEW.id, 'posted', public.rma_today(), NEW.inv_code, v_memo, jsonb_build_array(
      jsonb_build_object('role', 'accounts_receivable', 'debit', v_total, 'customer_id', NEW.customer_id),
      jsonb_build_object('role', 'sales_revenue', 'credit', v_total - v_tax),
      jsonb_build_object('role', 'sales_tax_payable', 'credit', v_tax)));
    -- a whole-order invoice carries its own cost of goods (already in base); a delivery's did not
    IF NEW.delivery_id IS NULL AND COALESCE(NEW.cogs_base, 0) > 0 THEN
      PERFORM public._gl_post('crm_invoice', NEW.id, 'cogs', public.rma_today(), NEW.inv_code, v_memo || ' — cost of goods', jsonb_build_array(
        jsonb_build_object('role', 'cost_of_goods_sold', 'debit', NEW.cogs_base),
        jsonb_build_object('role', 'inventory', 'credit', NEW.cogs_base)));
    END IF;
  ELSIF OLD.doc_status = 'posted' AND NEW.doc_status <> 'posted' THEN
    PERFORM public._gl_reverse('crm_invoice', NEW.id, 'posted', 'voided', public.rma_today(), 'Voids ' || v_memo);
    PERFORM public._gl_reverse('crm_invoice', NEW.id, 'cogs', 'voided_cogs', public.rma_today(), 'Voids ' || v_memo || ' — cost of goods');
  END IF;
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.rma_gl_post_credit_note()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_total numeric := round(COALESCE(NEW.total, 0) * COALESCE(NEW.exchange_rate, 1), 2);
  v_tax   numeric := round(COALESCE(NEW.tax_amount, 0) * COALESCE(NEW.exchange_rate, 1), 2);
  v_memo  text := 'Credit note ' || COALESCE(NEW.cn_code, NEW.id::text)
                  || CASE WHEN COALESCE(NEW.exchange_rate, 1) <> 1 THEN ' (' || NEW.currency || ' at ' || NEW.exchange_rate::text || ')' ELSE '' END;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF NEW.status IN ('issued', 'applied') AND OLD.status NOT IN ('issued', 'applied') THEN
    PERFORM public._gl_post('credit_note', NEW.id, 'issued', public.rma_today(), NEW.cn_code, v_memo, jsonb_build_array(
      jsonb_build_object('role', 'sales_revenue', 'debit', v_total - v_tax),
      jsonb_build_object('role', 'sales_tax_payable', 'debit', v_tax),
      jsonb_build_object('role', 'accounts_receivable', 'credit', v_total, 'customer_id', NEW.customer_id)));
  ELSIF NEW.status = 'voided' AND OLD.status IN ('issued', 'applied') THEN
    PERFORM public._gl_reverse('credit_note', NEW.id, 'issued', 'voided', public.rma_today(), 'Voids ' || v_memo);
  END IF;
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.rma_gl_post_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_amt  numeric := round(COALESCE(NEW.amount, 0) * COALESCE(NEW.exchange_rate, 1), 2);
  v_memo text := 'Payment ' || COALESCE(NEW.payment_code, NEW.id::text)
                 || CASE WHEN COALESCE(NEW.exchange_rate, 1) <> 1 THEN ' (' || NEW.currency || ' at ' || NEW.exchange_rate::text || ')' ELSE '' END;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
    PERFORM public._gl_post('payment', NEW.id, 'recorded', COALESCE(NEW.payment_date, public.rma_today()), NEW.payment_code, v_memo,
      jsonb_build_array(
        jsonb_build_object('role', public.rma_gl_money_role(NEW.method), 'debit', v_amt),
        jsonb_build_object('role', 'accounts_receivable', 'credit', v_amt, 'customer_id', NEW.customer_id)));
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'voided' AND OLD.status = 'active' THEN
    PERFORM public._gl_reverse('payment', NEW.id, 'recorded', 'voided', public.rma_today(), 'Voids ' || v_memo);
  END IF;
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.rma_gl_post_customer_refund()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_amt numeric := round(COALESCE(NEW.amount, 0) * COALESCE(NEW.exchange_rate, 1), 2);
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  PERFORM public._gl_post('customer_refund', NEW.id, 'approved', COALESCE(NEW.refund_date, public.rma_today()), NEW.refund_code,
    'Refund ' || COALESCE(NEW.refund_code, NEW.id::text), jsonb_build_array(
      jsonb_build_object('role', 'accounts_receivable', 'debit', v_amt, 'customer_id', NEW.customer_id),
      jsonb_build_object('role', public.rma_gl_money_role(NEW.method), 'credit', v_amt)));
  RETURN NULL;
END $fn$;

-- realised exchange differences on customer invoices
CREATE OR REPLACE FUNCTION public.rma_gl_post_ar_fx()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_inv  public.crm_invoices;
  v_rate numeric;
  v_diff numeric;
  v_type text;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_inv FROM public.crm_invoices WHERE id = NEW.invoice_id;
  IF TG_TABLE_NAME = 'payment_applications' THEN
    SELECT exchange_rate INTO v_rate FROM public.payments WHERE id = NEW.payment_id; v_type := 'payment_application';
  ELSE
    SELECT exchange_rate INTO v_rate FROM public.credit_notes WHERE id = NEW.credit_note_id; v_type := 'credit_note_application';
  END IF;
  -- booked at the invoice's rate, settled at the payment's (a reversal row is negative)
  v_diff := round(NEW.amount_applied * COALESCE(v_inv.exchange_rate, 1), 2) - round(NEW.amount_applied * COALESCE(v_rate, 1), 2);
  IF v_diff = 0 THEN
    RETURN NULL;
  END IF;
  PERFORM public._gl_post(v_type, NEW.id, 'fx', public.rma_today(), v_inv.inv_code,
    'Exchange difference on ' || COALESCE(v_inv.inv_code, v_inv.id::text),
    CASE WHEN v_diff > 0
      THEN jsonb_build_array(   -- worth less than booked: a loss
        jsonb_build_object('role', 'fx_loss', 'debit', v_diff),
        jsonb_build_object('role', 'accounts_receivable', 'credit', v_diff, 'customer_id', v_inv.customer_id))
      ELSE jsonb_build_array(
        jsonb_build_object('role', 'accounts_receivable', 'debit', -v_diff, 'customer_id', v_inv.customer_id),
        jsonb_build_object('role', 'fx_gain', 'credit', -v_diff)) END);
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_gl_post_ar_fx() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_payment_applications_fx ON public.payment_applications;
CREATE TRIGGER trg_payment_applications_fx AFTER INSERT ON public.payment_applications
  FOR EACH ROW EXECUTE FUNCTION public.rma_gl_post_ar_fx();
DROP TRIGGER IF EXISTS trg_credit_note_applications_fx ON public.credit_note_applications;
CREATE TRIGGER trg_credit_note_applications_fx AFTER INSERT ON public.credit_note_applications
  FOR EACH ROW EXECUTE FUNCTION public.rma_gl_post_ar_fx();

-- realised exchange differences on supplier bills (until now they stayed in payables)
CREATE OR REPLACE FUNCTION public.rma_gl_post_ap_fx()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_vi   public.vendor_invoices;
  v_rate numeric;
  v_diff numeric;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_vi FROM public.vendor_invoices WHERE id = NEW.invoice_id;
  SELECT exchange_rate INTO v_rate FROM public.vendor_payments WHERE id = NEW.payment_id;
  -- payables were credited at the bill's rate and debited at the payment's
  v_diff := round(NEW.amount_applied * COALESCE(v_vi.exchange_rate, 1), 2) - round(NEW.amount_applied * COALESCE(v_rate, 1), 2);
  IF v_diff = 0 THEN
    RETURN NULL;
  END IF;
  PERFORM public._gl_post('vendor_payment_application', NEW.id, 'fx', public.rma_today(), COALESCE(v_vi.vi_code, v_vi.supplier_invoice_no),
    'Exchange difference on ' || COALESCE(v_vi.vi_code, v_vi.supplier_invoice_no, v_vi.id::text),
    CASE WHEN v_diff > 0
      THEN jsonb_build_array(   -- paid less than booked: a gain
        jsonb_build_object('role', 'accounts_payable', 'debit', v_diff, 'vendor_id', v_vi.vendor_id),
        jsonb_build_object('role', 'fx_gain', 'credit', v_diff))
      ELSE jsonb_build_array(
        jsonb_build_object('role', 'fx_loss', 'debit', -v_diff),
        jsonb_build_object('role', 'accounts_payable', 'credit', -v_diff, 'vendor_id', v_vi.vendor_id)) END);
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_gl_post_ap_fx() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_vendor_payment_applications_fx ON public.vendor_payment_applications;
CREATE TRIGGER trg_vendor_payment_applications_fx AFTER INSERT ON public.vendor_payment_applications
  FOR EACH ROW EXECUTE FUNCTION public.rma_gl_post_ap_fx();

-- the VAT return converts output tax at each document's rate
CREATE OR REPLACE FUNCTION public.rma_vat_return(p_from date, p_to date)
RETURNS TABLE (side text, tax_code text, name text, name_ar text, kind text, rate numeric,
               net_amount numeric, tax_amount numeric, documents bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Not allowed.' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Give a period: a start date and an end date on or after it.' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH ev AS (
    SELECT e.source_type, e.source_id,
           CASE WHEN (e.source_type, e.event) IN (('crm_invoice', 'posted'), ('credit_note', 'voided'), ('vendor_invoice', 'approved'))
                THEN 1 ELSE -1 END AS sgn
      FROM public.journal_entries e
     WHERE e.entry_date BETWEEN p_from AND p_to
       AND (e.source_type, e.event) IN (('crm_invoice', 'posted'), ('crm_invoice', 'voided'),
                                        ('credit_note', 'issued'), ('credit_note', 'voided'),
                                        ('vendor_invoice', 'approved'), ('vendor_invoice', 'cancelled'))
  ), ln AS (
    SELECT 'output'::text AS side, ev.source_id, l.tax_code, l.tax_pct,
           ev.sgn * l.qty * l.unit_price * (1 - l.discount_pct / 100) * COALESCE(NULLIF(i.exchange_rate, 0), 1) AS net
      FROM ev JOIN public.crm_invoice_lines l ON ev.source_type = 'crm_invoice' AND l.crm_invoice_id = ev.source_id
      JOIN public.crm_invoices i ON i.id = ev.source_id
    UNION ALL
    SELECT 'output', ev.source_id, l.tax_code, l.tax_pct,
           ev.sgn * l.qty * l.unit_price * (1 - l.discount_pct / 100) * COALESCE(NULLIF(c.exchange_rate, 0), 1)
      FROM ev JOIN public.credit_note_lines l ON ev.source_type = 'credit_note' AND l.credit_note_id = ev.source_id
      JOIN public.credit_notes c ON c.id = ev.source_id
    UNION ALL
    SELECT 'input', ev.source_id, l.tax_code, l.tax_pct,
           ev.sgn * l.qty_ordered * l.unit_cost * (1 - l.discount_pct / 100) * COALESCE(NULLIF(vi.exchange_rate, 0), 1)
      FROM ev JOIN public.vendor_invoice_lines l ON ev.source_type = 'vendor_invoice' AND l.vendor_invoice_id = ev.source_id
      JOIN public.vendor_invoices vi ON vi.id = ev.source_id
  )
  SELECT ln.side, ln.tax_code, c.name, c.name_ar, c.kind, ln.tax_pct,
         round(sum(ln.net), 2), round(sum(ln.net * ln.tax_pct / 100), 2), count(DISTINCT ln.source_id)
    FROM ln LEFT JOIN public.tax_codes c ON c.code = ln.tax_code
   GROUP BY ln.side, ln.tax_code, c.name, c.name_ar, c.kind, ln.tax_pct
   ORDER BY ln.side DESC, ln.tax_pct DESC, ln.tax_code;
END $fn$;

-- ── 7. Backup & Restore: the restorable BACKUP_TABLES, in order ─────────────
-- (src/test/restoreManifest.test.js fails if the two drift apart). Rates come
-- after the currencies they name.
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
    'activities', 'notifications', 'user_activity_log'
  ]::text[]
$function$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotations', 'sales_orders', 'crm_invoices', 'credit_notes', 'payments', 'customer_refunds'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || t || '_currency' AND tgrelid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'Refusing to finish: % has no currency trigger', t;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.posting_rules WHERE role = 'fx_gain')
     OR NOT EXISTS (SELECT 1 FROM public.posting_rules WHERE role = 'fx_loss') THEN
    RAISE EXCEPTION 'Refusing to finish: no account for exchange gains or losses';
  END IF;
  IF has_function_privilege('anon', 'public.rma_exchange_rate(char, date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_document_currency(text, uuid, text, numeric)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.record_payment(uuid, numeric, text, text, date, text, text, jsonb, text, numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_doc_currency_defaults()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_gl_post_ar_fx()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a currency function is open to the wrong role';
  END IF;
END $$;
