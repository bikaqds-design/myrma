-- Stop the overdue-reminder loop, and clear what it has already piled up.
-- (Audit finding BUG-043. Must be applied BEFORE the drain is repaired —
--  see 20260817 and BUG-005.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- queue_overdue_ticket_emails() runs daily and queues a reminder for every open
-- ticket past its due date. Its only guard against repeating itself was:
--
--     AND NOT EXISTS (
--       SELECT 1 FROM notification_queue q
--        WHERE q.event_type = 'ticket.overdue'
--          AND q.payload->>'ticketId' = t.id::text
--          AND q.created_at > now() - interval '23 hours'
--     )
--
-- which asks "did I queue one YESTERDAY", never "did this customer actually get
-- one" or "how many have they had". So a ticket that stays overdue accrues one
-- job per day, for ever, and nothing counts them.
--
-- ── The damage is not hypothetical ───────────────────────────────────────────
--
-- Measured on this database before the change:
--
--   RMA          queued   already sent   due          status
--   21052026-1     64         28         2026-05-28   Open
--   26052026-1     64         28         2026-06-02   Open
--   04062026-1     64         21         2026-06-10   Pending
--   05062026-1     64         19         2026-06-12   On Hold/Open
--   06062026-1     64         18         2026-06-13   On Hold
--   06082026-3     21          0         2026-08-13   In Progress
--
-- 118 duplicate overdue emails have already been delivered — between eighteen
-- and twenty-eight for a single ticket. They went out through the app: the
-- browser fires the worker after ticket events, so the queue drained in bursts
-- even while the scheduled drain was failing.
--
-- Where they landed matters, and was checked rather than assumed: every one of
-- those 118 went to the project owner's own two addresses. The customer records
-- on these tickets carry the owner's email, not an external one. So no customer
-- was actually spammed — but nothing in the code made that true, and a single
-- real address on any of these rows would have meant twenty-eight emails to a
-- stranger. The loop is bounded below on that basis, not on the basis that it
-- caused visible harm.
--
-- 341 more are queued for the same six tickets, and the queueing job is
-- healthy — it is only the DRAIN that is broken (BUG-005) — so the pile grows
-- by six a day. Repairing the drain without this migration would deliver all
-- 341 at once.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- Three conditions replace the one:
--
--   1. Nothing already waiting for this ticket. The old check looked at when a
--      job was CREATED, not whether it was still pending, which is precisely
--      why a stalled queue kept growing. This alone stops the pile-up.
--   2. Nothing actually SENT within the gap. Judged from notification_logs —
--      what the customer received — rather than from what we queued.
--   3. A hard cap on how many reminders one ticket may ever produce.
--
-- ── The two numbers, which are a judgement call ──────────────────────────────
--
-- A reminder every three days, at most five in total. They are business policy
-- rather than anything the data dictates, so they are constants at the top of
-- the function where they can be changed without unpicking the logic.
--
-- One consequence worth stating plainly: the five tickets above are already far
-- past a cap of five, so they will receive NO further reminders. Given they
-- have each had eighteen or more, that is the intended outcome and not an
-- accident of the numbers.

-- ═══ 1. The queueing function ════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.queue_overdue_ticket_emails()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  -- Policy. Change these two rather than the query below.
  c_min_gap_days  constant integer := 3;  -- at most one reminder per ticket per N days
  c_max_reminders constant integer := 5;  -- and never more than N in total, ever

  ticket RECORD;
BEGIN
  FOR ticket IN
    SELECT t.id, t.rma_number, t.customer_name, t.customer_email,
           t.due_date, t.ticket_status, t.priority
    FROM public.rma_tickets t
    WHERE t.due_date IS NOT NULL
      AND t.due_date::date < CURRENT_DATE
      AND t.ticket_status NOT IN ('Closed','Completed','Cancelled','Rejected')
      AND t.customer_email IS NOT NULL AND t.customer_email <> ''

      -- 1. Nothing already waiting to go out for this ticket. The previous
      --    version asked only whether a job had been CREATED in the last 23
      --    hours, so a queue that was not draining grew by one a day for ever.
      AND NOT EXISTS (
        SELECT 1 FROM public.notification_queue q
        WHERE q.event_type = 'ticket.overdue'
          AND q.payload->>'ticketId' = t.id::text
          AND q.status IN ('pending', 'processing')
      )

      -- 2. Nothing actually delivered inside the gap. Judged on what the
      --    customer received, not on what we queued.
      AND NOT EXISTS (
        SELECT 1 FROM public.notification_logs l
        WHERE l.ticket_id = t.id
          AND l.event_type = 'ticket.overdue'
          AND l.delivery_status = 'sent'
          AND l.sent_at > now() - make_interval(days => c_min_gap_days)
      )

      -- 3. A ceiling on the total, so a ticket that stays open for a year does
      --    not email its customer a hundred times.
      AND (
        SELECT count(*) FROM public.notification_logs l
        WHERE l.ticket_id = t.id
          AND l.event_type = 'ticket.overdue'
          AND l.delivery_status = 'sent'
      ) < c_max_reminders
  LOOP
    INSERT INTO public.notification_queue
      (job_type, event_type, payload, status, priority, scheduled_at, created_by)
    VALUES (
      'email', 'ticket.overdue',
      jsonb_build_object(
        'to', ticket.customer_email,
        'templateName', 'ticket_overdue',
        'ticketId', ticket.id::text,
        'variables', jsonb_build_object(
          'recipient_name', COALESCE(ticket.customer_name,'Customer'),
          'customer_name',  COALESCE(ticket.customer_name,'Customer'),
          'rma_number',     ticket.rma_number,
          'status',         ticket.ticket_status,
          'priority',       COALESCE(ticket.priority,'Normal'),
          'due_date',       to_char(ticket.due_date,'DD/MM/YYYY'),
          'days_overdue',   (CURRENT_DATE - ticket.due_date::date)::text
        )
      ),
      'pending', 3, now(), 'pg_cron'
    );
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.queue_overdue_ticket_emails() IS
  'Queues one overdue reminder per ticket, bounded: never while one is already pending, never within c_min_gap_days of one actually being delivered, and never more than c_max_reminders in total. The unbounded version sent five customers 18-28 emails each about one ticket (BUG-043).';

-- ═══ 2. The backlog ══════════════════════════════════════════════════════════
-- 341 jobs for six tickets. Cancelled rather than deleted, so the record of
-- what was queued and why it never went survives in the table.
--
-- Only ticket.overdue is touched. The ten pending WhatsApp jobs are left alone:
-- they are few, recent, and about ticket creation rather than a repeating
-- reminder, so they are still worth delivering when the drain returns.

UPDATE public.notification_queue
   SET status        = 'cancelled',
       error_message = 'Cancelled 2026-09-03: unbounded overdue-reminder backlog (BUG-043). '
                       || 'The customer had already received one or more reminders for this ticket; '
                       || 'delivering the backlog would have sent dozens more.'
 WHERE status = 'pending'
   AND event_type = 'ticket.overdue';

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_pending  integer;
  v_src      text;
  v_would    integer;
BEGIN
  SELECT count(*) INTO v_pending
    FROM public.notification_queue
   WHERE status = 'pending' AND event_type = 'ticket.overdue';

  IF v_pending <> 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: % overdue reminders are still pending after the clear-out. Nothing has been changed.',
      v_pending;
  END IF;

  -- The function must actually carry the new bounds.
  SELECT prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'queue_overdue_ticket_emails';

  IF v_src NOT LIKE '%c_max_reminders%' OR v_src NOT LIKE '%notification_logs%' THEN
    RAISE EXCEPTION
      'Refusing to apply: queue_overdue_ticket_emails() does not carry the new bounds. Nothing has been changed.';
  END IF;

  -- Exercise the new conditions for real: with the backlog cleared, a run must
  -- queue at most one job — the single ticket that has never had a reminder.
  -- Five of the six are far past the cap and must produce nothing.
  --
  -- The test run is then undone. Deciding to email a customer is not a
  -- migration's business; the scheduled 08:00 run will queue it on its own
  -- merits tomorrow.
  PERFORM public.queue_overdue_ticket_emails();

  SELECT count(*) INTO v_would
    FROM public.notification_queue
   WHERE status = 'pending' AND event_type = 'ticket.overdue';

  DELETE FROM public.notification_queue
   WHERE status = 'pending' AND event_type = 'ticket.overdue';

  IF v_would > 1 THEN
    RAISE EXCEPTION
      'Refusing to apply: a run immediately after the clear-out queued % reminders; expected at most 1 (the one ticket with no history), so the new conditions are not holding. Nothing has been changed.',
      v_would;
  END IF;

  RAISE NOTICE
    'Overdue reminders bounded (max 5, one per 3 days). Backlog cleared. A trial run queued % job(s) and was undone; the 08:00 job will queue legitimately from tomorrow.',
    v_would;
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- supabase/manual/20260855_verify_overdue_reminder_bounds.sql
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- The cancelled jobs can be restored with
--   UPDATE notification_queue SET status='pending', error_message=NULL
--    WHERE status='cancelled' AND error_message LIKE 'Cancelled 2026-09-03%';
-- but there is no good reason to: delivering them is the outcome this migration
-- exists to prevent. The previous, unbounded function body is in
-- 20260604_pgcron_notifications.sql.
