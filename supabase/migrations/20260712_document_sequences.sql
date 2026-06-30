-- document_sequences: gapless sequential counter for INV- and CN- codes.
-- The nextval_for_type RPC uses SELECT … FOR UPDATE so concurrent calls
-- are serialised — a rolled-back draft invoice never burns a number.

CREATE TABLE IF NOT EXISTS public.document_sequences (
  seq_type   text    PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0,
  seq_year   integer NOT NULL
);

-- Seed rows (idempotent: only insert when the row doesn't exist yet)
INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
VALUES
  ('invoice',     0, EXTRACT(YEAR FROM NOW())::integer),
  ('credit_note', 0, EXTRACT(YEAR FROM NOW())::integer)
ON CONFLICT (seq_type) DO NOTHING;

-- RLS: only server-side RPCs (SECURITY DEFINER) should touch this table.
-- Direct client access is blocked entirely.
ALTER TABLE public.document_sequences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "no_direct_client_access" ON public.document_sequences;
CREATE POLICY "no_direct_client_access"
  ON public.document_sequences
  FOR ALL
  USING (false);

-- nextval_for_type: returns the next sequential value for the given type.
-- Resets to 1 when the calendar year changes.
-- Caller receives a formatted code string, e.g. 'INV-2026-00001'.
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
  -- Lock the row so concurrent calls queue behind this one (gapless guarantee)
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
    WHEN 'invoice'     THEN 'INV'
    WHEN 'credit_note' THEN 'CN'
    ELSE UPPER(p_seq_type)
  END;

  RETURN v_prefix || '-' || v_year::text || '-' || LPAD(v_next::text, 5, '0');
END;
$$;

-- Random 8-digit code generator (for QT- and SO- codes, no legal weight)
CREATE OR REPLACE FUNCTION public.generate_doc_code(p_prefix text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_prefix || '-' || LPAD((FLOOR(RANDOM() * 90000000) + 10000000)::text, 8, '0');
$$;
