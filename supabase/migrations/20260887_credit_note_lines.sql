-- ============================================================================
-- 20260887_credit_note_lines.sql
-- W2 / L-01, fourth document type — credit notes. Same design as 20260883-85
-- (quotations, sales orders, sales invoices); read those first.
--
-- WHY IT MATTERS HERE: a credit note is money going back. issue_credit_note
-- takes credit_notes.total as the amount — it becomes the note's balance and
-- is applied against the invoice — and nothing ever recomputed that total from
-- the lines: the browser computed it and wrote both. A draft's total could say
-- one thing and its lines another (the caps of 20260880 bound the total by the
-- invoice's room, but the printed lines and the credited money could still
-- disagree). The total is now computed in the database from the stored rows.
--
-- WHAT DIFFERS FROM THE OTHER TYPES
--   * A line need not be a catalogue product: a rebate or goodwill credit is
--     often a free-text line. If a product IS named, it must exist.
--   * Each line keeps its restock flag and warehouse (an RMA return's goods).
--   * source_invoice_number is taken from the invoice itself, never from the
--     caller; a named invoice must exist and belong to the same customer, and a
--     named RMA ticket must exist.
--   * Only a DRAFT is edited here — a note awaiting approval is locked (20260880
--     fingerprints it at submit and re-checks at issue).
--   * The existing guard rma_guard_credit_note_client_writes (20260880) stays:
--     it still pins the stamps and refuses status changes. This migration adds
--     the allowlist on top: a direct UPDATE may change only restock_status
--     (creditNotes.restoreUnits marks a note restocked) and the archive fields.
--
-- _credit_note_assert_within_caps, submit_credit_note_for_approval and
-- issue_credit_note read credit_notes.line_items — kept as the mirror, so none
-- of them changed.
-- ============================================================================

-- ── 1. the table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credit_note_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id  uuid NOT NULL REFERENCES public.credit_notes(id) ON DELETE CASCADE,
  line_no         integer NOT NULL,
  product_id      uuid REFERENCES public.products(id),   -- nullable: a rebate / goodwill line has none
  product_name    text NOT NULL,
  description     text,
  qty             integer NOT NULL,
  unit_price      numeric(14,4) NOT NULL DEFAULT 0,
  discount_pct    numeric(5,2) NOT NULL DEFAULT 0,
  tax_pct         numeric(5,2) NOT NULL DEFAULT 0,
  restock         boolean NOT NULL DEFAULT false,
  warehouse_id    uuid REFERENCES public.warehouses(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_note_lines_qty_positive   CHECK (qty >= 1),
  CONSTRAINT credit_note_lines_price_nonneg   CHECK (unit_price >= 0),
  CONSTRAINT credit_note_lines_discount_range CHECK (discount_pct >= 0 AND discount_pct <= 100),
  CONSTRAINT credit_note_lines_tax_range      CHECK (tax_pct >= 0 AND tax_pct <= 100),
  CONSTRAINT credit_note_lines_name_present   CHECK (length(btrim(product_name)) > 0),
  CONSTRAINT credit_note_lines_unique_line    UNIQUE (credit_note_id, line_no)
);

CREATE INDEX IF NOT EXISTS credit_note_lines_note_idx    ON public.credit_note_lines (credit_note_id);
CREATE INDEX IF NOT EXISTS credit_note_lines_product_idx ON public.credit_note_lines (product_id) WHERE product_id IS NOT NULL;

COMMENT ON TABLE public.credit_note_lines IS
  'One row per credit-note line. Source of truth; credit_notes.line_items is a read-only mirror maintained by create_credit_note / update_credit_note. Client writes are revoked.';

ALTER TABLE public.credit_note_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_credit_note_lines" ON public.credit_note_lines;
CREATE POLICY "read_credit_note_lines"
  ON public.credit_note_lines
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.credit_notes c WHERE c.id = credit_note_lines.credit_note_id));

REVOKE ALL ON TABLE public.credit_note_lines FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.credit_note_lines FROM authenticated;
GRANT SELECT ON TABLE public.credit_note_lines TO authenticated;
GRANT ALL ON TABLE public.credit_note_lines TO service_role;

