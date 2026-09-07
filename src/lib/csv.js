/**
 * CSV cell encoding, in one place. (Audit finding BUG-044.)
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * Two separate `downloadCSV` implementations — `src/pages/Inventory/_shared.jsx`
 * and `src/pages/Reports.jsx` — escaped quotes and nothing else:
 *
 *   const s = String(v ?? '').replace(/"/g, '""')
 *   return s.includes(',') || s.includes('\n') || s.includes('"') ? `"${s}"` : s
 *
 * That is correct CSV quoting and no defence at all against formula injection.
 * A spreadsheet treats a cell beginning `=`, `+`, `-` or `@` as a formula, so a
 * customer named `=HYPERLINK("http://evil","click")` — or the classic
 * `=cmd|' /C calc'!A0` — executes when a manager opens the export.
 *
 * The values are not ours. Lead and customer names arrive from sales reps, bulk
 * imports, and the public RMA tracker, so the attacker does not need an account.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * Prefix a leading formula trigger with a single quote, which spreadsheets
 * consume as "treat the rest as text". Tab and carriage return are included
 * because Excel strips leading whitespace before deciding, so "\t=1+1" is still
 * a formula.
 *
 * Numbers are deliberately exempt. Blanket-prefixing anything starting `-`
 * would turn every negative amount in a financial export into the text
 * `'-1234.50`, which breaks the sums the export exists for. A value that parses
 * as a plain number cannot carry a formula, so it is left alone.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

/** True when a value would be interpreted as a formula by a spreadsheet. */
export function isFormulaLike(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return false
  const s = String(value ?? '')
  if (s === '') return false
  if (PLAIN_NUMBER.test(s)) return false
  return FORMULA_TRIGGER.test(s)
}

/**
 * One CSV cell: formula-neutralised, then quoted per RFC 4180.
 * Always use this rather than escaping inline.
 */
export function csvCell(value) {
  let s = String(value ?? '')
  if (isFormulaLike(value)) s = `'${s}`
  s = s.replace(/"/g, '""')
  return /[",\n\r]/.test(s) ? `"${s}"` : s
}

/** A full CSV document from a header row and rows of already-ordered values. */
export function toCsv(headers, rows) {
  return [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n')
}

/**
 * Trigger a browser download of `csvText`.
 * The BOM keeps Excel from mis-reading UTF-8 (Arabic names in particular).
 */
export function downloadCsvText(csvText, filename) {
  const blob = new Blob(['﻿' + csvText], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
