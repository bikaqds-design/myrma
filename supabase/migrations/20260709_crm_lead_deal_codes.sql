-- 20260709_crm_lead_deal_codes.sql
-- Add auto-generated reference codes to leads and deals.
-- Format: LD-XXXXXXXX (leads), DL-XXXXXXXX (deals) — same pattern as CB-XXXXXXXX for customers.
-- Codes are generated client-side on create; existing rows get backfilled here.
-- The deal_code persists when a deal evolves to quotation → sales order → invoice (same row).
-- The lead_code stays on the lead; the converted customer gets its own CB- code.

-- ── leads.lead_code ──────────────────────────────────────────────────────────
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS lead_code TEXT;

-- Backfill existing rows that have no code yet
UPDATE public.leads
SET lead_code = 'LD-' || floor(10000000 + random() * 89999999)::bigint::text
WHERE lead_code IS NULL;

-- ── deals.deal_code ──────────────────────────────────────────────────────────
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS deal_code TEXT;

-- Backfill existing rows
UPDATE public.deals
SET deal_code = 'DL-' || floor(10000000 + random() * 89999999)::bigint::text
WHERE deal_code IS NULL;
