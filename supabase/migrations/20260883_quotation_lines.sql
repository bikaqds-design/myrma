-- ============================================================================
-- 20260883_quotation_lines.sql
-- W2 / L-01+L-02, first document type — Quotations.
--
-- WHY QUOTATIONS FIRST: it is the one sales document with NO write RPC at
-- all — the browser inserts and updates the row directly (gated only by RLS),
-- computes totals itself, and there is no FK from a line to a real product: a
-- line is just whatever shape of jsonb the browser sent. `line_items` cannot
-- even be joined against `products` to ask "which quotations include this
-- item" without scanning and casting every row.
--
-- WHAT THIS DOES
--   * quotation_lines: a real table, one row per line, product_id FK'd to
--     products, qty/price/discount/tax CHECK-constrained. This is now the
--     source of truth for a quotation's lines.
--   * create_quotation / update_quotation: SECURITY DEFINER RPCs that write
--     the lines, recompute totals from them SERVER-SIDE (closing the "browser
--     computes the money" gap the same way I-06/I-07 closed it elsewhere),
--     and — in the SAME transaction — write quotations.line_items as a
--     projection of the rows just written, byte-for-byte the same shape as
--     before.
--   * Who may write matches the policies this replaces (20260781): a manager,
--     or a sales rep — creating any, editing only their own. A quotation's
--     deal must belong to its customer.
--   * A client-surface trigger refuses any direct UPDATE that changes more than
--     the status or the archive flag, and INSERT is revoked from
--     authenticated, so every other change goes through the two RPCs. That
--     also closes a gap from before this migration: an owner could move an
--     expired quotation's validity date forward directly and convert it past
--     20260880's manager-plus-reason rule.
--   * Lines can be changed only on a draft or sent quotation — previously
--     "enforced in app layer" only, per the original RLS policy's comment.
--   * NOT closed here: a SENT quotation is still editable while its approval
--     is pending, so an approver can accept figures that changed after the
--     request was raised. Credit notes solve this with a fingerprint checked
--     at approval; quotations need the same (tracked as a follow-up).
--
-- SCOPE DECISION (read this before assuming "the JSON path is gone"):
-- `line_items` is KEPT, not dropped. It is now a server-maintained mirror of
-- quotation_lines, written by the RPC in the same transaction as the rows it
-- reflects, so for every quotation written from now on it cannot drift from
-- them (historical rows: see the backfill, section 6). Every existing reader —
-- convert_quotation_to_so, quotationPdf.js, DealDetail.jsx, the Sales
-- Documents screens, margin/reports — keeps reading it unchanged; NONE of
-- them needed to change for this migration. Pointing those readers directly
-- at quotation_lines (and dropping the mirror) is a deliberate fast-follow,
-- not done here: rewriting every consumer across a shared multi-document-type
-- form component in the same change as the schema is exactly the kind of
-- large, hard-to-review blast radius this project has avoided everywhere
-- else. The real integrity win — FK to products, CHECK per line, server-
-- computed totals, a table that can be joined and reported on — is delivered
-- now; the read-side migration is tracked as its own follow-up per document
-- type once each is proven.
-- ============================================================================

-- ── 1. the table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.quotation_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id  uuid NOT NULL REFERENCES public.quotations(id) ON DELETE CASCADE,
  line_no       integer NOT NULL,
  product_id    uuid REFERENCES public.products(id),   -- nullable: a free-text line (service, custom item) has none
  product_name  text NOT NULL,
  description   text,
  qty           integer NOT NULL,
  unit_price    numeric(14,4) NOT NULL DEFAULT 0,
  discount_pct  numeric(5,2) NOT NULL DEFAULT 0,
  tax_pct       numeric(5,2) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quotation_lines_qty_positive     CHECK (qty >= 1),
  CONSTRAINT quotation_lines_price_nonneg     CHECK (unit_price >= 0),
  CONSTRAINT quotation_lines_discount_range   CHECK (discount_pct >= 0 AND discount_pct <= 100),
  CONSTRAINT quotation_lines_tax_range        CHECK (tax_pct >= 0 AND tax_pct <= 100),
  CONSTRAINT quotation_lines_name_present     CHECK (length(btrim(product_name)) > 0),
  CONSTRAINT quotation_lines_unique_line      UNIQUE (quotation_id, line_no)
);

CREATE INDEX IF NOT EXISTS quotation_lines_quotation_id_idx ON public.quotation_lines (quotation_id);
CREATE INDEX IF NOT EXISTS quotation_lines_product_id_idx   ON public.quotation_lines (product_id) WHERE product_id IS NOT NULL;

