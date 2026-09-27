-- ############################################################################
-- #  20260911 — tax codes, per-line tax snapshots, VAT return (A-04a, BL-15)
-- #
-- #  Every document line now carries a tax code (standard, reduced, zero-rated,
-- #  exempt, out of scope) and the rate it had when the line was written: the
-- #  existing tax_pct column is that snapshot. A posted document cannot be
-- #  rewritten, so changing a code's rate later never changes posted tax.
-- #
-- #    · tax_codes (finance writes: administrators and accountants) and
-- #      tax_code_rates (every rate a code has had).
-- #    · A BEFORE INSERT/UPDATE trigger on the six line tables sets the rate
-- #      from the code. With no code, the line takes the default code for its
-- #      rate. A credit note or a supplier bill may keep any rate its code has
-- #      had (it follows the document it credits, or what the supplier billed).
-- #    · The six line writers pass a line's tax_code through, and keep a line's
-- #      previous code when a screen sends the line back at the same rate
-- #      without one. The six conversions carry the code to the new document.
-- #    · Posting an invoice, issuing a credit note or approving a supplier bill
-- #      gives each line without a code the default code for its rate, and is
-- #      refused while a line still has none. An invoice whose code's rate has
-- #      changed since it was saved must be saved again first.
-- #    · rma_vat_return(from, to): output and input tax by code and rate, from
-- #      the documents the ledger posted in the period; rma_vat_return_ledger
-- #      gives the ledger's VAT account movements to tie it to.
-- #
-- #  Not here (A-04b): the screens. Not in scope: withholding tax.
-- #  Pinned by src/test/taxCodes.test.js; supabase/tests/tax_codes.sql is the
-- #  rolled-back reference script.
-- ############################################################################

-- ── 0. a rate as people write it: 14, 12.5 ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_fmt_rate(p_rate numeric)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT CASE WHEN p_rate::text LIKE '%.%' THEN rtrim(rtrim(p_rate::text, '0'), '.') ELSE p_rate::text END
$fn$;
REVOKE ALL ON FUNCTION public.rma_fmt_rate(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_fmt_rate(numeric) TO authenticated, service_role;

-- ── 1. tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tax_codes (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  name_ar     text,
  kind        text NOT NULL CHECK (kind IN ('standard', 'reduced', 'zero', 'exempt', 'out_of_scope')),
  rate        numeric(5,2) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  is_default  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_codes_rate_matches_kind CHECK (
    (kind IN ('zero', 'exempt', 'out_of_scope') AND rate = 0) OR (kind IN ('standard', 'reduced') AND rate > 0)),
  CONSTRAINT tax_codes_default_is_active CHECK (NOT is_default OR is_active)
);
-- the code a line takes when it carries only a rate: one per rate
CREATE UNIQUE INDEX IF NOT EXISTS tax_codes_one_default_per_rate_idx ON public.tax_codes (rate) WHERE is_default;
COMMENT ON TABLE public.tax_codes IS
  'Tax codes (A-04). A line''s tax_pct is its code''s rate when the line was written; a posted document keeps it. Written by administrators and accountants.';

CREATE TABLE IF NOT EXISTS public.tax_code_rates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL REFERENCES public.tax_codes(code),
  rate       numeric(5,2) NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text
);
CREATE INDEX IF NOT EXISTS tax_code_rates_code_idx ON public.tax_code_rates (code);
COMMENT ON TABLE public.tax_code_rates IS 'Every rate a tax code has had (A-04). Written by a trigger on tax_codes.';

ALTER TABLE public.tax_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_code_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tax_codes, public.tax_code_rates FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.tax_codes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tax_codes TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.tax_code_rates FROM authenticated;
GRANT SELECT ON TABLE public.tax_code_rates TO authenticated;
GRANT ALL ON TABLE public.tax_codes, public.tax_code_rates TO service_role;

