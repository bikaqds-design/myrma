-- Close the last anonymous write hole: notification_logs.
--
-- 20260784 locked down the public write tables and dropped four policy names
-- on notification_logs — notif_logs_staff_read, notif_logs_manager_update,
-- notification_logs_all, allow_all. It missed two, because 20260602 created
-- them with *quoted* identifiers under different names:
--
--   "service_insert_notif_logs"  FOR INSERT WITH CHECK (true)
--   "service_update_notif_logs"  FOR UPDATE USING (true)
--
-- Neither carries a TO clause, so both apply to anon as well as authenticated.
-- The insert one is live and exploitable: posting
--   {"event_type":"...","recipient":"..."}
-- to /rest/v1/notification_logs with nothing but the anon key creates a row.
-- Verified against this database, which is why the DELETE at the bottom of
-- this file exists.
--
-- The update one is latent rather than reachable — Postgres also applies
-- SELECT policies to an UPDATE ... WHERE, and anon has no SELECT policy here,
-- so the WHERE matches nothing. It is removed anyway; a policy that is only
-- safe by accident of a second policy is not safe.
--
-- notification_queue carries the identical mistake from the same migration:
--   "service_update_notif_queue"  FOR UPDATE USING (true)
--
-- All three were written on the premise that the edge functions need a policy
-- in order to insert. They do not. The service role bypasses RLS entirely, so
-- these policies never granted the worker anything it did not already have —
-- they only ever widened the door for anon and for every signed-in role.
--
-- Dropping them does not affect notification delivery.

DROP POLICY IF EXISTS "service_insert_notif_logs"  ON public.notification_logs;
DROP POLICY IF EXISTS "service_update_notif_logs"  ON public.notification_logs;
DROP POLICY IF EXISTS "service_update_notif_queue" ON public.notification_queue;

-- Also drop the unquoted spellings, in case either form exists live. Policy
-- names are identifiers: "service_insert_notif_logs" and
-- service_insert_notif_logs fold to the same name, but 20260784 taught the
-- lesson that assuming which spelling is live is how the first fix missed.
DROP POLICY IF EXISTS service_insert_notif_logs  ON public.notification_logs;
DROP POLICY IF EXISTS service_update_notif_logs  ON public.notification_logs;
DROP POLICY IF EXISTS service_update_notif_queue ON public.notification_queue;

-- The staff read and manager update policies from 20260784 stay as they are:
--   notif_logs_staff_read      SELECT TO authenticated  USING (rma_is_staff())
--   notif_logs_manager_update  UPDATE TO authenticated  USING (manager_or_above)
-- With the two above gone, notification_logs has no INSERT or DELETE policy at
-- all, which is correct: only the service role writes or prunes these.

-- Remove the rows this audit created while proving the hole was real: one by
-- hand, one by scripts/probe-anon-access.mjs --deep. Both are sentinel-valued
-- and match nothing the application writes.
DELETE FROM public.notification_logs
 WHERE event_type IN ('zz-probe', 'zz-anon-probe')
   AND recipient  IN ('zz-probe', 'zz-anon-probe');

-- ─── Verification ────────────────────────────────────────────────────────────
-- Expect zero rows — no policy on either table may be open to anon:
--
--   SELECT tablename, policyname, cmd, roles, qual, with_check
--     FROM pg_policies
--    WHERE schemaname = 'public'
--      AND tablename IN ('notification_logs','notification_queue')
--      AND (roles = '{public}' OR 'anon' = ANY(roles))
--      AND (qual = 'true' OR with_check = 'true');
--
-- And from a shell with the anon key and no session:
--
--   node scripts/probe-anon-access.mjs        # expect 49 refused, exit 0
