-- Add customer_email to rma_tickets so email notifications can reach the customer
-- without requiring a customers-table lookup on every ticket save.
ALTER TABLE rma_tickets
  ADD COLUMN IF NOT EXISTS customer_email TEXT;
