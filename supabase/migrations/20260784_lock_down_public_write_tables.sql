-- Two tables accepted writes from an unauthenticated caller.
--
-- Found by probing the live database during a pre-launch review rather than by
-- reading these files — which matters, because neither table has a policy in
-- any migration, and one of them turned out to have a live policy that exists
-- nowhere in this repo. The migration history is not a complete description of
-- the database, so this file asserts the end state rather than assuming one.
--
-- Verified against production with the anon key and no session:
--
--   kb_articles       INSERT succeeded (only NOT NULL stopped an empty body),
--                     PATCH returned 204, DELETE returned 204.
--                     Full anonymous CRUD.
--   notification_logs INSERT reached a NOT NULL constraint rather than being
--                     refused, and DELETE returned 204 against a table holding
--                     192 rows.
--
-- Every other table in the app — 47 of 49 probed — refused with 42501.
--
-- kb_articles is the serious one. /kb renders KnowledgeBasePublic before any
-- auth check, showing every article with is_published = true. So an anonymous
-- visitor could publish arbitrary content onto a public page on the company's
-- domain, or edit and delete the real articles.
--
-- Nothing was exposed in the event: kb_articles holds 0 rows today. The hole
-- would have opened the moment somebody wrote the first help article.

-- ── kb_articles: public may read what is published, and nothing else ─────────

ALTER TABLE public.kb_articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_public_read      ON public.kb_articles;
DROP POLICY IF EXISTS kb_staff_read_all   ON public.kb_articles;
DROP POLICY IF EXISTS kb_admin_write      ON public.kb_articles;
-- any permissive policy created outside this repo
DROP POLICY IF EXISTS kb_articles_all     ON public.kb_articles;
DROP POLICY IF EXISTS allow_all           ON public.kb_articles;

-- The public tracker and /kb need this, so it is granted to anon deliberately
-- and narrowly: published rows only.
CREATE POLICY kb_public_read ON public.kb_articles
  FOR SELECT USING (is_published = true);

-- Staff see drafts too, so the Control Panel editor can work on them.
CREATE POLICY kb_staff_read_all ON public.kb_articles
  FOR SELECT TO authenticated USING (public.rma_is_staff());

-- Writing is an admin action: the Knowledge Base feature lives in the Control
-- Panel, which is already admin-gated in the app.
CREATE POLICY kb_admin_write ON public.kb_articles
  FOR ALL TO authenticated
  USING (public.rma_is_admin())
  WITH CHECK (public.rma_is_admin());

-- ── notification_logs: staff read, manager retry, no anonymous anything ──────
-- The notification worker and webhook write these through the service role,
-- which bypasses RLS, so none of this affects delivery.

ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notif_logs_staff_read     ON public.notification_logs;
DROP POLICY IF EXISTS notif_logs_manager_update ON public.notification_logs;
DROP POLICY IF EXISTS notification_logs_all     ON public.notification_logs;
DROP POLICY IF EXISTS allow_all                 ON public.notification_logs;

CREATE POLICY notif_logs_staff_read ON public.notification_logs
  FOR SELECT TO authenticated USING (public.rma_is_staff());

-- Retrying a failed notification updates the row; that screen is admin-only.
CREATE POLICY notif_logs_manager_update ON public.notification_logs
  FOR UPDATE TO authenticated
  USING (public.rma_is_manager_or_above())
  WITH CHECK (public.rma_is_manager_or_above());

-- No INSERT or DELETE policy: only the service role writes or prunes these.

-- ─── Verification ────────────────────────────────────────────────────────────
-- Re-run supabase/manual/20260818_probe_anon_access.sql, or from a shell with
-- the anon key and no session:
--
--   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
--     -H "apikey: $ANON" -H 'Content-Type: application/json' \
--     -d '{"title":"x","slug":"x","body":"x"}' \
--     "$URL/rest/v1/kb_articles"          # expect 401, was 201
--
--   curl -s -o /dev/null -w '%{http_code}\n' -X DELETE \
--     -H "apikey: $ANON" "$URL/rest/v1/notification_logs?id=eq.<any uuid>"
--                                          # expect 401, was 204
--
-- And confirm the public page still works: /kb must still list published
-- articles for a signed-out visitor.
