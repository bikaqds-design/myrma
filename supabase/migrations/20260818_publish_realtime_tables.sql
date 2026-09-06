-- Put the seven subscribed tables into the Realtime publication.
-- (Audit finding BUG-007.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- The app opens ten postgres_changes subscriptions across ten screens. The
-- publication they all depend on is empty:
--
--   SELECT pubname, (SELECT count(*) FROM pg_publication_rel r
--                     WHERE r.prpubid = p.oid) AS tables
--     FROM pg_publication p;
--   -> supabase_realtime | 0
--
-- Postgres only writes a change to the logical replication stream if the table
-- belongs to a publication, so Realtime never sees a single row event. Every
-- `.subscribe()` in the app succeeds — the channel joins, the callback is
-- registered, no error is raised anywhere — and then no callback ever fires.
-- This is the quiet failure mode: nothing looks broken, the lists simply go
-- stale until something else refetches them. TanStack Query's staleTime is what
-- has been carrying these screens (60s on the dashboard, 2 min on inventory
-- stats), so the symptom reads as "slow to update", not "realtime is off".
--
-- ── Which tables, and why not more ───────────────────────────────────────────
--
-- Exactly the tables the client subscribes to, enumerated from the source
-- rather than guessed:
--
--   notifications     App.jsx                      INSERT
--   activities        ActivityChatter, CommentPanel, DealCommentPanel  * (filtered)
--   customers         Customers/index.jsx          *
--   rma_tickets       Dashboard, Inventory, RMATickets  INSERT/UPDATE/DELETE, *
--   inventory_units   Inventory/index.jsx          *
--   leads             Leads/index.jsx              *
--   products          Products/index.jsx           *
--
-- Deliberately not `FOR ALL TABLES`. The publication is a standing decision
-- about which of the 62 public tables stream their contents out of the
-- database; widening it to everything would put payments, vendor_payments,
-- credit_notes and the rest of the financial ledger on the wire for any
-- subscriber whose RLS policy happens to admit them, to serve subscriptions
-- that do not exist. Adding a table here should stay a deliberate act, taken
-- when a screen actually needs it.
--
-- ── RLS still applies, which was checked and not assumed ─────────────────────
--
-- Realtime evaluates each table's SELECT policy per subscriber before
-- forwarding a row, in a context equivalent to:
--
--   SET LOCAL role = 'authenticated';
--   SET LOCAL request.jwt.claims = '{"email": "...", "role": "authenticated"}';
--
-- All seven policies resolve through rma_user_role() / rma_is_staff() /
-- rma_current_user_email(), which are SECURITY DEFINER and read
-- auth.jwt() ->> 'email' — so they work in that context. Probed live against
-- production data before this migration was written, everything rolled back:
--
--   viewer  -> rma_tickets visible rows: 13          PASS
--   orphan  -> rma_tickets visible rows: 0           PASS   (authenticated, no user_roles row)
--   orphan  -> customers   visible rows: 0           PASS
--   rep     -> foreign activities visible: 0         PASS   (sales_rep scoping holds)
--   rep     -> foreign leads      visible: 0         PASS
--
-- So publishing these tables grants no subscriber anything they could not
-- already read through PostgREST. `authenticated` already holds SELECT on all
-- seven; the policies, not the grants, are what scope them.
--
-- ── The one genuine exposure: DELETE ─────────────────────────────────────────
--
-- Per Supabase's documentation, quoted rather than paraphrased:
--
--   "RLS policies are not applied to DELETE statements, because there is no way
--    for Postgres to verify that a user has access to a deleted record. When RLS
--    is enabled and replica identity is set to full on a table, the old record
--    contains only the primary key(s)."
--
-- Measured rather than taken on faith, by running a DELETE record through
-- realtime.apply_rls() — the function Realtime itself calls to decide who sees
-- a row — with two subscriptions registered, one staff and one unassigned:
--
--   DELETE on rma_tickets -> visible to 2 of 2 subscribers
--     staff  delivered: t
--     orphan delivered: t
--     old_record: {"id": "e837a77d-3c45-411c-98c9-aec35509c727"}
--
-- The same harness run with an INSERT delivered to 1 of 2 — staff yes, orphan
-- no — so RLS is demonstrably applied on INSERT and demonstrably skipped on
-- DELETE. That is the documented behaviour, now confirmed on this database.
--
-- What that leaks here is a primary key and nothing else — a bare UUID, with no
-- customer name, no amount, no status, as the old_record above shows. Scope of
-- the audience: 8 auth accounts,
-- 7 of which are staff who can already read these tables in full. The eighth
-- (ahmed@qdsegypt.com, an auth user with no user_roles row) would learn that
-- some row disappeared, without learning which row or anything about it.
-- Accepted rather than mitigated — the alternative is not subscribing to DELETE
-- at all, which would break the dashboard's list pruning for no real gain.
--
-- ── Replica identity stays DEFAULT ───────────────────────────────────────────
--
-- The obvious instinct is REPLICA IDENTITY FULL so DELETE payloads carry the
-- old row. It would be pure cost here, for two independent reasons:
--
--   1. The quote above: with RLS enabled, FULL still yields only the primary
--      key. There is no way around that while RLS is on, so FULL buys nothing.
--   2. Nothing needs it. Exactly one handler in the codebase reads `old`
--      (Dashboard.jsx:453) and it uses `row.id` only, which DEFAULT provides.
--      Grepped across src/**: no other subscription touches payload.old.
--
-- FULL would add WAL volume for every update and delete on seven busy tables
-- and change no observable behaviour. All seven already have a primary key, so
-- DEFAULT is a valid identity for publishing deletes.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
DECLARE
  v_tables   constant text[] := ARRAY[
    'activities', 'customers', 'inventory_units', 'leads',
    'notifications', 'products', 'rma_tickets'
  ];
  v_missing  text[] := ARRAY[]::text[];
  v_no_pk    text[] := ARRAY[]::text[];
  v_no_rls   text[] := ARRAY[]::text[];
  v_t        text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE EXCEPTION
      'Refusing to apply: the supabase_realtime publication does not exist. Nothing has been changed.';
  END IF;

  FOREACH v_t IN ARRAY v_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = v_t AND c.relkind = 'r'
    ) THEN
      v_missing := v_missing || v_t;
      CONTINUE;
    END IF;

    -- Publishing DELETE without a row identity makes Postgres reject the DELETE
    -- itself, so this check protects writes, not just replication.
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = v_t AND i.indisprimary
    ) THEN
      v_no_pk := v_no_pk || v_t;
    END IF;

    -- Publishing a table with RLS off would stream every row to every
    -- subscriber. Refuse rather than do that quietly.
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = v_t AND c.relrowsecurity
    ) THEN
      v_no_rls := v_no_rls || v_t;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'Refusing to apply: these tables do not exist: %. Nothing has been changed.',
      array_to_string(v_missing, ', ');
  END IF;
  IF array_length(v_no_pk, 1) > 0 THEN
    RAISE EXCEPTION 'Refusing to apply: these tables have no primary key, so publishing DELETE would make Postgres reject deletes on them: %. Nothing has been changed.',
      array_to_string(v_no_pk, ', ');
  END IF;
  IF array_length(v_no_rls, 1) > 0 THEN
    RAISE EXCEPTION 'Refusing to apply: RLS is not enabled on %, so publishing would stream every row to every subscriber. Nothing has been changed.',
      array_to_string(v_no_rls, ', ');
  END IF;
END
$do$;

-- ═══ Add the tables ══════════════════════════════════════════════════════════
-- ALTER PUBLICATION has no IF NOT EXISTS, and re-adding a member raises
-- 42710. Adding one at a time and swallowing only that specific error keeps
-- this migration re-runnable without hiding anything else.

DO $do$
DECLARE
  v_tables constant text[] := ARRAY[
    'activities', 'customers', 'inventory_units', 'leads',
    'notifications', 'products', 'rma_tickets'
  ];
  v_t     text;
  v_added text[] := ARRAY[]::text[];
  v_kept  text[] := ARRAY[]::text[];
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_t);
      v_added := v_added || v_t;
    EXCEPTION
      WHEN duplicate_object THEN
        v_kept := v_kept || v_t;
    END;
  END LOOP;

  RAISE NOTICE 'Realtime publication: added %, already present %',
    coalesce(array_to_string(v_added, ', '), 'none'),
    coalesce(array_to_string(v_kept,  ', '), 'none');
END
$do$;

-- ═══ Guard: all seven are published, and nothing else crept in ═══════════════

DO $do$
DECLARE
  v_expected constant text[] := ARRAY[
    'activities', 'customers', 'inventory_units', 'leads',
    'notifications', 'products', 'rma_tickets'
  ];
  v_actual   text[];
  v_extra    text[];
  v_absent   text[];
BEGIN
  SELECT coalesce(array_agg(tablename ORDER BY tablename), ARRAY[]::text[])
    INTO v_actual
    FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public';

  SELECT coalesce(array_agg(t), ARRAY[]::text[]) INTO v_absent
    FROM unnest(v_expected) t WHERE t <> ALL (v_actual);
  SELECT coalesce(array_agg(t), ARRAY[]::text[]) INTO v_extra
    FROM unnest(v_actual) t WHERE t <> ALL (v_expected);

  IF array_length(v_absent, 1) > 0 THEN
    RAISE EXCEPTION 'Refusing to finish: these tables are still not published: %.',
      array_to_string(v_absent, ', ');
  END IF;

  -- Not fatal: a later migration may legitimately add one. Say so out loud
  -- rather than letting the publication drift unnoticed.
  IF array_length(v_extra, 1) > 0 THEN
    RAISE WARNING 'The Realtime publication also contains tables this migration did not add: %. Confirm each one is intentional.',
      array_to_string(v_extra, ', ');
  END IF;

  RAISE NOTICE 'All 7 subscribed tables are published. Realtime callbacks should now fire.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260856_verify_realtime_publication.sql, which checks
-- the publication membership and re-proves the per-subscriber RLS scoping.
--
-- In the app: open Customers on two browsers signed in as different staff and
-- edit a record on one. The other list should update without a refresh.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.activities,
--     public.customers, public.inventory_units, public.leads,
--     public.notifications, public.products, public.rma_tickets;
-- which returns the app to silently-stale lists — the state this migration
-- exists to end.
