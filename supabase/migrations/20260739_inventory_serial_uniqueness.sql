-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 7.6 §4 — Serial-number uniqueness (A4) — DEFERRED
--
--  Split out from 20260738 because this has a live-data dependency the
--  other fixes don't: applying this migration failed on first attempt
--  (2026-07-01) with "Key (serial_number)=(1) is duplicated" — production
--  already has non-closed inventory_units rows sharing a serial number.
--
--  DO NOT APPLY until the duplicate(s) are resolved. Run this read-only
--  diagnostic first:
--
--    SELECT serial_number, COUNT(*) AS dup_count,
--           array_agg(id) AS unit_ids, array_agg(status) AS statuses
--    FROM public.inventory_units
--    WHERE serial_number IS NOT NULL
--      AND serial_number <> ''
--      AND status <> 'closed'
--    GROUP BY serial_number
--    HAVING COUNT(*) > 1
--    ORDER BY dup_count DESC;
--
--  For each duplicate group, either correct the serial_number on the
--  incorrect row(s), or set it to NULL/'' if the real serial isn't known,
--  or transition the stale row to status = 'closed' if it no longer
--  represents a live unit. Once the diagnostic returns zero rows, this
--  migration will apply cleanly.
--
--  Excludes NULL and '' (repair-ticket units without a captured serial
--  share both — inventory.ts createUnitsFromTicket) and 'closed' units
--  (historical/terminal — may legitimately repeat a serial that later
--  comes back through a new ticket).
--
--  receive_stock (Sprint 8) and receive_vendor_invoice (Sprint 9) will add
--  friendly per-serial duplicate errors when those RPCs are written — this
--  migration only adds the enforcement mechanism.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS inv_units_serial_unique_idx
  ON public.inventory_units (serial_number)
  WHERE serial_number IS NOT NULL
    AND serial_number <> ''
    AND status <> 'closed';
