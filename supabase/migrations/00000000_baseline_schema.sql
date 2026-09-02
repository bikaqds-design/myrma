-- ============================================================================
-- 00000000_baseline_schema.sql
--
-- Generated from the live database by supabase/manual/GENERATE_baseline_schema.sql
-- Generated at: 2026-09-01 16:31:53.470417+00
--
-- The complete public schema. Twenty of these tables were created by no
-- migration in this repo, so before this file existed a clean Supabase
-- project could not be provisioned from source at all.
--
-- ON A FRESH DATABASE: run this file, then 00000001_baseline_reference_data.sql.
-- Do NOT then replay the historical migrations - this already reflects their
-- end state, and re-running them would re-apply ALTERs against a schema that
-- already has them.
--
-- VERIFIED on 2026-09-01 by applying this file to a brand-new, empty Supabase
-- project, then fingerprinting the result against production. Columns,
-- constraints, policies, views and triggers all matched exactly; function
-- bodies matched once carriage returns were normalised (production stores
-- CRLF inside 85 function bodies, inherited from Windows-authored migrations;
-- this file is LF throughout, which changes nothing about behaviour).
--
-- That run found four defects that no amount of reading the file would have
-- caught, all now fixed here and in the generator:
--   1. no CREATE EXTENSION, so uuid_generate_v4() did not exist and the first
--      of five tables using it failed;
--   2. the seven generated columns were emitted as DEFAULT, which Postgres
--      rejects outright ("cannot use column reference in DEFAULT expression");
--   3. functions are emitted alphabetically and some call others, so a
--      SQL-language body was validated before its callee existed -- hence the
--      SET check_function_bodies = false above, which is what pg_dump emits;
--   4. COMMENT ON TABLE was emitted for views, which Postgres refuses.
--
-- Objects emitted:
--   2 extensions, 1 sequences, 62 tables, 165 pk/unique/check, 64 foreign keys,
--   96 indexes, 89 functions, 6 views, 30 triggers,
--   62 tables with RLS, 199 policies, 168 grants, 27 comments
--
-- Not included: non-public schemas, roles, storage buckets, column-level
-- privileges, and data.
-- ============================================================================

-- Functions are emitted alphabetically, and some call others -- rma_can_handle_cash()
-- calls rma_is_manager_or_above(), which sorts after it. SQL-language bodies are
-- validated at CREATE time, so that ordering fails. This is the same guard
-- pg_dump emits, for the same reason.
SET check_function_bodies = false;

-- Extensions
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Sequences
CREATE SEQUENCE IF NOT EXISTS public.ticket_activity_id_seq;

-- Tables
CREATE TABLE IF NOT EXISTS public.activities (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  related_type text NOT NULL,
  related_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  due_date timestamp with time zone,
  completed_at timestamp with time zone,
  assigned_rep text,
  outcome_notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by text,
  attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
  parent_id uuid
);

CREATE TABLE IF NOT EXISTS public.announcements (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  type text DEFAULT 'info'::text NOT NULL,
  is_active boolean DEFAULT true,
  start_date timestamp with time zone,
  end_date timestamp with time zone,
  created_by text,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.branding_settings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  company_name text DEFAULT 'myRMA 2.0'::text,
  logo_url text,
  primary_color text DEFAULT '#4F46E5'::text,
  secondary_color text DEFAULT '#818CF8'::text,
  accent_color text DEFAULT '#10B981'::text,
  updated_by text,
  updated_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.brands (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  brand_name text NOT NULL,
  brand_description text,
  brand_logo_url text,
  status text DEFAULT 'active'::text,
  created_date timestamp with time zone DEFAULT now(),
  created_by text,
  updated_date timestamp with time zone DEFAULT now(),
  updated_by text,
  contact_person text,
  email text,
  phone text,
  tax_id text,
  payment_terms text,
  country_code character(2)
);

CREATE TABLE IF NOT EXISTS public.categories (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  brand_id uuid,
  category_name text NOT NULL,
  category_description text,
  status text DEFAULT 'active'::text,
  created_date timestamp with time zone DEFAULT now(),
  created_by text,
  updated_date timestamp with time zone DEFAULT now(),
  updated_by text
);

CREATE TABLE IF NOT EXISTS public.contacts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid NOT NULL,
  full_name text NOT NULL,
  title text,
  phone text,
  email text,
  is_primary boolean DEFAULT false NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by text
);

CREATE TABLE IF NOT EXISTS public.countries (
  code character(2) NOT NULL,
  name text NOT NULL,
  dial_code text NOT NULL,
  currency_code character(3),
  trunk_prefix text DEFAULT '0'::text NOT NULL,
  mobile_prefixes text[] DEFAULT '{}'::text[] NOT NULL,
  mobile_digits smallint,
  has_area_codes boolean DEFAULT false NOT NULL,
  landline_digits smallint,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.country_area_codes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  country_code character(2) NOT NULL,
  area_code text NOT NULL,
  name text NOT NULL,
  digits smallint NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.credit_note_applications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  credit_note_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount_applied numeric(12,2) NOT NULL,
  applied_date timestamp with time zone DEFAULT now() NOT NULL,
  applied_by text NOT NULL,
  is_reversal boolean DEFAULT false NOT NULL,
  reverses_application_id uuid,
  reversal_reason text
);

CREATE TABLE IF NOT EXISTS public.credit_notes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  cn_code text,
  type text NOT NULL,
  source_invoice_id uuid,
  source_invoice_number text,
  ticket_id uuid,
  customer_id uuid NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  line_items jsonb DEFAULT '[]'::jsonb NOT NULL,
  subtotal numeric(12,2) DEFAULT 0 NOT NULL,
  tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
  total numeric(12,2) DEFAULT 0 NOT NULL,
  applied_amount numeric(12,2) DEFAULT 0 NOT NULL,
  remaining_balance numeric(12,2) DEFAULT 0 NOT NULL,
  reason text NOT NULL,
  affects_inventory boolean GENERATED ALWAYS AS ((type = 'rma_return'::text)) STORED,
  restock_status text DEFAULT 'not_applicable'::text NOT NULL,
  assigned_rep text,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  issued_at timestamp with time zone,
  archived boolean DEFAULT false NOT NULL,
  archived_at timestamp with time zone,
  archived_by text,
  voided_at timestamp with time zone,
  voided_by text,
  void_reason text
);

CREATE TABLE IF NOT EXISTS public.crm_invoices (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  inv_code text,
  so_id uuid,
  customer_id uuid NOT NULL,
  doc_status text DEFAULT 'draft'::text NOT NULL,
  payment_status text DEFAULT 'unpaid'::text NOT NULL,
  line_items jsonb DEFAULT '[]'::jsonb NOT NULL,
  subtotal numeric(12,2) DEFAULT 0 NOT NULL,
  discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
  tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
  total numeric(12,2) DEFAULT 0 NOT NULL,
  amount_paid numeric(12,2) DEFAULT 0 NOT NULL,
  due_date date,
  payment_terms text,
  reference_po text,
  notes text,
  void_reason text,
  assigned_rep text,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  posted_at timestamp with time zone,
  paid_at timestamp with time zone,
  archived boolean DEFAULT false NOT NULL,
  archived_at timestamp with time zone,
  archived_by text,
  cogs_base numeric(12,2),
  cogs_unknown_qty integer DEFAULT 0 NOT NULL,
  cogs_complete boolean GENERATED ALWAYS AS (((cogs_base IS NOT NULL) AND (cogs_unknown_qty = 0))) STORED
);

CREATE TABLE IF NOT EXISTS public.currencies (
  code character(3) NOT NULL,
  name text NOT NULL,
  symbol text NOT NULL,
  decimals smallint DEFAULT 2 NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.custom_field_definitions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  field_name text NOT NULL,
  field_label text NOT NULL,
  field_type text NOT NULL,
  applies_to text NOT NULL,
  is_required boolean DEFAULT false,
  is_active boolean DEFAULT true,
  field_options jsonb,
  sort_order integer DEFAULT 0,
  created_by text,
  created_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.custom_roles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  role_name text NOT NULL,
  role_description text,
  permissions jsonb NOT NULL,
  created_by text NOT NULL,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now(),
  base_role text DEFAULT 'viewer'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.customer_notes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid,
  note text NOT NULL,
  created_by text,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.customers (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now(),
  customer_code text NOT NULL,
  customer_type text NOT NULL,
  customer_status text DEFAULT 'Active'::text,
  company_name text,
  contact_person text,
  mobile text,
  landline text,
  email text,
  address text,
  account_manager text,
  cr_number text,
  tax_id text,
  company_documents jsonb DEFAULT '[]'::jsonb,
  linked_user_email text,
  notes text,
  job_title text,
  status text DEFAULT 'active'::text,
  preferred_contact text DEFAULT 'email'::text,
  address_street text,
  address_city text,
  address_state text,
  address_postal_code text,
  address_country text DEFAULT 'Egypt'::text,
  tags text[] DEFAULT '{}'::text[],
  profile_photo_url text,
  created_by text,
  updated_by text,
  attachments jsonb DEFAULT '[]'::jsonb,
  lifecycle_stage text DEFAULT 'customer'::text,
  lead_source text,
  assigned_rep text,
  last_activity_at timestamp with time zone,
  credit_limit numeric(12,2),
  country_code character(2)
);

CREATE TABLE IF NOT EXISTS public.deals (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  title text NOT NULL,
  customer_id uuid NOT NULL,
  contact_id uuid,
  pipeline_id uuid NOT NULL,
  stage text NOT NULL,
  value numeric(12,2),
  probability integer DEFAULT 0 NOT NULL,
  expected_close_date date,
  assigned_rep text,
  product_lines jsonb DEFAULT '[]'::jsonb NOT NULL,
  status text DEFAULT 'open'::text NOT NULL,
  lost_reason text,
  won_at timestamp with time zone,
  lost_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by text,
  updated_at timestamp with time zone,
  deal_code text
);

CREATE TABLE IF NOT EXISTS public.document_sequences (
  seq_type text NOT NULL,
  last_value integer DEFAULT 0 NOT NULL,
  seq_year integer NOT NULL
);

CREATE TABLE IF NOT EXISTS public.email_queue (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  recipient_email text NOT NULL,
  template_name text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text DEFAULT 'pending'::text,
  error_message text,
  sent_date timestamp with time zone,
  created_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_settings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  provider text DEFAULT 'resend'::text,
  api_key text,
  from_email text DEFAULT 'noreply@yourdomain.com'::text,
  from_name text DEFAULT 'myRMA System'::text,
  is_active boolean DEFAULT false,
  updated_by text,
  updated_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  template_name text NOT NULL,
  template_subject text NOT NULL,
  template_body text NOT NULL,
  variables jsonb DEFAULT '[]'::jsonb,
  is_active boolean DEFAULT true,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now(),
  updated_by text
);

CREATE TABLE IF NOT EXISTS public.inventory_units (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  rma_ticket_id uuid,
  rma_number text,
  product_name text,
  serial_number text,
  warranty_status text,
  status text DEFAULT 'active_rma'::text,
  resolution_type text,
  resolved_date timestamp with time zone,
  manufacturer_batch_id uuid,
  notes text,
  created_date timestamp with time zone DEFAULT now(),
  warehouse_id uuid,
  reservation_status text DEFAULT 'available'::text NOT NULL,
  reserved_by_doc_type text,
  reserved_by_doc_id uuid,
  reserved_at timestamp with time zone,
  reserved_by_email text,
  product_id uuid,
  vendor_invoice_id uuid,
  unit_cost_base numeric(14,4)
);

CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  invoice_number text NOT NULL,
  ticket_id uuid,
  customer_id uuid,
  customer_name text,
  customer_email text,
  status text DEFAULT 'draft'::text NOT NULL,
  type text DEFAULT 'invoice'::text NOT NULL,
  line_items jsonb DEFAULT '[]'::jsonb NOT NULL,
  labour_hours numeric(6,2) DEFAULT 0 NOT NULL,
  labour_rate numeric(10,2) DEFAULT 0 NOT NULL,
  discount_pct numeric(5,2) DEFAULT 0 NOT NULL,
  tax_pct numeric(5,2) DEFAULT 0 NOT NULL,
  notes text,
  due_date date,
  paid_date date,
  created_by text,
  created_date timestamp with time zone DEFAULT now() NOT NULL,
  updated_date timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.kb_articles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  title text NOT NULL,
  slug text NOT NULL,
  body text NOT NULL,
  category text DEFAULT 'general'::text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  is_published boolean DEFAULT false NOT NULL,
  created_by text,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.leads (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  full_name text NOT NULL,
  company_name text,
  phone text,
  email text,
  source text NOT NULL,
  status text DEFAULT 'new'::text NOT NULL,
  assigned_rep text,
  notes text,
  converted_at timestamp with time zone,
  converted_customer_id uuid,
  converted_deal_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by text,
  updated_at timestamp with time zone,
  lead_code text
);

CREATE TABLE IF NOT EXISTS public.manufacturer_batches (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  batch_number text,
  manufacturer_name text,
  status text DEFAULT 'draft'::text,
  sent_date date,
  tracking_number text,
  resolution_type text,
  resolution_date date,
  resolution_notes text,
  unit_count integer DEFAULT 0,
  created_date timestamp with time zone DEFAULT now(),
  created_by text
);

CREATE TABLE IF NOT EXISTS public.notification_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  ticket_id uuid,
  event_type text NOT NULL,
  provider text DEFAULT 'whatsapp'::text NOT NULL,
  recipient text NOT NULL,
  recipient_name text,
  template_id uuid,
  message_content text,
  delivery_status text DEFAULT 'pending'::text NOT NULL,
  whatsapp_message_id text,
  sent_at timestamp with time zone DEFAULT now() NOT NULL,
  delivered_at timestamp with time zone,
  read_at timestamp with time zone,
  response_data jsonb,
  error_message text,
  retry_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_email text NOT NULL,
  ticket_created boolean DEFAULT true,
  ticket_assigned boolean DEFAULT true,
  ticket_status_changed boolean DEFAULT true,
  ticket_priority_changed boolean DEFAULT true,
  comment_added boolean DEFAULT true,
  ticket_due_soon boolean DEFAULT true,
  ticket_overdue boolean DEFAULT true,
  daily_summary boolean DEFAULT false,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notification_queue (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  job_type text DEFAULT 'whatsapp'::text NOT NULL,
  event_type text NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  priority integer DEFAULT 5 NOT NULL,
  retry_count integer DEFAULT 0 NOT NULL,
  max_retries integer DEFAULT 3 NOT NULL,
  scheduled_at timestamp with time zone DEFAULT now() NOT NULL,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  error_message text,
  result jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by text
);

CREATE TABLE IF NOT EXISTS public.notification_settings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  setting_key text NOT NULL,
  setting_value jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by text
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  entity_type text,
  entity_id text,
  entity_ref text,
  created_by text,
  created_date timestamp with time zone DEFAULT now(),
  target_roles text[] DEFAULT '{}'::text[],
  target_emails text[] DEFAULT '{}'::text[],
  read_by text[] DEFAULT '{}'::text[]
);

CREATE TABLE IF NOT EXISTS public.parts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  part_name text NOT NULL,
  part_number text,
  quantity integer DEFAULT 0 NOT NULL,
  unit_cost numeric(10,2) DEFAULT 0,
  supplier text,
  reorder_level integer DEFAULT 5 NOT NULL,
  location text,
  notes text,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now(),
  reserved_quantity integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.payment_applications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount_applied numeric(12,2) NOT NULL,
  applied_date timestamp with time zone DEFAULT now() NOT NULL,
  applied_by text NOT NULL,
  is_reversal boolean DEFAULT false NOT NULL,
  reverses_application_id uuid,
  reversal_reason text
);

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  payment_code text,
  customer_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  unapplied_amount numeric(12,2) DEFAULT 0 NOT NULL,
  method text NOT NULL,
  reference_number text,
  payment_date date DEFAULT CURRENT_DATE NOT NULL,
  notes text,
  status text DEFAULT 'active'::text NOT NULL,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  voided_at timestamp with time zone,
  voided_by text,
  void_reason text
);

