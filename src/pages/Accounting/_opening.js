// Opening balances (B-03 over 20260921): turning a CSV into the rows the
// database checks. Amounts and dates are normalised when they can be read;
// anything else goes through as typed, so the database names the row.
import { parseAmount, parseDate } from './_bank'

export const OPENING_SECTIONS = ['accounts', 'receivables', 'payables', 'stock']

// field → the header names it answers to (lower case, letters and digits only)
export const SECTION_FIELDS = {
  accounts: {
    account_code: ['accountcode', 'account', 'code', 'accountno', 'accountnumber'],
    debit: ['debit', 'dr'],
    credit: ['credit', 'cr'],
    memo: ['memo', 'note', 'notes', 'description', 'accountname', 'name'],
  },
  receivables: {
    party: ['customer', 'customercode', 'customername', 'party', 'client'],
    doc_no: ['invoice', 'invoiceno', 'invoicenumber', 'number', 'docno', 'document', 'reference', 'ref'],
    doc_date: ['date', 'invoicedate', 'docdate'],
    due_date: ['duedate', 'due'],
    currency: ['currency', 'ccy', 'cur'],
    exchange_rate: ['rate', 'exchangerate', 'fxrate'],
    amount: ['amount', 'balance', 'openamount', 'outstanding', 'amountdue', 'total'],
    notes: ['notes', 'note', 'memo'],
  },
  payables: {
    party: ['supplier', 'vendor', 'suppliername', 'vendorname', 'party'],
    doc_no: ['bill', 'billno', 'invoice', 'invoiceno', 'invoicenumber', 'number', 'docno', 'reference', 'ref'],
    doc_date: ['date', 'billdate', 'invoicedate', 'docdate'],
    due_date: ['duedate', 'due'],
    currency: ['currency', 'ccy', 'cur'],
    exchange_rate: ['rate', 'exchangerate', 'fxrate'],
    amount: ['amount', 'balance', 'openamount', 'outstanding', 'amountdue', 'total'],
    notes: ['notes', 'note', 'memo'],
  },
  stock: {
    sku: ['sku', 'itemcode', 'productcode', 'code', 'item'],
    warehouse: ['warehouse', 'location', 'store', 'warehousecode'],
    qty: ['qty', 'quantity', 'onhand', 'count'],
    unit_cost: ['unitcost', 'cost', 'costprice', 'averagecost'],
    serials: ['serials', 'serial', 'serialnumbers', 'serialnumber', 'sn'],
    notes: ['notes', 'note', 'memo'],
  },
}

const MONEY = new Set(['debit', 'credit', 'amount'])
const DATES = new Set(['doc_date', 'due_date'])

const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Which column holds each field, from the header names (null = none). */
export function guessOpeningMapping(section, headers) {
  const fields = SECTION_FIELDS[section] || {}
  const used = new Set()
  const out = {}
  for (const [field, names] of Object.entries(fields)) {
    let idx = null
    for (const name of names) {
      const i = headers.findIndex((h, j) => !used.has(j) && norm(h) === name)
      if (i >= 0) { idx = i; break }
    }
    if (idx != null) used.add(idx)
    out[field] = idx
  }
  return out
}

/** Serial numbers written in one cell: separated by ; | , or new lines. */
export function splitSerials(cell) {
  return String(cell ?? '').split(/[;|,\n]+/).map((s) => s.trim()).filter(Boolean)
}

/**
 * The CSV's data rows as the objects set_opening_balance_rows expects.
 * Blank rows are dropped; `sourceRow` keeps each row's number in the file
 * (1 = the first data row) so the database's row numbers can be mapped back.
 */
export function mapOpeningRows(section, rows, mapping, dateFormat = 'ymd') {
  const out = []
  ;(rows || []).forEach((r, i) => {
    if (!r || r.every((c) => String(c ?? '').trim() === '')) return
    const obj = {}
    for (const [field, idx] of Object.entries(mapping || {})) {
      if (idx == null) continue
      const raw = String(r[idx] ?? '').trim()
      if (field === 'serials') { obj.serials = splitSerials(raw); continue }
      if (raw === '') continue
      if (MONEY.has(field)) {
        obj[field] = parseAmount(raw) ?? raw
      } else if (field === 'unit_cost' || field === 'exchange_rate') {
        // more than two decimals are allowed here: only drop thousands separators
        const plain = raw.replace(/[,\s]/g, '')
        obj[field] = /^\d+(\.\d+)?$/.test(plain) ? plain : raw
      } else if (DATES.has(field)) {
        obj[field] = parseDate(raw, dateFormat) || raw
      } else if (field === 'qty') {
        const n = raw.replace(/[,\s]/g, '')
        obj.qty = n
      } else {
        obj[field] = raw
      }
    }
    out.push({ row: obj, sourceRow: i + 1 })
  })
  return out
}

/** The fields a section cannot do without (for the mapping check). */
export const REQUIRED_FIELDS = {
  accounts: ['account_code'],
  receivables: ['party', 'doc_no', 'doc_date', 'amount'],
  payables: ['party', 'doc_no', 'doc_date', 'amount'],
  stock: ['sku', 'warehouse', 'qty'],
}

export function missingFields(section, mapping) {
  const req = REQUIRED_FIELDS[section] || []
  const miss = req.filter((f) => mapping?.[f] == null)
  if (section === 'accounts' && mapping?.debit == null && mapping?.credit == null) miss.push('debit')
  return miss
}

/** Opening balance equity's balance is 0 (to the cent). */
export const equityBalances = (summary) => Math.round(Number(summary?.equity_difference || 0) * 100) === 0
