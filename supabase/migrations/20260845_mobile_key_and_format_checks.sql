-- BUG-085: the customer phone book is damaged, and the duplicate check was
-- looking for the wrong thing.
--
-- ── What a look at the 14 "duplicates" actually turned up ────────────────────
--
-- Six of the seven pairs were not duplicates at all. Two are branch locations
-- (Mega Top Albostan / Almansoura, Dream Group 6 October / Mall Technology),
-- two are the USD-currency twin of an existing account (Micro Laps / Micro Laps
-- USD, Emak / Emak USD), one is a pair of the owner's own test records, and one
-- was two unrelated companies whose mobile is the single character `+`.
--
-- Sharing a number is normal here, which is why this stays a report and never a
-- unique index. What is NOT normal is the state of the numbers themselves:
--
--   470  customers had a mobile value (418 of 888 have none)
--   186  of those could not be dialled as an Egyptian mobile — 40%
--    28  had simply lost their leading zero, 27 of them to a `+`:
--         `01091768465` was stored as `+1091768465`
--
-- The 28 were repaired on 2026-09-13 before this migration. That reading is not
-- a guess: `+1 091…` is invalid as a North American number too, because NANP
-- area codes never begin with 0 or 1, so there is no other thing it could be.
-- Well-formed local numbers went 276 → 304; not-dialable went 186 → 158.
--
-- ── Two checks disagreeing about the same question ──────────────────────────
--
-- The front end compares the LAST NINE DIGITS (src/lib/customerDuplicates.js),
-- so `+20 100 123 4567` and `0100 123 4567` meet. The database check compared
-- trimmed strings, so it missed five records the app would catch, and flagged
-- two companies whose "number" contains no digits at all.
--
-- One definition now, in both places. Repairing the 28 immediately proved the
-- point: the check went from 14 to 16 because two pairs that were previously
-- spelled differently became visibly the same number.

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'rma_data_integrity_issues') THEN
    RAISE EXCEPTION 'Refusing to apply: rma_data_integrity_issues does not exist.';
  END IF;
END
$do$;

-- ═══ The shared definition ═══════════════════════════════════════════════════

-- The SQL twin of mobileKey() in src/lib/customerDuplicates.js. Keep the two in
-- step: if one changes its mind about what makes two numbers the same, the
-- screen and the report start disagreeing about who is a duplicate.
--
-- Nine digits because an Egyptian mobile is 01X XXXX XXX — ten locally, twelve
-- with the country code — and the last nine are identical in every spelling.
CREATE OR REPLACE FUNCTION public.rma_mobile_key(p_mobile text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE WHEN length(d) > 9 THEN right(d, 9) ELSE d END
    FROM (SELECT regexp_replace(coalesce(p_mobile, ''), '\D', '', 'g') AS d) t;
$fn$;

COMMENT ON FUNCTION public.rma_mobile_key(text) IS
  'Comparison key for a phone number: digits only, last nine where there are more. Empty string when there is nothing to compare. Mirrors mobileKey() in src/lib/customerDuplicates.js — change both or neither. (BUG-085.)';

-- Is this dialable as an Egyptian mobile? 01[0125] + 8 digits locally, or the
-- same with a 20 country code. Deliberately narrow: a landline or a foreign
-- number is not wrong to hold, it is just not this.
CREATE OR REPLACE FUNCTION public.rma_is_egyptian_mobile(p_mobile text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT d ~ '^01[0125][0-9]{8}$' OR d ~ '^201[0125][0-9]{8}$'
    FROM (SELECT regexp_replace(coalesce(p_mobile, ''), '\D', '', 'g') AS d) t;
$fn$;

REVOKE ALL ON FUNCTION public.rma_mobile_key(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rma_is_egyptian_mobile(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_mobile_key(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rma_is_egyptian_mobile(text) TO authenticated;

-- ═══ Self-test: the key must agree with the front end ════════════════════════

DO $do$
DECLARE v_local text := public.rma_mobile_key('0100 123 4567');
BEGIN
  IF public.rma_mobile_key('+20 100 123 4567') <> v_local
     OR public.rma_mobile_key('00201001234567') <> v_local
     OR public.rma_mobile_key('(0100)-123-4567') <> v_local THEN
    RAISE EXCEPTION 'Refusing to apply: rma_mobile_key does not treat the same number written four ways as one.';
  END IF;
  IF public.rma_mobile_key('+') <> '' OR public.rma_mobile_key(NULL) <> '' THEN
    RAISE EXCEPTION 'Refusing to apply: rma_mobile_key must return an empty key when there are no digits.';
  END IF;
  IF public.rma_mobile_key('01001234567') = public.rma_mobile_key('01001234568') THEN
    RAISE EXCEPTION 'Refusing to apply: rma_mobile_key conflates two different numbers.';
  END IF;
  IF NOT public.rma_is_egyptian_mobile('01091768465')
     OR NOT public.rma_is_egyptian_mobile('+201091768465')
     OR public.rma_is_egyptian_mobile('+1091768465')
     OR public.rma_is_egyptian_mobile('0223456789') THEN
    RAISE EXCEPTION 'Refusing to apply: rma_is_egyptian_mobile does not agree with the Egyptian numbering plan.';
  END IF;
END
$do$;
