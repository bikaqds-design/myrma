/**
 * fullTableReadGuard.test.js — BUG-066, phase 7: keep whole-table reads out.
 *
 * The Supabase Data API returns at most 1 000 rows per request and says
 * nothing when it truncates. Screens that loaded a whole table and filtered,
 * counted or summed it in the browser therefore reported part of the data as
 * all of it — the Dashboard, Reports, every list page. Phases 1–6 moved that
 * work into the database. These checks fail the build if it creeps back:
 *
 *  1. no page, component, hook or lib calls a helper that reads a whole table;
 *  2. those helpers no longer exist to be called;
 *  3. nothing asks for more rows than the API will ever return;
 *  4. every read in src/api/db is bounded — a page (range), one row, a head
 *     count, chunked ids, or fetchAllRows walking past the cap — unless it is
 *     on the short, explained allowlist below.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../api/client.js', () => ({ supabase: { from: () => ({}), rpc: () => ({}), channel: () => ({}) } }))

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== 'test') out.push(...walk(path))
    } else if (/\.(jsx?|tsx?)$/.test(entry)) out.push(path)
  }
  return out
}

const baseName = (f) => f.split(/[\\/]/).pop()

// Read every source file once, when the module loads. Reading them again inside
// each test case made single cases take up to 2.7 s on a busy Windows machine,
// close to Vitest's 5 s per-test timeout; the reads are not what is under test.
const sources = new Map(walk('src').map((f) => [f, readFileSync(f, 'utf8')]))
const uiFiles = [...sources.keys()].filter((f) => !/^src[\\/]api[\\/]/.test(f))

describe('screens never read a whole table', () => {
  const banned = [
    [/db\.customers\.list\(/, 'db.customers.list()'],
    [/db\.rmaTickets\.list\(/, 'db.rmaTickets.list()'],
    [/db\.products\.list\(/, 'db.products.list()'],
    [/db\.deals\.list\(/, 'db.deals.list()'],
    [/db\.leads\.list\(/, 'db.leads.list()'],
    [/db\.timeEntries\.listAll\(/, 'db.timeEntries.listAll()'],
    [/db\.purchaseDocuments\.listAll\(/, 'db.purchaseDocuments.listAll()'],
    [/db\.salesDocuments\.listAll\(/, 'db.salesDocuments.listAll()'],
    [/db\.activities\.listOverdue\(\)/, 'db.activities.listOverdue()'],
    [/db\.margin\.byInvoice\(\)/, 'db.margin.byInvoice()'],
  ]

  it.each(banned)('no caller of %s', (pattern, name) => {
    const hits = uiFiles.filter((f) => pattern.test(sources.get(f)))
    expect(hits, `${name} reads a whole table (capped at 1 000 rows); use a paged or summarised read`).toEqual([])
  })
})

describe('the whole-table helpers are gone', async () => {
  const { db } = await import('../api/db/index.ts')

  it.each([
    ['customers', 'list'],
    ['customers', 'listPaged'],
    ['products', 'list'],
    ['products', 'listPaged'],
    ['products', 'getRelatedTickets'],
    ['rmaTickets', 'list'],
    ['rmaTickets', 'listPaged'],
    ['deals', 'list'],
    ['deals', 'listForCustomer'],
    ['leads', 'list'],
    ['timeEntries', 'listAll'],
    ['purchaseDocuments', 'listAll'],
    ['activities', 'listOverdue'],
    ['crmInvoices', 'listAll'],
    ['margin', 'byInvoice'],
  ])('db.%s.%s is not defined', (module, fn) => {
    expect(db[module]?.[fn]).toBeUndefined()
  })
})

describe('nothing asks for more than the API returns', () => {
  it('no .limit() above 1 000 anywhere in src', () => {
    // WhatsApp is on hold by the owner's instruction; its log export is revisited then.
    const allowed = new Set(['whatsappNotifications.ts'])
    const hits = []
    for (const [f, text] of sources) {
      if (allowed.has(baseName(f))) continue
      const code = text
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\*|\/\/)/.test(line))
        .join('\n')
      for (const m of code.matchAll(/\.limit\(\s*(\d[\d_]*)\s*\)/g)) {
        if (Number(m[1].replace(/_/g, '')) > 1000) hits.push(`${f}: .limit(${m[1]})`)
      }
    }
    expect(hits).toEqual([])
  })
})

describe('every read in src/api/db is bounded', () => {
  // Reads that are bounded some other way, each with the reason.
  const ALLOWED = {
    // Chunked by 25 phone keys in a hand-written loop.
    'customers.ts:findByMobileKeys': true,
    // One row per folder on a path — a handful, never a table.
    'knowledgeLists.ts:foldersOnPath': true,
    // WhatsApp is on hold by the owner's instruction; its reads are revisited
    // when that work resumes.
    'whatsappNotifications.ts:list': true,
    'whatsappNotifications.ts:getByEvent': true,
    'whatsappNotifications.ts:stats': true,
    'whatsappNotifications.ts:getAll': true,
  }
  const BOUNDED = /\.range\(|\.single\(\)|\.maybeSingle\(\)|head: true|fetchAllRows|fetchPage|chunksOf|\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.limit\(/

  it('has no unbounded select outside the allowlist', () => {
    const dir = 'src/api/db'
    const unbounded = []
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n')
      const starts = [...src.matchAll(/\n {2}async (\w+)\s*\(/g)].map((m) => [m.index, m[1]])
      starts.forEach(([at, name], k) => {
        const body = src.slice(at, k + 1 < starts.length ? starts[k + 1][0] : src.length)
        if (!/\.select\(/.test(body) || BOUNDED.test(body)) return
        if (!ALLOWED[`${file}:${name}`]) unbounded.push(`${file}:${name}`)
      })
    }
    expect(unbounded, 'these reads stop silently at 1 000 rows').toEqual([])
  })
})
