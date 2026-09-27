-- ============================================================================
-- 20260908_country_chart_templates.sql
-- A-02 — a full chart of accounts per country (Egypt, UAE, Saudi Arabia), and
-- a CSV import. Owner decision (2026-09-27): full chart per country.
-- Design and review status: docs/A01_GENERAL_LEDGER.md (A-02).
-- ============================================================================
-- DRAFT TEMPLATES: the three charts follow an IFRS-style structure with each
-- country's own accounts (Egypt: withholding / salary / stamp tax, social
-- insurance, legal reserve, employees' profit share; Saudi Arabia: zakat,
-- GOSI, end-of-service provision, Iqama and work-permit fees; UAE: corporate
-- tax, pension contributions, end-of-service gratuity, visa and labour fees).
-- An accountant must review them before a tenant relies on them; changing a
-- template later is a new migration that upserts gl_chart_templates.
--
--   * gl_chart_templates: the rows, one per (country, code), with the posting
--     role an account carries. Readable by staff; written only by migrations.
--   * rma_apply_chart_template(country) — administrators, and only before
--     anything has been posted (a chart with postings keeps its meaning): the
--     chart becomes exactly the template. Accounts whose code is in it are
--     renamed / retyped / re-parented to it, missing ones are created (id from
--     the code, as the default chart's are), the posting rules point where the
--     template says, and accounts not in it are removed. Remembered in
--     rma_config 'chart_template'.
--   * rma_import_chart_accounts(rows) — administrators, at any time: each row
--     {code, name, name_ar, type, parent_code, header} creates an account, or
--     renames an existing one (its type, parent and header flag stay as they
--     are — the guards protect an account with postings). One result per row.
--
-- Pinned by src/test/countryChartTemplates.test.js; supabase/tests/
-- country_chart_templates.sql is the rolled-back reference script.
-- ============================================================================

-- ── 1. the templates ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gl_chart_templates (
  country_code text NOT NULL CHECK (country_code IN ('EG', 'AE', 'SA')),
  code         text NOT NULL CHECK (btrim(code) <> '' AND code = btrim(code)),
  name         text NOT NULL,
  name_ar      text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_code  text,
  is_postable  boolean NOT NULL,
  role         text,
  PRIMARY KEY (country_code, code)
);
CREATE UNIQUE INDEX IF NOT EXISTS gl_chart_templates_role_uniq
  ON public.gl_chart_templates (country_code, role) WHERE role IS NOT NULL;

COMMENT ON TABLE public.gl_chart_templates IS
  'Chart-of-accounts templates per country (A-02). DRAFT: to be reviewed by an accountant before tenants rely on them. Written only by migrations; applied by rma_apply_chart_template.';

ALTER TABLE public.gl_chart_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gl_chart_templates FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.gl_chart_templates FROM authenticated;
GRANT SELECT ON TABLE public.gl_chart_templates TO authenticated;
GRANT ALL ON TABLE public.gl_chart_templates TO service_role;
DROP POLICY IF EXISTS "read_gl_chart_templates" ON public.gl_chart_templates;
CREATE POLICY "read_gl_chart_templates" ON public.gl_chart_templates FOR SELECT USING (COALESCE(public.rma_is_staff(), false));

INSERT INTO public.gl_chart_templates (country_code, code, name, name_ar, account_type, parent_code, is_postable, role)
VALUES
  ('EG', '1000', 'Assets', 'الأصول', 'asset', NULL, false, NULL),
  ('EG', '1100', 'Current assets', 'الأصول المتداولة', 'asset', '1000', false, NULL),
  ('EG', '1110', 'Cash on hand', 'النقدية بالصندوق', 'asset', '1100', true, NULL),
  ('EG', '1120', 'Petty cash', 'العهد النقدية', 'asset', '1100', true, NULL),
  ('EG', '1130', 'Bank – current account', 'البنك – حساب جاري', 'asset', '1100', true, 'cash'),
  ('EG', '1140', 'Bank – foreign currency account', 'البنك – حساب بالعملة الأجنبية', 'asset', '1100', true, NULL),
  ('EG', '1150', 'Cheques under collection', 'شيكات تحت التحصيل', 'asset', '1100', true, NULL),
  ('EG', '1200', 'Receivables', 'المدينون', 'asset', '1000', false, NULL),
  ('EG', '1210', 'Trade receivables', 'العملاء', 'asset', '1200', true, 'accounts_receivable'),
  ('EG', '1220', 'Allowance for doubtful debts', 'مخصص الديون المشكوك في تحصيلها', 'asset', '1200', true, NULL),
  ('EG', '1230', 'Employee advances and loans', 'سلف وقروض الموظفين', 'asset', '1200', true, NULL),
  ('EG', '1240', 'Other receivables', 'مدينون آخرون', 'asset', '1200', true, NULL),
  ('EG', '1300', 'Inventory', 'المخزون', 'asset', '1000', false, NULL),
  ('EG', '1310', 'Inventory – goods for resale', 'مخزون البضاعة بغرض البيع', 'asset', '1300', true, 'inventory'),
  ('EG', '1320', 'Goods in transit', 'بضاعة بالطريق', 'asset', '1300', true, NULL),
  ('EG', '1400', 'Tax receivables', 'الضرائب المستردة', 'asset', '1000', false, NULL),
  ('EG', '1410', 'VAT input (recoverable)', 'ضريبة القيمة المضافة على المدخلات', 'asset', '1400', true, 'purchase_tax_receivable'),
  ('EG', '1420', 'Withholding tax deducted by customers', 'ضريبة الخصم والتحصيل تحت حساب الضريبة', 'asset', '1400', true, NULL),
  ('EG', '1430', 'Advance income tax payments', 'دفعات مقدمة من ضريبة الدخل', 'asset', '1400', true, NULL),
  ('EG', '1500', 'Prepayments and advances', 'المصروفات المدفوعة مقدماً والدفعات المقدمة', 'asset', '1000', false, NULL),
  ('EG', '1510', 'Prepaid expenses', 'مصروفات مدفوعة مقدماً', 'asset', '1500', true, NULL),
  ('EG', '1520', 'Advances to suppliers', 'دفعات مقدمة للموردين', 'asset', '1500', true, NULL),
  ('EG', '1530', 'Refundable deposits', 'تأمينات مستردة', 'asset', '1500', true, NULL),
  ('EG', '1600', 'Property and equipment', 'الأصول الثابتة', 'asset', '1000', false, NULL),
  ('EG', '1610', 'Land', 'الأراضي', 'asset', '1600', true, NULL),
  ('EG', '1620', 'Buildings', 'المباني', 'asset', '1600', true, NULL),
  ('EG', '1630', 'Vehicles', 'السيارات', 'asset', '1600', true, NULL),
  ('EG', '1640', 'Furniture and fixtures', 'الأثاث والتجهيزات', 'asset', '1600', true, NULL),
  ('EG', '1650', 'Computers and IT equipment', 'أجهزة الحاسب الآلي', 'asset', '1600', true, NULL),
  ('EG', '1660', 'Tools and equipment', 'العدد والأدوات', 'asset', '1600', true, NULL),
  ('EG', '1690', 'Accumulated depreciation', 'مجمع الإهلاك', 'asset', '1600', true, NULL),
  ('EG', '1700', 'Intangible assets', 'الأصول غير الملموسة', 'asset', '1000', false, NULL),
  ('EG', '1710', 'Software and licences', 'البرامج والتراخيص', 'asset', '1700', true, NULL),
  ('EG', '1790', 'Accumulated amortisation', 'مجمع الاستهلاك', 'asset', '1700', true, NULL),
  ('EG', '2000', 'Liabilities', 'الخصوم', 'liability', NULL, false, NULL),
  ('EG', '2100', 'Current liabilities', 'الخصوم المتداولة', 'liability', '2000', false, NULL),
  ('EG', '2110', 'Trade payables', 'الموردون', 'liability', '2100', true, 'accounts_payable'),
  ('EG', '2120', 'Goods received not invoiced', 'بضاعة مستلمة لم تصل فواتيرها', 'liability', '2100', true, 'goods_received_not_invoiced'),
  ('EG', '2130', 'Accrued freight and duties', 'مستحقات الشحن والرسوم الجمركية', 'liability', '2100', true, 'accrued_landed_costs'),
  ('EG', '2140', 'Accrued expenses', 'مصروفات مستحقة', 'liability', '2100', true, NULL),
  ('EG', '2150', 'Customer deposits', 'دفعات مقدمة من العملاء', 'liability', '2100', true, 'customer_deposits'),
  ('EG', '2160', 'Salaries payable', 'رواتب مستحقة', 'liability', '2100', true, NULL),
  ('EG', '2170', 'Other payables', 'دائنون آخرون', 'liability', '2100', true, NULL),
  ('EG', '2180', 'Employees'' profit share payable', 'حصة العاملين في الأرباح المستحقة', 'liability', '2100', true, NULL),
  ('EG', '2200', 'Tax liabilities', 'الضرائب المستحقة', 'liability', '2000', false, NULL),
  ('EG', '2210', 'VAT output', 'ضريبة القيمة المضافة على المخرجات', 'liability', '2200', true, 'sales_tax_payable'),
  ('EG', '2220', 'Withholding tax payable', 'ضريبة الخصم والتحصيل المستحقة', 'liability', '2200', true, NULL),
  ('EG', '2230', 'Salary tax payable', 'ضريبة كسب العمل المستحقة', 'liability', '2200', true, NULL),
  ('EG', '2240', 'Social insurance payable', 'التأمينات الاجتماعية المستحقة', 'liability', '2200', true, NULL),
  ('EG', '2250', 'Stamp duty payable', 'ضريبة الدمغة المستحقة', 'liability', '2200', true, NULL),
  ('EG', '2260', 'Corporate income tax payable', 'ضريبة الدخل المستحقة', 'liability', '2200', true, NULL),
  ('EG', '2300', 'Borrowings', 'القروض', 'liability', '2000', false, NULL),
  ('EG', '2310', 'Short-term loans and overdrafts', 'قروض قصيرة الأجل وسحب على المكشوف', 'liability', '2300', true, NULL),
  ('EG', '2320', 'Long-term loans', 'قروض طويلة الأجل', 'liability', '2300', true, NULL),
  ('EG', '2400', 'Provisions', 'المخصصات', 'liability', '2000', false, NULL),
  ('EG', '3000', 'Equity', 'حقوق الملكية', 'equity', NULL, false, NULL),
  ('EG', '3100', 'Share capital', 'رأس المال', 'equity', '3000', true, NULL),
  ('EG', '3200', 'Legal reserve', 'الاحتياطي القانوني', 'equity', '3000', true, NULL),
  ('EG', '3300', 'Retained earnings', 'الأرباح المحتجزة', 'equity', '3000', true, 'retained_earnings'),
  ('EG', '3400', 'Owners'' current account', 'جاري الشركاء', 'equity', '3000', true, NULL),
  ('EG', '3900', 'Opening balance equity', 'حقوق ملكية الأرصدة الافتتاحية', 'equity', '3000', true, 'opening_balance_equity'),
  ('EG', '4000', 'Revenue', 'الإيرادات', 'income', NULL, false, NULL),
  ('EG', '4100', 'Sales revenue', 'إيرادات المبيعات', 'income', '4000', true, 'sales_revenue'),
  ('EG', '4200', 'Service revenue', 'إيرادات الخدمات', 'income', '4000', true, NULL),
  ('EG', '4300', 'Sales discounts', 'خصم مسموح به', 'income', '4000', true, NULL),
  ('EG', '4900', 'Other income', 'إيرادات أخرى', 'income', '4000', true, NULL),
  ('EG', '4910', 'Foreign exchange gains', 'أرباح فروق العملة', 'income', '4000', true, NULL),
  ('EG', '4920', 'Gain on disposal of assets', 'أرباح بيع أصول ثابتة', 'income', '4000', true, NULL),
  ('EG', '5000', 'Cost of sales', 'تكلفة المبيعات', 'expense', NULL, false, NULL),
  ('EG', '5100', 'Cost of goods sold', 'تكلفة البضاعة المباعة', 'expense', '5000', true, 'cost_of_goods_sold'),
  ('EG', '5200', 'Purchase price variance', 'فروق أسعار الشراء', 'expense', '5000', true, 'purchase_price_variance'),
  ('EG', '5300', 'Inventory adjustments and write-offs', 'تسويات وإعدام المخزون', 'expense', '5000', true, 'inventory_adjustment'),
  ('EG', '5400', 'Freight and customs on purchases', 'مصروفات الشحن والجمارك على المشتريات', 'expense', '5000', true, NULL),
  ('EG', '6000', 'Operating expenses', 'المصروفات التشغيلية', 'expense', NULL, false, NULL),
  ('EG', '6100', 'Salaries and wages', 'الرواتب والأجور', 'expense', '6000', true, NULL),
  ('EG', '6110', 'Employee benefits', 'مزايا الموظفين', 'expense', '6000', true, NULL),
  ('EG', '6120', 'Employer social insurance contributions', 'حصة الشركة في التأمينات الاجتماعية', 'expense', '6000', true, NULL),
  ('EG', '6200', 'Rent', 'الإيجار', 'expense', '6000', true, NULL),
  ('EG', '6210', 'Utilities', 'المرافق (كهرباء ومياه)', 'expense', '6000', true, NULL),
  ('EG', '6220', 'Telephone and internet', 'الهاتف والإنترنت', 'expense', '6000', true, NULL),
  ('EG', '6300', 'Marketing and advertising', 'التسويق والإعلان', 'expense', '6000', true, NULL),
  ('EG', '6310', 'Travel and transport', 'السفر والانتقالات', 'expense', '6000', true, NULL),
  ('EG', '6400', 'Repairs and maintenance', 'الإصلاح والصيانة', 'expense', '6000', true, NULL),
  ('EG', '6410', 'Office supplies', 'مستلزمات مكتبية', 'expense', '6000', true, NULL),
  ('EG', '6500', 'Professional fees', 'أتعاب مهنية', 'expense', '6000', true, NULL),
  ('EG', '6510', 'Bank charges', 'مصروفات بنكية', 'expense', '6000', true, NULL),
  ('EG', '6520', 'Foreign exchange losses', 'خسائر فروق العملة', 'expense', '6000', true, NULL),
  ('EG', '6600', 'Depreciation', 'الإهلاك', 'expense', '6000', true, NULL),
  ('EG', '6610', 'Amortisation', 'الاستهلاك', 'expense', '6000', true, NULL),
  ('EG', '6700', 'Bad debt expense', 'الديون المعدومة', 'expense', '6000', true, NULL),
  ('EG', '6800', 'Government fees and licences', 'رسوم حكومية وتراخيص', 'expense', '6000', true, NULL),
  ('EG', '6900', 'Other expenses', 'مصروفات أخرى', 'expense', '6000', true, NULL),
  ('EG', '6990', 'Rounding differences', 'فروق التقريب', 'expense', '6000', true, 'rounding'),
  ('EG', '7000', 'Taxes on income', 'الضرائب على الدخل', 'expense', NULL, false, NULL),
  ('EG', '7100', 'Corporate income tax expense', 'مصروف ضريبة الدخل', 'expense', '7000', true, NULL),
  ('AE', '1000', 'Assets', 'الأصول', 'asset', NULL, false, NULL),
  ('AE', '1100', 'Current assets', 'الأصول المتداولة', 'asset', '1000', false, NULL),
  ('AE', '1110', 'Cash on hand', 'النقدية بالصندوق', 'asset', '1100', true, NULL),
  ('AE', '1120', 'Petty cash', 'العهد النقدية', 'asset', '1100', true, NULL),
  ('AE', '1130', 'Bank – current account', 'البنك – حساب جاري', 'asset', '1100', true, 'cash'),
  ('AE', '1140', 'Bank – foreign currency account', 'البنك – حساب بالعملة الأجنبية', 'asset', '1100', true, NULL),
  ('AE', '1150', 'Cheques under collection', 'شيكات تحت التحصيل', 'asset', '1100', true, NULL),
  ('AE', '1200', 'Receivables', 'المدينون', 'asset', '1000', false, NULL),
  ('AE', '1210', 'Trade receivables', 'العملاء', 'asset', '1200', true, 'accounts_receivable'),
  ('AE', '1220', 'Allowance for doubtful debts', 'مخصص الديون المشكوك في تحصيلها', 'asset', '1200', true, NULL),
  ('AE', '1230', 'Employee advances and loans', 'سلف وقروض الموظفين', 'asset', '1200', true, NULL),
  ('AE', '1240', 'Other receivables', 'مدينون آخرون', 'asset', '1200', true, NULL),
  ('AE', '1300', 'Inventory', 'المخزون', 'asset', '1000', false, NULL),
  ('AE', '1310', 'Inventory – goods for resale', 'مخزون البضاعة بغرض البيع', 'asset', '1300', true, 'inventory'),
  ('AE', '1320', 'Goods in transit', 'بضاعة بالطريق', 'asset', '1300', true, NULL),
  ('AE', '1400', 'Tax receivables', 'الضرائب المستردة', 'asset', '1000', false, NULL),
  ('AE', '1410', 'VAT input (recoverable)', 'ضريبة القيمة المضافة على المدخلات', 'asset', '1400', true, 'purchase_tax_receivable'),
  ('AE', '1500', 'Prepayments and advances', 'المصروفات المدفوعة مقدماً والدفعات المقدمة', 'asset', '1000', false, NULL),
  ('AE', '1510', 'Prepaid expenses', 'مصروفات مدفوعة مقدماً', 'asset', '1500', true, NULL),
  ('AE', '1520', 'Advances to suppliers', 'دفعات مقدمة للموردين', 'asset', '1500', true, NULL),
  ('AE', '1530', 'Refundable deposits', 'تأمينات مستردة', 'asset', '1500', true, NULL),
  ('AE', '1600', 'Property and equipment', 'الأصول الثابتة', 'asset', '1000', false, NULL),
  ('AE', '1610', 'Land', 'الأراضي', 'asset', '1600', true, NULL),
  ('AE', '1620', 'Buildings', 'المباني', 'asset', '1600', true, NULL),
  ('AE', '1630', 'Vehicles', 'السيارات', 'asset', '1600', true, NULL),
  ('AE', '1640', 'Furniture and fixtures', 'الأثاث والتجهيزات', 'asset', '1600', true, NULL),
  ('AE', '1650', 'Computers and IT equipment', 'أجهزة الحاسب الآلي', 'asset', '1600', true, NULL),
  ('AE', '1660', 'Tools and equipment', 'العدد والأدوات', 'asset', '1600', true, NULL),
  ('AE', '1690', 'Accumulated depreciation', 'مجمع الإهلاك', 'asset', '1600', true, NULL),
  ('AE', '1700', 'Intangible assets', 'الأصول غير الملموسة', 'asset', '1000', false, NULL),
  ('AE', '1710', 'Software and licences', 'البرامج والتراخيص', 'asset', '1700', true, NULL),
  ('AE', '1790', 'Accumulated amortisation', 'مجمع الاستهلاك', 'asset', '1700', true, NULL),
  ('AE', '2000', 'Liabilities', 'الخصوم', 'liability', NULL, false, NULL),
  ('AE', '2100', 'Current liabilities', 'الخصوم المتداولة', 'liability', '2000', false, NULL),
  ('AE', '2110', 'Trade payables', 'الموردون', 'liability', '2100', true, 'accounts_payable'),
  ('AE', '2120', 'Goods received not invoiced', 'بضاعة مستلمة لم تصل فواتيرها', 'liability', '2100', true, 'goods_received_not_invoiced'),
  ('AE', '2130', 'Accrued freight and duties', 'مستحقات الشحن والرسوم الجمركية', 'liability', '2100', true, 'accrued_landed_costs'),
  ('AE', '2140', 'Accrued expenses', 'مصروفات مستحقة', 'liability', '2100', true, NULL),
  ('AE', '2150', 'Customer deposits', 'دفعات مقدمة من العملاء', 'liability', '2100', true, 'customer_deposits'),
  ('AE', '2160', 'Salaries payable', 'رواتب مستحقة', 'liability', '2100', true, NULL),
  ('AE', '2170', 'Other payables', 'دائنون آخرون', 'liability', '2100', true, NULL),
  ('AE', '2200', 'Tax liabilities', 'الضرائب المستحقة', 'liability', '2000', false, NULL),
  ('AE', '2210', 'VAT output', 'ضريبة القيمة المضافة على المخرجات', 'liability', '2200', true, 'sales_tax_payable'),
  ('AE', '2220', 'Corporate tax payable', 'ضريبة الشركات المستحقة', 'liability', '2200', true, NULL),
  ('AE', '2230', 'Pension contributions payable', 'اشتراكات المعاشات المستحقة', 'liability', '2200', true, NULL),
  ('AE', '2300', 'Borrowings', 'القروض', 'liability', '2000', false, NULL),
  ('AE', '2310', 'Short-term loans and overdrafts', 'قروض قصيرة الأجل وسحب على المكشوف', 'liability', '2300', true, NULL),
  ('AE', '2320', 'Long-term loans', 'قروض طويلة الأجل', 'liability', '2300', true, NULL),
  ('AE', '2400', 'Provisions', 'المخصصات', 'liability', '2000', false, NULL),
  ('AE', '2410', 'Provision for end-of-service gratuity', 'مخصص مكافأة نهاية الخدمة', 'liability', '2400', true, NULL),
  ('AE', '3000', 'Equity', 'حقوق الملكية', 'equity', NULL, false, NULL),
  ('AE', '3100', 'Share capital', 'رأس المال', 'equity', '3000', true, NULL),
  ('AE', '3200', 'Statutory reserve', 'الاحتياطي النظامي', 'equity', '3000', true, NULL),
  ('AE', '3300', 'Retained earnings', 'الأرباح المحتجزة', 'equity', '3000', true, 'retained_earnings'),
  ('AE', '3400', 'Owners'' current account', 'جاري الشركاء', 'equity', '3000', true, NULL),
  ('AE', '3900', 'Opening balance equity', 'حقوق ملكية الأرصدة الافتتاحية', 'equity', '3000', true, 'opening_balance_equity'),
  ('AE', '4000', 'Revenue', 'الإيرادات', 'income', NULL, false, NULL),
  ('AE', '4100', 'Sales revenue', 'إيرادات المبيعات', 'income', '4000', true, 'sales_revenue'),
  ('AE', '4200', 'Service revenue', 'إيرادات الخدمات', 'income', '4000', true, NULL),
  ('AE', '4300', 'Sales discounts', 'خصم مسموح به', 'income', '4000', true, NULL),
  ('AE', '4900', 'Other income', 'إيرادات أخرى', 'income', '4000', true, NULL),
  ('AE', '4910', 'Foreign exchange gains', 'أرباح فروق العملة', 'income', '4000', true, NULL),
  ('AE', '4920', 'Gain on disposal of assets', 'أرباح بيع أصول ثابتة', 'income', '4000', true, NULL),
  ('AE', '5000', 'Cost of sales', 'تكلفة المبيعات', 'expense', NULL, false, NULL),
  ('AE', '5100', 'Cost of goods sold', 'تكلفة البضاعة المباعة', 'expense', '5000', true, 'cost_of_goods_sold'),
  ('AE', '5200', 'Purchase price variance', 'فروق أسعار الشراء', 'expense', '5000', true, 'purchase_price_variance'),
  ('AE', '5300', 'Inventory adjustments and write-offs', 'تسويات وإعدام المخزون', 'expense', '5000', true, 'inventory_adjustment'),
  ('AE', '5400', 'Freight and customs on purchases', 'مصروفات الشحن والجمارك على المشتريات', 'expense', '5000', true, NULL),
  ('AE', '6000', 'Operating expenses', 'المصروفات التشغيلية', 'expense', NULL, false, NULL),
  ('AE', '6100', 'Salaries and wages', 'الرواتب والأجور', 'expense', '6000', true, NULL),
  ('AE', '6110', 'Employee benefits', 'مزايا الموظفين', 'expense', '6000', true, NULL),
  ('AE', '6120', 'Pension contributions – employer', 'حصة الشركة في اشتراكات المعاشات', 'expense', '6000', true, NULL),
  ('AE', '6130', 'End-of-service gratuity expense', 'مصروف مكافأة نهاية الخدمة', 'expense', '6000', true, NULL),
  ('AE', '6200', 'Rent', 'الإيجار', 'expense', '6000', true, NULL),
  ('AE', '6210', 'Utilities', 'المرافق (كهرباء ومياه)', 'expense', '6000', true, NULL),
  ('AE', '6220', 'Telephone and internet', 'الهاتف والإنترنت', 'expense', '6000', true, NULL),
  ('AE', '6300', 'Marketing and advertising', 'التسويق والإعلان', 'expense', '6000', true, NULL),
  ('AE', '6310', 'Travel and transport', 'السفر والانتقالات', 'expense', '6000', true, NULL),
  ('AE', '6400', 'Repairs and maintenance', 'الإصلاح والصيانة', 'expense', '6000', true, NULL),
  ('AE', '6410', 'Office supplies', 'مستلزمات مكتبية', 'expense', '6000', true, NULL),
  ('AE', '6500', 'Professional fees', 'أتعاب مهنية', 'expense', '6000', true, NULL),
  ('AE', '6510', 'Bank charges', 'مصروفات بنكية', 'expense', '6000', true, NULL),
  ('AE', '6520', 'Foreign exchange losses', 'خسائر فروق العملة', 'expense', '6000', true, NULL),
  ('AE', '6600', 'Depreciation', 'الإهلاك', 'expense', '6000', true, NULL),
  ('AE', '6610', 'Amortisation', 'الاستهلاك', 'expense', '6000', true, NULL),
  ('AE', '6700', 'Bad debt expense', 'الديون المعدومة', 'expense', '6000', true, NULL),
  ('AE', '6800', 'Government fees and licences', 'رسوم حكومية وتراخيص', 'expense', '6000', true, NULL),
  ('AE', '6810', 'Visa and labour fees', 'رسوم التأشيرات والعمل', 'expense', '6000', true, NULL),
  ('AE', '6900', 'Other expenses', 'مصروفات أخرى', 'expense', '6000', true, NULL),
  ('AE', '6990', 'Rounding differences', 'فروق التقريب', 'expense', '6000', true, 'rounding'),
  ('AE', '7000', 'Taxes on income', 'الضرائب على الدخل', 'expense', NULL, false, NULL),
  ('AE', '7100', 'Corporate tax expense', 'مصروف ضريبة الشركات', 'expense', '7000', true, NULL),
  ('SA', '1000', 'Assets', 'الأصول', 'asset', NULL, false, NULL),
  ('SA', '1100', 'Current assets', 'الأصول المتداولة', 'asset', '1000', false, NULL),
  ('SA', '1110', 'Cash on hand', 'النقدية بالصندوق', 'asset', '1100', true, NULL),
  ('SA', '1120', 'Petty cash', 'العهد النقدية', 'asset', '1100', true, NULL),
  ('SA', '1130', 'Bank – current account', 'البنك – حساب جاري', 'asset', '1100', true, 'cash'),
  ('SA', '1140', 'Bank – foreign currency account', 'البنك – حساب بالعملة الأجنبية', 'asset', '1100', true, NULL),
  ('SA', '1150', 'Cheques under collection', 'شيكات تحت التحصيل', 'asset', '1100', true, NULL),
  ('SA', '1200', 'Receivables', 'المدينون', 'asset', '1000', false, NULL),
  ('SA', '1210', 'Trade receivables', 'العملاء', 'asset', '1200', true, 'accounts_receivable'),
  ('SA', '1220', 'Allowance for doubtful debts', 'مخصص الديون المشكوك في تحصيلها', 'asset', '1200', true, NULL),
  ('SA', '1230', 'Employee advances and loans', 'سلف وقروض الموظفين', 'asset', '1200', true, NULL),
  ('SA', '1240', 'Other receivables', 'مدينون آخرون', 'asset', '1200', true, NULL),
  ('SA', '1300', 'Inventory', 'المخزون', 'asset', '1000', false, NULL),
  ('SA', '1310', 'Inventory – goods for resale', 'مخزون البضاعة بغرض البيع', 'asset', '1300', true, 'inventory'),
  ('SA', '1320', 'Goods in transit', 'بضاعة بالطريق', 'asset', '1300', true, NULL),
  ('SA', '1400', 'Tax receivables', 'الضرائب المستردة', 'asset', '1000', false, NULL),
  ('SA', '1410', 'VAT input (recoverable)', 'ضريبة القيمة المضافة على المدخلات', 'asset', '1400', true, 'purchase_tax_receivable'),
  ('SA', '1500', 'Prepayments and advances', 'المصروفات المدفوعة مقدماً والدفعات المقدمة', 'asset', '1000', false, NULL),
  ('SA', '1510', 'Prepaid expenses', 'مصروفات مدفوعة مقدماً', 'asset', '1500', true, NULL),
  ('SA', '1520', 'Advances to suppliers', 'دفعات مقدمة للموردين', 'asset', '1500', true, NULL),
  ('SA', '1530', 'Refundable deposits', 'تأمينات مستردة', 'asset', '1500', true, NULL),
  ('SA', '1600', 'Property and equipment', 'الأصول الثابتة', 'asset', '1000', false, NULL),
  ('SA', '1610', 'Land', 'الأراضي', 'asset', '1600', true, NULL),
  ('SA', '1620', 'Buildings', 'المباني', 'asset', '1600', true, NULL),
  ('SA', '1630', 'Vehicles', 'السيارات', 'asset', '1600', true, NULL),
  ('SA', '1640', 'Furniture and fixtures', 'الأثاث والتجهيزات', 'asset', '1600', true, NULL),
  ('SA', '1650', 'Computers and IT equipment', 'أجهزة الحاسب الآلي', 'asset', '1600', true, NULL),
  ('SA', '1660', 'Tools and equipment', 'العدد والأدوات', 'asset', '1600', true, NULL),
  ('SA', '1690', 'Accumulated depreciation', 'مجمع الإهلاك', 'asset', '1600', true, NULL),
  ('SA', '1700', 'Intangible assets', 'الأصول غير الملموسة', 'asset', '1000', false, NULL),
  ('SA', '1710', 'Software and licences', 'البرامج والتراخيص', 'asset', '1700', true, NULL),
  ('SA', '1790', 'Accumulated amortisation', 'مجمع الاستهلاك', 'asset', '1700', true, NULL),
  ('SA', '2000', 'Liabilities', 'الخصوم', 'liability', NULL, false, NULL),
  ('SA', '2100', 'Current liabilities', 'الخصوم المتداولة', 'liability', '2000', false, NULL),
  ('SA', '2110', 'Trade payables', 'الموردون', 'liability', '2100', true, 'accounts_payable'),
  ('SA', '2120', 'Goods received not invoiced', 'بضاعة مستلمة لم تصل فواتيرها', 'liability', '2100', true, 'goods_received_not_invoiced'),
  ('SA', '2130', 'Accrued freight and duties', 'مستحقات الشحن والرسوم الجمركية', 'liability', '2100', true, 'accrued_landed_costs'),
  ('SA', '2140', 'Accrued expenses', 'مصروفات مستحقة', 'liability', '2100', true, NULL),
  ('SA', '2150', 'Customer deposits', 'دفعات مقدمة من العملاء', 'liability', '2100', true, 'customer_deposits'),
  ('SA', '2160', 'Salaries payable', 'رواتب مستحقة', 'liability', '2100', true, NULL),
  ('SA', '2170', 'Other payables', 'دائنون آخرون', 'liability', '2100', true, NULL),
  ('SA', '2200', 'Tax liabilities', 'الضرائب المستحقة', 'liability', '2000', false, NULL),
  ('SA', '2210', 'VAT output', 'ضريبة القيمة المضافة على المخرجات', 'liability', '2200', true, 'sales_tax_payable'),
  ('SA', '2220', 'Withholding tax payable', 'ضريبة الاستقطاع المستحقة', 'liability', '2200', true, NULL),
  ('SA', '2230', 'GOSI payable', 'التأمينات الاجتماعية (GOSI) المستحقة', 'liability', '2200', true, NULL),
  ('SA', '2240', 'Zakat payable', 'الزكاة المستحقة', 'liability', '2200', true, NULL),
  ('SA', '2250', 'Income tax payable', 'ضريبة الدخل المستحقة', 'liability', '2200', true, NULL),
  ('SA', '2300', 'Borrowings', 'القروض', 'liability', '2000', false, NULL),
  ('SA', '2310', 'Short-term loans and overdrafts', 'قروض قصيرة الأجل وسحب على المكشوف', 'liability', '2300', true, NULL),
  ('SA', '2320', 'Long-term loans', 'قروض طويلة الأجل', 'liability', '2300', true, NULL),
  ('SA', '2400', 'Provisions', 'المخصصات', 'liability', '2000', false, NULL),
  ('SA', '2410', 'Provision for end-of-service benefits', 'مخصص مكافأة نهاية الخدمة', 'liability', '2400', true, NULL),
  ('SA', '3000', 'Equity', 'حقوق الملكية', 'equity', NULL, false, NULL),
  ('SA', '3100', 'Share capital', 'رأس المال', 'equity', '3000', true, NULL),
  ('SA', '3200', 'Statutory reserve', 'الاحتياطي النظامي', 'equity', '3000', true, NULL),
  ('SA', '3300', 'Retained earnings', 'الأرباح المحتجزة', 'equity', '3000', true, 'retained_earnings'),
  ('SA', '3400', 'Owners'' current account', 'جاري الشركاء', 'equity', '3000', true, NULL),
  ('SA', '3900', 'Opening balance equity', 'حقوق ملكية الأرصدة الافتتاحية', 'equity', '3000', true, 'opening_balance_equity'),
  ('SA', '4000', 'Revenue', 'الإيرادات', 'income', NULL, false, NULL),
  ('SA', '4100', 'Sales revenue', 'إيرادات المبيعات', 'income', '4000', true, 'sales_revenue'),
  ('SA', '4200', 'Service revenue', 'إيرادات الخدمات', 'income', '4000', true, NULL),
  ('SA', '4300', 'Sales discounts', 'خصم مسموح به', 'income', '4000', true, NULL),
  ('SA', '4900', 'Other income', 'إيرادات أخرى', 'income', '4000', true, NULL),
  ('SA', '4910', 'Foreign exchange gains', 'أرباح فروق العملة', 'income', '4000', true, NULL),
  ('SA', '4920', 'Gain on disposal of assets', 'أرباح بيع أصول ثابتة', 'income', '4000', true, NULL),
  ('SA', '5000', 'Cost of sales', 'تكلفة المبيعات', 'expense', NULL, false, NULL),
  ('SA', '5100', 'Cost of goods sold', 'تكلفة البضاعة المباعة', 'expense', '5000', true, 'cost_of_goods_sold'),
  ('SA', '5200', 'Purchase price variance', 'فروق أسعار الشراء', 'expense', '5000', true, 'purchase_price_variance'),
  ('SA', '5300', 'Inventory adjustments and write-offs', 'تسويات وإعدام المخزون', 'expense', '5000', true, 'inventory_adjustment'),
  ('SA', '5400', 'Freight and customs on purchases', 'مصروفات الشحن والجمارك على المشتريات', 'expense', '5000', true, NULL),
  ('SA', '6000', 'Operating expenses', 'المصروفات التشغيلية', 'expense', NULL, false, NULL),
  ('SA', '6100', 'Salaries and wages', 'الرواتب والأجور', 'expense', '6000', true, NULL),
  ('SA', '6110', 'Employee benefits', 'مزايا الموظفين', 'expense', '6000', true, NULL),
  ('SA', '6120', 'GOSI employer contributions', 'حصة الشركة في التأمينات الاجتماعية', 'expense', '6000', true, NULL),
  ('SA', '6130', 'End-of-service benefits expense', 'مصروف مكافأة نهاية الخدمة', 'expense', '6000', true, NULL),
  ('SA', '6200', 'Rent', 'الإيجار', 'expense', '6000', true, NULL),
  ('SA', '6210', 'Utilities', 'المرافق (كهرباء ومياه)', 'expense', '6000', true, NULL),
  ('SA', '6220', 'Telephone and internet', 'الهاتف والإنترنت', 'expense', '6000', true, NULL),
  ('SA', '6300', 'Marketing and advertising', 'التسويق والإعلان', 'expense', '6000', true, NULL),
  ('SA', '6310', 'Travel and transport', 'السفر والانتقالات', 'expense', '6000', true, NULL),
  ('SA', '6400', 'Repairs and maintenance', 'الإصلاح والصيانة', 'expense', '6000', true, NULL),
  ('SA', '6410', 'Office supplies', 'مستلزمات مكتبية', 'expense', '6000', true, NULL),
  ('SA', '6500', 'Professional fees', 'أتعاب مهنية', 'expense', '6000', true, NULL),
  ('SA', '6510', 'Bank charges', 'مصروفات بنكية', 'expense', '6000', true, NULL),
  ('SA', '6520', 'Foreign exchange losses', 'خسائر فروق العملة', 'expense', '6000', true, NULL),
  ('SA', '6600', 'Depreciation', 'الإهلاك', 'expense', '6000', true, NULL),
  ('SA', '6610', 'Amortisation', 'الاستهلاك', 'expense', '6000', true, NULL),
  ('SA', '6700', 'Bad debt expense', 'الديون المعدومة', 'expense', '6000', true, NULL),
  ('SA', '6800', 'Government fees and licences', 'رسوم حكومية وتراخيص', 'expense', '6000', true, NULL),
  ('SA', '6810', 'Iqama, visa and work permit fees', 'رسوم الإقامة والتأشيرات ورخص العمل', 'expense', '6000', true, NULL),
  ('SA', '6900', 'Other expenses', 'مصروفات أخرى', 'expense', '6000', true, NULL),
  ('SA', '6990', 'Rounding differences', 'فروق التقريب', 'expense', '6000', true, 'rounding'),
  ('SA', '7000', 'Taxes on income', 'الضرائب على الدخل', 'expense', NULL, false, NULL),
  ('SA', '7100', 'Zakat expense', 'مصروف الزكاة', 'expense', '7000', true, NULL),
  ('SA', '7110', 'Income tax expense', 'مصروف ضريبة الدخل', 'expense', '7000', true, NULL)

ON CONFLICT (country_code, code) DO UPDATE
   SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, account_type = EXCLUDED.account_type,
       parent_code = EXCLUDED.parent_code, is_postable = EXCLUDED.is_postable, role = EXCLUDED.role;

-- ── 2. apply one (before anything is posted) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_apply_chart_template(p_country text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_c       text := upper(btrim(COALESCE(p_country, '')));
  v_t       public.gl_chart_templates;
  v_created integer := 0;
  v_updated integer := 0;
  v_removed integer := 0;
BEGIN
  IF NOT COALESCE(public.rma_is_admin(), false) THEN
    RAISE EXCEPTION 'Only an administrator can replace the chart of accounts.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gl_chart_templates WHERE country_code = v_c) THEN
    RAISE EXCEPTION 'There is no chart template for "%".', v_c USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- one at a time, and nothing posts meanwhile
  LOCK TABLE public.gl_accounts, public.posting_rules IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.journal_lines IN SHARE MODE;
  IF EXISTS (SELECT 1 FROM public.journal_lines) THEN
    RAISE EXCEPTION 'The chart can only be replaced before anything has been posted. Add or rename accounts instead.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0. detach every account, so any of them can change between header and postable
  UPDATE public.gl_accounts SET parent_id = NULL WHERE parent_id IS NOT NULL;

  -- 1. every template account exists, active, with its name and type
  FOR v_t IN SELECT * FROM public.gl_chart_templates WHERE country_code = v_c ORDER BY code LOOP
    IF EXISTS (SELECT 1 FROM public.gl_accounts WHERE code = v_t.code) THEN
      UPDATE public.gl_accounts
         SET name = v_t.name, name_ar = v_t.name_ar, account_type = v_t.account_type, is_active = true,
             -- a header becomes one after the rules move off it (step 3)
             is_postable = CASE WHEN v_t.is_postable THEN true ELSE is_postable END
       WHERE code = v_t.code;
      v_updated := v_updated + 1;
    ELSE
      INSERT INTO public.gl_accounts (id, code, name, name_ar, account_type, parent_id, is_postable)
      VALUES (md5('gl_account:' || v_t.code)::uuid, v_t.code, v_t.name, v_t.name_ar, v_t.account_type, NULL, v_t.is_postable);
      v_created := v_created + 1;
    END IF;
  END LOOP;

  -- 2. the posting rules point where the template says
  UPDATE public.posting_rules r
     SET account_id = a.id
    FROM public.gl_chart_templates t
    JOIN public.gl_accounts a ON a.code = t.code
   WHERE t.country_code = v_c AND t.role = r.role AND r.account_id <> a.id;
  INSERT INTO public.posting_rules (role, account_id)
  SELECT t.role, a.id
    FROM public.gl_chart_templates t JOIN public.gl_accounts a ON a.code = t.code
   WHERE t.country_code = v_c AND t.role IS NOT NULL
  ON CONFLICT (role) DO NOTHING;

  -- 3. the template's headers are headers
  UPDATE public.gl_accounts a SET is_postable = false
    FROM public.gl_chart_templates t
   WHERE t.country_code = v_c AND t.code = a.code AND NOT t.is_postable AND a.is_postable;

  -- 4. each account under its parent
  UPDATE public.gl_accounts a SET parent_id = p.id
    FROM public.gl_chart_templates t JOIN public.gl_accounts p ON p.code = t.parent_code
   WHERE t.country_code = v_c AND t.code = a.code AND t.parent_code IS NOT NULL;

  -- 5. what the template does not have goes (nothing has been posted to it)
  DELETE FROM public.gl_accounts a
   WHERE NOT EXISTS (SELECT 1 FROM public.gl_chart_templates t WHERE t.country_code = v_c AND t.code = a.code);
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  INSERT INTO public.rma_config (config_key, config_value, updated_by)
  VALUES ('chart_template', to_jsonb(v_c), public.rma_current_user_email())
  ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_by = EXCLUDED.updated_by, updated_date = now();

  RETURN jsonb_build_object('country', v_c, 'created', v_created, 'updated', v_updated, 'removed', v_removed);
END $fn$;

-- ── 3. import accounts from a list (a CSV parsed in the browser) ─────────────
CREATE OR REPLACE FUNCTION public.rma_import_chart_accounts(p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_r       jsonb;
  v_code    text;
  v_name    text;
  v_name_ar text;
  v_type    text;
  v_parent  text;
  v_pid     uuid;
  v_header  boolean;
  v_out     jsonb := '[]'::jsonb;
BEGIN
  IF NOT COALESCE(public.rma_is_admin(), false) THEN
    RAISE EXCEPTION 'Only an administrator can import accounts.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Nothing to import.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'At most 2000 accounts at a time.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- by code, so a parent (a shorter or smaller code) usually comes first
  FOR v_r IN SELECT e FROM jsonb_array_elements(p_rows) e ORDER BY btrim(COALESCE(e ->> 'code', '')) LOOP
    v_code    := btrim(COALESCE(v_r ->> 'code', ''));
    v_name    := btrim(COALESCE(v_r ->> 'name', ''));
    v_name_ar := NULLIF(btrim(COALESCE(v_r ->> 'name_ar', '')), '');
    v_type    := lower(btrim(COALESCE(v_r ->> 'type', '')));
    v_parent  := NULLIF(btrim(COALESCE(v_r ->> 'parent_code', '')), '');
    v_header  := lower(btrim(COALESCE(v_r ->> 'header', ''))) IN ('true', '1', 'yes', 'y');
    BEGIN
      IF v_code = '' THEN
        RAISE EXCEPTION 'A row has no code.';
      END IF;
      IF v_name = '' THEN
        RAISE EXCEPTION 'Account % has no name.', v_code;
      END IF;
      IF EXISTS (SELECT 1 FROM public.gl_accounts WHERE code = v_code) THEN
        UPDATE public.gl_accounts SET name = v_name, name_ar = COALESCE(v_name_ar, name_ar) WHERE code = v_code;
        v_out := v_out || jsonb_build_object('code', v_code, 'status', 'updated');
      ELSE
        IF v_type NOT IN ('asset', 'liability', 'equity', 'income', 'expense') THEN
          RAISE EXCEPTION 'Account %: the type must be asset, liability, equity, income or expense.', v_code;
        END IF;
        IF v_parent IS NOT NULL THEN
          SELECT id INTO v_pid FROM public.gl_accounts WHERE code = v_parent;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Account %: its parent % does not exist.', v_code, v_parent;
          END IF;
        ELSE
          v_pid := NULL;
        END IF;
        INSERT INTO public.gl_accounts (code, name, name_ar, account_type, parent_id, is_postable)
        VALUES (v_code, v_name, v_name_ar, v_type, v_pid, NOT v_header);
        v_out := v_out || jsonb_build_object('code', v_code, 'status', 'created');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || jsonb_build_object('code', NULLIF(v_code, ''), 'status', 'error', 'message', SQLERRM);
    END;
  END LOOP;
  RETURN v_out;
END $fn$;

REVOKE ALL ON FUNCTION public.rma_apply_chart_template(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rma_import_chart_accounts(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_apply_chart_template(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rma_import_chart_accounts(jsonb) TO authenticated, service_role;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_c text;
BEGIN
  FOREACH v_c IN ARRAY ARRAY['EG', 'AE', 'SA'] LOOP
    IF (SELECT count(*) FROM public.gl_chart_templates WHERE country_code = v_c AND role IS NOT NULL) <> 16 THEN
      RAISE EXCEPTION 'Refusing to finish: the % template does not give every posting role an account', v_c;
    END IF;
    IF EXISTS (SELECT 1 FROM public.gl_chart_templates t WHERE t.country_code = v_c AND t.parent_code IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM public.gl_chart_templates p
                                   WHERE p.country_code = v_c AND p.code = t.parent_code AND NOT p.is_postable))
       OR EXISTS (SELECT 1 FROM public.gl_chart_templates WHERE country_code = v_c AND role IS NOT NULL AND NOT is_postable) THEN
      RAISE EXCEPTION 'Refusing to finish: the % template has a parent that is not a header, or a role on a header', v_c;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.gl_chart_templates', 'INSERT')
     OR has_function_privilege('anon', 'public.rma_apply_chart_template(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: the templates are writable, or anon can apply one';
  END IF;
END $$;
