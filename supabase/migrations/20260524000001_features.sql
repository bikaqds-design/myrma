-- ═══════════════════════════════════════════════════════════════════════════
--  myRMA Feature Expansion Migration
--  Run this in the Supabase SQL Editor to enable all new features.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Shipping columns on rma_tickets ──────────────────────────────────────
ALTER TABLE rma_tickets
  ADD COLUMN IF NOT EXISTS carrier           TEXT,
  ADD COLUMN IF NOT EXISTS tracking_number   TEXT,
  ADD COLUMN IF NOT EXISTS shipping_label_url TEXT;

-- ── 2. Time entries (per-ticket labour logging) ──────────────────────────────
CREATE TABLE IF NOT EXISTS time_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     UUID NOT NULL REFERENCES rma_tickets(id) ON DELETE CASCADE,
  user_email    TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  duration_min  INTEGER,          -- nullable until timer stopped
  notes         TEXT,
  created_date  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS time_entries_ticket_idx ON time_entries(ticket_id);
CREATE INDEX IF NOT EXISTS time_entries_user_idx   ON time_entries(user_email);

-- ── 3. Parts / components inventory ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name     TEXT NOT NULL,
  part_number   TEXT,
  quantity      INTEGER NOT NULL DEFAULT 0,
  unit_cost     NUMERIC(10,2) NOT NULL DEFAULT 0,
  supplier      TEXT,
  reorder_level INTEGER NOT NULL DEFAULT 5,
  location      TEXT,
  notes         TEXT,
  created_date  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Parts used on individual tickets
CREATE TABLE IF NOT EXISTS ticket_parts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     UUID NOT NULL REFERENCES rma_tickets(id) ON DELETE CASCADE,
  part_id       UUID NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
  quantity      INTEGER NOT NULL DEFAULT 1,
  unit_cost     NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes         TEXT,
  added_by      TEXT,
  created_date  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_parts_ticket_idx ON ticket_parts(ticket_id);
CREATE INDEX IF NOT EXISTS ticket_parts_part_idx   ON ticket_parts(part_id);

-- ── 4. Invoices / Quotes ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number  TEXT NOT NULL UNIQUE,
  ticket_id       UUID REFERENCES rma_tickets(id) ON DELETE SET NULL,
  customer_id     UUID,
  customer_name   TEXT,
  customer_email  TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft | sent | paid | void
  type            TEXT NOT NULL DEFAULT 'invoice', -- invoice | quote
  line_items      JSONB NOT NULL DEFAULT '[]',
  labour_hours    NUMERIC(6,2) NOT NULL DEFAULT 0,
  labour_rate     NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_pct         NUMERIC(5,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  due_date        DATE,
  paid_date       DATE,
  created_by      TEXT,
  created_date    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_ticket_idx   ON invoices(ticket_id);
CREATE INDEX IF NOT EXISTS invoices_status_idx   ON invoices(status);

-- ── 5. Grant access to app roles ────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON time_entries  TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON parts         TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_parts  TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON invoices      TO anon, authenticated;

-- ── 6. Auto-update updated_date triggers ────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_date()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_date = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS parts_updated_date   ON parts;
CREATE TRIGGER parts_updated_date
  BEFORE UPDATE ON parts FOR EACH ROW EXECUTE FUNCTION set_updated_date();

DROP TRIGGER IF EXISTS invoices_updated_date ON invoices;
CREATE TRIGGER invoices_updated_date
  BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_date();
