-- Add priority_changed email template
INSERT INTO email_templates (template_name, template_subject, template_body, variables, is_active)
VALUES (
  'priority_changed',
  'RMA Ticket Priority Updated: {{rma_number}}',
  'Hello {{recipient_name}},

The priority of your RMA ticket {{rma_number}} has been updated.

Previous Priority: {{old_priority}}
New Priority: {{new_priority}}

You can view the ticket details in the RMA system.

Best regards,
{{company_name}} Team',
  '["recipient_name","rma_number","old_priority","new_priority","company_name"]',
  true
)
ON CONFLICT (template_name) DO NOTHING;
