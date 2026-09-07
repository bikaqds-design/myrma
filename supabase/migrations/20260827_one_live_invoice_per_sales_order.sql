-- One live invoice per sales order, enforced by the database.
-- (Audit finding BUG-028.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- `salesOrders.convertToInvoice()` guards against re-conversion by SELECTing
-- first and INSERTing second:
--
--   const { data: existingInv } = await supabase.from('crm_invoices')
--     .select('id').eq('so_id', soId).neq('doc_status', 'cancelled').limit(1)
--   if (existingInv?.length) throw new Error('already been converted')
--   … .insert({ so_id: soId, … })
--
-- Nothing holds a lock between those two statements, so two clicks inside one
-- network round-trip — or two people on the same order — both read "no invoice
-- yet" and both insert. The check is a courtesy, not a constraint.
--
-- The consequence is worse than a duplicate row. Both drafts can be posted, and
-- `deliver_units` moves whatever is still reserved: the first post consumes the
-- reservation, the second finds nothing left to deliver **but still bills the
-- customer**. That is a double charge with no stock movement behind it.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- A partial unique index. Cancelled invoices are excluded so an order can be
-- legitimately re-invoiced after its first attempt is cancelled, which is the
-- same rule the application already intended.
--
-- This is the guarantee; the client-side check stays as the friendly error.
-- Indexes do not have race conditions, so a second concurrent insert now fails
-- with 23505 rather than succeeding.
--
-- Existing data was checked first: zero sales orders currently have more than
-- one non-cancelled invoice (27 invoices, 20 linked to an order, 7 cancelled),
-- so nothing has to be repaired before the index can be created.

-- ═══ Guard: no existing violations ═══════════════════════════════════════════

DO $do$
DECLARE
  v_dupes integer;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT so_id FROM public.crm_invoices
     WHERE so_id IS NOT NULL AND doc_status <> 'cancelled'
     GROUP BY so_id HAVING count(*) > 1
  ) d;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: % sales order(s) already have more than one live invoice. Cancel the duplicates first, then re-run. Nothing has been changed.',
      v_dupes;
  END IF;
END
$do$;

-- ═══ The constraint ══════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS crm_invoices_one_live_per_so_idx
  ON public.crm_invoices (so_id)
  WHERE so_id IS NOT NULL AND doc_status <> 'cancelled';

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'crm_invoices_one_live_per_so_idx'
  ) THEN
    RAISE EXCEPTION 'Refusing to finish: the unique index was not created.';
  END IF;
  RAISE NOTICE 'BUG-028: a sales order can no longer carry two live invoices.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Rolled-back probe: insert two draft invoices for one so_id -> the second
-- fails with 23505; cancel the first and insert again -> succeeds.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP INDEX public.crm_invoices_one_live_per_so_idx;
-- which restores the double-billing race.
