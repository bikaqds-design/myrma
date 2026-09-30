-- 20260920_bank_reconciliation.sql — W4 / A-07a: bank reconciliation
-- (database layer; the screens are A-07b).
--
-- Owner decisions (2026-09-30):
--   * any ledger account marked as a bank or cash account can be reconciled
--     (gl_accounts.is_bank); the accounts the cash and bank posting roles point
--     at are marked automatically;
--   * the statement comes in as a CSV (parsed on the screen, stored here as
--     lines); lines can be added by hand;
--   * a statement line with no entry in the books yet (bank charges, interest)
--     is booked from the line to a chosen account, and matched at once;
--   * accountants and administrators reconcile (rma_is_finance); managers and
--     accountants can read (rma_can_handle_cash).
--
-- A statement belongs to one account: opening and closing balance, a date and
-- its lines (+ money in, − money out). Each line is matched to exactly one
-- journal line on that account with the same signed amount (debit − credit);
-- a journal line clears at most one statement line. Completing a statement
-- needs every line matched and opening + lines = closing; the opening must
-- equal the previous completed statement's closing on the account. A
-- completed statement is locked; only the latest one on an account can be
-- reopened. The month-end checklist's "bank reconciliation" line (a
-- placeholder until now) counts bank accounts with postings up to the month
-- end but no completed statement reaching it.

-- ── 1. bank accounts ─────────────────────────────────────────────────────────
ALTER TABLE public.gl_accounts ADD COLUMN IF NOT EXISTS is_bank boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.gl_accounts.is_bank IS
  'A-07 (20260920): a bank or cash account that can be reconciled against a statement.';
UPDATE public.gl_accounts a SET is_bank = true
 WHERE NOT a.is_bank AND a.id IN (SELECT r.account_id FROM public.posting_rules r WHERE r.role IN ('cash', 'bank'));

-- whatever the cash and bank roles point at is a bank account (a country
-- template or a repointed rule included)
CREATE OR REPLACE FUNCTION public.rma_mark_money_accounts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF NEW.role IN ('cash', 'bank') THEN
    UPDATE public.gl_accounts SET is_bank = true WHERE id = NEW.account_id AND NOT is_bank;
  END IF;
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_mark_money_accounts() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_posting_rules_mark_money_accounts ON public.posting_rules;
CREATE TRIGGER trg_posting_rules_mark_money_accounts AFTER INSERT OR UPDATE OF account_id ON public.posting_rules
  FOR EACH ROW EXECUTE FUNCTION public.rma_mark_money_accounts();

-- ── 2. statements ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bank_statements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.gl_accounts(id),
  statement_date  date NOT NULL,
  reference       text,
  opening_balance numeric(14, 2) NOT NULL,
  closing_balance numeric(14, 2) NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_by    text,
  completed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS bank_statements_account_idx ON public.bank_statements (account_id, statement_date);
CREATE TABLE IF NOT EXISTS public.bank_statement_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id    uuid NOT NULL REFERENCES public.bank_statements(id) ON DELETE CASCADE,
  line_no         integer NOT NULL,
  txn_date        date NOT NULL,
  description     text,
  reference       text,
  amount          numeric(14, 2) NOT NULL CHECK (amount <> 0),
  journal_line_id uuid UNIQUE REFERENCES public.journal_lines(id),
  booked_entry_id uuid REFERENCES public.journal_entries(id),
  matched_by      text,
  matched_at      timestamptz,
  UNIQUE (statement_id, line_no)
);
COMMENT ON TABLE public.bank_statements IS
  'A-07 (20260920): a bank statement for one bank/cash account, reconciled line by line against its journal lines. Written only by the bank reconciliation functions.';

ALTER TABLE public.bank_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_statement_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bank_statements, public.bank_statement_lines FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.bank_statements, public.bank_statement_lines FROM authenticated;
GRANT SELECT ON TABLE public.bank_statements, public.bank_statement_lines TO authenticated;
GRANT ALL ON TABLE public.bank_statements, public.bank_statement_lines TO service_role;
DROP POLICY IF EXISTS "read_bank_statements" ON public.bank_statements;
CREATE POLICY "read_bank_statements" ON public.bank_statements FOR SELECT
  TO authenticated USING (COALESCE(public.rma_can_handle_cash(), false));
