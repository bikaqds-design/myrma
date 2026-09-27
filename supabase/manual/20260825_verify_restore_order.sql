-- Would a restore actually succeed? Check the manifest order against real FKs.
--
-- src/api/backup.js writes tables back in the order of BACKUP_TABLES, in one
-- pass, with immediate constraints. If any child table is written before the
-- parent it references, the restore fails partway — and nobody discovers that
-- until the day they need it.
--
-- The ordering in BACKUP_TABLES was reasoned out by hand and spot-checked in
-- src/test/backupCoverage.test.js against twenty parent/child pairs. Twenty is
-- not all of them. This checks every foreign key the database actually has.
--
-- Read-only. Returns nothing when the order is sound.
--
-- The list below is generated from BACKUP_TABLES. src/test/restoreOrder.test.js
-- fails if the two drift apart, so this file cannot quietly go stale — which is
-- the failure mode of every hardcoded snapshot found elsewhere in this review.

WITH manifest(ord, tbl) AS (
  VALUES
    (1, 'currencies'),
    (2, 'countries'),
    (3, 'country_area_codes'),
    (4, 'document_sequences'),
    (5, 'rma_config'),
    (6, 'gl_accounts'),
    (7, 'posting_rules'),
    (8, 'tax_codes'),
    (9, 'tax_code_rates'),
    (10, 'brands'),
    (11, 'categories'),
    (12, 'subcategories'),
    (13, 'warehouses'),
    (14, 'pipelines'),
    (15, 'parts'),
    (16, 'custom_field_definitions'),
    (17, 'custom_roles'),
    (18, 'user_roles'),
    (19, 'user_preferences'),
    (20, 'announcements'),
    (21, 'kb_articles'),
    (22, 'webhooks'),
    (23, 'branding_settings'),
    (24, 'email_templates'),
    (25, 'whatsapp_templates'),
    (26, 'notification_settings'),
    (27, 'notification_preferences'),
    (28, 'email_settings'),
    (29, 'products'),
    (30, 'product_images'),
    (31, 'product_documents'),
    (32, 'company_documents'),
    (33, 'customers'),
    (34, 'contacts'),
    (35, 'customer_notes'),
    (36, 'deals'),
    (37, 'leads'),
    (38, 'rma_tickets'),
    (39, 'ticket_comments'),
    (40, 'ticket_activity'),
    (41, 'ticket_parts'),
    (42, 'ticket_resolutions'),
    (43, 'time_entries'),
    (44, 'purchase_orders'),
    (45, 'purchase_order_lines'),
    (46, 'purchase_order_revisions'),
    (47, 'vendor_invoices'),
    (48, 'vendor_invoice_lines'),
    (49, 'vendor_invoice_charges'),
    (50, 'vendor_payments'),
    (51, 'vendor_payment_applications'),
    (52, 'goods_receipts'),
    (53, 'goods_receipt_lines'),
    (54, 'vendor_invoice_receipt_lines'),
    (55, 'purchase_cost_adjustments'),
    (56, 'manufacturer_batches'),
    (57, 'inventory_units'),
    (58, 'warehouse_stock'),
    (59, 'goods_receipt_line_units'),
    (60, 'goods_receipt_line_bins'),
    (61, 'stock_moves'),
    (62, 'quotations'),
    (63, 'quotation_lines'),
    (64, 'sales_orders'),
    (65, 'sales_order_lines'),
    (66, 'deliveries'),
    (67, 'delivery_lines'),
    (68, 'delivery_line_units'),
    (69, 'delivery_line_bins'),
    (70, 'customer_returns'),
    (71, 'customer_return_lines'),
    (72, 'customer_return_line_units'),
    (73, 'customer_return_line_bins'),
    (74, 'crm_invoices'),
    (75, 'crm_invoice_lines'),
    (76, 'invoices'),
    (77, 'payments'),
    (78, 'payment_applications'),
    (79, 'credit_notes'),
    (80, 'credit_note_lines'),
    (81, 'credit_note_applications'),
    (82, 'customer_refunds'),
    (83, 'journal_entries'),
    (84, 'journal_lines'),
    (85, 'accounting_periods'),
    (86, 'period_reopen_requests'),
    (87, 'activities'),
    (88, 'notifications'),
    (89, 'user_activity_log'),
    (90, 'notification_logs'),
    (91, 'notification_queue')
),
fk AS (
  SELECT c.relname  AS child,
         p.relname  AS parent,
         con.conname
    FROM pg_constraint con
    JOIN pg_class c      ON c.oid = con.conrelid
    JOIN pg_class p      ON p.oid = con.confrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
   WHERE con.contype = 'f'
     AND n.nspname = 'public'
)

-- 1. A child restored before its parent: the restore dies here.
SELECT 'ORDER VIOLATION'                                   AS problem,
       fk.child, fk.parent, fk.conname,
       mc.ord::text || ' before ' || mp.ord::text          AS detail
  FROM fk
  JOIN manifest mc ON mc.tbl = fk.child
  JOIN manifest mp ON mp.tbl = fk.parent
 WHERE fk.child <> fk.parent
   AND mc.ord < mp.ord

UNION ALL

-- 2. A parent that is not backed up at all. The child rows reference something
--    the restore never recreates, so they fail on insert.
SELECT 'PARENT NOT IN BACKUP', fk.child, fk.parent, fk.conname,
       'nothing restores ' || fk.parent
  FROM fk
  JOIN manifest mc ON mc.tbl = fk.child
 WHERE fk.child <> fk.parent
   AND NOT EXISTS (SELECT 1 FROM manifest m WHERE m.tbl = fk.parent)
   -- auth.users lives outside public and is recreated by the platform.
   AND fk.parent <> 'users'

UNION ALL

-- 3. Self-referencing keys. Table order cannot help here: within one table, a
--    child row inserted before its own parent row fails, because these are
--    immediate constraints checked per row. Whether it bites depends on the
--    order rows come back in, which is not guaranteed. Reported so the risk is
--    known rather than discovered during a recovery.
SELECT 'SELF-REFERENCE', fk.child, fk.parent, fk.conname,
       'row order within the table matters; consider DEFERRABLE'
  FROM fk
 WHERE fk.child = fk.parent

ORDER BY 1, 2;

-- ─── Reading the result ──────────────────────────────────────────────────────
--
-- No rows: a restore into an empty database will not hit a foreign key error.
--
-- ORDER VIOLATION or PARENT NOT IN BACKUP: BACKUP_TABLES is wrong and a restore
-- would fail partway. Fix the order in src/api/backup.js and re-run.
--
-- SELF-REFERENCE rows are expected — there are a handful, on activities,
-- ticket_comments and the three *_applications tables. They are informational:
-- each is nullable, so the risk only materialises if a parent row sorts after
-- its child within the same chunk.
