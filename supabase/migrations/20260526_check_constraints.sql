-- ═══════════════════════════════════════════════════════════════════════════
--  F-2: Postgres CHECK constraints + RPC field validation
--
--  Adds server-side enforcement for every enum-like column in the app so
--  invalid values are rejected at the DB layer regardless of which client
--  sends them.
--
--  Design choices:
--  • DROP … IF EXISTS before each ADD so this script is idempotent.
--  • NOT VALID on core tables — skips row-by-row scan on large tables,
--    adds the constraint for NEW writes immediately.
--  • Conditional DO $$ blocks for optional tables that may not exist in
--    every deployment (inventory_units, manufacturer_batches, products).
--  • validate_ticket_fields() RPC returns a JSON error list so the UI can
--    show friendly messages before hitting a constraint violation.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. rma_tickets ───────────────────────────────────────────────────────────

ALTER TABLE public.rma_tickets
  DROP CONSTRAINT IF EXISTS chk_ticket_status;
ALTER TABLE public.rma_tickets
  ADD CONSTRAINT chk_ticket_status
  CHECK (ticket_status IN (
    'Open', 'In Progress', 'Pending', 'On Hold', 'Closed', 'Cancelled'
  )) NOT VALID;

ALTER TABLE public.rma_tickets
  DROP CONSTRAINT IF EXISTS chk_ticket_priority;
ALTER TABLE public.rma_tickets
  ADD CONSTRAINT chk_ticket_priority
  CHECK (priority IN ('Critical', 'High', 'Medium', 'Low')) NOT VALID;


-- ── 2. user_roles ────────────────────────────────────────────────────────────

ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS chk_user_role;
ALTER TABLE public.user_roles
  ADD CONSTRAINT chk_user_role
  CHECK (role IN (
    'super_admin', 'admin', 'manager', 'technician', 'viewer'
  )) NOT VALID;

ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS chk_user_status;
ALTER TABLE public.user_roles
  ADD CONSTRAINT chk_user_status
  CHECK (status IN ('active', 'suspended', 'locked')) NOT VALID;


-- ── 3. invoices ──────────────────────────────────────────────────────────────

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS chk_invoice_status;
ALTER TABLE public.invoices
  ADD CONSTRAINT chk_invoice_status
  CHECK (status IN ('draft', 'sent', 'paid', 'void')) NOT VALID;

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS chk_invoice_type;
ALTER TABLE public.invoices
  ADD CONSTRAINT chk_invoice_type
  CHECK (type IN ('invoice', 'quote')) NOT VALID;


-- ── 4. notifications (in-app) ────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE public.notifications
    DROP CONSTRAINT IF EXISTS chk_notification_type;
  ALTER TABLE public.notifications
    ADD CONSTRAINT chk_notification_type
    CHECK (type IN (
      'info', 'warning', 'success', 'error', 'announcement', 'custom_alert'
    )) NOT VALID;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'Table notifications not found — skipping chk_notification_type';
END $$;


-- ── 5. inventory_units (optional table) ──────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE public.inventory_units
    DROP CONSTRAINT IF EXISTS chk_inventory_status;
  ALTER TABLE public.inventory_units
    ADD CONSTRAINT chk_inventory_status
    CHECK (status IN (
      'active_rma', 'company_stock', 'sent_to_manufacturer', 'closed'
    )) NOT VALID;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'Table inventory_units not found — skipping chk_inventory_status';
END $$;


-- ── 6. manufacturer_batches (optional table) ─────────────────────────────────

DO $$ BEGIN
  ALTER TABLE public.manufacturer_batches
    DROP CONSTRAINT IF EXISTS chk_batch_status;
  ALTER TABLE public.manufacturer_batches
    ADD CONSTRAINT chk_batch_status
    CHECK (status IN ('draft', 'sent', 'resolved')) NOT VALID;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'Table manufacturer_batches not found — skipping chk_batch_status';
END $$;


-- ── 7. products (optional — may not exist in all deployments) ────────────────

DO $$ BEGIN
  ALTER TABLE public.products
    DROP CONSTRAINT IF EXISTS chk_product_status;
  ALTER TABLE public.products
    ADD CONSTRAINT chk_product_status
    CHECK (status IN ('active', 'inactive', 'discontinued')) NOT VALID;

  ALTER TABLE public.products
    DROP CONSTRAINT IF EXISTS chk_product_type;
  ALTER TABLE public.products
    ADD CONSTRAINT chk_product_type
    CHECK (product_type IN (
      'hardware', 'software', 'accessory', 'service'
    )) NOT VALID;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'Table products not found — skipping product constraints';
END $$;


-- ── 8. customers (optional — customer_status column) ─────────────────────────

DO $$ BEGIN
  ALTER TABLE public.customers
    DROP CONSTRAINT IF EXISTS chk_customer_status;
  ALTER TABLE public.customers
    ADD CONSTRAINT chk_customer_status
    CHECK (customer_status IN ('active', 'inactive', 'vip')) NOT VALID;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Table customers not found — skipping chk_customer_status';
  WHEN undefined_column THEN
    RAISE NOTICE 'Column customer_status not found — skipping chk_customer_status';
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
--  RPC: validate_ticket_fields(status text, priority text)
--
--  Returns a JSON array of validation errors:
--    []                              → valid, safe to insert/update
--    [{"field":"priority","msg":"…"}] → one or more invalid values
--
--  Usage from the app:
--    const { data } = await supabase.rpc('validate_ticket_fields',
--      { p_status: ticketStatus, p_priority: priority })
--    if (data.length) showErrors(data)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.validate_ticket_fields(
  p_status   text,
  p_priority text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_errors jsonb := '[]'::jsonb;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN (
    'Open', 'In Progress', 'Pending', 'On Hold', 'Closed', 'Cancelled'
  ) THEN
    v_errors := v_errors || jsonb_build_array(
      jsonb_build_object(
        'field', 'ticket_status',
        'value', p_status,
        'msg',   'Invalid status. Allowed: Open, In Progress, Pending, On Hold, Closed, Cancelled'
      )
    );
  END IF;

  IF p_priority IS NOT NULL AND p_priority NOT IN (
    'Critical', 'High', 'Medium', 'Low'
  ) THEN
    v_errors := v_errors || jsonb_build_array(
      jsonb_build_object(
        'field', 'priority',
        'value', p_priority,
        'msg',   'Invalid priority. Allowed: Critical, High, Medium, Low'
      )
    );
  END IF;

  RETURN v_errors;
END;
$$;

-- Grant to authenticated users only (app-facing RPC)
GRANT EXECUTE ON FUNCTION public.validate_ticket_fields(text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_ticket_fields(text, text) FROM anon;
