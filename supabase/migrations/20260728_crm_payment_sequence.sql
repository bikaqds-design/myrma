-- Registers the 'payment' sequence type (PAY-YYYY-NNNNN) used by record_payment().
-- CREATE OR REPLACE of the same function from 20260712_document_sequences.sql,
-- with a new prefix branch added — same pattern as 20260726's crm_convert_lead update.

INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
VALUES ('payment', 0, EXTRACT(YEAR FROM NOW())::integer)
ON CONFLICT (seq_type) DO NOTHING;

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
    WHEN 'payment'      THEN 'PAY'
    ELSE UPPER(p_seq_type)
  END;

  RETURN v_prefix || '-' || v_year::text || '-' || LPAD(v_next::text, 5, '0');
END;
$$;
