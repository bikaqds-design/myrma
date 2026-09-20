-- Generate a complete baseline of the public schema.
--
-- Why this exists: 20 of the 49 tables the app uses are created by no migration
-- in this repo — including customers, products, rma_tickets and user_roles. The
-- migrations only ALTER them. The schema exists solely in the live database, so
-- a clean Supabase project cannot be provisioned from this repo and the
-- README's "apply migrations in order" fails at the first ALTER TABLE.
--
-- The normal tool for this is `supabase db dump`, which runs pg_dump in a
-- container. Docker is not installed on this machine, and neither pg_dump nor
-- psql is on PATH, so the schema is reconstructed from the catalogs instead.
--
-- ── How to run ───────────────────────────────────────────────────────────────
--
--   1. Paste this whole file into the Supabase SQL editor and run it.
--   2. The result is ONE row with ONE column, `baseline_sql`.
--   3. Click the cell, copy the whole value, and save it as
--        supabase/migrations/00000000_baseline_schema.sql
--      (or use the editor's "Download CSV" and strip the header/quoting).
--
-- Read-only: it inspects catalogs and returns text. It changes nothing.
--
-- ── What it covers ───────────────────────────────────────────────────────────
--
--   sequences · tables and columns · primary/unique/check constraints ·
--   foreign keys · non-constraint indexes · views (including the
--   security_invoker setting, which 20260778 depends on) · functions
--   (after views: some declare RETURNS SETOF <view>, see the note on the
--   `fns` CTE below) · triggers · RLS enablement · policies · table
--   grants · function EXECUTE grants (see the note on the `fn_grants` CTE
--   below -- CREATE FUNCTION alone does not reproduce these) · comments
--
--   Emitted in dependency order, so the output runs top to bottom on an empty
--   database.
--
-- ── What it does NOT cover — read this before trusting the output ────────────
--
--   * Anything outside schema `public`: the auth, storage and realtime schemas
--     are Supabase's own and are recreated by the platform.
--   * Roles and storage buckets. The bucket is a documented setup
--     step already (README section 4).
--   * Data. Structure only.
--   * Column-level and default privileges.
--
--   Verify before relying on it: the counts at the top of the generated file
--   state how many objects of each kind were emitted. Compare those against
--   the live database rather than assuming.

WITH
-- Only ordinary tables in public, excluding anything an extension owns.
t AS (
  SELECT c.oid, c.relname, c.relrowsecurity, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend d
        WHERE d.objid = c.oid AND d.deptype = 'e'
     )
),

