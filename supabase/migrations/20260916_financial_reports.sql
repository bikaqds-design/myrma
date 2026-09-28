-- 20260916_financial_reports.sql — W4 / A-08a: profit and loss, balance sheet,
-- and drill-down from any account to the entries (and so the documents) behind
-- it. Read-only: every figure comes from journal_lines, the only source of
-- truth for money since A-01, so the reports tie to the journal by
-- construction.
--
-- Who: managers and accountants (rma_can_handle_cash), like the journal and
-- the trial balance.
--
-- Nothing is ever closed into retained earnings (there is no year-end closing
-- entry), so the balance sheet shows the profit or loss that has not been
-- closed as two equity lines: before the financial year the report date falls
-- in, and within it. The year starts in rma_config.fiscal_year_start_month.
-- With every entry balanced, assets = liabilities + equity always holds.
--
-- Not here: reconciling the ledger with the customer, supplier and stock
-- records (A-08b) and month-end revaluation of foreign balances (A-08c).

-- ── 1. the financial year a date falls in ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_fiscal_year_start(p_date date)
RETURNS date LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_raw   text;
  v_month int := 1;
BEGIN
  SELECT c.config_value #>> '{}' INTO v_raw FROM public.rma_config c WHERE c.config_key = 'fiscal_year_start_month';
  IF v_raw ~ '^\s*(1[0-2]|[1-9])\s*$' THEN v_month := btrim(v_raw)::int; END IF;
  IF extract(month FROM p_date)::int >= v_month THEN
    RETURN make_date(extract(year FROM p_date)::int, v_month, 1);
  END IF;
  RETURN make_date(extract(year FROM p_date)::int - 1, v_month, 1);