COMMENT ON TABLE public.quotation_lines IS
  'One row per quotation line. Source of truth for a quotation''s lines; quotations.line_items is a read-only mirror maintained by create_quotation/update_quotation. Client writes are revoked — only those two RPCs write here.';

-- RLS: readable the same way the header is; no client write grant at all
-- (procedure-only, the same pattern as payments/warehouse_stock/the three
-- application tables since 20260850/20260872).
ALTER TABLE public.quotation_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_quotation_lines" ON public.quotation_lines;
CREATE POLICY "read_quotation_lines"
  ON public.quotation_lines
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.quotations q
       WHERE q.id = quotation_lines.quotation_id
         AND (
           public.rma_is_manager_or_above()
           OR (
             public.rma_is_staff()
             AND (q.assigned_rep = public.rma_current_user_email() OR q.created_by = public.rma_current_user_email())
           )
         )
    )
  );

REVOKE ALL ON TABLE public.quotation_lines FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.quotation_lines FROM authenticated;
GRANT SELECT ON TABLE public.quotation_lines TO authenticated;
GRANT ALL ON TABLE public.quotation_lines TO service_role;

-- ── 2. the guard: outside the RPCs a client may change only the status and
--      the archive flag ─────────────────────────────────────────────────────
-- An allowlist, not a list of pinned columns: a column added later is protected
-- by default. Status stays a plain UPDATE (send / accept / decline / cancel /
-- reopen), policed by rma_assert_sales_status_transition; archiving is
-- salesDocuments.setArchived. Everything else — lines, totals, customer, deal,
-- code, creator, and also validity_until, whose direct edit let an owner move an
-- expired quotation's date forward and convert it past 20260880's manager-plus-
-- reason rule — changes only through update_quotation. A refusal is loud: a
-- write that silently did nothing would look like a save.
CREATE OR REPLACE FUNCTION public.rma_guard_quotation_client_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_open text[] := ARRAY['status', 'archived', 'archived_at', 'archived_by', 'updated_at'];
BEGIN
  -- Client surface only. create_quotation/update_quotation run as the owner.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'A quotation''s lines, amounts and details are changed through the quotation form (update_quotation), not directly.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.rma_guard_quotation_client_writes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_guard_quotation_client_writes() TO service_role;

DROP TRIGGER IF EXISTS trg_quotations_client_writes ON public.quotations;
CREATE TRIGGER trg_quotations_client_writes
  BEFORE UPDATE ON public.quotations
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_quotation_client_writes();

-- A quotation can no longer be INSERTed directly — only create_quotation does
-- that now.
REVOKE INSERT ON TABLE public.quotations FROM authenticated;

