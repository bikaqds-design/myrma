-- Index the foreign keys the app filters and cascades on; drop indexes a unique
-- index already covers. (Audit finding BUG-058.)
--
-- ── What was measured (2026-09-10) ───────────────────────────────────────────
--
-- 25 foreign keys had no index whose leading column is the key. A lookup by that
-- column — a ticket's units, a pipeline's deals, the original row a reversal
-- points at — reads the whole table, and deleting a referenced row makes
-- Postgres scan the referencing table for dependants.
--
-- Honest scale: no table here holds more than 888 rows, so none of this is
-- measurably slow today. These are the tables that grow, and an index added now
-- costs kilobytes, while one added later is added under load.
--
-- ── Indexed (15) ─────────────────────────────────────────────────────────────
--   inventory_units(rma_ticket_id)      a ticket's units (inventory.ts)
--   inventory_units(warehouse_id)       warehouse breakdowns and transfers
--   ticket_activity(ticket_id)          a ticket's timeline
--   customer_notes(customer_id)         a customer's notes
--   ticket_comments(parent_comment_id)  reply threads
--   deals(pipeline_id), deals(contact_id)
--   purchase_orders(vendor_id)
--   vendor_invoices(vendor_id), vendor_invoices(purchase_order_id)
--   leads(converted_customer_id), leads(converted_deal_id)
--   payment_applications / credit_note_applications / vendor_payment_applications
--     (reverses_application_id)         every reversal looks its original up by this
--
-- ── Deliberately not indexed (10) ────────────────────────────────────────────
--   currency and country_code keys on brands, countries, customers,
--     purchase_orders, vendor_invoices, vendor_payments: they point at fixed
--     reference lists that are never deleted from, the only case such an index serves.
--   rma_tickets(product_id): nothing writes it; every row is null (see catalog.ts).
--   user_permissions(linked_customer_id): legacy table, empty.
--   notification_logs(template_id, user_id): the WhatsApp notification subsystem,
--     left alone under the current instruction to skip WhatsApp work.
--
-- ── Dropped (8): fully covered by a unique index ─────────────────────────────
--   Exact duplicates of a unique index on the same column:
--     idx_products_sku, idx_customers_code, idx_rma_tickets_number, idx_user_permissions_email
--   The leading column of a composite unique index, which serves the same lookups:
--     idx_categories_brand, idx_subcategories_category,
--     country_area_codes_country_idx, warehouse_stock_product_idx
--   Every write to those tables was maintaining two indexes for one lookup path.
--
-- ── Deliberately NOT dropped: 17 "never scanned" indexes ─────────────────────
-- pg_stat_user_indexes shows idx_scan = 0 since 2026-05-07 for 17 others, and the
-- finding suggested dropping unused ones. On tables this small the planner reads
-- the table rather than any index, so zero scans is evidence the table is small,
-- not that the index is useless. Two of them are the full-text GIN indexes that
-- product and company document search will need once there is much to search.
--
-- Plain CREATE INDEX, not CONCURRENTLY: a migration runs inside a transaction,
-- where CONCURRENTLY is not allowed. At these sizes the write lock lasts milliseconds.

-- ═══ Guard: every index about to be dropped is covered by its unique index ═══

DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('idx_products_sku',               'products_sku_key'),
      ('idx_customers_code',             'customers_customer_code_key'),
      ('idx_rma_tickets_number',         'rma_tickets_rma_number_key'),
      ('idx_user_permissions_email',     'user_permissions_user_email_key'),
      ('idx_categories_brand',           'categories_brand_id_category_name_key'),
      ('idx_subcategories_category',     'subcategories_category_id_subcategory_name_key'),
      ('country_area_codes_country_idx', 'country_area_codes_country_code_area_code_key'),
      ('warehouse_stock_product_idx',    'warehouse_stock_product_id_warehouse_id_key')
    ) AS v(redundant, covering)
  LOOP
    IF to_regclass('public.' || r.redundant) IS NULL THEN
      RAISE NOTICE '% is already gone.', r.redundant;
      CONTINUE;
    END IF;
    IF to_regclass('public.' || r.covering) IS NULL THEN
      RAISE EXCEPTION 'Refusing to apply: covering index % does not exist, so % is not redundant.', r.covering, r.redundant;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_index a
        JOIN pg_index b ON b.indrelid = a.indrelid
        JOIN pg_class ca ON ca.oid = a.indexrelid
        JOIN pg_class cb ON cb.oid = b.indexrelid
       WHERE a.indexrelid = to_regclass('public.' || r.redundant)
         AND b.indexrelid = to_regclass('public.' || r.covering)
         AND ca.relam = cb.relam
         AND b.indisunique AND b.indisvalid
         AND a.indpred IS NULL AND a.indexprs IS NULL
         AND b.indpred IS NULL AND b.indexprs IS NULL
         AND array_length(a.indkey::int2[], 1) <= array_length(b.indkey::int2[], 1)
         AND (a.indkey::int2[])[0:array_length(a.indkey::int2[], 1) - 1]
           = (b.indkey::int2[])[0:array_length(a.indkey::int2[], 1) - 1]
    ) THEN
      RAISE EXCEPTION 'Refusing to apply: % is no longer a leading-column subset of %.', r.redundant, r.covering;
    END IF;
  END LOOP;
