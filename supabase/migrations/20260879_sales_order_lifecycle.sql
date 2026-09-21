-- ============================================================================
-- 20260879_sales_order_lifecycle.sql — BL-04 / I-04
--
-- The sales-order lifecycle told small lies about stock and about itself.
-- Each one was reproduced by supabase/tests/sales_order_lifecycle.sql before
-- this file existed (24 failing checks), and is fixed here.
--
-- 1. reject_sales_order had no status check. A manager could "decline" a
--    confirmed, delivered or cancelled order: the status changed and whatever
--    the order had reserved stayed reserved. Now: only an order awaiting
--    approval ('sent') can be rejected, under a row lock.
--
-- 2. cancel_sales_order released serialized units only. An order that reserved
--    a BULK quantity kept it after cancellation for ever, so the warehouse
--    showed stock as reserved for a document that no longer existed. It now
--    also calls release_warehouse_stock.
--
-- 3. approve_sales_order set status = 'delivered' and delivered_at = now(),
--    although the units were only reserved: nothing had been delivered
--    (deliver_units runs when the invoice posts). An approved order is now
--    'confirmed'; 'delivered' is for a delivery. Orders already 'delivered'
--    are left as they are. The same function used to skip a line with no
--    quantity, or a quantity of 0, without a word -- so an order could be
--    approved having reserved nothing for that line. It now refuses.
--
-- 4. An invoice could be created from a sales order in ANY status, a draft or
--    a declined one included, because the check lived only in the browser. A
--    trigger now requires 'confirmed' or 'delivered'. It polices the client
--    surface only: an RPC (the owner) is exempt -- and Backup & Restore is an
--    RPC (rma_restore_apply), so an administrator needs no exemption of their
--    own. The lookup is a SECURITY DEFINER helper: a sales rep, the one
--    non-manager role that can insert an invoice, cannot READ another rep's
--    order, and a lookup run as them saw "not found" and let the invoice
--    through (found by the independent review, reproduced before the fix).
--
-- 5. Quotation, sales-order and purchase-order codes were random 8-digit
--    numbers under a UNIQUE constraint, with no retry: a collision (1 in
--    ~90 million per pair, so rare and therefore never noticed) is a hard
--    failure at creation. They are now sequential, QT-YYYY-NNNNN, from the
--    same document_sequences table the invoices use, one sequence each. They
--    are not legally gapless (a draft that fails validation burns a number),
--    which is the reason they were left off nextval_for_type at first; the
--    point here is uniqueness and order. generate_doc_code creates its own
--    sequence row if a project lacks it, so a tenant provisioned before this
--    file needs no seed. Existing random codes are untouched and cannot
--    collide with the new format. Other prefixes keep the random behaviour.
--    generate_doc_code also stops accepting a viewer, who could burn numbers.
--    nextval_for_type no longer lets a counter go BACK a year (a transaction
--    that started before midnight could re-issue number 1 of the new year, and
--    these are now uniquely-constrained columns), and the code carries the
--    counter's own year.
--
-- 6. rma_reservation_integrity(): the check that would have caught 1-3.
--    Reports units reserved for an order that is closed or missing, a bulk
--    counter that disagrees with the ledger, and an approved order holding
--    less stock than it sold. Administrators only. (Reserving more than is on
--    hand needs no check: warehouse_stock_check already forbids it.)
--
-- 7. Found while adding 6 beside rma_data_integrity_issues(): that function's
--    own comment says "Admins only" but it was granted to every signed-in
--    user with no check inside, and its rows carry invoice codes and amounts.
--    A technician or a viewer could read them. The admin check lived only in
--    the summary wrapper the screen calls. The body is renamed and closed to
--    clients, and a guarded function takes its name.
--
-- Idempotent. Not applied to production without the owner's OK.
-- ============================================================================