CREATE TABLE IF NOT EXISTS public.pipelines (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  stages jsonb NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.product_documents (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  product_id uuid NOT NULL,
  title text NOT NULL,
  doc_type text DEFAULT 'datasheet'::text NOT NULL,
  description text,
  file_name text NOT NULL,
  file_url text NOT NULL,
  storage_path text NOT NULL,
  file_size integer,
  mime_type text,
  extracted_text text,
  extraction_status text DEFAULT 'pending'::text NOT NULL,
  page_count integer,
  uploaded_by text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (((setweight(to_tsvector('simple'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, COALESCE(description, ''::text)), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, COALESCE(extracted_text, ''::text)), 'C'::"char"))) STORED
);

CREATE TABLE IF NOT EXISTS public.product_images (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  product_id uuid,
  image_url text NOT NULL,
  image_path text NOT NULL,
  is_primary boolean DEFAULT false,
  display_order integer DEFAULT 0,
  uploaded_by text,
  uploaded_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.products (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now(),
  sku text NOT NULL,
  product_name text NOT NULL,
  brand text,
  category text,
  subcategory text,
  model text,
  product_type text DEFAULT 'Hardware'::text,
  product_status text DEFAULT 'active'::text,
  warranty_period_months integer DEFAULT 12,
  description text,
  product_link text,
  product_photo text,
  notes text,
  brand_id uuid,
  category_id uuid,
  subcategory_id uuid,
  warranty_months integer DEFAULT 12,
  status text DEFAULT 'active'::text,
  product_image_url text,
  updated_by text,
  product_description text,
  created_by text,
  stock_tracking_mode text DEFAULT 'serialized'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  po_code text NOT NULL,
  vendor_id uuid NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  line_items jsonb DEFAULT '[]'::jsonb NOT NULL,
  total numeric(12,2) DEFAULT 0 NOT NULL,
  expected_delivery_date date,
  notes text,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone,
  issue_date date DEFAULT CURRENT_DATE,
  currency character(3) NOT NULL,
  payment_terms text,
  delivery_terms text,
  shipping_address text,
  billing_address text,
  terms_conditions text,
  subtotal numeric(12,2) DEFAULT 0 NOT NULL,
  discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
  tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
  archived boolean DEFAULT false NOT NULL,
  archived_at timestamp with time zone,
  archived_by text,
  exchange_rate numeric(18,8) DEFAULT 1 NOT NULL,
  total_base numeric(12,2) GENERATED ALWAYS AS (round((total * exchange_rate), 2)) STORED
);

CREATE TABLE IF NOT EXISTS public.quotations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  qt_code text NOT NULL,
  deal_id uuid,
  customer_id uuid NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  line_items jsonb DEFAULT '[]'::jsonb NOT NULL,
  subtotal numeric(12,2) DEFAULT 0 NOT NULL,
  discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
  tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
  total numeric(12,2) DEFAULT 0 NOT NULL,
  validity_until date,
  payment_terms text,
  reference_po text,
  notes text,
  assigned_rep text,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  archived boolean DEFAULT false NOT NULL,
  archived_at timestamp with time zone,
  archived_by text
);

CREATE TABLE IF NOT EXISTS public.rma_config (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  config_key text NOT NULL,
  config_value jsonb NOT NULL,
  updated_by text,
  updated_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rma_tickets (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now(),
  rma_number text NOT NULL,
  customer_id uuid,
  customer_name text,
  products jsonb DEFAULT '[]'::jsonb,
  product_id uuid,
  product_name text,
  product_serial text,
  brand text,
  quantity integer DEFAULT 1,
  warranty_status text,
  damage_level text,
  rma_description text,
  accessories_received text,
  resolution_notes text,
  ticket_status text DEFAULT 'New'::text,
  priority text DEFAULT 'Medium'::text,
  assigned_technician text,
  account_manager text,
  spare_parts_used jsonb DEFAULT '[]'::jsonb,
  repair_cost numeric(10,2),
  repair_cost_approved boolean DEFAULT false,
  repair_cost_approved_by text,
  due_date date,
  closed_date timestamp with time zone,
  sla_breached boolean DEFAULT false,
  attachments jsonb DEFAULT '[]'::jsonb,
  qr_code text,
  created_by text,
  updated_by text,
  general_description text,
  carrier text,
  tracking_number text,
  shipping_label_url text,
  customer_email text
);

CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  so_code text NOT NULL,
  quotation_id uuid,
  customer_id uuid NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  line_items jsonb DEFAULT '[]'::jsonb NOT NULL,
  subtotal numeric(12,2) DEFAULT 0 NOT NULL,
  discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
  tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
  total numeric(12,2) DEFAULT 0 NOT NULL,
  delivery_date date,
  payment_terms text,
  reference_po text,
  notes text,
  assigned_rep text,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  confirmed_at timestamp with time zone,
  delivered_at timestamp with time zone,
  archived boolean DEFAULT false NOT NULL,
  archived_at timestamp with time zone,
  archived_by text
);

CREATE TABLE IF NOT EXISTS public.stock_moves (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ref_type text NOT NULL,
  ref_id uuid NOT NULL,
  doc_type text NOT NULL,
  doc_id uuid,
  move_type text NOT NULL,
  qty integer NOT NULL,
  from_status text,
  to_status text,
  actor_email text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.subcategories (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  category_id uuid,
  subcategory_name text NOT NULL,
  subcategory_description text,
  status text DEFAULT 'active'::text,
  created_date timestamp with time zone DEFAULT now(),
  created_by text,
  updated_date timestamp with time zone DEFAULT now(),
  updated_by text
);

CREATE TABLE IF NOT EXISTS public.ticket_activity (
  id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  created_date timestamp with time zone DEFAULT now() NOT NULL,
  ticket_id uuid,
  user_email text,
  action_type text,
  action_details jsonb,
  details text
);

CREATE TABLE IF NOT EXISTS public.ticket_comments (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now(),
  ticket_id uuid,
  user_email text,
  comment_text text NOT NULL,
  is_internal boolean DEFAULT false,
  author_name text,
  parent_comment_id uuid,
  attachments jsonb DEFAULT '[]'::jsonb,
  is_customer_comment boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.ticket_parts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ticket_id uuid NOT NULL,
  part_id uuid NOT NULL,
  quantity integer DEFAULT 1 NOT NULL,
  unit_cost numeric(10,2) DEFAULT 0 NOT NULL,
  notes text,
  added_by text,
  created_date timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ticket_resolutions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ticket_id uuid NOT NULL,
  type text NOT NULL,
  replacement_product_name text,
  replacement_serial text,
  amount numeric(10,2),
  currency text DEFAULT 'USD'::text,
  reason text,
  reference_number text,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.time_entries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ticket_id uuid NOT NULL,
  user_email text NOT NULL,
  started_at timestamp with time zone NOT NULL,
  ended_at timestamp with time zone,
  duration_min integer,
  notes text,
  created_date timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_activity_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_email text NOT NULL,
  action_type text NOT NULL,
  action_details jsonb,
  ip_address text,
  user_agent text,
  created_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_permissions (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now(),
  user_email text NOT NULL,
  role_name text NOT NULL,
  permissions jsonb NOT NULL,
  linked_customer_id uuid,
  is_active boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.user_preferences (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_email text NOT NULL,
  prefs jsonb DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_email text NOT NULL,
  role text NOT NULL,
  created_date timestamp with time zone DEFAULT now(),
  permissions jsonb DEFAULT '{}'::jsonb,
  role_type text DEFAULT 'preset'::text,
  status text DEFAULT 'active'::text NOT NULL,
  last_login timestamp with time zone,
  expiration_date timestamp with time zone,
  notes text,
  suspended_reason text,
  suspended_by text,
  suspended_date timestamp with time zone,
  password_hash text,
  access_expires_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.vendor_invoice_charges (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  vendor_invoice_id uuid NOT NULL,
  charge_type text NOT NULL,
  description text,
  amount numeric(12,2) NOT NULL,
  created_by text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.vendor_invoices (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  vi_code text,
  purchase_order_id uuid,
  vendor_id uuid NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  line_items jsonb DEFAULT '[]'::jsonb NOT NULL,
  total numeric(12,2) DEFAULT 0 NOT NULL,
  invoice_date date,
  notes text,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  approved_at timestamp with time zone,
  received_at timestamp with time zone,
  due_date date,
  subtotal numeric(12,2) DEFAULT 0 NOT NULL,
  discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
  tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
  archived boolean DEFAULT false NOT NULL,
  archived_at timestamp with time zone,
  archived_by text,
  amount_paid numeric(12,2) DEFAULT 0 NOT NULL,
  payment_status text DEFAULT 'unpaid'::text NOT NULL,
  paid_at timestamp with time zone,
  updated_at timestamp with time zone,
  currency character(3) NOT NULL,
  exchange_rate numeric(18,8) DEFAULT 1 NOT NULL,
  total_base numeric(12,2) GENERATED ALWAYS AS (round((total * exchange_rate), 2)) STORED
);

CREATE TABLE IF NOT EXISTS public.vendor_payment_applications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount_applied numeric(12,2) NOT NULL,
  applied_date timestamp with time zone DEFAULT now() NOT NULL,
  applied_by text NOT NULL,
  is_reversal boolean DEFAULT false NOT NULL,
  reverses_application_id uuid,
  reversal_reason text
);

CREATE TABLE IF NOT EXISTS public.vendor_payments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  payment_code text,
  vendor_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  unapplied_amount numeric(12,2) DEFAULT 0 NOT NULL,
  method text NOT NULL,
  reference_number text,
  payment_date date DEFAULT CURRENT_DATE NOT NULL,
  notes text,
  status text DEFAULT 'active'::text NOT NULL,
  voided_at timestamp with time zone,
  voided_by text,
  void_reason text,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  currency character(3) DEFAULT 'EGP'::bpchar NOT NULL,
  exchange_rate numeric(18,8) DEFAULT 1 NOT NULL,
  amount_base numeric(12,2) GENERATED ALWAYS AS (round((amount * exchange_rate), 2)) STORED
);

CREATE TABLE IF NOT EXISTS public.warehouse_stock (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  product_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  quantity integer DEFAULT 0 NOT NULL,
  reserved_quantity integer DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  total_cost_base numeric(18,4) DEFAULT 0 NOT NULL,
  uncosted_quantity integer DEFAULT 0 NOT NULL,
  avg_cost_base numeric(14,4) GENERATED ALWAYS AS (
CASE
    WHEN ((quantity - uncosted_quantity) > 0) THEN round((total_cost_base / ((quantity - uncosted_quantity))::numeric), 4)
    ELSE NULL::numeric
END) STORED
);

CREATE TABLE IF NOT EXISTS public.warehouses (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  code text,
  description text,
  location text,
  is_active boolean DEFAULT true,
  created_date timestamp with time zone DEFAULT now(),
  created_by text,
  warehouse_type text,
  manager text,
  notes text,
  is_system boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS public.webhooks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  events jsonb DEFAULT '[]'::jsonb NOT NULL,
  is_active boolean DEFAULT true,
  secret_key text,
  last_triggered_at timestamp with time zone,
  created_by text,
  created_date timestamp with time zone DEFAULT now(),
  updated_date timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  display_name text NOT NULL,
  event_type text NOT NULL,
  provider text DEFAULT 'whatsapp'::text NOT NULL,
  language text DEFAULT 'en'::text NOT NULL,
  template_name text,
  header_type text,
  header_content text,
  body_content text NOT NULL,
  footer_content text,
  variables jsonb DEFAULT '[]'::jsonb NOT NULL,
  attach_pdf boolean DEFAULT false NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by text
);

-- Primary keys, unique and check constraints
ALTER TABLE public.activities ADD CONSTRAINT activities_pkey PRIMARY KEY (id);
ALTER TABLE public.activities ADD CONSTRAINT chk_activity_related_type CHECK ((related_type = ANY (ARRAY['lead'::text, 'deal'::text, 'customer'::text, 'contact'::text, 'purchase_order'::text, 'vendor_invoice'::text]))) NOT VALID;
ALTER TABLE public.activities ADD CONSTRAINT chk_activity_type CHECK ((type = ANY (ARRAY['call'::text, 'meeting'::text, 'whatsapp'::text, 'email'::text, 'note'::text, 'task'::text, 'log'::text, 'approval'::text]))) NOT VALID;
ALTER TABLE public.announcements ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);
ALTER TABLE public.announcements ADD CONSTRAINT announcements_type_check CHECK ((type = ANY (ARRAY['info'::text, 'warning'::text, 'success'::text, 'error'::text])));
ALTER TABLE public.branding_settings ADD CONSTRAINT branding_settings_pkey PRIMARY KEY (id);
ALTER TABLE public.brands ADD CONSTRAINT brands_brand_name_key UNIQUE (brand_name);
ALTER TABLE public.brands ADD CONSTRAINT brands_pkey PRIMARY KEY (id);
ALTER TABLE public.brands ADD CONSTRAINT brands_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])));
ALTER TABLE public.categories ADD CONSTRAINT categories_brand_id_category_name_key UNIQUE (brand_id, category_name);
ALTER TABLE public.categories ADD CONSTRAINT categories_pkey PRIMARY KEY (id);
ALTER TABLE public.categories ADD CONSTRAINT categories_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])));
ALTER TABLE public.contacts ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);
ALTER TABLE public.countries ADD CONSTRAINT countries_landline_digits_check CHECK (((landline_digits >= 4) AND (landline_digits <= 15)));
ALTER TABLE public.countries ADD CONSTRAINT countries_mobile_digits_check CHECK (((mobile_digits >= 4) AND (mobile_digits <= 15)));
ALTER TABLE public.countries ADD CONSTRAINT countries_pkey PRIMARY KEY (code);
ALTER TABLE public.country_area_codes ADD CONSTRAINT country_area_codes_country_code_area_code_key UNIQUE (country_code, area_code);
ALTER TABLE public.country_area_codes ADD CONSTRAINT country_area_codes_digits_check CHECK (((digits >= 4) AND (digits <= 12)));
ALTER TABLE public.country_area_codes ADD CONSTRAINT country_area_codes_pkey PRIMARY KEY (id);
ALTER TABLE public.credit_note_applications ADD CONSTRAINT credit_note_applications_amount_applied_check CHECK ((((is_reversal = false) AND (amount_applied > (0)::numeric)) OR ((is_reversal = true) AND (amount_applied < (0)::numeric))));
ALTER TABLE public.credit_note_applications ADD CONSTRAINT credit_note_applications_pkey PRIMARY KEY (id);
ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_cn_code_key UNIQUE (cn_code);
ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_pkey PRIMARY KEY (id);
ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_restock_status_check CHECK ((restock_status = ANY (ARRAY['not_applicable'::text, 'pending'::text, 'restocked'::text])));
ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'issued'::text, 'applied'::text, 'voided'::text])));
ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_type_check CHECK ((type = ANY (ARRAY['rma_return'::text, 'rebate'::text, 'discount'::text, 'correction'::text])));
ALTER TABLE public.crm_invoices ADD CONSTRAINT crm_invoices_cogs_unknown_qty_check CHECK ((cogs_unknown_qty >= 0));
ALTER TABLE public.crm_invoices ADD CONSTRAINT crm_invoices_doc_status_check CHECK ((doc_status = ANY (ARRAY['draft'::text, 'posted'::text, 'cancelled'::text])));
ALTER TABLE public.crm_invoices ADD CONSTRAINT crm_invoices_inv_code_key UNIQUE (inv_code);
ALTER TABLE public.crm_invoices ADD CONSTRAINT crm_invoices_payment_status_check CHECK ((payment_status = ANY (ARRAY['unpaid'::text, 'partial'::text, 'paid'::text, 'reversed'::text])));
ALTER TABLE public.crm_invoices ADD CONSTRAINT crm_invoices_pkey PRIMARY KEY (id);
ALTER TABLE public.currencies ADD CONSTRAINT currencies_decimals_check CHECK (((decimals >= 0) AND (decimals <= 4)));
ALTER TABLE public.currencies ADD CONSTRAINT currencies_pkey PRIMARY KEY (code);
ALTER TABLE public.custom_field_definitions ADD CONSTRAINT custom_field_definitions_applies_to_check CHECK ((applies_to = ANY (ARRAY['ticket'::text, 'customer'::text])));
ALTER TABLE public.custom_field_definitions ADD CONSTRAINT custom_field_definitions_field_type_check CHECK ((field_type = ANY (ARRAY['text'::text, 'number'::text, 'date'::text, 'select'::text, 'textarea'::text, 'checkbox'::text])));
ALTER TABLE public.custom_field_definitions ADD CONSTRAINT custom_field_definitions_pkey PRIMARY KEY (id);
ALTER TABLE public.custom_roles ADD CONSTRAINT chk_custom_base_role CHECK ((base_role = ANY (ARRAY['manager'::text, 'technician'::text, 'viewer'::text, 'sales_rep'::text, 'accountant'::text])));
ALTER TABLE public.custom_roles ADD CONSTRAINT chk_custom_role_name CHECK ((role_name <> ALL (ARRAY['super_admin'::text, 'admin'::text, 'manager'::text, 'technician'::text, 'viewer'::text, 'sales_rep'::text, 'accountant'::text])));
ALTER TABLE public.custom_roles ADD CONSTRAINT custom_roles_pkey PRIMARY KEY (id);
ALTER TABLE public.custom_roles ADD CONSTRAINT custom_roles_role_name_key UNIQUE (role_name);
ALTER TABLE public.customer_notes ADD CONSTRAINT customer_notes_pkey PRIMARY KEY (id);
ALTER TABLE public.customers ADD CONSTRAINT chk_customer_lifecycle_stage CHECK ((lifecycle_stage = ANY (ARRAY['lead'::text, 'prospect'::text, 'customer'::text, 'churned'::text]))) NOT VALID;
ALTER TABLE public.customers ADD CONSTRAINT customers_customer_code_key UNIQUE (customer_code);
ALTER TABLE public.customers ADD CONSTRAINT customers_customer_status_check CHECK ((customer_status = ANY (ARRAY['Active'::text, 'Inactive'::text, 'Blocked'::text])));
ALTER TABLE public.customers ADD CONSTRAINT customers_customer_type_check CHECK ((customer_type = ANY (ARRAY['B2B'::text, 'B2C'::text])));
ALTER TABLE public.customers ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
ALTER TABLE public.deals ADD CONSTRAINT chk_deal_probability CHECK (((probability >= 0) AND (probability <= 100))) NOT VALID;
ALTER TABLE public.deals ADD CONSTRAINT chk_deal_status CHECK ((status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text]))) NOT VALID;
ALTER TABLE public.deals ADD CONSTRAINT deals_pkey PRIMARY KEY (id);
ALTER TABLE public.document_sequences ADD CONSTRAINT document_sequences_pkey PRIMARY KEY (seq_type);
ALTER TABLE public.email_queue ADD CONSTRAINT email_queue_pkey PRIMARY KEY (id);
ALTER TABLE public.email_queue ADD CONSTRAINT email_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])));
ALTER TABLE public.email_settings ADD CONSTRAINT email_settings_pkey PRIMARY KEY (id);
ALTER TABLE public.email_templates ADD CONSTRAINT email_templates_pkey PRIMARY KEY (id);
ALTER TABLE public.email_templates ADD CONSTRAINT email_templates_template_name_key UNIQUE (template_name);
ALTER TABLE public.inventory_units ADD CONSTRAINT inventory_units_pkey PRIMARY KEY (id);
ALTER TABLE public.inventory_units ADD CONSTRAINT inventory_units_reservation_status_check CHECK ((reservation_status = ANY (ARRAY['available'::text, 'reserved'::text, 'delivered'::text])));
ALTER TABLE public.invoices ADD CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number);
ALTER TABLE public.invoices ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);
ALTER TABLE public.kb_articles ADD CONSTRAINT kb_articles_pkey PRIMARY KEY (id);
ALTER TABLE public.kb_articles ADD CONSTRAINT kb_articles_slug_key UNIQUE (slug);
ALTER TABLE public.leads ADD CONSTRAINT chk_lead_source CHECK ((source = ANY (ARRAY['walk-in'::text, 'phone'::text, 'referral'::text, 'exhibition'::text, 'website'::text, 'whatsapp'::text]))) NOT VALID;
ALTER TABLE public.leads ADD CONSTRAINT chk_lead_status CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text, 'qualified'::text, 'nurturing'::text, 'inactive'::text, 'converted'::text, 'disqualified'::text]))) NOT VALID;
ALTER TABLE public.leads ADD CONSTRAINT leads_pkey PRIMARY KEY (id);
ALTER TABLE public.manufacturer_batches ADD CONSTRAINT manufacturer_batches_batch_number_key UNIQUE (batch_number);
ALTER TABLE public.manufacturer_batches ADD CONSTRAINT manufacturer_batches_pkey PRIMARY KEY (id);
ALTER TABLE public.notification_logs ADD CONSTRAINT notification_logs_delivery_status_check CHECK ((delivery_status = ANY (ARRAY['pending'::text, 'queued'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text, 'cancelled'::text])));
ALTER TABLE public.notification_logs ADD CONSTRAINT notification_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.notification_preferences ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);
ALTER TABLE public.notification_preferences ADD CONSTRAINT notification_preferences_user_email_key UNIQUE (user_email);
ALTER TABLE public.notification_queue ADD CONSTRAINT notification_queue_job_type_check CHECK ((job_type = ANY (ARRAY['whatsapp'::text, 'email'::text, 'sms'::text, 'push'::text])));
ALTER TABLE public.notification_queue ADD CONSTRAINT notification_queue_pkey PRIMARY KEY (id);
ALTER TABLE public.notification_queue ADD CONSTRAINT notification_queue_priority_check CHECK (((priority >= 1) AND (priority <= 10)));
ALTER TABLE public.notification_queue ADD CONSTRAINT notification_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])));
ALTER TABLE public.notification_settings ADD CONSTRAINT notification_settings_pkey PRIMARY KEY (id);
ALTER TABLE public.notification_settings ADD CONSTRAINT notification_settings_setting_key_key UNIQUE (setting_key);
ALTER TABLE public.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE public.parts ADD CONSTRAINT parts_pkey PRIMARY KEY (id);
ALTER TABLE public.parts ADD CONSTRAINT parts_reserved_quantity_check CHECK ((reserved_quantity >= 0));
ALTER TABLE public.payment_applications ADD CONSTRAINT payment_applications_amount_applied_check CHECK ((((is_reversal = false) AND (amount_applied > (0)::numeric)) OR ((is_reversal = true) AND (amount_applied < (0)::numeric))));
ALTER TABLE public.payment_applications ADD CONSTRAINT payment_applications_pkey PRIMARY KEY (id);
ALTER TABLE public.payments ADD CONSTRAINT chk_payments_unapplied_nonneg CHECK ((unapplied_amount >= (0)::numeric));
ALTER TABLE public.payments ADD CONSTRAINT payments_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.payments ADD CONSTRAINT payments_method_check CHECK ((method = ANY (ARRAY['cash'::text, 'bank_transfer'::text, 'check'::text, 'card'::text, 'other'::text])));
ALTER TABLE public.payments ADD CONSTRAINT payments_payment_code_key UNIQUE (payment_code);
ALTER TABLE public.payments ADD CONSTRAINT payments_pkey PRIMARY KEY (id);
ALTER TABLE public.payments ADD CONSTRAINT payments_status_check CHECK ((status = ANY (ARRAY['active'::text, 'voided'::text])));
ALTER TABLE public.pipelines ADD CONSTRAINT pipelines_name_key UNIQUE (name);
ALTER TABLE public.pipelines ADD CONSTRAINT pipelines_pkey PRIMARY KEY (id);
ALTER TABLE public.product_documents ADD CONSTRAINT product_documents_doc_type_check CHECK ((doc_type = ANY (ARRAY['datasheet'::text, 'manual'::text, 'warranty'::text, 'certificate'::text, 'drawing'::text, 'other'::text])));
ALTER TABLE public.product_documents ADD CONSTRAINT product_documents_extraction_status_check CHECK ((extraction_status = ANY (ARRAY['pending'::text, 'ok'::text, 'empty'::text, 'failed'::text, 'unsupported'::text])));
ALTER TABLE public.product_documents ADD CONSTRAINT product_documents_pkey PRIMARY KEY (id);
ALTER TABLE public.product_images ADD CONSTRAINT product_images_pkey PRIMARY KEY (id);
ALTER TABLE public.products ADD CONSTRAINT products_pkey PRIMARY KEY (id);
ALTER TABLE public.products ADD CONSTRAINT products_product_type_check CHECK ((product_type = ANY (ARRAY['hardware'::text, 'software'::text, 'accessory'::text, 'service'::text])));
ALTER TABLE public.products ADD CONSTRAINT products_sku_key UNIQUE (sku);
ALTER TABLE public.products ADD CONSTRAINT products_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'discontinued'::text])));
ALTER TABLE public.products ADD CONSTRAINT products_stock_tracking_mode_check CHECK ((stock_tracking_mode = ANY (ARRAY['serialized'::text, 'bulk'::text])));
ALTER TABLE public.purchase_orders ADD CONSTRAINT chk_po_rate_positive CHECK ((exchange_rate > (0)::numeric));
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_po_code_key UNIQUE (po_code);
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'pending_confirmation'::text, 'confirmed'::text, 'partially_completed'::text, 'completed'::text, 'cancelled'::text, 'expired'::text])));
ALTER TABLE public.quotations ADD CONSTRAINT quotations_pkey PRIMARY KEY (id);
ALTER TABLE public.quotations ADD CONSTRAINT quotations_qt_code_key UNIQUE (qt_code);
ALTER TABLE public.quotations ADD CONSTRAINT quotations_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'accepted'::text, 'declined'::text, 'expired'::text, 'cancelled'::text, 'converted'::text])));
ALTER TABLE public.rma_config ADD CONSTRAINT rma_config_config_key_key UNIQUE (config_key);
ALTER TABLE public.rma_config ADD CONSTRAINT rma_config_pkey PRIMARY KEY (id);
ALTER TABLE public.rma_tickets ADD CONSTRAINT rma_tickets_pkey PRIMARY KEY (id);
ALTER TABLE public.rma_tickets ADD CONSTRAINT rma_tickets_priority_check CHECK ((priority = ANY (ARRAY['Low'::text, 'Medium'::text, 'High'::text, 'Critical'::text])));
ALTER TABLE public.rma_tickets ADD CONSTRAINT rma_tickets_rma_number_key UNIQUE (rma_number);
ALTER TABLE public.rma_tickets ADD CONSTRAINT rma_tickets_ticket_status_nonempty CHECK (((ticket_status IS NULL) OR (length(btrim(ticket_status)) > 0)));
ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_pkey PRIMARY KEY (id);
ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_so_code_key UNIQUE (so_code);
ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'accepted'::text, 'declined'::text, 'confirmed'::text, 'delivered'::text, 'cancelled'::text])));
ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_doc_type_check CHECK ((doc_type = ANY (ARRAY['sales_order'::text, 'invoice'::text, 'credit_note'::text, 'manual'::text, 'vendor_invoice'::text, 'rma_ticket'::text])));
ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_move_type_check CHECK ((move_type = ANY (ARRAY['reserve'::text, 'deliver'::text, 'release'::text, 'restore'::text, 'adjust'::text, 'receive'::text, 'transfer'::text])));
ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_pkey PRIMARY KEY (id);
ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_qty_check CHECK ((qty > 0));
ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_ref_type_check CHECK ((ref_type = ANY (ARRAY['unit'::text, 'part'::text, 'warehouse_stock'::text])));
ALTER TABLE public.subcategories ADD CONSTRAINT subcategories_category_id_subcategory_name_key UNIQUE (category_id, subcategory_name);
ALTER TABLE public.subcategories ADD CONSTRAINT subcategories_pkey PRIMARY KEY (id);
ALTER TABLE public.subcategories ADD CONSTRAINT subcategories_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])));
ALTER TABLE public.ticket_activity ADD CONSTRAINT ticket_activity_pkey PRIMARY KEY (id);
ALTER TABLE public.ticket_comments ADD CONSTRAINT ticket_comments_pkey PRIMARY KEY (id);
ALTER TABLE public.ticket_parts ADD CONSTRAINT ticket_parts_pkey PRIMARY KEY (id);
ALTER TABLE public.ticket_resolutions ADD CONSTRAINT ticket_resolutions_pkey PRIMARY KEY (id);
ALTER TABLE public.ticket_resolutions ADD CONSTRAINT ticket_resolutions_type_check CHECK ((type = ANY (ARRAY['replacement'::text, 'exchange'::text, 'credit_note'::text, 'refund'::text])));
ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_pkey PRIMARY KEY (id);
ALTER TABLE public.user_activity_log ADD CONSTRAINT user_activity_log_pkey PRIMARY KEY (id);
ALTER TABLE public.user_permissions ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (id);
ALTER TABLE public.user_permissions ADD CONSTRAINT user_permissions_user_email_key UNIQUE (user_email);
ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (id);
ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_user_email_key UNIQUE (user_email);
ALTER TABLE public.user_roles ADD CONSTRAINT chk_user_status CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'locked'::text, 'deactivated'::text, 'pending'::text])));
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'locked'::text, 'deactivated'::text, 'pending'::text])));
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_email_key UNIQUE (user_email);
ALTER TABLE public.vendor_invoice_charges ADD CONSTRAINT vendor_invoice_charges_amount_check CHECK ((amount >= (0)::numeric));
ALTER TABLE public.vendor_invoice_charges ADD CONSTRAINT vendor_invoice_charges_charge_type_check CHECK ((charge_type = ANY (ARRAY['freight'::text, 'customs'::text, 'clearance'::text, 'insurance'::text, 'handling'::text, 'other'::text])));
ALTER TABLE public.vendor_invoice_charges ADD CONSTRAINT vendor_invoice_charges_pkey PRIMARY KEY (id);
ALTER TABLE public.vendor_invoices ADD CONSTRAINT chk_vi_rate_positive CHECK ((exchange_rate > (0)::numeric));
ALTER TABLE public.vendor_invoices ADD CONSTRAINT vendor_invoices_payment_status_check CHECK ((payment_status = ANY (ARRAY['unpaid'::text, 'partial'::text, 'paid'::text, 'reversed'::text])));
ALTER TABLE public.vendor_invoices ADD CONSTRAINT vendor_invoices_pkey PRIMARY KEY (id);
ALTER TABLE public.vendor_invoices ADD CONSTRAINT vendor_invoices_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending_approval'::text, 'approved'::text, 'partially_received'::text, 'received'::text, 'cancelled'::text])));
ALTER TABLE public.vendor_invoices ADD CONSTRAINT vendor_invoices_vi_code_key UNIQUE (vi_code);
ALTER TABLE public.vendor_payment_applications ADD CONSTRAINT vendor_payment_applications_amount_applied_check CHECK ((((is_reversal = false) AND (amount_applied > (0)::numeric)) OR ((is_reversal = true) AND (amount_applied < (0)::numeric))));
ALTER TABLE public.vendor_payment_applications ADD CONSTRAINT vendor_payment_applications_pkey PRIMARY KEY (id);
ALTER TABLE public.vendor_payments ADD CONSTRAINT vendor_payments_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.vendor_payments ADD CONSTRAINT vendor_payments_exchange_rate_check CHECK ((exchange_rate > (0)::numeric));
ALTER TABLE public.vendor_payments ADD CONSTRAINT vendor_payments_method_check CHECK ((method = ANY (ARRAY['cash'::text, 'bank_transfer'::text, 'check'::text, 'card'::text, 'other'::text])));
ALTER TABLE public.vendor_payments ADD CONSTRAINT vendor_payments_payment_code_key UNIQUE (payment_code);
ALTER TABLE public.vendor_payments ADD CONSTRAINT vendor_payments_pkey PRIMARY KEY (id);
ALTER TABLE public.vendor_payments ADD CONSTRAINT vendor_payments_status_check CHECK ((status = ANY (ARRAY['active'::text, 'voided'::text])));
ALTER TABLE public.vendor_payments ADD CONSTRAINT vendor_payments_unapplied_amount_check CHECK ((unapplied_amount >= (0)::numeric));
ALTER TABLE public.warehouse_stock ADD CONSTRAINT chk_uncosted_within_quantity CHECK (((uncosted_quantity >= 0) AND (uncosted_quantity <= quantity)));
ALTER TABLE public.warehouse_stock ADD CONSTRAINT warehouse_stock_check CHECK (((reserved_quantity >= 0) AND (reserved_quantity <= quantity)));
ALTER TABLE public.warehouse_stock ADD CONSTRAINT warehouse_stock_pkey PRIMARY KEY (id);
ALTER TABLE public.warehouse_stock ADD CONSTRAINT warehouse_stock_product_id_warehouse_id_key UNIQUE (product_id, warehouse_id);
ALTER TABLE public.warehouse_stock ADD CONSTRAINT warehouse_stock_quantity_check CHECK ((quantity >= 0));
ALTER TABLE public.warehouses ADD CONSTRAINT warehouses_pkey PRIMARY KEY (id);
ALTER TABLE public.warehouses ADD CONSTRAINT warehouses_warehouse_type_check CHECK ((warehouse_type = ANY (ARRAY['main'::text, 'branch'::text, 'service_center'::text, 'rma'::text, 'transit'::text, 'virtual'::text])));
ALTER TABLE public.webhooks ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);
ALTER TABLE public.whatsapp_templates ADD CONSTRAINT whatsapp_templates_header_type_check CHECK (((header_type = ANY (ARRAY['text'::text, 'document'::text, 'image'::text])) OR (header_type IS NULL)));
ALTER TABLE public.whatsapp_templates ADD CONSTRAINT whatsapp_templates_pkey PRIMARY KEY (id);
ALTER TABLE public.whatsapp_templates ADD CONSTRAINT whatsapp_templates_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'pending_approval'::text])));

