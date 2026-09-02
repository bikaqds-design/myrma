-- How big is the baseline going to be?
--
-- Run this BEFORE GENERATE_baseline_schema.sql. That script returns the whole
-- schema in a single text cell, and if the result is very large the editor may
-- be awkward to copy from. This says what to expect, and confirms the object
-- counts are plausible before anyone trusts the output.
--
-- Read-only.

SELECT 'sequences' AS object_kind, count(*) AS n, NULL::bigint AS approx_bytes
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'S'
UNION ALL
SELECT 'tables', count(*), NULL
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
UNION ALL
SELECT 'views', count(*), sum(length(pg_get_viewdef(c.oid, true)))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'v'
UNION ALL
SELECT 'functions', count(*), sum(length(pg_get_functiondef(p.oid)))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
UNION ALL
SELECT 'policies', count(*), NULL FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
UNION ALL
SELECT 'triggers (non-internal)', count(*), NULL
  FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND NOT tg.tgisinternal
UNION ALL
SELECT 'indexes', count(*), NULL
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
UNION ALL
-- Functions dominate the output, so this is the number that matters.
SELECT 'ESTIMATED TOTAL KB', NULL,
       (COALESCE((SELECT sum(length(pg_get_functiondef(p.oid)))
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
                     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')), 0)
      + COALESCE((SELECT sum(length(pg_get_viewdef(c.oid, true)))
                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relkind = 'v'), 0)
      + 40000) / 1024;
