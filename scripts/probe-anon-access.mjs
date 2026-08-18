#!/usr/bin/env node
/**
 * Probe every app table as an anonymous caller.
 *
 * Written after a pre-launch review found two tables accepting unauthenticated
 * writes — kb_articles with full CRUD, feeding a public page, and
 * notification_logs with delete against 192 rows. Neither had a policy in any
 * migration, and reading the SQL files would not have found them: the live
 * database contains policies this repo does not describe.
 *
 * So this asks the database instead of the repo.
 *
 * Reads use a plain SELECT. Writes post an empty object, which no NOT NULL
 * table can accept — so nothing is ever created, while the error code still
 * distinguishes an RLS refusal (42501) from a constraint (23502). A table that
 * reaches its constraints has let an anonymous caller through.
 *
 *   node scripts/probe-anon-access.mjs
 *
 * Needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the environment or in
 * .env.local. Exits non-zero if anything is readable or writable anonymously,
 * so it can gate a release.
 */
import { readFileSync, existsSync } from 'node:fs'

function env(name) {
  if (process.env[name]) return process.env[name]
  for (const f of ['.env.local', '.env']) {
    if (!existsSync(f)) continue
    const m = readFileSync(f, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  return null
}

const URL_ = env('VITE_SUPABASE_URL')
const KEY = env('VITE_SUPABASE_ANON_KEY')
if (!URL_ || !KEY) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  process.exit(2)
}

// Tables the app touches. Views are excluded: they carry no policies of their
// own and inherit from their base tables via security_invoker (20260778).
const TABLES = `activities announcements brands categories contacts
credit_note_applications credit_notes crm_invoices custom_field_definitions
custom_roles customer_notes customers deals inventory_units invoices kb_articles
leads manufacturer_batches notification_logs notification_queue
notification_settings notifications parts payment_applications payments
pipelines products purchase_orders quotations rma_config rma_tickets sales_orders
stock_moves subcategories ticket_activity ticket_comments ticket_parts
ticket_resolutions time_entries user_activity_log user_preferences user_roles
vendor_invoices vendor_payment_applications vendor_payments warehouse_stock
warehouses webhooks whatsapp_templates`.split(/\s+/).filter(Boolean)

// kb_articles is intentionally readable: /kb serves published articles to
// signed-out visitors. Rows returned here are expected, not a finding.
const READ_ALLOWED = new Set(['kb_articles'])

const H = { apikey: KEY, 'Content-Type': 'application/json' }
const readable = [], writable = [], ok = []

for (const t of TABLES) {
  const r = await fetch(`${URL_}/rest/v1/${t}?select=*&limit=1`, {
    headers: { ...H, Prefer: 'count=exact' },
  })
  let rows = 0
  if (r.ok) rows = parseInt((r.headers.get('content-range') || '').split('/')[1] || '0', 10) || 0
  if (rows > 0 && !READ_ALLOWED.has(t)) readable.push(`${t} (${rows} rows)`)

  const w = await fetch(`${URL_}/rest/v1/${t}`, { method: 'POST', headers: H, body: '{}' })
  const body = await w.text()
  const code = (body.match(/"code":"(\w+)"/) || [])[1] || String(w.status)
  if (code !== '42501' && w.status !== 404) writable.push(`${t} (${code})`)
  else ok.push(t)
}

console.log(`probed ${TABLES.length} tables as an anonymous caller\n`)
console.log(`refused writes: ${ok.length}`)
if (readable.length) {
  console.log(`\nREADABLE ANONYMOUSLY (${readable.length}):`)
  for (const x of readable) console.log('  -', x)
}
if (writable.length) {
  console.log(`\nWRITABLE ANONYMOUSLY (${writable.length}) — RLS did not refuse:`)
  for (const x of writable) console.log('  -', x)
}
if (!readable.length && !writable.length) console.log('\nno anonymous read or write access found')
process.exit(readable.length || writable.length ? 1 : 0)
