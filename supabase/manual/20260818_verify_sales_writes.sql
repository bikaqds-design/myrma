-- Verify 20260781. READ-ONLY in effect: everything is inside a transaction that
-- is rolled back, so the test rows and the throwaway roles all disappear.
--
-- Exercises the writes rather than reading the policies. Two failure modes this
-- is built to avoid, both hit earlier in this work:
--
--   * An UPDATE blocked by RLS does not raise — it matches zero rows. So the
--     rep tests report a ROW COUNT, not success or failure.
--   * An INSERT can fail for reasons that have nothing to do with permissions
--     (a NOT NULL, a check constraint). So the insert is cloned from a real row
--     and the message is reported, letting an RLS refusal be told apart from a
--     constraint error. "It errored" is not the same as "it was refused".

BEGIN;

INSERT INTO public.user_roles (user_email, role, status)
VALUES ('zz-verify-tech@example.com', 'technician', 'active')
ON CONFLICT (user_email) DO UPDATE SET role = 'technician';

CREATE TEMP TABLE _w(step text, outcome text) ON COMMIT DROP;

DO $$
DECLARE
  v_rep        text;
  v_own        uuid;
  v_other      uuid;
  v_src        public.quotations%ROWTYPE;
  n            int;
  r_own text; r_other text; r_ins text; r_acct text;
BEGIN
  SELECT user_email INTO v_rep
    FROM public.user_roles WHERE role = 'sales_rep' AND status = 'active' LIMIT 1;

  SELECT id INTO v_own   FROM public.quotations
   WHERE assigned_rep = v_rep OR created_by = v_rep LIMIT 1;
  SELECT id INTO v_other FROM public.quotations
   WHERE coalesce(assigned_rep,'') <> v_rep AND coalesce(created_by,'') <> v_rep LIMIT 1;
  SELECT * INTO v_src FROM public.quotations LIMIT 1;

  -- ── as the sales rep ──────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_rep, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  UPDATE public.quotations SET notes = 'rls verification' WHERE id = v_own;
  GET DIAGNOSTICS n = ROW_COUNT;
  r_own := n || ' row(s) updated';

  UPDATE public.quotations SET notes = 'rls verification' WHERE id = v_other;
  GET DIAGNOSTICS n = ROW_COUNT;
  r_other := n || ' row(s) updated';

  RESET ROLE;

  -- ── as a technician: insert must be refused ───────────────────────────────
  PERFORM set_config('request.jwt.claims',
    json_build_object('email','zz-verify-tech@example.com','role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  BEGIN
    v_src.id := gen_random_uuid();
    v_src.qt_code := 'ZZ-VERIFY-1';
    INSERT INTO public.quotations VALUES (v_src.*);
    r_ins := 'ALLOWED — technician can create sales documents';
  EXCEPTION WHEN OTHERS THEN
    r_ins := 'refused: ' || left(SQLERRM, 70);
  END;

  RESET ROLE;

  -- ── as an accountant: read yes, write no ──────────────────────────────────
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES ('zz-verify-acct@example.com','accountant','active')
  ON CONFLICT (user_email) DO UPDATE SET role = 'accountant';

  PERFORM set_config('request.jwt.claims',
    json_build_object('email','zz-verify-acct@example.com','role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  UPDATE public.quotations SET notes = 'rls verification' WHERE id = v_own;
  GET DIAGNOSTICS n = ROW_COUNT;
  r_acct := 'update matched ' || n || ' row(s)';

  SELECT count(*) INTO n FROM public.quotations;
  r_acct := r_acct || ', reads ' || n || ' quotation(s)';

  RESET ROLE;

  INSERT INTO _w VALUES
    ('1. rep updates OWN quotation',    r_own),
    ('2. rep updates ANOTHER rep''s',   r_other),
    ('3. technician INSERT',            r_ins),
    ('4. accountant read vs write',     r_acct);
END
$$;

RESET ROLE;
SELECT * FROM _w ORDER BY step;

ROLLBACK;

-- ── Reading the result ───────────────────────────────────────────────────────
--   1. 1 row(s) updated        <- the rep can edit their own work again
--   2. 0 row(s) updated        <- and still cannot touch anyone else's
--   3. refused: ... row-level security ...   <- technician cannot create
--   4. update matched 0 row(s), reads 38 quotation(s)
--                              <- the accountant reads everything and writes
--                                 nothing, which is the whole point of the role
--
--   1 showing 0  -> the UPDATE policy did not take; the rep is still locked out
--   2 showing 1  -> the ownership test is missing from USING
--   3 ALLOWED    -> the INSERT tightening did not take
--   3 refused for a reason other than row-level security -> a constraint got in
--     the way and this test proved nothing; tell me the message
