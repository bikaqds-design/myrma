-- Close the direct-insert path into the money tables.  (Audit finding BUG-001)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- record_payment() and record_vendor_payment() enforce rma_can_handle_cash()
-- and mint the gapless PAY-/VP- code. apply_payment_to_invoice() and its two
-- siblings check the unapplied balance, that the invoice is posted, and that it
-- belongs to the paying customer.
--
-- None of that was a boundary, because the tables underneath accepted a plain
-- INSERT from anyone rma_is_staff() answers true for — which is every role in
-- the system, viewer included. Measured rather than inferred: a probe running
-- as a live viewer account inserted a row into payments and it was accepted.
--
-- A row created that way carries status 'active', so v_customer_ledger counts
-- it the moment it lands: the customer's Billing tab shows money that was never
-- received and the receivable disappears. Nothing about the fabricated row
-- looks unusual afterwards — it has no payment_code, but neither does a real
-- payment until the RPC assigns one, and nothing reads that column as a check.
--
-- The application tables had the same shape one level down. A manager could
-- insert straight into payment_applications, skipping the balance and
-- customer-match checks, and crm_invoices.amount_paid would never move — the
-- sync trigger recomputes the *payment's* unapplied_amount, not the invoice.
-- So the ledger and the invoice would disagree with nothing to say which is
-- right. Six invoices in the live data already show that exact divergence.
--
-- ── Why this cannot break the RPCs ───────────────────────────────────────────
--
-- Every writer is SECURITY DEFINER and owned by `postgres`, which holds
-- BYPASSRLS, and none of these tables sets FORCE ROW LEVEL SECURITY. Row
-- policies are therefore not consulted inside those functions at all, so taking
-- a client policy away takes nothing away from them. Confirmed against this
-- database before the migration was written:
--
--   SELECT relforcerowsecurity FROM pg_class  WHERE relname = 'payments'  -> false
--   SELECT rolbypassrls        FROM pg_roles  WHERE rolname = 'postgres'  -> true
--
-- The application code agrees: every one of the ten places src/ touches these
-- five tables is a select. Payments are recorded, applied, voided and reversed
-- through the RPCs and nowhere else.
--
-- ── Why admin, rather than nobody ────────────────────────────────────────────
--
-- One legitimate caller does write these tables directly: Backup & Restore,
-- which upserts every table from the browser (src/api/backup.js). It lives
-- behind /control-panel, which only admin and super_admin can open.
--
-- Closing the door completely would mean a restore silently skipping the entire
-- payment ledger — and that is the kind of thing nobody discovers until they
-- are already restoring from a backup. So the policies stay, narrowed to
-- rma_is_admin().
--
-- That is not a segregation-of-duties boundary and does not pretend to be one:
-- an administrator can already delete customers and reassign roles. It is the
-- difference between "any of the seventeen accounts in this system can
-- fabricate a payment" and "the four that could already do anything can".
--
-- ── What is NOT addressed here ───────────────────────────────────────────────
--
-- manager_update_payments / manager_update_vendor_payments still allow an
-- UPDATE by whoever created the row, with no WITH CHECK and no lock on a
-- settled payment. That is BUG-002 and is a separate change: it needs a
-- column-level guard trigger, not a policy edit, and it touches the sales
-- documents too.

-- ═══ payments ════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS staff_insert_payments ON public.payments;

CREATE POLICY admin_insert_payments ON public.payments
  FOR INSERT TO public
  WITH CHECK (public.rma_is_admin());

COMMENT ON POLICY admin_insert_payments ON public.payments IS
  'Restore only. Payments are created by record_payment(), which is SECURITY DEFINER and bypasses RLS, so this policy grants the application nothing. It exists so an administrator can restore a backup.';

-- ═══ vendor_payments ═════════════════════════════════════════════════════════

DROP POLICY IF EXISTS staff_insert_vendor_payments ON public.vendor_payments;

CREATE POLICY admin_insert_vendor_payments ON public.vendor_payments
  FOR INSERT TO public
  WITH CHECK (public.rma_is_admin());

COMMENT ON POLICY admin_insert_vendor_payments ON public.vendor_payments IS
  'Restore only — see admin_insert_payments. record_vendor_payment() is the application''s only writer.';

-- ═══ the three application ledgers ═══════════════════════════════════════════
-- Append-only records of how much of a payment or credit note was set against
-- which invoice. Written by apply_*_to_invoice() and the reversal functions,
-- which also move the invoice's amount_paid in the same transaction. A direct
-- insert writes one half of that pair.

DROP POLICY IF EXISTS manager_insert_payment_applications ON public.payment_applications;