-- Foreign keys
ALTER TABLE public.activities ADD CONSTRAINT activities_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES activities(id) ON DELETE CASCADE;
ALTER TABLE public.brands ADD CONSTRAINT brands_country_code_fkey FOREIGN KEY (country_code) REFERENCES countries(code);
ALTER TABLE public.categories ADD CONSTRAINT categories_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.countries ADD CONSTRAINT countries_currency_code_fkey FOREIGN KEY (currency_code) REFERENCES currencies(code) ON DELETE SET NULL;
ALTER TABLE public.country_area_codes ADD CONSTRAINT country_area_codes_country_code_fkey FOREIGN KEY (country_code) REFERENCES countries(code) ON DELETE CASCADE;
ALTER TABLE public.credit_note_applications ADD CONSTRAINT credit_note_applications_credit_note_id_fkey FOREIGN KEY (credit_note_id) REFERENCES credit_notes(id) ON DELETE CASCADE;
ALTER TABLE public.credit_note_applications ADD CONSTRAINT credit_note_applications_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES crm_invoices(id) ON DELETE CASCADE;
ALTER TABLE public.credit_note_applications ADD CONSTRAINT credit_note_applications_reverses_application_id_fkey FOREIGN KEY (reverses_application_id) REFERENCES credit_note_applications(id);
ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_source_invoice_id_fkey FOREIGN KEY (source_invoice_id) REFERENCES crm_invoices(id) ON DELETE SET NULL;
ALTER TABLE public.crm_invoices ADD CONSTRAINT crm_invoices_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
ALTER TABLE public.crm_invoices ADD CONSTRAINT crm_invoices_so_id_fkey FOREIGN KEY (so_id) REFERENCES sales_orders(id) ON DELETE SET NULL;
ALTER TABLE public.customer_notes ADD CONSTRAINT customer_notes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.customers ADD CONSTRAINT customers_country_code_fkey FOREIGN KEY (country_code) REFERENCES countries(code);
ALTER TABLE public.deals ADD CONSTRAINT deals_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id);
ALTER TABLE public.deals ADD CONSTRAINT deals_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE public.deals ADD CONSTRAINT deals_pipeline_id_fkey FOREIGN KEY (pipeline_id) REFERENCES pipelines(id);
ALTER TABLE public.inventory_units ADD CONSTRAINT inventory_units_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE public.inventory_units ADD CONSTRAINT inventory_units_rma_ticket_id_fkey FOREIGN KEY (rma_ticket_id) REFERENCES rma_tickets(id) ON DELETE CASCADE;
ALTER TABLE public.inventory_units ADD CONSTRAINT inventory_units_vendor_invoice_id_fkey FOREIGN KEY (vendor_invoice_id) REFERENCES vendor_invoices(id);
ALTER TABLE public.inventory_units ADD CONSTRAINT inventory_units_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES rma_tickets(id) ON DELETE SET NULL;
ALTER TABLE public.leads ADD CONSTRAINT fk_leads_converted_deal FOREIGN KEY (converted_deal_id) REFERENCES deals(id);
ALTER TABLE public.leads ADD CONSTRAINT leads_converted_customer_id_fkey FOREIGN KEY (converted_customer_id) REFERENCES customers(id);
ALTER TABLE public.notification_logs ADD CONSTRAINT notification_logs_template_id_fkey FOREIGN KEY (template_id) REFERENCES whatsapp_templates(id) ON DELETE SET NULL;
ALTER TABLE public.notification_logs ADD CONSTRAINT notification_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.payment_applications ADD CONSTRAINT payment_applications_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES crm_invoices(id) ON DELETE CASCADE;
ALTER TABLE public.payment_applications ADD CONSTRAINT payment_applications_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE;
ALTER TABLE public.payment_applications ADD CONSTRAINT payment_applications_reverses_application_id_fkey FOREIGN KEY (reverses_application_id) REFERENCES payment_applications(id);
ALTER TABLE public.payments ADD CONSTRAINT payments_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
ALTER TABLE public.product_documents ADD CONSTRAINT product_documents_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE public.product_images ADD CONSTRAINT product_images_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE public.products ADD CONSTRAINT products_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL;
ALTER TABLE public.products ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE public.products ADD CONSTRAINT products_subcategory_id_fkey FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE SET NULL;
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_currency_fkey FOREIGN KEY (currency) REFERENCES currencies(code) ON DELETE RESTRICT;
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES brands(id);
ALTER TABLE public.quotations ADD CONSTRAINT quotations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
ALTER TABLE public.quotations ADD CONSTRAINT quotations_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;
ALTER TABLE public.rma_tickets ADD CONSTRAINT rma_tickets_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
ALTER TABLE public.rma_tickets ADD CONSTRAINT rma_tickets_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_quotation_id_fkey FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE SET NULL;
ALTER TABLE public.subcategories ADD CONSTRAINT subcategories_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE;
ALTER TABLE public.ticket_activity ADD CONSTRAINT ticket_activity_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES rma_tickets(id) ON DELETE CASCADE;
ALTER TABLE public.ticket_comments ADD CONSTRAINT ticket_comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES ticket_comments(id) ON DELETE SET NULL;
ALTER TABLE public.ticket_comments ADD CONSTRAINT ticket_comments_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES rma_tickets(id) ON DELETE CASCADE;
ALTER TABLE public.ticket_parts ADD CONSTRAINT ticket_parts_part_id_fkey FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE RESTRICT;
ALTER TABLE public.ticket_parts ADD CONSTRAINT ticket_parts_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES rma_tickets(id) ON DELETE CASCADE;
ALTER TABLE public.ticket_resolutions ADD CONSTRAINT ticket_resolutions_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES rma_tickets(id) ON DELETE CASCADE;
ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES rma_tickets(id) ON DELETE CASCADE;
ALTER TABLE public.user_permissions ADD CONSTRAINT user_permissions_linked_customer_id_fkey FOREIGN KEY (linked_customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE public.vendor_invoice_charges ADD CONSTRAINT vendor_invoice_charges_vendor_invoice_id_fkey FOREIGN KEY (vendor_invoice_id) REFERENCES vendor_invoices(id) ON DELETE CASCADE;
ALTER TABLE public.vendor_invoices ADD CONSTRAINT vendor_invoices_currency_fkey FOREIGN KEY (currency) REFERENCES currencies(code) ON DELETE RESTRICT;
ALTER TABLE public.vendor_invoices ADD CONSTRAINT vendor_invoices_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id);
ALTER TABLE public.vendor_invoices ADD CONSTRAINT vendor_invoices_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES brands(id);
ALTER TABLE public.vendor_payment_applications ADD CONSTRAINT vendor_payment_applications_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES vendor_invoices(id) ON DELETE CASCADE;
ALTER TABLE public.vendor_payment_applications ADD CONSTRAINT vendor_payment_applications_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES vendor_payments(id) ON DELETE CASCADE;
ALTER TABLE public.vendor_payment_applications ADD CONSTRAINT vendor_payment_applications_reverses_application_id_fkey FOREIGN KEY (reverses_application_id) REFERENCES vendor_payment_applications(id);
ALTER TABLE public.vendor_payments ADD CONSTRAINT vendor_payments_currency_fkey FOREIGN KEY (currency) REFERENCES currencies(code);
ALTER TABLE public.vendor_payments ADD CONSTRAINT vendor_payments_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES brands(id) ON DELETE RESTRICT;
ALTER TABLE public.warehouse_stock ADD CONSTRAINT warehouse_stock_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE public.warehouse_stock ADD CONSTRAINT warehouse_stock_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);

-- Indexes
CREATE INDEX cn_applications_cn_idx ON public.credit_note_applications USING btree (credit_note_id);
CREATE INDEX cn_applications_invoice_idx ON public.credit_note_applications USING btree (invoice_id);
CREATE INDEX country_area_codes_country_idx ON public.country_area_codes USING btree (country_code);
CREATE INDEX credit_notes_customer_idx ON public.credit_notes USING btree (customer_id);
CREATE INDEX credit_notes_invoice_idx ON public.credit_notes USING btree (source_invoice_id);
CREATE INDEX credit_notes_status_idx ON public.credit_notes USING btree (status);
CREATE INDEX credit_notes_type_idx ON public.credit_notes USING btree (type);
CREATE INDEX crm_invoices_customer_idx ON public.crm_invoices USING btree (customer_id);
CREATE INDEX crm_invoices_doc_status_idx ON public.crm_invoices USING btree (doc_status);
CREATE INDEX crm_invoices_pay_status_idx ON public.crm_invoices USING btree (payment_status);
CREATE INDEX crm_invoices_rep_idx ON public.crm_invoices USING btree (assigned_rep);
CREATE INDEX crm_invoices_so_idx ON public.crm_invoices USING btree (so_id);
CREATE INDEX idx_activities_assigned_rep ON public.activities USING btree (assigned_rep);
CREATE INDEX idx_activities_completed_at ON public.activities USING btree (completed_at);
CREATE INDEX idx_activities_due_date ON public.activities USING btree (due_date);
CREATE INDEX idx_activities_parent_id ON public.activities USING btree (parent_id);
CREATE INDEX idx_activities_related_id ON public.activities USING btree (related_id);
CREATE INDEX idx_categories_brand ON public.categories USING btree (brand_id);
CREATE INDEX idx_contacts_customer_id ON public.contacts USING btree (customer_id);
CREATE INDEX idx_customers_code ON public.customers USING btree (customer_code);
CREATE INDEX idx_customers_email ON public.customers USING btree (email);
CREATE INDEX idx_deals_assigned_rep ON public.deals USING btree (assigned_rep);
CREATE INDEX idx_deals_customer_id ON public.deals USING btree (customer_id);
CREATE INDEX idx_deals_expected_close_date ON public.deals USING btree (expected_close_date);
CREATE INDEX idx_deals_status ON public.deals USING btree (status);
CREATE INDEX idx_leads_assigned_rep ON public.leads USING btree (assigned_rep);
CREATE INDEX idx_leads_created_at ON public.leads USING btree (created_at);
CREATE INDEX idx_leads_source ON public.leads USING btree (source);
CREATE INDEX idx_leads_status ON public.leads USING btree (status);
CREATE INDEX idx_notif_logs_event_type ON public.notification_logs USING btree (event_type);
CREATE INDEX idx_notif_logs_provider ON public.notification_logs USING btree (provider);
CREATE INDEX idx_notif_logs_recipient ON public.notification_logs USING btree (recipient);
CREATE INDEX idx_notif_logs_sent_at ON public.notification_logs USING btree (sent_at DESC);
CREATE INDEX idx_notif_logs_status ON public.notification_logs USING btree (delivery_status);
CREATE INDEX idx_notif_logs_ticket_id ON public.notification_logs USING btree (ticket_id);
CREATE INDEX idx_notif_logs_wa_msg_id ON public.notification_logs USING btree (whatsapp_message_id) WHERE (whatsapp_message_id IS NOT NULL);
CREATE INDEX idx_notif_queue_job_type ON public.notification_queue USING btree (job_type);
CREATE INDEX idx_notif_queue_priority ON public.notification_queue USING btree (priority, status, scheduled_at);
CREATE INDEX idx_notif_queue_scheduled ON public.notification_queue USING btree (scheduled_at);
CREATE INDEX idx_notif_queue_status ON public.notification_queue USING btree (status);
CREATE INDEX idx_product_images_product ON public.product_images USING btree (product_id);
CREATE INDEX idx_products_brand ON public.products USING btree (brand_id);
CREATE INDEX idx_products_category ON public.products USING btree (category_id);
CREATE INDEX idx_products_sku ON public.products USING btree (sku);
CREATE INDEX idx_products_status ON public.products USING btree (status);
CREATE INDEX idx_products_subcategory ON public.products USING btree (subcategory_id);
CREATE INDEX idx_rma_tickets_customer ON public.rma_tickets USING btree (customer_id);
CREATE INDEX idx_rma_tickets_number ON public.rma_tickets USING btree (rma_number);
CREATE INDEX idx_rma_tickets_status ON public.rma_tickets USING btree (ticket_status);
CREATE INDEX idx_subcategories_category ON public.subcategories USING btree (category_id);
CREATE INDEX idx_ticket_comments_created ON public.ticket_comments USING btree (created_date);
CREATE INDEX idx_ticket_comments_ticket ON public.ticket_comments USING btree (ticket_id);
CREATE INDEX idx_user_activity_log_created_date ON public.user_activity_log USING btree (created_date DESC);
CREATE INDEX idx_user_activity_log_user_email ON public.user_activity_log USING btree (user_email);
CREATE INDEX idx_user_permissions_email ON public.user_permissions USING btree (user_email);
CREATE INDEX idx_wa_templates_event_type ON public.whatsapp_templates USING btree (event_type);
CREATE INDEX idx_wa_templates_provider ON public.whatsapp_templates USING btree (provider);
CREATE INDEX idx_wa_templates_status ON public.whatsapp_templates USING btree (status);
CREATE INDEX inv_units_product_id_idx ON public.inventory_units USING btree (product_id);
CREATE INDEX inv_units_reservation_idx ON public.inventory_units USING btree (reservation_status);
CREATE INDEX inv_units_reserved_by_idx ON public.inventory_units USING btree (reserved_by_doc_id) WHERE (reserved_by_doc_id IS NOT NULL);
CREATE UNIQUE INDEX inv_units_serial_unique_idx ON public.inventory_units USING btree (serial_number) WHERE ((serial_number IS NOT NULL) AND (serial_number <> ''::text) AND (status <> 'closed'::text));
CREATE INDEX inv_units_vendor_invoice_idx ON public.inventory_units USING btree (vendor_invoice_id);
CREATE INDEX invoices_status_idx ON public.invoices USING btree (status);
CREATE INDEX invoices_ticket_idx ON public.invoices USING btree (ticket_id);
CREATE INDEX notifications_created_date_idx ON public.notifications USING btree (created_date DESC);
CREATE INDEX payment_applications_invoice_idx ON public.payment_applications USING btree (invoice_id);
CREATE INDEX payment_applications_payment_idx ON public.payment_applications USING btree (payment_id);
CREATE INDEX payments_customer_idx ON public.payments USING btree (customer_id);
CREATE INDEX payments_status_idx ON public.payments USING btree (status);
CREATE INDEX product_documents_product_idx ON public.product_documents USING btree (product_id);
CREATE INDEX product_documents_search_idx ON public.product_documents USING gin (search_vector);
CREATE INDEX product_documents_type_idx ON public.product_documents USING btree (doc_type);
CREATE INDEX quotations_customer_idx ON public.quotations USING btree (customer_id);
CREATE INDEX quotations_deal_idx ON public.quotations USING btree (deal_id);
CREATE INDEX quotations_rep_idx ON public.quotations USING btree (assigned_rep);
CREATE INDEX quotations_status_idx ON public.quotations USING btree (status);
CREATE INDEX sales_orders_customer_idx ON public.sales_orders USING btree (customer_id);
CREATE INDEX sales_orders_quotation_idx ON public.sales_orders USING btree (quotation_id);
CREATE INDEX sales_orders_rep_idx ON public.sales_orders USING btree (assigned_rep);
CREATE INDEX sales_orders_status_idx ON public.sales_orders USING btree (status);
CREATE INDEX stock_moves_doc_idx ON public.stock_moves USING btree (doc_type, doc_id);
CREATE INDEX stock_moves_ref_idx ON public.stock_moves USING btree (ref_type, ref_id);
CREATE INDEX ticket_parts_part_idx ON public.ticket_parts USING btree (part_id);
CREATE INDEX ticket_parts_ticket_idx ON public.ticket_parts USING btree (ticket_id);
CREATE UNIQUE INDEX ticket_resolutions_ticket_id_unique ON public.ticket_resolutions USING btree (ticket_id);
CREATE INDEX time_entries_ticket_idx ON public.time_entries USING btree (ticket_id);
CREATE INDEX time_entries_user_idx ON public.time_entries USING btree (user_email);
CREATE INDEX vendor_invoice_charges_vi_idx ON public.vendor_invoice_charges USING btree (vendor_invoice_id);
CREATE INDEX vendor_payment_applications_invoice_idx ON public.vendor_payment_applications USING btree (invoice_id);
CREATE INDEX vendor_payment_applications_payment_idx ON public.vendor_payment_applications USING btree (payment_id);
CREATE INDEX vendor_payments_status_idx ON public.vendor_payments USING btree (status);
CREATE INDEX vendor_payments_vendor_idx ON public.vendor_payments USING btree (vendor_id);
CREATE INDEX warehouse_stock_product_idx ON public.warehouse_stock USING btree (product_id);
CREATE INDEX warehouse_stock_warehouse_idx ON public.warehouse_stock USING btree (warehouse_id);
CREATE UNIQUE INDEX warehouses_system_code_key ON public.warehouses USING btree (code) WHERE is_system;

-- Functions
CREATE OR REPLACE FUNCTION public._reverse_credit_note_application(p_application_id uuid, p_reason text, p_actor text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_app record;
  v_new uuid;
BEGIN
  SELECT * INTO v_app
  FROM public.credit_note_applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note application not found: %', p_application_id;
  END IF;
  IF v_app.is_reversal THEN
    RAISE EXCEPTION 'Cannot reverse a reversal row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.credit_note_applications
    WHERE reverses_application_id = p_application_id
  ) THEN
    RAISE EXCEPTION 'This application has already been reversed';
  END IF;

  PERFORM 1 FROM public.crm_invoices WHERE id = v_app.invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found for application: %', v_app.invoice_id;
  END IF;

  INSERT INTO public.credit_note_applications (
    credit_note_id, invoice_id, amount_applied, applied_by,
    is_reversal, reverses_application_id, reversal_reason
  )
  VALUES (
    v_app.credit_note_id, v_app.invoice_id, -v_app.amount_applied, p_actor,
    true, p_application_id, p_reason
  )
  RETURNING id INTO v_new;

  IF FOUND THEN
    UPDATE public.crm_invoices
    SET
      amount_paid    = GREATEST(amount_paid - v_app.amount_applied, 0),
      payment_status = CASE
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) >= total THEN 'paid'
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) > 0     THEN 'partial'
        ELSE 'unpaid'
        END,
      paid_at = CASE
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) >= total THEN paid_at
        ELSE NULL
        END,
      updated_at = NOW()
    WHERE id = v_app.invoice_id;
  END IF;

  RETURN v_new;
END;
$function$
;

CREATE OR REPLACE FUNCTION public._reverse_payment_application(p_application_id uuid, p_reason text, p_actor text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_app  record;
  v_inv  record;
  v_new  uuid;
BEGIN
  SELECT * INTO v_app
  FROM public.payment_applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment application not found: %', p_application_id;
  END IF;
  IF v_app.is_reversal THEN
    RAISE EXCEPTION 'Cannot reverse a reversal row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payment_applications
    WHERE reverses_application_id = p_application_id
  ) THEN
    RAISE EXCEPTION 'This application has already been reversed';
  END IF;

  SELECT id, total, amount_paid INTO v_inv
  FROM public.crm_invoices
  WHERE id = v_app.invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found for application: %', v_app.invoice_id;
  END IF;

  INSERT INTO public.payment_applications (
    payment_id, invoice_id, amount_applied, applied_by,
    is_reversal, reverses_application_id, reversal_reason
  )
  VALUES (
    v_app.payment_id, v_app.invoice_id, -v_app.amount_applied, p_actor,
    true, p_application_id, p_reason
  )
  RETURNING id INTO v_new;

  IF FOUND THEN
    UPDATE public.crm_invoices
    SET
      amount_paid    = GREATEST(amount_paid - v_app.amount_applied, 0),
      payment_status = CASE
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) >= total THEN 'paid'
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) > 0     THEN 'partial'
        ELSE 'unpaid'
        END,
      paid_at = CASE
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) >= total THEN paid_at
        ELSE NULL
        END,
      updated_at = NOW()
    WHERE id = v_app.invoice_id;
  END IF;

  RETURN v_new;
END;
$function$
;