-- 0. Extensions the public schema actually depends on.
--
--    Omitting these was a real defect: five tables default their id to
--    uuid_generate_v4(), so a baseline without uuid-ossp fails on the first of
--    them against a fresh database. Only extensions whose functions appear in a
--    column default are emitted -- listing every installed extension would drag
--    in pg_cron and pg_net, which this schema never calls.
exts AS (
  SELECT string_agg(stmt, E'
' ORDER BY stmt) AS sql, count(*) AS n
    FROM (
      SELECT DISTINCT format('CREATE EXTENSION IF NOT EXISTS %I WITH SCHEMA %I;',
                             e.extname, en.nspname) AS stmt
        FROM pg_extension e
        JOIN pg_namespace en ON en.oid = e.extnamespace
       WHERE e.extname <> 'plpgsql'
         -- pg_depend points FROM the member function TO the extension:
         -- refobjid is the extension, objid the function. Written the other way
         -- round this matches nothing, emits "-- none", and quietly reproduces
         -- the very defect it exists to prevent. Verified against the live
         -- catalog before being trusted.
         AND EXISTS (
           SELECT 1
             FROM pg_depend dep
             JOIN pg_proc pr ON pr.oid = dep.objid
             JOIN pg_attrdef ad ON true
             JOIN pg_class c ON c.oid = ad.adrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE dep.refobjid = e.oid
              AND dep.deptype = 'e'
              AND dep.classid = 'pg_proc'::regclass
              AND n.nspname = 'public'
              AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%' || pr.proname || '(%'
         )
    ) x
),

-- 1. Sequences. Emitted before the tables whose defaults call nextval().
seqs AS (
  SELECT string_agg(
           format('CREATE SEQUENCE IF NOT EXISTS public.%I;', c.relname),
           E'\n' ORDER BY c.relname) AS sql,
         count(*) AS n
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
),

-- 2. Tables with their columns. Constraints come later so that a table never
--    references one that does not exist yet.
cols AS (
  SELECT t.relname,
         string_agg(
           format('  %I %s%s%s',
             a.attname,
             format_type(a.atttypid, a.atttypmod),
             -- Generated columns MUST come before the identity/default branch.
             -- pg_attrdef holds the generation expression for a STORED column
             -- exactly as it holds a default, so emitting it as ' DEFAULT ...'
             -- looks right and is not: Postgres refuses a DEFAULT that
             -- references another column, and the baseline dies on
             -- credit_notes. Seven columns are affected, among them
             -- purchase_orders.total_base, vendor_payments.amount_base and
             -- warehouse_stock.avg_cost_base -- the costing values whose whole
             -- point is that they cannot drift from their inputs.
             CASE
               WHEN a.attgenerated = 's'
                 THEN ' GENERATED ALWAYS AS (' || pg_get_expr(ad.adbin, ad.adrelid) || ') STORED'
               WHEN a.attidentity = 'a' THEN ' GENERATED ALWAYS AS IDENTITY'
               WHEN a.attidentity = 'd' THEN ' GENERATED BY DEFAULT AS IDENTITY'
               ELSE COALESCE(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), '')
             END,
             CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END),
           E',\n' ORDER BY a.attnum) AS body
    FROM t
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef ad ON ad.adrelid = t.oid AND ad.adnum = a.attnum
   GROUP BY t.relname
),
tables AS (
  SELECT string_agg(
           format(E'CREATE TABLE IF NOT EXISTS public.%I (\n%s\n);', relname, body),
           E'\n\n' ORDER BY relname) AS sql,
         count(*) AS n
    FROM cols
),

-- 3. Primary key, unique and check constraints.
cons_local AS (
  SELECT string_agg(
           format('ALTER TABLE public.%I ADD CONSTRAINT %I %s;',
                  t.relname, con.conname, pg_get_constraintdef(con.oid)),
           E'\n' ORDER BY t.relname, con.conname) AS sql,
         count(*) AS n
    FROM t
    JOIN pg_constraint con ON con.conrelid = t.oid
   WHERE con.contype IN ('p', 'u', 'c')
),

-- 4. Foreign keys, after every table and key exists.
cons_fk AS (
  SELECT string_agg(
           format('ALTER TABLE public.%I ADD CONSTRAINT %I %s;',
                  t.relname, con.conname, pg_get_constraintdef(con.oid)),
           E'\n' ORDER BY t.relname, con.conname) AS sql,
         count(*) AS n
    FROM t
    JOIN pg_constraint con ON con.conrelid = t.oid
   WHERE con.contype = 'f'
),

-- 5. Indexes that are not already created by a constraint above.
idx AS (
  SELECT string_agg(pg_get_indexdef(i.indexrelid) || ';',
                    E'\n' ORDER BY ic.relname) AS sql,
         count(*) AS n
    FROM t
    JOIN pg_index i  ON i.indrelid = t.oid
    JOIN pg_class ic ON ic.oid = i.indexrelid
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid
   )
),

-- 6. Functions, including the RLS helpers and the SECURITY DEFINER RPCs the
--    app calls directly. pg_get_functiondef emits CREATE OR REPLACE.
--
--    Emitted AFTER views below (found 2026-09-20 regenerating this baseline
--    against production): a handful of functions declare `RETURNS SETOF
--    <view_name>` — e.g. rma_deals_matching returns SETOF v_deals_list — which
--    makes the view's row type a dependency of the function, not the other way
--    round. With functions first, CREATE FUNCTION fails on "type v_deals_list
--    does not exist" because the view is not created until later. No view here
--    calls a function (verified: every function name checked against the
--    Views block, zero matches), so views-before-functions has no matching
--    hazard in the other direction. If that ever changes, this ordering will
--    need to become two passes instead of one swap.
fns AS (
  SELECT string_agg(pg_get_functiondef(p.oid) || ';', E'\n\n' ORDER BY p.proname) AS sql,
         count(*) AS n
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
),

