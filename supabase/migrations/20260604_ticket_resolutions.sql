-- ── ticket_resolutions ──────────────────────────────────────────────────────
-- Stores replacement/exchange/credit-note/refund outcomes for RMA tickets.
-- At most one resolution per ticket (enforced by unique index).

CREATE TABLE IF NOT EXISTS ticket_resolutions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id                UUID NOT NULL REFERENCES rma_tickets(id) ON DELETE CASCADE,
  type                     TEXT NOT NULL,
  replacement_product_name TEXT,
  replacement_serial       TEXT,
  amount                   NUMERIC(10,2),
  currency                 TEXT DEFAULT 'USD',
  reason                   TEXT,
  reference_number         TEXT,
  created_by               TEXT NOT NULL,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ticket_resolutions
  ADD CONSTRAINT ticket_resolutions_type_check
  CHECK (type IN ('replacement', 'exchange', 'credit_note', 'refund'));

-- One resolution per ticket
CREATE UNIQUE INDEX IF NOT EXISTS ticket_resolutions_ticket_id_unique
  ON ticket_resolutions (ticket_id);

-- RLS
ALTER TABLE ticket_resolutions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_resolutions"   ON ticket_resolutions;
DROP POLICY IF EXISTS "staff_write_resolutions"  ON ticket_resolutions;
DROP POLICY IF EXISTS "staff_delete_resolutions" ON ticket_resolutions;

CREATE POLICY "staff_read_resolutions"
  ON ticket_resolutions FOR SELECT
  USING (public.rma_is_staff());

CREATE POLICY "staff_write_resolutions"
  ON ticket_resolutions FOR INSERT
  WITH CHECK (public.rma_is_staff());

CREATE POLICY "staff_write_update_resolutions"
  ON ticket_resolutions FOR UPDATE
  USING (public.rma_is_staff());

CREATE POLICY "staff_delete_resolutions"
  ON ticket_resolutions FOR DELETE
  USING (public.rma_is_manager_or_above());
