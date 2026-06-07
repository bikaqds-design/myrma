-- ============================================================
-- WhatsApp / Messaging Notification System
-- ============================================================
-- Tables: whatsapp_templates, notification_logs,
--         notification_settings, notification_queue
-- ============================================================

-- ── 1. Message Templates ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  display_name     TEXT        NOT NULL,
  event_type       TEXT        NOT NULL,
  provider         TEXT        NOT NULL DEFAULT 'whatsapp',
  language         TEXT        NOT NULL DEFAULT 'en',
  template_name    TEXT,                         -- registered Meta template name
  header_type      TEXT        CHECK (header_type IN ('text','document','image') OR header_type IS NULL),
  header_content   TEXT,
  body_content     TEXT        NOT NULL,
  footer_content   TEXT,
  variables        JSONB       NOT NULL DEFAULT '[]',
  attach_pdf       BOOLEAN     NOT NULL DEFAULT false,
  status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','inactive','pending_approval')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       TEXT
);

-- ── 2. Notification Logs ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_logs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  ticket_id             UUID,                    -- soft ref — tickets may be deleted
  event_type            TEXT        NOT NULL,
  provider              TEXT        NOT NULL DEFAULT 'whatsapp',
  recipient             TEXT        NOT NULL,
  recipient_name        TEXT,
  template_id           UUID        REFERENCES public.whatsapp_templates(id) ON DELETE SET NULL,
  message_content       TEXT,
  delivery_status       TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (delivery_status IN ('pending','queued','sent','delivered','read','failed','cancelled')),
  whatsapp_message_id   TEXT,
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at          TIMESTAMPTZ,
  read_at               TIMESTAMPTZ,
  response_data         JSONB,
  error_message         TEXT,
  retry_count           INTEGER     NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 3. Notification Settings ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_settings (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key   TEXT        UNIQUE NOT NULL,
  setting_value JSONB       NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT
);

-- Seed defaults (idempotent)
INSERT INTO public.notification_settings (setting_key, setting_value) VALUES
  ('whatsapp_enabled',  'false'),
  ('email_enabled',     'true'),
  ('sms_enabled',       'false'),
  ('whatsapp_config',   '{"phone_number_id":"","business_account_id":"","default_language":"en","api_version":"v20.0"}'),
  ('notification_events','{"ticket.created":true,"ticket.updated":true,"ticket.closed":true,"ticket.assigned":true,"payment.received":true,"warranty.approved":true,"replacement.approved":false,"delivery.scheduled":false}'),
  ('retry_config',       '{"max_retries":3,"retry_delay_seconds":300,"backoff_multiplier":2}'),
  ('rate_limit',         '{"messages_per_minute":60,"messages_per_day":1000}')
ON CONFLICT (setting_key) DO NOTHING;

-- ── 4. Notification Queue ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_queue (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type      TEXT        NOT NULL DEFAULT 'whatsapp'
                            CHECK (job_type IN ('whatsapp','email','sms','push')),
  event_type    TEXT        NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}',
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','processing','completed','failed','cancelled')),
  priority      INTEGER     NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  retry_count   INTEGER     NOT NULL DEFAULT 0,
  max_retries   INTEGER     NOT NULL DEFAULT 3,
  scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error_message TEXT,
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT
);

-- ── Indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_wa_templates_event_type   ON public.whatsapp_templates(event_type);
CREATE INDEX IF NOT EXISTS idx_wa_templates_provider     ON public.whatsapp_templates(provider);
CREATE INDEX IF NOT EXISTS idx_wa_templates_status       ON public.whatsapp_templates(status);

