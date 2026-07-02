-- ═══════════════════════════════════════════════════════════════════════════
--  Manual one-time data cleanup — NOT part of normal deployment history.
--
--  Unblocks 20260739_inventory_serial_uniqueness.sql, which failed to apply
--  on first attempt (2026-07-01): production has 8 non-closed inventory_units
--  rows sharing a serial_number with a sibling row — 4x '1', 2x '2', 2x 'd'.
--
--  All 8 are status = 'active_rma' (mid-repair-ticket units, never part of
--  the sellable company_stock pool the sales funnel reserves against) — so
--  this has zero effect on any live order. Single-character values are
--  placeholder entries from when no real serial was captured at ticket
--  intake, not genuine duplicate device serials — confirmed with the user
--  before running (2026-07-01).
--
--  Sets serial_number = NULL on exactly these 8 rows, by id (not by matching
--  serial_number again, to avoid touching any other row that might
--  coincidentally share one of these placeholder values by the time this
--  runs). Run once in the Supabase SQL Editor, then re-apply 20260739.
--
--  Do NOT include this in an automated migration pipeline.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.inventory_units
SET serial_number = NULL
WHERE id IN (
  -- serial_number = '1' (4 rows)
  '0868663d-8ce1-483f-9e23-1b8214291232',
  'c27b70dd-02ae-4d3e-8e26-84aecfbf0518',
  '58dc6659-4cfb-4276-9c43-37b302d164d0',
  'e002f106-8b8a-4ecf-b9e5-10e6e9ee22ca',
  -- serial_number = '2' (2 rows)
  '0de57faf-49c4-4d34-a107-224ec4836fcb',
  '8b69d5c6-f285-433d-9ad1-6cede320393f',
  -- serial_number = 'd' (2 rows)
  '90da1cd4-94bb-46e5-9def-5ef550240eaf',
  '20ffa8a3-fd1e-4d1a-820b-4548a0f2f248'
);

-- Verify zero duplicates remain before re-applying 20260739:
--
--   SELECT serial_number, COUNT(*) AS dup_count
--   FROM public.inventory_units
--   WHERE serial_number IS NOT NULL
--     AND serial_number <> ''
--     AND status <> 'closed'
--   GROUP BY serial_number
--   HAVING COUNT(*) > 1;