-- 7. Views, emitted before functions (see the note on 6 above) and in
--    dependency order among themselves, not just alphabetically.
--
--    Found 2026-09-20 regenerating this baseline against production:
--    v_knowledge_documents and v_knowledge_nodes both select FROM
--    v_knowledge_product_placement, which sorts alphabetically AFTER them
--    ("documents"/"nodes" < "product_placement"). Plain `ORDER BY relname`
--    emitted the dependents first and the baseline died with "relation
--    v_knowledge_product_placement does not exist". Two other pairs
--    (v_purchase_documents_list/v_purchase_documents,
--    v_sales_documents_list/v_sales_documents) happen to be alphabetically
--    safe today, which is exactly the kind of luck that stops holding the
--    next time someone names a view — so this orders by real dependency
--    depth, not by hoping names stay alphabetically convenient.
--
--    view_rule/view_deps read the actual dependency from the catalog (a
--    view's `_RETURN` rule depends on every relation its query touches),
--    not from matching view names as text — the same reason 20260792's
--    extension-detection joins pg_depend instead of grepping a function
--    body. view_depth computes each view's longest dependency chain via a
--    recursive CTE: every view starts at depth 0, and each dependency edge
--    proposes dependent-depth = dependency-depth + 1; taking MAX(d) per view
--    after the recursion settles gives a view depth greater than everything
--    it depends on, however many links away. Emitting by (depth, relname)
--    is therefore always safe to run views top-to-bottom, for today's two
--    dependency levels or any depth a future view adds.
view_rule AS (
  SELECT c.oid AS view_oid, c.relname AS view_name, r.oid AS rule_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_rewrite r ON r.ev_class = c.oid AND r.rulename = '_RETURN'
   WHERE n.nspname = 'public' AND c.relkind = 'v'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
),
view_deps AS (
  SELECT vr.view_name AS dependent, c2.relname AS depends_on
    FROM view_rule vr
    JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass
                     AND d.objid = vr.rule_oid
                     AND d.deptype = 'n'
                     AND d.refclassid = 'pg_class'::regclass
    JOIN pg_class c2 ON c2.oid = d.refobjid AND c2.relkind = 'v'
    JOIN pg_namespace n2 ON n2.oid = c2.relnamespace AND n2.nspname = 'public'
   WHERE c2.relname <> vr.view_name
),
view_depth AS (
  SELECT view_name, max(d) AS depth
    FROM (
      WITH RECURSIVE depth(view_name, d) AS (
        SELECT view_name, 0 FROM view_rule
        UNION
        SELECT vd.dependent, dep.d + 1
          FROM view_deps vd
          JOIN depth dep ON dep.view_name = vd.depends_on
      )
      SELECT * FROM depth
    ) x
   GROUP BY view_name
),
views AS (
  SELECT string_agg(
           format('CREATE OR REPLACE VIEW public.%I%s AS%s%s',
                  c.relname,
                  CASE WHEN array_to_string(c.reloptions, ',') LIKE '%security_invoker%'
                       THEN ' WITH (security_invoker = true)' ELSE '' END,
                  E'\n', pg_get_viewdef(c.oid, true)),
           E'\n\n' ORDER BY COALESCE(vdp.depth, 0), c.relname) AS sql,
         count(*) AS n
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN view_depth vdp ON vdp.view_name = c.relname
   WHERE n.nspname = 'public' AND c.relkind = 'v'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
),

-- 8. Triggers, excluding the internal ones that back foreign keys.
trgs AS (
  SELECT string_agg(pg_get_triggerdef(tg.oid) || ';',
                    E'\n' ORDER BY tg.tgname) AS sql,
         count(*) AS n
    FROM t
    JOIN pg_trigger tg ON tg.tgrelid = t.oid
   WHERE NOT tg.tgisinternal
),

-- 9. Row level security enablement.
rls AS (
  SELECT string_agg(
           format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', relname),
           E'\n' ORDER BY relname) AS sql,
         count(*) AS n
    FROM t WHERE relrowsecurity
),

-- 10. Policies, rebuilt from pg_policy. polroles = {0} means PUBLIC, which is
--     exactly the shape that let anon through in Findings 1 and 2 — so it is
--     reproduced faithfully rather than normalised away.
pols AS (
  SELECT string_agg(
           format('CREATE POLICY %I ON public.%I%s FOR %s TO %s%s%s;',
             p.polname,
             t.relname,
             CASE WHEN p.polpermissive THEN '' ELSE ' AS RESTRICTIVE' END,
             CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                           WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                           ELSE 'ALL' END,
             CASE WHEN p.polroles = '{0}'::oid[] THEN 'PUBLIC'
                  ELSE array_to_string(
                         ARRAY(SELECT pg_get_userbyid(r) FROM unnest(p.polroles) r),
                         ', ') END,
             COALESCE(' USING (' || pg_get_expr(p.polqual, p.polrelid) || ')', ''),
             COALESCE(' WITH CHECK (' || pg_get_expr(p.polwithcheck, p.polrelid) || ')', '')),
           E'\n' ORDER BY t.relname, p.polname) AS sql,
         count(*) AS n
    FROM t JOIN pg_policy p ON p.polrelid = t.oid
),

-- 11. Table grants for the Supabase roles. Policies are meaningless without
--     these: a missing grant is what makes most tables answer 42501 rather
--     than consulting a policy at all.
grants AS (
  SELECT string_agg(
           format('GRANT %s ON public.%I TO %I;', g.privs, g.table_name, g.grantee),
           E'\n' ORDER BY g.table_name, g.grantee) AS sql,
         count(*) AS n
    FROM (
      SELECT rtg.table_name,
             rtg.grantee,
             string_agg(DISTINCT rtg.privilege_type, ', ' ORDER BY rtg.privilege_type) AS privs
        FROM information_schema.role_table_grants rtg
       WHERE rtg.table_schema = 'public'
         AND rtg.grantee IN ('anon', 'authenticated', 'service_role')
       GROUP BY rtg.table_name, rtg.grantee
    ) g
),

-- 11a. Function EXECUTE grants -- a real gap found 2026-09-20, alongside the
--      two view/function ordering bugs above, while regenerating this
--      baseline and testing it on a fresh project. Every function's
--      privileges here are locked down per-role: `20260752_lockdown_rpc_
--      execute.sql` REVOKEs PUBLIC/anon and grants only authenticated/
--      service_role on most RPCs; `20260868`/`20260869` then explicitly
--      GRANT two of them back to anon so the integration tier can call them
--      unauthenticated. None of that is a CREATE FUNCTION property --
--      pg_get_functiondef (used by `fns` above) emits only the definition,
--      never the grants -- so a baseline built without this section
--      recreates every function with whatever EXECUTE privilege a fresh
--      Supabase project happens to default new functions to. On
--      mycrm-staging that meant the one function meant to be anon-executable
--      came back denied, while every function actually guarded by an
--      in-body role check (`rma_is_manager_or_above()` and friends) kept
--      refusing anon regardless -- because SECURITY DEFINER bodies enforce
--      authorization themselves, so a missing REVOKE never surfaces as a
--      passing test turning into a failure for THEM, only for the one
--      function with no such guard to mask it.
--
--      Reads pg_proc.proacl via aclexplode() -- the actual stored ACL, the
--      same one already verified column-by-column against production before
--      writing this -- rather than joining information_schema by name,
--      which would need disambiguating overloaded function names (there are
--      none today, but a name-matching join would silently mismatch the
--      moment one is added). Verified on production: every one of its 167
--      functions already has a non-NULL proacl (all explicitly touched by
--      the migrations above), so REVOKE ALL FROM PUBLIC before replaying the
--      exact stored grants is safe to emit unconditionally.
fn_grants AS (
  SELECT string_agg(stmt, E'\n' ORDER BY proname, args, ord) AS sql, count(*) AS n
    FROM (
      SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, 1 AS ord,
             format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC;',
                    p.proname, pg_get_function_identity_arguments(p.oid)) AS stmt
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prokind IN ('f', 'p')
         AND p.proacl IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      UNION ALL
      SELECT p.proname, pg_get_function_identity_arguments(p.oid), 2,
             format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO %I;',
                    p.proname, pg_get_function_identity_arguments(p.oid), r.rolname)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(p.proacl) a
        JOIN pg_roles r ON r.oid = a.grantee
       WHERE n.nspname = 'public'
         AND p.prokind IN ('f', 'p')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
         AND a.privilege_type = 'EXECUTE'
         AND r.rolname IN ('anon', 'authenticated', 'service_role')
    ) x
),

