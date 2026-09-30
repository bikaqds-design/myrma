-- 20260917_subledger_reconciliation.sql — W4 / A-08b: does the ledger agree
-- with the records behind it?
--
--   receivables  the receivables account  vs  every customer statement (v_customer_ledger)
--   payables     the payables account     vs  every supplier statement (v_vendor_ledger)
--   inventory    the inventory account    vs  the cost of the stock on hand
--
-- The receivables and payables lines in the ledger do not carry the customer
-- or supplier, so the match is made per DOCUMENT: each statement row (invoice,
-- credit note, payment, refund, exchange difference; bill, supplier payment)
-- against what the ledger posted to the control account for that document
-- (journal_entries.source_id = the statement row's id; invoice, void and
-- exchange-difference entries all name their document). A difference then
-- points at one document. A document that is not in the ledger at all and was
-- final before the ledger first posted to that control account is marked
-- before_ledger (sales and purchase postings started on different days): documents
-- final before A-01 were not back-posted (owner decision, "the ledger starts
-- empty"), so those differences are expected until opening balances are
-- entered.
--
-- The statements show each document's CURRENT state (a voided document drops
-- out), so this compares the ledger as it stands now; it takes no date.
-- Inventory has no per-document match: stock is valued now (company_stock
-- units available or reserved at their cost, bins at their costed total) and
-- units or quantities with no known cost are counted, not valued.
--
-- Control accounts are the ones the posting rules point at now. Managers and
-- accountants (rma_can_handle_cash), like every ledger report.

-- ── 1. a timestamp as the tenant's own date (as rma_today does) ─────────────
CREATE OR REPLACE FUNCTION public._rma_tenant_date(p_ts timestamptz)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT (p_ts AT TIME ZONE COALESCE(
            (SELECT z.name FROM pg_timezone_names z
              WHERE z.name = (SELECT NULLIF(c.config_value #>> '{}', '') FROM public.rma_config c WHERE c.config_key = 'timezone')
              LIMIT 1),
            'UTC'))::date
$fn$;
REVOKE ALL ON FUNCTION public._rma_tenant_date(timestamptz) FROM PUBLIC, anon, authenticated;

-- ── 2. every document, statement against ledger (internal) ──────────────────
CREATE OR REPLACE FUNCTION public._rma_subledger_rows(p_area text)
RETURNS TABLE(doc_type text, doc_id uuid, doc_code text, party_id uuid, party_name text, doc_date date,
              subledger_amount numeric, ledger_amount numeric, difference numeric, in_ledger boolean, before_ledger boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_account uuid;
  v_start   timestamptz;
BEGIN
  SELECT r.account_id INTO v_account FROM public.posting_rules r
   WHERE r.role = CASE p_area WHEN 'receivables' THEN 'accounts_receivable' WHEN 'payables' THEN 'accounts_payable' END;
  -- when the ledger first posted to this control account (sales and purchase
  -- postings started on different days)
  SELECT min(e.created_at) INTO v_start
    FROM public.journal_entries e WHERE EXISTS (SELECT 1 FROM public.journal_lines l WHERE l.entry_id = e.id AND l.account_id = v_account);

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
       WHERE l.account_id = v_account AND e.source_id IS NOT NULL
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
       WHERE l.account_id = v_account AND e.source_id IS NOT NULL
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

-- ── 3. the summary ───────────────────────────────────────────────────────────
-- One row per area: the control account, its balance, what the records add up
-- to, the difference, how many documents differ (and how many of those are
-- before the ledger started). Inventory: uncosted units / quantities counted.
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
      INTO v_led FROM public.journal_lines l WHERE l.account_id = v_acc.id;

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

-- ── 4. the documents that differ, a page at a time ───────────────────────────
-- Largest difference first; total_count for paging (BUG-066).
CREATE OR REPLACE FUNCTION public.rma_subledger_differences(p_area text, p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS TABLE(doc_type text, doc_id uuid, doc_code text, party_id uuid, party_name text, doc_date date,
              subledger_amount numeric, ledger_amount numeric, difference numeric, in_ledger boolean,
              before_ledger boolean, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN
    RAISE EXCEPTION 'Only managers and accountants can read the ledger checks.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_area IS NULL OR p_area NOT IN ('receivables', 'payables') THEN
    RAISE EXCEPTION 'Documents are matched for receivables and payables only.' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT x.doc_type, x.doc_id, x.doc_code, x.party_id, x.party_name, x.doc_date,
         x.subledger_amount, x.ledger_amount, x.difference, x.in_ledger, x.before_ledger,
         count(*) OVER ()
    FROM public._rma_subledger_rows(p_area) x
   WHERE x.difference <> 0
   ORDER BY abs(x.difference) DESC, x.doc_date, x.doc_id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END $fn$;
REVOKE ALL ON FUNCTION public.rma_subledger_differences(text, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_subledger_differences(text, int, int) TO authenticated, service_role;

-- ── 5. checks ────────────────────────────────────────────────────────────────
DO $chk$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.rma_subledger_reconciliation()', 'public.rma_subledger_differences(text, int, int)',
                           'public._rma_subledger_rows(text)', 'public._rma_tenant_date(timestamptz)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION '20260917: anon can execute %', f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._rma_subledger_rows(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '20260917: _rma_subledger_rows is client-callable';
  END IF;
END
$chk$;
