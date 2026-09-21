-- ============================================================================
-- 20260876_server_audit_log.sql                              (BL-02 / I-02)
--
-- Until now nothing recorded who changed a price, a status or a role, or who
-- deleted a row. user_activity_log is written from the browser (any signed-in
-- user can insert into it) and holds no financial events, and the documents
-- themselves keep only updated_at.
--
-- audit_log is written by a trigger, so it cannot be skipped by a client that
-- forgets to log, and it is append-only for everyone: no client or service_role
-- write of any kind, and even the table owner is refused an UPDATE, DELETE or
-- TRUNCATE. (A superuser can still disable the trigger; that is a
-- database-administrator boundary, not an application one, and Supabase's own
-- logs cover it.)
--
-- Scope: the financial documents, the stock tables, the master data that
-- prices and permissions hang off, and the access tables. The two application
-- ledgers (payment_applications, credit_note_applications) and stock_moves are
-- already append-only histories in their own right and are not duplicated here.
--
-- Found by an independent security review before this shipped, and fixed here:
--   * an accountant could read user_roles and rma_config history through the
--     log although RLS hides those tables from them -> the accountant branch
--     of the read policy is limited to the financial documents;
--   * a restore upserts through all 15 tables in ONE statement under the
--     authenticated role's 8-second timeout (20260848), so a row of audit work
--     per restored row could tip a restore that fits today into a timeout ->
--     restore suspends per-row auditing and writes ONE summary row per table
--     (action 'R') instead;
--   * TRUNCATE left no trace and authenticated held it on 12 of the 15 tables
--     -> statement-level TRUNCATE audit rows, and the privilege is revoked;
--   * service_role could INSERT forged, back-dated rows -> its write grants
--     are revoked (the trigger runs as the owner and is unaffected);
--   * the UPDATE path re-serialised the whole row once per column, which is
--     quadratic on rows carrying a large line_items -> serialised once.
--
-- Known limits, not fixed here:
--   * Edge Functions that write with the service key (admin-invite-user,
--     admin-delete-user) record actor_email = 'authenticator' and actor_role
--     = 'service_role', because a service JWT carries no email. Those
--     functions already know the real caller; passing it through needs an
--     Edge Function change and the owner's OK to deploy it.
--   * audit_log keeps personal data (a deleted customer's old row) and cannot
--     be erased, even by the owner. A data-erasure process needs an explicit,
--     logged path around the append-only trigger; decide it before real
--     customer data arrives.
--   * No per-document timeline UI, no retention/pruning, no rpc_name column
--     (nothing sets a session variable naming the calling function yet).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  table_name    text        NOT NULL,
  row_id        text,
  -- I insert, U update, D delete, T truncate, R restore summary (one per table).
  action        char(1)     NOT NULL CHECK (action IN ('I', 'U', 'D', 'T', 'R')),
  -- The JWT email of the signed-in caller. For a write that carries no JWT
  -- (a migration, a cron job) it falls back to the database login role.
  actor_email   text,
  -- The JWT role: authenticated, anon or service_role.
  actor_role    text,
  txid          bigint      NOT NULL DEFAULT txid_current(),
  -- On UPDATE only the columns that changed, and only their old and new
  -- values. On INSERT the full new row, on DELETE the full old row.
  changed_keys  text[],
  old_row       jsonb,
  new_row       jsonb
);

COMMENT ON TABLE public.audit_log IS
  'Append-only record of every insert, update, delete and truncate on the financial, stock, master-data and access tables, written by trigger. Nothing in it can be changed or removed, by a client or by the table owner. (BL-02.)';

