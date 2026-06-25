-- ════════════════════════════════════════════════════════════════════════════
--  SEED: 10 test users + 30 test deals for pipeline analytics testing
--
--  Run in Supabase SQL Editor while logged in as admin/super_admin.
--  Safe to re-run (ON CONFLICT DO NOTHING + title-based duplicate guard).
--
--  Users: no auth accounts are created — these are user_roles rows only,
--  which is enough for the pipeline's "Assign Rep" dropdown and the
--  Graph/Pivot "Salesperson" grouping. The assigned_rep column in deals
--  is plain text (email), not a uuid FK.
--
--  Deals: distributed across 6 months (Feb–Jul 2026) and all 5 active
--  stages plus Won/Lost, intentionally varied so every Graph/Pivot/Activity
--  view shows interesting data.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Test users ─────────────────────────────────────────────────────────────

INSERT INTO public.user_roles (user_email, role, status) VALUES
  ('ahmed.hassan@test.com',  'sales_rep',   'active'),
  ('sara.mostafa@test.com',  'sales_rep',   'active'),
  ('omar.khalil@test.com',   'sales_rep',   'active'),
  ('layla.ibrahim@test.com', 'manager',     'active'),
  ('karim.nasser@test.com',  'manager',     'active'),
  ('nour.ali@test.com',      'technician',  'active'),
  ('hana.sayed@test.com',    'technician',  'active'),
  ('rami.farouk@test.com',   'viewer',      'active'),
  ('dina.adel@test.com',     'admin',       'active'),
  ('youssef.nagy@test.com',  'super_admin', 'active')
ON CONFLICT (user_email) DO NOTHING;


