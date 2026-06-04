-- ============================================================
-- pg_cron Scheduled Notifications
-- Requires: Supabase Pro plan (pg_cron + pg_net extensions)
-- ============================================================

-- 1. Extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Ensure ticket_overdue email template exists
INSERT INTO public.email_templates (template_name, template_subject, template_body, variables, is_active)
VALUES (
  'ticket_overdue',
  'Action Required: RMA Ticket {{rma_number}} is Overdue',
  E'Hello {{recipient_name}},\n\nThis is a reminder that your RMA ticket has passed its due date and is still open.\n\nTicket Number: {{rma_number}}\nCurrent Status: {{status}}\nPriority: {{priority}}\nDue Date: {{due_date}}\n\nOur team is working to resolve this as quickly as possible. We apologize for the delay.\n\nIf you have any questions, please contact us.\n\nBest regards,\n{{company_name}} Team',
  '["recipient_name","rma_number","status","priority","due_date","company_name"]',
  true
)
ON CONFLICT (template_name) DO NOTHING;

-- 3. Function: insert overdue ticket email jobs into notification_queue (runs daily via pg_cron)
CREATE OR REPLACE FUNCTION public.queue_overdue_ticket_emails()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ticket RECORD;
BEGIN
  FOR ticket IN
    SELECT
      t.id,
      t.rma_number,
      t.customer_name,
      t.customer_email,
      t.due_date,
      t.ticket_status,
      t.priority
    FROM public.rma_tickets t
    WHERE
      t.due_date IS NOT NULL
      AND t.due_date::date < CURRENT_DATE
      AND t.ticket_status NOT IN ('Closed', 'Completed', 'Cancelled', 'Rejected')
      AND t.customer_email IS NOT NULL
      AND t.customer_email <> ''
      -- Skip if already queued for this ticket in the last 23 hours (dedup)
      AND NOT EXISTS (
        SELECT 1
        FROM public.notification_queue q
        WHERE q.event_type = 'ticket.overdue'
          AND q.payload->>'ticketId' = t.id::text
          AND q.created_at > now() - interval '23 hours'
      )
  LOOP
    INSERT INTO public.notification_queue (
      job_type,
      event_type,
      payload,
      status,
      priority,
      scheduled_at,
      created_by
    ) VALUES (
      'email',
      'ticket.overdue',
      jsonb_build_object(
        'to',           ticket.customer_email,
        'templateName', 'ticket_overdue',
        'ticketId',     ticket.id::text,
        'variables',    jsonb_build_object(
          'recipient_name', COALESCE(ticket.customer_name, 'Customer'),
          'customer_name',  COALESCE(ticket.customer_name, 'Customer'),
          'rma_number',     ticket.rma_number,
          'status',         ticket.ticket_status,
          'priority',       COALESCE(ticket.priority, 'Normal'),
          'due_date',       to_char(ticket.due_date, 'DD/MM/YYYY'),
          'days_overdue',   (CURRENT_DATE - ticket.due_date::date)::text
        )
      ),
      'pending',
      3,
      now(),
      'pg_cron'
    );
  END LOOP;
END;
$$;

-- 4. Schedule cron jobs (idempotent — remove existing then re-add)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'queue-overdue-ticket-emails') THEN
    PERFORM cron.unschedule('queue-overdue-ticket-emails');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-notification-queue') THEN
    PERFORM cron.unschedule('drain-notification-queue');
  END IF;
END;
$$;

-- Daily at 08:00 UTC: queue overdue ticket emails
SELECT cron.schedule(
  'queue-overdue-ticket-emails',
  '0 8 * * *',
  $$SELECT public.queue_overdue_ticket_emails()$$
);

-- Every 2 minutes: drain notification queue (processes both WhatsApp and Email jobs)
SELECT cron.schedule(
  'drain-notification-queue',
  '*/2 * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://ohkynosgscfygtjxbpxq.supabase.co/functions/v1/notification-worker',
      headers := '{"Content-Type":"application/json","x-trigger-source":"pg_cron"}'::jsonb,
      body    := '{}'
    )
  $$
);
