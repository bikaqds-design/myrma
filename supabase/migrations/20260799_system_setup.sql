-- 20260799_system_setup.sql
-- System Setup — countries, phone number rules, and the installation-wide
-- settings that were scattered or missing.
--
-- ═══ What this is for ════════════════════════════════════════════════════════
--
-- Today `mobile` and `landline` are `text` with a 50-character cap and no
-- format rule of any kind, so "0100" and "call the office" are equally valid.
-- There is no country field anywhere in the schema. This adds the reference
-- data that makes a real rule possible, and the settings that belong beside it.
--
-- ═══ How a phone number is validated ═════════════════════════════════════════
--
-- Per country, because the rules are not universal:
--
--   mobile_prefixes   the national prefixes a mobile may start with
--                     Egypt: 010 011 012 015
--   mobile_digits     total national digits including the prefix
--                     Egypt: 11, e.g. 01012345678
--   has_area_codes    whether landlines carry an area code at all
--   landline_digits   for countries WITHOUT area codes, the national length;
--                     ignored where has_area_codes is true, because the length
--                     then varies by area and lives on the area row
--
-- Countries with area codes get rows in country_area_codes: the code, the place
-- it covers, and how many subscriber digits follow it. Cairo and Giza are
-- area 2 with 8 subscriber digits; most other Egyptian governorates have 7.
-- A country with no area codes simply has no rows here, and the check falls
-- back to landline_digits — which is what "skip it" means in practice.
--
-- ═══ A caution on the seeded data ════════════════════════════════════════════
--
-- The Egyptian governorate codes below are the standard published list, but
-- they change occasionally and I have not verified them against a current
-- source. CHECK THEM before relying on them to reject a customer's number. The
-- table is editable from System Setup precisely so a wrong or missing row is a
-- two-minute correction rather than a migration.
--
-- ═══ Applying ════════════════════════════════════════════════════════════════
-- Paste into the Supabase SQL editor. One transaction.
-- Verify with supabase/manual/20260843_verify_system_setup.sql.

-- ═══ 1. Countries ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.countries (
  code             char(2)     PRIMARY KEY,          -- ISO 3166-1 alpha-2
  name             text        NOT NULL,
  -- The international dialling prefix, stored in + form. '00' is the same
  -- thing spelled for a keypad; storing one canonical form avoids every
  -- comparison having to know about both.
  dial_code        text        NOT NULL,
  -- The country's currency. This is the link the setup screen exposes as
  -- "the country connected to the currency".
  currency_code    char(3)     REFERENCES public.currencies(code) ON DELETE SET NULL,
  -- The prefix dialled before a national number domestically. '0' in Egypt and
  -- most of Europe; empty in Kuwait, the US and much of the Gulf. Stored
  -- because the digit counts below are written the way people in that country
  -- say them, and whether the trunk prefix is part of that count differs:
  -- an Egyptian mobile is "11 digits" counting the 0, a Kuwaiti landline is
  -- "8 digits" with no 0 to count. Assuming one convention silently rejects
  -- every correct number in the other.
  trunk_prefix     text        NOT NULL DEFAULT '0',
  mobile_prefixes  text[]      NOT NULL DEFAULT '{}',
  mobile_digits    smallint    CHECK (mobile_digits BETWEEN 4 AND 15),
  has_area_codes   boolean     NOT NULL DEFAULT false,
  -- Only meaningful when has_area_codes is false.
  landline_digits  smallint    CHECK (landline_digits BETWEEN 4 AND 15),
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.countries IS
  'Countries this installation deals with, and the phone number rules that apply in each. A table rather than a hardcoded list so a rule can be corrected without a deploy.';
COMMENT ON COLUMN public.countries.mobile_digits IS
  'Total national digits INCLUDING the prefix. Egypt is 11: 01x plus eight.';
COMMENT ON COLUMN public.countries.landline_digits IS
  'National landline length for countries with no area codes. Ignored when has_area_codes is true — the length then varies by area and lives on country_area_codes.';

CREATE TABLE IF NOT EXISTS public.country_area_codes (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code  char(2)     NOT NULL REFERENCES public.countries(code) ON DELETE CASCADE,
  -- National form, without the trunk zero: Cairo is '2', dialled as 02.
  area_code     text        NOT NULL,
  name          text        NOT NULL,
  -- Subscriber digits AFTER the area code.
  digits        smallint    NOT NULL CHECK (digits BETWEEN 4 AND 12),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_code, area_code)
);

