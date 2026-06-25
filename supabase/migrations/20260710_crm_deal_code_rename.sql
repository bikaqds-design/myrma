-- 20260710_crm_deal_code_rename.sql
-- Rename deal_code prefix from DL- to QT- (Quotation) to distinguish clearly
-- from lead codes (LD-). Deals evolve into Quotation → Sales Order → Invoice,
-- so QT- better reflects the document lifecycle.
-- Only renames rows backfilled by 20260709; new codes are generated client-side as QT-.

UPDATE public.deals
SET deal_code = 'QT-' || substr(deal_code, 4)
WHERE deal_code LIKE 'DL-%';