-- 12. Comments. Several encode why a rule exists, which is worth keeping.
cmts AS (
  SELECT string_agg(stmt, E'\n' ORDER BY stmt) AS sql, count(*) AS n
    FROM (
      -- COMMENT ON TABLE is rejected for a view ("is not a table"), so the
      -- keyword follows relkind. Emitting TABLE for both looks harmless and
      -- kills the baseline at the very last section.
      SELECT format('COMMENT ON %s public.%I IS %L;',
                    CASE WHEN c.relkind = 'v' THEN 'VIEW' ELSE 'TABLE' END,
                    c.relname, d.description) AS stmt
        FROM pg_description d
        JOIN pg_class c ON c.oid = d.objoid AND d.objsubid = 0
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
      UNION ALL
      SELECT format('COMMENT ON COLUMN public.%I.%I IS %L;', c.relname, a.attname, d.description)
        FROM pg_description d
        JOIN pg_class c ON c.oid = d.objoid AND d.objsubid > 0
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
       WHERE n.nspname = 'public'
    ) x
)

SELECT
  '-- ============================================================================' || E'\n' ||
  '-- 00000000_baseline_schema.sql' || E'\n' ||
  '--' || E'\n' ||
  '-- Generated from the live database by supabase/manual/GENERATE_baseline_schema.sql' || E'\n' ||
  '-- Generated at: ' || now()::text || E'\n' ||
  '--' || E'\n' ||
  '-- The complete public schema. Twenty of these tables were created by no' || E'\n' ||
  '-- migration in this repo, so before this file existed a clean Supabase' || E'\n' ||
  '-- project could not be provisioned from source at all.' || E'\n' ||
  '--' || E'\n' ||
  '-- ON A FRESH DATABASE: run this file ALONE. Do not then replay the historical' || E'\n' ||
  '-- migrations — this already reflects their end state, and re-running them' || E'\n' ||
  '-- would re-apply ALTERs against a schema that already has them.' || E'\n' ||
  '--' || E'\n' ||
  '-- Objects emitted:' || E'\n' ||
  format('--   %s extensions, %s sequences, %s tables, %s pk/unique/check, %s foreign keys,',
         exts.n, seqs.n, tables.n, cons_local.n, cons_fk.n) || E'\n' ||
  format('--   %s indexes, %s functions, %s views, %s triggers,',
         idx.n, fns.n, views.n, trgs.n) || E'\n' ||
  format('--   %s tables with RLS, %s policies, %s grants, %s function grants, %s comments',
         rls.n, pols.n, grants.n, fn_grants.n, cmts.n) || E'\n' ||
  '--' || E'\n' ||
  '-- Not included: non-public schemas, roles, storage buckets,' || E'\n' ||
  '-- column-level privileges, and data.' || E'\n' ||
  '-- ============================================================================' || E'\n\n' ||

  '-- Functions are emitted alphabetically, and some call others -- rma_can_handle_cash()' || E'
