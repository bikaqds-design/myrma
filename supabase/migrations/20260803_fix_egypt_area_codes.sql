-- 20260803_fix_egypt_area_codes.sql
--
-- Correct the Egyptian landline area codes seeded in 20260799.
--
-- ── Why this matters more than it looks ──────────────────────────────────────
--
-- These rows are not reference trivia. useContactValidation blocks a NEW record
-- whose landline fails validation, and validateLandline resolves the area code
-- against this table. A wrong row therefore does not produce a cosmetic label —
-- it refuses to let staff save a real customer, at the counter, with no way
-- forward except to invent a number.
--
-- 20260799 seeded 26 rows from memory and said so in a comment. Checked against
-- two independent published sources, three of them were wrong:
--
--   * 62 and 64 were swapped. 62 is Suez and 64 is Ismailia, not the reverse.
--   * 68 and 69 were swapped. 68 is North Sinai (El Arish) and 69 is South
--     Sinai (El Tor, Sharm El Sheikh).
--   * 15, the 10th of Ramadan industrial city, was missing entirely. For a B2B
--     business in Egypt that is the most expensive omission on the list: it is
--     one of the country's largest industrial zones, so its landlines belong to
--     exactly the kind of customer this system exists to serve.
--
-- ── On 015 being a mobile prefix too ─────────────────────────────────────────
--
-- 015 is both the 10th of Ramadan landline code and the We mobile prefix. That
-- is not a conflict here: validateMobile matches against countries.mobile_prefixes
-- and validateLandline against this table, and the two never consult each
-- other. The numbers differ in length anyway — 015 + 7 subscriber digits for a
-- landline against 11 digits in total for a mobile.

BEGIN;

-- ═══ 1. The two swaps ════════════════════════════════════════════════════════
-- Plain UPDATEs rather than a swap dance: name carries no unique constraint,
-- so the two statements cannot collide with each other.

UPDATE public.country_area_codes
   SET name = 'Suez'
 WHERE country_code = 'EG' AND area_code = '62';

UPDATE public.country_area_codes
   SET name = 'Ismailia'
 WHERE country_code = 'EG' AND area_code = '64';

UPDATE public.country_area_codes
   SET name = 'North Sinai (El Arish)'
 WHERE country_code = 'EG' AND area_code = '68';

UPDATE public.country_area_codes
   SET name = 'South Sinai (El Tor / Sharm El Sheikh)'
 WHERE country_code = 'EG' AND area_code = '69';

-- ═══ 2. The missing city ═════════════════════════════════════════════════════

INSERT INTO public.country_area_codes (country_code, area_code, name, digits)
VALUES ('EG', '15', '10th of Ramadan City', 7)
ON CONFLICT (country_code, area_code) DO UPDATE
   SET name = EXCLUDED.name, digits = EXCLUDED.digits;

COMMIT;

-- ═══ Verification ════════════════════════════════════════════════════════════
-- Run this after the migration. Every row must report PASS.

SELECT
  CASE WHEN name = 'Suez'                                   THEN 'PASS' ELSE 'FAIL' END AS result,
  '62 is Suez' AS what, name AS actual
  FROM public.country_area_codes WHERE country_code='EG' AND area_code='62'
UNION ALL
SELECT
  CASE WHEN name = 'Ismailia'                               THEN 'PASS' ELSE 'FAIL' END,
  '64 is Ismailia', name
  FROM public.country_area_codes WHERE country_code='EG' AND area_code='64'
UNION ALL
SELECT
  CASE WHEN name LIKE 'North Sinai%'                        THEN 'PASS' ELSE 'FAIL' END,
  '68 is North Sinai', name
  FROM public.country_area_codes WHERE country_code='EG' AND area_code='68'
UNION ALL
SELECT
  CASE WHEN name LIKE 'South Sinai%'                        THEN 'PASS' ELSE 'FAIL' END,
  '69 is South Sinai', name
  FROM public.country_area_codes WHERE country_code='EG' AND area_code='69'
UNION ALL
SELECT
  CASE WHEN digits = 7                                      THEN 'PASS' ELSE 'FAIL' END,
  '15 is 10th of Ramadan, 7 digits', name
  FROM public.country_area_codes WHERE country_code='EG' AND area_code='15'
UNION ALL
SELECT
  CASE WHEN count(*) = 27                                   THEN 'PASS' ELSE 'FAIL' END,
  '27 Egyptian area codes in total', count(*)::text
  FROM public.country_area_codes WHERE country_code='EG'
UNION ALL
-- Cairo/Giza/Qalyubia is the only area taking eight subscriber digits.
SELECT
  CASE WHEN count(*) = 1                                    THEN 'PASS' ELSE 'FAIL' END,
  'exactly one 8-digit area (Cairo/Giza)', count(*)::text
  FROM public.country_area_codes WHERE country_code='EG' AND digits = 8;