CREATE OR REPLACE FUNCTION public._reverse_vendor_payment_application(p_application_id uuid, p_reason text, p_actor text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_app record;
  v_new uuid;
BEGIN
  SELECT * INTO v_app
  FROM public.vendor_payment_applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor payment application not found: %', p_application_id;
  END IF;
  IF v_app.is_reversal THEN
    RAISE EXCEPTION 'Cannot reverse a reversal row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.vendor_payment_applications
    WHERE reverses_application_id = p_application_id
  ) THEN
    RAISE EXCEPTION 'This application has already been reversed';
  END IF;

  PERFORM 1 FROM public.vendor_invoices WHERE id = v_app.invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice not found for application: %', v_app.invoice_id;
  END IF;

  INSERT INTO public.vendor_payment_applications (
    payment_id, invoice_id, amount_applied, applied_by,
    is_reversal, reverses_application_id, reversal_reason
  )
  VALUES (
    v_app.payment_id, v_app.invoice_id, -v_app.amount_applied, p_actor,
    true, p_application_id, p_reason
  )
  RETURNING id INTO v_new;

  IF FOUND THEN
    UPDATE public.vendor_invoices
    SET
      amount_paid    = GREATEST(amount_paid - v_app.amount_applied, 0),
      payment_status = CASE
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) >= total THEN 'paid'
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) > 0     THEN 'partial'
        ELSE 'unpaid'
        END,
      paid_at = CASE
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) >= total THEN paid_at
        ELSE NULL
        END,
      updated_at = NOW()
    WHERE id = v_app.invoice_id;
  END IF;

  RETURN v_new;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.adjust_part_quantity(p_id uuid, p_delta integer)
 RETURNS TABLE(id uuid, quantity integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to adjust part quantities' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  UPDATE public.parts
     SET quantity     = GREATEST(0, parts.quantity + p_delta),
         updated_date = now()
   WHERE parts.id = p_id
  RETURNING parts.id, parts.quantity;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.adjust_stock(p_product_id uuid, p_warehouse_id uuid, p_actor_email text, p_unit_id uuid DEFAULT NULL::uuid, p_new_status text DEFAULT NULL::text, p_qty_delta integer DEFAULT NULL::integer, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tracking_mode text;
  v_old_status    text;
  v_ws_id         uuid;
  v_old_qty       integer;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to adjust stock' USING ERRCODE = 'P0001';
  END IF;

  SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = 'P0001';
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    IF p_qty_delta IS NULL OR p_qty_delta = 0 THEN
      RAISE EXCEPTION 'A non-zero quantity delta is required to adjust bulk stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT id, quantity INTO v_ws_id, v_old_qty FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
    FOR UPDATE;

    IF NOT FOUND THEN
      IF p_qty_delta < 0 THEN
        RAISE EXCEPTION 'No stock exists at this warehouse to reduce' USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity)
      VALUES (p_product_id, p_warehouse_id, p_qty_delta, 0)
      RETURNING id INTO v_ws_id;
      v_old_qty := 0;
    ELSE
      IF v_old_qty + p_qty_delta < 0 THEN
        RAISE EXCEPTION 'Adjustment would take quantity negative (current %, delta %)', v_old_qty, p_qty_delta
          USING ERRCODE = 'P0001';
      END IF;
      UPDATE public.warehouse_stock SET quantity = quantity + p_qty_delta, updated_at = now() WHERE id = v_ws_id;
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_ws_id, 'manual', NULL, 'adjust', abs(p_qty_delta),
       v_old_qty::text, (v_old_qty + p_qty_delta)::text, p_actor_email);
  ELSE
    IF p_unit_id IS NULL OR p_new_status IS NULL THEN
      RAISE EXCEPTION 'A unit id and new status are required to adjust serialized stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT status INTO v_old_status FROM public.inventory_units WHERE id = p_unit_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit % not found', p_unit_id USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.inventory_units SET status = p_new_status, notes = COALESCE(p_reason, notes) WHERE id = p_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', p_unit_id, 'manual', NULL, 'adjust', 1, v_old_status, p_new_status, p_actor_email);
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_credit_note_to_invoice(p_cn_id uuid, p_invoice_id uuid, p_amount numeric, p_actor_email text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor text;
  v_cn    record;
  v_inv   record;
  v_app   uuid;
BEGIN
  IF NOT public.rma_can_handle_cash() THEN
    RAISE EXCEPTION 'Not authorized to apply credit notes';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Applied amount must be positive';
  END IF;

  SELECT id, customer_id, status, remaining_balance
    INTO v_cn
  FROM public.credit_notes
  WHERE id = p_cn_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id;
  END IF;
  IF v_cn.status <> 'issued' THEN
    RAISE EXCEPTION 'Credit note must be issued to apply (current: %)', v_cn.status;
  END IF;
  IF p_amount > v_cn.remaining_balance THEN
    RAISE EXCEPTION 'Amount % exceeds remaining balance %',
      p_amount, v_cn.remaining_balance;
  END IF;

  SELECT id, customer_id, total, amount_paid
    INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
    AND doc_status = 'posted'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % is not a posted invoice', p_invoice_id;
  END IF;
  IF v_inv.customer_id <> v_cn.customer_id THEN
    RAISE EXCEPTION 'Invoice % belongs to a different customer', p_invoice_id;
  END IF;

  INSERT INTO public.credit_note_applications (
    credit_note_id, invoice_id, amount_applied, applied_by
  )
  VALUES (p_cn_id, p_invoice_id, p_amount, v_actor)
  RETURNING id INTO v_app;

  UPDATE public.crm_invoices
  SET
    amount_paid    = LEAST(amount_paid + p_amount, total),
    payment_status = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN 'paid'
      WHEN LEAST(amount_paid + p_amount, total) > 0     THEN 'partial'
      ELSE 'unpaid'
      END,
    paid_at = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN NOW()
      ELSE paid_at
      END,
    updated_at = NOW()
  WHERE id = p_invoice_id;

  RETURN v_app;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_payment_to_invoice(p_payment_id uuid, p_invoice_id uuid, p_amount numeric, p_actor_email text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor text;
  v_pay   record;
  v_inv   record;
  v_app   uuid;
BEGIN
  IF NOT public.rma_can_handle_cash() THEN
    RAISE EXCEPTION 'Not authorized to apply payments';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Applied amount must be positive';
  END IF;

  SELECT id, customer_id, status, unapplied_amount
    INTO v_pay
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found: %', p_payment_id;
  END IF;
  IF v_pay.status <> 'active' THEN
    RAISE EXCEPTION 'Payment must be active to apply (current: %)', v_pay.status;
  END IF;
  IF p_amount > v_pay.unapplied_amount THEN
    RAISE EXCEPTION 'Amount % exceeds unapplied balance %',
      p_amount, v_pay.unapplied_amount;
  END IF;

  SELECT id, customer_id, total, amount_paid
    INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
    AND doc_status = 'posted'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % is not a posted invoice', p_invoice_id;
  END IF;
  IF v_inv.customer_id <> v_pay.customer_id THEN
    RAISE EXCEPTION 'Invoice % belongs to a different customer', p_invoice_id;
  END IF;

  INSERT INTO public.payment_applications (
    payment_id, invoice_id, amount_applied, applied_by
  )
  VALUES (p_payment_id, p_invoice_id, p_amount, v_actor)
  RETURNING id INTO v_app;

  UPDATE public.crm_invoices
  SET
    amount_paid    = LEAST(amount_paid + p_amount, total),
    payment_status = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN 'paid'
      WHEN LEAST(amount_paid + p_amount, total) > 0     THEN 'partial'
      ELSE 'unpaid'
      END,
    paid_at = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN NOW()
      ELSE paid_at
      END,
    updated_at = NOW()
  WHERE id = p_invoice_id;

  RETURN v_app;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_vendor_payment_to_invoice(p_payment_id uuid, p_invoice_id uuid, p_amount numeric, p_actor_email text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor text;
  v_pay   record;
  v_inv   record;
  v_app   uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to apply vendor payments';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Applied amount must be positive';
  END IF;

  SELECT id, vendor_id, status, unapplied_amount, currency
    INTO v_pay
  FROM public.vendor_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor payment not found: %', p_payment_id;
  END IF;
  IF v_pay.status <> 'active' THEN
    RAISE EXCEPTION 'Vendor payment must be active to apply (current: %)', v_pay.status;
  END IF;
  IF p_amount > v_pay.unapplied_amount THEN
    RAISE EXCEPTION 'Amount % exceeds unapplied balance %', p_amount, v_pay.unapplied_amount;
  END IF;

  SELECT id, vendor_id, total, amount_paid, currency
    INTO v_inv
  FROM public.vendor_invoices
  WHERE id = p_invoice_id
    AND status IN ('approved', 'partially_received', 'received')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice % is not payable', p_invoice_id;
  END IF;
  IF v_inv.vendor_id <> v_pay.vendor_id THEN
    RAISE EXCEPTION 'Vendor invoice % belongs to a different vendor', p_invoice_id;
  END IF;
  IF v_inv.currency IS DISTINCT FROM v_pay.currency THEN
    RAISE EXCEPTION
      'Cannot settle a % invoice with a % payment. Record the payment in % instead.',
      v_inv.currency, v_pay.currency, v_inv.currency
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.vendor_payment_applications (
    payment_id, invoice_id, amount_applied, applied_by
  )
  VALUES (p_payment_id, p_invoice_id, p_amount, v_actor)
  RETURNING id INTO v_app;

  UPDATE public.vendor_invoices
  SET
    amount_paid    = LEAST(amount_paid + p_amount, total),
    payment_status = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN 'paid'
      WHEN LEAST(amount_paid + p_amount, total) > 0     THEN 'partial'
      ELSE 'unpaid'
      END,
    paid_at = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN NOW()
      ELSE paid_at
      END,
    updated_at = NOW()
  WHERE id = p_invoice_id;

  RETURN v_app;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.approve_sales_order(p_so_id uuid, p_actor_email text)
 RETURNS SETOF sales_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_so   record;
  v_line record;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to approve sales orders';
  END IF;

  SELECT * INTO v_so
  FROM public.sales_orders
  WHERE id = p_so_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found: %', p_so_id;
  END IF;

  IF v_so.status <> 'sent' THEN
    RAISE EXCEPTION 'Sales order must be submitted for approval first (current: %)', v_so.status;
  END IF;

  FOR v_line IN
    SELECT
      (line->>'product_id')::uuid AS product_id,
      (line->>'qty')::integer     AS qty
    FROM jsonb_array_elements(v_so.line_items) AS line
    WHERE (line->>'product_id') IS NOT NULL AND (line->>'product_id') <> ''
  LOOP
    PERFORM public.funnel_reserve_line(
      'sales_order', p_so_id, v_line.product_id, v_line.qty, p_actor_email
    );
  END LOOP;

  UPDATE public.sales_orders
  SET
    status       = 'delivered',
    confirmed_at = NOW(),
    delivered_at = NOW(),
    updated_at   = NOW()
  WHERE id = p_so_id;

  RETURN QUERY SELECT * FROM public.sales_orders WHERE id = p_so_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.archive_warehouse(p_warehouse_id uuid, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unit_count  integer;
  v_stock_count integer;
  v_is_system   boolean;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to archive a warehouse' USING ERRCODE = 'P0001';
  END IF;

  SELECT is_system INTO v_is_system FROM public.warehouses WHERE id = p_warehouse_id;

  IF v_is_system THEN
    RAISE EXCEPTION 'System warehouses cannot be archived' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_unit_count
  FROM public.inventory_units
  WHERE warehouse_id = p_warehouse_id AND status <> 'closed';

  SELECT COUNT(*) INTO v_stock_count
  FROM public.warehouse_stock
  WHERE warehouse_id = p_warehouse_id AND quantity > 0;

  IF v_unit_count > 0 OR v_stock_count > 0 THEN
    RAISE EXCEPTION 'Cannot archive warehouse: % live serialized unit(s) and % bulk-stock product(s) still present',
      v_unit_count, v_stock_count
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.warehouses SET is_active = false WHERE id = p_warehouse_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.assert_not_system_warehouse(p_warehouse_id uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wh record;
BEGIN
  IF p_warehouse_id IS NULL THEN
    RETURN;
  END IF;

  SELECT name, is_system INTO v_wh
  FROM public.warehouses
  WHERE id = p_warehouse_id;

  IF FOUND AND v_wh.is_system THEN
    RAISE EXCEPTION
      '"%" is a protected system location and cannot be the % of a manual stock transfer — use the RMA workflow instead',
      v_wh.name, p_role
      USING ERRCODE = 'P0001';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.assert_purchase_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_allowed text[];
BEGIN
  -- Only interested in an actual change. The document forms send the whole row
  -- back on every save, so same-value writes are routine and must pass through.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'purchase_orders' THEN
    v_allowed := CASE OLD.status
      -- Send for approval, or abandon before anyone has looked at it.
      WHEN 'draft'                THEN ARRAY['sent', 'pending_confirmation', 'cancelled']
      -- Awaiting a manager: approve, reject back to draft, or let it lapse.
      WHEN 'sent'                 THEN ARRAY['pending_confirmation', 'confirmed', 'draft', 'cancelled', 'expired']
      WHEN 'pending_confirmation' THEN ARRAY['confirmed', 'draft', 'cancelled', 'expired']
      -- Approved. Completion states are written only by receive_vendor_invoice.
      WHEN 'confirmed'            THEN ARRAY['partially_completed', 'completed', 'cancelled', 'expired']
      -- Part-delivered. Cancelling is refused from here: stock has arrived.
      WHEN 'partially_completed'  THEN ARRAY['completed']
      -- Terminal.
      WHEN 'completed'            THEN ARRAY[]::text[]
      WHEN 'cancelled'            THEN ARRAY[]::text[]
      -- Lapsed rather than refused, so it may be revived or closed off.
      WHEN 'expired'              THEN ARRAY['draft', 'cancelled']
      ELSE ARRAY[]::text[]
    END;
  ELSE
    v_allowed := CASE OLD.status
      WHEN 'draft'              THEN ARRAY['pending_approval', 'cancelled']
      WHEN 'pending_approval'   THEN ARRAY['approved', 'draft', 'cancelled']
      -- Approved but nothing received yet, so cancelling is still safe.
      -- Not back to 'draft': that would reopen the line items for editing
      -- without a second approval.
      WHEN 'approved'           THEN ARRAY['partially_received', 'received', 'cancelled']
      -- Stock has arrived. Forward to fully received only.
      WHEN 'partially_received' THEN ARRAY['received']
      WHEN 'received'           THEN ARRAY[]::text[]
      WHEN 'cancelled'          THEN ARRAY[]::text[]
      ELSE ARRAY[]::text[]
    END;
  END IF;

  IF NOT (NEW.status = ANY (v_allowed)) THEN
    RAISE EXCEPTION
      'Illegal % status change: % -> %. Allowed from "%": %.',
      replace(TG_TABLE_NAME, '_', ' '),
      OLD.status,
      NEW.status,
      OLD.status,
      CASE WHEN array_length(v_allowed, 1) IS NULL
           THEN 'nothing (terminal state)'
           ELSE array_to_string(v_allowed, ', ')
      END
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.assert_tracking_mode_change_is_safe()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_units integer;
  v_bulk  integer;
BEGIN
  -- Only interested in an actual change of the mode.
  IF NEW.stock_tracking_mode IS NOT DISTINCT FROM OLD.stock_tracking_mode THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_units
  FROM public.inventory_units
  WHERE product_id = NEW.id
    AND status IN ('company_stock', 'active_rma');

  SELECT COALESCE(sum(quantity), 0) INTO v_bulk
  FROM public.warehouse_stock
  WHERE product_id = NEW.id;

  IF v_units > 0 OR v_bulk > 0 THEN
    RAISE EXCEPTION
      'Cannot change stock tracking mode for "%": % serialized unit(s) and % bulk in stock. Move or remove the stock first — switching modes would hide it.',
      NEW.product_name, v_units, v_bulk
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_sales_order(p_so_id uuid, p_actor_email text)
 RETURNS SETOF sales_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_so    record;
  v_email text := public.rma_current_user_email();
BEGIN
  -- Coarse gate: nobody outside sales or management cancels an order, and
  -- this costs no lookup, so it answers before revealing whether the id is real.
  IF NOT (public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep') THEN
    RAISE EXCEPTION 'Not authorized to cancel sales orders' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found: %', p_so_id;
  END IF;

  -- Fine-grained: a rep may cancel their own orders, not a colleague's.
  -- Mirrors sales_update_sales_orders.
  IF NOT (public.rma_is_manager_or_above()
          OR v_so.assigned_rep = v_email
          OR v_so.created_by  = v_email) THEN
    RAISE EXCEPTION 'Not authorized to cancel this sales order' USING ERRCODE = 'P0001';
  END IF;

  IF v_so.status = 'cancelled' THEN
    RAISE EXCEPTION 'Sales order is already cancelled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.crm_invoices
    WHERE so_id = p_so_id AND doc_status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Cannot cancel — an invoice exists; void or credit it first';
  END IF;

  PERFORM public.release_units('sales_order', p_so_id, p_actor_email);

  UPDATE public.sales_orders
  SET status = 'cancelled', updated_at = NOW()
  WHERE id = p_so_id;

  RETURN QUERY SELECT * FROM public.sales_orders WHERE id = p_so_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.convert_quotation_to_so(p_quotation_id uuid, p_actor_email text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_qt         record;
  v_so_code    text;
  v_so_id      uuid;
  v_null_lines bigint;
BEGIN
  IF NOT (public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep') THEN
    RAISE EXCEPTION 'Not authorized to convert quotations' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_qt FROM public.quotations WHERE id = p_quotation_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quotation not found: %', p_quotation_id;
  END IF;

  IF v_qt.status IN ('cancelled', 'declined', 'converted') THEN
    RAISE EXCEPTION 'Cannot convert a % quotation', v_qt.status;
  END IF;

  SELECT count(*) INTO v_null_lines
  FROM jsonb_array_elements(v_qt.line_items) AS line
  WHERE (line->>'product_id') IS NULL OR (line->>'product_id') = '';

  IF v_null_lines > 0 THEN
    RAISE EXCEPTION '% line(s) have no product — promote them to real products first', v_null_lines;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sales_orders
    WHERE quotation_id = p_quotation_id AND status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Quotation already converted to a sales order';
  END IF;

  v_so_code := public.generate_doc_code('SO');

  INSERT INTO public.sales_orders (
    so_code, quotation_id, customer_id, status, line_items,
    subtotal, discount_amount, tax_amount, total,
    payment_terms, reference_po, notes, assigned_rep, created_by
  )
  VALUES (
    v_so_code, p_quotation_id, v_qt.customer_id, 'draft', v_qt.line_items,
    v_qt.subtotal, v_qt.discount_amount, v_qt.tax_amount, v_qt.total,
    v_qt.payment_terms, v_qt.reference_po, v_qt.notes,
    COALESCE(v_qt.assigned_rep, p_actor_email), p_actor_email
  )
  RETURNING id INTO v_so_id;

  UPDATE public.quotations
  SET status = 'converted', updated_at = NOW()
  WHERE id = p_quotation_id;

  RETURN v_so_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.crm_convert_lead(p_lead_id uuid, p_deal_title text, p_pipeline_id uuid, p_deal_value numeric DEFAULT NULL::numeric, p_existing_customer_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(customer_id uuid, deal_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lead        public.leads%ROWTYPE;
  v_customer_id uuid;
  v_deal_id     uuid;
  v_first_stage text;
BEGIN
  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id;
  END IF;

  IF v_lead.converted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Lead % is already converted', p_lead_id;
  END IF;

  IF NOT (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND v_lead.assigned_rep = public.rma_current_user_email())
  ) THEN
    RAISE EXCEPTION 'Not authorized to convert this lead';
  END IF;

  IF p_existing_customer_id IS NOT NULL THEN
    -- FR-012: validate the customer exists before accepting it
    IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_existing_customer_id) THEN
      RAISE EXCEPTION 'Customer % not found', p_existing_customer_id;
    END IF;
    v_customer_id := p_existing_customer_id;
  ELSE
    INSERT INTO public.customers (
      customer_code, customer_type, contact_person, company_name, mobile, email,
      lifecycle_stage, lead_source, assigned_rep
    ) VALUES (
      'CB-' || floor(10000000 + random() * 89999999)::bigint::text,
      CASE WHEN v_lead.company_name IS NOT NULL THEN 'B2B' ELSE 'B2C' END,
      v_lead.full_name,
      v_lead.company_name,
      COALESCE(v_lead.phone, ''),
      v_lead.email,
      'customer',
      v_lead.source,
      v_lead.assigned_rep
    )
    RETURNING id INTO v_customer_id;
  END IF;

  SELECT stage->>'id' INTO v_first_stage
  FROM public.pipelines, jsonb_array_elements(stages) AS stage
  WHERE pipelines.id = p_pipeline_id
  ORDER BY (stage->>'order')::int ASC
  LIMIT 1;

  IF v_first_stage IS NULL THEN
    RAISE EXCEPTION 'Pipeline % has no stages', p_pipeline_id;
  END IF;

  INSERT INTO public.deals (
    deal_code, title, customer_id, pipeline_id, stage, value, assigned_rep, created_by
  ) VALUES (
    'OPP-' || floor(10000000 + random() * 89999999)::bigint::text,
    p_deal_title, v_customer_id, p_pipeline_id, v_first_stage,
    p_deal_value, v_lead.assigned_rep,
    public.rma_current_user_email()   -- fix: was auth.uid() in 20260726
  )
  RETURNING id INTO v_deal_id;

  UPDATE public.leads
  SET status                = 'converted',
      converted_at          = now(),
      converted_customer_id = v_customer_id,
      converted_deal_id     = v_deal_id,
      updated_at            = now()
  WHERE id = p_lead_id;

  RETURN QUERY SELECT v_customer_id, v_deal_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.crm_update_customer_last_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_customer_id uuid;
BEGIN
  IF NEW.related_type = 'customer' THEN
    v_customer_id := NEW.related_id;
  ELSIF NEW.related_type = 'contact' THEN
    SELECT customer_id INTO v_customer_id FROM public.contacts WHERE id = NEW.related_id;
  ELSIF NEW.related_type = 'deal' THEN
    SELECT customer_id INTO v_customer_id FROM public.deals WHERE id = NEW.related_id;
  ELSIF NEW.related_type = 'lead' THEN
    SELECT converted_customer_id INTO v_customer_id FROM public.leads WHERE id = NEW.related_id;
  END IF;

  IF v_customer_id IS NOT NULL THEN
    UPDATE public.customers SET last_activity_at = now() WHERE id = v_customer_id;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_customer_cascade(p_customer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tickets integer;
  v_name    text;
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION 'Not authorized to delete customers' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_tickets FROM rma_tickets WHERE customer_id = p_customer_id;

  IF v_tickets > 0 THEN
    SELECT COALESCE(company_name, contact_person, id::text) INTO v_name
    FROM customers WHERE id = p_customer_id;

    RAISE EXCEPTION
      'Cannot delete "%": % RMA ticket(s) reference this customer. Delete or reassign the tickets first — their serials, repair outcomes and stock history would go with them.',
      COALESCE(v_name, p_customer_id::text), v_tickets
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM activities
   WHERE related_type = 'customer' AND related_id = p_customer_id;
  DELETE FROM customer_notes WHERE customer_id = p_customer_id;
  DELETE FROM customers      WHERE id          = p_customer_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_customers_cascade(p_customer_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tickets   integer;
  v_customers integer;
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION 'Not authorized to delete customers' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*), count(DISTINCT customer_id)
    INTO v_tickets, v_customers
  FROM rma_tickets
  WHERE customer_id = ANY(p_customer_ids);

  IF v_tickets > 0 THEN
    RAISE EXCEPTION
      'Cannot delete: % of the selected customers have % RMA ticket(s) between them. Delete or reassign those tickets first.',
      v_customers, v_tickets
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM activities
   WHERE related_type = 'customer' AND related_id = ANY(p_customer_ids);
  DELETE FROM customer_notes WHERE customer_id = ANY(p_customer_ids);
  DELETE FROM customers      WHERE id          = ANY(p_customer_ids);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.deliver_parts(p_doc_type text, p_doc_id uuid, p_part_id uuid, p_qty integer, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.parts
  SET
    quantity          = quantity          - p_qty,
    reserved_quantity = GREATEST(reserved_quantity - p_qty, 0)
  WHERE id = p_part_id
    AND quantity >= p_qty;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot deliver % units of part % — insufficient quantity', p_qty, p_part_id
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, actor_email)
  VALUES
    ('part', p_part_id, p_doc_type, p_doc_id, 'deliver', p_qty, p_actor_email);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.deliver_units(p_doc_type text, p_doc_id uuid, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unit record;
BEGIN
  FOR v_unit IN
    SELECT id, reservation_status FROM public.inventory_units
    WHERE reserved_by_doc_type = p_doc_type
      AND reserved_by_doc_id   = p_doc_id
      AND reservation_status   IN ('reserved', 'available')
    FOR UPDATE
  LOOP
    UPDATE public.inventory_units
    SET
      reservation_status   = 'delivered',
      reserved_by_doc_type = NULL,
      reserved_by_doc_id   = NULL,
      reserved_at          = NULL,
      reserved_by_email    = NULL
    WHERE id = v_unit.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit.id, p_doc_type, p_doc_id, 'deliver', 1,
       v_unit.reservation_status, 'delivered', p_actor_email);
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.deliver_warehouse_stock(p_doc_type text, p_doc_id uuid, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT
      sm.ref_id AS warehouse_stock_id,
      SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
        - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) AS net_qty
    FROM public.stock_moves sm
    WHERE sm.doc_type = p_doc_type
      AND sm.doc_id IS NOT DISTINCT FROM p_doc_id
      AND sm.ref_type = 'warehouse_stock'
    GROUP BY sm.ref_id
    HAVING SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
         - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) > 0
  LOOP
    UPDATE public.warehouse_stock
    SET quantity = quantity - v_row.net_qty,
        reserved_quantity = GREATEST(reserved_quantity - v_row.net_qty, 0),
        updated_at = now()
    WHERE id = v_row.warehouse_stock_id
      AND quantity >= v_row.net_qty;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot deliver % units from warehouse_stock % — quantity would go negative',
        v_row.net_qty, v_row.warehouse_stock_id
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_row.warehouse_stock_id, p_doc_type, p_doc_id, 'deliver', v_row.net_qty, 'reserved', 'delivered', p_actor_email);
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.funnel_reserve_line(p_doc_type text, p_doc_id uuid, p_product_id uuid, p_qty integer, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_product_type  text;
  v_tracking_mode text;
BEGIN
  SELECT product_type, stock_tracking_mode INTO v_product_type, v_tracking_mode
  FROM public.products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_product_type = 'service' THEN
    RETURN; -- service lines never touch inventory
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    PERFORM public.reserve_warehouse_stock(p_doc_type, p_doc_id, p_product_id, p_qty, p_actor_email);
  ELSE
    -- 'serialized' (default) — always requires individual units.
    -- reserve_units raises "Insufficient stock" at 0 available (fixes the
    -- silent no-op from before Sprint 7.6, audit A2). Unchanged from 20260738.
    PERFORM public.reserve_units(p_doc_type, p_doc_id, p_product_id, p_qty, p_actor_email);
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.generate_doc_code(p_prefix text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.rma_is_staff() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  RETURN p_prefix || '-' || LPAD((FLOOR(RANDOM() * 90000000) + 10000000)::text, 8, '0');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_converted_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only enforce once the lead has been converted.
  IF OLD.converted_at IS NOT NULL THEN
    IF (
      NEW.full_name              IS DISTINCT FROM OLD.full_name              OR
      NEW.company_name           IS DISTINCT FROM OLD.company_name           OR
      NEW.phone                  IS DISTINCT FROM OLD.phone                  OR
      NEW.email                  IS DISTINCT FROM OLD.email                  OR
      NEW.source                 IS DISTINCT FROM OLD.source                 OR
      NEW.status                 IS DISTINCT FROM OLD.status                 OR
      NEW.assigned_rep           IS DISTINCT FROM OLD.assigned_rep           OR
      NEW.converted_at           IS DISTINCT FROM OLD.converted_at           OR
      NEW.converted_customer_id  IS DISTINCT FROM OLD.converted_customer_id  OR
      NEW.converted_deal_id      IS DISTINCT FROM OLD.converted_deal_id
    ) THEN
      RAISE EXCEPTION 'Converted leads are immutable except for notes';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.issue_credit_note(p_cn_id uuid, p_actor_email text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cn            record;
  v_code          text;
  v_actor         text;
  v_inv_remaining numeric(12,2);
  v_apply_amount  numeric(12,2);
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to issue credit notes';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  SELECT * INTO v_cn
  FROM public.credit_notes
  WHERE id = p_cn_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id;
  END IF;

  IF v_cn.status <> 'draft' THEN
    RAISE EXCEPTION 'Credit note is already % — cannot issue again', v_cn.status;
  END IF;

  v_code := public.nextval_for_type('credit_note');

  UPDATE public.credit_notes
  SET
    cn_code           = v_code,
    status            = 'issued',
    remaining_balance = v_cn.total,
    issued_at         = NOW(),
    updated_at        = NOW()
  WHERE id = p_cn_id;

  IF v_cn.source_invoice_id IS NOT NULL THEN
    SELECT GREATEST(total - amount_paid, 0) INTO v_inv_remaining
    FROM public.crm_invoices
    WHERE id = v_cn.source_invoice_id
      AND doc_status = 'posted'
    FOR UPDATE;

    IF FOUND AND v_inv_remaining > 0 THEN
      v_apply_amount := LEAST(v_cn.total, v_inv_remaining);

      INSERT INTO public.credit_note_applications (
        credit_note_id, invoice_id, amount_applied, applied_by
      )
      VALUES (p_cn_id, v_cn.source_invoice_id, v_apply_amount, v_actor);

      UPDATE public.crm_invoices
      SET
        amount_paid    = LEAST(amount_paid + v_apply_amount, total),
        payment_status = CASE
          WHEN LEAST(amount_paid + v_apply_amount, total) >= total THEN 'paid'
          WHEN LEAST(amount_paid + v_apply_amount, total) > 0     THEN 'partial'
          ELSE 'unpaid'
          END,
        paid_at = CASE
          WHEN LEAST(amount_paid + v_apply_amount, total) >= total THEN NOW()
          ELSE paid_at
          END,
        updated_at = NOW()
      WHERE id = v_cn.source_invoice_id;
    END IF;
  END IF;

  RETURN v_code;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.link_serial_to_rma_ticket(p_serial text, p_ticket_id uuid, p_rma_number text, p_actor_email text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unit     record;
  v_received record;
  v_doc      text;
BEGIN
  -- Same posture as move_rma_units: any non-viewer staff member can do this,
  -- because it happens as a side effect of an ordinary ticket save.
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to link a serial to an RMA ticket' USING ERRCODE = 'P0001';
  END IF;

  IF btrim(COALESCE(p_serial, '')) = '' THEN
    RAISE EXCEPTION 'A serial number is required to link an existing unit' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_unit
  FROM public.inventory_units
  WHERE btrim(serial_number) = btrim(p_serial)
    AND status <> 'closed'          -- mirrors inv_units_serial_unique_idx
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No live unit holds serial %', p_serial USING ERRCODE = 'P0001';
  END IF;

  IF v_unit.status = 'active_rma' THEN
    RAISE EXCEPTION 'Serial % is already on RMA % — resolve that ticket before opening another',
      p_serial, COALESCE(v_unit.rma_number, '(unknown)')
      USING ERRCODE = 'P0001';
  END IF;

  IF v_unit.status <> 'company_stock' THEN
    RAISE EXCEPTION 'Serial % is % — only a unit in company stock can be taken onto an RMA',
      p_serial, v_unit.status
      USING ERRCODE = 'P0001';
  END IF;

  IF v_unit.reservation_status <> 'available' THEN
    -- Point at the holding document. The reservation link is polymorphic
    -- (reserved_by_doc_type / reserved_by_doc_id, 20260719), so the id is
    -- reported as-is rather than joined — "reserved" with nothing to look up
    -- just sends the user hunting.
    v_doc := COALESCE(
      NULLIF(btrim(COALESCE(v_unit.reserved_by_doc_type, '')), '') || ' ' || COALESCE(v_unit.reserved_by_doc_id::text, ''),
      'an open document'
    );

    RAISE EXCEPTION 'Serial % is % on % — release it there before opening an RMA',
      p_serial, v_unit.reservation_status, v_doc
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_received
  FROM public.warehouses
  WHERE code = 'RMA-RECEIVED' AND is_system;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'System location RMA-RECEIVED is missing — apply 20260764 first'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.inventory_units
  SET
    status        = 'active_rma',
    rma_ticket_id = p_ticket_id,
    rma_number    = p_rma_number,
    warehouse_id  = v_received.id
  WHERE id = v_unit.id;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
  VALUES
    ('unit', v_unit.id, 'rma_ticket', p_ticket_id, 'transfer', 1,
     COALESCE(v_unit.warehouse_id::text, 'unassigned'), v_received.id::text, p_actor_email);

  RETURN v_unit.id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_email text, p_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := public.rma_current_user_email();
BEGIN
  IF v_email IS NULL OR NOT public.rma_is_staff() THEN
    RAISE EXCEPTION 'Not authorized to mark notifications read' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.notifications
  SET read_by = array_append(read_by, v_email)
  WHERE id = ANY(p_ids)
    AND NOT (COALESCE(read_by, '{}') @> ARRAY[v_email]);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.move_rma_units(p_ticket_id uuid, p_moves jsonb, p_actor_email text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_move        jsonb;
  v_unit        record;
  v_target_wh   record;
  v_moved_count integer := 0;
BEGIN
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to move RMA units' USING ERRCODE = 'P0001';
  END IF;

  FOR v_move IN SELECT * FROM jsonb_array_elements(p_moves)
  LOOP
    SELECT * INTO v_unit
    FROM public.inventory_units
    WHERE id = (v_move->>'unit_id')::uuid
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit % not found', v_move->>'unit_id' USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.rma_ticket_id IS DISTINCT FROM p_ticket_id THEN
      RAISE EXCEPTION 'Unit % does not belong to ticket %', v_unit.id, p_ticket_id
        USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.status <> 'active_rma' THEN
      RAISE EXCEPTION 'Unit % is not an active RMA unit (status=%)', v_unit.id, v_unit.status
        USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.reservation_status <> 'available' THEN
      RAISE EXCEPTION 'Unit % is currently % — cannot auto-move a reserved/delivered unit',
        v_unit.id, v_unit.reservation_status
        USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_target_wh
    FROM public.warehouses
    WHERE code = (v_move->>'to_code') AND is_system
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown system RMA location code: %', v_move->>'to_code'
        USING ERRCODE = 'P0001';
    END IF;

    -- Idempotent no-op: unit is already at its target location.
    CONTINUE WHEN v_unit.warehouse_id = v_target_wh.id;

    UPDATE public.inventory_units
    SET warehouse_id = v_target_wh.id
    WHERE id = v_unit.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit.id, 'rma_ticket', p_ticket_id, 'transfer', 1,
       COALESCE(v_unit.warehouse_id::text, 'unassigned'), v_target_wh.id::text, p_actor_email);

    v_moved_count := v_moved_count + 1;
  END LOOP;

  RETURN v_moved_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.nextval_for_type(p_seq_type text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_year     integer := EXTRACT(YEAR FROM NOW())::integer;
  v_next     integer;
  v_prefix   text;
BEGIN
  UPDATE public.document_sequences
  SET
    last_value = CASE WHEN seq_year = v_year THEN last_value + 1 ELSE 1 END,
    seq_year   = v_year
  WHERE seq_type = p_seq_type
  RETURNING last_value INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Unknown sequence type: %', p_seq_type;
  END IF;

  v_prefix := CASE p_seq_type
    WHEN 'invoice'        THEN 'INV'
    WHEN 'credit_note'    THEN 'CN'
    WHEN 'payment'        THEN 'PAY'
    WHEN 'vendor_invoice' THEN 'VI'
    WHEN 'vendor_payment' THEN 'VP'
    ELSE UPPER(p_seq_type)
  END;

  RETURN v_prefix || '-' || v_year::text || '-' || LPAD(v_next::text, 5, '0');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.post_invoice(p_invoice_id uuid, p_actor_email text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv       record;
  v_code      text;
  v_expected  integer;
  v_reserved  integer;
  v_cogs      numeric := 0;   -- 20260797
  v_unknown   integer := 0;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  SELECT * INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.doc_status <> 'draft' THEN
    RAISE EXCEPTION 'Invoice is already % — cannot post again', v_inv.doc_status;
  END IF;

  -- ── Precondition: the serialized stock this invoice bills must be reserved ──
  IF v_inv.so_id IS NOT NULL THEN
    -- How many serialized units do this invoice's lines actually bill for?
    SELECT COALESCE(SUM((li ->> 'qty')::numeric), 0)::integer
      INTO v_expected
    FROM jsonb_array_elements(COALESCE(v_inv.line_items, '[]'::jsonb)) AS li
    JOIN public.products p
      ON p.id = NULLIF(li ->> 'product_id', '')::uuid
    WHERE p.stock_tracking_mode = 'serialized';

    IF v_expected > 0 THEN
      -- How many are actually held for the linked SO right now?
      SELECT COUNT(*)
        INTO v_reserved
      FROM public.inventory_units
      WHERE reserved_by_doc_type = 'sales_order'
        AND reserved_by_doc_id   = v_inv.so_id
        AND reservation_status   = 'reserved';

      IF v_reserved < v_expected THEN
        RAISE EXCEPTION
          'Cannot post this invoice: it bills % serialized unit(s) but only % are reserved on sales order %. Posting would charge the customer for stock the system never hands over.',
          v_expected, v_reserved, v_inv.so_id
          USING HINT = 'Voiding a posted invoice releases its reservations. A sales order in that state cannot currently re-reserve stock from the UI — raise a new sales order for the goods still owed.';
      END IF;
    END IF;
  END IF;

  -- Assign gapless code inside this tx; rolls back if deliver_units fails below
  v_code := public.nextval_for_type('invoice');

  UPDATE public.crm_invoices
  SET
    inv_code   = v_code,
    doc_status = 'posted',
    posted_at  = NOW(),
    updated_at = NOW()
  WHERE id = p_invoice_id;

  -- ── Cost of goods sold, captured BEFORE the stock moves ──────────────────
  -- It has to be read first: delivering serialised units changes their
  -- reservation, and delivering bulk stock changes the very average the cost
  -- is read from. Afterwards there is nothing left to measure.
  --
  -- Captured on the invoice rather than computed on demand later, because the
  -- cost of what was sold is a fact about the day it shipped. Re-deriving it
  -- next quarter from a moving average would report a different profit for the
  -- same sale every time stock is revalued.
  IF v_inv.so_id IS NOT NULL THEN
    SELECT c.cogs_base, c.unknown_qty
      INTO v_cogs, v_unknown
      FROM public.rma_invoice_cogs(p_invoice_id) c;
  END IF;

  UPDATE public.crm_invoices
  SET cogs_base       = COALESCE(v_cogs, 0),
      cogs_unknown_qty = COALESCE(v_unknown, 0)
  WHERE id = p_invoice_id;

  -- Deliver inventory reserved by the linked SO — same transaction (Invariant I1)
  IF v_inv.so_id IS NOT NULL THEN
    PERFORM public.deliver_units('sales_order', v_inv.so_id, p_actor_email);

    -- 20260797: bulk stock was reserved by funnel_reserve_line when the sales
    -- order was approved and then never delivered by anything — the customer
    -- was billed and the quantity never left the warehouse, while
    -- reserved_quantity grew until no further bulk sale of that product could
    -- be reserved at all. deliver_warehouse_stock existed and had no caller
    -- anywhere in the codebase.
    PERFORM public.deliver_warehouse_stock('sales_order', v_inv.so_id, p_actor_email);
  END IF;

  RETURN v_code;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.promote_rma_unit(p_unit_id uuid, p_warehouse_id uuid, p_actor_email text, p_resolution_type text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unit      record;
  v_dest      record;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to promote an RMA unit to sellable stock' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_unit FROM public.inventory_units WHERE id = p_unit_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unit % not found', p_unit_id USING ERRCODE = 'P0001';
  END IF;

  IF v_unit.status <> 'active_rma' THEN
    RAISE EXCEPTION 'Unit % is not an active RMA unit (status=%)', p_unit_id, v_unit.status
      USING ERRCODE = 'P0001';
  END IF;

  IF v_unit.reservation_status <> 'available' THEN
    RAISE EXCEPTION 'Unit % is currently % — cannot promote a reserved/delivered unit',
      p_unit_id, v_unit.reservation_status
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_dest FROM public.warehouses WHERE id = p_warehouse_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Destination warehouse % not found', p_warehouse_id USING ERRCODE = 'P0001';
  END IF;

  IF v_dest.is_system THEN
    RAISE EXCEPTION 'Cannot promote into a system RMA/transit/virtual location — choose a sellable warehouse'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_dest.warehouse_type IS NOT NULL AND v_dest.warehouse_type NOT IN ('main', 'branch') THEN
    RAISE EXCEPTION 'Destination warehouse "%" is not a sellable location (type=%)', v_dest.name, v_dest.warehouse_type
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.inventory_units
  SET
    status          = 'company_stock',
    warehouse_id    = p_warehouse_id,
    resolved_date   = now(),
    resolution_type = COALESCE(p_resolution_type, resolution_type)
  WHERE id = p_unit_id;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
  VALUES
    ('unit', p_unit_id, 'rma_ticket', v_unit.rma_ticket_id, 'transfer', 1,
     COALESCE(v_unit.warehouse_id::text, 'unassigned'), p_warehouse_id::text, p_actor_email);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_system_warehouse()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'System warehouse "%" cannot be deleted', OLD.code
      USING ERRCODE = 'P0001';
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.code IS DISTINCT FROM OLD.code
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.warehouse_type IS DISTINCT FROM OLD.warehouse_type
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION 'System warehouse "%" cannot be renamed, re-coded, re-typed, deactivated, or un-flagged', OLD.code
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.queue_overdue_ticket_emails()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ticket RECORD;
BEGIN
  FOR ticket IN
    SELECT t.id, t.rma_number, t.customer_name, t.customer_email,
           t.due_date, t.ticket_status, t.priority
    FROM public.rma_tickets t
    WHERE t.due_date IS NOT NULL
      AND t.due_date::date < CURRENT_DATE
      AND t.ticket_status NOT IN ('Closed','Completed','Cancelled','Rejected')
      AND t.customer_email IS NOT NULL AND t.customer_email <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.notification_queue q
        WHERE q.event_type = 'ticket.overdue'
          AND q.payload->>'ticketId' = t.id::text
          AND q.created_at > now() - interval '23 hours'
      )
  LOOP
    INSERT INTO public.notification_queue
      (job_type, event_type, payload, status, priority, scheduled_at, created_by)
    VALUES (
      'email', 'ticket.overdue',
      jsonb_build_object(
        'to', ticket.customer_email,
        'templateName', 'ticket_overdue',
        'ticketId', ticket.id::text,
        'variables', jsonb_build_object(
          'recipient_name', COALESCE(ticket.customer_name,'Customer'),
          'customer_name',  COALESCE(ticket.customer_name,'Customer'),
          'rma_number',     ticket.rma_number,
          'status',         ticket.ticket_status,
          'priority',       COALESCE(ticket.priority,'Normal'),
          'due_date',       to_char(ticket.due_date,'DD/MM/YYYY'),
          'days_overdue',   (CURRENT_DATE - ticket.due_date::date)::text
        )
      ),
      'pending', 3, now(), 'pg_cron'
    );
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.recalculate_stock(p_product_id uuid, p_warehouse_id uuid, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ws_id             uuid;
  v_computed_reserved integer;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to recalculate stock' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_ws_id FROM public.warehouse_stock
  WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No warehouse_stock row for this product/warehouse' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(
    CASE WHEN move_type = 'reserve' THEN qty
         WHEN move_type IN ('release', 'deliver') THEN -qty
         ELSE 0 END), 0)
  INTO v_computed_reserved
  FROM public.stock_moves
  WHERE ref_type = 'warehouse_stock' AND ref_id = v_ws_id;

  UPDATE public.warehouse_stock
  SET reserved_quantity = GREATEST(v_computed_reserved, 0), updated_at = now()
  WHERE id = v_ws_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.receive_stock(p_product_id uuid, p_warehouse_id uuid, p_actor_email text, p_serial text DEFAULT NULL::text, p_qty integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tracking_mode text;
  v_product_name  text;
  v_unit_id       uuid;
  v_ws_id         uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to receive stock' USING ERRCODE = 'P0001';
  END IF;

  SELECT stock_tracking_mode, product_name INTO v_tracking_mode, v_product_name
  FROM public.products WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = 'P0001';
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    IF p_qty IS NULL OR p_qty <= 0 THEN
      RAISE EXCEPTION 'A positive quantity is required to receive bulk stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT id INTO v_ws_id FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.warehouse_stock
        (product_id, warehouse_id, quantity, reserved_quantity, uncosted_quantity)
      VALUES (p_product_id, p_warehouse_id, p_qty, 0, p_qty)
      RETURNING id INTO v_ws_id;
    ELSE
      -- Setting uncosted_quantity explicitly keeps rma_hold_unit_cost() out of
      -- the way: these units are added as unknown rather than being assumed to
      -- cost whatever the bin already averages.
      UPDATE public.warehouse_stock
      SET quantity          = quantity + p_qty,
          uncosted_quantity = uncosted_quantity + p_qty,
          updated_at        = now()
      WHERE id = v_ws_id;
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_ws_id, 'manual', NULL, 'receive', p_qty, NULL, 'available', p_actor_email);
  ELSE
    IF p_serial IS NULL OR btrim(p_serial) = '' THEN
      RAISE EXCEPTION 'A serial number is required to receive serialized stock' USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      -- unit_cost_base is left NULL: unknown, not free.
      INSERT INTO public.inventory_units
        (product_id, product_name, serial_number, status, reservation_status, warehouse_id, created_date)
      VALUES
        (p_product_id, v_product_name, p_serial, 'company_stock', 'available', p_warehouse_id, now())
      RETURNING id INTO v_unit_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Serial number % is already in use', p_serial USING ERRCODE = 'P0001';
    END;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit_id, 'manual', NULL, 'receive', 1, NULL, 'available', p_actor_email);
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.receive_vendor_invoice(p_vi_id uuid, p_receipt_lines jsonb, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_vi                 record;
  v_receipt             jsonb;
  v_product_id          uuid;
  v_warehouse_id        uuid;
  v_tracking_mode       text;
  v_serial              text;
  v_unit_id             uuid;
  v_ws_id               uuid;
  v_received_this_line  integer;
  v_receipt_totals      jsonb := '[]'::jsonb;
  v_final_line_items    jsonb;
  v_all_complete        boolean;
  v_po_status           text;
  v_unit_cost           numeric;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to receive a vendor invoice' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_vi FROM public.vendor_invoices WHERE id = p_vi_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice % not found', p_vi_id USING ERRCODE = 'P0001';
  END IF;
  IF v_vi.status NOT IN ('approved', 'partially_received') THEN
    RAISE EXCEPTION 'Vendor invoice must be approved before receiving (current status: %)', v_vi.status
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_receipt IN SELECT * FROM jsonb_array_elements(p_receipt_lines)
  LOOP
    v_product_id   := (v_receipt->>'product_id')::uuid;
    v_warehouse_id := (v_receipt->>'warehouse_id')::uuid;

    SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = v_product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % not found', v_product_id USING ERRCODE = 'P0001';
    END IF;

    -- What this product costs, landed, on this invoice. Computed per receipt
    -- line rather than once, because a single invoice can carry the same
    -- product on more than one line; the function returns the line's own cost.
    SELECT c.unit_cost_base INTO v_unit_cost
      FROM public.rma_vi_landed_unit_costs(p_vi_id) c
     WHERE c.product_id = v_product_id
     LIMIT 1;
    v_unit_cost := COALESCE(v_unit_cost, 0);

    IF v_tracking_mode = 'bulk' THEN
      v_received_this_line := (v_receipt->>'qty')::integer;
      IF v_received_this_line IS NULL OR v_received_this_line <= 0 THEN
        RAISE EXCEPTION 'A positive qty is required for bulk product %', v_product_id USING ERRCODE = 'P0001';
      END IF;

      SELECT id INTO v_ws_id FROM public.warehouse_stock
      WHERE product_id = v_product_id AND warehouse_id = v_warehouse_id
      FOR UPDATE;

      IF NOT FOUND THEN
        INSERT INTO public.warehouse_stock
          (product_id, warehouse_id, quantity, reserved_quantity, total_cost_base)
        VALUES
          (v_product_id, v_warehouse_id, v_received_this_line, 0,
           round(v_unit_cost * v_received_this_line, 4))
        RETURNING id INTO v_ws_id;
      ELSE
        -- Both columns move together, so rma_hold_unit_cost() stands aside and
        -- the new goods blend into the average at the price actually paid.
        UPDATE public.warehouse_stock
        SET quantity        = quantity + v_received_this_line,
            total_cost_base = total_cost_base + round(v_unit_cost * v_received_this_line, 4),
            updated_at      = now()
        WHERE id = v_ws_id;
      END IF;

      INSERT INTO public.stock_moves
        (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
      VALUES
        ('warehouse_stock', v_ws_id, 'vendor_invoice', p_vi_id, 'receive', v_received_this_line, NULL, 'available', p_actor_email);
    ELSE
      v_received_this_line := 0;
      FOR v_serial IN SELECT jsonb_array_elements_text(COALESCE(v_receipt->'serials', '[]'::jsonb))
      LOOP
        BEGIN
          INSERT INTO public.inventory_units
            (product_id, product_name, serial_number, status, reservation_status, warehouse_id, vendor_invoice_id, unit_cost_base, created_date)
          SELECT v_product_id, p.product_name, v_serial, 'company_stock', 'available', v_warehouse_id, p_vi_id, v_unit_cost, now()
          FROM public.products p WHERE p.id = v_product_id
          RETURNING id INTO v_unit_id;
        EXCEPTION WHEN unique_violation THEN
          RAISE EXCEPTION 'Serial number % is already in use', v_serial USING ERRCODE = 'P0001';
        END;

        INSERT INTO public.stock_moves
          (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
        VALUES
          ('unit', v_unit_id, 'vendor_invoice', p_vi_id, 'receive', 1, NULL, 'available', p_actor_email);

        v_received_this_line := v_received_this_line + 1;
      END LOOP;
    END IF;

    v_receipt_totals := v_receipt_totals ||
      jsonb_build_object('product_id', v_product_id::text, 'received', v_received_this_line);
  END LOOP;

  -- Fold each receipt's received qty onto the matching line's qty_received.
  -- Lines with no matching receipt this call are left untouched.
  SELECT jsonb_agg(
    CASE
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_receipt_totals) r WHERE r->>'product_id' = line->>'product_id')
      THEN jsonb_set(
        line,
        '{qty_received}',
        to_jsonb(
          COALESCE((line->>'qty_received')::integer, 0) +
          (SELECT SUM((r->>'received')::integer) FROM jsonb_array_elements(v_receipt_totals) r
           WHERE r->>'product_id' = line->>'product_id')
        )
      )
      ELSE line
    END
  )
  INTO v_final_line_items
  FROM jsonb_array_elements(v_vi.line_items) line;

  SELECT bool_and(COALESCE((line->>'qty_received')::integer, 0) >= COALESCE((line->>'qty_ordered')::integer, 0))
  INTO v_all_complete
  FROM jsonb_array_elements(v_final_line_items) line;

  UPDATE public.vendor_invoices
  SET
    line_items = v_final_line_items,
    vi_code    = COALESCE(vi_code, public.nextval_for_type('vendor_invoice')),
    status     = CASE WHEN v_all_complete THEN 'received' ELSE 'partially_received' END,
    received_at = COALESCE(received_at, now())
  WHERE id = p_vi_id;

  -- Sync the linked Purchase Order's completion status, if any.
  IF v_vi.purchase_order_id IS NOT NULL THEN
    SELECT status INTO v_po_status FROM public.purchase_orders WHERE id = v_vi.purchase_order_id FOR UPDATE;
    IF v_po_status IS NOT NULL AND v_po_status NOT IN ('cancelled', 'expired') THEN
      UPDATE public.purchase_orders
      SET status = CASE WHEN v_all_complete THEN 'completed' ELSE 'partially_completed' END,
          updated_at = now()
      WHERE id = v_vi.purchase_order_id;
    END IF;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_payment(p_customer_id uuid, p_amount numeric, p_method text, p_reference_number text, p_payment_date date, p_notes text, p_actor_email text, p_allocations jsonb DEFAULT '[]'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_code   text;
  v_id     uuid;
  v_actor  text;
  v_alloc  record;
  v_sum    numeric(12,2) := 0;
  v_inv    record;
BEGIN
  -- CRIT-1: authorization
  IF NOT public.rma_can_handle_cash() THEN
    RAISE EXCEPTION 'Not authorized to record payments';
  END IF;

  -- CRIT-3: trust the JWT, not the parameter
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  v_code := public.nextval_for_type('payment');

  INSERT INTO public.payments (
    payment_code, customer_id, amount, unapplied_amount,
    method, reference_number, payment_date, notes, created_by
  )
  VALUES (
    v_code, p_customer_id, p_amount, p_amount,
    p_method, p_reference_number,
    COALESCE(p_payment_date, CURRENT_DATE),
    p_notes, v_actor
  )
  RETURNING id INTO v_id;

  -- Apply allocations atomically (Invariant A2)
  FOR v_alloc IN
    SELECT
      (x->>'invoice_id')::uuid AS invoice_id,
      (x->>'amount')::numeric  AS amount
    FROM jsonb_array_elements(p_allocations) AS x
    WHERE (x->>'amount')::numeric > 0
  LOOP
    -- CRIT-2: allocations may never exceed the payment amount
    v_sum := v_sum + v_alloc.amount;
    IF v_sum > p_amount THEN
      RAISE EXCEPTION
        'Allocations (%) exceed payment amount (%)', v_sum, p_amount;
    END IF;

    -- CRIT-2 + M1: lock the invoice, verify it exists, is posted, and belongs
    -- to the paying customer
    SELECT id, customer_id, total, amount_paid
      INTO v_inv
    FROM public.crm_invoices
    WHERE id = v_alloc.invoice_id
      AND doc_status = 'posted'
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % is not a posted invoice', v_alloc.invoice_id;
    END IF;

    IF v_inv.customer_id <> p_customer_id THEN
      RAISE EXCEPTION
        'Invoice % belongs to a different customer', v_alloc.invoice_id;
    END IF;

    -- Insert application row; sync_payment_balance trigger recomputes unapplied
    INSERT INTO public.payment_applications (
      payment_id, invoice_id, amount_applied, applied_by
    )
    VALUES (v_id, v_alloc.invoice_id, v_alloc.amount, v_actor);

    UPDATE public.crm_invoices
    SET
      amount_paid    = LEAST(amount_paid + v_alloc.amount, total),
      payment_status = CASE
        WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN 'paid'
        WHEN LEAST(amount_paid + v_alloc.amount, total) > 0     THEN 'partial'
        ELSE 'unpaid'
        END,
      paid_at = CASE
        WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN NOW()
        ELSE paid_at
        END,
      updated_at = NOW()
    WHERE id = v_alloc.invoice_id;
  END LOOP;

  RETURN v_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_vendor_payment(p_vendor_id uuid, p_amount numeric, p_method text, p_reference_number text, p_payment_date date, p_notes text, p_actor_email text, p_allocations jsonb DEFAULT '[]'::jsonb, p_currency character DEFAULT NULL::bpchar, p_exchange_rate numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_code  text;
  v_id    uuid;
  v_actor text;
  v_alloc record;
  v_sum   numeric(12,2) := 0;
  v_inv   record;
  v_base  text;
  v_cur   char(3);
  v_rate  numeric(18,8);
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to record vendor payments';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  SELECT config_value #>> '{}' INTO v_base
    FROM public.rma_config WHERE config_key = 'default_currency';

  -- Omitting the currency means a local payment. Callers written before this
  -- migration pass neither argument and keep working unchanged.
  v_cur  := COALESCE(p_currency, v_base);
  v_rate := COALESCE(p_exchange_rate, 1);

  v_code := public.nextval_for_type('vendor_payment');

  INSERT INTO public.vendor_payments (
    payment_code, vendor_id, amount, unapplied_amount,
    method, reference_number, payment_date, notes, created_by,
    currency, exchange_rate
  )
  VALUES (
    v_code, p_vendor_id, p_amount, p_amount,
    p_method, p_reference_number,
    COALESCE(p_payment_date, CURRENT_DATE),
    p_notes, v_actor,
    v_cur, v_rate
  )
  RETURNING id INTO v_id;

  FOR v_alloc IN
    SELECT
      (x->>'invoice_id')::uuid AS invoice_id,
      (x->>'amount')::numeric  AS amount
    FROM jsonb_array_elements(p_allocations) AS x
    WHERE (x->>'amount')::numeric > 0
  LOOP
    v_sum := v_sum + v_alloc.amount;
    IF v_sum > p_amount THEN
      RAISE EXCEPTION 'Allocations (%) exceed payment amount (%)', v_sum, p_amount;
    END IF;

    SELECT id, vendor_id, total, amount_paid, currency
      INTO v_inv
    FROM public.vendor_invoices
    WHERE id = v_alloc.invoice_id
      AND status IN ('approved', 'partially_received', 'received')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Vendor invoice % is not payable', v_alloc.invoice_id;
    END IF;
    IF v_inv.vendor_id <> p_vendor_id THEN
      RAISE EXCEPTION 'Vendor invoice % belongs to a different vendor', v_alloc.invoice_id;
    END IF;
    -- Without this, a payment of 1,000 in one currency marks an invoice of
    -- 1,000 in another paid in full.
    IF v_inv.currency IS DISTINCT FROM v_cur THEN
      RAISE EXCEPTION
        'Cannot settle a % invoice with a % payment. Record the payment in % instead.',
        v_inv.currency, v_cur, v_inv.currency
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.vendor_payment_applications (
      payment_id, invoice_id, amount_applied, applied_by
    )
    VALUES (v_id, v_alloc.invoice_id, v_alloc.amount, v_actor);

    UPDATE public.vendor_invoices
    SET
      amount_paid    = LEAST(amount_paid + v_alloc.amount, total),
      payment_status = CASE
        WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN 'paid'
        WHEN LEAST(amount_paid + v_alloc.amount, total) > 0     THEN 'partial'
        ELSE 'unpaid'
        END,
      paid_at = CASE
        WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN NOW()
        ELSE paid_at
        END,
      updated_at = NOW()
    WHERE id = v_alloc.invoice_id;
  END LOOP;

  RETURN v_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reject_sales_order(p_so_id uuid, p_actor_email text)
 RETURNS SETOF sales_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to reject sales orders';
  END IF;

  UPDATE public.sales_orders
  SET status = 'declined', updated_at = NOW()
  WHERE id = p_so_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found: %', p_so_id;
  END IF;

  RETURN QUERY SELECT * FROM public.sales_orders WHERE id = p_so_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.release_units(p_doc_type text, p_doc_id uuid, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unit record;
BEGIN
  FOR v_unit IN
    SELECT id FROM public.inventory_units
    WHERE reserved_by_doc_type = p_doc_type
      AND reserved_by_doc_id   = p_doc_id
      AND reservation_status   = 'reserved'
    FOR UPDATE
  LOOP
    UPDATE public.inventory_units
    SET
      reservation_status   = 'available',
      reserved_by_doc_type = NULL,
      reserved_by_doc_id   = NULL,
      reserved_at          = NULL,
      reserved_by_email    = NULL
    WHERE id = v_unit.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit.id, p_doc_type, p_doc_id, 'release', 1, 'reserved', 'available', p_actor_email);
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.release_warehouse_stock(p_doc_type text, p_doc_id uuid, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT
      sm.ref_id AS warehouse_stock_id,
      SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
        - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) AS net_qty
    FROM public.stock_moves sm
    WHERE sm.doc_type = p_doc_type
      AND sm.doc_id IS NOT DISTINCT FROM p_doc_id
      AND sm.ref_type = 'warehouse_stock'
    GROUP BY sm.ref_id
    HAVING SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
         - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) > 0
  LOOP
    UPDATE public.warehouse_stock
    SET reserved_quantity = GREATEST(reserved_quantity - v_row.net_qty, 0), updated_at = now()
    WHERE id = v_row.warehouse_stock_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_row.warehouse_stock_id, p_doc_type, p_doc_id, 'release', v_row.net_qty, 'reserved', 'available', p_actor_email);
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reserve_parts(p_doc_type text, p_doc_id uuid, p_part_id uuid, p_qty integer, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_qty      integer;
  v_reserved integer;
BEGIN
  SELECT quantity, reserved_quantity
  INTO v_qty, v_reserved
  FROM public.parts
  WHERE id = p_part_id
  FOR UPDATE;

  IF (v_qty - v_reserved) < p_qty THEN
    RAISE EXCEPTION 'Insufficient parts: need %, only % available for part %',
      p_qty, (v_qty - v_reserved), p_part_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.parts
  SET reserved_quantity = reserved_quantity + p_qty
  WHERE id = p_part_id;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, actor_email)
  VALUES
    ('part', p_part_id, p_doc_type, p_doc_id, 'reserve', p_qty, p_actor_email);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reserve_units(p_doc_type text, p_doc_id uuid, p_product_id uuid, p_qty integer, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unit       record;
  v_count      integer := 0;
  v_available  integer;
BEGIN
  -- Count available units first (fast check before locking)
  SELECT COUNT(*) INTO v_available
  FROM public.inventory_units
  WHERE product_id = p_product_id
    AND reservation_status = 'available'
    AND status = 'company_stock';

  IF v_available < p_qty THEN
    RAISE EXCEPTION 'Insufficient stock: need %, only % available for product %',
      p_qty, v_available, p_product_id
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_unit IN
    SELECT id FROM public.inventory_units
    WHERE product_id = p_product_id
      AND reservation_status = 'available'
      AND status = 'company_stock'
    ORDER BY created_date
    LIMIT p_qty
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.inventory_units
    SET
      reservation_status   = 'reserved',
      reserved_by_doc_type = p_doc_type,
      reserved_by_doc_id   = p_doc_id,
      reserved_at          = NOW(),
      reserved_by_email    = p_actor_email
    WHERE id = v_unit.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit.id, p_doc_type, p_doc_id, 'reserve', 1, 'available', 'reserved', p_actor_email);

    v_count := v_count + 1;
  END LOOP;

  IF v_count < p_qty THEN
    RAISE EXCEPTION 'Concurrent reservation conflict: secured only % of % units for product %',
      v_count, p_qty, p_product_id
      USING ERRCODE = 'P0001';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reserve_warehouse_stock(p_doc_type text, p_doc_id uuid, p_product_id uuid, p_qty integer, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row             record;
  v_remaining       integer := p_qty;
  v_take            integer;
  v_total_available integer;
BEGIN
  SELECT COALESCE(SUM(quantity - reserved_quantity), 0) INTO v_total_available
  FROM public.warehouse_stock
  WHERE product_id = p_product_id;

  IF v_total_available < p_qty THEN
    RAISE EXCEPTION 'Insufficient stock: need %, only % available for product %',
      p_qty, v_total_available, p_product_id
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_row IN
    SELECT id, quantity, reserved_quantity
    FROM public.warehouse_stock
    WHERE product_id = p_product_id
      AND (quantity - reserved_quantity) > 0
    ORDER BY (quantity - reserved_quantity) DESC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_remaining, v_row.quantity - v_row.reserved_quantity);

    UPDATE public.warehouse_stock
    SET reserved_quantity = reserved_quantity + v_take, updated_at = now()
    WHERE id = v_row.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_row.id, p_doc_type, p_doc_id, 'reserve', v_take, 'available', 'reserved', p_actor_email);

    v_remaining := v_remaining - v_take;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'Concurrent reservation conflict: could not secure % of % units for product %',
      v_remaining, p_qty, p_product_id
      USING ERRCODE = 'P0001';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.restore_parts(p_doc_type text, p_doc_id uuid, p_part_id uuid, p_qty integer, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.parts
  SET quantity = quantity + p_qty
  WHERE id = p_part_id;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, actor_email)
  VALUES
    ('part', p_part_id, p_doc_type, p_doc_id, 'restore', p_qty, p_actor_email);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.restore_units(p_unit_ids uuid[], p_doc_type text, p_doc_id uuid, p_actor_email text, p_to_status text DEFAULT 'available'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unit_id uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to restore units' USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_unit_id IN ARRAY p_unit_ids
  LOOP
    UPDATE public.inventory_units
    SET
      reservation_status = 'available',
      status             = CASE
                             WHEN p_to_status = 'active_rma' THEN 'active_rma'
                             ELSE status
                           END
    WHERE id = v_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit_id, p_doc_type, p_doc_id, 'restore', 1, 'delivered', p_to_status, p_actor_email);
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.restore_warehouse_stock(p_product_id uuid, p_warehouse_id uuid, p_qty integer, p_doc_type text, p_doc_id uuid, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.warehouse_stock
  WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity)
    VALUES (p_product_id, p_warehouse_id, p_qty, 0)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.warehouse_stock SET quantity = quantity + p_qty, updated_at = now() WHERE id = v_id;
  END IF;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
  VALUES
    ('warehouse_stock', v_id, p_doc_type, p_doc_id, 'restore', p_qty, 'delivered', 'available', p_actor_email);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reverse_credit_note_application(p_application_id uuid, p_reason text, p_actor_email text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor text;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to reverse a credit note application';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reversal reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);
  RETURN public._reverse_credit_note_application(p_application_id, p_reason, v_actor);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reverse_payment_application(p_application_id uuid, p_reason text, p_actor_email text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor text;
BEGIN
  IF NOT public.rma_can_handle_cash() THEN
    RAISE EXCEPTION 'Not authorized to reverse a payment application';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reversal reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);
  RETURN public._reverse_payment_application(p_application_id, p_reason, v_actor);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reverse_vendor_payment_application(p_application_id uuid, p_reason text, p_actor_email text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor text;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to reverse a vendor payment application';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reversal reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);
  RETURN public._reverse_vendor_payment_application(p_application_id, p_reason, v_actor);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.rma_access_is_current(p_status text, p_expires timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$ SELECT COALESCE(p_status, 'active') = 'active'
        AND (p_expires IS NULL OR p_expires > now()) $function$
;

CREATE OR REPLACE FUNCTION public.rma_can_handle_cash()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT public.rma_is_manager_or_above()
        OR public.rma_user_role() = 'accountant' $function$
;

CREATE OR REPLACE FUNCTION public.rma_current_user_email()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT auth.jwt() ->> 'email' $function$
;

CREATE OR REPLACE FUNCTION public.rma_document_counters()
 RETURNS TABLE(seq_type text, last_value integer, seq_year integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- SECURITY DEFINER, so it reads past the table's own refusal. Restricted to
  -- staff: the counters reveal how many documents of each kind exist, which is
  -- commercial information.
  IF NOT public.rma_is_staff() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT d.seq_type, d.last_value, d.seq_year
    FROM public.document_sequences d
   ORDER BY d.seq_type;
END
$function$
;

CREATE OR REPLACE FUNCTION public.rma_guard_base_currency()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_docs integer;
BEGIN
  IF NEW.config_key <> 'default_currency' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.config_value IS NOT DISTINCT FROM OLD.config_value THEN
    RETURN NEW;   -- a no-op save from the settings form
  END IF;

  SELECT
      (SELECT count(*) FROM public.crm_invoices)
    + (SELECT count(*) FROM public.quotations)
    + (SELECT count(*) FROM public.sales_orders)
    + (SELECT count(*) FROM public.purchase_orders)
    + (SELECT count(*) FROM public.vendor_invoices)
    + (SELECT count(*) FROM public.payments)
    + (SELECT count(*) FROM public.vendor_payments)
    INTO v_docs;

  IF v_docs > 0 THEN
    RAISE EXCEPTION
      'The base currency cannot be changed: % transaction document(s) already exist and their stored amounts were recorded against the current base. Changing it would silently reinterpret every one of them.',
      v_docs
      USING ERRCODE = 'P0001';
  END IF;

  -- Must be a currency this installation actually knows about.
  IF NOT EXISTS (
    SELECT 1 FROM public.currencies
     WHERE code = btrim(NEW.config_value #>> '{}') AND is_active
  ) THEN
    RAISE EXCEPTION 'Unknown or inactive currency: %', NEW.config_value #>> '{}'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.rma_guard_charges_before_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_vi     uuid := COALESCE(NEW.vendor_invoice_id, OLD.vendor_invoice_id);
BEGIN
  SELECT status INTO v_status FROM public.vendor_invoices WHERE id = v_vi;

  IF v_status IN ('partially_received', 'received') THEN
    RAISE EXCEPTION
      'This invoice has already been received, so its landed cost is fixed. Changing charges now would not update the cost of the goods already in stock.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$function$
;

CREATE OR REPLACE FUNCTION public.rma_guard_custom_role_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.user_roles WHERE role = OLD.role_name;
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'Cannot delete role "%": % user(s) still hold it. Reassign them first.',
      OLD.role_name, v_n
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN OLD;
END
$function$
;

CREATE OR REPLACE FUNCTION public.rma_guard_document_rate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_base text;
BEGIN
  SELECT config_value #>> '{}' INTO v_base
    FROM public.rma_config WHERE config_key = 'default_currency';

  IF NEW.currency = v_base AND NEW.exchange_rate <> 1 THEN
    RAISE EXCEPTION
      'A document in the base currency (%) must have an exchange rate of 1, not %.',
      v_base, NEW.exchange_rate
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.currency <> v_base AND NEW.exchange_rate = 1 THEN
    RAISE EXCEPTION
      'A document in % needs the exchange rate that was actually paid. A rate of 1 would record % as though it were %.',
      NEW.currency, NEW.currency, v_base
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.rma_hold_unit_cost()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_costed_old integer;
  v_avg        numeric;
BEGIN
  -- Only when quantity moved and the caller stated neither a value nor a
  -- count. A caller that sets either knows something this function does not.
  IF NEW.quantity IS DISTINCT FROM OLD.quantity
     AND NEW.total_cost_base   IS NOT DISTINCT FROM OLD.total_cost_base
     AND NEW.uncosted_quantity IS NOT DISTINCT FROM OLD.uncosted_quantity
  THEN
    IF OLD.quantity > 0 THEN
      -- Preserve the unknown share. There is no way to tell which physical
      -- units left a bin held at weighted average, so depleting the known or
      -- the unknown side first would assert something the data cannot support.
      NEW.uncosted_quantity := LEAST(
        NEW.quantity,
        GREATEST(0, round(OLD.uncosted_quantity::numeric * NEW.quantity / OLD.quantity)::integer));

      v_costed_old := OLD.quantity - OLD.uncosted_quantity;
      v_avg := CASE WHEN v_costed_old > 0
                    THEN OLD.total_cost_base / v_costed_old
                    ELSE 0 END;
      NEW.total_cost_base := round(v_avg * (NEW.quantity - NEW.uncosted_quantity), 4);
    ELSE
      -- Growing from empty with no cost stated: the goods arrived through a
      -- path that never knew what they cost, so say so rather than record 0.
      NEW.uncosted_quantity := NEW.quantity;
      NEW.total_cost_base   := 0;
    END IF;
  END IF;

  RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.rma_invoice_cogs(p_invoice_id uuid)
 RETURNS TABLE(cogs_base numeric, unknown_qty integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv         record;
  v_ser_cost    numeric := 0;
  v_ser_unknown integer := 0;
  v_bulk_cost   numeric := 0;
  v_bulk_unknown integer := 0;
BEGIN
  -- SECURITY DEFINER, so it reads past RLS. Cost is commercially sensitive.
  IF NOT public.rma_is_staff() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_inv FROM public.crm_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id USING ERRCODE = 'P0001';
  END IF;

  IF v_inv.so_id IS NULL THEN
    RETURN QUERY SELECT 0::numeric, 0;
    RETURN;
  END IF;

  -- ── Serialised: each unit carries its own actual cost ───────────────────
  SELECT COALESCE(SUM(u.unit_cost_base), 0),
         COUNT(*) FILTER (WHERE u.unit_cost_base IS NULL)
    INTO v_ser_cost, v_ser_unknown
    FROM public.inventory_units u
   WHERE u.reserved_by_doc_type = 'sales_order'
     AND u.reserved_by_doc_id   = v_inv.so_id
     AND u.reservation_status   = 'reserved';

  -- ── Bulk: the reserved quantity per bin, at that bin's average ──────────
  -- Net reserved is computed the same way deliver_warehouse_stock computes it,
  -- so the quantity costed here is exactly the quantity about to ship.
  -- A bin whose average is NULL has no known cost, and those units are counted
  -- as unknown rather than multiplied by nothing.
  WITH reserved AS (
    SELECT sm.ref_id AS ws_id,
           SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
         - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) AS qty
      FROM public.stock_moves sm
     WHERE sm.doc_type = 'sales_order'
       AND sm.doc_id   IS NOT DISTINCT FROM v_inv.so_id
       AND sm.ref_type = 'warehouse_stock'
     GROUP BY sm.ref_id
    HAVING SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
         - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) > 0
  )
  SELECT COALESCE(SUM(r.qty * ws.avg_cost_base) FILTER (WHERE ws.avg_cost_base IS NOT NULL), 0),
         COALESCE(SUM(r.qty) FILTER (WHERE ws.avg_cost_base IS NULL), 0)::integer
    INTO v_bulk_cost, v_bulk_unknown
    FROM reserved r
    JOIN public.warehouse_stock ws ON ws.id = r.ws_id;

  RETURN QUERY SELECT
    round(COALESCE(v_ser_cost, 0) + COALESCE(v_bulk_cost, 0), 2),
    COALESCE(v_ser_unknown, 0) + COALESCE(v_bulk_unknown, 0);
END
$function$
;

CREATE OR REPLACE FUNCTION public.rma_is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT public.rma_user_role() IN ('super_admin', 'admin') $function$
;

CREATE OR REPLACE FUNCTION public.rma_is_authenticated()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT auth.jwt() ->> 'email' IS NOT NULL $function$
;

CREATE OR REPLACE FUNCTION public.rma_is_manager_or_above()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT public.rma_user_role() IN ('super_admin', 'admin', 'manager') $function$
;

CREATE OR REPLACE FUNCTION public.rma_is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT public.rma_user_role() IN (
  'super_admin', 'admin', 'manager', 'technician', 'viewer',
  'sales_rep', 'accountant'
) $function$
;

CREATE OR REPLACE FUNCTION public.rma_protect_last_super_admin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_remaining integer;
  v_was_admin boolean;
  v_is_admin  boolean;
BEGIN
  v_was_admin := OLD.role = 'super_admin'
                 AND rma_access_is_current(OLD.status, OLD.access_expires_at);

  -- Not an effective super admin before the change: nothing can be lost.
  IF NOT v_was_admin THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_is_admin := NEW.role = 'super_admin'
                  AND rma_access_is_current(NEW.status, NEW.access_expires_at);
    IF v_is_admin THEN
      RETURN NEW;   -- still an effective super admin
    END IF;
  END IF;

  SELECT count(*) INTO v_remaining
    FROM public.user_roles
   WHERE role = 'super_admin'
     AND rma_access_is_current(status, access_expires_at)
     AND user_email <> OLD.user_email;

  IF v_remaining = 0 THEN
    RAISE EXCEPTION
      'Refusing to remove the last active Super Admin (%). Promote another one first — with none left, nobody can administer the system and recovery needs direct database access.',
      OLD.user_email
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$function$
;

CREATE OR REPLACE FUNCTION public.rma_search_by_serial(serial text)
 RETURNS TABLE(id uuid, rma_number text, customer_name text, ticket_status text, priority text, assigned_technician text, created_date timestamp with time zone, due_date date, products jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    id, rma_number, customer_name, ticket_status, priority,
    assigned_technician, created_date, due_date, products
  FROM rma_tickets
  WHERE EXISTS (
    SELECT 1
    FROM jsonb_array_elements(products) AS p
    WHERE p->>'serial_number' ILIKE serial
  )
  ORDER BY created_date DESC;
$function$
;

CREATE OR REPLACE FUNCTION public.rma_set_opening_cost(p_product_id uuid, p_warehouse_id uuid, p_unit_cost numeric)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row    record;
  v_units  integer := 0;
  v_bulk   integer := 0;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to set stock costs' USING ERRCODE = 'P0001';
  END IF;

  IF p_unit_cost IS NULL OR p_unit_cost <= 0 THEN
    RAISE EXCEPTION
      'An opening cost must be a positive amount in base currency. Leave the stock uncosted rather than valuing it at zero — zero is a claim, and an unknown is not.'
      USING ERRCODE = 'P0001';
  END IF;

  -- ── Serialised units ────────────────────────────────────────────────────
  -- Only the ones with no cost. A unit that arrived on a vendor invoice
  -- already carries what was actually paid for it, and an estimate must not
  -- overwrite a fact.
  UPDATE public.inventory_units
     SET unit_cost_base = p_unit_cost
   WHERE product_id     = p_product_id
     AND warehouse_id   = p_warehouse_id
     AND status         = 'company_stock'
     AND unit_cost_base IS NULL;
  GET DIAGNOSTICS v_units = ROW_COUNT;

  -- ── Bulk stock ──────────────────────────────────────────────────────────
  SELECT * INTO v_row FROM public.warehouse_stock
   WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
   FOR UPDATE;

  IF FOUND AND v_row.uncosted_quantity > 0 THEN
    UPDATE public.warehouse_stock
       SET total_cost_base   = total_cost_base + round(p_unit_cost * v_row.uncosted_quantity, 4),
           uncosted_quantity = 0,
           updated_at        = now()
     WHERE id = v_row.id;
    v_bulk := v_row.uncosted_quantity;
  END IF;

  IF v_units = 0 AND v_bulk = 0 THEN
    RAISE EXCEPTION
      'Nothing here needs a cost: there is no uncosted stock of that product in that warehouse. Setting one would overwrite what was actually paid.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN format('valued %s serialised unit(s) and %s bulk unit(s) at %s each',
                v_units, v_bulk, p_unit_cost);
END
$function$
;

CREATE OR REPLACE FUNCTION public.rma_staff_directory()
 RETURNS TABLE(user_email text, role text, status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.rma_is_staff() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT ur.user_email, ur.role, ur.status
    FROM public.user_roles ur
   ORDER BY ur.user_email;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.rma_user_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(cr.base_role, ur.role)
    FROM public.user_roles ur
    LEFT JOIN public.custom_roles cr ON cr.role_name = ur.role
   WHERE ur.user_email = (auth.jwt() ->> 'email')
     AND public.rma_access_is_current(ur.status, ur.access_expires_at)
   LIMIT 1
$function$
;

CREATE OR REPLACE FUNCTION public.rma_validate_user_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.role IN ('super_admin','admin','manager','technician',
                  'viewer','sales_rep','accountant') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.custom_roles WHERE role_name = NEW.role) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'Unknown role "%": not a built-in and not defined in custom_roles', NEW.role
    USING ERRCODE = 'check_violation';
END
$function$
;

CREATE OR REPLACE FUNCTION public.rma_vi_landed_unit_costs(p_vi_id uuid)
 RETURNS TABLE(product_id uuid, unit_cost_base numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_vi          record;
  v_tax_in_cost boolean;
  v_charges     numeric := 0;
  v_line_value  numeric := 0;
BEGIN
  -- SECURITY DEFINER, so it reads past RLS. Without this guard any signed-in
  -- account could ask what any shipment cost, which is exactly the class of
  -- unguarded definer function 20260788 went through and closed.
  IF NOT public.rma_is_staff() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_vi FROM public.vendor_invoices WHERE id = p_vi_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice % not found', p_vi_id USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE((config_value #>> '{}')::boolean, false) INTO v_tax_in_cost
    FROM public.rma_config WHERE config_key = 'purchase_tax_in_cost';
  v_tax_in_cost := COALESCE(v_tax_in_cost, false);

  SELECT COALESCE(SUM(amount), 0) INTO v_charges
    FROM public.vendor_invoice_charges WHERE vendor_invoice_id = p_vi_id;

  -- The apportionment base: every line's pre-tax value, whether or not it is
  -- being received yet. Freight is earned by the whole shipment.
  SELECT COALESCE(SUM(
           COALESCE((l->>'qty_ordered')::numeric, 0)
         * COALESCE((l->>'unit_cost')::numeric, 0)
         * (1 - COALESCE((l->>'discount_pct')::numeric, 0) / 100)
         ), 0)
    INTO v_line_value
    FROM jsonb_array_elements(COALESCE(v_vi.line_items, '[]'::jsonb)) l;

  RETURN QUERY
  SELECT
    (l->>'product_id')::uuid,
    round(
      (
        -- the line's own price per unit, after discount and optionally tax
        COALESCE((l->>'unit_cost')::numeric, 0)
      * (1 - COALESCE((l->>'discount_pct')::numeric, 0) / 100)
      * CASE WHEN v_tax_in_cost
             THEN 1 + COALESCE((l->>'tax_pct')::numeric, 0) / 100
             ELSE 1 END
        -- plus this line's share of the charges, per unit
      + CASE
          WHEN v_line_value > 0 AND COALESCE((l->>'qty_ordered')::numeric, 0) > 0
          THEN v_charges
             * (
                 COALESCE((l->>'qty_ordered')::numeric, 0)
               * COALESCE((l->>'unit_cost')::numeric, 0)
               * (1 - COALESCE((l->>'discount_pct')::numeric, 0) / 100)
               / v_line_value
               )
             / COALESCE((l->>'qty_ordered')::numeric, 1)
          ELSE 0
        END
      )
      -- into base currency
      * COALESCE(v_vi.exchange_rate, 1),
      4
    )
  FROM jsonb_array_elements(COALESCE(v_vi.line_items, '[]'::jsonb)) l
  WHERE (l->>'product_id') IS NOT NULL;
END
$function$
;

CREATE OR REPLACE FUNCTION public.set_credit_notes_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_crm_invoices_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_payments_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_quotations_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_sales_orders_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_updated_at_col()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_updated_date()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_date = now(); RETURN NEW; END; $function$
;

CREATE OR REPLACE FUNCTION public.set_vendor_payments_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.stock_moves_stamp_actor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_email text;
BEGIN
  v_jwt_email := public.rma_current_user_email();
  IF v_jwt_email IS NOT NULL AND v_jwt_email <> '' THEN
    NEW.actor_email := v_jwt_email;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_credit_note_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cn_id   uuid;
  v_total   numeric(12,2);
  v_applied numeric(12,2);
BEGIN
  v_cn_id := COALESCE(NEW.credit_note_id, OLD.credit_note_id);

  SELECT total INTO v_total
  FROM public.credit_notes WHERE id = v_cn_id;

  SELECT COALESCE(SUM(amount_applied), 0) INTO v_applied
  FROM public.credit_note_applications WHERE credit_note_id = v_cn_id;

  UPDATE public.credit_notes
  SET
    applied_amount    = v_applied,
    remaining_balance = GREATEST(v_total - v_applied, 0),
    status = CASE
      WHEN v_applied >= v_total AND status = 'issued' THEN 'applied'
      WHEN v_applied <  v_total AND status = 'applied' THEN 'issued'
      ELSE status
    END,
    updated_at = NOW()
  WHERE id = v_cn_id;

  RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_payment_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id uuid;
  v_amount     numeric(12,2);
  v_applied    numeric(12,2);
BEGIN
  v_payment_id := COALESCE(NEW.payment_id, OLD.payment_id);

  SELECT amount INTO v_amount
  FROM public.payments WHERE id = v_payment_id;

  SELECT COALESCE(SUM(amount_applied), 0) INTO v_applied
  FROM public.payment_applications WHERE payment_id = v_payment_id;

  UPDATE public.payments
  SET unapplied_amount = v_amount - v_applied,
      updated_at = NOW()
  WHERE id = v_payment_id;

  RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_vendor_payment_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id uuid;
  v_amount     numeric(12,2);
  v_applied    numeric(12,2);
BEGIN
  v_payment_id := COALESCE(NEW.payment_id, OLD.payment_id);

  SELECT amount INTO v_amount
  FROM public.vendor_payments WHERE id = v_payment_id;

  SELECT COALESCE(SUM(amount_applied), 0) INTO v_applied
  FROM public.vendor_payment_applications WHERE payment_id = v_payment_id;

  UPDATE public.vendor_payments
  SET unapplied_amount = v_amount - v_applied,
      updated_at = NOW()
  WHERE id = v_payment_id;

  RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.transfer_stock(p_product_id uuid, p_from_warehouse_id uuid, p_to_warehouse_id uuid, p_actor_email text, p_unit_id uuid DEFAULT NULL::uuid, p_qty integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tracking_mode text;
  v_unit          record;
  v_src           record;
  v_dst_id        uuid;
  v_moved         numeric;   -- 20260794: value leaving the source, at its average
  v_unk_moved     integer;   -- 20260795: how many of those units have no known cost
  v_costed_src    integer;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to transfer stock' USING ERRCODE = 'P0001';
  END IF;

  -- ── NEW in 20260770 ──────────────────────────────────────────────────────
  PERFORM public.assert_not_system_warehouse(p_to_warehouse_id, 'destination');
  PERFORM public.assert_not_system_warehouse(p_from_warehouse_id, 'source');
  -- ─────────────────────────────────────────────────────────────────────────

  IF p_from_warehouse_id = p_to_warehouse_id THEN
    RAISE EXCEPTION 'Source and destination warehouse must differ' USING ERRCODE = 'P0001';
  END IF;

  SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = 'P0001';
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    IF p_qty IS NULL OR p_qty <= 0 THEN
      RAISE EXCEPTION 'A positive quantity is required to transfer bulk stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_src FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_from_warehouse_id
    FOR UPDATE;

    IF NOT FOUND OR (v_src.quantity - v_src.reserved_quantity) < p_qty THEN
      RAISE EXCEPTION 'Insufficient available stock at source warehouse: need %, only % available',
        p_qty, COALESCE(v_src.quantity - v_src.reserved_quantity, 0)
        USING ERRCODE = 'P0001';
    END IF;

    -- Read before the update: avg_cost_base is derived from the very columns
    -- about to change. Goods worth 500 each must arrive at the destination
    -- worth 500 each, not be silently revalued to whatever it already averages.
    --
    -- The unknown units travel too, in proportion. Moving value while leaving
    -- every uncosted unit behind would quietly convert the source into a bin of
    -- pure unknowns and hand the destination a certainty it has not got.
    v_unk_moved := LEAST(
      p_qty,
      GREATEST(0, round(COALESCE(v_src.uncosted_quantity, 0)::numeric * p_qty / v_src.quantity)::integer));
    v_costed_src := v_src.quantity - COALESCE(v_src.uncosted_quantity, 0);
    v_moved := round(
      CASE WHEN v_costed_src > 0 THEN v_src.total_cost_base / v_costed_src ELSE 0 END
      * (p_qty - v_unk_moved), 4);

    UPDATE public.warehouse_stock
    SET quantity = quantity - p_qty,
        uncosted_quantity = GREATEST(uncosted_quantity - v_unk_moved, 0),
        total_cost_base = GREATEST(total_cost_base - v_moved, 0),
        updated_at = now()
    WHERE id = v_src.id;

    SELECT id INTO v_dst_id FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_to_warehouse_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.warehouse_stock
        (product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
      VALUES (p_product_id, p_to_warehouse_id, p_qty, 0, v_moved, v_unk_moved)
      RETURNING id INTO v_dst_id;
    ELSE
      -- Setting these columns keeps rma_hold_unit_cost() out of the way, so the
      -- arriving goods blend in at their own cost rather than the destination's,
      -- and carry their own uncertainty with them.
      UPDATE public.warehouse_stock
      SET quantity = quantity + p_qty,
          total_cost_base = total_cost_base + v_moved,
          uncosted_quantity = uncosted_quantity + v_unk_moved,
          updated_at = now()
      WHERE id = v_dst_id;
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_src.id, 'manual', NULL, 'transfer', p_qty, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email),
      ('warehouse_stock', v_dst_id, 'manual', NULL, 'transfer', p_qty, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email);
  ELSE
    IF p_unit_id IS NULL THEN
      RAISE EXCEPTION 'A unit id is required to transfer serialized stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_unit FROM public.inventory_units WHERE id = p_unit_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit % not found', p_unit_id USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.reservation_status != 'available' THEN
      RAISE EXCEPTION 'Cannot transfer unit % — it is currently %, not available',
        p_unit_id, v_unit.reservation_status
        USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.warehouse_id IS DISTINCT FROM p_from_warehouse_id THEN
      RAISE EXCEPTION 'Unit % is not currently in the specified source warehouse', p_unit_id
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.inventory_units SET warehouse_id = p_to_warehouse_id WHERE id = p_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', p_unit_id, 'manual', NULL, 'transfer', 1, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email);
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.void_credit_note(p_cn_id uuid, p_reason text, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor  text;
  v_cn     record;
  v_app_id uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to void a credit note';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A void reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_cn_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id;
  END IF;
  IF v_cn.status = 'voided' THEN
    RAISE EXCEPTION 'Credit note is already voided';
  END IF;

  FOR v_app_id IN
    SELECT ca.id
    FROM public.credit_note_applications ca
    WHERE ca.credit_note_id = p_cn_id
      AND ca.is_reversal = false
      AND NOT EXISTS (
        SELECT 1 FROM public.credit_note_applications r
        WHERE r.reverses_application_id = ca.id
      )
  LOOP
    PERFORM public._reverse_credit_note_application(v_app_id, p_reason, v_actor);
  END LOOP;

  UPDATE public.credit_notes
  SET status = 'voided', voided_at = NOW(), voided_by = v_actor, void_reason = p_reason
  WHERE id = p_cn_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.void_invoice(p_invoice_id uuid, p_reason text, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv      record;
  v_unit_ids uuid[];
  v_bulk     record;   -- 20260797
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to void invoices';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A void reason is required';
  END IF;

  SELECT * INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.doc_status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted invoices can be voided (current: %)', v_inv.doc_status;
  END IF;

  IF (
    SELECT COALESCE(SUM(amount_applied), 0)
    FROM public.payment_applications WHERE invoice_id = p_invoice_id
  ) > 0 THEN
    RAISE EXCEPTION 'Reverse payments before voiding';
  END IF;

  IF (
    SELECT COALESCE(SUM(amount_applied), 0)
    FROM public.credit_note_applications WHERE invoice_id = p_invoice_id
  ) > 0 THEN
    RAISE EXCEPTION 'Reverse credit notes before voiding';
  END IF;

  IF v_inv.so_id IS NOT NULL THEN
    SELECT array_agg(DISTINCT ref_id) INTO v_unit_ids
    FROM public.stock_moves
    WHERE doc_type  = 'sales_order'
      AND doc_id    = v_inv.so_id
      AND move_type = 'deliver'
      AND ref_type  = 'unit';

    IF v_unit_ids IS NOT NULL AND array_length(v_unit_ids, 1) > 0 THEN
      PERFORM public.restore_units(
        v_unit_ids, 'invoice', p_invoice_id, p_actor_email, 'available'
      );
    END IF;
  END IF;

  -- 20260797: the mirror of the delivery gap. Serialised units were restored
  -- above and bulk stock was not, so voiding an invoice for bulk goods left the
  -- quantity permanently gone from the warehouse.
  --
  -- The goods come back at the bin's CURRENT average, not at what they cost
  -- when they shipped. That is inherent to a weighted average — nothing records
  -- which physical units these were — and if the bin is now empty they return
  -- as uncosted, which is the honest answer rather than a guess.
  IF v_inv.so_id IS NOT NULL THEN
    FOR v_bulk IN
      SELECT ws.product_id, ws.warehouse_id, SUM(sm.qty)::integer AS qty
        FROM public.stock_moves sm
        JOIN public.warehouse_stock ws ON ws.id = sm.ref_id
       WHERE sm.doc_type  = 'sales_order'
         AND sm.doc_id    = v_inv.so_id
         AND sm.ref_type  = 'warehouse_stock'
         AND sm.move_type = 'deliver'
       GROUP BY ws.product_id, ws.warehouse_id
      HAVING SUM(sm.qty) > 0
    LOOP
      PERFORM public.restore_warehouse_stock(
        v_bulk.product_id, v_bulk.warehouse_id, v_bulk.qty,
        'invoice', p_invoice_id, p_actor_email);
    END LOOP;
  END IF;

  UPDATE public.crm_invoices
  SET
    doc_status     = 'cancelled',
    payment_status = 'reversed',
    void_reason    = p_reason,
    -- The sale did not happen, so there is no cost of goods sold. Leaving the
    -- figure behind would keep the voided invoice in every margin total.
    cogs_base        = NULL,
    cogs_unknown_qty = 0,
    updated_at     = NOW()
  WHERE id = p_invoice_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.void_payment(p_payment_id uuid, p_reason text, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor  text;
  v_pay    record;
  v_app_id uuid;
BEGIN
  IF NOT public.rma_can_handle_cash() THEN
    RAISE EXCEPTION 'Not authorized to void a payment';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A void reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  SELECT * INTO v_pay FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found: %', p_payment_id;
  END IF;
  IF v_pay.status = 'voided' THEN
    RAISE EXCEPTION 'Payment is already voided';
  END IF;

  -- Reverse every application that hasn't already been reversed
  FOR v_app_id IN
    SELECT pa.id
    FROM public.payment_applications pa
    WHERE pa.payment_id = p_payment_id
      AND pa.is_reversal = false
      AND NOT EXISTS (
        SELECT 1 FROM public.payment_applications r
        WHERE r.reverses_application_id = pa.id
      )
  LOOP
    PERFORM public._reverse_payment_application(v_app_id, p_reason, v_actor);
  END LOOP;

  UPDATE public.payments
  SET status = 'voided', voided_at = NOW(), voided_by = v_actor, void_reason = p_reason
  WHERE id = p_payment_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.void_vendor_payment(p_payment_id uuid, p_reason text, p_actor_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor  text;
  v_pay    record;
  v_app_id uuid;
BEGIN
  IF NOT public.rma_can_handle_cash() THEN
    RAISE EXCEPTION 'Not authorized to void a vendor payment';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A void reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  SELECT * INTO v_pay FROM public.vendor_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor payment not found: %', p_payment_id;
  END IF;
  IF v_pay.status = 'voided' THEN
    RAISE EXCEPTION 'Vendor payment is already voided';
  END IF;

  FOR v_app_id IN
    SELECT pa.id
    FROM public.vendor_payment_applications pa
    WHERE pa.payment_id = p_payment_id
      AND pa.is_reversal = false
      AND NOT EXISTS (
        SELECT 1 FROM public.vendor_payment_applications r
        WHERE r.reverses_application_id = pa.id
      )
  LOOP
    PERFORM public._reverse_vendor_payment_application(v_app_id, p_reason, v_actor);
  END LOOP;

  UPDATE public.vendor_payments
  SET status = 'voided', voided_at = NOW(), voided_by = v_actor, void_reason = p_reason
  WHERE id = p_payment_id;
END;
$function$
;

-- Views
CREATE OR REPLACE VIEW public.v_customer_ledger WITH (security_invoker = true) AS
 SELECT crm_invoices.id,
    'invoice'::text AS entry_type,
    crm_invoices.inv_code AS entry_code,
    crm_invoices.customer_id,
    crm_invoices.total AS amount,
    crm_invoices.doc_status AS status,
    crm_invoices.due_date,
    COALESCE(crm_invoices.posted_at, crm_invoices.created_at) AS entry_date,
    crm_invoices.created_at
   FROM crm_invoices
  WHERE crm_invoices.doc_status = 'posted'::text
UNION ALL
 SELECT credit_notes.id,
    'credit_note'::text AS entry_type,
    credit_notes.cn_code AS entry_code,
    credit_notes.customer_id,
    - credit_notes.total AS amount,
    credit_notes.status,
    NULL::date AS due_date,
    COALESCE(credit_notes.issued_at, credit_notes.created_at) AS entry_date,
    credit_notes.created_at
   FROM credit_notes
  WHERE credit_notes.status = ANY (ARRAY['issued'::text, 'applied'::text])
UNION ALL
 SELECT payments.id,
    'payment'::text AS entry_type,
    payments.payment_code AS entry_code,
    payments.customer_id,
    - payments.amount AS amount,
    payments.status,
    NULL::date AS due_date,
    COALESCE(payments.payment_date::timestamp with time zone, payments.created_at) AS entry_date,
    payments.created_at
   FROM payments
  WHERE payments.status = 'active'::text;

CREATE OR REPLACE VIEW public.v_invoice_margin WITH (security_invoker = true) AS
 SELECT i.id,
    i.inv_code,
    i.customer_id,
    COALESCE(NULLIF(btrim(c.company_name), ''::text), c.contact_person) AS customer_name,
    i.assigned_rep,
    i.posted_at,
    i.doc_status,
    i.payment_status,
    i.total AS revenue_base,
    i.cogs_base,
    i.cogs_unknown_qty,
    i.cogs_complete,
        CASE
            WHEN i.cogs_complete THEN round(i.total - i.cogs_base, 2)
            ELSE NULL::numeric
        END AS margin_base,
        CASE
            WHEN i.cogs_complete AND i.total > 0::numeric THEN round(100.0 * (i.total - i.cogs_base) / i.total, 2)
            ELSE NULL::numeric
        END AS margin_pct
   FROM crm_invoices i
     LEFT JOIN customers c ON c.id = i.customer_id
  WHERE i.doc_status = 'posted'::text;

CREATE OR REPLACE VIEW public.v_purchase_documents WITH (security_invoker = true) AS
 SELECT purchase_orders.id,
    'purchase_order'::text AS doc_type,
    purchase_orders.po_code AS doc_code,
    purchase_orders.vendor_id,
    purchase_orders.created_by,
    purchase_orders.status AS doc_status,
    NULL::text AS payment_status,
    purchase_orders.total,
    purchase_orders.currency,
    purchase_orders.exchange_rate,
    purchase_orders.total_base,
    purchase_orders.created_at,
    purchase_orders.updated_at,
    purchase_orders.expected_delivery_date AS type_specific_date,
    'expected_delivery_date'::text AS type_specific_date_label,
    purchase_orders.archived,
    purchase_orders.archived_at
   FROM purchase_orders
UNION ALL
 SELECT vendor_invoices.id,
    'vendor_invoice'::text AS doc_type,
    vendor_invoices.vi_code AS doc_code,
    vendor_invoices.vendor_id,
    vendor_invoices.created_by,
    vendor_invoices.status AS doc_status,
    vendor_invoices.payment_status,
    vendor_invoices.total,
    vendor_invoices.currency,
    vendor_invoices.exchange_rate,
    vendor_invoices.total_base,
    vendor_invoices.created_at,
    NULL::timestamp with time zone AS updated_at,
    vendor_invoices.due_date AS type_specific_date,
    'due_date'::text AS type_specific_date_label,
    vendor_invoices.archived,
    vendor_invoices.archived_at
   FROM vendor_invoices;

CREATE OR REPLACE VIEW public.v_sales_documents WITH (security_invoker = true) AS
 SELECT quotations.id,
    'quotation'::text AS doc_type,
    quotations.qt_code AS doc_code,
    quotations.customer_id,
    quotations.assigned_rep,
    quotations.created_by,
    quotations.status AS doc_status,
    NULL::text AS payment_status,
    quotations.total,
    quotations.created_at,
    quotations.updated_at,
    quotations.validity_until AS type_specific_date,
    'validity_until'::text AS type_specific_date_label,
    quotations.archived,
    quotations.archived_at
   FROM quotations
UNION ALL
 SELECT sales_orders.id,
    'sales_order'::text AS doc_type,
    sales_orders.so_code AS doc_code,
    sales_orders.customer_id,
    sales_orders.assigned_rep,
    sales_orders.created_by,
    sales_orders.status AS doc_status,
    NULL::text AS payment_status,
    sales_orders.total,
    sales_orders.created_at,
    sales_orders.updated_at,
    sales_orders.delivery_date AS type_specific_date,
    'delivery_date'::text AS type_specific_date_label,
    sales_orders.archived,
    sales_orders.archived_at
   FROM sales_orders
UNION ALL
 SELECT crm_invoices.id,
    'invoice'::text AS doc_type,
    crm_invoices.inv_code AS doc_code,
    crm_invoices.customer_id,
    crm_invoices.assigned_rep,
    crm_invoices.created_by,
    crm_invoices.doc_status,
    crm_invoices.payment_status,
    crm_invoices.total,
    crm_invoices.created_at,
    crm_invoices.updated_at,
    crm_invoices.due_date AS type_specific_date,
    'due_date'::text AS type_specific_date_label,
    crm_invoices.archived,
    crm_invoices.archived_at
   FROM crm_invoices
UNION ALL
 SELECT credit_notes.id,
    'credit_note'::text AS doc_type,
    credit_notes.cn_code AS doc_code,
    credit_notes.customer_id,
    credit_notes.assigned_rep,
    credit_notes.created_by,
    credit_notes.status AS doc_status,
    NULL::text AS payment_status,
    credit_notes.total,
    credit_notes.created_at,
    credit_notes.updated_at,
    credit_notes.issued_at AS type_specific_date,
    'issued_date'::text AS type_specific_date_label,
    credit_notes.archived,
    credit_notes.archived_at
   FROM credit_notes;

CREATE OR REPLACE VIEW public.v_sales_rep_performance WITH (security_invoker = true) AS
 SELECT COALESCE(assigned_rep, '(unassigned)'::text) AS assigned_rep,
    count(*) AS invoices_total,
    count(*) FILTER (WHERE cogs_complete) AS invoices_costed,
    count(*) FILTER (WHERE NOT cogs_complete) AS invoices_cost_unknown,
    round(COALESCE(sum(revenue_base), 0::numeric), 2) AS revenue_base,
    round(COALESCE(sum(revenue_base) FILTER (WHERE cogs_complete), 0::numeric), 2) AS costed_revenue_base,
    round(COALESCE(sum(cogs_base) FILTER (WHERE cogs_complete), 0::numeric), 2) AS cogs_base,
    round(COALESCE(sum(margin_base), 0::numeric), 2) AS margin_base,
        CASE
            WHEN COALESCE(sum(revenue_base) FILTER (WHERE cogs_complete), 0::numeric) > 0::numeric THEN round(100.0 * COALESCE(sum(margin_base), 0::numeric) / sum(revenue_base) FILTER (WHERE cogs_complete), 2)
            ELSE NULL::numeric
        END AS margin_pct,
    min(posted_at) AS first_sale,
    max(posted_at) AS last_sale
   FROM v_invoice_margin m
  GROUP BY (COALESCE(assigned_rep, '(unassigned)'::text));

CREATE OR REPLACE VIEW public.v_vendor_ledger WITH (security_invoker = true) AS
 SELECT vendor_invoices.id,
    'vendor_invoice'::text AS entry_type,
    vendor_invoices.vi_code AS entry_code,
    vendor_invoices.vendor_id,
    vendor_invoices.total AS amount,
    vendor_invoices.currency,
    vendor_invoices.total_base AS amount_base,
    vendor_invoices.status,
    vendor_invoices.due_date,
    COALESCE(vendor_invoices.approved_at, vendor_invoices.created_at) AS entry_date,
    vendor_invoices.created_at
   FROM vendor_invoices
  WHERE vendor_invoices.status = ANY (ARRAY['approved'::text, 'partially_received'::text, 'received'::text])
UNION ALL
 SELECT vendor_payments.id,
    'vendor_payment'::text AS entry_type,
    vendor_payments.payment_code AS entry_code,
    vendor_payments.vendor_id,
    - vendor_payments.amount AS amount,
    vendor_payments.currency,
    - vendor_payments.amount_base AS amount_base,
    vendor_payments.status,
    NULL::date AS due_date,
    COALESCE(vendor_payments.payment_date::timestamp with time zone, vendor_payments.created_at) AS entry_date,
    vendor_payments.created_at
   FROM vendor_payments
  WHERE vendor_payments.status = 'active'::text;

-- Triggers
CREATE TRIGGER guard_converted_lead_trigger BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION guard_converted_lead();
CREATE TRIGGER invoices_updated_date BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION set_updated_date();
CREATE TRIGGER parts_updated_date BEFORE UPDATE ON public.parts FOR EACH ROW EXECUTE FUNCTION set_updated_date();
CREATE TRIGGER product_documents_updated_at BEFORE UPDATE ON public.product_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at_col();
CREATE TRIGGER trg_activities_update_customer_last_activity AFTER INSERT ON public.activities FOR EACH ROW EXECUTE FUNCTION crm_update_customer_last_activity();
CREATE TRIGGER trg_assert_po_status_transition BEFORE UPDATE OF status ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION assert_purchase_status_transition();
CREATE TRIGGER trg_assert_tracking_mode_change_is_safe BEFORE UPDATE OF stock_tracking_mode ON public.products FOR EACH ROW EXECUTE FUNCTION assert_tracking_mode_change_is_safe();
CREATE TRIGGER trg_assert_vi_status_transition BEFORE UPDATE OF status ON public.vendor_invoices FOR EACH ROW EXECUTE FUNCTION assert_purchase_status_transition();
CREATE TRIGGER trg_charges_before_receipt BEFORE INSERT OR DELETE OR UPDATE ON public.vendor_invoice_charges FOR EACH ROW EXECUTE FUNCTION rma_guard_charges_before_receipt();
CREATE TRIGGER trg_credit_notes_updated_at BEFORE UPDATE ON public.credit_notes FOR EACH ROW EXECUTE FUNCTION set_credit_notes_updated_at();
CREATE TRIGGER trg_crm_invoices_updated_at BEFORE UPDATE ON public.crm_invoices FOR EACH ROW EXECUTE FUNCTION set_crm_invoices_updated_at();
CREATE TRIGGER trg_guard_base_currency BEFORE INSERT OR UPDATE ON public.rma_config FOR EACH ROW EXECUTE FUNCTION rma_guard_base_currency();
CREATE TRIGGER trg_guard_custom_role_delete BEFORE DELETE ON public.custom_roles FOR EACH ROW EXECUTE FUNCTION rma_guard_custom_role_delete();
CREATE TRIGGER trg_guard_po_rate BEFORE INSERT OR UPDATE OF currency, exchange_rate ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION rma_guard_document_rate();
CREATE TRIGGER trg_guard_vendor_payment_rate BEFORE INSERT OR UPDATE OF currency, exchange_rate ON public.vendor_payments FOR EACH ROW EXECUTE FUNCTION rma_guard_document_rate();
CREATE TRIGGER trg_guard_vi_rate BEFORE INSERT OR UPDATE OF currency, exchange_rate ON public.vendor_invoices FOR EACH ROW EXECUTE FUNCTION rma_guard_document_rate();
CREATE TRIGGER trg_notif_settings_updated_at BEFORE UPDATE ON public.notification_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at_col();
CREATE TRIGGER trg_payments_updated_at BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION set_payments_updated_at();
CREATE TRIGGER trg_protect_last_super_admin BEFORE DELETE OR UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION rma_protect_last_super_admin();
CREATE TRIGGER trg_protect_system_warehouse BEFORE DELETE OR UPDATE ON public.warehouses FOR EACH ROW WHEN (old.is_system) EXECUTE FUNCTION protect_system_warehouse();
CREATE TRIGGER trg_quotations_updated_at BEFORE UPDATE ON public.quotations FOR EACH ROW EXECUTE FUNCTION set_quotations_updated_at();
CREATE TRIGGER trg_sales_orders_updated_at BEFORE UPDATE ON public.sales_orders FOR EACH ROW EXECUTE FUNCTION set_sales_orders_updated_at();
CREATE TRIGGER trg_stock_moves_stamp_actor BEFORE INSERT ON public.stock_moves FOR EACH ROW EXECUTE FUNCTION stock_moves_stamp_actor();
CREATE TRIGGER trg_sync_cn_balance AFTER INSERT OR DELETE OR UPDATE OF amount_applied ON public.credit_note_applications FOR EACH ROW EXECUTE FUNCTION sync_credit_note_balance();
CREATE TRIGGER trg_sync_payment_balance AFTER INSERT OR DELETE OR UPDATE OF amount_applied ON public.payment_applications FOR EACH ROW EXECUTE FUNCTION sync_payment_balance();
CREATE TRIGGER trg_sync_vendor_payment_balance AFTER INSERT OR DELETE OR UPDATE OF amount_applied ON public.vendor_payment_applications FOR EACH ROW EXECUTE FUNCTION sync_vendor_payment_balance();
CREATE TRIGGER trg_validate_user_role BEFORE INSERT OR UPDATE OF role ON public.user_roles FOR EACH ROW EXECUTE FUNCTION rma_validate_user_role();
CREATE TRIGGER trg_vendor_payments_updated_at BEFORE UPDATE ON public.vendor_payments FOR EACH ROW EXECUTE FUNCTION set_vendor_payments_updated_at();
CREATE TRIGGER trg_wa_templates_updated_at BEFORE UPDATE ON public.whatsapp_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at_col();
CREATE TRIGGER trg_warehouse_stock_hold_unit_cost BEFORE UPDATE ON public.warehouse_stock FOR EACH ROW EXECUTE FUNCTION rma_hold_unit_cost();

-- Row level security
ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branding_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.countries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.country_area_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_note_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manufacturer_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rma_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rma_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subcategories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_invoice_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_payment_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_templates ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY activities_insert ON public.activities FOR INSERT TO authenticated WITH CHECK ((rma_is_manager_or_above() OR (rma_user_role() = 'sales_rep'::text)));
CREATE POLICY activities_read ON public.activities FOR SELECT TO authenticated USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND (assigned_rep = rma_current_user_email()))));
CREATE POLICY activities_update ON public.activities FOR UPDATE TO authenticated USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND (assigned_rep = rma_current_user_email())))) WITH CHECK ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND (assigned_rep = rma_current_user_email()))));
CREATE POLICY admin_delete ON public.activities FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY admin_all ON public.announcements FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY staff_read ON public.announcements FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_all ON public.branding_settings FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY staff_read_branding ON public.branding_settings FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_delete ON public.brands FOR DELETE TO PUBLIC USING (rma_is_admin());
CREATE POLICY manager_update_brands ON public.brands FOR UPDATE TO PUBLIC USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY manager_write_brands ON public.brands FOR INSERT TO PUBLIC WITH CHECK (rma_is_manager_or_above());
CREATE POLICY staff_read ON public.brands FOR SELECT TO PUBLIC USING (rma_is_staff());
CREATE POLICY admin_delete ON public.categories FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY admin_update ON public.categories FOR UPDATE TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY admin_write ON public.categories FOR INSERT TO authenticated WITH CHECK (rma_is_admin());
CREATE POLICY staff_read ON public.categories FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_delete ON public.contacts FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY manager_insert ON public.contacts FOR INSERT TO authenticated WITH CHECK (rma_is_manager_or_above());
CREATE POLICY manager_update ON public.contacts FOR UPDATE TO authenticated USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY staff_read ON public.contacts FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY countries_admin_write ON public.countries FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY countries_staff_read ON public.countries FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY area_codes_admin_write ON public.country_area_codes FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY area_codes_staff_read ON public.country_area_codes FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_delete_cn_applications ON public.credit_note_applications FOR DELETE TO PUBLIC USING (rma_is_admin());
CREATE POLICY manager_insert_cn_applications ON public.credit_note_applications FOR INSERT TO PUBLIC WITH CHECK (rma_is_manager_or_above());
CREATE POLICY staff_read_cn_applications ON public.credit_note_applications FOR SELECT TO PUBLIC USING (rma_is_staff());
CREATE POLICY accountant_read_credit_notes ON public.credit_notes FOR SELECT TO PUBLIC USING ((rma_user_role() = 'accountant'::text));
CREATE POLICY admin_delete_credit_notes ON public.credit_notes FOR DELETE TO PUBLIC USING (rma_is_admin());
CREATE POLICY manager_update_credit_notes ON public.credit_notes FOR UPDATE TO PUBLIC USING ((rma_is_manager_or_above() OR (assigned_rep = rma_current_user_email()) OR (created_by = rma_current_user_email())));
CREATE POLICY sales_insert_credit_notes ON public.credit_notes FOR INSERT TO PUBLIC WITH CHECK ((rma_is_manager_or_above() OR (rma_user_role() = 'sales_rep'::text)));
CREATE POLICY sales_rep_read_credit_notes ON public.credit_notes FOR SELECT TO PUBLIC USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND ((assigned_rep = rma_current_user_email()) OR (created_by = rma_current_user_email())))));
CREATE POLICY accountant_read_crm_invoices ON public.crm_invoices FOR SELECT TO PUBLIC USING ((rma_user_role() = 'accountant'::text));
CREATE POLICY admin_delete_crm_invoices ON public.crm_invoices FOR DELETE TO PUBLIC USING (rma_is_admin());
CREATE POLICY manager_update_crm_invoices ON public.crm_invoices FOR UPDATE TO PUBLIC USING ((rma_is_manager_or_above() OR (assigned_rep = rma_current_user_email()) OR (created_by = rma_current_user_email())));
CREATE POLICY sales_insert_crm_invoices ON public.crm_invoices FOR INSERT TO PUBLIC WITH CHECK ((rma_is_manager_or_above() OR (rma_user_role() = 'sales_rep'::text)));
CREATE POLICY sales_rep_read_crm_invoices ON public.crm_invoices FOR SELECT TO PUBLIC USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND ((assigned_rep = rma_current_user_email()) OR (created_by = rma_current_user_email())))));
CREATE POLICY currencies_admin_write ON public.currencies FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY currencies_staff_read ON public.currencies FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_all ON public.custom_field_definitions FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY admin_all ON public.custom_roles FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY staff_read_custom_roles ON public.custom_roles FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_delete ON public.customer_notes FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY manager_insert ON public.customer_notes FOR INSERT TO authenticated WITH CHECK (rma_is_manager_or_above());
CREATE POLICY manager_update ON public.customer_notes FOR UPDATE TO authenticated USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY staff_read ON public.customer_notes FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_delete ON public.customers FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY manager_insert ON public.customers FOR INSERT TO authenticated WITH CHECK (rma_is_manager_or_above());
CREATE POLICY manager_update ON public.customers FOR UPDATE TO authenticated USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY sales_insert_customers ON public.customers FOR INSERT TO authenticated WITH CHECK ((rma_is_manager_or_above() OR (rma_user_role() = 'sales_rep'::text)));
CREATE POLICY sales_rep_update_assigned ON public.customers FOR UPDATE TO authenticated USING (((rma_user_role() = 'sales_rep'::text) AND (assigned_rep = rma_current_user_email()))) WITH CHECK (((rma_user_role() = 'sales_rep'::text) AND (assigned_rep = rma_current_user_email())));
CREATE POLICY staff_read ON public.customers FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_delete ON public.deals FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY deals_insert ON public.deals FOR INSERT TO authenticated WITH CHECK ((rma_is_manager_or_above() OR (rma_user_role() = 'sales_rep'::text)));
CREATE POLICY deals_read ON public.deals FOR SELECT TO authenticated USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND (assigned_rep = rma_current_user_email()))));
CREATE POLICY deals_update ON public.deals FOR UPDATE TO authenticated USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND (assigned_rep = rma_current_user_email())))) WITH CHECK ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND (assigned_rep = rma_current_user_email()))));
CREATE POLICY no_direct_client_access ON public.document_sequences FOR ALL TO PUBLIC USING (false);
CREATE POLICY email_queue_admin_read ON public.email_queue FOR SELECT TO authenticated USING (rma_is_admin());
CREATE POLICY staff_insert_email_queue ON public.email_queue FOR INSERT TO authenticated WITH CHECK (rma_is_staff());
CREATE POLICY admin_all ON public.email_settings FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY admin_all ON public.email_templates FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY staff_read_email_templates ON public.email_templates FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_delete ON public.inventory_units FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY staff_read ON public.inventory_units FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY staff_update ON public.inventory_units FOR UPDATE TO authenticated USING ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text))) WITH CHECK ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text)));
CREATE POLICY staff_write ON public.inventory_units FOR INSERT TO authenticated WITH CHECK ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text)));
CREATE POLICY admin_delete ON public.invoices FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY manager_update ON public.invoices FOR UPDATE TO authenticated USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY manager_write ON public.invoices FOR INSERT TO authenticated WITH CHECK (rma_is_manager_or_above());
CREATE POLICY staff_read ON public.invoices FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY kb_admin_write ON public.kb_articles FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY kb_public_read ON public.kb_articles FOR SELECT TO PUBLIC USING ((is_published = true));
CREATE POLICY kb_staff_read_all ON public.kb_articles FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_delete ON public.leads FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY leads_insert ON public.leads FOR INSERT TO authenticated WITH CHECK ((rma_is_manager_or_above() OR (rma_user_role() = 'sales_rep'::text)));
CREATE POLICY leads_read ON public.leads FOR SELECT TO authenticated USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND (assigned_rep = rma_current_user_email()))));
CREATE POLICY leads_update ON public.leads FOR UPDATE TO authenticated USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND (assigned_rep = rma_current_user_email())))) WITH CHECK ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND (assigned_rep = rma_current_user_email()))));
CREATE POLICY admin_delete ON public.manufacturer_batches FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY staff_read ON public.manufacturer_batches FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY staff_update ON public.manufacturer_batches FOR UPDATE TO authenticated USING ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text))) WITH CHECK ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text)));
CREATE POLICY staff_write ON public.manufacturer_batches FOR INSERT TO authenticated WITH CHECK ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text)));
CREATE POLICY notif_logs_manager_update ON public.notification_logs FOR UPDATE TO authenticated USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY notif_logs_staff_read ON public.notification_logs FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY "Users can insert their own preferences" ON public.notification_preferences FOR INSERT TO authenticated WITH CHECK ((user_email = auth.email()));
CREATE POLICY "Users can read their own preferences" ON public.notification_preferences FOR SELECT TO authenticated USING ((user_email = auth.email()));
CREATE POLICY "Users can update their own preferences" ON public.notification_preferences FOR UPDATE TO authenticated USING ((user_email = auth.email())) WITH CHECK ((user_email = auth.email()));
CREATE POLICY user_own ON public.notification_preferences FOR ALL TO authenticated USING (((user_email = rma_current_user_email()) OR rma_is_admin())) WITH CHECK (((user_email = rma_current_user_email()) OR rma_is_admin()));
CREATE POLICY admin_read_notif_queue ON public.notification_queue FOR SELECT TO PUBLIC USING (rma_is_admin());
CREATE POLICY staff_insert_notif_queue ON public.notification_queue FOR INSERT TO PUBLIC WITH CHECK (rma_is_staff());
CREATE POLICY admin_rw_notif_settings ON public.notification_settings FOR ALL TO PUBLIC USING (rma_is_admin());
CREATE POLICY admin_delete ON public.notifications FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY staff_insert ON public.notifications FOR INSERT TO authenticated WITH CHECK (rma_is_staff());
CREATE POLICY user_read_targeted ON public.notifications FOR SELECT TO authenticated USING ((rma_is_staff() AND ((target_roles IS NULL) OR (array_length(target_roles, 1) IS NULL) OR (rma_user_role() = ANY (target_roles)) OR ((target_emails IS NOT NULL) AND (rma_current_user_email() = ANY (target_emails))))));
CREATE POLICY user_update_read ON public.notifications FOR UPDATE TO authenticated USING (rma_is_staff()) WITH CHECK (rma_is_staff());
CREATE POLICY admin_delete ON public.parts FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY staff_read ON public.parts FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY staff_update ON public.parts FOR UPDATE TO authenticated USING ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text))) WITH CHECK ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text)));
CREATE POLICY staff_write ON public.parts FOR INSERT TO authenticated WITH CHECK ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text)));
CREATE POLICY admin_delete_payment_applications ON public.payment_applications FOR DELETE TO PUBLIC USING (rma_is_admin());
CREATE POLICY manager_insert_payment_applications ON public.payment_applications FOR INSERT TO PUBLIC WITH CHECK (rma_is_manager_or_above());
CREATE POLICY staff_read_payment_applications ON public.payment_applications FOR SELECT TO PUBLIC USING (rma_is_staff());
CREATE POLICY accountant_read_payments ON public.payments FOR SELECT TO PUBLIC USING ((rma_user_role() = 'accountant'::text));
CREATE POLICY admin_delete_payments ON public.payments FOR DELETE TO PUBLIC USING (rma_is_admin());
CREATE POLICY manager_update_payments ON public.payments FOR UPDATE TO PUBLIC USING ((rma_is_manager_or_above() OR (created_by = rma_current_user_email())));
CREATE POLICY staff_insert_payments ON public.payments FOR INSERT TO PUBLIC WITH CHECK (rma_is_staff());
CREATE POLICY staff_read_payments ON public.payments FOR SELECT TO PUBLIC USING ((rma_is_manager_or_above() OR (rma_is_staff() AND (created_by = rma_current_user_email()))));
CREATE POLICY admin_delete ON public.pipelines FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY admin_insert ON public.pipelines FOR INSERT TO authenticated WITH CHECK (rma_is_admin());
CREATE POLICY admin_update ON public.pipelines FOR UPDATE TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY staff_read ON public.pipelines FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY product_documents_manager_write ON public.product_documents FOR ALL TO authenticated USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY product_documents_staff_read ON public.product_documents FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY product_images_admin_write ON public.product_images FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY product_images_staff_read ON public.product_images FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_delete ON public.products FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY manager_insert ON public.products FOR INSERT TO authenticated WITH CHECK (rma_is_manager_or_above());
CREATE POLICY manager_update ON public.products FOR UPDATE TO authenticated USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY staff_read ON public.products FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY accountant_read_purchase_orders ON public.purchase_orders FOR SELECT TO PUBLIC USING ((rma_user_role() = 'accountant'::text));
CREATE POLICY manager_read_purchase_orders ON public.purchase_orders FOR SELECT TO PUBLIC USING (rma_is_manager_or_above());
CREATE POLICY manager_write_purchase_orders ON public.purchase_orders FOR ALL TO PUBLIC USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY accountant_read_quotations ON public.quotations FOR SELECT TO PUBLIC USING ((rma_user_role() = 'accountant'::text));
CREATE POLICY admin_delete_quotations ON public.quotations FOR DELETE TO PUBLIC USING (rma_is_admin());
CREATE POLICY manager_insert_quotations ON public.quotations FOR INSERT TO PUBLIC WITH CHECK ((rma_is_manager_or_above() OR (created_by = rma_current_user_email())));
CREATE POLICY sales_insert_quotations ON public.quotations FOR INSERT TO PUBLIC WITH CHECK ((rma_is_manager_or_above() OR (rma_user_role() = 'sales_rep'::text)));
CREATE POLICY sales_rep_read_quotations ON public.quotations FOR SELECT TO PUBLIC USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND ((assigned_rep = rma_current_user_email()) OR (created_by = rma_current_user_email())))));
CREATE POLICY sales_update_quotations ON public.quotations FOR UPDATE TO PUBLIC USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND ((assigned_rep = rma_current_user_email()) OR (created_by = rma_current_user_email()))))) WITH CHECK ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND ((assigned_rep = rma_current_user_email()) OR (created_by = rma_current_user_email())))));
CREATE POLICY admin_all ON public.rma_config FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY staff_read_appearance_settings ON public.rma_config FOR SELECT TO PUBLIC USING ((rma_is_staff() AND (config_key = 'appearance_settings'::text)));
CREATE POLICY staff_write_appearance_settings ON public.rma_config FOR ALL TO PUBLIC USING ((rma_is_staff() AND (config_key = 'appearance_settings'::text))) WITH CHECK ((rma_is_staff() AND (config_key = 'appearance_settings'::text)));
CREATE POLICY admin_delete ON public.rma_tickets FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY manager_insert ON public.rma_tickets FOR INSERT TO authenticated WITH CHECK (rma_is_manager_or_above());
CREATE POLICY staff_insert_tickets ON public.rma_tickets FOR INSERT TO authenticated WITH CHECK ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text)));
CREATE POLICY staff_read ON public.rma_tickets FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY staff_update ON public.rma_tickets FOR UPDATE TO authenticated USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'technician'::text) AND (assigned_technician = rma_current_user_email())))) WITH CHECK ((rma_is_manager_or_above() OR ((rma_user_role() = 'technician'::text) AND (assigned_technician = rma_current_user_email()))));
CREATE POLICY accountant_read_sales_orders ON public.sales_orders FOR SELECT TO PUBLIC USING ((rma_user_role() = 'accountant'::text));
CREATE POLICY admin_delete_sales_orders ON public.sales_orders FOR DELETE TO PUBLIC USING (rma_is_admin());
CREATE POLICY sales_insert_sales_orders ON public.sales_orders FOR INSERT TO PUBLIC WITH CHECK ((rma_is_manager_or_above() OR (rma_user_role() = 'sales_rep'::text)));
CREATE POLICY sales_rep_read_sales_orders ON public.sales_orders FOR SELECT TO PUBLIC USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND ((assigned_rep = rma_current_user_email()) OR (created_by = rma_current_user_email())))));
CREATE POLICY sales_update_sales_orders ON public.sales_orders FOR UPDATE TO PUBLIC USING ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND ((assigned_rep = rma_current_user_email()) OR (created_by = rma_current_user_email()))))) WITH CHECK ((rma_is_manager_or_above() OR ((rma_user_role() = 'sales_rep'::text) AND ((assigned_rep = rma_current_user_email()) OR (created_by = rma_current_user_email())))));
CREATE POLICY no_direct_client_insert ON public.stock_moves FOR INSERT TO PUBLIC WITH CHECK (false);
CREATE POLICY staff_read_stock_moves ON public.stock_moves FOR SELECT TO PUBLIC USING (rma_is_staff());
CREATE POLICY admin_delete ON public.subcategories FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY admin_update ON public.subcategories FOR UPDATE TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY admin_write ON public.subcategories FOR INSERT TO authenticated WITH CHECK (rma_is_admin());
CREATE POLICY staff_read ON public.subcategories FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_delete ON public.ticket_activity FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY staff_insert ON public.ticket_activity FOR INSERT TO authenticated WITH CHECK ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text)));
CREATE POLICY staff_read ON public.ticket_activity FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_delete ON public.ticket_comments FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY staff_insert ON public.ticket_comments FOR INSERT TO authenticated WITH CHECK ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text)));
CREATE POLICY staff_read ON public.ticket_comments FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY staff_update_comments ON public.ticket_comments FOR UPDATE TO authenticated USING ((rma_is_manager_or_above() OR (user_email = rma_current_user_email()))) WITH CHECK ((rma_is_manager_or_above() OR (user_email = rma_current_user_email())));
CREATE POLICY admin_delete ON public.ticket_parts FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY staff_read ON public.ticket_parts FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY staff_update ON public.ticket_parts FOR UPDATE TO authenticated USING ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text))) WITH CHECK ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text)));
CREATE POLICY staff_write ON public.ticket_parts FOR INSERT TO authenticated WITH CHECK ((rma_is_staff() AND (rma_user_role() <> 'viewer'::text)));
CREATE POLICY staff_delete_resolutions ON public.ticket_resolutions FOR DELETE TO PUBLIC USING (rma_is_manager_or_above());
CREATE POLICY staff_read_resolutions ON public.ticket_resolutions FOR SELECT TO PUBLIC USING (rma_is_staff());
CREATE POLICY staff_write_resolutions ON public.ticket_resolutions FOR INSERT TO PUBLIC WITH CHECK (rma_is_staff());
CREATE POLICY staff_write_update_resolutions ON public.ticket_resolutions FOR UPDATE TO PUBLIC USING (rma_is_staff());
CREATE POLICY admin_delete ON public.time_entries FOR DELETE TO authenticated USING ((rma_is_admin() OR (user_email = rma_current_user_email())));
CREATE POLICY user_insert_own ON public.time_entries FOR INSERT TO authenticated WITH CHECK (((user_email = rma_current_user_email()) AND rma_is_staff()));
CREATE POLICY user_read_own ON public.time_entries FOR SELECT TO authenticated USING (((user_email = rma_current_user_email()) OR rma_is_manager_or_above()));
CREATE POLICY user_update_own ON public.time_entries FOR UPDATE TO authenticated USING (((user_email = rma_current_user_email()) OR rma_is_manager_or_above())) WITH CHECK (((user_email = rma_current_user_email()) OR rma_is_manager_or_above()));
CREATE POLICY admin_read ON public.user_activity_log FOR SELECT TO authenticated USING (rma_is_admin());
CREATE POLICY auth_insert ON public.user_activity_log FOR INSERT TO authenticated WITH CHECK (rma_is_authenticated());
CREATE POLICY legacy_user_permissions_admin ON public.user_permissions FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY user_own_preferences_delete ON public.user_preferences FOR DELETE TO PUBLIC USING ((user_email = rma_current_user_email()));
CREATE POLICY user_own_preferences_insert ON public.user_preferences FOR INSERT TO PUBLIC WITH CHECK ((user_email = rma_current_user_email()));
CREATE POLICY user_own_preferences_select ON public.user_preferences FOR SELECT TO PUBLIC USING ((user_email = rma_current_user_email()));
CREATE POLICY user_own_preferences_update ON public.user_preferences FOR UPDATE TO PUBLIC USING ((user_email = rma_current_user_email()));
CREATE POLICY users_own_prefs ON public.user_preferences FOR ALL TO PUBLIC USING ((user_email = rma_current_user_email()));
CREATE POLICY admin_delete ON public.user_roles FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY admin_update ON public.user_roles FOR UPDATE TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY admin_write ON public.user_roles FOR INSERT TO authenticated WITH CHECK (rma_is_admin());
CREATE POLICY user_read_own ON public.user_roles FOR SELECT TO authenticated USING (((user_email = rma_current_user_email()) OR rma_is_admin()));
CREATE POLICY vi_charges_manager_write ON public.vendor_invoice_charges FOR ALL TO authenticated USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY vi_charges_staff_read ON public.vendor_invoice_charges FOR SELECT TO authenticated USING ((rma_is_manager_or_above() OR (rma_user_role() = 'accountant'::text)));
CREATE POLICY accountant_read_vendor_invoices ON public.vendor_invoices FOR SELECT TO PUBLIC USING ((rma_user_role() = 'accountant'::text));
CREATE POLICY manager_read_vendor_invoices ON public.vendor_invoices FOR SELECT TO PUBLIC USING (rma_is_manager_or_above());
CREATE POLICY manager_write_vendor_invoices ON public.vendor_invoices FOR ALL TO PUBLIC USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY admin_delete_vendor_payment_applications ON public.vendor_payment_applications FOR DELETE TO PUBLIC USING (rma_is_admin());
CREATE POLICY manager_insert_vendor_payment_applications ON public.vendor_payment_applications FOR INSERT TO PUBLIC WITH CHECK (rma_is_manager_or_above());
CREATE POLICY staff_read_vendor_payment_applications ON public.vendor_payment_applications FOR SELECT TO PUBLIC USING (rma_is_staff());
CREATE POLICY accountant_read_vendor_payments ON public.vendor_payments FOR SELECT TO PUBLIC USING ((rma_user_role() = 'accountant'::text));
CREATE POLICY admin_delete_vendor_payments ON public.vendor_payments FOR DELETE TO PUBLIC USING (rma_is_admin());
CREATE POLICY manager_update_vendor_payments ON public.vendor_payments FOR UPDATE TO PUBLIC USING ((rma_is_manager_or_above() OR (created_by = rma_current_user_email())));
CREATE POLICY staff_insert_vendor_payments ON public.vendor_payments FOR INSERT TO PUBLIC WITH CHECK (rma_is_staff());
CREATE POLICY staff_read_vendor_payments ON public.vendor_payments FOR SELECT TO PUBLIC USING ((rma_is_manager_or_above() OR (rma_is_staff() AND (created_by = rma_current_user_email()))));
CREATE POLICY manager_write_warehouse_stock ON public.warehouse_stock FOR ALL TO PUBLIC USING (rma_is_manager_or_above()) WITH CHECK (rma_is_manager_or_above());
CREATE POLICY staff_read_warehouse_stock ON public.warehouse_stock FOR SELECT TO PUBLIC USING (rma_is_staff());
CREATE POLICY admin_delete ON public.warehouses FOR DELETE TO authenticated USING (rma_is_admin());
CREATE POLICY admin_update ON public.warehouses FOR UPDATE TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY admin_write ON public.warehouses FOR INSERT TO authenticated WITH CHECK (rma_is_admin());
CREATE POLICY staff_read ON public.warehouses FOR SELECT TO authenticated USING (rma_is_staff());
CREATE POLICY admin_all ON public.webhooks FOR ALL TO authenticated USING (rma_is_admin()) WITH CHECK (rma_is_admin());
CREATE POLICY admin_write_wa_templates ON public.whatsapp_templates FOR ALL TO PUBLIC USING (rma_is_admin());
CREATE POLICY staff_read_wa_templates ON public.whatsapp_templates FOR SELECT TO PUBLIC USING (rma_is_staff());

