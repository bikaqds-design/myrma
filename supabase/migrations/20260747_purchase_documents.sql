-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 9 — Purchase Module: proforma_invoices, purchase_orders, vendor_invoices
--
--  Document flow: Vendor -> Proforma Invoice (optional) -> Purchase Order ->
--  Vendor Invoice -> [Confirm & Receive] -> inventory_units/warehouse_stock.
--
--  Codes: PI-/PO- are random 8-digit (no legal weight, assigned at create,
--  matching QT-/SO-). VI- is gapless YYYY-NNNNN, assigned only at physical
--  receipt inside receive_vendor_invoice (not here) — see that migration.
--
--  vendor_invoices.line_items carries qty_ordered AND qty_received per line
--  so a PO arriving in multiple shipments is representable (partial receipt).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.proforma_invoices (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pi_code    text        UNIQUE NOT NULL,
  vendor_id  uuid        NOT NULL REFERENCES public.vendors(id),
  status     text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'cancelled')),
  line_items jsonb       NOT NULL DEFAULT '[]',
  total      numeric     NOT NULL DEFAULT 0,
  notes      text,
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  po_code              text        UNIQUE NOT NULL,
  vendor_id            uuid        NOT NULL REFERENCES public.vendors(id),
  proforma_invoice_id  uuid        REFERENCES public.proforma_invoices(id),
  status               text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'confirmed', 'cancelled')),
  line_items           jsonb       NOT NULL DEFAULT '[]',
  total                numeric     NOT NULL DEFAULT 0,
  expected_delivery_date date,
  notes                text,
  created_by           text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz
);

CREATE TABLE IF NOT EXISTS public.vendor_invoices (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vi_code            text        UNIQUE,
  purchase_order_id  uuid        REFERENCES public.purchase_orders(id),
  vendor_id          uuid        NOT NULL REFERENCES public.vendors(id),
  status             text        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'confirmed', 'partially_received', 'received', 'cancelled')),
  line_items         jsonb       NOT NULL DEFAULT '[]',
  total              numeric     NOT NULL DEFAULT 0,
  invoice_date       date,
  notes              text,
  created_by         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_at       timestamptz,
  received_at        timestamptz
);

-- RLS: staff read, manager+ write — same tier as vendors and every other
-- CRM document table in this project.
ALTER TABLE public.proforma_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_invoices   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_proforma_invoices" ON public.proforma_invoices;
CREATE POLICY "staff_read_proforma_invoices" ON public.proforma_invoices FOR SELECT USING (public.rma_is_staff());
DROP POLICY IF EXISTS "manager_write_proforma_invoices" ON public.proforma_invoices;
CREATE POLICY "manager_write_proforma_invoices" ON public.proforma_invoices FOR ALL
  USING (public.rma_is_manager_or_above()) WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS "staff_read_purchase_orders" ON public.purchase_orders;
CREATE POLICY "staff_read_purchase_orders" ON public.purchase_orders FOR SELECT USING (public.rma_is_staff());
DROP POLICY IF EXISTS "manager_write_purchase_orders" ON public.purchase_orders;
CREATE POLICY "manager_write_purchase_orders" ON public.purchase_orders FOR ALL
  USING (public.rma_is_manager_or_above()) WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS "staff_read_vendor_invoices" ON public.vendor_invoices;
CREATE POLICY "staff_read_vendor_invoices" ON public.vendor_invoices FOR SELECT USING (public.rma_is_staff());
DROP POLICY IF EXISTS "manager_write_vendor_invoices" ON public.vendor_invoices;
CREATE POLICY "manager_write_vendor_invoices" ON public.vendor_invoices FOR ALL
  USING (public.rma_is_manager_or_above()) WITH CHECK (public.rma_is_manager_or_above());

-- ── Register the vendor_invoice sequence type ────────────────────────────────

INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
VALUES ('vendor_invoice', 0, EXTRACT(YEAR FROM NOW())::integer)
ON CONFLICT (seq_type) DO NOTHING;

-- nextval_for_type's prefix CASE has an ELSE UPPER(p_seq_type) fallback,
-- which would produce 'VENDOR_INVOICE', not 'VI' — must add an explicit
-- WHEN clause. Re-declaring the whole function (idempotent, same body as
-- 20260712 otherwise).
CREATE OR REPLACE FUNCTION public.nextval_for_type(p_seq_type text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year     integer := EXTRACT(YEAR FROM NOW())::integer;
  v_next     integer;
  v_prefix   text;
BEGIN
  UPDATE public.document_sequences
  SET
    last_value = CASE WHEN seq_year = v_year THEN last_value + 1 ELSE 1 END,
    seq_year   = v_year
  WHERE seq_type = p_seq_type
  RETURNING last_value INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Unknown sequence type: %', p_seq_type;
  END IF;

  v_prefix := CASE p_seq_type
    WHEN 'invoice'        THEN 'INV'
    WHEN 'credit_note'    THEN 'CN'
    WHEN 'payment'        THEN 'PAY'
    WHEN 'vendor_invoice' THEN 'VI'
    ELSE UPPER(p_seq_type)
  END;

  RETURN v_prefix || '-' || v_year::text || '-' || LPAD(v_next::text, 5, '0');
END;
$$;

-- ── stock_moves: extend doc_type (vendor_invoice) ────────────────────────────
-- A vendor_invoice.id is a distinct concept from a sales crm_invoices.id —
-- reusing doc_type='invoice' would make doc_id ambiguous between the two
-- and break the Stock Movements tab's "click to view" link (which routes
-- sales-document doc_types to /sales/:type/:id).

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.stock_moves'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%doc_type%';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.stock_moves DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;

ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_doc_type_check
  CHECK (doc_type IN ('sales_order', 'invoice', 'credit_note', 'manual', 'vendor_invoice'));