DROP POLICY IF EXISTS "read_tax_codes" ON public.tax_codes;
CREATE POLICY "read_tax_codes" ON public.tax_codes FOR SELECT USING (COALESCE(public.rma_is_staff(), false));
DROP POLICY IF EXISTS "finance_write_tax_codes" ON public.tax_codes;
CREATE POLICY "finance_write_tax_codes" ON public.tax_codes FOR ALL
  USING (COALESCE(public.rma_is_finance(), false)) WITH CHECK (COALESCE(public.rma_is_finance(), false));
DROP POLICY IF EXISTS "read_tax_code_rates" ON public.tax_code_rates;
CREATE POLICY "read_tax_code_rates" ON public.tax_code_rates FOR SELECT USING (COALESCE(public.rma_is_staff(), false));

DROP TRIGGER IF EXISTS trg_audit_tax_codes ON public.tax_codes;
CREATE TRIGGER trg_audit_tax_codes AFTER INSERT OR DELETE OR UPDATE ON public.tax_codes
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();
DROP TRIGGER IF EXISTS trg_audit_truncate_tax_codes ON public.tax_codes;
CREATE TRIGGER trg_audit_truncate_tax_codes AFTER TRUNCATE ON public.tax_codes
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_truncate();

-- ── 2. columns ───────────────────────────────────────────────────────────────
ALTER TABLE public.quotation_lines      ADD COLUMN IF NOT EXISTS tax_code text REFERENCES public.tax_codes(code);
ALTER TABLE public.sales_order_lines    ADD COLUMN IF NOT EXISTS tax_code text REFERENCES public.tax_codes(code);
ALTER TABLE public.crm_invoice_lines    ADD COLUMN IF NOT EXISTS tax_code text REFERENCES public.tax_codes(code);
ALTER TABLE public.credit_note_lines    ADD COLUMN IF NOT EXISTS tax_code text REFERENCES public.tax_codes(code);
ALTER TABLE public.purchase_order_lines ADD COLUMN IF NOT EXISTS tax_code text REFERENCES public.tax_codes(code);
ALTER TABLE public.vendor_invoice_lines ADD COLUMN IF NOT EXISTS tax_code text REFERENCES public.tax_codes(code);
-- a product's usual code, and a customer's / supplier's tax status, for the
-- screens to propose a line's code (A-04b)
ALTER TABLE public.products  ADD COLUMN IF NOT EXISTS tax_code text REFERENCES public.tax_codes(code);
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS tax_status text
  CHECK (tax_status IN ('registered', 'unregistered', 'exempt', 'foreign'));
ALTER TABLE public.brands    ADD COLUMN IF NOT EXISTS tax_status text
  CHECK (tax_status IN ('registered', 'unregistered', 'exempt', 'foreign'));

-- ── 3. the codes keep their meaning once used ───────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_tax_code_used(p_code text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.quotation_lines WHERE tax_code = p_code)
      OR EXISTS (SELECT 1 FROM public.sales_order_lines WHERE tax_code = p_code)
      OR EXISTS (SELECT 1 FROM public.crm_invoice_lines WHERE tax_code = p_code)
      OR EXISTS (SELECT 1 FROM public.credit_note_lines WHERE tax_code = p_code)
      OR EXISTS (SELECT 1 FROM public.purchase_order_lines WHERE tax_code = p_code)
      OR EXISTS (SELECT 1 FROM public.vendor_invoice_lines WHERE tax_code = p_code)
      OR EXISTS (SELECT 1 FROM public.products WHERE tax_code = p_code)
