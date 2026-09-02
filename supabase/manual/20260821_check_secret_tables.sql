-- Who can read the tables that hold secrets?
--
-- Found while auditing Backup & Restore: src/api/backup.js deliberately selects
-- only non-secret columns from email_settings, because that table holds
-- api_key, smtp_password, smtp_user and webhook_secret. The export redacts
-- them (H-6).
--
-- Three of these tables were missing from scripts/probe-anon-access.mjs
-- entirely — the list was built from the 49 tables in src/api/db/ and never
-- included the four reached through src/api/*.js. The probe now covers 53 and
-- reports no anonymous access to any of them.
--
-- But anonymous is not the question that matters here. None of these three has
-- a policy in any migration, and this project has already found policies that
-- exist live without appearing in the repo. If RLS is off, or a policy grants
-- all authenticated users, then every technician and viewer can read the SMTP
-- password.
--
-- Read-only.

SELECT c.relname                                        AS table_name,
       c.relrowsecurity                                 AS rls_enabled,
       COALESCE(p.n, 0)                                 AS policy_count,
       COALESCE(p.names, '(none)')                      AS policies,
       COALESCE(g.grantees, '(none)')                   AS granted_to,
       CASE
         WHEN NOT c.relrowsecurity AND g.grantees LIKE '%authenticated%'
           THEN 'EXPOSED — RLS off, any signed-in user can read this'
         WHEN c.relrowsecurity AND COALESCE(p.n, 0) = 0
           THEN 'SEALED — RLS on with no policy, only the service role can read'
         WHEN NOT c.relrowsecurity
           THEN 'RLS off, but no authenticated grant'
         ELSE 'RLS on with policies — check the policy text below'
       END                                              AS verdict
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN (
    SELECT polrelid, count(*) AS n, string_agg(polname, ', ' ORDER BY polname) AS names
      FROM pg_policy GROUP BY polrelid
  ) p ON p.polrelid = c.oid
  LEFT JOIN (
    SELECT c2.oid,
           string_agg(DISTINCT rtg.grantee, ', ' ORDER BY rtg.grantee) AS grantees
      FROM information_schema.role_table_grants rtg
      JOIN pg_class c2 ON c2.relname = rtg.table_name
      JOIN pg_namespace n2 ON n2.oid = c2.relnamespace AND n2.nspname = rtg.table_schema
     WHERE rtg.table_schema = 'public'
       AND rtg.grantee IN ('anon', 'authenticated', 'service_role')
       AND rtg.privilege_type = 'SELECT'
     GROUP BY c2.oid
  ) g ON g.oid = c.oid
 WHERE n.nspname = 'public'
   AND c.relname IN (
     'email_settings', 'branding_settings', 'email_templates',
     'notification_preferences', 'notification_settings', 'webhooks'
   )
 ORDER BY c.relname;

-- webhooks and notification_settings are included because they carry the same
-- shape of risk: webhook target URLs and any auth headers configured with them.
--
-- If any row reads EXPOSED, say so and a migration will follow restricting
-- those tables to rma_is_admin(). Nothing here changes anything.
