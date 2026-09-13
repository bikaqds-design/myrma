-- BUG-063: the two live-data inconsistencies the integrity check did not cover,
-- plus the one guard that stops a recurrence rather than just counting it.
--
-- ── Measured against production on 2026-09-13, not copied from the report ────
--
--   14  customers share a mobile number with another customer (888 total)
--    8  live inventory_units have a blank serial  ← already checked (20260839)
--    3  posted invoices have no due_date          ← already checked (20260839)
--   10  user_roles rows name an address with no auth.users account (17 total)
--    1  auth user holds no user_roles row
--
-- So two of the four were already visible and two were not. This adds the two.
--
-- ── One of them is not the small inconsistency the finding describes ─────────
--
-- All 10 orphaned user_roles rows were created on 2026-06-24, all on @test.com,
-- all `status = 'active'`, none has ever logged in — and one of them holds
-- `super_admin`, another `admin`.
--
-- A role is resolved by matching `user_roles.user_email` against the signed-in
-- address (src/api/db/users.ts). Nothing links the row to an account; the row
-- simply waits. So each of those rows is a standing grant to whoever first
-- creates an account with that address — and the project still has
-- `disable_signup = false`, confirmed by reading /auth/v1/settings today.
--
-- What stands between that and an administrator account is only that sign-up
-- requires confirming the email, and @test.com is a domain the company does not
-- own. That is a stranger's mail server, not a control.
--
-- This migration deliberately does NOT delete or suspend those rows. They are
-- part of the fixture data whose purge the owner deferred until after launch,
-- and quietly revoking someone's administrator row is not a change to make on
-- another party's behalf. It makes them impossible to miss instead, and the
-- one-line repair is written out at the bottom of this file.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'rma_data_integrity_issues') THEN
    RAISE EXCEPTION 'Refusing to apply: 20260839 (rma_data_integrity_issues) has not been applied.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'user_roles'
                    AND column_name = 'user_email') THEN
    RAISE EXCEPTION 'Refusing to apply: user_roles.user_email does not exist; the join below would be wrong.';
  END IF;
END
$do$;

-- ═══ 1. The check, with three cases added ════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_data_integrity_issues()
RETURNS TABLE (
  check_name text,
  severity   text,
  entity     text,
  entity_id  uuid,
  reference  text,
  detail     text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $fn$
  -- 1. amount_paid must equal the sum of what was applied to the invoice.
  SELECT 'unbacked_amount_paid',
         'high',
         'crm_invoices',
         i.id,
         i.inv_code,
         format('amount_paid is %s but applications total %s', i.amount_paid, applied.total_applied)
    FROM public.crm_invoices i
    JOIN LATERAL (
      SELECT coalesce((SELECT sum(pa.amount_applied) FROM public.payment_applications pa
                        WHERE pa.invoice_id = i.id), 0)
           + coalesce((SELECT sum(ca.amount_applied) FROM public.credit_note_applications ca
                        WHERE ca.invoice_id = i.id), 0) AS total_applied
    ) applied ON true
   WHERE i.doc_status <> 'cancelled'
     AND i.amount_paid IS DISTINCT FROM applied.total_applied

  UNION ALL

  -- 2. A delivered order must have left a trace in stock history.
  SELECT 'delivered_without_stock_moves',
         'medium',
         'sales_orders',
         so.id,
         so.so_code,
         'status is delivered but no stock_moves rows reference this order'
    FROM public.sales_orders so
   WHERE so.status = 'delivered'
     AND NOT EXISTS (SELECT 1 FROM public.stock_moves m
                      WHERE m.doc_type = 'sales_order' AND m.doc_id = so.id)

  UNION ALL

  -- 3. A unit with no serial cannot be traced, matched to an RMA, or counted
  --    reliably against a customer's claim.
  --
  --    Reported, not prevented. Every one of the 8 is an `active_rma` unit: a
  --    customer handed over an item whose serial was never recorded, which is
  --    an ordinary thing to happen at a service counter. A NOT NULL constraint
  --    here would refuse real intake, so this stays a thing someone chases.
  SELECT 'unit_without_serial',
         'low',
         'inventory_units',
         u.id,
         coalesce(u.serial_number, '(null)'),
         'inventory unit has no serial number'
    FROM public.inventory_units u
   WHERE u.serial_number IS NULL OR btrim(u.serial_number) = ''

  UNION ALL

  -- 4. A posted invoice with no due date is never overdue and never ages.
  --    New ones can no longer be created — see the trigger below.
  SELECT 'posted_invoice_without_due_date',
         'medium',
         'crm_invoices',
         i.id,
         i.inv_code,
         'invoice is posted but has no due_date, so it can never age or fall overdue'
    FROM public.crm_invoices i
   WHERE i.doc_status = 'posted' AND i.due_date IS NULL

  UNION ALL

  -- 5. Two customers sharing a mobile number. Not always wrong — a household or
  --    a company switchboard legitimately repeats — which is why this is
  --    reported rather than blocked by a unique index. What it costs when it IS
  --    wrong: the RMA intake search by phone returns two records and whichever
  --    is picked gets the ticket, so one customer's history splits in half.
  SELECT 'duplicate_customer_mobile',
         'medium',
         'customers',
         c.id,
         c.mobile,
         format('mobile %s is also on %s other customer record(s)', btrim(c.mobile), dup.others)
    FROM public.customers c
    JOIN LATERAL (
      SELECT count(*) AS others
        FROM public.customers c2
       WHERE c2.id <> c.id
         AND btrim(coalesce(c2.mobile, '')) = btrim(c.mobile)
    ) dup ON dup.others > 0
   WHERE nullif(btrim(coalesce(c.mobile, '')), '') IS NOT NULL

  UNION ALL

  -- 6. A role row whose address has no account. Harmless-looking, and the
  --    reason this check exists at all: the row is not a record of access, it
  --    IS the access. Whoever registers that address inherits the role on first
  --    sign-in. High when the waiting grant is administrative.
  SELECT 'role_without_account',
         CASE WHEN coalesce(ur.status, 'active') = 'active'
               AND ur.role IN ('admin', 'super_admin') THEN 'high' ELSE 'medium' END,
         'user_roles',
         ur.id,
         ur.user_email,
         format('role %s (%s) is assigned to an address with no account; whoever registers it inherits the role',
                ur.role, coalesce(ur.status, 'active'))
    FROM public.user_roles ur
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(ur.user_email))

  UNION ALL

  -- 7. The mirror image: an account with no role. They can sign in and are then
  --    denied everything, which reads to them as the application being broken.
  SELECT 'account_without_role',
         'low',
         'auth.users',
         u.id,
         u.email,
         'account exists but holds no user_roles row, so every query is refused after sign-in'
    FROM auth.users u
   WHERE u.email IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE lower(ur.user_email) = lower(u.email))