CREATE POLICY admin_insert_payment_applications ON public.payment_applications
  FOR INSERT TO public
  WITH CHECK (public.rma_is_admin());

COMMENT ON POLICY admin_insert_payment_applications ON public.payment_applications IS
  'Restore only. apply_payment_to_invoice() and the reversal functions are the application''s writers; they also update crm_invoices.amount_paid, which a direct insert does not.';

DROP POLICY IF EXISTS manager_insert_cn_applications ON public.credit_note_applications;

CREATE POLICY admin_insert_cn_applications ON public.credit_note_applications
  FOR INSERT TO public
  WITH CHECK (public.rma_is_admin());

COMMENT ON POLICY admin_insert_cn_applications ON public.credit_note_applications IS
  'Restore only — see admin_insert_payment_applications. issue_credit_note() and apply_credit_note_to_invoice() are the writers.';

DROP POLICY IF EXISTS manager_insert_vendor_payment_applications ON public.vendor_payment_applications;

CREATE POLICY admin_insert_vendor_payment_applications ON public.vendor_payment_applications
  FOR INSERT TO public
  WITH CHECK (public.rma_is_admin());

COMMENT ON POLICY admin_insert_vendor_payment_applications ON public.vendor_payment_applications IS
  'Restore only — see admin_insert_payment_applications. apply_vendor_payment_to_invoice() is the writer.';

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- Refuse the whole migration if it has left the money tables in a state the
-- application cannot work in. The Supabase SQL editor runs a script in one
-- implicit transaction, so a RAISE here rolls back everything above it.

DO $do$
DECLARE
  r            record;
  v_tables     text[] := ARRAY[
    'payments', 'vendor_payments', 'payment_applications',
    'credit_note_applications', 'vendor_payment_applications'
  ];
  v_bad        text[] := ARRAY[]::text[];
  v_rpcs       text[] := ARRAY[
    'record_payment', 'record_vendor_payment',
    'apply_payment_to_invoice', 'apply_credit_note_to_invoice',
    'apply_vendor_payment_to_invoice', 'issue_credit_note',
    'void_payment', 'void_vendor_payment', 'void_credit_note',
    'reverse_payment_application', 'reverse_credit_note_application',
    'reverse_vendor_payment_application'
  ];
  v_unreachable text[] := ARRAY[]::text[];
BEGIN
  -- 1. Exactly one INSERT policy per table, and it must be the admin one.
  --    More than one would be OR-ed, and the widest would win — which is how
  --    the hole this migration closes survived two previous passes.
  FOR r IN
    SELECT c.relname AS tbl,
           count(*) FILTER (WHERE p.polcmd IN ('a', '*'))            AS insert_policies,
           count(*) FILTER (WHERE p.polcmd IN ('a', '*')
                              AND pg_get_expr(p.polwithcheck, p.polrelid)
                                  LIKE '%rma_is_admin()%')           AS admin_only
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
     WHERE n.nspname = 'public' AND c.relname = ANY(v_tables)
     GROUP BY c.relname
  LOOP
    IF r.insert_policies <> 1 OR r.admin_only <> 1 THEN
      v_bad := v_bad || format('%s (%s INSERT policy/policies, %s admin-only)',
                               r.tbl, r.insert_policies, r.admin_only);
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: these tables do not have exactly one admin-only INSERT policy afterwards: %. Nothing has been changed.',
      array_to_string(v_bad, '; ');
  END IF;

  -- 2. Every RPC the application calls must still be executable by
  --    `authenticated`, or the payment screens break on the next deploy.
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY(v_rpcs)
  LOOP
    IF NOT has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      v_unreachable := v_unreachable || r.proname;
    END IF;
  END LOOP;

  IF array_length(v_unreachable, 1) > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: the application calls these functions but authenticated can no longer execute them: %. Nothing has been changed.',
      array_to_string(v_unreachable, ', ');
  END IF;

  RAISE NOTICE 'Direct client INSERT on the five money tables is now admin-only; every RPC remains reachable.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260847_verify_payment_write_lockdown.sql. It simulates
-- a viewer and asserts the insert is refused, then simulates an administrator
-- and asserts it is allowed, and rolls both back.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- Should this need undoing, the previous state was:
--
--   DROP POLICY admin_insert_payments ON public.payments;
--   CREATE POLICY staff_insert_payments ON public.payments
--     FOR INSERT TO public WITH CHECK (public.rma_is_staff());
--   -- and the same shape for vendor_payments (rma_is_staff) and for the three
--   -- application tables (manager_insert_*, rma_is_manager_or_above).
--
-- Restoring it re-opens BUG-001; there is no reason to, because nothing in the
-- application inserted through those policies.