END $fn$;
REVOKE ALL ON FUNCTION public.rma_fiscal_year_start(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_fiscal_year_start(date) TO authenticated, service_role;

-- ── 2. profit and loss for a period ──────────────────────────────────────────
-- One row per income or expense account with postings in the period, with its
-- header (parent) for grouping. amount is on the account's normal side:
-- income credit − debit, expense debit − credit. Net profit = Σ income − Σ expense.
CREATE OR REPLACE FUNCTION public.rma_profit_and_loss(p_from date, p_to date)
RETURNS TABLE(account_id uuid, code text, name text, name_ar text, account_type text,
              parent_id uuid, parent_code text, parent_name text, parent_name_ar text, amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Only managers and accountants can read the financial reports.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Choose a period: a start date on or before its end date.' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT a.id, a.code, a.name, a.name_ar, a.account_type,
         h.id, h.code, h.name, h.name_ar,
         (CASE WHEN a.account_type = 'income' THEN sum(l.credit) - sum(l.debit)
               ELSE sum(l.debit) - sum(l.credit) END)::numeric
    FROM public.journal_lines l
    JOIN public.journal_entries e ON e.id = l.entry_id
    JOIN public.gl_accounts a ON a.id = l.account_id
    LEFT JOIN public.gl_accounts h ON h.id = a.parent_id
   WHERE a.account_type IN ('income', 'expense')
     AND e.entry_date BETWEEN p_from AND p_to
   GROUP BY a.id, a.code, a.name, a.name_ar, a.account_type, h.id, h.code, h.name, h.name_ar
   ORDER BY CASE a.account_type WHEN 'income' THEN 0 ELSE 1 END, h.code NULLS LAST, a.code;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_profit_and_loss(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_profit_and_loss(date, date) TO authenticated, service_role;

-- ── 3. balance sheet at a date ───────────────────────────────────────────────
-- kind 'account': one row per asset / liability / equity account with postings
-- on or before the date, amount on its normal side (asset debit − credit,
-- liability and equity credit − debit).
-- kind 'prior_years_earnings' / 'current_year_earnings': the profit or loss
-- not closed, before and within the financial year of p_as_of (section
-- 'equity', no account).
CREATE OR REPLACE FUNCTION public.rma_balance_sheet(p_as_of date)
RETURNS TABLE(kind text, section text, account_id uuid, code text, name text, name_ar text,
              parent_id uuid, parent_code text, parent_name text, parent_name_ar text, amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_fy date;
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Only managers and accountants can read the financial reports.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Choose the date of the balance sheet.' USING ERRCODE = 'P0001';
  END IF;
  v_fy := public.rma_fiscal_year_start(p_as_of);

  RETURN QUERY
  SELECT 'account'::text, a.account_type, a.id, a.code, a.name, a.name_ar,
         h.id, h.code, h.name, h.name_ar,
         (CASE WHEN a.account_type = 'asset' THEN sum(l.debit) - sum(l.credit)
               ELSE sum(l.credit) - sum(l.debit) END)::numeric
    FROM public.journal_lines l
    JOIN public.journal_entries e ON e.id = l.entry_id
    JOIN public.gl_accounts a ON a.id = l.account_id
    LEFT JOIN public.gl_accounts h ON h.id = a.parent_id
   WHERE a.account_type IN ('asset', 'liability', 'equity')
     AND e.entry_date <= p_as_of
   GROUP BY a.id, a.code, a.name, a.name_ar, a.account_type, h.id, h.code, h.name, h.name_ar;

  RETURN QUERY
  SELECT k.kind, 'equity'::text, NULL::uuid, NULL::text, NULL::text, NULL::text,
         NULL::uuid, NULL::text, NULL::text, NULL::text, k.amount
    FROM (
      SELECT 'prior_years_earnings'::text AS kind,
             COALESCE(sum(l.credit - l.debit) FILTER (WHERE e.entry_date < v_fy), 0)::numeric AS amount
        FROM public.journal_lines l
        JOIN public.journal_entries e ON e.id = l.entry_id
        JOIN public.gl_accounts a ON a.id = l.account_id
       WHERE a.account_type IN ('income', 'expense') AND e.entry_date <= p_as_of
      UNION ALL
      SELECT 'current_year_earnings',
             COALESCE(sum(l.credit - l.debit) FILTER (WHERE e.entry_date >= v_fy), 0)::numeric
        FROM public.journal_lines l
        JOIN public.journal_entries e ON e.id = l.entry_id
        JOIN public.gl_accounts a ON a.id = l.account_id
       WHERE a.account_type IN ('income', 'expense') AND e.entry_date <= p_as_of
    ) k;
END $fn$;
REVOKE ALL ON FUNCTION public.rma_balance_sheet(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_balance_sheet(date) TO authenticated, service_role;

-- ── 4. drill-down: one account's entries ─────────────────────────────────────
-- A page of the account's lines in date order, each with its entry and the
-- document it came from, a running balance on the account's normal side
-- starting from the balance before p_from, and the total number of lines (so
-- the screen pages in the database, BUG-066). p_from NULL = from the start.
CREATE OR REPLACE FUNCTION public.rma_account_activity(
  p_account_id uuid, p_from date, p_to date, p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS TABLE(entry_id uuid, entry_no text, entry_date date, source_type text, source_id uuid,
              source_code text, event text, memo text, debit numeric, credit numeric,
              running_balance numeric, opening_balance numeric, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_type    text;
  v_sign    int;
  v_opening numeric := 0;
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Only managers and accountants can read the financial reports.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT a.account_type INTO v_type FROM public.gl_accounts a WHERE a.id = p_account_id;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'That account does not exist.' USING ERRCODE = 'P0001';
  END IF;
  IF p_to IS NULL OR (p_from IS NOT NULL AND p_from > p_to) THEN
    RAISE EXCEPTION 'Choose a period: a start date on or before its end date.' USING ERRCODE = 'P0001';
  END IF;
  v_sign := CASE WHEN v_type IN ('asset', 'expense') THEN 1 ELSE -1 END;

  IF p_from IS NOT NULL THEN
    SELECT COALESCE(sum(v_sign * (l.debit - l.credit)), 0) INTO v_opening
      FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = p_account_id AND e.entry_date < p_from;
  END IF;

  RETURN QUERY
  WITH lines AS (
    SELECT e.id AS e_id, e.entry_no AS e_no, e.entry_date AS e_date, e.source_type AS s_type,
           e.source_id AS s_id, e.source_code AS s_code, e.event AS s_event,
           COALESCE(l.memo, e.memo) AS l_memo, l.debit AS l_debit, l.credit AS l_credit,
           v_opening + sum(v_sign * (l.debit - l.credit))
             OVER (ORDER BY e.entry_date, e.entry_no, l.line_no ROWS UNBOUNDED PRECEDING) AS running,
           count(*) OVER () AS total,
           row_number() OVER (ORDER BY e.entry_date, e.entry_no, l.line_no) AS rn
      FROM public.journal_lines l
      JOIN public.journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = p_account_id
       AND (p_from IS NULL OR e.entry_date >= p_from)
       AND e.entry_date <= p_to
  )
  SELECT x.e_id, x.e_no, x.e_date, x.s_type, x.s_id, x.s_code, x.s_event, x.l_memo,
         x.l_debit, x.l_credit, x.running::numeric, v_opening, x.total
    FROM lines x
   ORDER BY x.rn
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END $fn$;
REVOKE ALL ON FUNCTION public.rma_account_activity(uuid, date, date, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_account_activity(uuid, date, date, int, int) TO authenticated, service_role;

-- ── 5. checks ────────────────────────────────────────────────────────────────
DO $chk$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.rma_fiscal_year_start(date)', 'public.rma_profit_and_loss(date, date)',
                           'public.rma_balance_sheet(date)', 'public.rma_account_activity(uuid, date, date, int, int)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION '20260916: anon can execute %', f;
    END IF;
  END LOOP;
END
$chk$;
