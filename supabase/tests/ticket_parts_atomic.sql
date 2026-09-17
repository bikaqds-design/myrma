-- ############################################################################
-- #  TICKET PARTS — BUG-030 (20260871, 20260873)
-- #
-- #  Stock and the ticket_parts row change together or not at all, and the
-- #  table cannot be written around the functions. Runs as real signed-in
-- #  roles (JWT claims + SET LOCAL ROLE authenticated, as in
-- #  authenticated_role_probes.sql), so grants and guards apply as they do for
-- #  a browser.
-- #
-- #  HOW TO RUN: paste into the SQL editor (or the MCP execute_sql tool). It
-- #  ENDS WITH A FORCED ROLLBACK — the result is in the error message and
-- #  nothing is kept. NOT RUN BY CI (the db-tests job is disabled).
-- #
-- #  Fixtures: one active viewer, technician and admin account, and any ticket.
-- #  The part is created inside the transaction.
-- ############################################################################

CREATE FUNCTION pg_temp.as_user(p_email text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  n bigint;
  outcome text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', p_email, 'role', 'authenticated',
      'sub', (SELECT id FROM auth.users WHERE lower(email) = lower(p_email)))::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    outcome := 'ok:' || n;
  EXCEPTION WHEN OTHERS THEN
    outcome := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 90);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN outcome;
END $f$;

DO $do$
DECLARE
  active text := 'public.rma_access_is_current(status, access_expires_at) AND EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(user_email))';
  viewer text;
  tech   text;
  admin  text;
  ticket uuid := (SELECT id FROM public.rma_tickets ORDER BY created_date DESC LIMIT 1);
  part   uuid;
  tp     uuid;
  o      text;
  r      text[] := '{}';
  fails  int;
