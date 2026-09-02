-- ============================================================================
-- 00000001_baseline_reference_data.sql
--
-- The reference data a fresh database cannot run without.
--
-- 00000000_baseline_schema.sql creates the structure and nothing else. On an
-- empty database that leaves currencies, countries, country_area_codes and
-- rma_config with no rows, and the application cannot function that way:
--
--   * every sales and purchase document carries a currency, so an empty
--     currencies table blocks the first invoice;
--   * rma_config holds the base currency and the system country, which the
--     costing engine and every phone field read on load;
--   * country_area_codes gates landline validation. With no rows, a NEW
--     customer record carrying a landline is refused outright -- which is the
--     exact failure 20260803 was written to fix, reintroduced by an empty
--     table.
--
-- Configuration and reference data only. No customers, products, tickets or
-- documents: that is what a backup export is for.
--
-- NOT included: rma_config.appearance_settings. It is UI theming and holds an
-- embedded base64 logo -- 88KB of one deployment's branding, which a fresh
-- database does not need and the app supplies defaults for.
--
-- Run AFTER 00000000_baseline_schema.sql. Every statement is
-- ON CONFLICT DO NOTHING, so re-running it changes nothing.
--
-- Generated from the live database on 2026-09-01.
-- ============================================================================

BEGIN;