' ||
  '-- calls rma_is_manager_or_above(), which sorts after it. SQL-language bodies are' || E'
' ||
  '-- validated at CREATE time, so that ordering fails. This is the same guard' || E'
' ||
  '-- pg_dump emits, for the same reason.' || E'
' ||
  'SET check_function_bodies = false;' || E'

' ||
  '-- Extensions' || E'
' || 'CREATE SCHEMA IF NOT EXISTS extensions;' || E'
' || COALESCE(exts.sql, '-- none') || E'

' ||
  '-- ── Sequences ───────────────────────────────────────────────────────────────' || E'\n'   || COALESCE(seqs.sql, '-- none')       || E'\n\n' ||
  '-- ── Tables ──────────────────────────────────────────────────────────────────' || E'\n'   || COALESCE(tables.sql, '-- none')     || E'\n\n' ||
  '-- ── Primary keys, unique and check constraints ──────────────────────────────' || E'\n'   || COALESCE(cons_local.sql, '-- none') || E'\n\n' ||
  '-- ── Foreign keys ────────────────────────────────────────────────────────────' || E'\n'   || COALESCE(cons_fk.sql, '-- none')    || E'\n\n' ||
  '-- ── Indexes ─────────────────────────────────────────────────────────────────' || E'\n'   || COALESCE(idx.sql, '-- none')        || E'\n\n' ||
  '-- ── Views ───────────────────────────────────────────────────────────────────' || E'\n'   || COALESCE(views.sql, '-- none')      || E'\n\n' ||
  '-- ── Functions ───────────────────────────────────────────────────────────────' || E'\n'   || COALESCE(fns.sql, '-- none')        || E'\n\n' ||
  '-- ── Triggers ────────────────────────────────────────────────────────────────' || E'\n'   || COALESCE(trgs.sql, '-- none')       || E'\n\n' ||
  '-- ── Row level security ──────────────────────────────────────────────────────' || E'\n'   || COALESCE(rls.sql, '-- none')        || E'\n\n' ||
  '-- ── Policies ────────────────────────────────────────────────────────────────' || E'\n'   || COALESCE(pols.sql, '-- none')       || E'\n\n' ||
  '-- ── Grants ──────────────────────────────────────────────────────────────────' || E'\n'   || COALESCE(grants.sql, '-- none')     || E'\n\n' ||
  '-- ── Function grants ─────────────────────────────────────────────────────────' || E'\n'   || COALESCE(fn_grants.sql, '-- none')  || E'\n\n' ||
  '-- ── Comments ────────────────────────────────────────────────────────────────' || E'\n'   || COALESCE(cmts.sql, '-- none')       || E'\n'
  AS baseline_sql
FROM exts, seqs, tables, cons_local, cons_fk, idx, fns, views, trgs, rls, pols, grants, fn_grants, cmts;
