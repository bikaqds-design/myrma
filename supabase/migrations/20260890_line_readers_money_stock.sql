-- ============================================================================
-- 20260890_line_readers_money_stock.sql
-- W2 / L-02, first step: the database functions that decide MONEY and STOCK
-- read a document's lines from its line table (20260884-20260889), not from
-- the line_items copy.
--
--   approve_sales_order          reserves stock for each order line
--   post_invoice                 its "the stock it bills was reserved" check
--                                (cost of goods comes from rma_invoice_cogs,
--                                which reads reservations and the ledger)
--   _credit_note_assert_within_caps   the value / per-product caps
--   rma_reservation_integrity    compares reservations with what was sold
--   rma_vi_landed_unit_costs     the cost each received unit carries
--
-- Each reads through a helper, rma_<doc>_lines_json(id), that returns the
-- lines in exactly the shape the copy has (the writers build both from the
-- same rows, so for anything written through the RPCs nothing changes). A
-- document with no rows at all — only data written outside the RPCs, e.g. a
-- restore of a backup taken before 20260883 — falls back to its stored copy,
-- so nothing already on file stops working. Dropping the copy (L-02, last
-- step) removes only that fallback.
--
-- The functions are changed by rewriting exactly the expressions below in
-- their live definitions, as 20260867 did: each must occur the stated number
-- of times, or the migration refuses to apply. Nothing else in them changes.
--
-- NOT moved here, on purpose:
--   * the credit-note approval fingerprint (submitted_hash, taken at submit and
--     re-checked at issue) hashes the stored copy; computing it differently
--     would make every note submitted before this migration fail its check. It
--     moves with the column drop.
--   * receive_vendor_invoice keeps the copy and the rows in step itself
--     (20260889) and finds lines by the copy's index, which is line_no.
--   * the identity guard compares the copy only to refuse a client edit.
-- ============================================================================

-- ── 1. the readers' helpers (internal) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_sales_order_lines_json(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
              'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
            ORDER BY l.line_no)
       FROM public.sales_order_lines l WHERE l.sales_order_id = p_id),
    (SELECT o.line_items FROM public.sales_orders o WHERE o.id = p_id AND jsonb_typeof(o.line_items) = 'array'),
    '[]'::jsonb)
$function$;

CREATE OR REPLACE FUNCTION public.rma_crm_invoice_lines_json(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
              'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
            ORDER BY l.line_no)
       FROM public.crm_invoice_lines l WHERE l.crm_invoice_id = p_id),
    (SELECT i.line_items FROM public.crm_invoices i WHERE i.id = p_id AND jsonb_typeof(i.line_items) = 'array'),
    '[]'::jsonb)
$function$;

CREATE OR REPLACE FUNCTION public.rma_credit_note_lines_json(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
              'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct,
              'restock', l.restock, 'warehouse_id', l.warehouse_id)
            ORDER BY l.line_no)
       FROM public.credit_note_lines l WHERE l.credit_note_id = p_id),
    (SELECT c.line_items FROM public.credit_notes c WHERE c.id = p_id AND jsonb_typeof(c.line_items) = 'array'),
    '[]'::jsonb)
$function$;

CREATE OR REPLACE FUNCTION public.rma_vendor_invoice_lines_json(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
              'qty_ordered', l.qty_ordered, 'qty_received', l.qty_received,
              'unit_cost', l.unit_cost, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
            ORDER BY l.line_no)
       FROM public.vendor_invoice_lines l WHERE l.vendor_invoice_id = p_id),
    (SELECT v.line_items FROM public.vendor_invoices v WHERE v.id = p_id AND jsonb_typeof(v.line_items) = 'array'),
    '[]'::jsonb)
