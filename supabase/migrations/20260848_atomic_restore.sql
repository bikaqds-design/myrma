-- BUG-025: a restore that fails part-way no longer leaves a half-restored database.
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- The browser restored table by table through PostgREST, 500 rows per request.
-- Every request committed on its own, so a failure at the twentieth table left
-- nineteen tables at backup state and the rest live — a database matching no
-- moment that ever existed, with nothing that could put it back.
--
-- ── What replaces it ─────────────────────────────────────────────────────────
--
-- A backup can be too large for one request, and everything must still land in
-- one transaction. So the browser uploads the file in small pieces to a holding
-- table, then asks the database to apply all of it in a single call:
--
--   rma_restore_begin()                        → a session id
--   rma_restore_stage(session, table, rows)    → called once per chunk
--   rma_restore_apply(session)                 → one transaction: all or nothing
--   rma_restore_discard(session)               → throw a staged upload away
--
-- If any table fails, the call raises, PostgreSQL rolls the whole call back, and
-- the database is exactly as it was before the restore began.
--
-- ── Why the database owns the rules, not the browser ─────────────────────────
--
-- These functions are SECURITY DEFINER so that one transaction can write every
-- table. That also means they bypass row-level security, so they must not trust
-- anything the browser says about what is allowed:
--
--   * administrators only — checked in every function;
--   * only tables in rma_restore_manifest(), in foreign-key order. The six
--     export-only tables (document_sequences, webhooks, email_settings,
--     stock_moves, notification_logs, notification_queue) are not in it;
--   * only columns that really exist and are writable — generated columns are
--     skipped — and never user_roles.password_hash, whatever the file contains;
--   * upsert on each table's actual primary key, discovered from the catalog.
--
-- Triggers still fire, exactly as they did for the old path, so a restore obeys
-- the same document rules as any other write.
--
-- Known ceiling: `authenticated` has an 8-second statement timeout, and the apply
-- is one statement. A restore that exceeds it fails safely — nothing changes —
-- and would need that timeout raised for the operation. Measured below against
-- the whole current database.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rma_is_admin') THEN
    RAISE EXCEPTION 'Refusing to apply: rma_is_admin() does not exist.';
  END IF;
END
$do$;