-- Grants
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.activities TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.activities TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.activities TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.announcements TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.announcements TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.branding_settings TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.branding_settings TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.brands TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.brands TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.categories TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.categories TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.contacts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.contacts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.contacts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.countries TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.countries TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.country_area_codes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.country_area_codes TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.credit_note_applications TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.credit_note_applications TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.credit_note_applications TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.credit_notes TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.credit_notes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.credit_notes TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.crm_invoices TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.crm_invoices TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.crm_invoices TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.currencies TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.currencies TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.custom_field_definitions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.custom_field_definitions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.custom_roles TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.custom_roles TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.customer_notes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.customer_notes TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.customers TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.customers TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.deals TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.deals TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.deals TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.document_sequences TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.document_sequences TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.document_sequences TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.email_queue TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.email_queue TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.email_settings TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.email_settings TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.email_templates TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.email_templates TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.inventory_units TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.inventory_units TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.invoices TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.invoices TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kb_articles TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kb_articles TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kb_articles TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.leads TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.leads TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.leads TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.manufacturer_batches TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.manufacturer_batches TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_logs TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_logs TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_logs TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_preferences TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_preferences TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_queue TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_queue TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_queue TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_settings TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_settings TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_settings TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notifications TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notifications TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.parts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.parts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payment_applications TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payment_applications TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payment_applications TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payments TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payments TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.pipelines TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.pipelines TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.pipelines TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.product_documents TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.product_documents TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.product_images TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.product_images TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.products TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.products TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.purchase_orders TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.purchase_orders TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.purchase_orders TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.quotations TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.quotations TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.quotations TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.rma_config TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.rma_config TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.rma_tickets TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.rma_tickets TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.sales_orders TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.sales_orders TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.sales_orders TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.stock_moves TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.stock_moves TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.stock_moves TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.subcategories TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.subcategories TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ticket_activity TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ticket_activity TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ticket_comments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ticket_comments TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ticket_parts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ticket_parts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ticket_resolutions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ticket_resolutions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ticket_resolutions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.time_entries TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.time_entries TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_activity_log TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_activity_log TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_permissions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_permissions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_preferences TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_preferences TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_preferences TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_roles TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_roles TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_customer_ledger TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_customer_ledger TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_customer_ledger TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_invoice_margin TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_invoice_margin TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_invoice_margin TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_purchase_documents TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_purchase_documents TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_purchase_documents TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_sales_documents TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_sales_documents TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_sales_documents TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_sales_rep_performance TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_sales_rep_performance TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_sales_rep_performance TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_vendor_ledger TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_vendor_ledger TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.v_vendor_ledger TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vendor_invoice_charges TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vendor_invoice_charges TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vendor_invoices TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vendor_invoices TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vendor_invoices TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vendor_payment_applications TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vendor_payment_applications TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vendor_payment_applications TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vendor_payments TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vendor_payments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vendor_payments TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.warehouse_stock TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.warehouse_stock TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.warehouse_stock TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.warehouses TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.warehouses TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.webhooks TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.webhooks TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.whatsapp_templates TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.whatsapp_templates TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.whatsapp_templates TO service_role;

