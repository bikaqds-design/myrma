-- Stop direct client writes to the stock-ledger and provenance columns.
-- (Audit finding BUG-010.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- `inventory_units.staff_update` is `USING/WITH CHECK (rma_is_staff() AND
-- rma_user_role() <> 'viewer')` with no column restriction, so any non-viewer
-- staff account can PATCH any column. The stock model assumes the reservation
-- and costing columns change only via RPCs that also write `stock_moves`.
--
-- Reproduced live on 2026-09-06 as the real technician account, rolled back:
--
--   UPDATE inventory_units
--      SET reserved_by_doc_id = NULL, status = 'available'
--    WHERE id = <a reserved unit>            -> 1 row allowed
--
-- That frees stock a sales order is holding, with no ledger entry. `post_invoice`
-- then refuses to post ("bills N serialized units but only M are reserved"), or
-- the same unit is sold twice. `unit_cost_base` is COGS, so it also feeds margin
-- reporting.
--
-- ── Scope: ledger and provenance only (owner's decision, 2026-09-06) ─────────
--
-- Guarded — nothing in `src/` writes any of these, so this breaks no screen:
--
--   reservation_status, reserved_by_doc_type, reserved_by_doc_id,
--   reserved_at, reserved_by_email      reservation, owned by the RPCs
--   unit_cost_base                      COGS
--   vendor_invoice_id, product_id,
--   serial_number                       identity and provenance
--
-- Deliberately NOT guarded, because live client code writes them directly:
--
--   status         src/api/db/inventory.ts:335, :389, :405
--   warehouse_id   src/api/db/inventory.ts:440
--
-- Those are the legacy direct-mutation paths of BUG-032. Blocking them here
-- would break the RMA resolution flow, manufacturer batch send/close and the
-- warehouse move. They stay open until those four call sites move onto RPCs
-- that write `stock_moves`; this file does not close that gap and does not
-- pretend to. `status` alone cannot un-reserve a unit — the reservation columns
-- are what a sales order actually reads — so the exploit above is closed even
-- with `status` still writable.
--
-- ── Why SECURITY INVOKER, deliberately ───────────────────────────────────────
--
-- The trigger must tell a direct PostgREST write from a call inside a
-- SECURITY DEFINER RPC, and it uses `current_user` to do it: 'authenticated'
-- for the former, 'postgres' for the latter.
--
-- That discriminator ONLY works in a SECURITY INVOKER function. Inside a
-- SECURITY DEFINER one, `current_user` is the function's owner, so the guard
-- would match every call and never fire — which is exactly what happened to the
-- stamping trigger in 20260819 and is why 20260820 exists. The convention in
-- this database is now: guard triggers are INVOKER (`rma_guard_settled_document`,
-- `rma_guard_sales_order_status`, `rma_guard_approval_authority`,
-- `rma_assert_sales_status_transition` all are); stamping triggers are DEFINER
-- and must key off the JWT instead.
--
-- ── No role exemption, on purpose ────────────────────────────────────────────
--
-- Not even an admin may move these columns from a browser. This is not a
-- lockout: the RPCs are SECURITY DEFINER and run as `postgres`, so they pass
-- straight through, and genuine data repair from the SQL editor also runs as
-- `postgres`. What is blocked is the one path that produces silent ledger
-- corruption — a PATCH from a signed-in session.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
DECLARE
  v_cols constant text[] := ARRAY[
    'reservation_status','reserved_by_doc_type','reserved_by_doc_id','reserved_at',
    'reserved_by_email','unit_cost_base','vendor_invoice_id','product_id','serial_number'
  ];
  v_missing text[];
BEGIN
  SELECT coalesce(array_agg(c), ARRAY[]::text[]) INTO v_missing
    FROM unnest(v_cols) c
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = 'public.inventory_units'::regclass
        AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped);

  IF array_length(v_missing,1) > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: these columns do not exist on inventory_units: %. The guard list is stale. Nothing has been changed.',
      array_to_string(v_missing, ', ');
  END IF;
END
$do$;

-- ═══ The guard ═══════════════════════════════════════════════════════════════
-- SECURITY INVOKER on purpose — see the note above.

CREATE OR REPLACE FUNCTION public.rma_guard_inventory_ledger_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  c_guarded constant text[] := ARRAY[
    'reservation_status','reserved_by_doc_type','reserved_by_doc_id','reserved_at',
    'reserved_by_email','unit_cost_base','vendor_invoice_id','product_id','serial_number'
  ];
  v_changed text[];
BEGIN
  -- Server-side callers (RPCs, service role, cron, SQL editor) pass through.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(array_agg(k), ARRAY[]::text[]) INTO v_changed
    FROM unnest(c_guarded) k
   WHERE to_jsonb(OLD) -> k IS DISTINCT FROM to_jsonb(NEW) -> k;

  IF array_length(v_changed, 1) > 0 THEN
    RAISE EXCEPTION
      'Stock ledger columns cannot be changed directly (%). Use the stock RPCs, which record the movement in stock_moves.',
      array_to_string(v_changed, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_inventory_units_guard_ledger ON public.inventory_units;
CREATE TRIGGER trg_inventory_units_guard_ledger
  BEFORE UPDATE ON public.inventory_units
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_inventory_ledger_columns();

-- ═══ Guard: it exists and is INVOKER ═════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_inventory_units_guard_ledger') THEN
    RAISE EXCEPTION 'Refusing to finish: the guard trigger was not created.';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='rma_guard_inventory_ledger_columns') THEN
    RAISE EXCEPTION
      'Refusing to finish: the guard is SECURITY DEFINER, which makes its current_user check always true and silently disables it.';
  END IF;
  RAISE NOTICE 'BUG-010: inventory ledger and provenance columns are now RPC-only from the client.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- supabase/manual/20260859_verify_inventory_ledger_guard.sql
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_inventory_units_guard_ledger ON public.inventory_units;
-- which restores the ability to free reserved stock from a browser.
