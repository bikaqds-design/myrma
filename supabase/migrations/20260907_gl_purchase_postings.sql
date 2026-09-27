-- ============================================================================
-- 20260907_gl_purchase_postings.sql
-- A-01b (purchase side) — goods receipts, supplier invoices, goods received on
-- an invoice, and vendor payments post to the general ledger (20260905).
-- Posting map: docs/A01_GENERAL_LEDGER.md.
-- ============================================================================
-- Same pattern as the sales side (20260906): a trigger on each step posts
-- through _gl_post / _gl_reverse in the step's transaction, and a posting that
-- fails fails the step. All amounts in the base currency.
--
--   goods receipt confirmed   Dr inventory / Cr goods received not invoiced
--                             (each line's quantity x the cost it was booked at;
--                             unknown cost posts nothing for that line)
--   supplier invoice approved Cr payables (total x rate, vendor on the line)
--                             Cr accrued freight and duties (its charges x rate)
--                             Dr VAT receivable (tax x rate), unless purchase
--                             tax is part of cost ('purchase_tax_in_cost')
--     from goods receipts     Dr goods received not invoiced — what the linked
--                             receipt lines were booked at (the re-costing has
--                             already rewritten their cost, so the booked cost
--                             is the adjustment's old cost where there is one)
--                             Dr/Cr inventory — the revaluation of stock on hand
--                             Dr/Cr purchase price variance — the difference on
--                             goods already gone, plus whatever is left (rounding)
--     otherwise               Dr goods received not invoiced — the rest; the
--                             goods are credited out of it as they are received
--   goods received on an      Dr inventory / Cr goods received not invoiced,
--   invoice (older path)      the quantity received x the line's landed cost
--   invoice cancelled         its approval entry reversed (only from 'approved':
--   (from approved)           nothing received yet)
--   vendor payment active     Dr payables (vendor) / Cr cash, amount x its rate,
--                             on its payment date; voided: reversed
--
-- Freight and duties (vendor_invoice_charges) go into the goods' landed cost
-- but are not part of the supplier's total, and no payable records who is
-- owed them: they are credited to a new posting role, accrued_landed_costs
-- (account 2160), until the charges are billed and paid.
--
-- A trigger fires after the re-costing trigger (trg_vendor_invoices_recost_on_
-- approval) because its name sorts after it: the adjustments exist when it
-- reads them. A restore posts nothing.
--
-- Pinned by src/test/glPurchasePostings.test.js; supabase/tests/gl_purchase_postings.sql
-- and the ledger section of supabase/tests/receipt_invoicing.sql are the
-- rolled-back reference scripts.
-- ============================================================================

-- ── 1. a posting role for freight and duties owed ────────────────────────────
ALTER TABLE public.posting_rules DROP CONSTRAINT IF EXISTS posting_rules_role_check;
ALTER TABLE public.posting_rules ADD CONSTRAINT posting_rules_role_check CHECK (role IN (
  'accounts_receivable', 'accounts_payable', 'inventory', 'goods_received_not_invoiced',
  'sales_revenue', 'sales_tax_payable', 'purchase_tax_receivable', 'cost_of_goods_sold',
  'purchase_price_variance', 'inventory_adjustment', 'cash', 'customer_deposits',
  'retained_earnings', 'opening_balance_equity', 'rounding', 'accrued_landed_costs'));

INSERT INTO public.gl_accounts (id, code, name, name_ar, account_type, parent_id, is_postable)
SELECT md5('gl_account:2160')::uuid, '2160', 'Accrued freight and duties', 'مستحقات الشحن والرسوم الجمركية',
       'liability', p.id, true
  FROM public.gl_accounts p WHERE p.code = '2000' AND NOT p.is_postable
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.posting_rules (role, account_id)
SELECT 'accrued_landed_costs', id FROM public.gl_accounts WHERE code = '2160' AND is_postable AND is_active
ON CONFLICT (role) DO NOTHING;

-- ── 2. a signed amount as a journal line (internal) ──────────────────────────
CREATE OR REPLACE FUNCTION public._gl_line(p_role text, p_amount numeric, p_vendor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT CASE WHEN COALESCE(p_amount, 0) >= 0
              THEN jsonb_build_object('role', p_role, 'debit', COALESCE(p_amount, 0), 'vendor_id', p_vendor)
              ELSE jsonb_build_object('role', p_role, 'credit', -p_amount, 'vendor_id', p_vendor) END
$fn$;

-- ── 3. goods receipts ────────────────────────────────────────────────────────
-- confirm_goods_receipt writes each line's cost before it confirms.
CREATE OR REPLACE FUNCTION public.rma_gl_post_goods_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_value numeric;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(round(qty * unit_cost_base, 2)), 0) INTO v_value
    FROM public.goods_receipt_lines WHERE goods_receipt_id = NEW.id AND unit_cost_base IS NOT NULL;
  PERFORM public._gl_post('goods_receipt', NEW.id, 'confirmed', public.rma_today(), NEW.grn_code,
    'Goods receipt ' || COALESCE(NEW.grn_code, NEW.id::text), jsonb_build_array(
      public._gl_line('inventory', v_value, NEW.vendor_id),
      public._gl_line('goods_received_not_invoiced', -v_value, NEW.vendor_id)));
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_goods_receipts_gl ON public.goods_receipts;
CREATE TRIGGER trg_goods_receipts_gl AFTER UPDATE OF status ON public.goods_receipts
  FOR EACH ROW WHEN (NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed')
  EXECUTE FUNCTION public.rma_gl_post_goods_receipt();

-- ── 4. supplier invoices ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_gl_post_vendor_invoice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_rate    numeric := COALESCE(NEW.exchange_rate, 1);
  v_ap      numeric;
  v_chg     numeric;
  v_vat     numeric;
  v_tax_in  boolean;
  v_grni    numeric;
  v_reval   numeric;
  v_var     numeric;
  v_rest    numeric;
  v_memo    text := 'Supplier invoice ' || COALESCE(NEW.vi_code, NEW.supplier_invoice_no, NEW.id::text);
  v_lines   jsonb;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status = 'approved' THEN
    PERFORM public._gl_reverse('vendor_invoice', NEW.id, 'approved', 'cancelled', public.rma_today(), 'Cancels ' || v_memo);
    RETURN NULL;
  END IF;
  IF NOT (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved') THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE((config_value #>> '{}')::boolean, false) INTO v_tax_in
    FROM public.rma_config WHERE config_key = 'purchase_tax_in_cost';
  v_ap  := round(COALESCE(NEW.total, 0) * v_rate, 2);
  v_chg := round(COALESCE((SELECT sum(amount) FROM public.vendor_invoice_charges WHERE vendor_invoice_id = NEW.id), 0) * v_rate, 2);
  v_vat := CASE WHEN COALESCE(v_tax_in, false) THEN 0 ELSE round(COALESCE(NEW.tax_amount, 0) * v_rate, 2) END;

  IF EXISTS (SELECT 1 FROM public.vendor_invoice_receipt_lines WHERE vendor_invoice_id = NEW.id) THEN
    -- what the linked receipt lines were booked at (before this approval re-costed them)
    SELECT COALESCE(sum(round(g.qty * COALESCE(
             CASE WHEN a.goods_receipt_line_id IS NOT NULL THEN a.old_unit_cost_base ELSE g.unit_cost_base END, 0), 2)), 0)
      INTO v_grni
      FROM public.vendor_invoice_receipt_lines k
      JOIN public.goods_receipt_lines g ON g.id = k.goods_receipt_line_id
      LEFT JOIN LATERAL (SELECT x.goods_receipt_line_id, x.old_unit_cost_base
                           FROM public.purchase_cost_adjustments x
                          WHERE x.vendor_invoice_id = NEW.id AND x.goods_receipt_line_id = g.id
                          LIMIT 1) a ON true
     WHERE k.vendor_invoice_id = NEW.id;
    -- the re-costing: stock on hand revalued, goods already gone a variance
    SELECT round(COALESCE(sum(COALESCE(amount_base,
                   qty * (new_unit_cost_base - COALESCE(old_unit_cost_base, 0)))) FILTER (WHERE kind = 'revalued'), 0), 2),
           round(COALESCE(sum(COALESCE(amount_base,
                   qty * (new_unit_cost_base - COALESCE(old_unit_cost_base, 0)))) FILTER (WHERE kind = 'variance'), 0), 2)
      INTO v_reval, v_var
      FROM public.purchase_cost_adjustments WHERE vendor_invoice_id = NEW.id;
    v_rest := v_ap + v_chg - v_vat - v_grni - v_reval - v_var;
    v_lines := jsonb_build_array(
      public._gl_line('goods_received_not_invoiced', v_grni, NEW.vendor_id),
      public._gl_line('inventory', v_reval, NEW.vendor_id),
      public._gl_line('purchase_price_variance', v_var + v_rest, NEW.vendor_id));
  ELSE
    -- invoiced before it is received: the goods are credited out as they arrive
    v_lines := jsonb_build_array(
      public._gl_line('goods_received_not_invoiced', v_ap + v_chg - v_vat, NEW.vendor_id));
  END IF;

  v_lines := v_lines || jsonb_build_array(
    public._gl_line('purchase_tax_receivable', v_vat, NEW.vendor_id),
    public._gl_line('accounts_payable', -v_ap, NEW.vendor_id),
    public._gl_line('accrued_landed_costs', -v_chg, NEW.vendor_id));
  PERFORM public._gl_post('vendor_invoice', NEW.id, 'approved', public.rma_today(), NEW.vi_code, v_memo, v_lines);
  RETURN NULL;
END $fn$;

-- named to sort after trg_vendor_invoices_recost_on_approval (both AFTER):
-- the re-costing's adjustments must exist when this reads them
DROP TRIGGER IF EXISTS trg_vendor_invoices_zz_gl ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_zz_gl AFTER UPDATE OF status ON public.vendor_invoices
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.rma_gl_post_vendor_invoice();

-- ── 5. goods received on an invoice (receive_vendor_invoice) ─────────────────
-- One entry per increase of a line's received quantity, named by the line and
-- its new total, so a repeat posts nothing twice. An invoice from goods
-- receipts is never received this way (its goods arrived on the receipts).
CREATE OR REPLACE FUNCTION public.rma_gl_post_vendor_invoice_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_vi    public.vendor_invoices;
  v_cost  numeric;
  v_value numeric;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.vendor_invoice_receipt_lines WHERE vendor_invoice_id = NEW.vendor_invoice_id) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_vi FROM public.vendor_invoices WHERE id = NEW.vendor_invoice_id;
  -- only goods received on an approved invoice (receive_vendor_invoice updates
  -- the lines before the invoice's own status)
  IF v_vi.status NOT IN ('approved', 'partially_received', 'received') THEN
    RETURN NULL;
  END IF;
  SELECT c.unit_cost_base INTO v_cost FROM public.rma_vi_landed_unit_costs(NEW.vendor_invoice_id) c WHERE c.line_index = NEW.line_no;
  v_value := round((NEW.qty_received - OLD.qty_received) * COALESCE(v_cost, 0), 2);
  PERFORM public._gl_post('vendor_invoice', NEW.vendor_invoice_id, 'received:' || NEW.line_no || ':' || NEW.qty_received,
    public.rma_today(), v_vi.vi_code,
    'Received on ' || COALESCE(v_vi.vi_code, v_vi.supplier_invoice_no, v_vi.id::text) || ': ' || NEW.product_name,
    jsonb_build_array(
      public._gl_line('inventory', v_value, v_vi.vendor_id),
      public._gl_line('goods_received_not_invoiced', -v_value, v_vi.vendor_id)));
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_vendor_invoice_lines_gl ON public.vendor_invoice_lines;
CREATE TRIGGER trg_vendor_invoice_lines_gl AFTER UPDATE OF qty_received ON public.vendor_invoice_lines
  FOR EACH ROW WHEN (NEW.qty_received > OLD.qty_received)
  EXECUTE FUNCTION public.rma_gl_post_vendor_invoice_receipt();

-- ── 6. vendor payments ───────────────────────────────────────────────────────
-- Active when recorded below the approval threshold, or when approved.
CREATE OR REPLACE FUNCTION public.rma_gl_post_vendor_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_amt  numeric := round(NEW.amount * COALESCE(NEW.exchange_rate, 1), 2);
  v_memo text := 'Vendor payment ' || COALESCE(NEW.payment_code, NEW.id::text);
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
    PERFORM public._gl_post('vendor_payment', NEW.id, 'paid', COALESCE(NEW.payment_date, public.rma_today()), NEW.payment_code, v_memo,
      jsonb_build_array(
        public._gl_line('accounts_payable', v_amt, NEW.vendor_id),
        public._gl_line('cash', -v_amt)));
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'voided' AND OLD.status = 'active' THEN
    PERFORM public._gl_reverse('vendor_payment', NEW.id, 'paid', 'voided', public.rma_today(), 'Voids ' || v_memo);
  END IF;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_vendor_payments_gl ON public.vendor_payments;
CREATE TRIGGER trg_vendor_payments_gl AFTER INSERT OR UPDATE OF status ON public.vendor_payments
  FOR EACH ROW EXECUTE FUNCTION public.rma_gl_post_vendor_payment();

-- ── none of it is client-callable ────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._gl_line(text, numeric, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_gl_post_goods_receipt() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_gl_post_vendor_invoice() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_gl_post_vendor_invoice_receipt() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_gl_post_vendor_payment() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
        'trg_goods_receipts_gl', 'trg_vendor_invoices_zz_gl', 'trg_vendor_invoice_lines_gl', 'trg_vendor_payments_gl')) <> 4 THEN
    RAISE EXCEPTION 'Refusing to finish: a purchase posting trigger is missing';
  END IF;
  IF 'trg_vendor_invoices_zz_gl' <= 'trg_vendor_invoices_recost_on_approval' THEN
    RAISE EXCEPTION 'Refusing to finish: the posting trigger would fire before the re-costing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.posting_rules WHERE role = 'accrued_landed_costs') THEN
    RAISE EXCEPTION 'Refusing to finish: no account for accrued_landed_costs';
  END IF;
  IF has_function_privilege('authenticated', 'public.rma_gl_post_vendor_invoice()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a posting trigger function is client-callable';
  END IF;
END $$;
