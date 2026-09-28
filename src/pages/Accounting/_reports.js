// Financial reports (A-08a over 20260916): grouping and totals for the profit
// and loss and the balance sheet. The database does the arithmetic per
// account; these add accounts up in cents so a column of 0.1s sums exactly.

import { accountName } from './_ledger'

const cents = (n) => Math.round((Number(n) || 0) * 100)
const units = (c) => c / 100

/**
 * Rows grouped under their header account, in the order they came (the
 * database orders them by header then code). Accounts with no header share one
 * group. Each group carries its total.
 */
export function groupByHeader(rows, lang) {
  const groups = []
  const byKey = new Map()
  for (const r of rows || []) {
    const key = r.parent_id || '—'
    let g = byKey.get(key)
    if (!g) {
      g = {
        key,
        code: r.parent_code || null,
        label: r.parent_id ? accountName({ name: r.parent_name, name_ar: r.parent_name_ar }, lang) : null,
        rows: [],
        cents: 0,
      }
      byKey.set(key, g)
      groups.push(g)
    }
    g.rows.push(r)
    g.cents += cents(r.amount)
  }
  return groups.map(({ cents: c, ...g }) => ({ ...g, total: units(c) }))
}

/** Income, expenses and net profit (income − expenses) of a P&L. */
export function plSummary(rows) {
  let income = 0
  let expense = 0
  for (const r of rows || []) {
    if (r.account_type === 'income') income += cents(r.amount)
    else if (r.account_type === 'expense') expense += cents(r.amount)
  }
  return { income: units(income), expense: units(expense), net: units(income - expense) }
}

/** Section totals of a balance sheet, and whether assets = liabilities + equity. */
export function bsSummary(rows) {
  const c = { asset: 0, liability: 0, equity: 0 }
  for (const r of rows || []) if (r.section in c) c[r.section] += cents(r.amount)
  return {
    assets: units(c.asset),
    liabilities: units(c.liability),
    equity: units(c.equity),
    liabilitiesAndEquity: units(c.liability + c.equity),
    balanced: c.asset === c.liability + c.equity,
  }
}

/** The label of a balance-sheet line: an account's name, or the earnings lines' key. */
export function bsLineLabel(row, lang, t) {
  if (row.kind === 'account') return accountName(row, lang)
  return t(`accounting.rep_${row.kind}`)
}

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The report default: the calendar year to date, in the viewer's own day. */
export function yearToDate(today = new Date()) {
  return { from: `${today.getFullYear()}-01-01`, to: iso(today) }
}
export function todayIso(today = new Date()) {
  return iso(today)
}

/** null when the period will be accepted, else the message key. */
export function validatePeriod(from, to) {
  if (!from || !to) return 'accounting.repErrPeriod'
  return from > to ? 'accounting.repErrPeriod' : null
}
