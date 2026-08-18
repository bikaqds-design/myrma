-- Verify 20260778 actually closed the leak. READ-ONLY: everything runs inside a
-- transaction that is rolled back, including the temporary accountant row.
--
-- Why this is needed: an admin session cannot prove the fix. manager_or_above
-- passes every policy, so an admin sees all rows whether the views respect RLS
-- or not. The only way to test is to become a restricted role, which is what
-- set_config('request.jwt.claims', ...) does — auth.jwt() reads that setting,
-- and rma_user_role() looks the email up in user_roles from there.
--
-- Run the whole file in one go. The final SELECT is the answer.

-- ── 1. Is the flag actually on? ──────────────────────────────────────────────
SELECT c.relname AS view_name,
       COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                  WHERE option_name = 'security_invoker'), 'off') AS security_invoker
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v'
  AND c.relname IN ('v_sales_documents','v_purchase_documents',
                    'v_customer_ledger','v_vendor_ledger')
ORDER BY c.relname;
-- Expect: all four = on.


-- ── 2. What each role can actually read through the views ───────────────────
BEGIN;

-- a throwaway accountant, so the role can be tested without creating a real
-- user. Rolled back with everything else.
INSERT INTO public.user_roles (user_email, role, status)
VALUES ('zz-verify-accountant@example.com', 'accountant', 'active')
ON CONFLICT (user_email) DO UPDATE SET role = 'accountant';

CREATE TEMP TABLE _rls_result(role_tested text, who text, sales_docs int,
                              purchase_docs int, cust_ledger int, vend_ledger int)
  ON COMMIT DROP;

DO $$
DECLARE
  r record;
  s int; p int; c int; v int;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('sales_rep',   (SELECT user_email FROM public.user_roles WHERE role='sales_rep'  AND status='active' LIMIT 1)),
      ('manager',     (SELECT user_email FROM public.user_roles WHERE role='manager'    AND status='active' LIMIT 1)),
      ('accountant',  'zz-verify-accountant@example.com'),
      ('technician',  (SELECT user_email FROM public.user_roles WHERE role='technician' AND status='active' LIMIT 1))
    ) AS t(role_name, email)
  LOOP
    CONTINUE WHEN r.email IS NULL;
    PERFORM set_config('request.jwt.claims',
                       json_build_object('email', r.email, 'role', 'authenticated')::text,
                       true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO s FROM public.v_sales_documents;
    SELECT count(*) INTO p FROM public.v_purchase_documents;
    SELECT count(*) INTO c FROM public.v_customer_ledger;
    SELECT count(*) INTO v FROM public.v_vendor_ledger;
    RESET ROLE;
    INSERT INTO _rls_result VALUES (r.role_name, r.email, s, p, c, v);
  END LOOP;
END
$$;

RESET ROLE;
SELECT * FROM _rls_result ORDER BY role_tested;

ROLLBACK;

-- ── How to read the result ───────────────────────────────────────────────────
--
--   manager     large numbers  — sees everything (manager_or_above)
--   accountant  large numbers  — sees everything, via the accountant_read_*
--                                policies; a 0 in cust_ledger or vend_ledger
--                                means a payments policy is still missing
--   sales_rep   SMALL numbers  — only their own. This is the fix. If it equals
--                                the manager count, the views are still
--                                bypassing RLS and the leak is open.
--   technician  0 or near 0    — no sales/purchasing access by design
