-- Verify 20260816_bound_overdue_reminders_and_clear_backlog.sql  (audit BUG-043)
--
-- Runs inside one transaction that ends in a RAISE, so nothing is committed —
-- including the fixture ticket and any jobs the function queues for it. A
-- successful run ENDS IN AN ERROR whose message is the verdict.
--
-- Safe to run against production.
--
-- ── What it exercises ────────────────────────────────────────────────────────
--
-- Each of the three conditions that replaced the single 23-hour check, on a
-- throwaway overdue ticket:
--
--   1  a ticket with no history gets exactly one reminder
--   2  running again straight away adds nothing (a job is already pending —
--      this is the condition whose absence caused the 341-job pile-up)
--   3  with the pending job gone but a delivery logged moments ago, the gap
--      still holds it back
--   4  with the cap's worth of deliveries logged, it is silent for good
--
-- Note the fixture email address: nothing here can send, because the whole
-- transaction is rolled back, but the address is obviously non-deliverable so
-- that a mistake could not reach a real person either.

DO $verify$
DECLARE
  v_ticket   uuid;
  v_customer uuid;
  v_n        integer;
  v_out      text := '';
BEGIN
  SELECT id INTO v_customer FROM public.customers LIMIT 1;

  INSERT INTO public.rma_tickets
    (rma_number, customer_id, customer_name, customer_email,
     ticket_status, priority, due_date, products)
  VALUES ('RMA-PROBE-' || substr(gen_random_uuid()::text, 1, 8), v_customer,
          'Reminder Probe', 'probe@invalid.example',
          'Open', 'Medium', (CURRENT_DATE - 30), '[]'::jsonb)
  RETURNING id INTO v_ticket;

  -- ═══ 1. A ticket with no history gets one reminder ═════════════════════════
  PERFORM public.queue_overdue_ticket_emails();
  SELECT count(*) INTO v_n FROM public.notification_queue
   WHERE event_type = 'ticket.overdue' AND payload->>'ticketId' = v_ticket::text;
  v_out := v_out || CASE WHEN v_n = 1
    THEN 'PASS first run queued exactly 1. '
    ELSE format('FAIL first run queued %s, expected 1. ', v_n) END;

  -- ═══ 2. Running again adds nothing while one is pending ════════════════════
  -- The old function checked only whether a job had been CREATED in the last 23
  -- hours, so a queue that was not draining grew by one every day. This is the
  -- condition that stops that.
  PERFORM public.queue_overdue_ticket_emails();
  SELECT count(*) INTO v_n FROM public.notification_queue
   WHERE event_type = 'ticket.overdue' AND payload->>'ticketId' = v_ticket::text;
  v_out := v_out || CASE WHEN v_n = 1
    THEN 'PASS second run added nothing while one was pending. '
    ELSE format('FAIL second run left %s jobs, expected 1. ', v_n) END;

  -- ═══ 3. With the queue clear but a delivery just logged, the gap holds ═════
  DELETE FROM public.notification_queue
   WHERE event_type = 'ticket.overdue' AND payload->>'ticketId' = v_ticket::text;

  INSERT INTO public.notification_logs
    (ticket_id, event_type, provider, recipient, message_content, delivery_status, sent_at)
  VALUES (v_ticket, 'ticket.overdue', 'email', 'probe@invalid.example',
          'probe', 'sent', now());

  PERFORM public.queue_overdue_ticket_emails();
  SELECT count(*) INTO v_n FROM public.notification_queue
   WHERE event_type = 'ticket.overdue' AND payload->>'ticketId' = v_ticket::text;
  v_out := v_out || CASE WHEN v_n = 0
    THEN 'PASS a delivery inside the gap suppressed the next reminder. '
    ELSE format('FAIL queued %s despite a delivery moments ago. ', v_n) END;

  -- ═══ 4. At the cap, it stays silent however long ago the last one was ══════
  -- Five deliveries, all well outside the gap, so only the cap can hold it.
  INSERT INTO public.notification_logs
    (ticket_id, event_type, provider, recipient, message_content, delivery_status, sent_at)
  SELECT v_ticket, 'ticket.overdue', 'email', 'probe@invalid.example',
         'probe', 'sent', now() - make_interval(days => 30 + g)
    FROM generate_series(1, 5) AS g;

  DELETE FROM public.notification_logs
   WHERE ticket_id = v_ticket AND sent_at > now() - interval '1 minute';

  PERFORM public.queue_overdue_ticket_emails();
  SELECT count(*) INTO v_n FROM public.notification_queue
   WHERE event_type = 'ticket.overdue' AND payload->>'ticketId' = v_ticket::text;
  v_out := v_out || CASE WHEN v_n = 0
    THEN 'PASS the cap held with 5 deliveries logged and none recent.'
    ELSE format('FAIL queued %s despite being at the cap.', v_n) END;

  RAISE EXCEPTION 'VERIFY 20260816 (rolled back) :: %', v_out;
END
$verify$;
