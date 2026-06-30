-- Allow 'converted' as a quotation status.
-- When a quotation is converted to a Sales Order the status is set to 'converted'
-- so the QT detail page can lock all action buttons and prevent re-conversion.

ALTER TABLE public.quotations
  DROP CONSTRAINT IF EXISTS quotations_status_check;

ALTER TABLE public.quotations
  ADD CONSTRAINT quotations_status_check
    CHECK (status IN ('draft','sent','accepted','declined','expired','cancelled','converted'));
