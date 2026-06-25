-- ═══════════════════════════════════════════════════════════════════════════
--  Sync deal values and probabilities — one-time data consistency fix
--
--  Root cause: the old saveLines() path wrote product_lines but did NOT
--  write back the computed sum to deals.value. So any deal where lines were
--  saved before the fix has a stale value column that doesn't match what
--  the UI now derives from product_lines. This migration back-fills it.
--
--  Safe to re-run (idempotent): the UPDATE is a no-op if already correct.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Recalculate value from product_lines ──────────────────────────────────
--
--  For every deal that has at least one product line, set value = SUM(qty × unit_price).
--  Deals with no product lines (empty array or NULL) are untouched — their
--  value is a manually entered number, not derived.

UPDATE public.deals
SET value = (
  SELECT COALESCE(
    SUM((line->>'qty')::numeric * (line->>'unit_price')::numeric),
    0
  )
  FROM jsonb_array_elements(product_lines) AS line
)
WHERE jsonb_array_length(product_lines) > 0;


-- ── 2. Sync probability for terminal statuses ────────────────────────────────
--
--  Won  → probability must be 100 (it's a fact, not an estimate).
--  Lost → probability must be 0.
--  Seed data or deals closed before the probability field was wired to the
--  edit modal may have had stale values.

UPDATE public.deals SET probability = 100 WHERE status = 'won'  AND (probability IS NULL OR probability <> 100);
UPDATE public.deals SET probability = 0   WHERE status = 'lost' AND (probability IS NULL OR probability <> 0);


-- ── VERIFICATION ─────────────────────────────────────────────────────────────
-- Check that no product-line deal has a mismatched value:
--
-- SELECT id, title, value,
--   (SELECT SUM((l->>'qty')::numeric * (l->>'unit_price')::numeric)
--    FROM jsonb_array_elements(product_lines) l) AS lines_sum
-- FROM deals
-- WHERE jsonb_array_length(product_lines) > 0
--   AND value IS DISTINCT FROM (
--     SELECT SUM((l->>'qty')::numeric * (l->>'unit_price')::numeric)
--     FROM jsonb_array_elements(product_lines) l
--   );
-- Expected: 0 rows
