-- Verify 20260785 and answer the one question the anonymous probe cannot.
--
-- Run AFTER applying 20260785_close_anon_notification_writes.sql.
-- Read-only: no writes, no DDL. Safe to run any number of times.
--
-- The Supabase SQL editor shows only the last statement's result, so this is
-- deliberately one SELECT.
--
-- check                          expect
-- ─────────────────────────────  ──────────────────────────────────────────────
-- open anon policies             0  — any row means a WITH CHECK/USING (true)
--                                    policy without a TO clause survives
-- probe rows remaining           0  — the audit's sentinel rows are gone
-- kb_articles total              ?  — informational
-- kb_articles published          =  must equal what /kb shows signed out.
--                                    An anonymous read returns 0 published
--                                    right now; if this says 0 too, the page
--                                    is correct and simply has no content. If
--                                    this is > 0, kb_public_read is broken.

SELECT 'open anon policies on notification tables' AS check, count(*) AS value
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('notification_logs', 'notification_queue')
   AND (roles = '{public}' OR 'anon' = ANY(roles))
   AND (qual = 'true' OR with_check = 'true')

UNION ALL
SELECT 'notification_logs probe rows remaining', count(*)
  FROM notification_logs
 WHERE event_type IN ('zz-probe', 'zz-anon-probe')

UNION ALL
SELECT 'kb_articles total rows', count(*) FROM kb_articles

UNION ALL
SELECT 'kb_articles published', count(*) FROM kb_articles WHERE is_published = true

UNION ALL
SELECT 'any policy on notification_logs allowing INSERT', count(*)
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'notification_logs'
   AND cmd IN ('INSERT', 'ALL');