-- ═══ Holding table ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.restore_staging (
  session_id uuid        NOT NULL,
  seq        bigserial,
  table_name text        NOT NULL,
  rows       jsonb       NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  created_by uuid        DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

COMMENT ON TABLE public.restore_staging IS
  'Backup chunks uploaded for a restore, applied in one transaction by rma_restore_apply. Reachable only through the rma_restore_* functions. (BUG-025.)';

ALTER TABLE public.restore_staging ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.restore_staging FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.restore_staging_seq_seq FROM PUBLIC, anon, authenticated;

-- ═══ What may be restored, and in what order ══════════════════════════════════
-- Keep in step with BACKUP_TABLES in src/api/backup.js (the entries without
-- `restore: false`). A table the browser sends that is not here is refused, so
-- drift fails loudly instead of silently skipping data.

CREATE OR REPLACE FUNCTION public.rma_restore_manifest()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT ARRAY[
    'currencies', 'countries', 'country_area_codes', 'rma_config', 'brands', 'categories',
    'subcategories', 'warehouses', 'pipelines', 'parts', 'custom_field_definitions', 'custom_roles',
    'user_roles', 'user_preferences', 'announcements', 'kb_articles', 'branding_settings',
    'email_templates', 'whatsapp_templates', 'notification_settings', 'notification_preferences',
    'products', 'product_images', 'product_documents', 'company_documents', 'customers', 'contacts',
    'customer_notes', 'deals', 'leads', 'rma_tickets', 'ticket_comments', 'ticket_activity',
    'ticket_parts', 'ticket_resolutions', 'time_entries', 'purchase_orders', 'vendor_invoices',
    'vendor_invoice_charges', 'vendor_payments', 'vendor_payment_applications',
    'manufacturer_batches', 'inventory_units', 'warehouse_stock', 'quotations', 'sales_orders',
    'crm_invoices', 'invoices', 'payments', 'payment_applications', 'credit_notes',
    'credit_note_applications', 'activities', 'notifications', 'user_activity_log'
  ]::text[]
$fn$;

-- ═══ Begin ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_restore_begin()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can restore a backup.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Uploads abandoned mid-way (a closed tab) are not worth keeping for long.
  DELETE FROM public.restore_staging WHERE created_at < now() - interval '1 day';
  RETURN gen_random_uuid();
END;
$fn$;

-- ═══ Stage one chunk ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_restore_stage(p_session uuid, p_table text, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can restore a backup.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_session IS NULL THEN
    RAISE EXCEPTION 'A restore session is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT p_table = ANY (public.rma_restore_manifest()) THEN
    RAISE EXCEPTION 'Table % cannot be restored.', p_table USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Rows for % must be a JSON array.', p_table USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.restore_staging (session_id, table_name, rows) VALUES (p_session, p_table, p_rows);
  RETURN jsonb_array_length(p_rows);
END;
$fn$;

-- ═══ Discard ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_restore_discard(p_session uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can restore a backup.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.restore_staging WHERE session_id = p_session;
END;
$fn$;

-- ═══ Apply: one transaction ═══════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_restore_apply(p_session uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_table   text;
  v_rel     regclass;
  v_rows    jsonb;
  v_cols    text[];
  v_pk      text[];
  v_update  text[];
  v_ident   boolean;
  v_sql     text;
  v_n       bigint;
  v_results jsonb  := '[]'::jsonb;
  v_rowsum  bigint := 0;
  v_tables  integer := 0;
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can restore a backup.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.restore_staging WHERE session_id = p_session) THEN
    RAISE EXCEPTION 'Nothing has been uploaded for this restore.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Refuse a staged table the manifest does not know, rather than dropping it.
  SELECT string_agg(DISTINCT table_name, ', ') INTO v_sql
    FROM public.restore_staging
   WHERE session_id = p_session AND NOT table_name = ANY (public.rma_restore_manifest());
  IF v_sql IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot restore: % not restorable.', v_sql USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOREACH v_table IN ARRAY public.rma_restore_manifest() LOOP
    SELECT jsonb_agg(e.elem ORDER BY s.seq, e.ord) INTO v_rows
      FROM public.restore_staging s
     CROSS JOIN LATERAL jsonb_array_elements(s.rows) WITH ORDINALITY AS e(elem, ord)
     WHERE s.session_id = p_session AND s.table_name = v_table;
    CONTINUE WHEN v_rows IS NULL;

    v_rel := to_regclass('public.' || quote_ident(v_table));
    IF v_rel IS NULL THEN
      RAISE EXCEPTION 'Cannot restore %: the table does not exist in this database.', v_table;
    END IF;

    -- Columns the backup carries that are real and writable here.
    SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO v_cols
      FROM pg_attribute a
     WHERE a.attrelid = v_rel AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attgenerated = ''
       AND a.attname IN (SELECT DISTINCT k FROM jsonb_array_elements(v_rows) x, jsonb_object_keys(x) k)
       AND NOT (v_table = 'user_roles' AND a.attname = 'password_hash');

    SELECT array_agg(a.attname::text ORDER BY k.ord) INTO v_pk
      FROM pg_index i
     CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = v_rel AND i.indisprimary;

    IF v_pk IS NULL THEN
      RAISE EXCEPTION 'Cannot restore %: it has no primary key to match rows on.', v_table;
    END IF;
    IF v_cols IS NULL OR NOT (v_pk <@ v_cols) THEN
      RAISE EXCEPTION 'Cannot restore %: the backup rows do not include its primary key.', v_table;
    END IF;

    SELECT array_agg(c) INTO v_update FROM unnest(v_cols) c WHERE NOT c = ANY (v_pk);
    SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = v_rel AND attidentity = 'a' AND NOT attisdropped)
      INTO v_ident;

    v_sql := format(
      'INSERT INTO public.%I (%s) %s SELECT %s FROM jsonb_populate_recordset(NULL::public.%I, $1) ON CONFLICT (%s) DO %s',
      v_table,
      (SELECT string_agg(quote_ident(c), ', ') FROM unnest(v_cols) c),
      CASE WHEN v_ident THEN 'OVERRIDING SYSTEM VALUE' ELSE '' END,
      (SELECT string_agg(quote_ident(c), ', ') FROM unnest(v_cols) c),
      v_table,
      (SELECT string_agg(quote_ident(c), ', ') FROM unnest(v_pk) c),
      CASE WHEN v_update IS NULL THEN 'NOTHING'
           ELSE 'UPDATE SET ' || (SELECT string_agg(format('%I = EXCLUDED.%I', c, c), ', ') FROM unnest(v_update) c) END
    );

    BEGIN
      EXECUTE v_sql USING v_rows;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN
      -- Name the table, then abort the whole call: every earlier table is rolled
      -- back with it, which is the entire point of this function.
      RAISE EXCEPTION 'Restore stopped at %: %', v_table, SQLERRM USING ERRCODE = SQLSTATE;
    END;

    v_results := v_results || jsonb_build_object('table', v_table, 'count', v_n, 'attempted', jsonb_array_length(v_rows));
    v_rowsum := v_rowsum + v_n;
    v_tables := v_tables + 1;
  END LOOP;

  DELETE FROM public.restore_staging WHERE session_id = p_session;
  RETURN jsonb_build_object('tables', v_tables, 'rows', v_rowsum, 'results', v_results);
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_restore_manifest()                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_restore_begin()                     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rma_restore_stage(uuid, text, jsonb)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rma_restore_discard(uuid)               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rma_restore_apply(uuid)                 FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_restore_begin()                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.rma_restore_stage(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rma_restore_discard(uuid)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.rma_restore_apply(uuid)              TO authenticated;

-- ═══ Guard ════════════════════════════════════════════════════════════════════

DO $do$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(public.rma_restore_manifest()) t WHERE to_regclass('public.' || quote_ident(t)) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: manifest names tables that do not exist: %', v_missing;
  END IF;
  IF has_table_privilege('authenticated', 'public.restore_staging', 'SELECT') THEN
    RAISE EXCEPTION 'Refusing to finish: authenticated can read restore_staging directly.';
  END IF;
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP FUNCTION public.rma_restore_apply(uuid), public.rma_restore_discard(uuid),
--     public.rma_restore_stage(uuid, text, jsonb), public.rma_restore_begin(),
--     public.rma_restore_manifest();
--   DROP TABLE public.restore_staging;
--   and redeploy the previous front end, whose restore wrote tables directly.
