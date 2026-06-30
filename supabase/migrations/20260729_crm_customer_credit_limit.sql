-- customers.credit_limit: optional soft limit, used only to surface a warning
-- on the Billing tab when a customer's outstanding balance exceeds it.
-- NULL means no limit set — never enforced/blocking, tracking only.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS credit_limit numeric(12,2);