DROP POLICY IF EXISTS "read_bank_statement_lines" ON public.bank_statement_lines;
CREATE POLICY "read_bank_statement_lines" ON public.bank_statement_lines FOR SELECT
  TO authenticated USING (COALESCE(public.rma_can_handle_cash(), false));
DROP TRIGGER IF EXISTS trg_audit_bank_statements ON public.bank_statements;
CREATE TRIGGER trg_audit_bank_statements AFTER INSERT OR DELETE OR UPDATE ON public.bank_statements
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();

-- ── 3. helpers (internal) ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._rma_bank_finance_only()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF NOT COALESCE(public.rma_is_finance(), false) THEN
    RAISE EXCEPTION 'Only accountants and administrators can reconcile the bank.' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $fn$;
REVOKE ALL ON FUNCTION public._rma_bank_finance_only() FROM PUBLIC, anon, authenticated;

-- an open statement, locked for the change
CREATE OR REPLACE FUNCTION public._rma_bank_open_statement(p_statement_id uuid)
RETURNS public.bank_statements LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v public.bank_statements;
BEGIN
  SELECT * INTO v FROM public.bank_statements WHERE id = p_statement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That statement does not exist.' USING ERRCODE = 'P0001';
  END IF;
  IF v.status <> 'open' THEN
    RAISE EXCEPTION 'This statement is completed; reopen it to change it.' USING ERRCODE = 'P0001';
  END IF;
  RETURN v;
END $fn$;
REVOKE ALL ON FUNCTION public._rma_bank_open_statement(uuid) FROM PUBLIC, anon, authenticated;

-- a statement line's text and amount, checked as text first
CREATE OR REPLACE FUNCTION public._rma_bank_line_values(p_line jsonb, OUT o_date date, OUT o_amount numeric,
                                                        OUT o_description text, OUT o_reference text)
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_d text := btrim(COALESCE(p_line ->> 'txn_date', ''));
  v_a text := btrim(COALESCE(p_line ->> 'amount', ''));
BEGIN
  IF v_d !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'A statement line needs a date (YYYY-MM-DD), not "%".', v_d USING ERRCODE = 'P0001';
  END IF;
  IF v_a !~ '^-?\d+(\.\d{1,2})?$' OR v_a::numeric = 0 THEN
    RAISE EXCEPTION 'A statement line needs a non-zero amount with at most two decimals, not "%".', v_a USING ERRCODE = 'P0001';
  END IF;
  o_date := v_d::date;
  o_amount := v_a::numeric;
  o_description := NULLIF(btrim(COALESCE(p_line ->> 'description', '')), '');
  o_reference := NULLIF(btrim(COALESCE(p_line ->> 'reference', '')), '');
END $fn$;
REVOKE ALL ON FUNCTION public._rma_bank_line_values(jsonb) FROM PUBLIC, anon, authenticated;

