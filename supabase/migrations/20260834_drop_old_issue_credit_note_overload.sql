-- NOTE ON PROVENANCE: recovered on 2026-09-07 from
-- `supabase_migrations.schema_migrations` (version 20260906151553). Applied to
-- production 2026-09-06; the .sql file was never written to the repository.
-- This is the SQL that actually ran, verbatim.

-- Adding the 3-argument form in 20260833 left the original 2-argument function
-- in place, so `issue_credit_note(uuid, text)` matched BOTH and Postgres
-- refused the call with 42725 "function is not unique". The client invokes it
-- with exactly two named arguments, so credit-note issuing would have been
-- broken outright. Caught by the verification probe before anyone hit it.
--
-- The 3-argument form defaults p_close_ticket to false, so a two-argument call
-- resolves to it and behaves exactly as the old one did.

DROP FUNCTION IF EXISTS public.issue_credit_note(uuid, text);

DO $do$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'issue_credit_note';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Refusing to finish: expected exactly one issue_credit_note, found %. An ambiguous overload breaks every 2-argument call.',
      v_count;
  END IF;

  IF to_regprocedure('public.issue_credit_note(uuid, text, boolean)') IS NULL THEN
    RAISE EXCEPTION 'Refusing to finish: the surviving function is not the 3-argument form.';
  END IF;

  RAISE NOTICE 'issue_credit_note overload resolved: one function, p_close_ticket defaults to false.';
END
$do$;
