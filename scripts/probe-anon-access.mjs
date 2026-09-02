#!/usr/bin/env node
/**
 * Probe every app table as an anonymous caller.
 *
 * Written after a pre-launch review found tables accepting unauthenticated
 * writes — kb_articles with full CRUD feeding a public page, and
 * notification_logs, whose open policy no migration described under the name
 * the fix was dropping. Reading the SQL files would not have found either: the
 * live database contains policies this repo does not accurately describe.
 *
 * So this asks the database instead of the repo.
 *
 * ── On inferring a refusal from an error code ────────────────────────────────
 * The first version of this script posted `{}` and treated any code other than
 * 42501 as "RLS let us through". That is not sound. Postgres checks NOT NULL
 * during tuple formation and the RLS WITH CHECK afterwards, so a table that
 * would refuse the insert still answers 23502 when a required column is
 * missing. The two are indistinguishable from a single empty post.
 *
 * It reported notification_logs on that basis. The table did turn out to be
 * genuinely writable — but by luck, not because the inference held, and the
 * contradiction cost an hour to unpick. So the verdicts are now three:
 *
 *   REFUSED       42501 / 401     — decisive, the database said no
 *   WRITABLE      2xx             — decisive, a row was created
 *   INCONCLUSIVE  anything else   — a constraint answered before RLS did
 *
 * Default mode never creates a row, so INCONCLUSIVE is where it stops.
 * `--deep` resolves those by filling the NOT NULL columns the error names,
 * one round trip per column, until the answer is decisive. That can create
 * rows: every value it writes is the sentinel below, and any table it managed
 * to write to is printed with ready-to-paste cleanup SQL.
 *
 *   node scripts/probe-anon-access.mjs
 *   node scripts/probe-anon-access.mjs --deep
 *
 * Needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the environment or in
 * .env.local. Exits non-zero if anything is readable or writable anonymously,
 * or if anything is inconclusive, so it can gate a release.
 */
import { readFileSync, existsSync } from 'node:fs'

const DEEP = process.argv.includes('--deep')
const SENTINEL = 'zz-anon-probe'

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
warehouses webhooks whatsapp_templates
branding_settings email_settings email_templates notification_preferences`.split(/\s+/).filter(Boolean)

// kb_articles is intentionally readable: /kb serves published articles to
// signed-out visitors. Rows returned here are expected, not a finding.
const READ_ALLOWED = new Set(['kb_articles'])

const H = { apikey: KEY, 'Content-Type': 'application/json' }

const post = async (t, payload) => {
  const r = await fetch(`${URL_}/rest/v1/${t}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(payload),
  })
  const body = await r.text()
  let message = ''
  try { message = JSON.parse(body).message || '' } catch { message = body }
  const code = (body.match(/"code":"(\w+)"/) || [])[1] || String(r.status)
  return { status: r.status, code, message }
}

// A value the column will accept. Timestamps and uuids have to parse; anything
// else takes the sentinel so the row is identifiable if it lands.
const filler = (col, message) => {
  if (/invalid input syntax for type uuid/i.test(message)) return '00000000-0000-0000-0000-000000000000'
  if (/_at$|^date/.test(col)) return new Date(0).toISOString()
  return SENTINEL
}

const readable = [], writable = [], inconclusive = [], refused = []

for (const t of TABLES) {
  const r = await fetch(`${URL_}/rest/v1/${t}?select=*&limit=1`, {
    headers: { ...H, Prefer: 'count=exact' },
  })
  let rows = 0
  if (r.ok) rows = parseInt((r.headers.get('content-range') || '').split('/')[1] || '0', 10) || 0
  if (rows > 0 && !READ_ALLOWED.has(t)) readable.push(`${t} (${rows} rows)`)

  let payload = {}
  let res = await post(t, payload)
  // Deep mode: keep answering the constraint the database names until it runs
  // out of them and has to state an RLS verdict. Bounded so a table with an
  // unfillable constraint cannot spin.
  for (let i = 0; DEEP && i < 15; i++) {
    if (res.status < 300 || res.code === '42501' || res.status === 401 || res.status === 404) break
    const col = (res.message.match(/column "([^"]+)"/) || [])[1]
    if (!col || col in payload) break
    payload[col] = filler(col, res.message)
    res = await post(t, payload)
  }

  if (res.status < 300) writable.push({ t, code: 'row created', payload })
  else if (res.code === '42501' || res.status === 401 || res.status === 404) refused.push(t)
  else inconclusive.push(`${t} (${res.code}) ${res.message.slice(0, 70)}`)
}

console.log(`probed ${TABLES.length} tables as an anonymous caller${DEEP ? ' (--deep)' : ''}\n`)
console.log(`refused writes: ${refused.length}`)

if (readable.length) {
  console.log(`\nREADABLE ANONYMOUSLY (${readable.length}):`)
  for (const x of readable) console.log('  -', x)
}
if (writable.length) {
  console.log(`\nWRITABLE ANONYMOUSLY (${writable.length}) — a row was created:`)
  for (const x of writable) console.log(`  - ${x.t}  ${JSON.stringify(x.payload)}`)
  console.log('\n  Clean up the rows this probe created:')
  for (const x of writable) {
    const where = Object.entries(x.payload)
      .map(([k, v]) => `${k} = ${typeof v === 'string' ? `'${v}'` : v}`)
      .join(' AND ')
    console.log(`    DELETE FROM public.${x.t} WHERE ${where};`)
  }
}
if (inconclusive.length) {
  console.log(`\nINCONCLUSIVE (${inconclusive.length}) — a constraint answered before RLS did:`)
  for (const x of inconclusive) console.log('  -', x)
  if (!DEEP) console.log('\n  Re-run with --deep to resolve these. It may create sentinel rows.')
}
if (!readable.length && !writable.length && !inconclusive.length) {
  console.log('\nno anonymous read or write access found')
}
process.exit(readable.length || writable.length || inconclusive.length ? 1 : 0)
