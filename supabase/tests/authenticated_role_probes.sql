-- ############################################################################
-- #  AUTHENTICATED-ROLE PROBES — BUG-061
-- #
-- #  The loopholes behind BUG-001, 002, 004, 010, 011, 034 and 087 were all
-- #  things a SIGNED-IN user could do that their role should not allow. The
-- #  integration tier in CI only holds the anon key, so it cannot see them.
-- #
-- #  This script reproduces a real signed-in API call without any password:
-- #  it sets the JWT claims PostgREST would set (email, role, sub) and switches
-- #  to the `authenticated` role, so row-level security, table grants and
-- #  guard triggers apply exactly as they do for a browser. Each loophole must
-- #  be REFUSED; each legitimate action next to it must still be ALLOWED —
-- #  a probe that only checks refusals would pass on a database that refuses
-- #  everything.
-- #
-- #  HOW TO RUN: paste into the SQL editor (or the MCP execute_sql tool) against
-- #  the project. It ENDS WITH A FORCED ROLLBACK — the result is printed in the
-- #  error message, and nothing it creates or changes is kept.
-- #
-- #  NOT RUN BY CI. The `db-tests` job is disabled (`if: false`), and running
-- #  this from CI would need a database credential in GitHub, which the owner
-- #  has declined. It is a reference script, run by hand after security-relevant
-- #  changes. Last run against production 2026-09-17: 28 of 28 passed.
-- #
-- #  It picks its own fixtures — one active account per role, a customer, a
-- #  posted invoice, a ticket, a vendor, an available unit — so it keeps working
-- #  after test data is reset. If a role has no active account it says so and
-- #  skips that role's checks rather than passing them.
-- ############################################################################

CREATE FUNCTION pg_temp.probe(p_label text, p_email text, p_sql text, p_expect text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  n bigint;
  outcome text;
  ok boolean;
  v_uid uuid;
BEGIN
  IF p_email IS NULL THEN
    RETURN format('SKIP  %-52s (no active account for this role)', p_label);
  END IF;

  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(p_email);

  PERFORM set_config('request.jwt.claims',
    json_build_object('email', p_email, 'role', 'authenticated', 'sub', v_uid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    outcome := 'ok:' || n;
  EXCEPTION WHEN OTHERS THEN
    outcome := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 110);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

  IF p_expect = 'refused' THEN
    -- 42501: RLS or a missing grant. P0001: a guard's RAISE. 23514: a guard's
    -- check_violation (the inventory ledger guard). ok:0: an UPDATE that RLS
    -- made invisible. Any OTHER error is a failure — a NOT NULL or FK error
    -- would mean the probe is broken, not that the database refused.
    ok := outcome LIKE 'err:42501%' OR outcome LIKE 'err:P0001%'
       OR outcome LIKE 'err:23514%' OR outcome = 'ok:0';
  ELSE
    ok := outcome LIKE 'ok:%' AND outcome <> 'ok:0';
  END IF;

  RETURN format('%s  %-52s expect %-7s → %s',
    CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_expect, outcome);
END $f$;

DO $do$
DECLARE
  -- one active account per role, if there is one
  viewer text := (SELECT user_email FROM public.user_roles WHERE role = 'viewer'     AND public.rma_access_is_current(status, access_expires_at) AND EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(user_email)) ORDER BY user_email LIMIT 1);
  tech   text := (SELECT user_email FROM public.user_roles WHERE role = 'technician' AND public.rma_access_is_current(status, access_expires_at) AND EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(user_email)) ORDER BY user_email LIMIT 1);
  rep    text := (SELECT user_email FROM public.user_roles WHERE role = 'sales_rep'  AND public.rma_access_is_current(status, access_expires_at) AND EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(user_email)) ORDER BY user_email LIMIT 1);
  mgr    text := (SELECT user_email FROM public.user_roles WHERE role = 'manager'    AND public.rma_access_is_current(status, access_expires_at) AND EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(user_email)) ORDER BY user_email LIMIT 1);
  admin  text := (SELECT user_email FROM public.user_roles WHERE role IN ('super_admin', 'admin') AND public.rma_access_is_current(status, access_expires_at) AND EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(user_email)) ORDER BY user_email LIMIT 1);

  cust   uuid := (SELECT id FROM public.customers ORDER BY created_date LIMIT 1);
  posted uuid := (SELECT id FROM public.crm_invoices WHERE doc_status = 'posted' ORDER BY created_at DESC LIMIT 1);
  ticket uuid := (SELECT id FROM public.rma_tickets ORDER BY created_date DESC LIMIT 1);
  brand  uuid := (SELECT id FROM public.brands ORDER BY brand_name LIMIT 1);
  unit   uuid := (SELECT id FROM public.inventory_units WHERE status = 'company_stock' AND reservation_status = 'available' ORDER BY id LIMIT 1);

  draft_inv uuid;
  rep_so uuid;
  forged_by text;
  r text[] := '{}';
  fails int;
