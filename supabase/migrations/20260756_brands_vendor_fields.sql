-- ═══════════════════════════════════════════════════════════════════════════
--  Purchasing Redesign — Brands become Vendors (step 1 of 7)
--
--  `brands` predates the migration history (created directly in Supabase,
--  never via a tracked migration) — this is the FIRST migration to ever
--  touch it. The CREATE TABLE below is a defensive bootstrap matching the
--  exact live shape (confirmed via information_schema against production,
--  2026-07-05), so this migration also applies cleanly on a from-scratch
--  database. It is a no-op on any database where the table already exists.
--
--  Adds vendor-facing fields so a Brand can also serve as a Purchasing
--  vendor: contact_person, email, phone, tax_id, payment_terms — the same
--  fields the (now-removed, see 20260757) standalone `vendors` table had.
--
--  Also widens `brands` write access from admin-only to manager+, so
--  vendor details can be edited from the Purchasing module by managers,
--  not just admins (matches how every other Purchasing action is gated).
--  Brand deletion stays admin-only — unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.brands (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_name        text        NOT NULL,
  brand_description text,
  brand_logo_url    text,
  status            text        DEFAULT 'active',
  created_date      timestamptz DEFAULT now(),
  created_by        text,
  updated_date      timestamptz DEFAULT now(),
  updated_by        text
);

ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS contact_person text,
  ADD COLUMN IF NOT EXISTS email          text,
  ADD COLUMN IF NOT EXISTS phone          text,
  ADD COLUMN IF NOT EXISTS tax_id         text,
  ADD COLUMN IF NOT EXISTS payment_terms  text;

ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;

-- Read access unchanged (staff_read already covers this via 20260526's loop
-- if it ran; re-asserted here in case this is the from-scratch bootstrap path).
DROP POLICY IF EXISTS "staff_read" ON public.brands;
CREATE POLICY "staff_read"
  ON public.brands FOR SELECT
  USING (public.rma_is_staff());

-- Widen write access: admin-only -> manager+ (user-approved 2026-07-05).
DROP POLICY IF EXISTS "admin_write" ON public.brands;
DROP POLICY IF EXISTS "manager_write_brands" ON public.brands;
CREATE POLICY "manager_write_brands"
  ON public.brands FOR INSERT
  WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS "admin_update" ON public.brands;
DROP POLICY IF EXISTS "manager_update_brands" ON public.brands;
CREATE POLICY "manager_update_brands"
  ON public.brands FOR UPDATE
  USING (public.rma_is_manager_or_above())
  WITH CHECK (public.rma_is_manager_or_above());

-- Delete stays admin-only — unchanged.
DROP POLICY IF EXISTS "admin_delete" ON public.brands;
CREATE POLICY "admin_delete"
  ON public.brands FOR DELETE
  USING (public.rma_is_admin());
