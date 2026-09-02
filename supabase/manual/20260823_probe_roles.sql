-- What can each role actually do?
--
-- The anonymous sweep (scripts/probe-anon-access.mjs) cannot see a defect that
-- needs a valid session, which is exactly why Finding 6 survived every earlier
-- audit: "Allow authenticated access" let any signed-in user delete every
-- customer, and no anonymous probe could ever reach it.
--
-- This asks the question that one cannot. For each role it takes a real
-- session identity and attempts real reads and writes, reporting what the
-- database actually permits.
--
-- ── How it avoids the traps this project has already hit ─────────────────────
--
--   * The SQL editor runs as `postgres`, which owns these tables and therefore
--     bypasses RLS completely. Every probe runs under SET LOCAL ROLE
--     authenticated so the policies are genuinely evaluated.
--   * Results accumulate in a plpgsql array, not a temp table. An earlier
--     attempt used a temp table and failed with "permission denied for table
--     _cash_result" — under SET LOCAL ROLE the probe could no longer write to
--     its own scratch space.
--   * Cleanup runs after RESET ROLE, as postgres, so it cannot be blocked by
--     the very policies being tested. It also runs from an EXCEPTION handler,
--     so a failure partway leaves nothing behind.
--   * One result set, returned last, because the editor shows only the last
--     statement's output.
--
-- ── What it writes ───────────────────────────────────────────────────────────
--
-- Probe accounts on @zz-probe.invalid, and sentinel customers and tickets
-- prefixed ZZ-PROBE. All are removed before the results are returned; the
-- final row of the report confirms the count remaining is zero.
--
-- Safe to run more than once.

CREATE OR REPLACE FUNCTION pg_temp.zz_probe_roles()
RETURNS TABLE(role_tested text, operation text, outcome text, detail text)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_rows   text[] := ARRAY[]::text[];
  v_roles  text[] := ARRAY['viewer','technician','sales_rep','accountant','manager','admin'];
  v_role   text;
  v_email  text;
  v_label  text;
  v_n      integer;
  v_id     uuid;
  v_left   integer;
  v_labels text[];
