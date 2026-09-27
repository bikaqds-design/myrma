-- ============================================================================
-- 20260905_general_ledger.sql
-- A-01a — the general ledger: chart of accounts, posting rules, journal
-- entries and lines, and the one engine every posting goes through.
-- Design: docs/A01_GENERAL_LEDGER.md.
-- ============================================================================
-- Nothing posts to the ledger yet: the documents start posting in A-01b, each
-- from the step that makes it final (an invoice posted, a delivery confirmed,
-- a payment recorded, ...). This migration gives them somewhere to post that
-- cannot be wrong:
--
--   * gl_accounts: the chart. Header accounts (is_postable = false) group the
--     accounts under them and are never posted to. An account that has been
--     posted to keeps its code and type, and stays postable.
--   * posting_rules: which account each kind of posting uses (a fixed list of
--     roles — accounts_receivable, sales_revenue, ...). A tenant points a role
--     at another account; a posting whose role has no account FAILS, and so
--     does the document step that needed it (strict by default: nothing is
--     ever left unposted).
--   * journal_entries / journal_lines: in the base currency, numbered
--     JE-YYYY-NNNNN (gapless). Every entry balances (debits = credits, checked
--     when it is written and again at commit), has at least two lines, and is
--     never changed or deleted — a mistake is corrected by a reversing entry.
--     One entry per (source, event): posting the same event twice returns the
--     entry already there.
--   * _gl_post / _gl_reverse: internal, not client-callable. A-01b calls them.
--   * rma_trial_balance(from, to): debits, credits and balance per account.
--
-- Readers: the chart and the rules, any staff; journals and the trial balance,
-- managers and accountants (rma_can_handle_cash). Writers: the chart and the
-- rules, administrators; journals, nobody but the engine.
--
-- The default chart is seeded with ids derived from each code, so the same
-- account has the same id in every tenant — a backup restores onto a new
-- tenant's seeded chart without a clash on the account code.
--
-- Pinned by src/test/generalLedger.test.js; supabase/tests/general_ledger.sql is
-- the rolled-back reference script.
-- ============================================================================

-- ── 1. numbering: JE-YYYY-NNNNN ──────────────────────────────────────────────
INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
VALUES ('journal_entry', 0, EXTRACT(YEAR FROM now())::integer)
ON CONFLICT (seq_type) DO NOTHING;