-- ── 2. the client surface ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_guard_credit_note_allowlist()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_open text[] := ARRAY['restock_status', 'archived', 'archived_at', 'archived_by', 'updated_at'];
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- A stored generated column reads as NULL in NEW inside a BEFORE trigger
  -- (credit_notes.affects_inventory is one). No client can write it.
  SELECT v_open || COALESCE(array_agg(a.attname::text), ARRAY[]::text[])
    INTO v_open
    FROM pg_attribute a
   WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> '';

  IF (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'A credit note''s lines, amounts and details are changed through the credit note form (update_credit_note), not directly.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.rma_guard_credit_note_allowlist() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_guard_credit_note_allowlist() TO service_role;

DROP TRIGGER IF EXISTS trg_credit_notes_allowlist ON public.credit_notes;
CREATE TRIGGER trg_credit_notes_allowlist
  BEFORE UPDATE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_credit_note_allowlist();

-- A credit note is created by create_credit_note only.
REVOKE INSERT ON TABLE public.credit_notes FROM authenticated;

-- ── 3. writing the lines (internal) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._credit_note_write_lines(p_cn_id uuid, p_lines jsonb)
RETURNS TABLE (subtotal numeric, discount_amount numeric, tax_amount numeric, total numeric, line_items jsonb)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_line    jsonb;
  v_no      integer := 0;
  v_name    text;
  v_pid     text;
  v_wid     text;
  v_qty     text;
  v_price   text;
  v_dpct    text;
  v_tpct    text;
  v_restock boolean;
  v_cat     text;
  v_sub     numeric := 0;
  v_dsum    numeric := 0;
  v_tsum    numeric := 0;
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'A credit note can have at most 500 lines' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.credit_note_lines WHERE credit_note_id = p_cn_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Line % is not a line item', v_no + 1 USING ERRCODE = 'P0001';
    END IF;

    v_name  := btrim(COALESCE(v_line->>'product_name', ''));
    v_pid   := btrim(COALESCE(v_line->>'product_id', ''));
    v_wid   := btrim(COALESCE(v_line->>'warehouse_id', ''));
    v_qty   := btrim(COALESCE(v_line->>'qty', ''));
    v_price := COALESCE(NULLIF(btrim(COALESCE(v_line->>'unit_price', '')), ''), '0');
    v_dpct  := COALESCE(NULLIF(btrim(COALESCE(v_line->>'discount_pct', '')), ''), '0');
    v_tpct  := COALESCE(NULLIF(btrim(COALESCE(v_line->>'tax_pct', '')), ''), '0');

    -- A product is optional on a credit note; if one is named it must exist,
    -- and its catalogue name fills a missing one.
    IF v_pid <> '' THEN
      IF v_pid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Line "%": the product reference is not valid', COALESCE(NULLIF(v_name, ''), (v_no + 1)::text) USING ERRCODE = 'P0001';
      END IF;
      SELECT p.product_name INTO v_cat FROM public.products p WHERE p.id = v_pid::uuid;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Line "%": that product does not exist', COALESCE(NULLIF(v_name, ''), (v_no + 1)::text) USING ERRCODE = 'P0001';
      END IF;
      v_name := COALESCE(NULLIF(v_name, ''), NULLIF(btrim(v_cat), ''));
    END IF;
    IF COALESCE(v_name, '') = '' THEN
      RAISE EXCEPTION 'Every line needs a description of what is being credited' USING ERRCODE = 'P0001';
    END IF;
    IF length(v_name) > 300 THEN
      RAISE EXCEPTION 'Line "%": the name is longer than 300 characters', left(v_name, 40) USING ERRCODE = 'P0001';
    END IF;
    -- Text first: NaN and Infinity are valid numerics that pass a range test.
    IF v_qty !~ '^[0-9]{1,9}$' OR v_qty::integer < 1 THEN
      RAISE EXCEPTION 'Line "%": quantity must be a whole number of at least 1', v_name USING ERRCODE = 'P0001';
    END IF;
    IF v_price !~ '^[0-9]{1,10}(\.[0-9]+)?$' THEN
      RAISE EXCEPTION 'Line "%": price must be 0 or more', v_name USING ERRCODE = 'P0001';
    END IF;
    IF v_dpct !~ '^[0-9]{1,3}(\.[0-9]+)?$' OR v_dpct::numeric > 100 THEN
      RAISE EXCEPTION 'Line "%": discount must be between 0 and 100', v_name USING ERRCODE = 'P0001';
    END IF;
    IF v_tpct !~ '^[0-9]{1,3}(\.[0-9]+)?$' OR v_tpct::numeric > 100 THEN
      RAISE EXCEPTION 'Line "%": tax must be between 0 and 100', v_name USING ERRCODE = 'P0001';
    END IF;

    -- restock is a flag: JSON true/false only (a string "false" is truthy in
    -- a browser and would be a dangerous thing to guess about).
    IF v_line ? 'restock' AND jsonb_typeof(v_line->'restock') NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'Line "%": restock must be true or false', v_name USING ERRCODE = 'P0001';
    END IF;
    v_restock := COALESCE((v_line->>'restock')::boolean, false);

    IF v_wid <> '' THEN
      IF v_wid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR NOT EXISTS (SELECT 1 FROM public.warehouses w WHERE w.id = v_wid::uuid) THEN
        RAISE EXCEPTION 'Line "%": that warehouse does not exist', v_name USING ERRCODE = 'P0001';
      END IF;
    END IF;

    INSERT INTO public.credit_note_lines
      (credit_note_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct, restock, warehouse_id)
    VALUES (
      p_cn_id, v_no, NULLIF(v_pid, '')::uuid, v_name,
      NULLIF(btrim(COALESCE(v_line->>'description', '')), ''),
      v_qty::integer, v_price::numeric, v_dpct::numeric, v_tpct::numeric,
      v_restock, NULLIF(v_wid, '')::uuid
    );

    v_no := v_no + 1;
  END LOOP;

  SELECT COALESCE(sum(b.base), 0),
         COALESCE(sum(b.disc), 0),
         COALESCE(sum((b.base - b.disc) * b.tax_pct / 100), 0)
    INTO v_sub, v_dsum, v_tsum
    FROM (SELECT l.qty * l.unit_price                        AS base,
                 l.qty * l.unit_price * l.discount_pct / 100 AS disc,
                 l.tax_pct
            FROM public.credit_note_lines l WHERE l.credit_note_id = p_cn_id) b;

  RETURN QUERY
  SELECT round(v_sub, 2), round(v_dsum, 2), round(v_tsum, 2), round(v_sub - v_dsum + v_tsum, 2),
         (SELECT jsonb_agg(jsonb_build_object(
                   'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
                   'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct,
                   'restock', l.restock, 'warehouse_id', l.warehouse_id)
                 ORDER BY l.line_no)
            FROM public.credit_note_lines l WHERE l.credit_note_id = p_cn_id);
END
$function$;

REVOKE ALL ON FUNCTION public._credit_note_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._credit_note_write_lines(uuid, jsonb) TO service_role;

-- ── 4. create_credit_note ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_credit_note(
  p_type               text,
  p_customer_id        uuid,
  p_reason             text,
  p_reason_code        text,
  p_lines              jsonb,
  p_source_invoice_id  uuid,
  p_ticket_id          uuid,
  p_assigned_rep       text,
  p_actor_email        text
)
RETURNS public.credit_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor  text := public.rma_current_user_email();
  v_id     uuid := gen_random_uuid();
  v_inv    public.crm_invoices;
  v_t      record;
  v_row    public.credit_notes;
BEGIN
  -- The INSERT policy this replaces (sales_insert_credit_notes, 20260781).
  IF NOT COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep', false) THEN
    RAISE EXCEPTION 'Not authorized to create a credit note' USING ERRCODE = 'P0001';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Your login has no email, so this credit note cannot be attributed' USING ERRCODE = 'P0001';
  END IF;
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'A customer is required' USING ERRCODE = 'P0001';
  END IF;
  IF p_type IS NULL OR p_type NOT IN ('rma_return', 'rebate', 'discount', 'correction') THEN
    RAISE EXCEPTION 'Unknown credit note type: %', COALESCE(p_type, '(none)') USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'Say why the credit note is being raised' USING ERRCODE = 'P0001';
  END IF;

  -- A named invoice is the customer's own and one the caller can read (the
  -- read policy sales_rep_read_crm_invoices — this function skips RLS); its
  -- number is copied from it, not taken from the caller. (The caps are checked
  -- again at submit and issue.) One message for every refusal, so it cannot
  -- be used to learn which ids exist.
  IF p_source_invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.crm_invoices WHERE id = p_source_invoice_id;
    IF NOT FOUND OR v_inv.customer_id IS DISTINCT FROM p_customer_id
       OR NOT COALESCE(public.rma_is_manager_or_above()
                       OR v_inv.assigned_rep = v_actor OR v_inv.created_by = v_actor, false) THEN
      RAISE EXCEPTION 'That invoice does not exist or belongs to another customer' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  -- A ticket is the customer's own: issue_credit_note closes the ticket a
  -- note names.
  IF p_ticket_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.rma_tickets t WHERE t.id = p_ticket_id AND t.customer_id = p_customer_id) THEN
    RAISE EXCEPTION 'That RMA ticket does not exist or belongs to another customer' USING ERRCODE = 'P0001';
  END IF;
  -- An RMA return is exempt from second approval because it is tied to a
  -- ticket (rma_credit_note_needs_approval), and the caps need an invoice: with
  -- neither, one manager could credit any amount unchecked.
  IF p_type = 'rma_return' AND p_ticket_id IS NULL AND p_source_invoice_id IS NULL THEN
    RAISE EXCEPTION 'An RMA return needs its RMA ticket or the invoice the goods were sold on' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.credit_notes
    (id, type, customer_id, status, line_items, reason, reason_code,
     source_invoice_id, source_invoice_number, ticket_id, assigned_rep, created_by,
     applied_amount, remaining_balance, restock_status)
  VALUES (
    v_id, p_type, p_customer_id, 'draft', '[]'::jsonb, btrim(p_reason), NULLIF(btrim(COALESCE(p_reason_code, '')), ''),
    p_source_invoice_id, v_inv.inv_code, p_ticket_id, p_assigned_rep, v_actor,
    0, 0, CASE WHEN p_type = 'rma_return' THEN 'pending' ELSE 'not_applicable' END
  );

  SELECT * INTO v_t FROM public._credit_note_write_lines(v_id, p_lines);

  UPDATE public.credit_notes SET
    line_items      = v_t.line_items,
    subtotal        = v_t.subtotal,
    discount_amount = v_t.discount_amount,
    tax_amount      = v_t.tax_amount,
    total           = v_t.total
  WHERE id = v_id
  RETURNING * INTO v_row;

  RETURN v_row;
