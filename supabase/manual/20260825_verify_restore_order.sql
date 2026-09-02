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
    ( 1, 'currencies'),
    ( 2, 'countries'),
    ( 3, 'country_area_codes'),
    ( 4, 'document_sequences'),
    ( 5, 'rma_config'),
    ( 6, 'brands'),
    ( 7, 'categories'),
    ( 8, 'subcategories'),
    ( 9, 'warehouses'),
    (10, 'pipelines'),
    (11, 'parts'),
    (12, 'custom_field_definitions'),
    (13, 'custom_roles'),
    (14, 'user_roles'),
    (15, 'user_preferences'),
    (16, 'announcements'),
    (17, 'kb_articles'),
    (18, 'webhooks'),
    (19, 'branding_settings'),
    (20, 'email_templates'),
    (21, 'whatsapp_templates'),
    (22, 'notification_settings'),
    (23, 'notification_preferences'),
    (24, 'email_settings'),
    (25, 'products'),
    (26, 'product_images'),
    (27, 'product_documents'),
    (28, 'customers'),
    (29, 'contacts'),
    (30, 'customer_notes'),
    (31, 'deals'),
    (32, 'leads'),
    (33, 'rma_tickets'),
    (34, 'ticket_comments'),
    (35, 'ticket_activity'),
    (36, 'ticket_parts'),
    (37, 'ticket_resolutions'),
    (38, 'time_entries'),
    (39, 'purchase_orders'),
    (40, 'vendor_invoices'),
    (41, 'vendor_invoice_charges'),
    (42, 'vendor_payments'),
    (43, 'vendor_payment_applications'),
    (44, 'manufacturer_batches'),
    (45, 'inventory_units'),
    (46, 'warehouse_stock'),
    (47, 'stock_moves'),
    (48, 'quotations'),
    (49, 'sales_orders'),
    (50, 'crm_invoices'),
    (51, 'invoices'),
    (52, 'payments'),
    (53, 'payment_applications'),
    (54, 'credit_notes'),
    (55, 'credit_note_applications'),
    (56, 'activities'),
    (57, 'notifications'),
    (58, 'user_activity_log'),
    (59, 'notification_logs'),
    (60, 'notification_queue')
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