-- Currencies
INSERT INTO public.currencies (code, name, symbol, decimals, is_active) VALUES ('AED','UAE Dirham','د.إ',2,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.currencies (code, name, symbol, decimals, is_active) VALUES ('CNY','Chinese Yuan','¥',2,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.currencies (code, name, symbol, decimals, is_active) VALUES ('EGP','Egyptian Pound','E£',2,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.currencies (code, name, symbol, decimals, is_active) VALUES ('EUR','Euro','€',2,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.currencies (code, name, symbol, decimals, is_active) VALUES ('GBP','Pound Sterling','£',2,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.currencies (code, name, symbol, decimals, is_active) VALUES ('JPY','Japanese Yen','¥',0,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.currencies (code, name, symbol, decimals, is_active) VALUES ('SAR','Saudi Riyal','ر.س',2,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.currencies (code, name, symbol, decimals, is_active) VALUES ('TRY','Turkish Lira','₺',2,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.currencies (code, name, symbol, decimals, is_active) VALUES ('USD','US Dollar','$',2,'t') ON CONFLICT (code) DO NOTHING;

-- Countries
INSERT INTO public.countries (code, name, dial_code, currency_code, trunk_prefix, mobile_prefixes, mobile_digits, has_area_codes, landline_digits, is_active) VALUES ('AE','United Arab Emirates','+971','AED','0','{050,052,054,055,056,058}',10,'t',NULL,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.countries (code, name, dial_code, currency_code, trunk_prefix, mobile_prefixes, mobile_digits, has_area_codes, landline_digits, is_active) VALUES ('CN','China','+86','CNY','0','{1}',11,'t',NULL,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.countries (code, name, dial_code, currency_code, trunk_prefix, mobile_prefixes, mobile_digits, has_area_codes, landline_digits, is_active) VALUES ('DE','Germany','+49','EUR','0','{015,016,017}',11,'t',NULL,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.countries (code, name, dial_code, currency_code, trunk_prefix, mobile_prefixes, mobile_digits, has_area_codes, landline_digits, is_active) VALUES ('EG','Egypt','+20','EGP','0','{010,011,012,015}',11,'t',NULL,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.countries (code, name, dial_code, currency_code, trunk_prefix, mobile_prefixes, mobile_digits, has_area_codes, landline_digits, is_active) VALUES ('GB','United Kingdom','+44','GBP','0','{07}',11,'t',NULL,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.countries (code, name, dial_code, currency_code, trunk_prefix, mobile_prefixes, mobile_digits, has_area_codes, landline_digits, is_active) VALUES ('JP','Japan','+81','JPY','0','{070,080,090}',11,'t',NULL,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.countries (code, name, dial_code, currency_code, trunk_prefix, mobile_prefixes, mobile_digits, has_area_codes, landline_digits, is_active) VALUES ('SA','Saudi Arabia','+966','SAR','0','{05}',10,'t',NULL,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.countries (code, name, dial_code, currency_code, trunk_prefix, mobile_prefixes, mobile_digits, has_area_codes, landline_digits, is_active) VALUES ('TR','Türkiye','+90','TRY','0','{05}',11,'t',NULL,'t') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.countries (code, name, dial_code, currency_code, trunk_prefix, mobile_prefixes, mobile_digits, has_area_codes, landline_digits, is_active) VALUES ('US','United States','+1','USD','','{}',10,'t',NULL,'t') ON CONFLICT (code) DO NOTHING;

-- Country area codes
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','2','Cairo / Giza / Qalyubia',8) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','3','Alexandria',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','13','Qalyubia (Banha)',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','15','10th of Ramadan City',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','40','Gharbia (Tanta)',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','45','Beheira (Damanhour)',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','46','Matrouh',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','47','Kafr El Sheikh',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','48','Menoufia',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','50','Dakahlia (Mansoura)',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','55','Sharqia (Zagazig)',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','57','Damietta',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','62','Suez',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','64','Ismailia',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','65','Red Sea (Hurghada)',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','66','Port Said',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','68','North Sinai (El Arish)',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','69','South Sinai (El Tor / Sharm El Sheikh)',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','82','Beni Suef',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','84','Fayoum',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','86','Minya',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','88','Assiut',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','92','New Valley',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','93','Sohag',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','95','Luxor',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','96','Qena',7) ON CONFLICT (country_code, area_code) DO NOTHING;
INSERT INTO public.country_area_codes (country_code, area_code, name, digits) VALUES ('EG','97','Aswan',7) ON CONFLICT (country_code, area_code) DO NOTHING;

-- System configuration
INSERT INTO public.rma_config (config_key, config_value) VALUES ('commercial_registration','""'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('default_country','"EG"'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('default_currency','"EGP"'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('default_tax_rate','14'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('email_typo_warnings','true'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('fiscal_year_start_month','1'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('kb_llm_base_url','""'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('kb_llm_max_tokens','4096'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('kb_llm_model','"nvidia/nemotron-3-ultra-550b-a55b"'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('legal_name','""'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('pdf_layout','{"font": "Calibri, Candara, sans-serif", "currency": "EGP", "fontSize": 12, "sections": {"products": true, "ticketInfo": true, "accessories": true, "attachments": false, "signatureLine": true, "generalDescription": true}, "showDate": true, "showLogo": true, "paperSize": "A4", "footerText": "Thanks for your business with QDS Egypt", "companyName": "Quality Durable System Egypt ", "headerStyle": "colored", "orientation": "portrait", "companyPhone": "+2027374455", "logoPosition": "left", "primaryColor": "#000000", "sectionOrder": ["ticketInfo", "products", "generalDescription", "accessories", "attachments", "signatureLine"], "showRmaNumber": true, "showWatermark": false, "companyAddress": "20 Ahmed Heshmat, Zamalek, Cairo, Egypt", "showCompanyName": true, "showGeneratedDate": true}'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('purchase_tax_in_cost','false'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('registered_address','""'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('role_templates','{"manager": {"products": {"edit": true, "view": true, "create": true, "delete": false, "export": true, "import": true}, "settings": {"edit_branding": false, "view_settings": false, "manage_statuses": false, "view_audit_logs": false, "edit_company_info": false, "manage_categories": false, "manage_priorities": false, "manage_email_templates": false}, "customers": {"edit": true, "view": true, "create": true, "delete": false, "export": true, "import": true, "view_history": true}, "dashboard": {"view_reports": true, "export_reports": true, "view_analytics": true, "view_dashboard": true, "customize_dashboard": false}, "inventory": {"view": true, "delete": false, "export": true, "transfer": true, "resolve_units": true, "manage_batches": true, "manage_warehouses": false}, "rma_tickets": {"assign": true, "create": true, "delete": false, "export": true, "edit_all": true, "view_all": true, "add_comments": true, "attach_files": true, "delete_files": false, "print_labels": true, "change_status": true, "edit_assigned": true, "view_activity": true, "view_assigned": true, "change_priority": true, "delete_comments": false}, "user_management": {"edit_users": false, "view_users": false, "assign_roles": false, "create_roles": false, "create_users": false, "delete_roles": false, "delete_users": false, "manage_permissions": false}}}'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('sales_doc_layout','{"font": "Calibri, Candara, sans-serif", "currency": "EGP", "fontSize": 13, "footerText": "Thanks for your business", "companyName": "QDS Egypt", "companyPhone": "+20227374455", "primaryColor": "#4338ca", "companyAddress": "20 Ahmed Heshmat, Zamalek, Cairo, Egypt", "showGeneratedDate": true}'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('tax_registration_number','""'::jsonb) ON CONFLICT (config_key) DO NOTHING;
INSERT INTO public.rma_config (config_key, config_value) VALUES ('timezone','"Africa/Cairo"'::jsonb) ON CONFLICT (config_key) DO NOTHING;

COMMIT;

-- Verification: every row must report PASS.
SELECT CASE WHEN count(*) > 0  THEN 'PASS' ELSE 'FAIL' END AS result,
       'currencies seeded' AS what, count(*)::text AS actual FROM public.currencies
UNION ALL SELECT CASE WHEN count(*) > 0 THEN 'PASS' ELSE 'FAIL' END,
       'countries seeded', count(*)::text FROM public.countries
UNION ALL SELECT CASE WHEN count(*) = 27 THEN 'PASS' ELSE 'FAIL' END,
       '27 Egyptian area codes', count(*)::text FROM public.country_area_codes WHERE country_code = 'EG'
UNION ALL SELECT CASE WHEN name = 'Suez' THEN 'PASS' ELSE 'FAIL' END,
       'area code 62 is Suez, not Ismailia', name
  FROM public.country_area_codes WHERE country_code = 'EG' AND area_code = '62'
UNION ALL SELECT CASE WHEN count(*) > 0 THEN 'PASS' ELSE 'FAIL' END,
       'system configuration seeded', count(*)::text FROM public.rma_config;