END
$function$;

REVOKE ALL ON FUNCTION public.create_credit_note(text, uuid, text, text, jsonb, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_credit_note(text, uuid, text, text, jsonb, uuid, uuid, text, text) TO authenticated, service_role;

-- ── 5. update_credit_note: a draft only ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_credit_note(
  p_id          uuid,
  p_lines       jsonb,
  p_fields      jsonb,
  p_actor_email text
)
RETURNS public.credit_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor   text := public.rma_current_user_email();
  v_allowed text[] := ARRAY['reason', 'reason_code', 'assigned_rep'];
  v_key     text;
  v_cn      public.credit_notes;
  v_f       jsonb := COALESCE(p_fields, '{}'::jsonb);
  v_rep     text;
  v_items   jsonb;
  v_sub     numeric;
  v_dis     numeric;
  v_tax     numeric;
  v_tot     numeric;
  v_row     public.credit_notes;
  v_sent    boolean := p_lines IS NOT NULL;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized to edit a credit note' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(v_f) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Fields must be an object' USING ERRCODE = 'P0001';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_f) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'The field "%" cannot be changed here', v_key USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note % not found', p_id USING ERRCODE = 'P0001';
  END IF;

  v_rep := CASE WHEN v_f ? 'assigned_rep' THEN NULLIF(btrim(COALESCE(v_f->>'assigned_rep', '')), '') ELSE v_cn.assigned_rep END;

  -- The UPDATE policy this replaces (sales_update_credit_notes, 20260781),
  -- before and after, COALESCE-wrapped (BUG-087).
  IF NOT COALESCE(
       public.rma_is_manager_or_above()
       OR (public.rma_user_role() = 'sales_rep'
           AND (v_cn.assigned_rep = v_actor OR v_cn.created_by = v_actor)
           AND (v_rep = v_actor OR v_cn.created_by = v_actor)),
       false) THEN
    RAISE EXCEPTION 'Not authorized to edit this credit note' USING ERRCODE = 'P0001';
  END IF;

  -- A note awaiting approval is fingerprinted (20260880); an issued one is
  -- money already credited. Only a draft changes.
  IF v_cn.status <> 'draft' THEN
    RAISE EXCEPTION 'This credit note is % and can no longer be edited', v_cn.status USING ERRCODE = 'P0001';
  END IF;

  IF v_f ? 'reason' AND length(btrim(COALESCE(v_f->>'reason', ''))) = 0 THEN
    RAISE EXCEPTION 'Say why the credit note is being raised' USING ERRCODE = 'P0001';
  END IF;

  -- Without new lines, the stored rows are rewritten as they are, so the
  -- mirror and total always come from them — a note backfilled while awaiting
  -- approval kept its old mirror, and after a return to draft a header-only
  -- edit must not keep crediting that.
  IF p_lines IS NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
             'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct,
             'restock', l.restock, 'warehouse_id', l.warehouse_id) ORDER BY l.line_no), '[]'::jsonb)
      INTO p_lines FROM public.credit_note_lines l WHERE l.credit_note_id = p_id;
  END IF;
  -- (A draft with no rows at all, from a backfilled non-list blob, keeps what
  -- it has: the writer refuses an empty set.)
  v_items := v_cn.line_items; v_sub := v_cn.subtotal; v_dis := v_cn.discount_amount;
  v_tax := v_cn.tax_amount;   v_tot := v_cn.total;
  IF v_sent OR jsonb_array_length(p_lines) > 0 THEN
    SELECT w.line_items, w.subtotal, w.discount_amount, w.tax_amount, w.total
      INTO v_items, v_sub, v_dis, v_tax, v_tot
      FROM public._credit_note_write_lines(p_id, p_lines) w;
  END IF;

  UPDATE public.credit_notes SET
    line_items      = v_items,
    subtotal        = v_sub,
    discount_amount = v_dis,
    tax_amount      = v_tax,
    total           = v_tot,
    reason          = CASE WHEN v_f ? 'reason'      THEN btrim(v_f->>'reason') ELSE reason END,
    reason_code     = CASE WHEN v_f ? 'reason_code' THEN NULLIF(btrim(COALESCE(v_f->>'reason_code', '')), '') ELSE reason_code END,
    assigned_rep    = v_rep
  WHERE id = p_id
  RETURNING * INTO v_row;

  RETURN v_row;