$fn$;

REVOKE ALL ON FUNCTION public.rma_data_integrity_issues() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_data_integrity_issues() TO authenticated;

-- ═══ 2. Stop new invoices from posting without a due date ════════════════════
--
-- Why a default rather than a rejection: the 3 existing rows show the shape of
-- the mistake. Every invoice that carries payment terms has a due date, and
-- every invoice missing a due date also has no terms — the form sets both
-- together or neither, so the gap is a field left blank, not a considered
-- choice. Refusing the insert would block posting on a detail the poster does
-- not think of as a decision; filling it makes the invoice age correctly, and
-- an invoice with no stated terms IS due on receipt.
--
-- Existing rows are untouched. Backfilling three posted invoices would move
-- them into overdue buckets on the AR aging report, and changing what a
-- financial report says is the owner's call, not a migration's.

CREATE OR REPLACE FUNCTION public.rma_fill_invoice_due_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_days integer;
  v_from date;
BEGIN
  IF NEW.doc_status = 'posted' AND NEW.due_date IS NULL THEN
    -- 'Net 30', '30 days net', '30' — take the first run of digits, if any.
    v_days := nullif(substring(coalesce(NEW.payment_terms, '') FROM '([0-9]+)'), '')::integer;
    v_from := coalesce(NEW.posted_at, NEW.created_at, now())::date;
    NEW.due_date := v_from + coalesce(v_days, 0);
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_fill_invoice_due_date() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_crm_invoices_due_date ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_due_date
  BEFORE INSERT OR UPDATE ON public.crm_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_fill_invoice_due_date();

-- ═══ Guard: the new checks must actually find the known rows ═════════════════

DO $do$
DECLARE
  v_dup   bigint;
  v_role  bigint;
  v_admin bigint;
BEGIN
  SELECT count(*) INTO v_dup   FROM public.rma_data_integrity_issues() WHERE check_name = 'duplicate_customer_mobile';
  SELECT count(*) INTO v_role  FROM public.rma_data_integrity_issues() WHERE check_name = 'role_without_account';
  SELECT count(*) INTO v_admin FROM public.rma_data_integrity_issues() WHERE check_name = 'role_without_account' AND severity = 'high';

  IF v_dup < 1 OR v_role < 1 THEN
    RAISE EXCEPTION
      'Refusing to finish: the new checks found % duplicate-mobile and % orphaned-role rows, but 14 and 10 were measured today. The queries are wrong.',
      v_dup, v_role;
  END IF;

  RAISE NOTICE 'BUG-063: % duplicate-mobile, % orphaned-role (% of them administrative).', v_dup, v_role, v_admin;
END
$do$;

-- ─── The repair this file deliberately does not perform ──────────────────────
--
-- Closing the waiting administrator grants, once the owner decides to:
--
--   UPDATE public.user_roles ur
--      SET status = 'suspended',
--          suspended_reason = 'no account; fixture row (BUG-063)',
--          suspended_date = now()
--    WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(ur.user_email));
--
-- Suspension rather than deletion keeps the rows visible for demonstrations and
-- is one UPDATE to undo. Any status other than 'active' denies in both the
-- database (rma_access_is_current) and the app (accessDenialReason), so this
-- closes the path in both places at once.
--
-- Separately, and worth more than the line above: turning off public sign-up in
-- the Supabase dashboard removes the mechanism entirely.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_crm_invoices_due_date ON public.crm_invoices;
--   DROP FUNCTION public.rma_fill_invoice_due_date();
--   -- and re-apply 20260839 to restore the four-case check.
