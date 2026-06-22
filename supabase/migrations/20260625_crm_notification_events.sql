-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 1, Step 8 — seed CRM WhatsApp notification event types
--
--  status = 'pending_approval', not 'active': these are placeholder bodies,
--  not yet registered as Meta templates. Sending via an unapproved
--  template_name fails (see CLAUDE.md's Meta error cheat sheet). Before
--  going live: create + get each approved as a Utility-category template in
--  Meta Business Manager, then UPDATE template_name to match (no code
--  change needed — see CLAUDE.md's WhatsApp section).
--
--  whatsapp_templates has no unique constraint on name/event_type, so the
--  existing seed's "ON CONFLICT DO NOTHING" (in 20260602) can't actually
--  match any constraint and is inert on re-run. Not fixing that here (out
--  of scope), but not copying the pattern either — guarding each insert
--  with WHERE NOT EXISTS instead so this migration is genuinely idempotent.
-- ═══════════════════════════════════════════════════════════════════════════


INSERT INTO public.whatsapp_templates
  (name, display_name, event_type, provider, language, template_name, body_content, variables, attach_pdf, status)
SELECT
  'crm_lead_assigned', 'CRM: Lead Assigned', 'crm_lead_assigned', 'whatsapp', 'en',
  'crm_lead_assigned_v1',
  E'Hello {{rep_name}},\n\nA new lead has been assigned to you.\n\n*Lead:* {{lead_name}}\n*Company:* {{company_name}}\n*Source:* {{lead_source}}\n\nPlease follow up promptly.',
  '[{"key":"rep_name","label":"Rep Name","source":"rep_name"},{"key":"lead_name","label":"Lead Name","source":"lead_name"},{"key":"company_name","label":"Company Name","source":"company_name"},{"key":"lead_source","label":"Lead Source","source":"lead_source"}]',
  false, 'pending_approval'
WHERE NOT EXISTS (SELECT 1 FROM public.whatsapp_templates WHERE event_type = 'crm_lead_assigned');

INSERT INTO public.whatsapp_templates
  (name, display_name, event_type, provider, language, template_name, body_content, variables, attach_pdf, status)
SELECT
  'crm_deal_won', 'CRM: Deal Won', 'crm_deal_won', 'whatsapp', 'en',
  'crm_deal_won_v1',
  E'Congratulations {{rep_name}}!\n\nYour deal has been marked as *Won*.\n\n*Deal:* {{deal_title}}\n*Customer:* {{customer_name}}\n*Value:* {{deal_value}} EGP',
  '[{"key":"rep_name","label":"Rep Name","source":"rep_name"},{"key":"deal_title","label":"Deal Title","source":"deal_title"},{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"deal_value","label":"Deal Value","source":"deal_value"}]',
  false, 'pending_approval'
WHERE NOT EXISTS (SELECT 1 FROM public.whatsapp_templates WHERE event_type = 'crm_deal_won');

INSERT INTO public.whatsapp_templates
  (name, display_name, event_type, provider, language, template_name, body_content, variables, attach_pdf, status)
SELECT
  'crm_followup_due', 'CRM: Follow-Ups Due Today', 'crm_followup_due', 'whatsapp', 'en',
  'crm_followup_due_v1',
  E'Good morning {{rep_name}},\n\nYou have {{activity_count}} follow-up(s) due today.\n\nCheck your Activities page for details.',
  '[{"key":"rep_name","label":"Rep Name","source":"rep_name"},{"key":"activity_count","label":"Activity Count","source":"activity_count"}]',
  false, 'pending_approval'
WHERE NOT EXISTS (SELECT 1 FROM public.whatsapp_templates WHERE event_type = 'crm_followup_due');

INSERT INTO public.whatsapp_templates
  (name, display_name, event_type, provider, language, template_name, body_content, variables, attach_pdf, status)
SELECT
  'crm_deal_overdue', 'CRM: Deal Follow-Up Overdue', 'crm_deal_overdue', 'whatsapp', 'en',
  'crm_deal_overdue_v1',
  E'Hello {{rep_name}},\n\nYour deal *{{deal_title}}* has an overdue follow-up.\n\n*Customer:* {{customer_name}}\n*Due:* {{due_date}}\n\nPlease take action.',
  '[{"key":"rep_name","label":"Rep Name","source":"rep_name"},{"key":"deal_title","label":"Deal Title","source":"deal_title"},{"key":"customer_name","label":"Customer Name","source":"customer_name"},{"key":"due_date","label":"Due Date","source":"due_date"}]',
  false, 'pending_approval'
WHERE NOT EXISTS (SELECT 1 FROM public.whatsapp_templates WHERE event_type = 'crm_deal_overdue');


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT name, event_type, status FROM whatsapp_templates WHERE event_type LIKE 'crm_%' ORDER BY event_type;
