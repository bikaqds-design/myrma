-- 20260922_setup_wizard.sql — B-03c: the first-run setup wizard.
--
-- The wizard's progress lives in rma_config under 'setup_wizard':
--   {"status": "in_progress" | "skipped" | "finished",
--    "steps_done": ["users", ...], "chart_confirmed": true,
--    "finished_at": "...", "finished_by": "..."}
-- A new company's database has no such row, so its first administrator is
-- taken to the wizard (owner decision 2026-10-01: shown at first login).
--
-- A database that already runs a business must never be sent there: this
-- marks the wizard finished wherever business data or a company name already
-- exists. Idempotent: an existing row is left alone.

INSERT INTO public.rma_config (config_key, config_value, updated_by, updated_date)
SELECT 'setup_wizard',
       jsonb_build_object('status', 'finished', 'reason', 'existing data', 'finished_at', now()),
       'system@migration', now()
 WHERE NOT EXISTS (SELECT 1 FROM public.rma_config WHERE config_key = 'setup_wizard')
   AND (EXISTS (SELECT 1 FROM public.customers)
        OR EXISTS (SELECT 1 FROM public.rma_tickets)
        OR EXISTS (SELECT 1 FROM public.crm_invoices)
        OR EXISTS (SELECT 1 FROM public.rma_config
                    WHERE config_key = 'legal_name' AND btrim(config_value #>> '{}') <> ''));
