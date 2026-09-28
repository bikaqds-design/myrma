// Pure helpers for the ledger screens (A-01c). No React, so they are tested
// directly.

/** Where a journal entry's source document lives in the app, or null if it has no page of its own. */
export function sourceLink(entry) {
  if (!entry?.source_id) return null
  switch (entry.source_type) {
    case 'crm_invoice':
      return `/sales/invoice/${entry.source_id}`
    case 'credit_note':
      return `/sales/credit_note/${entry.source_id}`
    case 'vendor_invoice':
      return `/purchasing/vendor_invoice/${entry.source_id}`
    default:
      return null // payments, refunds, deliveries, returns, receipts: shown by code only
  }
}

/** The translation key naming a source type (unknown types show as they are). */
export const SOURCE_TYPE_KEYS = {
  crm_invoice: 'accounting.glSrc_crm_invoice',
  credit_note: 'accounting.glSrc_credit_note',
  payment: 'accounting.glSrc_payment',
  customer_refund: 'accounting.glSrc_customer_refund',
  delivery: 'accounting.glSrc_delivery',
  customer_return: 'accounting.glSrc_customer_return',
  goods_receipt: 'accounting.glSrc_goods_receipt',
  vendor_invoice: 'accounting.glSrc_vendor_invoice',
  vendor_payment: 'accounting.glSrc_vendor_payment',
}

/** An account's name in the viewer's language (Arabic when there is one). */
export function accountName(account, lang) {
  if (!account) return '—'
  return lang === 'ar' && account.name_ar ? account.name_ar : account.name
}

/** Sum of an entry's debits (= its credits, since every entry balances). */
export function entryTotal(entry) {
  return (entry?.journal_lines || []).reduce((s, l) => s + (Number(l.debit) || 0), 0)
}

/**
 * Totals of a trial balance, in cents to avoid floating-point drift. `balanced`
 * is true when debits equal credits — the ledger enforces it per entry, so a
 * false here means something is wrong with the data read, not with the books.
 */
export function trialBalanceTotals(rows) {
  let dr = 0
  let cr = 0
  for (const r of rows || []) {
    dr += Math.round((Number(r.debit) || 0) * 100)
    cr += Math.round((Number(r.credit) || 0) * 100)
  }
  return { debit: dr / 100, credit: cr / 100, balanced: dr === cr }
}

/**
 * The chart as a list in code order with each account's depth, headers first
 * under their parent, so it reads as a tree without nesting components.
 */
export function chartRows(accounts) {
  const byParent = new Map()
  for (const a of accounts || []) {
    const k = a.parent_id || null
    if (!byParent.has(k)) byParent.set(k, [])
    byParent.get(k).push(a)
  }
  for (const list of byParent.values()) list.sort((x, y) => x.code.localeCompare(y.code))
  const out = []
  const seen = new Set()
  const walk = (parent, depth) => {
    for (const a of byParent.get(parent) || []) {
      if (seen.has(a.id)) continue
      seen.add(a.id)
      out.push({ ...a, depth })
      walk(a.id, depth + 1)
    }
  }
  walk(null, 0)
  // an account whose parent is missing from the list still shows, at the top level
  for (const a of accounts || []) if (!seen.has(a.id)) out.push({ ...a, depth: 0 })
  return out
}

/** Validate a new account before the round trip; returns a translation key or null. */
export function validateAccount({ code, name, account_type }) {
  if (!code || !String(code).trim()) return 'accounting.glErrCode'
  if (String(code).trim() !== String(code)) return 'accounting.glErrCodeSpaces'
  if (!name || !String(name).trim()) return 'accounting.glErrName'
  if (!['asset', 'liability', 'equity', 'income', 'expense'].includes(account_type)) return 'accounting.glErrType'
  return null
}

export const POSTING_ROLES = [
  'accounts_receivable',
  'accounts_payable',
  'inventory',
  'goods_received_not_invoiced',
  'accrued_landed_costs',
  'sales_revenue',
  'sales_tax_payable',
  'purchase_tax_receivable',
  'cost_of_goods_sold',
  'purchase_price_variance',
  'inventory_adjustment',
  'cash',
  'bank',
  'customer_deposits',
  'retained_earnings',
  'opening_balance_equity',
  'rounding',
  'fx_gain',
  'fx_loss',
]

// ── A-02: country templates and importing a chart ────────────────────────────

/** The countries with a chart template, in the order they are offered. */
export const CHART_COUNTRIES = ['EG', 'AE', 'SA']

/** At most this many accounts per import (rma_import_chart_accounts refuses more). */
export const CHART_IMPORT_MAX = 2000

// Header names a file may use for each column (lower case, spaces as underscores).
const CHART_COLUMNS = {
  code: ['code', 'account_code', 'account'],
  name: ['name', 'account_name'],
  name_ar: ['name_ar', 'arabic_name', 'name_arabic'],
  type: ['type', 'account_type'],
  parent_code: ['parent_code', 'parent'],
  header: ['header', 'is_header'],
}

// One CSV line into fields: quoted fields may hold commas and doubled quotes.
function parseCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        quoted = !quoted
      }
    } else if (ch === ',' && !quoted) {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

/**
 * A chart file (CSV with a header row) into rows for rma_import_chart_accounts.
 * Returns { rows } or { error } (a translation key). Only the file's shape is
 * checked here; each row's content is judged by the database, row by row.
 */
export function parseChartCsv(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
  if (lines.length < 2) return { error: 'accounting.glImportErrEmpty' }
  const head = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'))
  const col = {}
  for (const [key, names] of Object.entries(CHART_COLUMNS)) {
    const i = head.findIndex((h) => names.includes(h))
    if (i >= 0) col[key] = i
  }
  if (col.code === undefined || col.name === undefined) return { error: 'accounting.glImportErrColumns' }
  if (lines.length - 1 > CHART_IMPORT_MAX) return { error: 'accounting.glImportErrTooMany' }
  const rows = lines.slice(1).map((line) => {
    const v = parseCsvLine(line)
    const row = {}
    for (const [key, i] of Object.entries(col)) if (v[i] !== undefined && v[i] !== '') row[key] = v[i]
    if (row.code === undefined) row.code = ''
    if (row.name === undefined) row.name = ''
    return row
  })
  return { rows }
}

/** How an import went: counts per outcome and the rows that failed. */
export function summarizeImport(results) {
  const out = { created: 0, updated: 0, errors: [] }
  for (const r of results || []) {
    if (r.status === 'created') out.created++
    else if (r.status === 'updated') out.updated++
    else out.errors.push(r)
  }
  return out
}