$fn$;
REVOKE ALL ON FUNCTION public.rma_tax_code_used(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rma_guard_tax_code()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF public.rma_tax_code_used(OLD.code) THEN
      RAISE EXCEPTION 'Tax code % has been used and cannot be deleted; make it inactive instead.', OLD.code USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM public.tax_code_rates WHERE code = OLD.code;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.code IS DISTINCT FROM OLD.code THEN
      RAISE EXCEPTION 'A tax code''s code cannot change; create a new code instead.' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.kind IS DISTINCT FROM OLD.kind AND public.rma_tax_code_used(OLD.code) THEN
      RAISE EXCEPTION 'Tax code % has been used: its kind cannot change.', OLD.code USING ERRCODE = 'P0001';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_guard_tax_code() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_tax_codes_guard ON public.tax_codes;
CREATE TRIGGER trg_tax_codes_guard BEFORE UPDATE OR DELETE ON public.tax_codes
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_tax_code();

CREATE OR REPLACE FUNCTION public.rma_tax_code_rate_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NEW;  -- a restore brings tax_code_rates back itself
  END IF;
  IF TG_OP = 'INSERT' OR NEW.rate IS DISTINCT FROM OLD.rate THEN
    INSERT INTO public.tax_code_rates (code, rate, changed_by) VALUES (NEW.code, NEW.rate, public.rma_current_user_email());
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_tax_code_rate_history() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_tax_codes_rate_history ON public.tax_codes;
CREATE TRIGGER trg_tax_codes_rate_history AFTER INSERT OR UPDATE OF rate ON public.tax_codes
  FOR EACH ROW EXECUTE FUNCTION public.rma_tax_code_rate_history();

-- ── 4. the line snapshot ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_default_tax_code(p_rate numeric)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT code FROM public.tax_codes WHERE is_default AND is_active AND rate = p_rate ORDER BY code LIMIT 1
$fn$;
REVOKE ALL ON FUNCTION public.rma_default_tax_code(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_default_tax_code(numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rma_line_tax_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_code public.tax_codes;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.tax_code IS NULL THEN
    NEW.tax_code := public.rma_default_tax_code(NEW.tax_pct);
    RETURN NEW;
  END IF;
  SELECT * INTO v_code FROM public.tax_codes WHERE code = NEW.tax_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Line %: there is no tax code "%".', NEW.line_no + 1, NEW.tax_code USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME IN ('credit_note_lines', 'vendor_invoice_lines') THEN
    -- a credit follows the document it credits, a bill what the supplier
    -- billed: any rate this code has had
    IF NEW.tax_pct = v_code.rate
       OR EXISTS (SELECT 1 FROM public.tax_code_rates WHERE code = NEW.tax_code AND rate = NEW.tax_pct) THEN
      RETURN NEW;
    END IF;
  ELSIF NOT v_code.is_active THEN
    RAISE EXCEPTION 'Line %: tax code % is no longer in use.', NEW.line_no + 1, NEW.tax_code USING ERRCODE = 'P0001';
  END IF;
  NEW.tax_pct := v_code.rate;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_line_tax_snapshot() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotation_lines', 'sales_order_lines', 'crm_invoice_lines', 'credit_note_lines',
                           'purchase_order_lines', 'vendor_invoice_lines'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_tax_snapshot ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_tax_snapshot BEFORE INSERT OR UPDATE OF tax_code, tax_pct ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION public.rma_line_tax_snapshot()', t, t);
  END LOOP;
END $$;

-- The code a writer stores for one incoming line: the one it names, else the
-- code the same line had at the same rate before this save (a screen that
-- sends lines back without codes must not lose them), else none — the
-- snapshot trigger then takes the default for the rate.
-- rma.prev_tax_codes is set by the writer just before it deletes the old rows.
CREATE OR REPLACE FUNCTION public._rma_line_tax_code(p_line jsonb, p_line_no integer, p_rate numeric)
RETURNS text LANGUAGE plpgsql STABLE SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_given text := NULLIF(upper(btrim(COALESCE(p_line->>'tax_code', ''))), '');
  v_prev  jsonb;
BEGIN
  IF v_given IS NOT NULL THEN
    RETURN v_given;
  END IF;
  v_prev := NULLIF(current_setting('rma.prev_tax_codes', true), '')::jsonb -> p_line_no::text;
  IF v_prev IS NOT NULL AND (v_prev->>1)::numeric = p_rate THEN
    RETURN v_prev->>0;
  END IF;
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public._rma_line_tax_code(jsonb, integer, numeric) FROM PUBLIC, anon, authenticated;

-- ── 5. writers and conversions carry the code ───────────────────────────────
-- Same rewrite-and-count pattern as 20260890: each anchor must appear exactly
-- as often as expected, or the migration refuses to apply.
CREATE FUNCTION pg_temp.rewrite(p_fn regprocedure, p_old text, p_new text, p_marker text, p_expect integer)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_def  text := replace(pg_get_functiondef(p_fn), E'\r\n', E'\n');
  v_have integer;
BEGIN
  IF strpos(v_def, p_marker) > 0 THEN
    RETURN;  -- already applied
  END IF;
  v_have := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_have <> p_expect THEN
    RAISE EXCEPTION 'Refusing to apply: % contains % % time(s), expected %', p_fn, quote_literal(p_old), v_have, p_expect;
  END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $f$;

DO $$
DECLARE
  w record;
BEGIN
  FOR w IN SELECT * FROM (VALUES
      ('public._quotation_write_lines(uuid,jsonb)'::regprocedure,     'quotation_lines',      'quotation_id',      'p_qt_id'),
      ('public._sales_order_write_lines(uuid,jsonb)'::regprocedure,   'sales_order_lines',    'sales_order_id',    'p_so_id'),
      ('public._crm_invoice_write_lines(uuid,jsonb)'::regprocedure,   'crm_invoice_lines',    'crm_invoice_id',    'p_inv_id'),
      ('public._credit_note_write_lines(uuid,jsonb)'::regprocedure,   'credit_note_lines',    'credit_note_id',    'p_cn_id'),
      ('public._purchase_order_write_lines(uuid,jsonb)'::regprocedure,'purchase_order_lines', 'purchase_order_id', 'p_po_id'),
      ('public._vendor_invoice_write_lines(uuid,jsonb)'::regprocedure,'vendor_invoice_lines', 'vendor_invoice_id', 'p_vi_id')
    ) AS v(fn, tbl, fk, param)
  LOOP
    PERFORM pg_temp.rewrite(w.fn,
      format('DELETE FROM public.%s WHERE %s = %s;', w.tbl, w.fk, w.param),
      format(E'PERFORM set_config(''rma.prev_tax_codes'', COALESCE((SELECT jsonb_object_agg(line_no::text, jsonb_build_array(tax_code, tax_pct)) FROM public.%s WHERE %s = %s), ''{}''::jsonb)::text, true);\n  DELETE FROM public.%s WHERE %s = %s;',
             w.tbl, w.fk, w.param, w.tbl, w.fk, w.param),
      'rma.prev_tax_codes', 1);
    PERFORM pg_temp.rewrite(w.fn, 'discount_pct, tax_pct', 'discount_pct, tax_pct, tax_code', 'tax_pct, tax_code', 1);
    PERFORM pg_temp.rewrite(w.fn, 'v_dpct::numeric, v_tpct::numeric',
      'v_dpct::numeric, v_tpct::numeric, public._rma_line_tax_code(v_line, v_no, v_tpct::numeric)', '_rma_line_tax_code', 1);
  END LOOP;

  PERFORM pg_temp.rewrite('public.convert_quotation_to_so(uuid,text,text)', '''tax_pct'', l.tax_pct)',
    '''tax_pct'', l.tax_pct, ''tax_code'', l.tax_code)', '''tax_code''', 1);
  PERFORM pg_temp.rewrite('public.convert_so_to_invoice(uuid,text)', '''tax_pct'', l.tax_pct)',
    '''tax_pct'', l.tax_pct, ''tax_code'', l.tax_code)', '''tax_code''', 1);
  PERFORM pg_temp.rewrite('public.create_invoice_from_delivery(uuid,text)', '''tax_pct'', sol.tax_pct)',
    '''tax_pct'', sol.tax_pct, ''tax_code'', sol.tax_code)', '''tax_code''', 1);
  PERFORM pg_temp.rewrite('public.convert_po_to_vendor_invoice(uuid,text)', '''tax_pct'', l.tax_pct)',
    '''tax_pct'', l.tax_pct, ''tax_code'', l.tax_code)', '''tax_code''', 1);
  PERFORM pg_temp.rewrite('public.create_vendor_invoice_from_receipts(uuid,uuid[],text)', '''tax_pct'', pol.tax_pct)',
    '''tax_pct'', pol.tax_pct, ''tax_code'', pol.tax_code)', '''tax_code''', 1);
  -- a return's credit uses the source line's code (BL-15)
  PERFORM pg_temp.rewrite('public.create_credit_note_from_return(uuid,text)', '''tax_pct'', sol.tax_pct,',
    '''tax_pct'', sol.tax_pct, ''tax_code'', sol.tax_code,', '''tax_code''', 1);
END $$;

-- ── 6. no posting without a code ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_guard_tax_codes_on_posting()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_tbl  text;
  v_fk   text;
  v_what text;
  v_line integer;
  v_code text;
  v_rate numeric;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'crm_invoices' THEN
    IF NOT (NEW.doc_status = 'posted' AND OLD.doc_status IS DISTINCT FROM 'posted') THEN RETURN NEW; END IF;
    v_tbl := 'crm_invoice_lines'; v_fk := 'crm_invoice_id'; v_what := 'invoice';
  ELSIF TG_TABLE_NAME = 'credit_notes' THEN
    IF NOT (NEW.status IN ('issued', 'applied') AND OLD.status NOT IN ('issued', 'applied')) THEN RETURN NEW; END IF;
    v_tbl := 'credit_note_lines'; v_fk := 'credit_note_id'; v_what := 'credit note';
  ELSE
    IF NOT (NEW.status = 'approved' AND OLD.status NOT IN ('approved', 'partially_received', 'received')) THEN RETURN NEW; END IF;
    v_tbl := 'vendor_invoice_lines'; v_fk := 'vendor_invoice_id'; v_what := 'supplier invoice';
  END IF;

  -- a line saved before its rate had a code takes the default for its rate
  EXECUTE format('UPDATE public.%I SET tax_code = public.rma_default_tax_code(tax_pct) WHERE %I = $1 AND tax_code IS NULL', v_tbl, v_fk)
    USING NEW.id;
  EXECUTE format('SELECT line_no, tax_pct FROM public.%I WHERE %I = $1 AND tax_code IS NULL ORDER BY line_no LIMIT 1', v_tbl, v_fk)
    INTO v_line, v_rate USING NEW.id;
  IF v_line IS NOT NULL THEN
    RAISE EXCEPTION '%', format('Line %s of this %s has no tax code: no tax code has the rate %s%%. Choose a code for the line, or add a tax code for that rate.',
      v_line + 1, v_what, public.rma_fmt_rate(v_rate)) USING ERRCODE = 'P0001';
  END IF;

  -- an invoice is taxed at today's rate for its codes
  IF TG_TABLE_NAME = 'crm_invoices' THEN
    SELECT l.line_no, l.tax_code, c.rate INTO v_line, v_code, v_rate
      FROM public.crm_invoice_lines l JOIN public.tax_codes c ON c.code = l.tax_code
     WHERE l.crm_invoice_id = NEW.id AND l.tax_pct <> c.rate
     ORDER BY l.line_no LIMIT 1;
    IF v_line IS NOT NULL THEN
      RAISE EXCEPTION '%', format('Line %s: the rate for tax code %s is now %s%%. Save the invoice again so its tax is worked out at that rate, then post it.',
        v_line + 1, v_code, public.rma_fmt_rate(v_rate)) USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_guard_tax_codes_on_posting() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_crm_invoices_tax_codes ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_tax_codes BEFORE UPDATE OF doc_status ON public.crm_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_tax_codes_on_posting();
DROP TRIGGER IF EXISTS trg_credit_notes_tax_codes ON public.credit_notes;
CREATE TRIGGER trg_credit_notes_tax_codes BEFORE UPDATE OF status ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_tax_codes_on_posting();
DROP TRIGGER IF EXISTS trg_vendor_invoices_tax_codes ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_tax_codes BEFORE UPDATE OF status ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_tax_codes_on_posting();

-- ── 7. the starting codes, and the lines already written ─────────────────────
-- Standard at the tenant's default_tax_rate, zero-rated, exempt, out of scope,
-- and a code for any other rate the existing lines use, so every line has one.
DO $$
DECLARE
  v_std  numeric;
  v_rate numeric;
BEGIN
  SELECT CASE WHEN btrim(config_value #>> '{}') ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' THEN (config_value #>> '{}')::numeric END
    INTO v_std FROM public.rma_config WHERE config_key = 'default_tax_rate';
  IF v_std IS NOT NULL AND v_std > 0 THEN
    INSERT INTO public.tax_codes (code, name, name_ar, kind, rate, is_default)
    VALUES ('VAT' || replace(public.rma_fmt_rate(v_std), '.', '_'),
            'Standard rate ' || public.rma_fmt_rate(v_std) || '%',
            'السعر الأساسي ' || public.rma_fmt_rate(v_std) || '%',
            'standard', v_std, true)
    ON CONFLICT (code) DO NOTHING;
  END IF;
  INSERT INTO public.tax_codes (code, name, name_ar, kind, rate, is_default) VALUES
    ('ZERO',   'Zero-rated',   'خاضع بنسبة صفر', 'zero', 0, true),
    ('EXEMPT', 'Exempt',       'معفى',            'exempt', 0, false),
    ('OOS',    'Out of scope', 'خارج النطاق',     'out_of_scope', 0, false)
  ON CONFLICT (code) DO NOTHING;

  FOR v_rate IN
    SELECT DISTINCT r FROM (
      SELECT tax_pct AS r FROM public.quotation_lines UNION SELECT tax_pct FROM public.sales_order_lines
      UNION SELECT tax_pct FROM public.crm_invoice_lines UNION SELECT tax_pct FROM public.credit_note_lines
      UNION SELECT tax_pct FROM public.purchase_order_lines UNION SELECT tax_pct FROM public.vendor_invoice_lines) x
     WHERE r > 0 AND NOT EXISTS (SELECT 1 FROM public.tax_codes c WHERE c.rate = x.r AND c.is_default)
  LOOP
    INSERT INTO public.tax_codes (code, name, name_ar, kind, rate, is_default)
    VALUES ('VAT' || replace(public.rma_fmt_rate(v_rate), '.', '_'),
            'Rate ' || public.rma_fmt_rate(v_rate) || '%',
            'نسبة ' || public.rma_fmt_rate(v_rate) || '%',
            CASE WHEN v_std IS NOT NULL AND v_rate < v_std THEN 'reduced' ELSE 'standard' END, v_rate, true)
    ON CONFLICT (code) DO NOTHING;
  END LOOP;
END $$;

-- existing lines take the default code for their rate; their rate is unchanged
UPDATE public.quotation_lines      SET tax_code = public.rma_default_tax_code(tax_pct) WHERE tax_code IS NULL;
UPDATE public.sales_order_lines    SET tax_code = public.rma_default_tax_code(tax_pct) WHERE tax_code IS NULL;
UPDATE public.crm_invoice_lines    SET tax_code = public.rma_default_tax_code(tax_pct) WHERE tax_code IS NULL;
UPDATE public.credit_note_lines    SET tax_code = public.rma_default_tax_code(tax_pct) WHERE tax_code IS NULL;
UPDATE public.purchase_order_lines SET tax_code = public.rma_default_tax_code(tax_pct) WHERE tax_code IS NULL;
UPDATE public.vendor_invoice_lines SET tax_code = public.rma_default_tax_code(tax_pct) WHERE tax_code IS NULL;

-- ── 8. the VAT return ────────────────────────────────────────────────────────
-- Output tax: invoices posted (+) and voided (−), credit notes issued (−) and
-- voided (+). Input tax: supplier invoices approved (+) and cancelled (−), in
-- the base currency at the bill's own rate. Taken from the ledger's entries in
-- the period, so the report covers exactly what the ledger posted; each
-- document's lines give the split by code and rate.
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
           ev.sgn * l.qty * l.unit_price * (1 - l.discount_pct / 100) AS net
      FROM ev JOIN public.crm_invoice_lines l ON ev.source_type = 'crm_invoice' AND l.crm_invoice_id = ev.source_id
    UNION ALL
    SELECT 'output', ev.source_id, l.tax_code, l.tax_pct,
           ev.sgn * l.qty * l.unit_price * (1 - l.discount_pct / 100)
      FROM ev JOIN public.credit_note_lines l ON ev.source_type = 'credit_note' AND l.credit_note_id = ev.source_id
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

-- The ledger's VAT accounts over the same period, to tie the return to:
-- output = credits less debits on sales VAT payable, input = debits less
-- credits on VAT receivable.
CREATE OR REPLACE FUNCTION public.rma_vat_return_ledger(p_from date, p_to date)
RETURNS TABLE (output_tax numeric, input_tax numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Not allowed.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT COALESCE(sum(l.credit - l.debit) FILTER (WHERE r.role = 'sales_tax_payable'), 0)::numeric,
         COALESCE(sum(l.debit - l.credit) FILTER (WHERE r.role = 'purchase_tax_receivable'), 0)::numeric
    FROM public.journal_lines l
    JOIN public.journal_entries e ON e.id = l.entry_id
    JOIN public.posting_rules r ON r.account_id = l.account_id AND r.role IN ('sales_tax_payable', 'purchase_tax_receivable')
   WHERE e.entry_date BETWEEN p_from AND p_to;
END $fn$;

REVOKE ALL ON FUNCTION public.rma_vat_return(date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rma_vat_return_ledger(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_vat_return(date, date), public.rma_vat_return_ledger(date, date) TO authenticated, service_role;

-- ── 9. Backup & Restore: the restorable BACKUP_TABLES, in order ─────────────
-- (src/test/restoreManifest.test.js fails if the two drift apart). Tax codes
-- come before the products and lines that name them.
CREATE OR REPLACE FUNCTION public.rma_restore_manifest()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'currencies', 'countries', 'country_area_codes', 'rma_config', 'gl_accounts', 'posting_rules',
    'tax_codes', 'tax_code_rates',
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
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['_quotation_write_lines', '_sales_order_write_lines', '_crm_invoice_write_lines',
                           '_credit_note_write_lines', '_purchase_order_write_lines', '_vendor_invoice_write_lines'] LOOP
    IF pg_get_functiondef(('public.' || f || '(uuid,jsonb)')::regprocedure) NOT LIKE '%_rma_line_tax_code(v_line, v_no, v_tpct::numeric)%'
       OR pg_get_functiondef(('public.' || f || '(uuid,jsonb)')::regprocedure) NOT LIKE '%rma.prev_tax_codes%' THEN
      RAISE EXCEPTION 'Refusing to finish: % does not store the tax code', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['convert_quotation_to_so(uuid,text,text)', 'convert_so_to_invoice(uuid,text)',
                           'create_invoice_from_delivery(uuid,text)', 'convert_po_to_vendor_invoice(uuid,text)',
                           'create_vendor_invoice_from_receipts(uuid,uuid[],text)', 'create_credit_note_from_return(uuid,text)'] LOOP
    IF pg_get_functiondef(('public.' || f)::regprocedure) NOT LIKE '%''tax_code''%' THEN
      RAISE EXCEPTION 'Refusing to finish: % does not carry the tax code', f;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.crm_invoice_lines l JOIN public.crm_invoices i ON i.id = l.crm_invoice_id
              WHERE i.doc_status = 'posted' AND l.tax_code IS NULL) THEN
    RAISE NOTICE 'Some posted invoice lines have a rate no tax code carries; they stay as they are and show without a code in the VAT return.';
  END IF;
  IF has_function_privilege('anon', 'public.rma_vat_return(date, date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_default_tax_code(numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._rma_line_tax_code(jsonb, integer, numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_line_tax_snapshot()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_tax_code_used(text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.tax_code_rates', 'INSERT') THEN
    RAISE EXCEPTION 'Refusing to finish: a tax function or table is open to the wrong role';
  END IF;
END $$;