COMMENT ON TABLE public.country_area_codes IS
  'Landline area codes per country — governorates in Egypt. A country with none simply has no rows, and validation falls back to countries.landline_digits.';

CREATE INDEX IF NOT EXISTS country_area_codes_country_idx
  ON public.country_area_codes (country_code);

-- ═══ 2. Seed ═════════════════════════════════════════════════════════════════
-- Countries matching the currencies already seeded in 20260791, so the
-- currency link has something to point at on day one.

INSERT INTO public.countries
  (code, name, dial_code, currency_code, trunk_prefix, mobile_prefixes, mobile_digits, has_area_codes, landline_digits)
VALUES
  ('EG', 'Egypt',                '+20',  'EGP', '0', ARRAY['010','011','012','015'], 11, true,  NULL),
  -- The US has no trunk prefix: a mobile is ten digits, area code included.
  ('US', 'United States',        '+1',   'USD', '',  ARRAY[]::text[],                10, true,  NULL),
  ('GB', 'United Kingdom',       '+44',  'GBP', '0', ARRAY['07'],                    11, true,  NULL),
  ('AE', 'United Arab Emirates', '+971', 'AED', '0', ARRAY['050','052','054','055','056','058'], 10, true, NULL),
  ('SA', 'Saudi Arabia',         '+966', 'SAR', '0', ARRAY['05'],                    10, true,  NULL),
  ('CN', 'China',                '+86',  'CNY', '0', ARRAY['1'],                     11, true,  NULL),
  ('JP', 'Japan',                '+81',  'JPY', '0', ARRAY['070','080','090'],       11, true,  NULL),
  ('TR', 'Türkiye',              '+90',  'TRY', '0', ARRAY['05'],                    11, true,  NULL),
  ('DE', 'Germany',              '+49',  'EUR', '0', ARRAY['015','016','017'],       11, true,  NULL)
ON CONFLICT (code) DO NOTHING;

-- Egyptian governorate landline codes, in national form (no trunk zero).
-- Cairo and Giza take eight subscriber digits; the rest take seven.
--
-- ►►► VERIFIED, AND THREE ROWS BELOW ARE WRONG. Do not read this block as the
--     correct list. It was seeded from memory; checking it against published
--     sources found 62/64 (Suez/Ismailia) and 68/69 (North/South Sinai) swapped,
--     and 10th of Ramadan (15) missing entirely.
--
--     20260803_fix_egypt_area_codes.sql corrects all four rows and adds the
--     missing one. This block is left as it was applied; the correction lives
--     there. Every row is also editable from System Setup.
INSERT INTO public.country_area_codes (country_code, area_code, name, digits)
VALUES
  ('EG', '2',  'Cairo / Giza / Qalyubia', 8),
  ('EG', '3',  'Alexandria',              7),
  ('EG', '13', 'Qalyubia (Banha)',        7),
  ('EG', '40', 'Gharbia (Tanta)',         7),
  ('EG', '45', 'Beheira (Damanhour)',     7),
  ('EG', '46', 'Matrouh',                 7),
  ('EG', '47', 'Kafr El Sheikh',          7),
  ('EG', '48', 'Menoufia',                7),
  ('EG', '50', 'Dakahlia (Mansoura)',     7),
  ('EG', '55', 'Sharqia (Zagazig)',       7),
  ('EG', '57', 'Damietta',                7),
  ('EG', '62', 'Ismailia',                7),
  ('EG', '64', 'Suez',                    7),
  ('EG', '65', 'Red Sea (Hurghada)',      7),
  ('EG', '66', 'Port Said',               7),
  ('EG', '68', 'South Sinai',             7),
  ('EG', '69', 'North Sinai',             7),
  ('EG', '82', 'Beni Suef',               7),
  ('EG', '84', 'Fayoum',                  7),
  ('EG', '86', 'Minya',                   7),
  ('EG', '88', 'Assiut',                  7),
  ('EG', '92', 'New Valley',              7),
  ('EG', '93', 'Sohag',                   7),
  ('EG', '95', 'Luxor',                   7),
  ('EG', '96', 'Qena',                    7),
  ('EG', '97', 'Aswan',                   7)
ON CONFLICT (country_code, area_code) DO NOTHING;

-- ═══ 3. Row level security ═══════════════════════════════════════════════════
-- Reference data every staff member needs to render or validate a number, and
-- only an administrator should be able to change.

ALTER TABLE public.countries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.country_area_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS countries_staff_read ON public.countries;
CREATE POLICY countries_staff_read ON public.countries
  FOR SELECT TO authenticated USING (public.rma_is_staff());