CREATE INDEX IF NOT EXISTS idx_notif_logs_ticket_id      ON public.notification_logs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_notif_logs_event_type     ON public.notification_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_notif_logs_status         ON public.notification_logs(delivery_status);
CREATE INDEX IF NOT EXISTS idx_notif_logs_sent_at        ON public.notification_logs(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_logs_provider       ON public.notification_logs(provider);
CREATE INDEX IF NOT EXISTS idx_notif_logs_recipient      ON public.notification_logs(recipient);
CREATE INDEX IF NOT EXISTS idx_notif_logs_wa_msg_id      ON public.notification_logs(whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notif_queue_status        ON public.notification_queue(status);
CREATE INDEX IF NOT EXISTS idx_notif_queue_scheduled     ON public.notification_queue(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notif_queue_job_type      ON public.notification_queue(job_type);
CREATE INDEX IF NOT EXISTS idx_notif_queue_priority      ON public.notification_queue(priority, status, scheduled_at);

-- ── RLS ───────────────────────────────────────────────────────

ALTER TABLE public.whatsapp_templates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_queue     ENABLE ROW LEVEL SECURITY;

-- Templates: any staff can read; admin can write
DROP POLICY IF EXISTS "staff_read_wa_templates"   ON public.whatsapp_templates;
DROP POLICY IF EXISTS "admin_write_wa_templates"  ON public.whatsapp_templates;
CREATE POLICY "staff_read_wa_templates"   ON public.whatsapp_templates FOR SELECT USING (public.rma_is_staff());
CREATE POLICY "admin_write_wa_templates"  ON public.whatsapp_templates FOR ALL    USING (public.rma_is_admin());

-- Logs: staff reads; edge functions (service role) insert
DROP POLICY IF EXISTS "staff_read_notif_logs"   ON public.notification_logs;
DROP POLICY IF EXISTS "service_insert_notif_logs" ON public.notification_logs;
CREATE POLICY "staff_read_notif_logs"     ON public.notification_logs FOR SELECT USING (public.rma_is_staff());
CREATE POLICY "service_insert_notif_logs" ON public.notification_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "service_update_notif_logs" ON public.notification_logs FOR UPDATE USING (true);

-- Settings: admin only
DROP POLICY IF EXISTS "admin_rw_notif_settings" ON public.notification_settings;
CREATE POLICY "admin_rw_notif_settings"   ON public.notification_settings FOR ALL USING (public.rma_is_admin());

-- Queue: staff insert; admin reads; service role updates
DROP POLICY IF EXISTS "staff_insert_notif_queue"  ON public.notification_queue;
DROP POLICY IF EXISTS "admin_read_notif_queue"    ON public.notification_queue;
DROP POLICY IF EXISTS "service_update_notif_queue" ON public.notification_queue;
CREATE POLICY "staff_insert_notif_queue"  ON public.notification_queue FOR INSERT WITH CHECK (public.rma_is_staff());
CREATE POLICY "admin_read_notif_queue"    ON public.notification_queue FOR SELECT USING (public.rma_is_admin());
CREATE POLICY "service_update_notif_queue" ON public.notification_queue FOR UPDATE USING (true);

-- ── updated_at trigger ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at_col()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_wa_templates_updated_at      ON public.whatsapp_templates;
DROP TRIGGER IF EXISTS trg_notif_settings_updated_at    ON public.notification_settings;
CREATE TRIGGER trg_wa_templates_updated_at
  BEFORE UPDATE ON public.whatsapp_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_col();
CREATE TRIGGER trg_notif_settings_updated_at
  BEFORE UPDATE ON public.notification_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_col();

-- ── Seed default templates ─────────────────────────────────────

INSERT INTO public.whatsapp_templates
  (name, display_name, event_type, provider, language, template_name,
   body_content, variables, attach_pdf, status)
VALUES
  (
    'ticket_created', 'Ticket Created', 'ticket.created', 'whatsapp', 'en',
    'rma_ticket_created',
    E'Hello {{customer_name}},\n\nYour RMA ticket has been successfully created.\n\n*Ticket Number:* {{ticket_number}}\n*Status:* {{ticket_status}}\n*Created:* {{created_date}}\n\nYou can track your request status at any time. We will notify you on every update.\n\nThank you for choosing our service.',
    '[{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"ticket_number","label":"Ticket Number","source":"rma_number"},{"key":"ticket_status","label":"Ticket Status","source":"ticket_status"},{"key":"created_date","label":"Created Date","source":"created_date"}]',
    true, 'active'
  ),
  (
    'ticket_updated', 'Ticket Status Updated', 'ticket.updated', 'whatsapp', 'en',
    'rma_ticket_updated',
    E'Hello {{customer_name}},\n\nYour RMA ticket status has been updated.\n\n*Ticket Number:* {{ticket_number}}\n*New Status:* {{ticket_status}}\n{{#notes}}*Notes:* {{notes}}\n{{/notes}}{{#estimated_date}}*Est. Completion:* {{estimated_date}}\n{{/estimated_date}}\nPlease contact us if you have any questions.',
    '[{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"ticket_number","label":"Ticket Number","source":"rma_number"},{"key":"ticket_status","label":"Ticket Status","source":"ticket_status"},{"key":"notes","label":"Notes","source":"general_description"},{"key":"estimated_date","label":"Est. Completion","source":"due_date"}]',
    false, 'active'
  ),
  (
    'ticket_assigned', 'Ticket Assigned to Technician', 'ticket.assigned', 'whatsapp', 'en',
    'rma_ticket_assigned',
    E'Hello {{customer_name}},\n\nYour RMA ticket has been assigned to a technician.\n\n*Ticket Number:* {{ticket_number}}\n*Assigned Technician:* {{assigned_technician}}\n\nWork on your device will begin shortly.',
    '[{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"ticket_number","label":"Ticket Number","source":"rma_number"},{"key":"assigned_technician","label":"Assigned Technician","source":"assigned_technician"}]',
    false, 'active'
  ),
  (
    'ticket_closed', 'Ticket Closed / Completed', 'ticket.closed', 'whatsapp', 'en',
    'rma_ticket_closed',
    E'Hello {{customer_name}},\n\nYour RMA ticket has been closed.\n\n*Ticket Number:* {{ticket_number}}\n*Final Status:* {{ticket_status}}\n\nThank you for your patience. We hope your issue has been resolved satisfactorily.\n\nPlease let us know if you need further assistance.',
    '[{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"ticket_number","label":"Ticket Number","source":"rma_number"},{"key":"ticket_status","label":"Ticket Status","source":"ticket_status"}]',
    true, 'active'
  ),
  (
    'payment_received', 'Payment Received', 'payment.received', 'whatsapp', 'en',
    'rma_payment_received',
    E'Hello {{customer_name}},\n\nWe have received your payment.\n\n*Invoice Number:* {{invoice_number}}\n*Amount:* {{amount}}\n*Date:* {{payment_date}}\n\nThank you for your payment.',
    '[{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"invoice_number","label":"Invoice Number","source":"invoice_number"},{"key":"amount","label":"Amount","source":"amount"},{"key":"payment_date","label":"Payment Date","source":"payment_date"}]',
    false, 'active'
  )
ON CONFLICT DO NOTHING;
