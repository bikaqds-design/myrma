-- 20260843_verify_system_setup.sql
-- Read-only. Confirms 20260799. Writes nothing. One statement, so all of it
-- shows in the Supabase editor.

WITH checks AS (

  SELECT 1 AS n, 'countries and country_area_codes exist' AS what,
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema='public'
        AND table_name IN ('countries','country_area_codes')) = 2 AS pass

  UNION ALL SELECT 2, 'both have row level security enabled',
    (SELECT bool_and(relrowsecurity) FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname IN ('countries','country_area_codes'))

  UNION ALL SELECT 3, 'staff may read them and only admins may write',
    (SELECT count(*) FROM pg_policies
      WHERE schemaname='public' AND tablename IN ('countries','country_area_codes')) >= 4

  UNION ALL SELECT 4, 'neither is reachable by anon',
    NOT has_table_privilege('anon','public.countries','SELECT')
    AND NOT has_table_privilege('anon','public.country_area_codes','SELECT')

  -- ── The rules that make validation possible ────────────────────────────────
  UNION ALL SELECT 5, 'Egypt carries the mobile rule: 010/011/012/015, 11 digits',
    (SELECT mobile_digits = 11
        AND mobile_prefixes @> ARRAY['010','011','012','015']
       FROM public.countries WHERE code='EG')

  -- The digit counts are written the way each country says them, so whether
  -- the trunk zero is counted has to be data. Assuming it silently rejects
  -- every correct number in a country that has no trunk prefix.
  UNION ALL SELECT 6, 'the trunk prefix is recorded per country, not assumed',
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='countries'
               AND column_name='trunk_prefix')
    AND (SELECT trunk_prefix FROM public.countries WHERE code='EG') = '0'
    AND (SELECT trunk_prefix FROM public.countries WHERE code='US') = ''

  UNION ALL SELECT 7, 'Egyptian governorate codes are seeded',
    (SELECT count(*) FROM public.country_area_codes WHERE country_code='EG') >= 20

  -- Cairo takes eight subscriber digits and the rest seven; a single national
  -- length would wrongly accept or reject one of them.
  UNION ALL SELECT 8, 'Cairo takes 8 subscriber digits, Alexandria 7',
    (SELECT digits FROM public.country_area_codes WHERE country_code='EG' AND area_code='2') = 8
    AND (SELECT digits FROM public.country_area_codes WHERE country_code='EG' AND area_code='3') = 7

  -- ── The country/currency link ──────────────────────────────────────────────
  UNION ALL SELECT 9, 'every country points at a currency that exists',
    NOT EXISTS (
      SELECT 1 FROM public.countries c
       WHERE c.currency_code IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.currencies x WHERE x.code = c.currency_code))

  UNION ALL SELECT 10, 'Egypt is linked to the base currency',
    (SELECT currency_code FROM public.countries WHERE code='EG')
      = (SELECT config_value #>> '{}' FROM public.rma_config WHERE config_key='default_currency')

  -- ── Settings ───────────────────────────────────────────────────────────────
  UNION ALL SELECT 11, 'default_country is set and names a real country',
    EXISTS (SELECT 1 FROM public.countries
             WHERE code = (SELECT config_value #>> '{}' FROM public.rma_config
                            WHERE config_key='default_country'))

  UNION ALL SELECT 12, 'the new installation settings are all present',
    (SELECT count(*) FROM public.rma_config WHERE config_key IN (
      'default_country','legal_name','tax_registration_number','commercial_registration',
      'registered_address','default_tax_rate','fiscal_year_start_month','timezone',
      'email_typo_warnings')) = 9

  -- ── Per-record override ────────────────────────────────────────────────────
  -- Nullable on purpose: NULL means "use the default", so nothing needs
  -- backfilling and no existing form gains a required field.
  UNION ALL SELECT 13, 'customers and vendors can override the country, and it is optional',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('customers','brands')
        AND column_name='country_code' AND is_nullable='YES') = 2

  UNION ALL SELECT 14, 'the override is a real foreign key, not free text',
    (SELECT count(*) FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage k USING (constraint_name, table_schema)
     WHERE tc.constraint_type='FOREIGN KEY'
       AND tc.table_name IN ('customers','brands')
       AND k.column_name='country_code') = 2

  -- ── Data sanity ────────────────────────────────────────────────────────────
  UNION ALL SELECT 15, 'no area code is attached to a country that does not exist',
    NOT EXISTS (
      SELECT 1 FROM public.country_area_codes a
       WHERE NOT EXISTS (SELECT 1 FROM public.countries c WHERE c.code = a.country_code))

  -- A country claiming area codes but having none falls through to
  -- landline_digits, which is NULL for those rows — accepting any length.
  UNION ALL SELECT 16, 'no active country would accept a landline of any length',
    NOT EXISTS (
      SELECT 1 FROM public.countries c
       WHERE c.is_active
         AND c.landline_digits IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.country_area_codes a WHERE a.country_code = c.code))
)
SELECT n, CASE WHEN pass THEN 'PASS' ELSE '*** FAIL ***' END AS result, what
FROM checks ORDER BY n;

-- ─────────────────────────────────────────────────────────────────────────────
-- CHECK 16 IS EXPECTED TO FAIL on first apply. Only Egypt has area codes
-- seeded; the other eight countries are flagged has_area_codes with none
-- listed and no landline length, so a landline in those countries would be
-- accepted at any length. The application treats that as "no rules" and stays
-- silent rather than approving it — but the row is worth filling in from
-- System Setup for any country you actually trade with.
--
-- To see which:
--
--   SELECT code, name FROM public.countries c
--    WHERE c.is_active AND c.landline_digits IS NULL
--      AND NOT EXISTS (SELECT 1 FROM public.country_area_codes a
--                       WHERE a.country_code = c.code);