CREATE INDEX IF NOT EXISTS audit_log_row_idx   ON public.audit_log (table_name, row_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_time_idx  ON public.audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON public.audit_log (actor_email, occurred_at DESC);

-- ── Access: read for admins and (financial rows only) accountants ───────────

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- service_role receives ALL from Supabase's default privileges at CREATE
-- TABLE, and BYPASSRLS, so without this it could forge rows.
REVOKE ALL ON public.audit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.audit_log TO authenticated, service_role;

DROP POLICY IF EXISTS audit_log_read ON public.audit_log;
CREATE POLICY audit_log_read ON public.audit_log
  FOR SELECT TO authenticated
  USING (COALESCE(
    public.rma_is_admin()
    OR (public.rma_user_role() = 'accountant'
        AND table_name IN ('quotations', 'sales_orders', 'crm_invoices', 'credit_notes',
                           'payments', 'purchase_orders', 'vendor_invoices', 'vendor_payments')),
    false));

-- ── Append-only, even for the owner ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rma_audit_log_is_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'The audit log is append-only: % is not allowed.', TG_OP
    USING ERRCODE = 'P0001';
END;
$function$;

DROP TRIGGER IF EXISTS trg_audit_log_no_change ON public.audit_log;
CREATE TRIGGER trg_audit_log_no_change
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_log_is_append_only();

DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON public.audit_log;
CREATE TRIGGER trg_audit_log_no_truncate
  BEFORE TRUNCATE ON public.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_log_is_append_only();

-- ── Redaction ───────────────────────────────────────────────────────────────
-- A value stored under a key that names a secret is replaced before it is
-- copied into the log. This works on column names only: a secret nested inside
-- a jsonb value under an innocent-looking column (rma_config.config_value is
-- one such column) is not found, so do not keep secrets there (webhook secrets
-- already live server-side, 20260825).

CREATE OR REPLACE FUNCTION public.rma_audit_redact(p_row jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(
    jsonb_object_agg(
      e.key,
      CASE WHEN e.key ~* '(password|secret|token|api_?key)'
           THEN '"[REDACTED]"'::jsonb
           ELSE e.value END),
    '{}'::jsonb)
  FROM jsonb_each(p_row) AS e
$function$;

-- ── The row trigger ─────────────────────────────────────────────────────────
-- SECURITY DEFINER so the insert into audit_log succeeds for a caller who has
-- no grant on it. The actor is read from the JWT, not from current_user, which
-- inside a definer function would always be the owner.

CREATE OR REPLACE FUNCTION public.rma_audit_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old  jsonb;
  v_new  jsonb;
  v_src  jsonb;
  v_o    jsonb;
  v_n    jsonb;
  v_keys text[];
BEGIN
  -- rma_restore_apply sets this for its own transaction and writes one summary
  -- row per table instead (see the end of this file).
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_src := to_jsonb(NEW);
    v_new := public.rma_audit_redact(v_src);

  ELSIF TG_OP = 'DELETE' THEN
    v_src := to_jsonb(OLD);
    v_old := public.rma_audit_redact(v_src);

  ELSE
    -- Serialised once each: a row can carry a large line_items, and doing this
    -- per column is quadratic in the width of the table.
    v_o := to_jsonb(OLD);
    v_n := to_jsonb(NEW);
    v_src := v_n;
    -- Which columns actually changed. A save that posts the whole row back
    -- unchanged, or only bumps a timestamp, is not an event worth a row.
    SELECT array_agg(n.key ORDER BY n.key)
      INTO v_keys
      FROM jsonb_each(v_n) AS n
     WHERE v_o -> n.key IS DISTINCT FROM n.value
       AND n.key NOT IN ('updated_at', 'updated_date');
    IF v_keys IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT jsonb_object_agg(k, v_o -> k) INTO v_old FROM unnest(v_keys) AS k;
    SELECT jsonb_object_agg(k, v_n -> k) INTO v_new FROM unnest(v_keys) AS k;
    v_old := public.rma_audit_redact(v_old);
    v_new := public.rma_audit_redact(v_new);
  END IF;

  INSERT INTO public.audit_log
    (table_name, row_id, action, actor_email, actor_role, changed_keys, old_row, new_row)
  VALUES
    (TG_TABLE_NAME,
     v_src ->> 'id',
     left(TG_OP, 1),
     coalesce(public.rma_current_user_email(), session_user),
     auth.jwt() ->> 'role',
     v_keys, v_old, v_new);

  RETURN NULL;
END;
$function$;

-- TRUNCATE has no rows, so it cannot go through the row trigger.
CREATE OR REPLACE FUNCTION public.rma_audit_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.audit_log (table_name, action, actor_email, actor_role)
  VALUES (TG_TABLE_NAME, 'T',
          coalesce(public.rma_current_user_email(), session_user),
          auth.jwt() ->> 'role');
  RETURN NULL;
END;
$function$;

-- Trigger functions cannot be called directly, and the definer needs no grant
-- to call rma_audit_redact, so nothing here is executable by a client.
REVOKE ALL ON FUNCTION public.rma_audit_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rma_audit_truncate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rma_audit_redact(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rma_audit_log_is_append_only() FROM PUBLIC;

-- ── Attach ──────────────────────────────────────────────────────────────────

DO $attach$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'quotations', 'sales_orders', 'crm_invoices', 'credit_notes', 'payments',
    'purchase_orders', 'vendor_invoices', 'vendor_payments',
    'inventory_units', 'warehouse_stock',
    'products', 'customers', 'brands',
    'user_roles', 'rma_config'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%1$s ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I '
      'FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row()', t);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_truncate_%1$s ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_truncate_%1$s AFTER TRUNCATE ON public.%1$I '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_truncate()', t);

    -- Nothing in the application truncates a table, PostgREST never emits it,
    -- and a client holding it could empty a ledger. The owner and service_role
    -- keep it (and are audited above).
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM authenticated, anon', t);
  END LOOP;
END
$attach$;

-- ── Restore: one summary row per table instead of one per row ───────────────
-- rma_restore_apply is the body from the live schema with three additions,
-- each marked "(20260876)": suspend the row trigger for this transaction,
-- record one 'R' row per restored table, and lift the suspension at the end.
-- The GUC is transaction-local, so an error rolls it back with everything else.

CREATE OR REPLACE FUNCTION public.rma_restore_apply(p_session uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  SELECT string_agg(DISTINCT table_name, ', ') INTO v_sql
    FROM public.restore_staging
   WHERE session_id = p_session AND NOT table_name = ANY (public.rma_restore_manifest());
  IF v_sql IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot restore: % not restorable.', v_sql USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- (20260876) One summary row per table below instead of one per row.
  PERFORM set_config('rma.audit_suspended', 'on', true);

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
      RAISE EXCEPTION 'Restore stopped at %: %', v_table, SQLERRM USING ERRCODE = SQLSTATE;
    END;

    v_results := v_results || jsonb_build_object('table', v_table, 'count', v_n, 'attempted', jsonb_array_length(v_rows));
    v_rowsum := v_rowsum + v_n;
    v_tables := v_tables + 1;
    INSERT INTO public.audit_log (table_name, action, actor_email, actor_role, new_row) -- (20260876)
    VALUES (v_table, 'R', coalesce(public.rma_current_user_email(), session_user), auth.jwt() ->> 'role',
            jsonb_build_object('session', p_session, 'rows_written', v_n, 'rows_attempted', jsonb_array_length(v_rows)));
  END LOOP;

  PERFORM set_config('rma.audit_suspended', 'off', true); -- (20260876)
  DELETE FROM public.restore_staging WHERE session_id = p_session;
  RETURN jsonb_build_object('tables', v_tables, 'rows', v_rowsum, 'results', v_results);
END;
$function$
;
