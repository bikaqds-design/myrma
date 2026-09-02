-- 20260800_document_counters_readable.sql
-- Let System Setup show the document numbering counters.
--
-- ═══ Why an RPC and not a policy ═════════════════════════════════════════════
--
-- document_sequences carries a `no_direct_client_access` policy (20260712) and
-- that is correct: it is the gapless counter behind every invoice, credit note
-- and payment code. A client that could UPDATE it could hand two documents the
-- same number, and a client that could DELETE a row would restart numbering at
-- one and collide with everything already issued.
--
-- But "cannot be written" should not mean "cannot be seen". Not knowing where
-- the counters stand is how a restore quietly reissues codes — the exact
-- failure the backup manifest already warns about. This adds a read-only
-- window and nothing else.
--
-- ═══ On changing the prefixes ════════════════════════════════════════════════
--
-- The screen shows prefixes but does not offer to change them, because they are
-- not stored: nextval_for_type builds a code from a literal. Making them
-- configurable is a real change, and a risky one — INV-2026-00019 already
-- exists, so switching the prefix does not renumber history, it creates a
-- second numbering series that a person has to reconcile by hand. Worth doing
-- deliberately, not as a side effect of a settings screen.
--
-- Paste into the Supabase SQL editor. Verify with
-- supabase/manual/20260844_verify_document_counters.sql.

CREATE OR REPLACE FUNCTION public.rma_document_counters()
RETURNS TABLE (seq_type text, last_value integer, seq_year integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- SECURITY DEFINER, so it reads past the table's own refusal. Restricted to
  -- staff: the counters reveal how many documents of each kind exist, which is
  -- commercial information.
  IF NOT public.rma_is_staff() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT d.seq_type, d.last_value, d.seq_year
    FROM public.document_sequences d
   ORDER BY d.seq_type;
END
$fn$;

REVOKE ALL ON FUNCTION public.rma_document_counters() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rma_document_counters() TO authenticated, service_role;

COMMENT ON FUNCTION public.rma_document_counters() IS
  'Read-only view of the gapless document counters, which the table itself refuses to clients. Shows where numbering stands; changes nothing.';

DO $do$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.rma_document_counters()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to apply: authenticated cannot read the document counters.';
  END IF;
  IF has_function_privilege('public', 'public.rma_document_counters()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to apply: the counters are readable by PUBLIC.';
  END IF;
  -- The table must STILL refuse direct access. An RPC that reads it is fine;
  -- a policy that opened it would not be.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='document_sequences'
       AND (qual = 'true' OR with_check = 'true')
  ) THEN
    RAISE EXCEPTION 'Refusing to apply: document_sequences has an open policy.';
  END IF;
  RAISE NOTICE 'Document counters are readable through rma_document_counters(); the table stays closed.';
END
$do$;
