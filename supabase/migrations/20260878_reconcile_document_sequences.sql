-- ============================================================================
-- 20260878_reconcile_document_sequences.sql
--
-- rma_reconcile_document_sequences(): set every document counter to the
-- highest number already issued this year.
--
-- WHY. document_sequences is deliberately outside the backup manifest (the
-- table refuses all client access, so a restore cannot write it). After a
-- restore into a fresh project the counters start at 0 while the restored
-- invoices already carry INV-2026-00001 ... INV-2026-00042. The next
-- post_invoice then gets INV-2026-00001, the UPDATE hits the unique
-- crm_invoices_inv_code_key, and because the counter bump lives in the same
-- transaction it rolls back with it: every retry produces the same number and
-- the tenant can never post an invoice again, with an error that points at
-- nothing. (Before 00000002 seeded the rows, the same mistake at least failed
-- with "Unknown sequence type".) The backup manifest already says an
-- administrator must reinstate the counters; this is the tool to do it with,
-- so it stops being a hand-written UPDATE.
--
-- WHAT IT DOES. For each document type, finds the largest numeric suffix among
-- codes shaped PREFIX-<this year>-NNNNN in the table that stores them and sets
-- the counter to that value. It NEVER lowers a counter (GREATEST), so running
-- it on a healthy project changes nothing, and it creates a missing row, so it
-- also works on a project provisioned with --no-seed.
--
-- Admin only, and a no-op for anyone else's data: it reads code columns and
-- writes only document_sequences.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rma_reconcile_document_sequences()
 RETURNS TABLE(sequence_type text, counter integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_year   integer := EXTRACT(YEAR FROM now())::integer;
  r        record;
  v_max    integer;
BEGIN
  -- current_user is the function owner inside SECURITY DEFINER; the JWT role
  -- claim is what says who is actually calling, so the guard uses the helper.
  -- Direct database sessions (the owner, service_role) carry no JWT and pass.
  IF auth.role() IN ('authenticated', 'anon')
     AND NOT COALESCE(public.rma_is_admin(), false) THEN
    RAISE EXCEPTION 'Only an administrator can reconcile document sequences'
      USING ERRCODE = '42501';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('invoice',        'crm_invoices',          'inv_code',       'INV'),
      ('credit_note',    'credit_notes',          'cn_code',        'CN'),
      ('payment',        'payments',              'payment_code',   'PAY'),
      ('vendor_invoice', 'vendor_invoices',       'vi_code',        'VI'),
      ('vendor_payment', 'vendor_payments',       'payment_code',   'VP'),
      ('batch',          'manufacturer_batches',  'batch_number',   'BATCH')
    ) AS t(seq, tbl, col, prefix)
  LOOP
    EXECUTE format(
      'SELECT COALESCE(MAX(substring(%I from %L)::integer), 0) FROM public.%I WHERE %I ~ %L',
      r.col,
      '-' || v_year::text || '-([0-9]+)$',
      r.tbl,
      r.col,
      '^' || r.prefix || '-' || v_year::text || '-[0-9]+$'
    ) INTO v_max;

    INSERT INTO public.document_sequences AS d (seq_type, seq_year, last_value)
    VALUES (r.seq, v_year, v_max)
    ON CONFLICT (seq_type) DO UPDATE
      SET seq_year   = v_year,
          -- A counter from an earlier year is about to roll over to 1 on its
          -- own, so it counts as 0 here; a current-year counter is only ever
          -- raised, never lowered.
          last_value = GREATEST(CASE WHEN d.seq_year = v_year THEN d.last_value ELSE 0 END,
                                EXCLUDED.last_value);
  END LOOP;

  RETURN QUERY
    SELECT d.seq_type, d.last_value FROM public.document_sequences d ORDER BY d.seq_type;
END;
$function$;

REVOKE ALL ON FUNCTION public.rma_reconcile_document_sequences() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_reconcile_document_sequences() TO authenticated, service_role;