DO $$
DECLARE
  v_def  text;
  v_old  text := '    WHEN ''customer_refund'' THEN ''RF''';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.nextval_for_type'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%WHEN ''journal_entry''%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: nextval_for_type holds the customer_refund prefix % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old || E'\n    WHEN ''journal_entry''   THEN ''JE''');
END $$;

DO $$
DECLARE
  v_def  text;
  v_old  text := '(''customer_refund'', ''customer_refunds'',     ''refund_code'',    ''RF'')';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.rma_reconcile_document_sequences'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%''journal_entries''%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_reconcile_document_sequences lists customer_refund % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old || E',\n      (''journal_entry'',   ''journal_entries'',      ''entry_no'',       ''JE'')');
END $$;

-- ── 2. the chart of accounts ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gl_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE CHECK (btrim(code) <> '' AND code = btrim(code)),
  name         text NOT NULL CHECK (btrim(name) <> ''),
  name_ar      text,
  account_type text NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_id    uuid REFERENCES public.gl_accounts(id) DEFERRABLE INITIALLY DEFERRED,
  is_postable  boolean NOT NULL DEFAULT true,
  is_active    boolean NOT NULL DEFAULT true,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gl_accounts_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS gl_accounts_parent_idx ON public.gl_accounts (parent_id);

COMMENT ON TABLE public.gl_accounts IS
  'Chart of accounts (A-01). Header accounts (is_postable = false) are never posted to. Once posted to, an account keeps its code and type and stays postable.';

-- ── 3. which account each kind of posting uses ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.posting_rules (
  role        text PRIMARY KEY CHECK (role IN (
                'accounts_receivable', 'accounts_payable', 'inventory', 'goods_received_not_invoiced',
                'sales_revenue', 'sales_tax_payable', 'purchase_tax_receivable', 'cost_of_goods_sold',
                'purchase_price_variance', 'inventory_adjustment', 'cash', 'customer_deposits',
                'retained_earnings', 'opening_balance_equity', 'rounding')),
  account_id  uuid NOT NULL REFERENCES public.gl_accounts(id),
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.posting_rules IS
  'Which account each kind of posting uses (A-01). A posting whose role has no account here fails, and the document step with it.';

-- ── 4. journals ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.journal_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_no          text NOT NULL UNIQUE,
  entry_date        date NOT NULL,
  source_type       text NOT NULL CHECK (btrim(source_type) <> ''),
  source_id         uuid,
  source_code       text,
  event             text NOT NULL CHECK (btrim(event) <> ''),
  memo              text,
  reverses_entry_id uuid REFERENCES public.journal_entries(id) DEFERRABLE INITIALLY DEFERRED,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- one entry per (source, event): the engine returns the existing one
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_source_event_uniq
  ON public.journal_entries (source_type, source_id, event) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_reversal_idx
  ON public.journal_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_entries_date_idx ON public.journal_entries (entry_date);

CREATE TABLE IF NOT EXISTS public.journal_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES public.journal_entries(id) DEFERRABLE INITIALLY DEFERRED,
  line_no     integer NOT NULL CHECK (line_no >= 0),
  account_id  uuid NOT NULL REFERENCES public.gl_accounts(id),
  debit       numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit      numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  customer_id uuid,  -- the party, for subledger reconciliation (no foreign key:
  vendor_id   uuid,  -- a journal outlives the records it names)
  memo        text,
  CONSTRAINT journal_lines_one_side CHECK ((debit > 0) <> (credit > 0)),
  CONSTRAINT journal_lines_entry_line_uniq UNIQUE (entry_id, line_no)
);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON public.journal_lines (account_id);
CREATE INDEX IF NOT EXISTS journal_lines_customer_idx ON public.journal_lines (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_lines_vendor_idx ON public.journal_lines (vendor_id) WHERE vendor_id IS NOT NULL;

COMMENT ON TABLE public.journal_entries IS
  'General ledger entries in the base currency (A-01). Balanced, at least two lines, never changed or deleted: corrected by a reversing entry. Written only by _gl_post / _gl_reverse.';

-- ── 5. access ────────────────────────────────────────────────────────────────
ALTER TABLE public.gl_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posting_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.gl_accounts, public.posting_rules, public.journal_entries, public.journal_lines FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.gl_accounts, public.posting_rules FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.gl_accounts, public.posting_rules TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.journal_entries, public.journal_lines FROM authenticated;
GRANT SELECT ON TABLE public.journal_entries, public.journal_lines TO authenticated;
GRANT ALL ON TABLE public.gl_accounts, public.posting_rules, public.journal_entries, public.journal_lines TO service_role;

DROP POLICY IF EXISTS "read_gl_accounts" ON public.gl_accounts;
CREATE POLICY "read_gl_accounts" ON public.gl_accounts FOR SELECT USING (COALESCE(public.rma_is_staff(), false));
DROP POLICY IF EXISTS "admin_write_gl_accounts" ON public.gl_accounts;
CREATE POLICY "admin_write_gl_accounts" ON public.gl_accounts FOR ALL
  USING (COALESCE(public.rma_is_admin(), false)) WITH CHECK (COALESCE(public.rma_is_admin(), false));

DROP POLICY IF EXISTS "read_posting_rules" ON public.posting_rules;
CREATE POLICY "read_posting_rules" ON public.posting_rules FOR SELECT USING (COALESCE(public.rma_is_staff(), false));
DROP POLICY IF EXISTS "admin_write_posting_rules" ON public.posting_rules;
CREATE POLICY "admin_write_posting_rules" ON public.posting_rules FOR ALL
  USING (COALESCE(public.rma_is_admin(), false)) WITH CHECK (COALESCE(public.rma_is_admin(), false));

DROP POLICY IF EXISTS "read_journal_entries" ON public.journal_entries;
CREATE POLICY "read_journal_entries" ON public.journal_entries FOR SELECT USING (COALESCE(public.rma_can_handle_cash(), false));
DROP POLICY IF EXISTS "read_journal_lines" ON public.journal_lines;
CREATE POLICY "read_journal_lines" ON public.journal_lines FOR SELECT USING (COALESCE(public.rma_can_handle_cash(), false));

-- the chart and its rules are configuration: audit every change
DROP TRIGGER IF EXISTS trg_audit_gl_accounts ON public.gl_accounts;
CREATE TRIGGER trg_audit_gl_accounts AFTER INSERT OR DELETE OR UPDATE ON public.gl_accounts
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();
DROP TRIGGER IF EXISTS trg_audit_truncate_gl_accounts ON public.gl_accounts;
CREATE TRIGGER trg_audit_truncate_gl_accounts AFTER TRUNCATE ON public.gl_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_truncate();
DROP TRIGGER IF EXISTS trg_audit_posting_rules ON public.posting_rules;
CREATE TRIGGER trg_audit_posting_rules AFTER INSERT OR DELETE OR UPDATE ON public.posting_rules
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();
DROP TRIGGER IF EXISTS trg_audit_truncate_posting_rules ON public.posting_rules;
CREATE TRIGGER trg_audit_truncate_posting_rules AFTER TRUNCATE ON public.posting_rules
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_truncate();

-- ── 6. guards ────────────────────────────────────────────────────────────────
-- An account that carries postings keeps its meaning. A restore
-- (rma.audit_suspended) is left alone: it writes rows as they were.
CREATE OR REPLACE FUNCTION public.rma_guard_gl_account()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_used boolean;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.journal_lines WHERE account_id = OLD.id) THEN
      RAISE EXCEPTION 'Account % has postings and cannot be deleted; make it inactive instead.', OLD.code USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.posting_rules WHERE account_id = OLD.id) THEN
      RAISE EXCEPTION 'Account % is used by a posting rule; point the rule at another account first.', OLD.code USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.gl_accounts WHERE parent_id = OLD.id) THEN
      RAISE EXCEPTION 'Account % has accounts under it.', OLD.code USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.gl_accounts WHERE id = NEW.parent_id AND NOT is_postable) THEN
    RAISE EXCEPTION 'An account can only sit under a header account (one that is not posted to).' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  v_used := EXISTS (SELECT 1 FROM public.journal_lines WHERE account_id = OLD.id);
  IF v_used AND (NEW.code IS DISTINCT FROM OLD.code OR NEW.account_type IS DISTINCT FROM OLD.account_type) THEN
    RAISE EXCEPTION 'Account % has postings: its code and type cannot change.', OLD.code USING ERRCODE = 'P0001';
  END IF;
  IF NOT NEW.is_postable AND OLD.is_postable THEN
    IF v_used THEN
      RAISE EXCEPTION 'Account % has postings and cannot become a header account.', OLD.code USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.posting_rules WHERE account_id = OLD.id) THEN
      RAISE EXCEPTION 'Account % is used by a posting rule and cannot become a header account.', OLD.code USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.is_postable AND NOT OLD.is_postable
     AND EXISTS (SELECT 1 FROM public.gl_accounts WHERE parent_id = OLD.id) THEN
    RAISE EXCEPTION 'Account % has accounts under it and must stay a header account.', OLD.code USING ERRCODE = 'P0001';
  END IF;
  IF NOT NEW.is_active AND OLD.is_active
     AND EXISTS (SELECT 1 FROM public.posting_rules WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'Account % is used by a posting rule; point the rule at another account first.', OLD.code USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_gl_accounts_guard ON public.gl_accounts;
CREATE TRIGGER trg_gl_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON public.gl_accounts
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_gl_account();

CREATE OR REPLACE FUNCTION public.rma_guard_posting_rule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A posting rule cannot be removed; point it at another account.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gl_accounts WHERE id = NEW.account_id AND is_postable AND is_active) THEN
    RAISE EXCEPTION 'A posting rule must point at an active account that is posted to (not a header).' USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_posting_rules_guard ON public.posting_rules;
CREATE TRIGGER trg_posting_rules_guard BEFORE INSERT OR UPDATE OR DELETE ON public.posting_rules
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_posting_rule();

-- Journals are never changed or deleted (a restore writes them as they were).
CREATE OR REPLACE FUNCTION public.rma_guard_journal_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF TG_OP <> 'TRUNCATE' AND current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'Journal entries cannot be changed or deleted; post a reversing entry instead.' USING ERRCODE = 'P0001';
END $fn$;

DROP TRIGGER IF EXISTS trg_journal_entries_immutable ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_immutable BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_journal_immutable();
DROP TRIGGER IF EXISTS trg_journal_entries_no_truncate ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_no_truncate BEFORE TRUNCATE ON public.journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_guard_journal_immutable();
DROP TRIGGER IF EXISTS trg_journal_lines_immutable ON public.journal_lines;
CREATE TRIGGER trg_journal_lines_immutable BEFORE UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_journal_immutable();
DROP TRIGGER IF EXISTS trg_journal_lines_no_truncate ON public.journal_lines;
CREATE TRIGGER trg_journal_lines_no_truncate BEFORE TRUNCATE ON public.journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_guard_journal_immutable();

-- Every entry balances and has at least two lines — checked at commit, so it
-- holds for any writer (the engine checks first, with a readable message).
CREATE OR REPLACE FUNCTION public.rma_assert_journal_balanced()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_entry uuid;
  v_dr    numeric;
  v_cr    numeric;
  v_n     integer;
BEGIN
  -- separate branches: a CASE would read NEW.entry_id on journal_entries too
  IF TG_TABLE_NAME = 'journal_entries' THEN
    v_entry := NEW.id;
  ELSE
    v_entry := NEW.entry_id;
  END IF;
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0), count(*)
    INTO v_dr, v_cr, v_n
    FROM public.journal_lines WHERE entry_id = v_entry;
  IF v_n < 2 OR v_dr <> v_cr THEN
    RAISE EXCEPTION 'Journal entry % does not balance (% lines, debit %, credit %).',
      (SELECT entry_no FROM public.journal_entries WHERE id = v_entry), v_n, v_dr, v_cr
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_journal_lines_balanced ON public.journal_lines;
CREATE CONSTRAINT TRIGGER trg_journal_lines_balanced AFTER INSERT ON public.journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.rma_assert_journal_balanced();
DROP TRIGGER IF EXISTS trg_journal_entries_balanced ON public.journal_entries;
CREATE CONSTRAINT TRIGGER trg_journal_entries_balanced AFTER INSERT ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.rma_assert_journal_balanced();

-- ── 7. the posting engine (internal) ─────────────────────────────────────────
-- p_lines: [{role | account_id, debit | credit, customer_id?, vendor_id?, memo?}]
-- Amounts are rounded to cents; zero lines are dropped; an all-zero posting
-- writes nothing and returns NULL. The same (source, event) posts once.
CREATE OR REPLACE FUNCTION public._gl_post(
  p_source_type text, p_source_id uuid, p_event text, p_entry_date date,
  p_source_code text, p_memo text, p_lines jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_id      uuid;
  v_line    jsonb;
  v_acct    uuid;
  v_role    text;
  v_dr      numeric(14,2);
  v_cr      numeric(14,2);
  v_sum_dr  numeric(14,2) := 0;
  v_sum_cr  numeric(14,2) := 0;
  v_rows    jsonb := '[]'::jsonb;
  v_n       integer := 0;
BEGIN
  IF p_source_type IS NULL OR btrim(p_source_type) = '' OR p_event IS NULL OR btrim(p_event) = '' THEN
    RAISE EXCEPTION 'A journal entry needs a source type and an event.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'A journal entry needs its lines as a list.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_source_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.journal_entries
     WHERE source_type = p_source_type AND source_id = p_source_id AND event = p_event;
    IF FOUND THEN
      RETURN v_id;  -- already posted
    END IF;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_role := NULLIF(btrim(v_line ->> 'role'), '');
    IF (v_role IS NULL) = (NULLIF(v_line ->> 'account_id', '') IS NULL) THEN
      RAISE EXCEPTION 'Each journal line names a posting role or an account, not both.' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_role IS NOT NULL THEN
      SELECT account_id INTO v_acct FROM public.posting_rules WHERE role = v_role;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No account is set for "%". Set it in the chart of accounts'' posting rules first.', v_role
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      v_acct := (v_line ->> 'account_id')::uuid;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.gl_accounts WHERE id = v_acct AND is_postable AND is_active) THEN
      RAISE EXCEPTION 'Account % cannot be posted to (a header, inactive or missing).',
        COALESCE((SELECT code FROM public.gl_accounts WHERE id = v_acct), v_acct::text) USING ERRCODE = 'P0001';
    END IF;

    v_dr := round(COALESCE((v_line ->> 'debit')::numeric, 0), 2);
    v_cr := round(COALESCE((v_line ->> 'credit')::numeric, 0), 2);
    IF v_dr < 0 OR v_cr < 0 OR (v_dr > 0 AND v_cr > 0) THEN
      RAISE EXCEPTION 'A journal line is a positive debit or a positive credit.' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    CONTINUE WHEN v_dr = 0 AND v_cr = 0;

    v_sum_dr := v_sum_dr + v_dr;
    v_sum_cr := v_sum_cr + v_cr;
    v_rows := v_rows || jsonb_build_object(
      'line_no', v_n, 'account_id', v_acct, 'debit', v_dr, 'credit', v_cr,
      'customer_id', NULLIF(v_line ->> 'customer_id', ''), 'vendor_id', NULLIF(v_line ->> 'vendor_id', ''),
      'memo', v_line ->> 'memo');
    v_n := v_n + 1;
  END LOOP;

  IF v_n = 0 THEN
    RETURN NULL;  -- nothing to post
  END IF;
  IF v_sum_dr <> v_sum_cr OR v_n < 2 THEN
    RAISE EXCEPTION 'The % entry for % does not balance: debit %, credit %.',
      p_event, COALESCE(p_source_code, p_source_type), v_sum_dr, v_sum_cr USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.journal_entries (entry_no, entry_date, source_type, source_id, source_code, event, memo, created_by)
  VALUES (public.nextval_for_type('journal_entry'), COALESCE(p_entry_date, public.rma_today()),
          p_source_type, p_source_id, p_source_code, p_event, p_memo,
          COALESCE(public.rma_current_user_email(), 'system'))
  RETURNING id INTO v_id;

  INSERT INTO public.journal_lines (entry_id, line_no, account_id, debit, credit, customer_id, vendor_id, memo)
  SELECT v_id, (r ->> 'line_no')::integer, (r ->> 'account_id')::uuid, (r ->> 'debit')::numeric, (r ->> 'credit')::numeric,
         (r ->> 'customer_id')::uuid, (r ->> 'vendor_id')::uuid, r ->> 'memo'
    FROM jsonb_array_elements(v_rows) r;

  RETURN v_id;
END $fn$;

-- Reverse the entry a (source, event) posted, as event p_reversal_event.
-- Nothing posted = nothing to reverse (NULL); reversing twice returns the
-- first reversal.
CREATE OR REPLACE FUNCTION public._gl_reverse(
  p_source_type text, p_source_id uuid, p_event text, p_reversal_event text,
  p_entry_date date, p_memo text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_orig  public.journal_entries;
  v_id    uuid;
BEGIN
  IF p_reversal_event IS NULL OR p_reversal_event = p_event THEN
    RAISE EXCEPTION 'A reversal needs its own event name.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_orig FROM public.journal_entries
   WHERE source_type = p_source_type AND source_id = p_source_id AND event = p_event;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT id INTO v_id FROM public.journal_entries WHERE reverses_entry_id = v_orig.id;
  IF FOUND THEN
    RETURN v_id;
  END IF;

  INSERT INTO public.journal_entries (entry_no, entry_date, source_type, source_id, source_code, event, memo,
                                      reverses_entry_id, created_by)
  VALUES (public.nextval_for_type('journal_entry'), COALESCE(p_entry_date, public.rma_today()),
          v_orig.source_type, v_orig.source_id, v_orig.source_code, p_reversal_event,
          COALESCE(p_memo, 'Reverses ' || v_orig.entry_no), v_orig.id,
          COALESCE(public.rma_current_user_email(), 'system'))
  RETURNING id INTO v_id;

  INSERT INTO public.journal_lines (entry_id, line_no, account_id, debit, credit, customer_id, vendor_id, memo)
  SELECT v_id, line_no, account_id, credit, debit, customer_id, vendor_id, memo
    FROM public.journal_lines WHERE entry_id = v_orig.id;

  RETURN v_id;
END $fn$;

REVOKE ALL ON FUNCTION public._gl_post(text, uuid, text, date, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._gl_reverse(text, uuid, text, text, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._gl_post(text, uuid, text, date, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public._gl_reverse(text, uuid, text, text, date, text) TO service_role;
REVOKE ALL ON FUNCTION public.rma_guard_gl_account() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_guard_posting_rule() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_guard_journal_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_assert_journal_balanced() FROM PUBLIC, anon, authenticated;

-- ── 8. trial balance ─────────────────────────────────────────────────────────
-- balance is on the account's normal side: debit - credit for assets and
-- expenses, credit - debit for liabilities, equity and income.
CREATE OR REPLACE FUNCTION public.rma_trial_balance(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (account_id uuid, code text, name text, name_ar text, account_type text,
               debit numeric, credit numeric, balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Only managers and accountants can read the ledger.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT a.id, a.code, a.name, a.name_ar, a.account_type,
         sum(l.debit)::numeric, sum(l.credit)::numeric,
         CASE WHEN a.account_type IN ('asset', 'expense') THEN sum(l.debit) - sum(l.credit)
              ELSE sum(l.credit) - sum(l.debit) END::numeric
    FROM public.journal_lines l
    JOIN public.journal_entries e ON e.id = l.entry_id
    JOIN public.gl_accounts a ON a.id = l.account_id
   WHERE (p_from IS NULL OR e.entry_date >= p_from)
     AND (p_to IS NULL OR e.entry_date <= p_to)
   GROUP BY a.id, a.code, a.name, a.name_ar, a.account_type
   ORDER BY a.code;
END $fn$;

REVOKE ALL ON FUNCTION public.rma_trial_balance(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_trial_balance(date, date) TO authenticated, service_role;

-- ── 9. the default chart and its rules ───────────────────────────────────────
-- Ids from the code, so every tenant's seeded account has the same id.
-- Headers first: an account may only sit under a header that exists.
CREATE TEMP TABLE _gl_seed (code text, name text, name_ar text, account_type text, parent text, postable boolean) ON COMMIT DROP;
INSERT INTO _gl_seed VALUES
    ('1000', 'Assets',                         'الأصول',                          'asset',     NULL,   false),
    ('1100', 'Cash on hand',                   'النقدية بالصندوق',                'asset',     '1000', true),
    ('1110', 'Bank',                           'البنك',                           'asset',     '1000', true),
    ('1200', 'Accounts receivable',            'العملاء (ذمم مدينة)',             'asset',     '1000', true),
    ('1300', 'Inventory',                      'المخزون',                         'asset',     '1000', true),
    ('1400', 'VAT receivable (input tax)',     'ضريبة القيمة المضافة على المشتريات', 'asset',  '1000', true),
    ('2000', 'Liabilities',                    'الخصوم',                          'liability', NULL,   false),
    ('2100', 'Accounts payable',               'الموردون (ذمم دائنة)',            'liability', '2000', true),
    ('2150', 'Goods received not invoiced',    'بضاعة مستلمة لم تصل فواتيرها',    'liability', '2000', true),
    ('2200', 'VAT payable (output tax)',       'ضريبة القيمة المضافة على المبيعات', 'liability', '2000', true),
    ('2300', 'Customer deposits',              'دفعات مقدمة من العملاء',          'liability', '2000', true),
    ('3000', 'Equity',                         'حقوق الملكية',                    'equity',    NULL,   false),
    ('3100', 'Owner''s capital',               'رأس المال',                       'equity',    '3000', true),
    ('3200', 'Retained earnings',              'الأرباح المحتجزة',                'equity',    '3000', true),
    ('3900', 'Opening balance equity',         'حقوق ملكية الأرصدة الافتتاحية',   'equity',    '3000', true),
    ('4000', 'Income',                         'الإيرادات',                       'income',    NULL,   false),
    ('4100', 'Sales revenue',                  'إيرادات المبيعات',                'income',    '4000', true),
    ('4900', 'Other income',                   'إيرادات أخرى',                    'income',    '4000', true),
    ('5000', 'Cost of sales',                  'تكلفة المبيعات',                  'expense',   NULL,   false),
    ('5100', 'Cost of goods sold',             'تكلفة البضاعة المباعة',           'expense',   '5000', true),
    ('5200', 'Purchase price variance',        'فروق أسعار الشراء',               'expense',   '5000', true),
    ('5300', 'Inventory adjustments',          'تسويات المخزون',                  'expense',   '5000', true),
    ('6000', 'Operating expenses',             'المصروفات التشغيلية',             'expense',   NULL,   false),
    ('6100', 'General expenses',               'مصروفات عامة',                    'expense',   '6000', true),
    ('6900', 'Rounding differences',           'فروق التقريب',                    'expense',   '6000', true)
;

INSERT INTO public.gl_accounts (id, code, name, name_ar, account_type, parent_id, is_postable)
SELECT md5('gl_account:' || code)::uuid, code, name, name_ar, account_type, NULL, postable
  FROM _gl_seed WHERE parent IS NULL
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.gl_accounts (id, code, name, name_ar, account_type, parent_id, is_postable)
SELECT md5('gl_account:' || c.code)::uuid, c.code, c.name, c.name_ar, c.account_type, p.id, c.postable
  FROM _gl_seed c
  LEFT JOIN public.gl_accounts p ON p.code = c.parent AND NOT p.is_postable
 WHERE c.parent IS NOT NULL
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.posting_rules (role, account_id)
SELECT r.role, a.id
  FROM (VALUES
    ('cash',                        '1110'),
    ('accounts_receivable',         '1200'),
    ('inventory',                   '1300'),
    ('purchase_tax_receivable',     '1400'),
    ('accounts_payable',            '2100'),
    ('goods_received_not_invoiced', '2150'),
    ('sales_tax_payable',           '2200'),
    ('customer_deposits',           '2300'),
    ('retained_earnings',           '3200'),
    ('opening_balance_equity',      '3900'),
    ('sales_revenue',               '4100'),
    ('cost_of_goods_sold',          '5100'),
    ('purchase_price_variance',     '5200'),
    ('inventory_adjustment',        '5300'),
    ('rounding',                    '6900')
  ) AS r(role, code)
  JOIN public.gl_accounts a ON a.code = r.code AND a.is_postable AND a.is_active
ON CONFLICT (role) DO NOTHING;

-- ── 10. Backup & Restore: the restorable BACKUP_TABLES, in order ─────────────
-- (src/test/restoreManifest.test.js fails if the two drift apart)
CREATE OR REPLACE FUNCTION public.rma_restore_manifest()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'currencies', 'countries', 'country_area_codes', 'rma_config', 'gl_accounts', 'posting_rules',
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
    'journal_entries', 'journal_lines',
    'activities', 'notifications', 'user_activity_log'
  ]::text[]
$function$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_missing text;
BEGIN
  IF has_function_privilege('authenticated', 'public._gl_post(text, uuid, text, date, text, text, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._gl_reverse(text, uuid, text, text, date, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_trial_balance(date, date)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.journal_entries', 'INSERT')
     OR has_table_privilege('authenticated', 'public.journal_lines', 'UPDATE') THEN
    RAISE EXCEPTION 'Refusing to finish: the journals are writable outside the posting engine';
  END IF;
  IF pg_get_functiondef('public.nextval_for_type'::regproc) NOT LIKE '%WHEN ''journal_entry''   THEN ''JE''%'
     OR NOT EXISTS (SELECT 1 FROM public.document_sequences WHERE seq_type = 'journal_entry')
     OR pg_get_functiondef('public.rma_reconcile_document_sequences'::regproc) NOT LIKE '%''journal_entries''%' THEN
    RAISE EXCEPTION 'Refusing to finish: the journal_entry sequence is not registered as JE-';
  END IF;
  SELECT string_agg(r, ', ') INTO v_missing
    FROM unnest(ARRAY['accounts_receivable', 'accounts_payable', 'inventory', 'goods_received_not_invoiced',
                      'sales_revenue', 'sales_tax_payable', 'purchase_tax_receivable', 'cost_of_goods_sold',
                      'purchase_price_variance', 'inventory_adjustment', 'cash', 'customer_deposits',
                      'retained_earnings', 'opening_balance_equity', 'rounding']) r
   WHERE NOT EXISTS (SELECT 1 FROM public.posting_rules p WHERE p.role = r);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: no account for posting role(s) %', v_missing;
  END IF;
END $$;