BEGIN
  IF cust IS NULL OR posted IS NULL OR ticket IS NULL OR brand IS NULL OR unit IS NULL THEN
    RAISE EXCEPTION 'Fixtures missing (customer %, posted invoice %, ticket %, vendor %, available unit %) — seed test data first.',
      cust, posted, ticket, brand, unit;
  END IF;

  -- Fixtures, as the owner (rolled back): the rep owns a posted invoice, a
  -- draft invoice and a draft sales order.
  IF rep IS NOT NULL THEN
    UPDATE public.crm_invoices SET assigned_rep = rep WHERE id = posted;
    INSERT INTO public.crm_invoices (customer_id, created_by, assigned_rep, doc_status)
    VALUES (cust, rep, rep, 'draft') RETURNING id INTO draft_inv;
    INSERT INTO public.sales_orders (so_code, customer_id, created_by, assigned_rep, status)
    VALUES ('SO-PROBE061', cust, rep, rep, 'draft') RETURNING id INTO rep_so;
  END IF;

  -- BUG-001: the money tables are procedure-only
  r := r || pg_temp.probe('BUG-001 insert a payment (viewer)', viewer, format($s$INSERT INTO payments (customer_id, amount, method, created_by) VALUES (%L, 1, 'cash', 'x')$s$, cust), 'refused');
  r := r || pg_temp.probe('BUG-001 insert a payment (sales rep)', rep, format($s$INSERT INTO payments (customer_id, amount, method, created_by) VALUES (%L, 1, 'cash', 'x')$s$, cust), 'refused');
  r := r || pg_temp.probe('BUG-001 insert a payment (manager)', mgr, format($s$INSERT INTO payments (customer_id, amount, method, created_by) VALUES (%L, 1, 'cash', 'x')$s$, cust), 'refused');
  r := r || pg_temp.probe('BUG-001 insert a vendor payment (viewer)', viewer, format($s$INSERT INTO vendor_payments (vendor_id, amount, method, created_by) VALUES (%L, 1, 'cash', 'x')$s$, brand), 'refused');
  r := r || pg_temp.probe('BUG-001 insert a vendor payment (manager)', mgr, format($s$INSERT INTO vendor_payments (vendor_id, amount, method, created_by) VALUES (%L, 1, 'cash', 'x')$s$, brand), 'refused');

  -- BUG-002: settled documents cannot be rewritten
  r := r || pg_temp.probe('BUG-002 rewrite own POSTED invoice (sales rep)', rep, format('UPDATE crm_invoices SET discount_amount = coalesce(discount_amount,0) + 1 WHERE id = %L', posted), 'refused');
  r := r || pg_temp.probe('BUG-002 rewrite a POSTED invoice (manager)', mgr, format('UPDATE crm_invoices SET discount_amount = coalesce(discount_amount,0) + 1 WHERE id = %L', posted), 'refused');

  -- BUG-034: a rep cannot post their own draft by hand; cancelling it is allowed
  IF rep IS NOT NULL THEN
    r := r || pg_temp.probe('BUG-034 post own DRAFT invoice by hand (sales rep)', rep, format($s$UPDATE crm_invoices SET doc_status = 'posted' WHERE id = %L$s$, draft_inv), 'refused');
    r := r || pg_temp.probe('BUG-034 cancel own draft invoice (sales rep, legit)', rep, format($s$UPDATE crm_invoices SET doc_status = 'cancelled' WHERE id = %L$s$, draft_inv), 'allowed');

    -- BUG-004: a rep cannot mark their own order delivered; sending it is allowed
    r := r || pg_temp.probe('BUG-004 mark own sales order DELIVERED (sales rep)', rep, format($s$UPDATE sales_orders SET status = 'delivered' WHERE id = %L$s$, rep_so), 'refused');
    r := r || pg_temp.probe('BUG-004 send own sales order (sales rep, legit)', rep, format($s$UPDATE sales_orders SET status = 'sent' WHERE id = %L$s$, rep_so), 'allowed');
  END IF;

  -- BUG-010: inventory ledger columns are server-only
  r := r || pg_temp.probe('BUG-010 set a unit reserved by hand (technician)', tech, format($s$UPDATE inventory_units SET reservation_status = 'reserved' WHERE id = %L$s$, unit), 'refused');
  r := r || pg_temp.probe('BUG-010 set a unit cost by hand (technician)', tech, format('UPDATE inventory_units SET unit_cost_base = 1 WHERE id = %L', unit), 'refused');
  r := r || pg_temp.probe('BUG-010 edit unit notes (technician, legit)', tech, format($s$UPDATE inventory_units SET notes = 'probe' WHERE id = %L$s$, unit), 'allowed');
  r := r || pg_temp.probe('BUG-010 edit unit notes (viewer)', viewer, format($s$UPDATE inventory_units SET notes = 'probe' WHERE id = %L$s$, unit), 'refused');

  -- BUG-011: what a viewer must not write, and what a technician still may
  r := r || pg_temp.probe('BUG-011 add a ticket resolution (viewer)', viewer, format($s$INSERT INTO ticket_resolutions (ticket_id, type, created_by) VALUES (%L, 'refund', 'x')$s$, ticket), 'refused');
  r := r || pg_temp.probe('BUG-011 add a ticket resolution (sales rep)', rep, format($s$INSERT INTO ticket_resolutions (ticket_id, type, created_by) VALUES (%L, 'refund', 'x')$s$, ticket), 'refused');
  r := r || pg_temp.probe('BUG-011 add a ticket resolution (technician, legit)', tech, format($s$INSERT INTO ticket_resolutions (ticket_id, type, created_by) VALUES (%L, 'refund', 'x')$s$, ticket), 'allowed');
  r := r || pg_temp.probe('BUG-011 rewrite every notification (viewer)', viewer, $s$UPDATE notifications SET title = 'probe'$s$, 'refused');
  r := r || pg_temp.probe('BUG-011 change company appearance (viewer)', viewer, $s$UPDATE rma_config SET config_value = '{}'::jsonb WHERE config_key = 'appearance_settings'$s$, 'refused');
  r := r || pg_temp.probe('BUG-011 queue a WhatsApp job (viewer)', viewer, $s$INSERT INTO notification_queue (event_type) VALUES ('probe')$s$, 'refused');
  r := r || pg_temp.probe('BUG-011 send a notification, forged author (technician)', tech, $s$INSERT INTO notifications (type, title, message, created_by) VALUES ('probe', 'probe-061', 'probe', 'forged@example.com')$s$, 'allowed');
  IF tech IS NOT NULL THEN
    SELECT created_by INTO forged_by FROM public.notifications WHERE title = 'probe-061' ORDER BY created_date DESC LIMIT 1;
    r := r || format('%s  %-52s expect stamp   → created_by=%s',
      CASE WHEN forged_by = tech THEN 'PASS' ELSE 'FAIL' END, 'BUG-011 author stamped from the login, not the request', forged_by);
  END IF;

  -- BUG-087: below manager is refused a manager-only function
  r := r || pg_temp.probe('BUG-087 manager-only transfer_stock (technician)', tech, format('SELECT public.transfer_stock(%L, %L, %L, NULL, %L, NULL)', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), unit), 'refused');

  -- BUG-073: money tables are procedure-only, even for an administrator
  r := r || pg_temp.probe('BUG-073 insert a payment (admin)', admin, format($s$INSERT INTO payments (customer_id, amount, method, created_by) VALUES (%L, 1, 'cash', 'x')$s$, cust), 'refused');
  r := r || pg_temp.probe('BUG-073 insert a vendor payment (admin)', admin, format($s$INSERT INTO vendor_payments (vendor_id, amount, method, created_by) VALUES (%L, 1, 'cash', 'x')$s$, brand), 'refused');
  r := r || pg_temp.probe('BUG-073 rewrite vendor payment amounts (admin)', admin, 'UPDATE vendor_payments SET amount = amount + 1', 'refused');

  -- BUG-030: parts used on a ticket go through rma_ticket_part_add, never the table
  r := r || pg_temp.probe('BUG-030 insert a ticket part directly (technician)', tech, format('INSERT INTO ticket_parts (ticket_id, part_id, quantity) VALUES (%L, %L, 1)', ticket, gen_random_uuid()), 'refused');

  SELECT count(*) INTO fails FROM unnest(r) x WHERE x LIKE 'FAIL%';
  RAISE EXCEPTION E'FORCED ROLLBACK — % checks, % failed, % skipped\n%',
    cardinality(r), fails, (SELECT count(*) FROM unnest(r) x WHERE x LIKE 'SKIP%'), array_to_string(r, E'\n');
END
$do$;