END
$do$;

-- ═══ Foreign-key indexes ═════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS inventory_units_rma_ticket_id_idx ON public.inventory_units (rma_ticket_id);
CREATE INDEX IF NOT EXISTS inventory_units_warehouse_id_idx ON public.inventory_units (warehouse_id);
CREATE INDEX IF NOT EXISTS ticket_activity_ticket_id_idx ON public.ticket_activity (ticket_id);
CREATE INDEX IF NOT EXISTS customer_notes_customer_id_idx ON public.customer_notes (customer_id);
CREATE INDEX IF NOT EXISTS ticket_comments_parent_comment_id_idx ON public.ticket_comments (parent_comment_id);
CREATE INDEX IF NOT EXISTS deals_pipeline_id_idx ON public.deals (pipeline_id);
CREATE INDEX IF NOT EXISTS deals_contact_id_idx ON public.deals (contact_id);
CREATE INDEX IF NOT EXISTS purchase_orders_vendor_id_idx ON public.purchase_orders (vendor_id);
CREATE INDEX IF NOT EXISTS vendor_invoices_vendor_id_idx ON public.vendor_invoices (vendor_id);
CREATE INDEX IF NOT EXISTS vendor_invoices_purchase_order_id_idx ON public.vendor_invoices (purchase_order_id);
CREATE INDEX IF NOT EXISTS leads_converted_customer_id_idx ON public.leads (converted_customer_id);
CREATE INDEX IF NOT EXISTS leads_converted_deal_id_idx ON public.leads (converted_deal_id);
CREATE INDEX IF NOT EXISTS payment_applications_reverses_application_id_idx ON public.payment_applications (reverses_application_id);
CREATE INDEX IF NOT EXISTS credit_note_applications_reverses_application_id_idx ON public.credit_note_applications (reverses_application_id);
CREATE INDEX IF NOT EXISTS vendor_payment_applications_reverses_application_id_idx ON public.vendor_payment_applications (reverses_application_id);

-- ═══ Redundant indexes ═══════════════════════════════════════════════════════

DROP INDEX IF EXISTS public.idx_products_sku;
DROP INDEX IF EXISTS public.idx_customers_code;
DROP INDEX IF EXISTS public.idx_rma_tickets_number;
DROP INDEX IF EXISTS public.idx_user_permissions_email;
DROP INDEX IF EXISTS public.idx_categories_brand;
DROP INDEX IF EXISTS public.idx_subcategories_category;
DROP INDEX IF EXISTS public.country_area_codes_country_idx;
DROP INDEX IF EXISTS public.warehouse_stock_product_idx;

-- ═══ Guard: the result ═══════════════════════════════════════════════════════

DO $do$
DECLARE
  v_missing text;
  v_left    text;
BEGIN
  SELECT string_agg(v.t || '(' || v.c || ')', ', ') INTO v_missing
    FROM (VALUES
      ('inventory_units', 'rma_ticket_id'), ('inventory_units', 'warehouse_id'),
      ('ticket_activity', 'ticket_id'), ('customer_notes', 'customer_id'),
      ('ticket_comments', 'parent_comment_id'), ('deals', 'pipeline_id'), ('deals', 'contact_id'),
      ('purchase_orders', 'vendor_id'), ('vendor_invoices', 'vendor_id'), ('vendor_invoices', 'purchase_order_id'),
      ('leads', 'converted_customer_id'), ('leads', 'converted_deal_id'),
      ('payment_applications', 'reverses_application_id'),
      ('credit_note_applications', 'reverses_application_id'),
      ('vendor_payment_applications', 'reverses_application_id')
    ) AS v(t, c)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = (i.indkey::int2[])[0]
      WHERE i.indrelid = ('public.' || v.t)::regclass AND a.attname = v.c AND i.indisvalid
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: still no leading-column index on %', v_missing;
  END IF;

  SELECT string_agg(x, ', ') INTO v_left
    FROM unnest(ARRAY['idx_products_sku', 'idx_customers_code', 'idx_rma_tickets_number',
                      'idx_user_permissions_email', 'idx_categories_brand', 'idx_subcategories_category',
                      'country_area_codes_country_idx', 'warehouse_stock_product_idx']) AS x
   WHERE to_regclass('public.' || x) IS NOT NULL;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: redundant indexes still present: %', v_left;
  END IF;

  RAISE NOTICE 'BUG-058: 15 foreign keys indexed; 8 redundant indexes dropped.';
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP INDEX the 15 *_idx indexes created above, and recreate the 8 dropped:
--     CREATE INDEX idx_products_sku ON public.products (sku);
--     CREATE INDEX idx_customers_code ON public.customers (customer_code);
--     CREATE INDEX idx_rma_tickets_number ON public.rma_tickets (rma_number);
--     CREATE INDEX idx_user_permissions_email ON public.user_permissions (user_email);
--     CREATE INDEX idx_categories_brand ON public.categories (brand_id);
--     CREATE INDEX idx_subcategories_category ON public.subcategories (category_id);
--     CREATE INDEX country_area_codes_country_idx ON public.country_area_codes (country_code);
--     CREATE INDEX warehouse_stock_product_idx ON public.warehouse_stock (product_id);