$function$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['rma_sales_order_lines_json', 'rma_crm_invoice_lines_json', 'rma_credit_note_lines_json', 'rma_vendor_invoice_lines_json'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(uuid) FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(uuid) TO service_role', f);
  END LOOP;
END $$;

-- ── 2. the readers read the rows ─────────────────────────────────────────────
-- [function, old expression, new expression, times it must occur]
DO $$
DECLARE
  v_rules jsonb := jsonb_build_array(
    jsonb_build_array('approve_sales_order',
      'jsonb_array_elements(v_so.line_items)',
      'jsonb_array_elements(public.rma_sales_order_lines_json(v_so.id))', 1),
    jsonb_build_array('post_invoice',
      'jsonb_array_elements(COALESCE(v_inv.line_items, ''[]''::jsonb))',
      'jsonb_array_elements(public.rma_crm_invoice_lines_json(v_inv.id))', 1),
    jsonb_build_array('_credit_note_assert_within_caps',
      'jsonb_array_elements(v_cn.line_items)',
      'jsonb_array_elements(public.rma_credit_note_lines_json(v_cn.id))', 2),
    jsonb_build_array('_credit_note_assert_within_caps',
      'jsonb_array_elements(v_inv.line_items)',
      'jsonb_array_elements(public.rma_crm_invoice_lines_json(v_inv.id))', 1),
    jsonb_build_array('_credit_note_assert_within_caps',
      'jsonb_array_elements(c.line_items)',
      'jsonb_array_elements(public.rma_credit_note_lines_json(c.id))', 1),
    jsonb_build_array('rma_reservation_integrity',
      'jsonb_array_elements(so.line_items)',
      'jsonb_array_elements(public.rma_sales_order_lines_json(so.id))', 1),
    jsonb_build_array('rma_vi_landed_unit_costs',
      'jsonb_array_elements(COALESCE(v_vi.line_items, ''[]''::jsonb))',
      'jsonb_array_elements(public.rma_vendor_invoice_lines_json(v_vi.id))', 2)
  );
  v_fn    text;
  v_def   text;
  v_old   text;
  v_new   text;
  v_want  integer;
  v_have  integer;
  v_r     jsonb;
  v_defs  jsonb := '{}'::jsonb;
BEGIN
  -- every rewrite is checked before any function is replaced
  FOR v_r IN SELECT * FROM jsonb_array_elements(v_rules) LOOP
    v_fn := v_r->>0; v_old := v_r->>1; v_new := v_r->>2; v_want := (v_r->>3)::integer;
    IF NOT v_defs ? v_fn THEN
      SELECT pg_get_functiondef(p.oid) INTO STRICT v_def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_fn;
      v_defs := v_defs || jsonb_build_object(v_fn, v_def);
    END IF;
    v_def  := v_defs->>v_fn;
    v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_have <> v_want THEN
      RAISE EXCEPTION 'Refusing to apply: % holds "%" % time(s), expected %', v_fn, v_old, v_have, v_want;
    END IF;
    v_defs := jsonb_set(v_defs, ARRAY[v_fn], to_jsonb(replace(v_def, v_old, v_new)));
  END LOOP;

  FOR v_fn IN SELECT jsonb_object_keys(v_defs) LOOP
    IF (v_defs->>v_fn) ~ '\.line_items' THEN
      RAISE EXCEPTION 'Refusing to apply: % still reads line_items after the rewrite', v_fn;
    END IF;
    EXECUTE v_defs->>v_fn;   -- CREATE OR REPLACE keeps the signature and grants
  END LOOP;
END $$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_left text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('approve_sales_order', 'post_invoice', '_credit_note_assert_within_caps', 'rma_reservation_integrity', 'rma_vi_landed_unit_costs')
     AND pg_get_functiondef(p.oid) ~ '\.line_items';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: still reading the line_items copy: %', v_left;
  END IF;
  IF has_function_privilege('authenticated', 'public.rma_sales_order_lines_json(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_crm_invoice_lines_json(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_credit_note_lines_json(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_vendor_invoice_lines_json(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a lines helper is client-executable (it skips no RLS but is internal)';
  END IF;
END $$;