BEGIN
  EXECUTE format('SELECT user_email FROM public.user_roles WHERE role = %L AND %s ORDER BY user_email LIMIT 1', 'viewer', active) INTO viewer;
  EXECUTE format('SELECT user_email FROM public.user_roles WHERE role = %L AND %s ORDER BY user_email LIMIT 1', 'technician', active) INTO tech;
  EXECUTE format('SELECT user_email FROM public.user_roles WHERE role IN (%L, %L) AND %s ORDER BY user_email LIMIT 1', 'super_admin', 'admin', active) INTO admin;
  IF viewer IS NULL OR tech IS NULL OR admin IS NULL OR ticket IS NULL THEN
    RAISE EXCEPTION 'Fixtures missing (viewer %, technician %, admin %, ticket %)', viewer, tech, admin, ticket;
  END IF;

  INSERT INTO public.parts (part_name, part_number, quantity, unit_cost)
  VALUES ('PROBE PART', 'PROBE-030', 3, 12.5) RETURNING id INTO part;

  -- 1. a viewer cannot add
  o := pg_temp.as_user(viewer, format('SELECT public.rma_ticket_part_add(%L, %L, 1)', ticket, part));
  r := r || format('%s viewer add refused → %s', CASE WHEN o LIKE 'err:P0001%' THEN 'PASS' ELSE 'FAIL' END, o);

  -- 2. more than in stock is refused and stock is untouched
  o := pg_temp.as_user(tech, format('SELECT public.rma_ticket_part_add(%L, %L, 5)', ticket, part));
  r := r || format('%s add 5 of 3 refused, stock %s → %s',
    CASE WHEN o LIKE 'err:P0001%Not enough%' AND (SELECT quantity FROM public.parts WHERE id = part) = 3 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT quantity FROM public.parts WHERE id = part), o);

  -- 3. zero and negative quantities are refused
  o := pg_temp.as_user(tech, format('SELECT public.rma_ticket_part_add(%L, %L, 0)', ticket, part));
  r := r || format('%s add 0 refused → %s', CASE WHEN o LIKE 'err:P0001%' THEN 'PASS' ELSE 'FAIL' END, o);
  o := pg_temp.as_user(tech, format('SELECT public.rma_ticket_part_add(%L, %L, -2)', ticket, part));
  r := r || format('%s add -2 refused, stock %s → %s',
    CASE WHEN o LIKE 'err:P0001%' AND (SELECT quantity FROM public.parts WHERE id = part) = 3 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT quantity FROM public.parts WHERE id = part), o);

  -- 4. an unknown ticket is refused before stock moves
  o := pg_temp.as_user(tech, format('SELECT public.rma_ticket_part_add(%L, %L, 1)', '00000000-0000-0000-0000-000000000000', part));
  r := r || format('%s unknown ticket refused, stock %s → %s',
    CASE WHEN o LIKE 'err:P0001%' AND (SELECT quantity FROM public.parts WHERE id = part) = 3 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT quantity FROM public.parts WHERE id = part), o);

  -- 5. the legitimate add: stock and row together, cost and actor from the server
  o := pg_temp.as_user(tech, format('SELECT public.rma_ticket_part_add(%L, %L, 2, NULL, %L)', ticket, part, '  probe  '));
  SELECT id INTO tp FROM public.ticket_parts WHERE part_id = part;
  r := r || format('%s technician adds 2: stock %s, rows %s, cost %s, added_by ok %s, notes %L → %s',
    CASE WHEN o = 'ok:1'
          AND (SELECT quantity FROM public.parts WHERE id = part) = 1
          AND (SELECT count(*) FROM public.ticket_parts WHERE part_id = part) = 1
          AND (SELECT unit_cost FROM public.ticket_parts WHERE id = tp) = 12.5
          AND (SELECT lower(added_by) FROM public.ticket_parts WHERE id = tp) = lower(tech)
          AND (SELECT notes FROM public.ticket_parts WHERE id = tp) = 'probe'
         THEN 'PASS' ELSE 'FAIL' END,
    (SELECT quantity FROM public.parts WHERE id = part),
    (SELECT count(*) FROM public.ticket_parts WHERE part_id = part),
    (SELECT unit_cost FROM public.ticket_parts WHERE id = tp),
    (SELECT lower(added_by) FROM public.ticket_parts WHERE id = tp) = lower(tech),
    (SELECT notes FROM public.ticket_parts WHERE id = tp), o);

  -- 6. the table cannot be written around the functions
  o := pg_temp.as_user(tech, format('INSERT INTO public.ticket_parts (ticket_id, part_id, quantity) VALUES (%L, %L, 1)', ticket, part));
  r := r || format('%s direct INSERT refused → %s', CASE WHEN o LIKE 'err:42501%' THEN 'PASS' ELSE 'FAIL' END, o);
  o := pg_temp.as_user(tech, format('UPDATE public.ticket_parts SET quantity = 1 WHERE id = %L', tp));
  r := r || format('%s direct UPDATE refused → %s', CASE WHEN o LIKE 'err:42501%' THEN 'PASS' ELSE 'FAIL' END, o);
  o := pg_temp.as_user(admin, format('DELETE FROM public.ticket_parts WHERE id = %L', tp));
  r := r || format('%s direct DELETE (admin) refused → %s', CASE WHEN o LIKE 'err:42501%' THEN 'PASS' ELSE 'FAIL' END, o);

  -- 7. a technician cannot remove, and stock does not move (the old remove()
  --    re-added stock and was then refused the delete)
  o := pg_temp.as_user(tech, format('SELECT public.rma_ticket_part_remove(%L)', tp));
  r := r || format('%s technician remove refused, stock %s, row kept %s → %s',
    CASE WHEN o LIKE 'err:P0001%' AND (SELECT quantity FROM public.parts WHERE id = part) = 1
          AND EXISTS (SELECT 1 FROM public.ticket_parts WHERE id = tp) THEN 'PASS' ELSE 'FAIL' END,
    (SELECT quantity FROM public.parts WHERE id = part), EXISTS (SELECT 1 FROM public.ticket_parts WHERE id = tp), o);

  -- 8. the admin removes: the row's own quantity goes back to its own part
  o := pg_temp.as_user(admin, format('SELECT public.rma_ticket_part_remove(%L)', tp));
  r := r || format('%s admin remove: stock %s, row gone %s → %s',
    CASE WHEN o = 'ok:1' AND (SELECT quantity FROM public.parts WHERE id = part) = 3
          AND NOT EXISTS (SELECT 1 FROM public.ticket_parts WHERE id = tp) THEN 'PASS' ELSE 'FAIL' END,
    (SELECT quantity FROM public.parts WHERE id = part), NOT EXISTS (SELECT 1 FROM public.ticket_parts WHERE id = tp), o);

  -- 9. removing it again is refused
  o := pg_temp.as_user(admin, format('SELECT public.rma_ticket_part_remove(%L)', tp));
  r := r || format('%s second remove refused, stock %s → %s',
    CASE WHEN o LIKE 'err:P0001%' AND (SELECT quantity FROM public.parts WHERE id = part) = 3 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT quantity FROM public.parts WHERE id = part), o);

  -- 10. deleting a ticket returns its parts (20260873) and touches no other ticket
  o := pg_temp.as_user(tech, format('SELECT public.rma_ticket_part_add(%L, %L, 2)', ticket, part));
  INSERT INTO public.rma_tickets (rma_number) VALUES ('PROBE-030-DEL') RETURNING id INTO tp;
  o := pg_temp.as_user(tech, format('SELECT public.rma_ticket_part_add(%L, %L, 1)', tp, part));
  o := pg_temp.as_user(admin, format('DELETE FROM public.rma_tickets WHERE id = %L', tp));
  r := r || format('%s admin deletes a ticket holding 1 → stock %s (expect 1), other ticket keeps its 2: %s → %s',
    CASE WHEN o = 'ok:1' AND (SELECT quantity FROM public.parts WHERE id = part) = 1
          AND (SELECT sum(quantity) FROM public.ticket_parts WHERE part_id = part) = 2 THEN 'PASS' ELSE 'FAIL' END,
    (SELECT quantity FROM public.parts WHERE id = part), (SELECT sum(quantity) FROM public.ticket_parts WHERE part_id = part), o);

  -- 11. reading is unchanged for staff
  o := pg_temp.as_user(viewer, 'SELECT 1 FROM public.ticket_parts LIMIT 1');
  r := r || format('%s viewer can still read ticket_parts → %s', CASE WHEN o LIKE 'ok:%' THEN 'PASS' ELSE 'FAIL' END, o);

  SELECT count(*) INTO fails FROM unnest(r) x WHERE x LIKE 'FAIL%';
  RAISE EXCEPTION E'FORCED ROLLBACK — % passed, % failed\n%',
    cardinality(r) - fails, fails, array_to_string(r, E'\n');
END
$do$;
