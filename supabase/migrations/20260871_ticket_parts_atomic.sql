-- Parts used on a ticket: the stock change and the ticket_parts row are one
-- transaction. (Audit finding BUG-030, second half.)
--
-- ── What was already fixed ───────────────────────────────────────────────────
--
-- 20260828 made adjust_part_quantity refuse to go below zero (no more silent
-- clamp), refuse an unknown part, and lock the part row.
--
-- ── What this closes ─────────────────────────────────────────────────────────
--
-- ticketParts.add() and remove() were two client calls each:
--
--   add:    adjust_part_quantity(-qty)   then  INSERT ticket_parts
--   remove: adjust_part_quantity(+qty)   then  DELETE ticket_parts
--
-- A failure between them left stock changed with no record of why. remove()
-- was worse than a network blip: the DELETE policy is admin-only, so a
-- non-admin staff member's remove re-added the stock and was then refused the
-- delete — stock went up every time they tried. And remove() trusted the
-- part id and quantity sent by the browser rather than the row being removed.
--
-- The table's own write policies were a second, unguarded path: any staff
-- member could INSERT a ticket_parts row (no stock taken), UPDATE its quantity
-- or part (stock untouched), or, as admin, DELETE it (no stock returned).
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- rma_ticket_part_add(ticket, part, quantity, unit_cost, notes)
--   Staff except viewer (as the INSERT policy was). Takes the stock through
--   adjust_part_quantity — the one stock rule — and inserts the row in the same
--   transaction. unit_cost defaults to the part's cost. added_by is the
--   signed-in user, not a value the browser supplies.
--
-- rma_ticket_part_remove(id)
--   Admin (as the DELETE policy was). Locks the row, returns ITS quantity to
--   ITS part, and deletes it — nothing is taken from the browser but the id.
--
-- Direct INSERT / UPDATE / DELETE on ticket_parts is revoked from client roles
-- and the three write policies are dropped. Reading is unchanged. Nothing in
-- the app writes the table directly (TicketDrawer only lists); backup restore
-- runs as SECURITY DEFINER and is unaffected.
--
-- ── Deliberately NOT changed ─────────────────────────────────────────────────
--
-- Deleting a ticket cascades to its ticket_parts rows without returning stock.
-- Whether parts fitted to a deleted ticket go back on the shelf is a business
-- rule, not something to settle here.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF to_regprocedure('public.adjust_part_quantity(uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: adjust_part_quantity(uuid, integer) does not exist.';
  END IF;
  IF to_regprocedure('public.rma_current_user_email()') IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: rma_current_user_email() does not exist.';
  END IF;
END
$do$;

-- ═══ Add ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_ticket_part_add(
  p_ticket_id uuid,
  p_part_id   uuid,
  p_quantity  integer,
  p_unit_cost numeric DEFAULT NULL,
  p_notes     text    DEFAULT NULL
)
RETURNS public.ticket_parts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_cost numeric;
  v_row  public.ticket_parts;
BEGIN
  IF NOT COALESCE((public.rma_is_staff() AND public.rma_user_role() <> 'viewer'), false) THEN
    RAISE EXCEPTION 'Not authorized to add parts to a ticket' USING ERRCODE = 'P0001';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be a whole number above zero' USING ERRCODE = 'P0001';
  END IF;
  IF p_unit_cost IS NOT NULL AND p_unit_cost < 0 THEN
    RAISE EXCEPTION 'Unit cost cannot be negative' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rma_tickets t WHERE t.id = p_ticket_id) THEN
    RAISE EXCEPTION 'Ticket % does not exist', p_ticket_id USING ERRCODE = 'P0001';
  END IF;

  -- Raises on an unknown part or insufficient stock, and locks the part row.
  PERFORM public.adjust_part_quantity(p_part_id, -p_quantity);

  SELECT p.unit_cost INTO v_cost FROM public.parts p WHERE p.id = p_part_id;

  INSERT INTO public.ticket_parts (ticket_id, part_id, quantity, unit_cost, notes, added_by, created_date)
  VALUES (
    p_ticket_id, p_part_id, p_quantity,
    COALESCE(p_unit_cost, v_cost, 0),
    NULLIF(btrim(p_notes), ''),
    public.rma_current_user_email(),
    now()
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$fn$;

-- ═══ Remove ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_ticket_part_remove(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_row public.ticket_parts;
BEGIN
  IF NOT COALESCE(public.rma_is_admin(), false) THEN
    RAISE EXCEPTION 'Not authorized to remove parts from a ticket' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM public.ticket_parts tp WHERE tp.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket part % does not exist', p_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.adjust_part_quantity(v_row.part_id, v_row.quantity);

  DELETE FROM public.ticket_parts tp WHERE tp.id = p_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_ticket_part_add(uuid, uuid, integer, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rma_ticket_part_remove(uuid) FROM PUBLIC;
DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.rma_ticket_part_add(uuid, uuid, integer, numeric, text) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.rma_ticket_part_remove(uuid) FROM anon';
END
$do$;
GRANT EXECUTE ON FUNCTION public.rma_ticket_part_add(uuid, uuid, integer, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rma_ticket_part_remove(uuid) TO authenticated;

-- ═══ Close the direct write path ═════════════════════════════════════════════

DROP POLICY IF EXISTS staff_write  ON public.ticket_parts;
DROP POLICY IF EXISTS staff_update ON public.ticket_parts;
DROP POLICY IF EXISTS admin_delete ON public.ticket_parts;
DO $do$
BEGIN
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.ticket_parts FROM anon, authenticated';
END
$do$;

-- ═══ Guards: the migration refuses to finish if it did not take ══════════════

DO $do$
BEGIN
  IF has_table_privilege('authenticated', 'public.ticket_parts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ticket_parts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ticket_parts', 'DELETE')
     OR has_table_privilege('anon', 'public.ticket_parts', 'INSERT')
     OR has_table_privilege('anon', 'public.ticket_parts', 'UPDATE')
     OR has_table_privilege('anon', 'public.ticket_parts', 'DELETE') THEN
    RAISE EXCEPTION 'Refusing to finish: a client role can still write ticket_parts directly.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'ticket_parts' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'Refusing to finish: ticket_parts still has a write policy.';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.rma_ticket_part_add(uuid, uuid, integer, numeric, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rma_ticket_part_remove(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: signed-in users cannot call the ticket part functions.';
  END IF;

  IF has_function_privilege('anon', 'public.rma_ticket_part_add(uuid, uuid, integer, numeric, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_ticket_part_remove(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: an anonymous caller can call a ticket part function.';
  END IF;
END
$do$;