-- ── 1. reject only from 'sent' ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_sales_order(p_so_id uuid, p_actor_email text)
 RETURNS SETOF sales_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_so record;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to reject sales orders';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found: %', p_so_id;
  END IF;

  -- Rejecting is the answer to "may this go ahead?". Once an order is
  -- confirmed it holds stock, and once it is cancelled it is finished:
  -- cancel_sales_order is the way out of either, because it releases.
  IF v_so.status <> 'sent' THEN
    RAISE EXCEPTION 'Only a sales order awaiting approval can be rejected (current: %). Use cancel to withdraw an order that was already approved.', v_so.status
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sales_orders
  SET status = 'declined', updated_at = NOW()
  WHERE id = p_so_id;

  RETURN QUERY SELECT * FROM public.sales_orders WHERE id = p_so_id;
END;
$function$;

-- ── 2. cancel releases bulk stock as well ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_sales_order(p_so_id uuid, p_actor_email text)
 RETURNS SETOF sales_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_so    record;
  v_email text := public.rma_current_user_email();
BEGIN
  -- Coarse gate: nobody outside sales or management cancels an order, and
  -- this costs no lookup, so it answers before revealing whether the id is real.
  IF NOT COALESCE((public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep'), false) THEN
    RAISE EXCEPTION 'Not authorized to cancel sales orders' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found: %', p_so_id;
  END IF;

  -- Fine-grained: a rep may cancel their own orders, not a colleague's.
  -- Mirrors sales_update_sales_orders.
  IF NOT (public.rma_is_manager_or_above()
          OR v_so.assigned_rep = v_email
          OR v_so.created_by  = v_email) THEN
    RAISE EXCEPTION 'Not authorized to cancel this sales order' USING ERRCODE = 'P0001';
  END IF;

  IF v_so.status = 'cancelled' THEN
    RAISE EXCEPTION 'Sales order is already cancelled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.crm_invoices
    WHERE so_id = p_so_id AND doc_status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Cannot cancel — an invoice exists; void or credit it first';
  END IF;

  -- Both kinds of reservation. Each is idempotent: it releases only what the
  -- ledger says this document still holds.
  PERFORM public.release_units('sales_order', p_so_id, p_actor_email);
  PERFORM public.release_warehouse_stock('sales_order', p_so_id, p_actor_email);

  UPDATE public.sales_orders
  SET status = 'cancelled', updated_at = NOW()
  WHERE id = p_so_id;

  RETURN QUERY SELECT * FROM public.sales_orders WHERE id = p_so_id;
END;
$function$;

-- ── 3. approve confirms; it does not claim a delivery ───────────────────────
CREATE OR REPLACE FUNCTION public.approve_sales_order(p_so_id uuid, p_actor_email text)
 RETURNS SETOF sales_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_so   record;
  v_line record;
  v_qty  numeric;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to approve sales orders';
  END IF;

  SELECT * INTO v_so
  FROM public.sales_orders
  WHERE id = p_so_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found: %', p_so_id;
  END IF;

  IF v_so.status <> 'sent' THEN
    RAISE EXCEPTION 'Sales order must be submitted for approval first (current: %)', v_so.status;
  END IF;

  FOR v_line IN
    SELECT n AS line_no,
           NULLIF(line->>'product_id', '')::uuid AS product_id,
           NULLIF(line->>'qty', '')              AS qty_text
    FROM jsonb_array_elements(v_so.line_items) WITH ORDINALITY AS t(line, n)
    WHERE NULLIF(line->>'product_id', '') IS NOT NULL
  LOOP
    -- A line that sells something must say how many. Before this it was
    -- skipped without a word and the order was approved holding nothing for it.
    -- Judged as TEXT before any cast: 'NaN' and 'Infinity' are valid numerics
    -- that sail past a range test, and 'abc' would escape as a raw cast error
    -- instead of this message. Up to six digits, optionally written 2.0.
    IF v_line.qty_text IS NULL OR v_line.qty_text !~ '^[0-9]{1,6}(\.0+)?$' THEN
      RAISE EXCEPTION 'Line % has no valid quantity (%). Give it a whole number above zero.',
        v_line.line_no, COALESCE(left(v_line.qty_text, 20), 'empty')
        USING ERRCODE = 'P0001';
    END IF;
    v_qty := v_line.qty_text::numeric;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Line % has no valid quantity (%). Give it a whole number above zero.',
        v_line.line_no, v_line.qty_text
        USING ERRCODE = 'P0001';
    END IF;

    PERFORM public.funnel_reserve_line(
      'sales_order', p_so_id, v_line.product_id, v_qty::integer, p_actor_email
    );
  END LOOP;

  -- 'confirmed', not 'delivered': the stock is held for the customer, it has
  -- not left the building. delivered_at stays empty until it does.
  UPDATE public.sales_orders
  SET
    status       = 'confirmed',
    confirmed_at = NOW(),
    updated_at   = NOW()
  WHERE id = p_so_id;

  RETURN QUERY SELECT * FROM public.sales_orders WHERE id = p_so_id;
END;
$function$;

-- ── 4. an invoice needs an approved order ───────────────────────────────────
-- The lookup has to see EVERY order. sales_orders is row-level-secured: a sales
-- rep reads only their own, so a lookup run as the caller saw "not found" for a
-- colleague's draft and let the invoice through -- and the sales rep is the one
-- non-manager role that can insert an invoice at all. So the lookup lives in a
-- SECURITY DEFINER helper that answers one boolean (it discloses nothing else
-- about an order the caller cannot read). The trigger itself must stay
-- SECURITY INVOKER: inside a definer function current_user is the owner, and
-- the "client surface only" test below would never fire.
--
-- FOR SHARE: blocks against cancel_sales_order's and approve_sales_order's
-- FOR UPDATE on the same row, so an invoice cannot slip in between "cancel
-- checked there is no invoice" and "cancel committed". (The helper is
-- volatile because FOR SHARE is not allowed in a stable function.)
CREATE OR REPLACE FUNCTION public.rma_sales_order_can_be_invoiced(p_so_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM public.sales_orders WHERE id = p_so_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN true;            -- no such order: the foreign key reports it
  END IF;
  RETURN v_status IN ('confirmed', 'delivered');
END;
$function$;

REVOKE ALL ON FUNCTION public.rma_sales_order_can_be_invoiced(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_sales_order_can_be_invoiced(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rma_guard_invoice_from_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only the client surface is policed; an RPC runs as the owner. That
  -- includes Backup & Restore, which goes through rma_restore_apply (a
  -- SECURITY DEFINER RPC), so an administrator needs no exemption here --
  -- signed in as one, the rule applies to them like anyone else.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF NEW.so_id IS NULL THEN
    RETURN NEW;                                 -- a standalone invoice
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.so_id IS NOT DISTINCT FROM OLD.so_id THEN
    RETURN NEW;                                 -- an edit, not a new link
  END IF;

  IF NOT public.rma_sales_order_can_be_invoiced(NEW.so_id) THEN
    RAISE EXCEPTION 'An invoice can only be raised from an approved sales order.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.rma_guard_invoice_from_order() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_guard_invoice_from_order() TO service_role;

DROP TRIGGER IF EXISTS trg_crm_invoices_from_approved_order ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_from_approved_order
  BEFORE INSERT OR UPDATE OF so_id ON public.crm_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_invoice_from_order();

-- ── 5. sequential QT / SO / PO codes ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.nextval_for_type(p_seq_type text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- The wall clock, not NOW(): NOW() is the START of the transaction, so one
  -- that began just before midnight and ran after it carried the old year.
  v_clock    integer := EXTRACT(YEAR FROM clock_timestamp())::integer;
  v_year     integer;
  v_next     integer;
  v_prefix   text;
BEGIN
  -- A counter is never pulled BACK to an earlier year. If a later transaction
  -- already moved it into the new year, resetting it here would re-issue
  -- number 1 of the new year: harmless for an invoice code nobody has yet
  -- used, a duplicate for the quotation / order / PO columns that are now
  -- behind this function. The code carries the counter's own year, so the
  -- number and the year always belong together.
  UPDATE public.document_sequences
  SET
    last_value = CASE WHEN seq_year < v_clock THEN 1 ELSE last_value + 1 END,
    seq_year   = GREATEST(seq_year, v_clock)
  WHERE seq_type = p_seq_type
  RETURNING last_value, seq_year INTO v_next, v_year;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Unknown sequence type: %', p_seq_type;
  END IF;

  v_prefix := CASE p_seq_type
    WHEN 'invoice'        THEN 'INV'
    WHEN 'credit_note'    THEN 'CN'
    WHEN 'payment'        THEN 'PAY'
    WHEN 'vendor_invoice' THEN 'VI'
    WHEN 'vendor_payment' THEN 'VP'
    WHEN 'quotation'      THEN 'QT'
    WHEN 'sales_order'    THEN 'SO'
    WHEN 'purchase_order' THEN 'PO'
    ELSE UPPER(p_seq_type)
  END;

  RETURN v_prefix || '-' || v_year::text || '-' || LPAD(v_next::text, 5, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_doc_code(p_prefix text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_type text;
BEGIN
  -- A viewer creates nothing, so has no business consuming numbers.
  IF NOT COALESCE((public.rma_is_staff() AND public.rma_user_role() <> 'viewer'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_type := CASE p_prefix
    WHEN 'QT' THEN 'quotation'
    WHEN 'SO' THEN 'sales_order'
    WHEN 'PO' THEN 'purchase_order'
  END;

  IF v_type IS NULL THEN
    -- Any other prefix keeps the old random code rather than breaking.
    RETURN p_prefix || '-' || LPAD((FLOOR(RANDOM() * 90000000) + 10000000)::text, 8, '0');
  END IF;

  -- Self-healing: a project provisioned before these rows existed needs no
  -- seed. The conflict target is the primary key, so this never resets a
  -- counter that is already running.
  INSERT INTO public.document_sequences (seq_type, seq_year, last_value)
  VALUES (v_type, EXTRACT(YEAR FROM NOW())::integer, 0)
  ON CONFLICT (seq_type) DO NOTHING;

  RETURN public.nextval_for_type(v_type);
END;
$function$;

-- ── 6. the reservation integrity report ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_reservation_integrity()
 RETURNS TABLE(check_name text, severity text, entity text, entity_id uuid, reference text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- A signed-in browser session must be an administrator. A service_role or
  -- owner session (a scheduled job) carries no JWT and passes.
  IF auth.role() IN ('authenticated', 'anon')
     AND NOT COALESCE(public.rma_is_admin(), false) THEN
    RAISE EXCEPTION 'Only an administrator can run the reservation integrity check.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY

  -- Units held for an order that can no longer use them: it is a draft, sent,
  -- declined or cancelled, or it does not exist. One row per order.
  SELECT 'unit_reserved_by_closed_document'::text,
         'high'::text,
         'sales_orders'::text,
         u.reserved_by_doc_id,
         COALESCE(so.so_code, u.reserved_by_doc_id::text),
         format('%s unit(s) still reserved for an order that is %s: %s',
                count(*), COALESCE(so.status, 'missing'),
                string_agg(COALESCE(u.serial_number, u.id::text), ', ' ORDER BY u.serial_number))
    FROM public.inventory_units u
    LEFT JOIN public.sales_orders so ON so.id = u.reserved_by_doc_id
   WHERE u.reservation_status = 'reserved'
     AND u.reserved_by_doc_type = 'sales_order'
     AND (so.id IS NULL OR so.status NOT IN ('confirmed', 'delivered', 'accepted'))
   GROUP BY u.reserved_by_doc_id, so.so_code, so.status

  UNION ALL

  -- The bulk counter is derived from the ledger, so the two must agree.
  SELECT 'bulk_reserved_mismatch',
         'high',
         'warehouse_stock',
         ws.id,
         COALESCE(p.sku, ws.product_id::text),
         format('reserved_quantity is %s but the ledger says %s', ws.reserved_quantity, l.net)
    FROM public.warehouse_stock ws
    LEFT JOIN public.products p ON p.id = ws.product_id
    CROSS JOIN LATERAL (
      SELECT GREATEST(COALESCE(SUM(CASE WHEN m.move_type = 'reserve' THEN m.qty
                                        WHEN m.move_type IN ('release', 'deliver') THEN -m.qty
                                        ELSE 0 END), 0), 0)::numeric AS net
        FROM public.stock_moves m
       WHERE m.ref_type = 'warehouse_stock' AND m.ref_id = ws.id
    ) l
   WHERE ws.reserved_quantity::numeric IS DISTINCT FROM l.net

  UNION ALL

  -- An approved (confirmed) order that has not been invoiced yet should hold
  -- what it sold. Service lines hold nothing and are ignored. Once an invoice
  -- exists, delivery has moved the stock on and this no longer applies.
  SELECT 'confirmed_order_under_reserved',
         'medium',
         'sales_orders',
         so.id,
         so.so_code,
         format('lines sell %s but only %s is held', need.qty, held.qty)
    FROM public.sales_orders so
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM((l.line->>'qty')::numeric), 0) AS qty
        FROM jsonb_array_elements(so.line_items) AS l(line)
        JOIN public.products p ON p.id = NULLIF(l.line->>'product_id', '')::uuid
       -- IS DISTINCT FROM, not <>: product_type is nullable, and funnel_reserve_line
       -- reserves a product whose type is NULL (only 'service' is exempt). <> would
       -- drop such a line from "need" and the check could never fire for it.
       WHERE p.product_type IS DISTINCT FROM 'service'
    ) need
    CROSS JOIN LATERAL (
      SELECT (SELECT count(*) FROM public.inventory_units u
               WHERE u.reserved_by_doc_type = 'sales_order' AND u.reserved_by_doc_id = so.id
                 AND u.reservation_status = 'reserved')::numeric
           + COALESCE((SELECT SUM(CASE WHEN m.move_type = 'reserve' THEN m.qty
                                       WHEN m.move_type IN ('release', 'deliver') THEN -m.qty
                                       ELSE 0 END)
                         FROM public.stock_moves m
                        WHERE m.doc_type = 'sales_order' AND m.doc_id = so.id
                          AND m.ref_type = 'warehouse_stock'), 0)::numeric AS qty
    ) held
   WHERE so.status = 'confirmed'
     AND need.qty > held.qty
     -- Any invoice at all, voided ones included: void_invoice cancels the
     -- invoice and releases the units but leaves the order confirmed, so
     -- "holds less than it sold" is the documented normal state after a void
     -- (post_invoice's own HINT says so) and must not be reported for ever.
     AND NOT EXISTS (SELECT 1 FROM public.crm_invoices i WHERE i.so_id = so.id);
END;
$function$;

REVOKE ALL ON FUNCTION public.rma_reservation_integrity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_reservation_integrity() TO authenticated, service_role;

-- ── 7. close rma_data_integrity_issues() to everyone but administrators ─────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'rma_data_integrity_issues')
     AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = 'rma_data_integrity_issues_unguarded') THEN
    ALTER FUNCTION public.rma_data_integrity_issues() RENAME TO rma_data_integrity_issues_unguarded;
  END IF;
END
$do$;

-- Refuse clearly rather than abort halfway if the report was never created.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'rma_data_integrity_issues_unguarded') THEN
    RAISE EXCEPTION 'Refusing to finish: public.rma_data_integrity_issues() does not exist on this project, so there is nothing to close. Apply 20260839 first.';
  END IF;
END
$do$;

REVOKE ALL ON FUNCTION public.rma_data_integrity_issues_unguarded() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rma_data_integrity_issues_unguarded() TO service_role;

CREATE OR REPLACE FUNCTION public.rma_data_integrity_issues()
 RETURNS TABLE(check_name text, severity text, entity text, entity_id uuid, reference text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- The rows name customers, invoice codes and amounts. A service_role or
  -- owner session (a scheduled job) carries no JWT and passes; a signed-in
  -- browser session must be an administrator.
  IF auth.role() IN ('authenticated', 'anon')
     AND NOT COALESCE(public.rma_is_admin(), false) THEN
    RAISE EXCEPTION 'Only an administrator can read the data integrity findings.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT * FROM public.rma_data_integrity_issues_unguarded();
END;
$function$;

REVOKE ALL ON FUNCTION public.rma_data_integrity_issues() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_data_integrity_issues() TO authenticated, service_role;

COMMENT ON FUNCTION public.rma_data_integrity_issues() IS
  'Administrators only (checked inside). The findings themselves live in rma_data_integrity_issues_unguarded(), which no client role can execute. Do NOT re-apply 20260839 / 20260843 / 20260846 after this: each does CREATE OR REPLACE on this name with the raw body and would reopen the leak.';