-- ── 3. writing the lines (shared by both RPCs, not client-callable) ─────────
-- Replaces a quotation's lines with p_lines, validates each one, and returns
-- the totals with the same formula as src/api/db/_documentTotals.ts: discount
-- on the line base, tax on the discounted amount, summed raw and rounded once
-- at the end (rounding per line drifts a cent from the browser's preview) —
-- over the rows as stored.
--
-- An empty string for unit_price / discount_pct / tax_pct means "not entered"
-- (0), which is what the Deal screen sends for a cleared field and what the
-- browser-side total always treated it as. qty has no such default: a line
-- with no quantity is refused.
CREATE OR REPLACE FUNCTION public._quotation_write_lines(p_qt_id uuid, p_lines jsonb)
RETURNS TABLE (subtotal numeric, discount_amount numeric, tax_amount numeric, total numeric, line_items jsonb)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_line  jsonb;
  v_no    integer := 0;
  v_name  text;
  v_qty   text;
  v_price text;
  v_dpct  text;
  v_tpct  text;
  v_sub   numeric := 0;
  v_dsum  numeric := 0;
  v_tsum  numeric := 0;
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'A quotation can have at most 500 lines' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.quotation_lines WHERE quotation_id = p_qt_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Line % is not a line item', v_no + 1 USING ERRCODE = 'P0001';
    END IF;

    v_name  := btrim(COALESCE(v_line->>'product_name', ''));
    v_qty   := btrim(COALESCE(v_line->>'qty', ''));
    v_price := COALESCE(NULLIF(btrim(COALESCE(v_line->>'unit_price', '')), ''), '0');
    v_dpct  := COALESCE(NULLIF(btrim(COALESCE(v_line->>'discount_pct', '')), ''), '0');
    v_tpct  := COALESCE(NULLIF(btrim(COALESCE(v_line->>'tax_pct', '')), ''), '0');

    IF v_name = '' THEN
      RAISE EXCEPTION 'Every line needs a product name' USING ERRCODE = 'P0001';
    END IF;
    IF length(v_name) > 300 THEN
      RAISE EXCEPTION 'Line "%": the product name is longer than 300 characters', left(v_name, 40) USING ERRCODE = 'P0001';
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

    BEGIN
      INSERT INTO public.quotation_lines
        (quotation_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct)
      VALUES (
        p_qt_id, v_no,
        NULLIF(btrim(COALESCE(v_line->>'product_id', '')), '')::uuid,
        v_name,
        NULLIF(btrim(COALESCE(v_line->>'description', '')), ''),
        v_qty::integer, v_price::numeric, v_dpct::numeric, v_tpct::numeric
      );
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Line "%": the product reference is not valid', v_name USING ERRCODE = 'P0001';
      WHEN foreign_key_violation THEN
        RAISE EXCEPTION 'Line "%": that product does not exist', v_name USING ERRCODE = 'P0001';
    END;

    v_no := v_no + 1;
  END LOOP;

  -- From the rows as STORED, not the text the caller sent: a price of 0.00005
  -- is kept as 0.0001 and a discount of 10.555 as 10.56, and totals worked out
  -- from the raw input would disagree with the lines beside them.
  SELECT COALESCE(sum(b.base), 0),
         COALESCE(sum(b.disc), 0),
         COALESCE(sum((b.base - b.disc) * b.tax_pct / 100), 0)
    INTO v_sub, v_dsum, v_tsum
    FROM (SELECT l.qty * l.unit_price                        AS base,
                 l.qty * l.unit_price * l.discount_pct / 100 AS disc,
                 l.tax_pct
            FROM public.quotation_lines l WHERE l.quotation_id = p_qt_id) b;

  RETURN QUERY
  SELECT round(v_sub, 2), round(v_dsum, 2), round(v_tsum, 2), round(v_sub - v_dsum + v_tsum, 2),
         (SELECT jsonb_agg(jsonb_build_object(
                   'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
                   'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
                 ORDER BY l.line_no)
            FROM public.quotation_lines l WHERE l.quotation_id = p_qt_id);
END
$function$;

-- Internal: only the two RPCs below call it, as the owner.
REVOKE ALL ON FUNCTION public._quotation_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._quotation_write_lines(uuid, jsonb) TO service_role;

-- ── 4. create_quotation ──────────────────────────────────────────────────────
-- p_lines: [{"product_id": "...", "product_name": "...", "description": "...",
--            "qty": 2, "unit_price": 100, "discount_pct": 10, "tax_pct": 14}, ...]
-- p_actor_email is kept for the calling convention only: who created the row
-- is taken from the login, never from the caller.
CREATE OR REPLACE FUNCTION public.create_quotation(
  p_customer_id     uuid,
  p_deal_id         uuid,
  p_lines           jsonb,
  p_validity_until  date,
  p_payment_terms   text,
  p_reference_po    text,
  p_notes           text,
  p_assigned_rep    text,
  p_actor_email     text
)
RETURNS public.quotations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_id    uuid := gen_random_uuid();
  v_t     record;
  v_row   public.quotations;
BEGIN
  -- Who may create one: exactly the INSERT policy this replaces
  -- (sales_insert_quotations, 20260781) — manager and above, or a sales rep.
  IF NOT COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep', false) THEN
    RAISE EXCEPTION 'Not authorized to create a quotation' USING ERRCODE = 'P0001';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Your login has no email, so this quotation cannot be attributed' USING ERRCODE = 'P0001';
  END IF;
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'A customer is required' USING ERRCODE = 'P0001';
  END IF;
  -- A quotation adds to its deal's value (dealValue.ts), so it must be a deal
  -- for the same customer. This runs as the owner, past RLS, so it is checked
  -- here rather than left to the foreign key.
  IF p_deal_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.deals d WHERE d.id = p_deal_id AND d.customer_id = p_customer_id) THEN
    RAISE EXCEPTION 'That deal does not exist or belongs to another customer' USING ERRCODE = 'P0001';
  END IF;

  -- The parent row must exist before a line can reference it (a real FK now,
  -- unlike the old jsonb blob): created empty, filled in below.
  INSERT INTO public.quotations
    (id, qt_code, deal_id, customer_id, status, line_items,
     validity_until, payment_terms, reference_po, notes, assigned_rep, created_by)
  VALUES (
    v_id, public.generate_doc_code('QT'), p_deal_id, p_customer_id, 'draft', '[]'::jsonb,
    p_validity_until, p_payment_terms, p_reference_po, p_notes, p_assigned_rep, v_actor
  );

  SELECT * INTO v_t FROM public._quotation_write_lines(v_id, p_lines);

  UPDATE public.quotations SET
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

REVOKE ALL ON FUNCTION public.create_quotation(uuid, uuid, jsonb, date, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_quotation(uuid, uuid, jsonb, date, text, text, text, text, text) TO authenticated, service_role;

-- ── 5. update_quotation ──────────────────────────────────────────────────────
-- Sets ONLY the header fields present as keys in p_fields (a key with a null
-- value blanks that field): the Deal screen sends lines, validity, terms and
-- notes but not reference_po or assigned_rep, and setting every column from a
-- parameter would blank those two on every save from there. p_lines NULL keeps
-- the lines as they are, so every field edit a client makes comes through here
-- (the trigger above refuses them anywhere else).
DROP FUNCTION IF EXISTS public.update_quotation(uuid, jsonb, date, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.update_quotation(
  p_id          uuid,
  p_lines       jsonb,
  p_fields      jsonb,
  p_actor_email text
)
RETURNS public.quotations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor   text := public.rma_current_user_email();
  v_allowed text[] := ARRAY['validity_until', 'payment_terms', 'reference_po', 'notes', 'assigned_rep'];
  v_key     text;
  v_qt      public.quotations;
  v_f       jsonb := COALESCE(p_fields, '{}'::jsonb);
  v_rep     text;
  v_valid   date;
  v_items   jsonb;
  v_sub     numeric;
  v_dis     numeric;
  v_tax     numeric;
  v_tot     numeric;
  v_row     public.quotations;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized to edit a quotation' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(v_f) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Fields must be an object' USING ERRCODE = 'P0001';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_f) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'The field "%" cannot be changed here', v_key USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT * INTO v_qt FROM public.quotations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quotation % not found', p_id USING ERRCODE = 'P0001';
  END IF;

  v_rep := CASE WHEN v_f ? 'assigned_rep' THEN NULLIF(btrim(COALESCE(v_f->>'assigned_rep', '')), '') ELSE v_qt.assigned_rep END;

  -- Exactly the UPDATE policy this replaces (sales_update_quotations, 20260781):
  -- a manager, or a sales rep who owns it — both before (USING) and after
  -- (WITH CHECK), so a rep cannot hand a quotation they only hold as assignee
  -- to somebody else. COALESCE: with no assigned rep, "assigned_rep = me" is
  -- NULL, and an IF on NULL does not fire (BUG-087).
  IF NOT COALESCE(
       public.rma_is_manager_or_above()
       OR (public.rma_user_role() = 'sales_rep'
           AND (v_qt.assigned_rep = v_actor OR v_qt.created_by = v_actor)
           AND (v_rep = v_actor OR v_qt.created_by = v_actor)),
       false) THEN
    RAISE EXCEPTION 'Not authorized to edit this quotation' USING ERRCODE = 'P0001';
  END IF;

  -- Was "enforced in app layer" only (the original update policy's own
  -- comment): an accepted quote's approved figures and the Sales Order
  -- converted from it could diverge.
  IF v_qt.status NOT IN ('draft', 'sent') THEN
    RAISE EXCEPTION 'This quotation is % and can no longer be edited', v_qt.status USING ERRCODE = 'P0001';
  END IF;

  IF v_f ? 'validity_until' THEN
    BEGIN
      v_valid := NULLIF(btrim(COALESCE(v_f->>'validity_until', '')), '')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'The validity date is not a date' USING ERRCODE = 'P0001';
    END;
  END IF;

  -- With no lines sent, the lines and their totals stay as they are.
  v_items := v_qt.line_items; v_sub := v_qt.subtotal; v_dis := v_qt.discount_amount;
  v_tax := v_qt.tax_amount;   v_tot := v_qt.total;
  IF p_lines IS NOT NULL THEN
    SELECT w.line_items, w.subtotal, w.discount_amount, w.tax_amount, w.total
      INTO v_items, v_sub, v_dis, v_tax, v_tot
      FROM public._quotation_write_lines(p_id, p_lines) w;
  END IF;

  UPDATE public.quotations SET
    line_items      = v_items,
    subtotal        = v_sub,
    discount_amount = v_dis,
    tax_amount      = v_tax,
    total           = v_tot,
    validity_until  = CASE WHEN v_f ? 'validity_until' THEN v_valid                ELSE validity_until END,
    payment_terms   = CASE WHEN v_f ? 'payment_terms'  THEN v_f->>'payment_terms'  ELSE payment_terms  END,
    reference_po    = CASE WHEN v_f ? 'reference_po'   THEN v_f->>'reference_po'   ELSE reference_po   END,
    notes           = CASE WHEN v_f ? 'notes'          THEN v_f->>'notes'          ELSE notes          END,
    assigned_rep    = v_rep
  WHERE id = p_id
  RETURNING * INTO v_row;

  RETURN v_row;
END
$function$;

REVOKE ALL ON FUNCTION public.update_quotation(uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_quotation(uuid, jsonb, jsonb, text) TO authenticated, service_role;

-- ── 6. backfill existing rows ────────────────────────────────────────────────
-- One-time and idempotent (NOT EXISTS: a re-run adds nothing). line_items and
-- the stored totals of existing quotations are NOT rewritten — some are
-- accepted or converted documents, and their figures stand as issued. So for
-- historical rows the relational copy is best-effort: where the old jsonb broke
-- a rule the table now enforces, the row is brought inside it and the change is
-- reported, and every quotation whose lines no longer add up to its stored
-- total is counted at the end rather than silently left to disagree.
--
-- Each line is read as text and checked before any cast, so one bad value
-- costs only that value: a product id that is malformed, or whose product was
-- deleted, becomes NULL and the line keeps its name, quantity and price.
CREATE OR REPLACE FUNCTION pg_temp.qt_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
BEGIN
  IF btrim(COALESCE(p, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN btrim(p)::numeric; END IF;
  RETURN p_default;
END $f$;

DO $$
DECLARE
  v_q        record;
  v_t        record;
  v_no       integer;
  v_pid      uuid;
  v_qty      numeric;
  v_price    numeric;
  v_dpct     numeric;
  v_tpct     numeric;
  v_changed  integer := 0;
  v_lines    integer := 0;
  v_drift    integer;
BEGIN
  FOR v_q IN
    SELECT q.id, q.line_items FROM public.quotations q
     WHERE NOT EXISTS (SELECT 1 FROM public.quotation_lines ql WHERE ql.quotation_id = q.id)
       AND jsonb_typeof(q.line_items) = 'array'   -- a non-array blob would abort the whole migration
  LOOP
    v_no := 0;
    FOR v_t IN SELECT e.l FROM jsonb_array_elements(v_q.line_items) AS e(l)
    LOOP
      IF jsonb_typeof(v_t.l) IS DISTINCT FROM 'object' THEN
        v_t.l := '{}'::jsonb;
      END IF;

      v_pid := NULL;
      IF btrim(COALESCE(v_t.l->>'product_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_pid FROM public.products p WHERE p.id = btrim(v_t.l->>'product_id')::uuid;
      END IF;

      v_qty   := pg_temp.qt_bf_num(v_t.l->>'qty', 1);
      v_price := pg_temp.qt_bf_num(v_t.l->>'unit_price', 0);
      v_dpct  := pg_temp.qt_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct  := pg_temp.qt_bf_num(v_t.l->>'tax_pct', 0);

      IF v_qty <> round(v_qty) OR v_qty < 1 OR v_price < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100
         OR (btrim(COALESCE(v_t.l->>'product_id', '')) <> '' AND v_pid IS NULL) THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'quotation_lines backfill: quotation % line % had values outside the new rules (qty %, price %, discount %, tax %, product %); stored inside them',
          v_q.id, v_no + 1, v_t.l->>'qty', v_t.l->>'unit_price', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.quotation_lines
        (quotation_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct)
      VALUES (
        v_q.id, v_no, v_pid,
        COALESCE(NULLIF(btrim(COALESCE(v_t.l->>'product_name', '')), ''), '(unnamed line)'),
        NULLIF(btrim(COALESCE(v_t.l->>'description', '')), ''),
        GREATEST(1, LEAST(999999999, round(v_qty)))::integer,
        GREATEST(0, LEAST(9999999999, v_price)),
        LEAST(100, GREATEST(0, v_dpct)),
        LEAST(100, GREATEST(0, v_tpct))
      );
      v_lines := v_lines + 1;
      v_no := v_no + 1;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_drift
    FROM public.quotations q
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty * l.unit_price * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.quotation_lines l WHERE l.quotation_id = q.id) s ON true
   WHERE abs(s.t - q.total) > 0.01;

  RAISE NOTICE 'quotation_lines backfill: % lines written, % brought inside the new rules, % quotations whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- ── guard: nothing new is anon-executable ───────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.create_quotation(uuid, uuid, jsonb, date, text, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_quotation(uuid, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._quotation_write_lines(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a quotation-line function is executable by anon';
  END IF;
  IF has_table_privilege('anon', 'public.quotation_lines', 'SELECT')
     OR has_table_privilege('anon', 'public.quotation_lines', 'INSERT') THEN
    RAISE EXCEPTION 'Refusing to finish: quotation_lines is reachable by anon';
  END IF;
END $$;
