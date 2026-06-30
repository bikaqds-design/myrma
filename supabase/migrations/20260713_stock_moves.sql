-- stock_moves: append-only ledger for every inventory state change.
-- Never updated — only inserted. One row per reserve/deliver/release/restore.
-- Provides full audit trail and lets you reconcile if counters drift.

CREATE TABLE IF NOT EXISTS public.stock_moves (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- what changed
  ref_type      text        NOT NULL CHECK (ref_type IN ('unit', 'part')),
  ref_id        uuid        NOT NULL,   -- inventory_units.id OR parts.id
  -- what caused it
  doc_type      text        NOT NULL CHECK (doc_type IN (
                              'sales_order', 'invoice', 'credit_note', 'manual')),
  doc_id        uuid,                   -- nullable for manual adjustments
  -- what happened
  move_type     text        NOT NULL CHECK (move_type IN (
                              'reserve', 'deliver', 'release', 'restore', 'adjust')),
  qty           integer     NOT NULL CHECK (qty > 0),
  from_status   text,
  to_status     text,
  -- who did it
  actor_email   text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

-- Index for fast lookup by document and by unit/part
CREATE INDEX IF NOT EXISTS stock_moves_doc_idx
  ON public.stock_moves (doc_type, doc_id);

CREATE INDEX IF NOT EXISTS stock_moves_ref_idx
  ON public.stock_moves (ref_type, ref_id);

-- RLS: staff can read moves for their own docs; manager+ reads all.
-- INSERT is only allowed via SECURITY DEFINER RPCs — not directly from clients.
ALTER TABLE public.stock_moves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_stock_moves" ON public.stock_moves;
CREATE POLICY "staff_read_stock_moves"
  ON public.stock_moves
  FOR SELECT
  USING (public.rma_is_staff());

DROP POLICY IF EXISTS "no_direct_client_insert" ON public.stock_moves;
CREATE POLICY "no_direct_client_insert"
  ON public.stock_moves
  FOR INSERT
  WITH CHECK (false);