-- ── 4. writing statements ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_bank_statement(
  p_account_id uuid, p_statement_date date, p_reference text,
  p_opening_balance numeric, p_closing_balance numeric, p_lines jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_acc  public.gl_accounts;
  v_id   uuid;
  v_line jsonb;
  v_vals record;
  v_n    integer := 0;
BEGIN
  PERFORM public._rma_bank_finance_only();
  SELECT * INTO v_acc FROM public.gl_accounts WHERE id = p_account_id;
  IF NOT FOUND OR NOT v_acc.is_bank OR NOT v_acc.is_postable THEN
    RAISE EXCEPTION 'Choose a bank or cash account.' USING ERRCODE = 'P0001';
  END IF;
  IF p_statement_date IS NULL OR p_opening_balance IS NULL OR p_closing_balance IS NULL THEN
    RAISE EXCEPTION 'A statement needs its date and its opening and closing balances.' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(COALESCE(p_lines, '[]'::jsonb)) <> 'array' OR jsonb_array_length(COALESCE(p_lines, '[]'::jsonb)) > 5000 THEN
    RAISE EXCEPTION 'A statement holds up to 5 000 lines.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_statements s WHERE s.account_id = p_account_id AND s.status = 'open') THEN
    RAISE EXCEPTION 'This account has a statement still open; complete it first.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.bank_statements (account_id, statement_date, reference, opening_balance, closing_balance, created_by)
  VALUES (p_account_id, p_statement_date, NULLIF(btrim(COALESCE(p_reference, '')), ''),
          round(p_opening_balance, 2), round(p_closing_balance, 2), public.rma_current_user_email())
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) LOOP
    v_vals := public._rma_bank_line_values(v_line);
    v_n := v_n + 1;
    INSERT INTO public.bank_statement_lines (statement_id, line_no, txn_date, description, reference, amount)
    VALUES (v_id, v_n, v_vals.o_date, v_vals.o_description, v_vals.o_reference, v_vals.o_amount);
  END LOOP;
  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION public.add_bank_statement_line(p_statement_id uuid, p_line jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_vals record;
  v_id   uuid;
BEGIN
  PERFORM public._rma_bank_finance_only();
  PERFORM public._rma_bank_open_statement(p_statement_id);
  v_vals := public._rma_bank_line_values(p_line);
  INSERT INTO public.bank_statement_lines (statement_id, line_no, txn_date, description, reference, amount)
  VALUES (p_statement_id, COALESCE((SELECT max(line_no) FROM public.bank_statement_lines WHERE statement_id = p_statement_id), 0) + 1,
          v_vals.o_date, v_vals.o_description, v_vals.o_reference, v_vals.o_amount)
  RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION public.delete_bank_statement(p_statement_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  PERFORM public._rma_bank_finance_only();
  PERFORM public._rma_bank_open_statement(p_statement_id);
  IF EXISTS (SELECT 1 FROM public.bank_statement_lines WHERE statement_id = p_statement_id AND booked_entry_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Entries were booked from this statement; unmatch or keep it.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.bank_statements WHERE id = p_statement_id;
END $fn$;

-- ── 5. matching ──────────────────────────────────────────────────────────────
-- the journal lines a statement line could be: same account, same signed
-- amount, not yet cleared, within 14 days; nearest date first
CREATE OR REPLACE FUNCTION public.rma_bank_match_candidates(p_statement_id uuid)
RETURNS TABLE(statement_line_id uuid, journal_line_id uuid, entry_no text, entry_date date,
              source_type text, source_id uuid, source_code text, memo text, amount numeric, days_apart integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Only managers and accountants can read the bank reconciliation.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT bl.id, jl.id, e.entry_no, e.entry_date, e.source_type, e.source_id, e.source_code,
         COALESCE(jl.memo, e.memo), (jl.debit - jl.credit)::numeric, abs(e.entry_date - bl.txn_date)
    FROM public.bank_statement_lines bl
    JOIN public.bank_statements s ON s.id = bl.statement_id
    JOIN public.journal_lines jl ON jl.account_id = s.account_id AND (jl.debit - jl.credit) = bl.amount
    JOIN public.journal_entries e ON e.id = jl.entry_id
   WHERE bl.statement_id = p_statement_id AND bl.journal_line_id IS NULL
     AND abs(e.entry_date - bl.txn_date) <= 14
     AND NOT EXISTS (SELECT 1 FROM public.bank_statement_lines x WHERE x.journal_line_id = jl.id)
   ORDER BY bl.line_no, abs(e.entry_date - bl.txn_date), e.entry_no;
END $fn$;

CREATE OR REPLACE FUNCTION public.match_bank_line(p_line_id uuid, p_journal_line_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_line public.bank_statement_lines;
  v_st   public.bank_statements;
  v_jl   public.journal_lines;
BEGIN
  PERFORM public._rma_bank_finance_only();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id = p_line_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That statement line does not exist.' USING ERRCODE = 'P0001'; END IF;
  v_st := public._rma_bank_open_statement(v_line.statement_id);
  IF v_line.journal_line_id IS NOT NULL THEN
    RAISE EXCEPTION 'This line is already matched; unmatch it first.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_jl FROM public.journal_lines WHERE id = p_journal_line_id;
  IF NOT FOUND OR v_jl.account_id <> v_st.account_id THEN
    RAISE EXCEPTION 'That entry is not on this bank account.' USING ERRCODE = 'P0001';
  END IF;
  IF (v_jl.debit - v_jl.credit) <> v_line.amount THEN
    RAISE EXCEPTION 'The amounts differ: the statement shows %, the entry %.', v_line.amount, v_jl.debit - v_jl.credit
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_statement_lines x WHERE x.journal_line_id = p_journal_line_id) THEN
    RAISE EXCEPTION 'That entry is already matched to another statement line.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.bank_statement_lines
     SET journal_line_id = p_journal_line_id, matched_by = public.rma_current_user_email(), matched_at = now()
   WHERE id = p_line_id;
END $fn$;

CREATE OR REPLACE FUNCTION public.unmatch_bank_line(p_line_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v_line public.bank_statement_lines;
BEGIN
  PERFORM public._rma_bank_finance_only();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id = p_line_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That statement line does not exist.' USING ERRCODE = 'P0001'; END IF;
  PERFORM public._rma_bank_open_statement(v_line.statement_id);
  IF v_line.booked_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'This line''s entry was booked from it; it stays matched.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.bank_statement_lines SET journal_line_id = NULL, matched_by = NULL, matched_at = NULL WHERE id = p_line_id;
END $fn$;

-- match every line that has exactly one candidate which no other line also
-- wants; the rest are left for a person. Returns how many were matched.
CREATE OR REPLACE FUNCTION public.auto_match_bank_statement(p_statement_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_n integer;
BEGIN
  PERFORM public._rma_bank_finance_only();
  PERFORM public._rma_bank_open_statement(p_statement_id);
  WITH c AS (SELECT * FROM public.rma_bank_match_candidates(p_statement_id)),
  sure AS (
    SELECT c.statement_line_id, min(c.journal_line_id::text)::uuid AS journal_line_id
      FROM c
     GROUP BY c.statement_line_id
    HAVING count(*) = 1
  ), uniq AS (
    SELECT s.* FROM sure s
     WHERE (SELECT count(*) FROM c WHERE c.journal_line_id = s.journal_line_id) = 1
  )
  UPDATE public.bank_statement_lines bl
     SET journal_line_id = u.journal_line_id, matched_by = public.rma_current_user_email(), matched_at = now()
    FROM uniq u
   WHERE bl.id = u.statement_line_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $fn$;

-- book a line with no entry yet (bank charges, interest) to a chosen account,
-- dated on the line, and match it to the bank side of that entry
CREATE OR REPLACE FUNCTION public.book_bank_line(p_line_id uuid, p_account_id uuid, p_memo text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_line  public.bank_statement_lines;
  v_st    public.bank_statements;
  v_acc   public.gl_accounts;
  v_amt   numeric;
  v_entry uuid;
  v_jl    uuid;
  v_memo  text;
BEGIN
  PERFORM public._rma_bank_finance_only();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id = p_line_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That statement line does not exist.' USING ERRCODE = 'P0001'; END IF;
  v_st := public._rma_bank_open_statement(v_line.statement_id);
  IF v_line.journal_line_id IS NOT NULL THEN
    RAISE EXCEPTION 'This line is already matched.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_acc FROM public.gl_accounts WHERE id = p_account_id;
  IF NOT FOUND OR NOT v_acc.is_postable OR NOT v_acc.is_active THEN
    RAISE EXCEPTION 'Choose an active account that takes postings.' USING ERRCODE = 'P0001';
  END IF;
  IF p_account_id = v_st.account_id THEN
    RAISE EXCEPTION 'Choose the other side of the entry, not the bank account itself.' USING ERRCODE = 'P0001';
  END IF;
  v_amt := abs(v_line.amount);
  v_memo := COALESCE(NULLIF(btrim(COALESCE(p_memo, '')), ''), v_line.description, 'Bank statement line');
  v_entry := public._gl_post('bank_statement_line', v_line.id, 'booked', v_line.txn_date, v_line.reference, v_memo,
    CASE WHEN v_line.amount > 0 THEN jsonb_build_array(
           jsonb_build_object('account_id', v_st.account_id, 'debit', v_amt),
           jsonb_build_object('account_id', p_account_id, 'credit', v_amt))
         ELSE jsonb_build_array(
           jsonb_build_object('account_id', p_account_id, 'debit', v_amt),
           jsonb_build_object('account_id', v_st.account_id, 'credit', v_amt)) END);
  SELECT jl.id INTO v_jl FROM public.journal_lines jl WHERE jl.entry_id = v_entry AND jl.account_id = v_st.account_id;
  UPDATE public.bank_statement_lines
     SET journal_line_id = v_jl, booked_entry_id = v_entry, matched_by = public.rma_current_user_email(), matched_at = now()
   WHERE id = p_line_id;
  RETURN v_entry;
END $fn$;

-- ── 6. the reconciliation ────────────────────────────────────────────────────
-- ledger balance of the account at the statement date, the entries up to it
-- not cleared by any statement, and whether it all ties: bank closing =
-- ledger − uncleared. (Before the ledger started posting, the first
-- statement's opening may carry history the ledger does not have.)
CREATE OR REPLACE FUNCTION public.rma_bank_statement_summary(p_statement_id uuid)
RETURNS TABLE(opening_balance numeric, lines_total numeric, closing_balance numeric, lines_count bigint,
              unmatched_count bigint, statement_balances boolean, ledger_balance numeric,
              uncleared_total numeric, uncleared_count bigint, difference numeric, previous_closing numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_st public.bank_statements;
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Only managers and accountants can read the bank reconciliation.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_st FROM public.bank_statements WHERE id = p_statement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That statement does not exist.' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY
  WITH ln AS (
    SELECT COALESCE(sum(l.amount), 0) AS total, count(*) AS n, count(*) FILTER (WHERE l.journal_line_id IS NULL) AS unmatched
      FROM public.bank_statement_lines l WHERE l.statement_id = p_statement_id
  ), led AS (
    SELECT COALESCE(sum(jl.debit - jl.credit), 0) AS bal
      FROM public.journal_lines jl JOIN public.journal_entries e ON e.id = jl.entry_id
     WHERE jl.account_id = v_st.account_id AND e.entry_date <= v_st.statement_date
  ), unc AS (
    SELECT COALESCE(sum(jl.debit - jl.credit), 0) AS total, count(*) AS n
      FROM public.journal_lines jl JOIN public.journal_entries e ON e.id = jl.entry_id
     WHERE jl.account_id = v_st.account_id AND e.entry_date <= v_st.statement_date
       AND NOT EXISTS (SELECT 1 FROM public.bank_statement_lines x WHERE x.journal_line_id = jl.id)
  ), prev AS (
    SELECT p.closing_balance AS closing FROM public.bank_statements p
     WHERE p.account_id = v_st.account_id AND p.status = 'completed' AND p.id <> v_st.id
       AND (p.statement_date, p.created_at) < (v_st.statement_date, v_st.created_at)
     ORDER BY p.statement_date DESC, p.created_at DESC LIMIT 1
  )
  SELECT v_st.opening_balance, ln.total, v_st.closing_balance, ln.n, ln.unmatched,
         (v_st.opening_balance + ln.total = v_st.closing_balance),
         led.bal, unc.total, unc.n, (v_st.closing_balance - (led.bal - unc.total))::numeric,
         (SELECT closing FROM prev)
    FROM ln, led, unc;
END $fn$;

CREATE OR REPLACE FUNCTION public.complete_bank_statement(p_statement_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_st  public.bank_statements;
  v_sum record;
BEGIN
  PERFORM public._rma_bank_finance_only();
  v_st := public._rma_bank_open_statement(p_statement_id);
  SELECT * INTO v_sum FROM public.rma_bank_statement_summary(p_statement_id);
  IF v_sum.unmatched_count > 0 THEN
    RAISE EXCEPTION '% statement lines are not matched yet; match or book each one.', v_sum.unmatched_count USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_sum.statement_balances THEN
    RAISE EXCEPTION 'The statement does not add up: opening % + lines % is not the closing %.',
      v_sum.opening_balance, v_sum.lines_total, v_sum.closing_balance USING ERRCODE = 'P0001';
  END IF;
  IF v_sum.previous_closing IS NOT NULL AND v_sum.previous_closing <> v_st.opening_balance THEN
    RAISE EXCEPTION 'The opening balance % is not the previous statement''s closing %.', v_st.opening_balance, v_sum.previous_closing
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.bank_statements
     SET status = 'completed', completed_by = public.rma_current_user_email(), completed_at = now()
   WHERE id = p_statement_id;
END $fn$;

CREATE OR REPLACE FUNCTION public.reopen_bank_statement(p_statement_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v_st public.bank_statements;
BEGIN
  PERFORM public._rma_bank_finance_only();
  SELECT * INTO v_st FROM public.bank_statements WHERE id = p_statement_id FOR UPDATE;
  IF NOT FOUND OR v_st.status <> 'completed' THEN
    RAISE EXCEPTION 'Only a completed statement can be reopened.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_statements s WHERE s.account_id = v_st.account_id AND s.id <> v_st.id
               AND (s.statement_date, s.created_at) > (v_st.statement_date, v_st.created_at)) THEN
    RAISE EXCEPTION 'Only the latest statement on an account can be reopened.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.bank_statements SET status = 'open', completed_by = NULL, completed_at = NULL WHERE id = p_statement_id;
END $fn$;

DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.create_bank_statement(uuid, date, text, numeric, numeric, jsonb)', 'public.add_bank_statement_line(uuid, jsonb)',
    'public.delete_bank_statement(uuid)', 'public.rma_bank_match_candidates(uuid)', 'public.match_bank_line(uuid, uuid)',
    'public.unmatch_bank_line(uuid)', 'public.auto_match_bank_statement(uuid)', 'public.book_bank_line(uuid, uuid, text)',
    'public.rma_bank_statement_summary(uuid)', 'public.complete_bank_statement(uuid)', 'public.reopen_bank_statement(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END
$grants$;

-- ── 7. the month-end checklist counts unreconciled bank accounts ─────────────
DO $rw$
DECLARE
  v_def text;
  v_old text := E'  -- bank reconciliation arrives with bank accounts (A-07)\n  RETURN QUERY SELECT ''bank_reconciliation''::text, NULL::bigint, NULL::numeric;';
  v_new text := E'  -- bank accounts with postings up to the month end and no completed\n'
             || E'  -- statement reaching it (A-07, 20260920)\n'
             || E'  RETURN QUERY SELECT ''bank_reconciliation''::text,\n'
             || E'    (SELECT count(*) FROM public.gl_accounts a\n'
             || E'      WHERE a.is_bank AND a.is_postable\n'
             || E'        AND EXISTS (SELECT 1 FROM public.journal_lines jl JOIN public.journal_entries e ON e.id = jl.entry_id\n'
             || E'                     WHERE jl.account_id = a.id AND e.entry_date <= v_end)\n'
             || E'        AND NOT EXISTS (SELECT 1 FROM public.bank_statements s\n'
             || E'                         WHERE s.account_id = a.id AND s.status = ''completed'' AND s.statement_date >= v_end)),\n'
             || E'    NULL::numeric;';
BEGIN
  v_def := replace(pg_get_functiondef('public.rma_period_close_checklist(date)'::regprocedure), E'\r\n', E'\n');
  IF position('public.bank_statements' IN v_def) > 0 THEN RETURN; END IF;  -- already applied
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION '20260920: rma_period_close_checklist does not read as expected';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$rw$;

-- ── 8. Backup & Restore: the restorable BACKUP_TABLES, in order ─────────────
-- (src/test/restoreManifest.test.js). Statements after the journal lines they
-- clear.
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
    'activities', 'notifications', 'user_activity_log'
  ]::text[]
$function$;

-- ── 9. checks ────────────────────────────────────────────────────────────────
DO $chk$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.create_bank_statement(uuid, date, text, numeric, numeric, jsonb)',
                           'public.book_bank_line(uuid, uuid, text)', 'public.complete_bank_statement(uuid)',
                           'public._rma_bank_open_statement(uuid)', 'public._rma_bank_finance_only()'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION '20260920: anon can execute %', f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._rma_bank_open_statement(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '20260920: an internal bank function is client-callable';
  END IF;
  IF position('public.bank_statements' IN pg_get_functiondef('public.rma_period_close_checklist(date)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '20260920: the checklist does not count bank reconciliation';
  END IF;
END
$chk$;
