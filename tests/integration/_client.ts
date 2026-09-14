/**
 * Shared setup for the integration tier.
 *
 * WHY THIS EXISTS, AND WHY IT DOES NOT USE DOCKER
 *
 * The original `db-tests` job (`npm run test:db`) is blocked twice over:
 *
 *   1. `supabase start` needs a container runtime, and this project will not
 *      be using Docker.
 *   2. Even with Docker it could not pass. `supabase start` applies every
 *      migration to an *empty* Postgres, but this schema was created by Base44
 *      and the migrations only ALTER it — thirteen core tables (customers,
 *      products, rma_tickets, inventory_units, user_roles, …) are never created
 *      by any migration. The first `ALTER TABLE public.products` dies on
 *      "relation does not exist". That job has been red since the day it was
 *      added and has never verified anything.
 *
 * Both problems disappear if the tests point at a *hosted* Supabase project
 * that already has the real schema. No container, no baseline dump, and the
 * thing under test is the schema the app actually runs against.
 *
 * SAFETY
 *
 * These tests run against a real database, so the default posture is read-only.
 * Everything in this tier either reads, or calls a privileged RPC as an
 * unauthenticated user and asserts it is refused *before* it does any work.
 * Nothing here writes.
 *
 * If a future test needs to write, it must gate itself on
 * `describeWrite` below, which stays skipped unless SUPABASE_TEST_ALLOW_WRITES
 * is explicitly set. That is deliberate friction: this project has twice lost
 * live data to a test that assumed it was operating on scratch records.
 *
 * CREDENTIALS
 *
 * Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (same names the app uses, so
 * a local .env already works). When they are absent every suite skips with a
 * clear message rather than failing — so a fresh clone, and CI on a fork with
 * no secrets, both stay green.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe } from 'vitest'

const url = process.env.VITE_SUPABASE_URL || ''
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || ''

export const hasCredentials = Boolean(url && anonKey)

/** Suites that only read, or assert an RPC refuses an unauthorized caller. */
export const describeIntegration = hasCredentials
  ? describe
  : describe.skip

/**
 * Suites that mutate. Skipped unless SUPABASE_TEST_ALLOW_WRITES is set, so the
 * default `npm run test:integration` can never write to whatever project the
 * ambient credentials happen to point at.
 */
export const describeWrite =
  hasCredentials && process.env.SUPABASE_TEST_ALLOW_WRITES === '1'
    ? describe
    : describe.skip

/**
 * An unauthenticated client — exactly what a logged-out browser would have.
 *
 * Call this *inside* a test, never at describe scope. `describe.skip` still
 * evaluates its callback body, so a client built at describe scope is
 * constructed even in the skipped case — and `createClient('', '')` throws,
 * turning a clean skip into three failing files. Found exactly that way.
 */
export function anonClient(): SupabaseClient {
  if (!hasCredentials) {
    throw new Error(`anonClient() called without credentials — ${skipReason}`)
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Tables that must never be readable without a session. */
export const PROTECTED_TABLES = [
  'customers',
  'rma_tickets',
  'inventory_units',
  'user_roles',
  'crm_invoices',
  'sales_orders',
  // The view; there has never been a purchase_documents table, so this line
  // asserted nothing until 2026-09-13. (BUG-061)
  'v_purchase_documents',
  'user_activity_log',
] as const

/**
 * Columns the app reads by name. A PostgREST select on a missing column fails
 * with 42703, so selecting them is a cheap drift check against the live schema —
 * the coverage the never-green db-tests job was supposed to provide.
 */
export const EXPECTED_COLUMNS: Record<string, string[]> = {
  customers: ['id', 'customer_code', 'company_name', 'contact_person', 'email', 'customer_type'],
  products: ['id', 'sku', 'product_name', 'stock_tracking_mode', 'status', 'brand_id'],
  // customer_name: Inventory's unit detail reads it by RMA number.
  rma_tickets: ['id', 'rma_number', 'customer_id', 'customer_name', 'ticket_status', 'priority', 'products'],
  inventory_units: [
    'id',
    'product_id',
    'serial_number',
    'status',
    'reservation_status',
    'reserved_by_doc_type',
    'reserved_by_doc_id',
    'rma_ticket_id',
    'warehouse_id',
  ],
  crm_invoices: ['id', 'inv_code', 'so_id', 'doc_status', 'payment_status', 'line_items', 'total'],
  sales_orders: ['id', 'so_code', 'customer_id', 'status', 'line_items', 'total'],
  stock_moves: ['id', 'ref_type', 'ref_id', 'doc_type', 'doc_id', 'move_type', 'qty'],
  // rls.test.ts probes ticket_comments.user_email by name; pinned here so a
  // rename fails as drift instead of quietly emptying that probe. (BUG-061.)
  ticket_comments: ['id', 'ticket_id', 'user_email', 'comment_text', 'is_internal'],
}

export const skipReason =
  'set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to run the integration tier'