-- Comments
COMMENT ON COLUMN public.brands.country_code IS 'Overrides the system default country for phone validation. NULL means use the default.';
COMMENT ON COLUMN public.countries.landline_digits IS 'National landline length for countries with no area codes. Ignored when has_area_codes is true — the length then varies by area and lives on country_area_codes.';
COMMENT ON COLUMN public.countries.mobile_digits IS 'Total national digits INCLUDING the prefix. Egypt is 11: 01x plus eight.';
COMMENT ON COLUMN public.crm_invoices.cogs_base IS 'Cost of the goods this invoice shipped, in base currency, captured at posting. NULL means not posted, or voided. Never recomputed.';
COMMENT ON COLUMN public.crm_invoices.cogs_complete IS 'True only when every unit shipped had a known cost. Derived; margin reporting must lead with this, not with the number.';
COMMENT ON COLUMN public.crm_invoices.cogs_unknown_qty IS 'Units shipped whose cost was unknown. Above zero means cogs_base covers only part of the sale and any margin from it is overstated.';
COMMENT ON COLUMN public.customers.country_code IS 'Overrides the system default country for phone validation. NULL means use the default.';
COMMENT ON COLUMN public.inventory_units.reservation_status IS 'Funnel/sales state: available | reserved (see reserved_by_doc_id) | delivered. Orthogonal to status — a unit is only sellable for a new document when it is ALSO status = ''company_stock''.';
COMMENT ON COLUMN public.inventory_units.status IS 'Physical/RMA repair lifecycle: active_rma (on the bench) | company_stock (sellable, in warehouse) | sent_to_manufacturer (out for repair) | closed (terminal). Orthogonal to reservation_status — never conflate the two.';
COMMENT ON COLUMN public.inventory_units.unit_cost_base IS 'Landed cost of this one unit in base currency, set when it was received. NULL means it predates costing or arrived through a path with no price.';
COMMENT ON COLUMN public.product_documents.extraction_status IS 'Whether the text could be read. A scanned datasheet is images of text and comes out empty — saying so is better than the document silently never appearing in search.';
COMMENT ON COLUMN public.purchase_orders.exchange_rate IS 'Units of base currency per one unit of this document''s currency, as actually paid. 1 for local purchases. Recorded on the document because a past purchase must keep converting the way it did at the time.';
COMMENT ON COLUMN public.purchase_orders.total_base IS 'total in base currency. Generated, so it cannot drift out of step with total or the rate.';
COMMENT ON COLUMN public.user_roles.access_expires_at IS 'Access ends at this instant. NULL means no expiry. Enforced centrally by rma_access_is_current(), so every RLS policy honours it without change.';
COMMENT ON COLUMN public.vendor_payments.amount_base IS 'What the payment cost in base currency. Derived; never written directly.';
COMMENT ON COLUMN public.vendor_payments.currency IS 'The currency the payment was made in. Must match the currency of every invoice it is applied to.';
COMMENT ON COLUMN public.vendor_payments.exchange_rate IS 'Rate to the base currency ON THE PAYMENT DATE, which is normally not the rate the invoice was received at. The difference is an FX gain or loss.';
COMMENT ON COLUMN public.warehouse_stock.avg_cost_base IS 'Weighted average cost of the COSTED units in this bin. NULL means nothing here has a known cost — it is not zero.';
COMMENT ON COLUMN public.warehouse_stock.total_cost_base IS 'Base-currency value of the stock on hand. Maintained by rma_hold_unit_cost() unless a receipt or transfer sets it explicitly.';
COMMENT ON COLUMN public.warehouse_stock.uncosted_quantity IS 'How many of the units on hand have no known cost. Excluded from avg_cost_base, so an unknown never behaves like a cost of zero.';
COMMENT ON TABLE public.countries IS 'Countries this installation deals with, and the phone number rules that apply in each. A table rather than a hardcoded list so a rule can be corrected without a deploy.';
COMMENT ON TABLE public.country_area_codes IS 'Landline area codes per country — governorates in Egypt. A country with none simply has no rows, and validation falls back to countries.landline_digits.';
COMMENT ON TABLE public.currencies IS 'ISO 4217 currencies this installation can transact in. A table rather than a config list so documents can reference a real row and formatting can read decimals from data.';
COMMENT ON TABLE public.product_documents IS 'Datasheets and manuals attached to a product. extracted_text is what makes them searchable and what a language model is later given to read.';
COMMENT ON VIEW public.v_invoice_margin IS 'Margin on every posted invoice. margin_base is NULL where the cost of goods is incomplete — that is "cannot tell", not "made nothing".';
COMMENT ON VIEW public.v_sales_rep_performance IS 'Sales performance per rep. margin_pct is measured against costed_revenue_base, not revenue_base, so it means "of what we can cost, this much was margin". invoices_cost_unknown says how much is missing.';
COMMENT ON TABLE public.vendor_invoice_charges IS 'Freight, customs and clearance on a vendor invoice. Apportioned across the goods by line value at receipt so they land in unit cost rather than being lost to general expenses.';
