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
    (8, 'brands'),
    (9, 'categories'),
    (10, 'subcategories'),
    (11, 'warehouses'),
    (12, 'pipelines'),
    (13, 'parts'),
    (14, 'custom_field_definitions'),
    (15, 'custom_roles'),
    (16, 'user_roles'),
    (17, 'user_preferences'),
    (18, 'announcements'),
    (19, 'kb_articles'),
    (20, 'webhooks'),
    (21, 'branding_settings'),
    (22, 'email_templates'),
    (23, 'whatsapp_templates'),
    (24, 'notification_settings'),
    (25, 'notification_preferences'),
    (26, 'email_settings'),
    (27, 'products'),
    (28, 'product_images'),
    (29, 'product_documents'),
    (30, 'company_documents'),
    (31, 'customers'),
    (32, 'contacts'),
    (33, 'customer_notes'),
    (34, 'deals'),
    (35, 'leads'),
    (36, 'rma_tickets'),
    (37, 'ticket_comments'),
    (38, 'ticket_activity'),
    (39, 'ticket_parts'),
    (40, 'ticket_resolutions'),
    (41, 'time_entries'),
    (42, 'purchase_orders'),
    (43, 'purchase_order_lines'),
    (44, 'purchase_order_revisions'),
    (45, 'vendor_invoices'),
    (46, 'vendor_invoice_lines'),
    (47, 'vendor_invoice_charges'),
    (48, 'vendor_payments'),
    (49, 'vendor_payment_applications'),
    (50, 'goods_receipts'),
    (51, 'goods_receipt_lines'),
    (52, 'vendor_invoice_receipt_lines'),
    (53, 'purchase_cost_adjustments'),
    (54, 'manufacturer_batches'),
    (55, 'inventory_units'),
    (56, 'warehouse_stock'),
    (57, 'goods_receipt_line_units'),
    (58, 'goods_receipt_line_bins'),
    (59, 'stock_moves'),
    (60, 'quotations'),
    (61, 'quotation_lines'),
    (62, 'sales_orders'),
    (63, 'sales_order_lines'),
    (64, 'deliveries'),
    (65, 'delivery_lines'),
    (66, 'delivery_line_units'),
    (67, 'delivery_line_bins'),
    (68, 'customer_returns'),
    (69, 'customer_return_lines'),
    (70, 'customer_return_line_units'),
    (71, 'customer_return_line_bins'),
    (72, 'crm_invoices'),
    (73, 'crm_invoice_lines'),
    (74, 'invoices'),
    (75, 'payments'),
    (76, 'payment_applications'),
    (77, 'credit_notes'),
    (78, 'credit_note_lines'),
    (79, 'credit_note_applications'),
    (80, 'customer_refunds'),
    (81, 'journal_entries'),
    (82, 'journal_lines'),
    (83, 'accounting_periods'),
    (84, 'period_reopen_requests'),
    (85, 'activities'),
    (86, 'notifications'),
    (87, 'user_activity_log'),
    (88, 'notification_logs'),
    (89, 'notification_queue')
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