DROP POLICY IF EXISTS countries_admin_write ON public.countries;
CREATE POLICY countries_admin_write ON public.countries
  FOR ALL TO authenticated
  USING (public.rma_is_admin()) WITH CHECK (public.rma_is_admin());

DROP POLICY IF EXISTS area_codes_staff_read ON public.country_area_codes;
CREATE POLICY area_codes_staff_read ON public.country_area_codes
  FOR SELECT TO authenticated USING (public.rma_is_staff());

DROP POLICY IF EXISTS area_codes_admin_write ON public.country_area_codes;
CREATE POLICY area_codes_admin_write ON public.country_area_codes
  FOR ALL TO authenticated
  USING (public.rma_is_admin()) WITH CHECK (public.rma_is_admin());

REVOKE ALL ON public.countries          FROM PUBLIC, anon;
REVOKE ALL ON public.country_area_codes FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.countries          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.country_area_codes TO authenticated;

-- ═══ 4. Per-record country ═══════════════════════════════════════════════════
-- A system default covers almost everything, but not the overseas vendors this
-- business already has. A NULL means "use the system default" rather than
-- "unknown", so nothing has to be backfilled and no form gains a required field.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS country_code char(2) REFERENCES public.countries(code);
ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS country_code char(2) REFERENCES public.countries(code);

COMMENT ON COLUMN public.customers.country_code IS
  'Overrides the system default country for phone validation. NULL means use the default.';
COMMENT ON COLUMN public.brands.country_code IS
  'Overrides the system default country for phone validation. NULL means use the default.';

-- ═══ 5. Installation settings ════════════════════════════════════════════════
-- All in rma_config, which already has a settings screen pattern and an audit
-- trail. Inserted with ON CONFLICT DO NOTHING so re-applying never overwrites a
-- value someone has since set.

INSERT INTO public.rma_config (config_key, config_value) VALUES
  -- Ties the phone rules to a country, and that country to a currency.
  ('default_country',            '"EG"'::jsonb),

  -- Business identity. These already appear on PDFs but are spread across
  -- branding_settings and the PDF layout, so two documents can disagree.
  ('legal_name',                 '""'::jsonb),
  ('tax_registration_number',    '""'::jsonb),
  ('commercial_registration',    '""'::jsonb),
  ('registered_address',         '""'::jsonb),

  -- Typed on every line today. 14 is Egypt's standard VAT rate; it is a
  -- default for new lines, never applied retroactively.
  ('default_tax_rate',           '14'::jsonb),

  -- Every "this year" filter and the margin reports currently assume the
  -- calendar year and the browser's timezone.
  ('fiscal_year_start_month',    '1'::jsonb),
  ('timezone',                   '"Africa/Cairo"'::jsonb),

  -- Warn on a likely mistyped email domain rather than rejecting it. No
  -- allowlist: rejecting an unlisted domain turns away the customers you least
  -- want to turn away.
  ('email_typo_warnings',        'true'::jsonb)
ON CONFLICT (config_key) DO NOTHING;

-- ═══ Guards ══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_eg_areas integer;
  v_default  text;
BEGIN
  SELECT count(*) INTO v_eg_areas FROM public.country_area_codes WHERE country_code = 'EG';
  IF v_eg_areas = 0 THEN
    RAISE EXCEPTION 'Refusing to apply: no Egyptian area codes were seeded.';
  END IF;

  -- The default country must exist, or every phone field validates against
  -- nothing and silently accepts anything.
  SELECT config_value #>> '{}' INTO v_default
    FROM public.rma_config WHERE config_key = 'default_country';
  IF NOT EXISTS (SELECT 1 FROM public.countries WHERE code = v_default) THEN
    RAISE EXCEPTION
      'Refusing to apply: default_country is %, which is not in the countries table.', v_default;
  END IF;

  -- A country claiming area codes but having none would fall through to
  -- landline_digits, which is NULL for those rows — accepting any length.
  IF EXISTS (
    SELECT 1 FROM public.countries c
     WHERE c.is_active
       AND c.has_area_codes
       AND NOT EXISTS (SELECT 1 FROM public.country_area_codes a WHERE a.country_code = c.code)
       AND c.landline_digits IS NULL
       AND c.code = v_default
  ) THEN
    RAISE EXCEPTION
      'Refusing to apply: the default country claims area codes but has none, so landline validation would accept anything.';
  END IF;

  RAISE NOTICE 'System setup reference data installed. VERIFY the seeded Egyptian area codes before relying on them.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260843_verify_system_setup.sql.
