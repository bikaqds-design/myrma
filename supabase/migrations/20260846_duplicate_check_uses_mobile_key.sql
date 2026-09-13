-- BUG-085 continued: make the duplicate check ask the same question the app
-- asks, and report the damaged numbers it was silently walking past.
--
-- Two changes to rma_data_integrity_issues():
--
--   5. duplicate_customer_mobile now compares rma_mobile_key() instead of
--      trimmed strings. It therefore stops reporting the two companies whose
--      "mobile" is the single character `+` — no digits, nothing to compare —
--      and starts catching pairs that differ only in spelling.
--   8. malformed_customer_mobile is new: a stored number that cannot be dialled
--      as an Egyptian mobile. 158 of 470, after the 28 repaired on 2026-09-13.
--      Low, because a landline in the mobile field is untidy rather than
--      broken — but it is the field intake searches by, so an undialable number
--      is a customer the counter cannot find.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'rma_mobile_key') THEN
    RAISE EXCEPTION 'Refusing to apply: 20260845 (rma_mobile_key) has not been applied.';
  END IF;
END
$do$;

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
  --    Known cohort: 15 rows, all updated_at = 2026-07-05. See the function
  --    comment for why those are seed data and inventory is unaffected.
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

  -- 3. Reported, not prevented: every one is an active_rma unit, i.e. a
  --    customer handed over an item whose serial was never recorded.
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
  SELECT 'posted_invoice_without_due_date',
         'medium',
         'crm_invoices',
         i.id,
         i.inv_code,
         'invoice is posted but has no due_date, so it can never age or fall overdue'
    FROM public.crm_invoices i
   WHERE i.doc_status = 'posted' AND i.due_date IS NULL

  UNION ALL

  -- 5. Two customers reachable on the same number.
  --
  --    Compared on rma_mobile_key, the same last-nine-digits rule the customer
  --    form and the CSV importer use, so the screen and this report cannot
  --    disagree about who is a duplicate. String comparison missed five records
  --    and flagged two whose "number" holds no digits at all.
  --
  --    Still a report and never a unique index: of the seven pairs found on
  --    2026-09-13, two were branch locations of one company, two were the
  --    USD-currency twin of an existing account, and one was a pair of test
  --    records. Sharing a number is ordinary here.
  SELECT 'duplicate_customer_mobile',
         'medium',
         'customers',
         c.id,
         c.mobile,
         format('%s other customer record(s) are reachable on this number', dup.others)
    FROM public.customers c
    JOIN LATERAL (
      SELECT count(*) AS others
        FROM public.customers c2
       WHERE c2.id <> c.id
         AND public.rma_mobile_key(c2.mobile) = public.rma_mobile_key(c.mobile)
    ) dup ON dup.others > 0
   WHERE public.rma_mobile_key(c.mobile) <> ''

  UNION ALL

  -- 6. The row is not a record of access, it IS the access: a role is resolved
  --    by matching user_email, so whoever registers that address inherits it.
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

  -- 7. An account with no role signs in and is refused everything, which reads
  --    to them as the application being broken.
  SELECT 'account_without_role',
         'low',
         'auth.users',
         u.id,
         u.email,
         'account exists but holds no user_roles row, so every query is refused after sign-in'
    FROM auth.users u
   WHERE u.email IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE lower(ur.user_email) = lower(u.email))

  UNION ALL

  -- 8. A number that cannot be dialled. Low severity and worth having anyway:
  --    this is the field RMA intake searches by, so an unusable number is a
  --    customer the counter cannot find. Includes landlines typed into the
  --    mobile field, which is untidy rather than wrong — hence low.
  SELECT 'malformed_customer_mobile',
         'low',
         'customers',
         c.id,
         c.mobile,
         CASE WHEN public.rma_mobile_key(c.mobile) = ''
              THEN 'mobile contains no digits at all'
              ELSE format('mobile has %s digits and is not an Egyptian mobile number (01[0125] + 8 digits)',
                          length(regexp_replace(c.mobile, '\D', '', 'g'))) END
    FROM public.customers c
   WHERE btrim(coalesce(c.mobile, '')) <> ''
     AND NOT public.rma_is_egyptian_mobile(c.mobile)
$fn$;

REVOKE ALL ON FUNCTION public.rma_data_integrity_issues() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_data_integrity_issues() TO authenticated;

COMMENT ON FUNCTION public.rma_data_integrity_issues() IS
'One row per violated invariant. Known baseline as of 2026-09-13, so a new finding is distinguishable from what is already understood:

 - delivered_without_stock_moves: 15 rows, ALL carrying updated_at = 2026-07-05. One script pass flipped a June seed cohort to "delivered"; every total matches a June invoice, no units were ever reserved and no stock moved, so inventory is correct. A 16th such order, or any without that timestamp, is a real problem.
 - unbacked_amount_paid: 0. Six seeded invoices (INV-2026-00010..15) claimed payments with nothing behind them and were cleared on 2026-09-13; the payments table has never held a row for those customers. Any reappearance here is genuine.
 - role_without_account: 10, all suspended on 2026-09-13 and therefore inert. Rated high only while such a row is active AND administrative.
 - unit_without_serial: 8, all active_rma — a customer handed over an item whose serial was never recorded. Reported, never blocked: a constraint here would refuse real intake.
 - duplicate_customer_mobile: ~16 of 888 real customers, compared on rma_mobile_key (last nine digits), the same rule the app uses. Of the seven pairs examined on 2026-09-13, two were branch locations of one company, two were the USD-currency twin of an existing account, one was a pair of test records. Sharing a number is ordinary; that is why there is no unique index.
 - malformed_customer_mobile: 158 of the 470 customers who have a number. 28 more were repaired on 2026-09-13 (a leading zero lost on import, 27 of them replaced by a "+"). The remainder are landlines in the mobile field, wrong lengths, and two entries holding no digits — they need someone who knows the customer, not a rule.
 - posted_invoice_without_due_date: 3 historical rows. New ones are impossible since the trigger added in 20260843.

Note for anyone extending this: warehouse_stock and inventory_units do NOT reconcile against each other and must not be compared. products.stock_tracking_mode splits the catalogue into 405 serialized products (tracked as units) and 1 bulk product (tracked as a quantity), with zero overlap.';

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE v_dup bigint; v_bad bigint; v_junk bigint;
BEGIN
  SELECT count(*) INTO v_dup  FROM public.rma_data_integrity_issues() WHERE check_name = 'duplicate_customer_mobile';
  SELECT count(*) INTO v_bad  FROM public.rma_data_integrity_issues() WHERE check_name = 'malformed_customer_mobile';
  SELECT count(*) INTO v_junk FROM public.rma_data_integrity_issues()
   WHERE check_name = 'duplicate_customer_mobile' AND public.rma_mobile_key(reference) = '';

  IF v_junk > 0 THEN
    RAISE EXCEPTION 'Refusing to finish: % row(s) with no digits are still reported as duplicates.', v_junk;
  END IF;
  IF v_dup < 1 OR v_bad < 1 THEN
    RAISE EXCEPTION 'Refusing to finish: duplicate=% malformed=%, but both were measured non-zero today. The queries are wrong.', v_dup, v_bad;
  END IF;

  RAISE NOTICE 'BUG-085: % duplicate-by-key, % malformed.', v_dup, v_bad;
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   Re-apply 20260843's definition of rma_data_integrity_issues (seven cases,
--   duplicate compared on btrim). The 28 repaired numbers are listed with their
--   previous values in each customer's `notes`.
