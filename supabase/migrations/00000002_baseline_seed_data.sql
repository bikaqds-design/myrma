-- ============================================================================
-- 00000002_baseline_seed_data.sql
--
-- The rows the application itself needs before its first user does anything.
--
-- 00000000 creates structure, 00000001 creates reference data (currencies,
-- countries, rma_config). This file is the third layer: rows that were seeded
-- by historical migrations (which a fresh tenant never runs -- it gets the
-- baseline instead) and that the code assumes exist. Found by provisioning
-- mycrm-staging from the baseline and diffing its row counts against
-- production: six tables were empty on staging that the app cannot work
-- without.
--
--   document_sequences   nextval_for_type() raises 'Unknown sequence type' when
--                        its row is missing, so the FIRST invoice, credit note,
--                        payment, vendor invoice, vendor payment or
--                        manufacturer batch on a new tenant failed.
--   warehouses (system)  move_rma_units / promote_rma_unit / the RMA
--                        auto-move on every ticket save look the eight system
--                        locations up by code. Missing, a ticket save cannot
--                        place its units.
--   pipelines            Leads convert into a deal on a pipeline. With none,
--                        crm_convert_lead has no first stage to use.
--   email_templates      the ticket e-mails have nothing to render.
--   whatsapp_templates   Control Panel > WhatsApp shows an empty list.
--   notification_settings  channel switches (see the safe defaults below).
--
-- What is deliberately NOT copied from production:
--   * the Meta access token and phone number that someone pasted into the body
--     of production's ticket_created WhatsApp template. Secrets do not belong
--     in a seed file, and the body is rewritten from its declared variables.
--   * the QDS tracker URL in the e-mail bodies -- it points at one tenant's
--     site. The line is dropped; a tenant adds its own.
--   * whatsapp_config (QDS's phone number id and business account id).
--   * audit columns (updated_by, created_by): they held one person's e-mail.
--
-- SAFE DEFAULTS. Nothing here can message anyone on day one:
--   * whatsapp_enabled starts FALSE -- the WhatsApp handlers read exactly this
--     row -- and the templates are seeded 'pending_approval', because their
--     Meta template names are not registered in a new tenant's account and the
--     handlers only send an 'active' one.
--   * E-mail is gated by public.email_settings (is_active + api_key), which is
--     deliberately NOT seeded; the send-email function refuses without it. The
--     email_enabled / sms_enabled rows below are only the Control Panel's
--     toggles, so do not treat them as the safety mechanism.
--   * crm.* notification events are seeded with the application's own defaults
--     (WASettings.jsx). They must be present: the handlers treat an ABSENT key
--     as enabled (`flags[event] !== false`), which would switch on the two
--     digest events the application deliberately leaves off.
--
-- Idempotent: every insert is guarded, so re-running changes nothing and it
-- never overwrites something a tenant has already edited.
--
-- RESTORING A BACKUP INTO A PROJECT PROVISIONED FROM THIS SEED: the restore
-- upserts on primary key only, so a backup row with the same natural key but
-- another id (the warehouse code, the pipeline name, a template name, a
-- setting key) is a unique violation and the whole restore rolls back. For a
-- project that will be filled from a backup, provision with --no-seed, restore,
-- then run SELECT public.rma_reconcile_document_sequences() (20260878), which
-- also recreates the document counters a backup cannot carry.
--
-- Run AFTER 00000000 and 00000001.
-- ============================================================================

-- ── Document sequences ──────────────────────────────────────────────────────
-- seq_type is the primary key. last_value 0: the first number handed out is 1.
INSERT INTO public.document_sequences (seq_type, seq_year, last_value)
SELECT v.seq_type, EXTRACT(YEAR FROM now())::integer, 0
FROM (VALUES
  ('invoice'), ('credit_note'), ('payment'),
  ('vendor_invoice'), ('vendor_payment'), ('batch')
) AS v(seq_type)
WHERE NOT EXISTS (
  SELECT 1 FROM public.document_sequences d WHERE d.seq_type = v.seq_type
);

-- ── System warehouses (the RMA stages as real locations) ────────────────────
INSERT INTO public.warehouses (code, name, description, warehouse_type, is_system, is_active)
SELECT v.code, v.name, v.description, v.warehouse_type, true, true
FROM (VALUES
  ('RMA-RECEIVED',   'RMA - Received',      'Units just received on an RMA ticket, not yet triaged',                  'rma'),
  ('RMA-REPAIR',     'RMA - Under Repair',  'Units currently being repaired',                                        'rma'),
  ('RMA-REPAIRED',   'RMA - Repaired',      'Units repaired, pending return or restock',                             'rma'),
  ('RMA-CANTREPAIR', 'RMA - Can''t Repair', 'Units that could not be repaired',                                      'rma'),
  ('RMA-STOCK',      'RMA - Stock',         'Units resolved as Replacement/Credit Note, pending disposition',        'rma'),
  ('REPLACEMENT',    'Replacement Holding', 'Units earmarked to be sent out as a customer replacement',              'transit'),
  ('CREDIT-NOTE',    'Credit Note Holding', 'Units returned against an issued credit note',                          'rma'),
  ('SCRAP',          'Scrap',               'Written-off units — never counted as sellable or physical stock',       'virtual')
) AS v(code, name, description, warehouse_type)
WHERE NOT EXISTS (
  SELECT 1 FROM public.warehouses w WHERE w.code = v.code AND w.is_system
);

-- ── Default sales pipeline ──────────────────────────────────────────────────
INSERT INTO public.pipelines (name, stages, is_active)
SELECT 'B2B Dealer Pipeline',
       $stages$[
         {"id":"new_lead","name":"New Deals","order":1,"is_won":false,"is_lost":false,"probability_default":10},
         {"id":"contacted","name":"Contacted","order":2,"is_won":false,"is_lost":false,"probability_default":20},
         {"id":"needs_assessment","name":"Needs Assessment","order":3,"is_won":false,"is_lost":false,"probability_default":40},
         {"id":"quote_sent","name":"Quote Sent","order":4,"is_won":false,"is_lost":false,"probability_default":60},
         {"id":"negotiation","name":"Negotiation","order":5,"is_won":false,"is_lost":false,"probability_default":75},
         {"id":"won","name":"Won","order":6,"is_won":true,"is_lost":false,"probability_default":100},
         {"id":"lost","name":"Lost","order":7,"is_won":false,"is_lost":true,"probability_default":0}
       ]$stages$::jsonb,
       true
WHERE NOT EXISTS (SELECT 1 FROM public.pipelines);

-- ── E-mail templates ────────────────────────────────────────────────────────
INSERT INTO public.email_templates (template_name, template_subject, template_body, variables, is_active)
SELECT v.template_name, v.template_subject, v.template_body, v.variables::jsonb, true
FROM (VALUES
  ('ticket_created',
   'New RMA Ticket Created: {{rma_number}}',
   $b$Hello {{recipient_name}},

A new RMA ticket has been created:

RMA Number: {{rma_number}}
Customer: {{customer_name}}
Priority: {{priority}}
Status: {{status}}

Product Details:
{{product_details}}

Issue Description:
{{issue_description}}

Best regards,
{{company_name}} Team$b$,
   '["recipient_name","rma_number","customer_name","priority","status","product_details","issue_description","company_name"]'),
  ('ticket_assigned',
   'RMA Ticket Assigned to You: {{rma_number}}',
   $b$Hello {{recipient_name}},

An RMA ticket has been assigned to you:

RMA Number: {{rma_number}}
Customer: {{customer_name}}
Priority: {{priority}}
Due Date: {{due_date}}

Best regards,
{{company_name}} Team$b$,
   '["recipient_name","rma_number","customer_name","priority","due_date","company_name"]'),
  ('status_changed',
   'RMA Ticket Status Updated: {{rma_number}}',
   $b$Hello {{recipient_name}},

The status of RMA ticket {{rma_number}} has been updated:

Previous Status: {{old_status}}
New Status: {{new_status}}

Updated by: {{updated_by}}
Update Time: {{update_time}}

Best regards,
{{company_name}} Team$b$,
   '["recipient_name","rma_number","old_status","new_status","updated_by","update_time","company_name"]'),
  ('priority_changed',
   'RMA Ticket Priority Updated: {{rma_number}}',
   $b$Hello {{recipient_name}},

The priority of your RMA ticket {{rma_number}} has been updated.

Previous Priority: {{old_priority}}
New Priority: {{new_priority}}

Best regards,
{{company_name}} Team$b$,
   '["recipient_name","rma_number","old_priority","new_priority","company_name"]'),
  ('comment_added',
   'New Comment on RMA Ticket: {{rma_number}}',
   $b$Hello {{recipient_name}},

A new comment has been added to RMA ticket {{rma_number}}:

Comment by: {{comment_author}}
Comment: {{comment_text}}

Best regards,
{{company_name}} Team$b$,
   '["recipient_name","rma_number","comment_author","comment_text","company_name"]'),
  ('ticket_overdue',
   'RMA Ticket Overdue: {{rma_number}}',
   $b$Hello {{recipient_name}},

RMA ticket {{rma_number}} is now overdue:

Customer: {{customer_name}}
Due Date: {{due_date}}
Current Status: {{status}}
Days Overdue: {{days_overdue}}

Best regards,
{{company_name}} Team$b$,
   '["recipient_name","rma_number","customer_name","due_date","status","days_overdue","company_name"]')
) AS v(template_name, template_subject, template_body, variables)
WHERE NOT EXISTS (
  SELECT 1 FROM public.email_templates e WHERE e.template_name = v.template_name
);

-- ── WhatsApp templates ──────────────────────────────────────────────────────
-- 'pending_approval' on purpose (see header). {{n}} counts must match the
-- template a tenant registers with Meta; the variables array is what fixes
-- their order.
INSERT INTO public.whatsapp_templates
  (name, display_name, event_type, provider, language, template_name,
   body_content, variables, attach_pdf, status)
SELECT v.name, v.display_name, v.event_type, 'whatsapp', 'en', v.template_name,
       v.body_content, v.variables::jsonb, v.attach_pdf, 'pending_approval'
FROM (VALUES
  ('ticket_created', 'Ticket Created', 'ticket.created', 'rma_ticket_created_v2',
   $b$Hello {{customer_name}},

Your RMA ticket has been created.

*Ticket Number:* {{ticket_number}}
*Status:* {{ticket_status}}
*Created:* {{created_date}}$b$,
   '[{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"ticket_number","label":"Ticket Number","source":"rma_number"},{"key":"ticket_status","label":"Ticket Status","source":"ticket_status"},{"key":"created_date","label":"Created Date","source":"created_date"}]',
   true),
  ('ticket_updated', 'Ticket Status Updated', 'ticket.updated', 'rma_ticket_updated',
   $b$Hello {{customer_name}},

Your RMA ticket status has been updated.

*Ticket Number:* {{ticket_number}}
*New Status:* {{ticket_status}}
{{#notes}}*Notes:* {{notes}}
{{/notes}}{{#estimated_date}}*Est. Completion:* {{estimated_date}}
{{/estimated_date}}
Please contact us if you have any questions.$b$,
   '[{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"ticket_number","label":"Ticket Number","source":"rma_number"},{"key":"ticket_status","label":"Ticket Status","source":"ticket_status"},{"key":"notes","label":"Notes","source":"general_description"},{"key":"estimated_date","label":"Est. Completion","source":"due_date"}]',
   false),
  ('ticket_assigned', 'Ticket Assigned to Technician', 'ticket.assigned', 'rma_ticket_assigned',
   $b$Hello {{customer_name}},

Your RMA ticket has been assigned to a technician.

*Ticket Number:* {{ticket_number}}
*Assigned Technician:* {{assigned_technician}}

Work on your device will begin shortly.$b$,
   '[{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"ticket_number","label":"Ticket Number","source":"rma_number"},{"key":"assigned_technician","label":"Assigned Technician","source":"assigned_technician"}]',
   false),
  ('ticket_closed', 'Ticket Closed / Completed', 'ticket.closed', 'rma_ticket_closed',
   $b$Hello {{customer_name}},

Your RMA ticket has been closed.

*Ticket Number:* {{ticket_number}}
*Final Status:* {{ticket_status}}

Thank you for your patience. Please let us know if you need further assistance.$b$,
   '[{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"ticket_number","label":"Ticket Number","source":"rma_number"},{"key":"ticket_status","label":"Ticket Status","source":"ticket_status"}]',
   true),
  ('payment_received', 'Payment Received', 'payment.received', 'rma_payment_received',
   $b$Hello {{customer_name}},

We have received your payment.

*Invoice Number:* {{invoice_number}}
*Amount:* {{amount}}
*Date:* {{payment_date}}

Thank you for your payment.$b$,
   '[{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"invoice_number","label":"Invoice Number","source":"invoice_number"},{"key":"amount","label":"Amount","source":"amount"},{"key":"payment_date","label":"Payment Date","source":"payment_date"}]',
   false),
  ('crm_lead_assigned', 'CRM: Lead Assigned', 'crm.lead_assigned', 'crm_lead_assigned_v1',
   $b$Hello {{rep_name}},

A new lead has been assigned to you.

*Lead:* {{lead_name}}
*Company:* {{company_name}}
*Source:* {{lead_source}}

Please follow up promptly.$b$,
   '[{"key":"rep_name","label":"Rep Name","source":"rep_name"},{"key":"lead_name","label":"Lead Name","source":"lead_name"},{"key":"company_name","label":"Company Name","source":"company_name"},{"key":"lead_source","label":"Lead Source","source":"lead_source"}]',
   false),
  ('crm_deal_won', 'CRM: Deal Won', 'crm.deal_won', 'crm_deal_won_v1',
   $b$Congratulations {{rep_name}}!

Your deal has been marked as *Won*.

*Deal:* {{deal_title}}
*Customer:* {{customer_name}}
*Value:* {{deal_value}}$b$,
   '[{"key":"rep_name","label":"Rep Name","source":"rep_name"},{"key":"deal_title","label":"Deal Title","source":"deal_title"},{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"deal_value","label":"Deal Value","source":"deal_value"}]',
   false),
  ('crm_followup_due', 'CRM: Follow-Ups Due Today', 'crm.followup_due', 'crm_followup_due_v1',
   $b$Good morning {{rep_name}},

You have {{activity_count}} follow-up(s) due today.

Check your Activities page for details.$b$,
   '[{"key":"rep_name","label":"Rep Name","source":"rep_name"},{"key":"activity_count","label":"Activity Count","source":"activity_count"}]',
   false),
  ('crm_deal_overdue', 'CRM: Deal Follow-Up Overdue', 'crm.deal_overdue', 'crm_deal_overdue_v1',
   $b$Hello {{rep_name}},

Your deal *{{deal_title}}* has an overdue follow-up.

*Customer:* {{customer_name}}
*Due:* {{due_date}}

Please take action.$b$,
   '[{"key":"rep_name","label":"Rep Name","source":"rep_name"},{"key":"deal_title","label":"Deal Title","source":"deal_title"},{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"due_date","label":"Due Date","source":"due_date"}]',
   false)
) AS v(name, display_name, event_type, template_name, body_content, variables, attach_pdf)
WHERE NOT EXISTS (
  SELECT 1 FROM public.whatsapp_templates w WHERE w.name = v.name
);

-- ── Notification settings ───────────────────────────────────────────────────
-- Channels OFF (see header). Retry and rate-limit values are the ones
-- production runs with.
INSERT INTO public.notification_settings (setting_key, setting_value)
SELECT v.setting_key, v.setting_value::jsonb
FROM (VALUES
  ('whatsapp_enabled', 'false'),
  ('email_enabled',    'false'),
  ('sms_enabled',      'false'),
  ('notification_events',
   '{"ticket.closed":true,"ticket.created":true,"ticket.updated":true,"ticket.assigned":true,"payment.received":true,"warranty.approved":true,"delivery.scheduled":false,"replacement.approved":false,"crm.lead_assigned":true,"crm.deal_won":true,"crm.followup_due":false,"crm.deal_overdue":false}'),
  ('retry_config', '{"max_retries":3,"backoff_multiplier":2,"retry_delay_seconds":300}'),
  ('rate_limit',   '{"messages_per_day":1000,"messages_per_minute":60}')
) AS v(setting_key, setting_value)
WHERE NOT EXISTS (
  SELECT 1 FROM public.notification_settings n WHERE n.setting_key = v.setting_key
);