END
$function$;

REVOKE ALL ON FUNCTION public.update_credit_note(uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_credit_note(uuid, jsonb, jsonb, text) TO authenticated, service_role;

-- ── 7. backfill existing credit notes ────────────────────────────────────────
-- As 20260883-85: text-first, a malformed or deleted product id costs only the
-- link, values outside the rules clamped and reported (including values that
-- could not be read), drift counted. Historical line_items and totals —
-- issued and applied notes among them — are NOT rewritten.
CREATE OR REPLACE FUNCTION pg_temp.cn_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
BEGIN
  IF btrim(COALESCE(p, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN btrim(p)::numeric; END IF;
  RETURN p_default;
END $f$;

DO $$
DECLARE
  v_c        record;
  v_t        record;
  v_no       integer;
  v_pid      uuid;
  v_wid      uuid;
  v_qty      numeric;
  v_price    numeric;
  v_dpct     numeric;
  v_tpct     numeric;
  v_restock  boolean;
  v_unread   boolean;
  v_changed  integer := 0;
  v_lines    integer := 0;
  v_drift    integer;
BEGIN
  FOR v_c IN
    SELECT c.id, c.line_items FROM public.credit_notes c
     WHERE NOT EXISTS (SELECT 1 FROM public.credit_note_lines cl WHERE cl.credit_note_id = c.id)
       AND jsonb_typeof(c.line_items) = 'array'
  LOOP
    v_no := 0;
    FOR v_t IN SELECT e.l FROM jsonb_array_elements(v_c.line_items) AS e(l)
    LOOP
      IF jsonb_typeof(v_t.l) IS DISTINCT FROM 'object' THEN
        v_t.l := '{}'::jsonb;
      END IF;

      v_pid := NULL;
      IF btrim(COALESCE(v_t.l->>'product_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_pid FROM public.products p WHERE p.id = btrim(v_t.l->>'product_id')::uuid;
      END IF;
      v_wid := NULL;
      IF btrim(COALESCE(v_t.l->>'warehouse_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT w.id INTO v_wid FROM public.warehouses w WHERE w.id = btrim(v_t.l->>'warehouse_id')::uuid;
      END IF;
      v_restock := CASE WHEN jsonb_typeof(v_t.l->'restock') = 'boolean' THEN (v_t.l->>'restock')::boolean ELSE false END;

      v_qty   := pg_temp.cn_bf_num(v_t.l->>'qty', 1);
      v_price := pg_temp.cn_bf_num(v_t.l->>'unit_price', 0);
      v_dpct  := pg_temp.cn_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct  := pg_temp.cn_bf_num(v_t.l->>'tax_pct', 0);

      v_unread := EXISTS (SELECT 1 FROM unnest(ARRAY['qty', 'unit_price', 'discount_pct', 'tax_pct']) k
                           WHERE v_t.l->>k IS NOT NULL AND btrim(v_t.l->>k) !~ '^-?[0-9]+(\.[0-9]+)?$');

      -- A product id that is present but does not resolve is a change too (a
      -- credit note may have no product, so only a present one counts).
      IF v_unread OR v_qty <> round(v_qty) OR v_qty < 1 OR v_price < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100
         OR (btrim(COALESCE(v_t.l->>'product_id', '')) <> '' AND v_pid IS NULL) THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'credit_note_lines backfill: credit note % line % had values outside the new rules (qty %, price %, discount %, tax %, product %); stored inside them',
          v_c.id, v_no + 1, v_t.l->>'qty', v_t.l->>'unit_price', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.credit_note_lines
        (credit_note_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct, restock, warehouse_id)
      VALUES (
        v_c.id, v_no, v_pid,
        COALESCE(NULLIF(btrim(COALESCE(v_t.l->>'product_name', '')), ''), '(unnamed line)'),
        NULLIF(btrim(COALESCE(v_t.l->>'description', '')), ''),
        GREATEST(1, LEAST(999999999, round(v_qty)))::integer,
        GREATEST(0, LEAST(9999999999, v_price)),
        LEAST(100, GREATEST(0, v_dpct)),
        LEAST(100, GREATEST(0, v_tpct)),
        v_restock, v_wid
      );
      v_lines := v_lines + 1;
      v_no := v_no + 1;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_drift
    FROM public.credit_notes c
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty * l.unit_price * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.credit_note_lines l WHERE l.credit_note_id = c.id) s ON true
   WHERE abs(s.t - c.total) > 0.01;

  RAISE NOTICE 'credit_note_lines backfill: % lines written, % brought inside the new rules, % credit notes whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- ── 8. draft credit notes agree with their rows ──────────────────────────────
-- Every DRAFT's mirror and totals are rebuilt from its rows (this reformats
-- the stored JSON even where nothing was wrong: the count is "drafts synced").
-- A note awaiting approval is fingerprinted and is NOT touched — rewriting it
-- would make it unissuable; issued, applied and voided notes keep their
-- figures.
DO $$
DECLARE v_n integer;
BEGIN
  WITH r AS (
    SELECT l.credit_note_id AS id,
           jsonb_agg(jsonb_build_object(
             'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
             'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct,
             'restock', l.restock, 'warehouse_id', l.warehouse_id)
             ORDER BY l.line_no) AS items,
           sum(l.qty * l.unit_price) AS sub,
           sum(l.qty * l.unit_price * l.discount_pct / 100) AS dis,
           sum((l.qty * l.unit_price - l.qty * l.unit_price * l.discount_pct / 100) * l.tax_pct / 100) AS tax
      FROM public.credit_note_lines l GROUP BY l.credit_note_id)
  UPDATE public.credit_notes c SET
    line_items = r.items, subtotal = round(r.sub, 2), discount_amount = round(r.dis, 2),
    tax_amount = round(r.tax, 2), total = round(r.sub - r.dis + r.tax, 2)
  FROM r
  WHERE c.id = r.id AND c.status = 'draft'
    AND (c.line_items IS DISTINCT FROM r.items OR c.total IS DISTINCT FROM round(r.sub - r.dis + r.tax, 2));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'draft credit notes synced from their rows: %', v_n;
END $$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.create_credit_note(text, uuid, text, text, jsonb, uuid, uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_credit_note(uuid, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._credit_note_write_lines(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a credit-note-line function is executable by the wrong role';
  END IF;
  IF has_table_privilege('anon', 'public.credit_note_lines', 'SELECT')
     OR has_table_privilege('authenticated', 'public.credit_note_lines', 'INSERT')
     OR has_table_privilege('authenticated', 'public.credit_notes', 'INSERT')
     OR has_table_privilege('anon', 'public.credit_notes', 'INSERT') THEN
    RAISE EXCEPTION 'Refusing to finish: a client can still write credit note lines or credit notes directly';
  END IF;
END $$;
