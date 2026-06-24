-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 3 — rename B2B Dealer Pipeline's "New Lead" stage to "New Deal"
--
--  Pure data update, not a schema change — deals.stage stores the stage id
--  ('new_lead'), not its display name, so renaming the label here doesn't
--  touch any deal row. Matches the original migration's own note: "Renaming
--  a stage later is a data UPDATE, not a schema change — low cost to adjust."
-- ═══════════════════════════════════════════════════════════════════════════


UPDATE public.pipelines
SET stages = (
  SELECT jsonb_agg(
    CASE WHEN stage->>'id' = 'new_lead' THEN jsonb_set(stage, '{name}', '"New Deal"') ELSE stage END
    ORDER BY (stage->>'order')::int
  )
  FROM jsonb_array_elements(stages) AS stage
)
WHERE name = 'B2B Dealer Pipeline';


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT jsonb_pretty(stages) FROM pipelines WHERE name = 'B2B Dealer Pipeline';
-- Expected: the 'new_lead' stage's "name" is now "New Deal"