BEGIN
  -- ── Provision probe accounts ───────────────────────────────────────────────
  DELETE FROM public.user_roles WHERE user_email LIKE '%@zz-probe.invalid';

  FOREACH v_role IN ARRAY v_roles LOOP
    INSERT INTO public.user_roles (user_email, role, status)
    VALUES (v_role || '@zz-probe.invalid', v_role, 'active');
  END LOOP;

  -- An admin whose account is suspended. Finding 6 turned on this case: the
  -- blanket policy ignored user_roles, so suspension did nothing here.
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES ('suspended@zz-probe.invalid', 'admin', 'suspended');

  -- An admin whose access has expired.
  INSERT INTO public.user_roles (user_email, role, status, access_expires_at)
  VALUES ('expired@zz-probe.invalid', 'admin', 'active', now() - interval '1 day');

  -- 'norow@zz-probe.invalid' is deliberately never inserted.

  v_labels := v_roles || ARRAY['suspended','expired','norow'];

  -- Give every identity its own row to try updating and deleting. Without
  -- this the first role runs before any probe customer exists, and a zero-row
  -- UPDATE would be indistinguishable from a refused one.
  FOREACH v_label IN ARRAY v_labels LOOP
    INSERT INTO public.customers (customer_code, customer_type, contact_person)
    VALUES ('ZZ-PROBE-TGT-' || v_label, 'B2C', 'zz probe target');
  END LOOP;

  -- ── Run the battery for each identity ──────────────────────────────────────
  FOREACH v_label IN ARRAY v_labels LOOP
    v_email := v_label || '@zz-probe.invalid';

    PERFORM set_config('request.jwt.claims',
                       json_build_object('email', v_email, 'role', 'authenticated')::text,
                       true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    -- read customers
    BEGIN
      SELECT count(*) INTO v_n FROM public.customers;
      v_rows := v_rows || (v_label || E'\tread customers\tALLOWED\t' || v_n || ' rows visible');
    EXCEPTION WHEN OTHERS THEN
      v_rows := v_rows || (v_label || E'\tread customers\tdenied\t' || SQLERRM);
    END;

    -- insert a customer
    BEGIN
      INSERT INTO public.customers (customer_code, customer_type, contact_person)
      VALUES ('ZZ-PROBE-INS-' || v_label, 'B2C', 'zz probe')
      RETURNING id INTO v_id;
      v_rows := v_rows || (v_label || E'\tINSERT customer\tALLOWED\t-');
    EXCEPTION WHEN OTHERS THEN
      v_id := NULL;
      v_rows := v_rows || (v_label || E'\tINSERT customer\tdenied\t' || left(SQLERRM, 60));
    END;

    -- update any customer
    BEGIN
      UPDATE public.customers SET notes = 'zz probe touch'
       WHERE customer_code = 'ZZ-PROBE-TGT-' || v_label;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_rows := v_rows || (v_label || E'\tUPDATE customer\t' ||
        CASE WHEN v_n > 0 THEN 'ALLOWED' ELSE 'no rows' END || E'\t' || v_n || ' rows');
    EXCEPTION WHEN OTHERS THEN
      v_rows := v_rows || (v_label || E'\tUPDATE customer\tdenied\t' || left(SQLERRM, 60));
    END;

    -- delete a customer — the Finding 6 headline. A viewer must not be able to.
    BEGIN
      DELETE FROM public.customers WHERE customer_code = 'ZZ-PROBE-TGT-' || v_label;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_rows := v_rows || (v_label || E'\tDELETE customer\t' ||
        CASE WHEN v_n > 0 THEN 'ALLOWED' ELSE 'no rows' END || E'\t' || v_n || ' rows');
    EXCEPTION WHEN OTHERS THEN
      v_rows := v_rows || (v_label || E'\tDELETE customer\tdenied\t' || left(SQLERRM, 60));
    END;

    -- insert an RMA ticket
    BEGIN
      INSERT INTO public.rma_tickets (rma_number, customer_name)
      VALUES ('ZZ-PROBE-' || v_label, 'zz probe');
      v_rows := v_rows || (v_label || E'\tINSERT rma_ticket\tALLOWED\t-');
    EXCEPTION WHEN OTHERS THEN
      v_rows := v_rows || (v_label || E'\tINSERT rma_ticket\tdenied\t' || left(SQLERRM, 60));
    END;

    -- read the user roster
    BEGIN
      SELECT count(*) INTO v_n FROM public.user_roles;
      v_rows := v_rows || (v_label || E'\tread user_roles\tALLOWED\t' || v_n || ' rows visible');
    EXCEPTION WHEN OTHERS THEN
      v_rows := v_rows || (v_label || E'\tread user_roles\tdenied\t' || left(SQLERRM, 60));
    END;

    -- what the role model believes this session is
    BEGIN
      v_rows := v_rows || (v_label || E'\trma_user_role()\t' ||
        COALESCE(public.rma_user_role(), 'NULL') || E'\t-');
    EXCEPTION WHEN OTHERS THEN
      v_rows := v_rows || (v_label || E'\trma_user_role()\terror\t' || left(SQLERRM, 60));
    END;

    EXECUTE 'RESET ROLE';
  END LOOP;

  -- ── Cleanup, as postgres ───────────────────────────────────────────────────
  DELETE FROM public.rma_tickets WHERE rma_number  LIKE 'ZZ-PROBE-%';
  DELETE FROM public.customers   WHERE customer_code LIKE 'ZZ-PROBE-%';
  DELETE FROM public.user_roles  WHERE user_email  LIKE '%@zz-probe.invalid';

  SELECT (SELECT count(*) FROM public.customers  WHERE customer_code LIKE 'ZZ-PROBE-%')
       + (SELECT count(*) FROM public.rma_tickets WHERE rma_number   LIKE 'ZZ-PROBE-%')
       + (SELECT count(*) FROM public.user_roles WHERE user_email    LIKE '%@zz-probe.invalid')
    INTO v_left;

  v_rows := v_rows || ('—' || E'\tprobe rows remaining\t' ||
    CASE WHEN v_left = 0 THEN 'CLEAN' ELSE 'LEFTOVER' END || E'\t' || v_left);

  RETURN QUERY
  SELECT split_part(r, E'\t', 1), split_part(r, E'\t', 2),
         split_part(r, E'\t', 3), split_part(r, E'\t', 4)
    FROM unnest(v_rows) AS r;

EXCEPTION WHEN OTHERS THEN
  -- Never leave probe data behind, whatever failed.
  EXECUTE 'RESET ROLE';
  DELETE FROM public.rma_tickets WHERE rma_number    LIKE 'ZZ-PROBE-%';
  DELETE FROM public.customers   WHERE customer_code LIKE 'ZZ-PROBE-%';
  DELETE FROM public.user_roles  WHERE user_email    LIKE '%@zz-probe.invalid';
  RAISE;
END
$fn$;

SELECT * FROM pg_temp.zz_probe_roles();

-- ─── What to expect after 20260787 ───────────────────────────────────────────
--
-- role        read cust  INSERT cust  DELETE cust  INSERT ticket  rma_user_role
-- ─────────── ────────── ──────────── ──────────── ────────────── ─────────────
-- viewer      ALLOWED    denied       no rows      denied         viewer
-- technician  ALLOWED    denied       no rows      ALLOWED        technician
-- sales_rep   ALLOWED    ALLOWED      no rows      ALLOWED        sales_rep
-- accountant  ALLOWED    denied       no rows      ALLOWED        accountant
-- manager     ALLOWED    ALLOWED      no rows      ALLOWED        manager
-- admin       ALLOWED    ALLOWED      ALLOWED      ALLOWED        admin
-- suspended   0 rows     denied       no rows      denied         NULL
-- expired     0 rows     denied       no rows      denied         NULL
-- norow       0 rows     denied       no rows      denied         NULL
--
-- Any DELETE customer showing ALLOWED for a non-admin means 20260787 did not
-- take. Any row where suspended, expired or norow is ALLOWED anything means a
-- blanket policy is still in place.
--
-- Note "no rows" rather than "denied" for DELETE: RLS filters rows rather than
-- raising, so a refused delete reports zero rows affected. Both mean the row
-- survived, which is what matters.