-- ── 2. 30 test deals ─────────────────────────────────────────────────────────
--
--  Stage IDs (from pipelines JSONB — must match what's in the pipelines row):
--    new_lead | contacted | needs_assessment | quote_sent | negotiation | won | lost
--
--  Stages named "new_lead" shows as "New Deal" in the UI (renamed in
--  migration 20260704 — name change only, id unchanged).

WITH
  pipeline AS (
    SELECT id AS pid
    FROM   public.pipelines
    WHERE  name IN ('Sales Pipeline', 'B2B Dealer Pipeline')
    LIMIT  1
  ),
  custs AS (
    -- cycle through whatever customers already exist (FK required)
    SELECT id, (row_number() OVER ())::int AS n
    FROM   public.customers
    LIMIT  10
  ),
  cust_count AS (SELECT COUNT(*)::int AS cnt FROM custs),
  seed (seq, title, stage, value_egp, prob, rep, status,
        lost_reason, months_ago, days_offset) AS (
    VALUES
    --  ── New Deal stage (6 deals, various reps, recent) ──────────────────
    ( 1, 'Al Noor Electronics — Bulk Device Order',      'new_lead', 120000, 10, 'ahmed.hassan@test.com',  'open',  NULL,                          0, 5),
    ( 2, 'Gulf Tech Trading — Quarterly Supply',         'new_lead',  55000, 10, 'sara.mostafa@test.com',  'open',  NULL,                          1, 3),
    ( 3, 'Delta Systems — Server Room Equipment',        'new_lead',  88000, 10, 'omar.khalil@test.com',   'open',  NULL,                          0,12),
    ( 4, 'Horizon IT Solutions — Laptop Fleet',          'new_lead',  42000, 10, 'layla.ibrahim@test.com', 'open',  NULL,                          1,18),
    ( 5, 'Cairo Digital — POS Terminal Rollout',         'new_lead',  67000, 10, 'karim.nasser@test.com',  'open',  NULL,                          2, 7),
    ( 6, 'Nile Retail Group — Warehouse Scanners',       'new_lead',  31000, 10, 'ahmed.hassan@test.com',  'open',  NULL,                          2,22),
    --  ── Contacted stage (6 deals) ────────────────────────────────────────
    ( 7, 'Star Medical — Device Maintenance Contract',   'contacted', 145000, 20, 'sara.mostafa@test.com',  'open',  NULL,                          1, 8),
    ( 8, 'Blue Ocean Shipping — Rugged Tablets',         'contacted',  76000, 20, 'omar.khalil@test.com',   'open',  NULL,                          2,14),
    ( 9, 'Phoenix Auto Group — Fleet Diagnostics',       'contacted',  39000, 20, 'ahmed.hassan@test.com',  'open',  NULL,                          3, 2),
    (10, 'Summit Construction — Site Devices',           'contacted',  93000, 20, 'layla.ibrahim@test.com', 'open',  NULL,                          3,19),
    (11, 'Green Valley Pharma — Label Printers',         'contacted',  28000, 20, 'karim.nasser@test.com',  'open',  NULL,                          4, 6),
    (12, 'Apex Security — CCTV Upgrade',                 'contacted',  62000, 20, 'sara.mostafa@test.com',  'open',  NULL,                          4,25),
    --  ── Needs Assessment stage (6 deals) ─────────────────────────────────
    (13, 'Royal Hotel Chain — Hospitality Tech',         'needs_assessment', 210000, 40, 'omar.khalil@test.com',   'open', NULL,                   2, 9),
    (14, 'Eagle Logistics — Warehouse Management',       'needs_assessment',  88000, 40, 'ahmed.hassan@test.com',  'open', NULL,                   3,11),
    (15, 'Metro Bank — Branch Hardware Refresh',         'needs_assessment', 175000, 40, 'layla.ibrahim@test.com', 'open', NULL,                   3,28),
    (16, 'Sunrise Manufacturing — ERP Terminals',        'needs_assessment',  54000, 40, 'karim.nasser@test.com',  'open', NULL,                   4, 4),
    (17, 'Coral Real Estate — Smart Office Setup',       'needs_assessment',  98000, 40, 'sara.mostafa@test.com',  'open', NULL,                   4,16),
    (18, 'Diamond Foods — Cold Chain Tracking',          'needs_assessment',  43000, 40, 'omar.khalil@test.com',   'open', NULL,                   5, 1),
    --  ── Quote Sent stage (5 deals) ───────────────────────────────────────
    (19, 'North Africa Trade — Annual Devices',          'quote_sent', 132000, 60, 'ahmed.hassan@test.com',  'open',  NULL,                        3,13),
    (20, 'Falcon Telecom — Call Centre Headsets',        'quote_sent',  48000, 60, 'layla.ibrahim@test.com', 'open',  NULL,                        4,20),
    (21, 'Palm Group — Point of Sale System',            'quote_sent',  77000, 60, 'karim.nasser@test.com',  'open',  NULL,                        4,27),
    (22, 'Sahara Energy — Field Inspection Tablets',     'quote_sent', 165000, 60, 'sara.mostafa@test.com',  'open',  NULL,                        5,10),
    (23, 'Crescent Schools — E-Learning Kit',            'quote_sent',  56000, 60, 'omar.khalil@test.com',   'open',  NULL,                        5,21),
    --  ── Negotiation stage (3 deals) ──────────────────────────────────────
    (24, 'Atlas Corp — Full IT Overhaul',                'negotiation', 340000, 75, 'layla.ibrahim@test.com', 'open',  NULL,                        4,15),
    (25, 'Prime Retail — 50-Branch Expansion',           'negotiation', 195000, 75, 'karim.nasser@test.com',  'open',  NULL,                        5,17),
    (26, 'Zenith Healthcare — Medical Devices',          'negotiation', 128000, 75, 'ahmed.hassan@test.com',  'open',  NULL,                        5,26),
    --  ── Won deals (5 deals) ──────────────────────────────────────────────
    (27, 'Pyramid Tech — Q1 Framework Deal',             'won',         95000, 100, 'sara.mostafa@test.com', 'won',   NULL,                         5, 8),
    (28, 'Oasis Investments — Smart Building',           'won',        220000, 100, 'omar.khalil@test.com',  'won',   NULL,                         4,22),
    (29, 'Nile Electronics — Retail Chain Kit',          'won',         73000, 100, 'ahmed.hassan@test.com', 'won',   NULL,                         3,30),
    --  ── Lost deals (2 deals) ─────────────────────────────────────────────
    (30, 'Desert Wind Trading — Bulk Handsets',          'lost',        48000,   0, 'layla.ibrahim@test.com','lost',  'Price not competitive',       5,29),
    (31, 'Coast Line Imports — POS Terminals',           'lost',        61000,   0, 'karim.nasser@test.com', 'lost',  'Chose a local competitor',    4,24)
  )
INSERT INTO public.deals (
  title, customer_id, pipeline_id, stage,
  value, probability, expected_close_date,
  assigned_rep, status, won_at, lost_at, lost_reason,
  created_at, created_by, product_lines
)
SELECT
  s.title,
  -- cycle customers: customer 1 → deal 1, customer 2 → deal 2, …, wraps around
  (SELECT id FROM custs WHERE n = ((s.seq - 1) % (SELECT cnt FROM cust_count) + 1)),
  (SELECT pid FROM pipeline),
  s.stage,
  s.value_egp,
  s.prob,
  -- expected close date: 60 days after deal creation
  (now() - ((s.months_ago * 30 + s.days_offset) * interval '1 day') + interval '60 days')::date,
  s.rep,
  s.status,
  CASE WHEN s.status = 'won'
       THEN now() - ((s.months_ago * 30 + s.days_offset - 14) * interval '1 day')
       ELSE NULL END,
  CASE WHEN s.status = 'lost'
       THEN now() - ((s.months_ago * 30 + s.days_offset - 10) * interval '1 day')
       ELSE NULL END,
  s.lost_reason,
  now() - ((s.months_ago * 30 + s.days_offset) * interval '1 day'),
  'bika.qds@gmail.com',
  '[]'::jsonb
FROM seed s
WHERE (SELECT pid FROM pipeline) IS NOT NULL
  AND (SELECT cnt FROM cust_count) > 0
  -- skip duplicates (safe to re-run)
  AND NOT EXISTS (
    SELECT 1 FROM public.deals d
    WHERE d.title = s.title
      AND d.pipeline_id = (SELECT pid FROM pipeline)
  );
