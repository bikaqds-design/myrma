-- Parts used on a ticket go back into stock whenever their record is deleted,
-- including when the whole ticket is deleted. (Owner decision 2026-09-17,
-- follow-up to BUG-030.)
--
-- ── What was true ────────────────────────────────────────────────────────────
--
-- 20260871 made rma_ticket_part_remove return a part's quantity to stock. But
-- ticket_parts.ticket_id is ON DELETE CASCADE, so deleting a ticket removed
-- its parts records and left the stock consumed — the parts were accounted for
-- nowhere. The owner chose: deleting a ticket returns its parts.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- An AFTER DELETE row trigger on ticket_parts returns OLD.quantity to OLD.part_id.
-- It fires however the row goes — rma_ticket_part_remove, or the cascade from a
-- ticket delete — so there is one restock rule instead of one per path.
--
-- rma_ticket_part_remove therefore no longer restocks itself; it would count
-- the quantity twice.
--
-- The trigger writes parts directly rather than through adjust_part_quantity:
-- adding stock back can never go negative, and adjust_part_quantity's staff
-- check would refuse a delete made without a user session (the SQL editor, the
-- planned data reset) and block it. Who may delete is already decided upstream:
-- clients cannot delete ticket_parts at all (20260871), and only admins can
-- delete a ticket (admin_delete policy on rma_tickets).
--
-- Not affected: TRUNCATE fires no row triggers; a part cannot be deleted while
-- ticket_parts rows reference it (ON DELETE RESTRICT); backup restore upserts
-- and never deletes.

DO $do$
BEGIN
  IF to_regprocedure('public.rma_ticket_part_remove(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: 20260871 (rma_ticket_part_remove) is not applied.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ticket_parts'::regclass AND contype = 'f'
       AND confrelid = 'public.rma_tickets'::regclass AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'Refusing to apply: ticket_parts no longer cascades from rma_tickets; re-check the design.';
  END IF;
END
$do$;

-- ═══ The trigger ═════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_ticket_parts_return_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  UPDATE public.parts p
     SET quantity     = p.quantity + OLD.quantity,
         updated_date = now()
   WHERE p.id = OLD.part_id;
  RETURN OLD;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_ticket_parts_return_stock() FROM PUBLIC;
DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.rma_ticket_parts_return_stock() FROM anon, authenticated';
END
$do$;

DROP TRIGGER IF EXISTS trg_ticket_parts_return_stock ON public.ticket_parts;
CREATE TRIGGER trg_ticket_parts_return_stock
  AFTER DELETE ON public.ticket_parts
  FOR EACH ROW EXECUTE FUNCTION public.rma_ticket_parts_return_stock();

-- ═══ Remove: the trigger now restocks ════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_ticket_part_remove(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  IF NOT COALESCE(public.rma_is_admin(), false) THEN
    RAISE EXCEPTION 'Not authorized to remove parts from a ticket' USING ERRCODE = 'P0001';
  END IF;

  -- trg_ticket_parts_return_stock returns the row's quantity to its part.
  DELETE FROM public.ticket_parts tp WHERE tp.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket part % does not exist', p_id USING ERRCODE = 'P0001';
  END IF;
END;
$fn$;

-- ═══ Guards ══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_ticket_parts_return_stock'
       AND tgrelid = 'public.ticket_parts'::regclass AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Refusing to finish: the ticket_parts trigger was not created.';
  END IF;
  IF pg_get_functiondef('public.rma_ticket_part_remove(uuid)'::regprocedure) ~ 'adjust_part_quantity' THEN
    RAISE EXCEPTION 'Refusing to finish: rma_ticket_part_remove still restocks, so removals would count twice.';
  END IF;
  IF has_function_privilege('authenticated', 'public.rma_ticket_parts_return_stock()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_ticket_parts_return_stock()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a client role can execute the restock trigger function.';
  END IF;
END
$do$;
