-- ═══════════════════════════════════════════════════════════════════════════
--  Rename pipeline stage "New Deal" → "New Deals" (plural, data fix)
--
--  The stage id ('new_lead') is unchanged — only the display name is updated.
--  Idempotent: uses a CASE so re-running is harmless.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.pipelines
SET stages = (
  SELECT jsonb_agg(
    CASE
      WHEN s->>'id' = 'new_lead' AND s->>'name' = 'New Deal'
        THEN jsonb_set(s, '{name}', '"New Deals"')
      ELSE s
    END
    ORDER BY (s->>'order')::int
  )
  FROM jsonb_array_elements(stages) AS s
)
WHERE name IN ('Sales Pipeline', 'B2B Dealer Pipeline')
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(stages) AS s
    WHERE s->>'id' = 'new_lead' AND s->>'name' = 'New Deal'
  );

-- VERIFICATION:
-- SELECT name, s->>'id', s->>'name' FROM pipelines, jsonb_array_elements(stages) s WHERE s->>'id' = 'new_lead';
