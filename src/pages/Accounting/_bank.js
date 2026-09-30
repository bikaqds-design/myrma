// Bank reconciliation (A-07 over 20260920): reading a bank's CSV export into
// statement lines. The database checks every line again (YYYY-MM-DD, a
// non-zero amount with at most two decimals); these name a bad row first.

/** One CSV line into fields, honouring quotes ("a, b" is one field; "" is a quote). */
export function splitCsvLine(line, delim = ',') {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === delim) { out.push(cur.trim()); cur = '' }
    else cur += ch
  }
  out.push(cur.trim())
  return out
}

/** A CSV file into its header row and data rows; the delimiter is guessed (, ; or tab). */
export function parseCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return { headers: [], rows: [] }
  const first = lines[0]
  const count = (c) => first.split(c).length - 1
  const delim = [['\t', count('\t')], [';', count(';')], [',', count(',')]].sort((a, b) => b[1] - a[1])[0][0]
  return { headers: splitCsvLine(first, delim), rows: lines.slice(1).map((l) => splitCsvLine(l, delim)) }
}

/**
 * An amount as a bank writes it into '1234.50' (or '-1234.50'), or null.
 * Handles thousands separators, a decimal comma, a currency code, (12.00) and a
 * trailing minus.
 */
export function parseAmount(raw) {
  let s = String(raw ?? '').trim()
  if (s === '') return null
  s = s.replace(/[^\d.,()-]/g, '')
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1) }
  if (/^-/.test(s)) { neg = !neg; s = s.slice(1) }
  s = s.replace(/[^\d.,]/g, '')
  if (s === '') return null
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  if (lastDot >= 0 && lastComma >= 0) {
    // the later of the two is the decimal mark
    s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.')
  } else if (lastComma >= 0) {
    // "12,50" is a decimal comma; "1,250" a thousands separator
    s = /,\d{1,2}$/.test(s) && s.split(',').length === 2 ? s.replace(',', '.') : s.replace(/,/g, '')
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Math.round(Number(s) * 100)
  if (!Number.isFinite(n)) return null
  const v = (neg ? -n : n) / 100
  return v.toFixed(2)
}

/** A date as a bank writes it into YYYY-MM-DD, or null. format: 'ymd' | 'dmy' | 'mdy'. */
export function parseDate(raw, format = 'ymd') {
  const parts = String(raw ?? '').trim().split(/[-/.\s]+/).filter(Boolean)
  if (parts.length < 3) return null
  let y; let m; let d
  if (format === 'dmy') [d, m, y] = parts
  else if (format === 'mdy') [m, d, y] = parts
  else [y, m, d] = parts
  if (!/^\d{1,4}$/.test(y) || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return null
  let year = Number(y)
  if (y.length === 2) year += 2000
  const date = new Date(Date.UTC(year, Number(m) - 1, Number(d)))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** A first guess at which column is which, from the header names. */
export function guessMapping(headers) {
  const find = (re) => { const i = headers.findIndex((h) => re.test(String(h))); return i >= 0 ? i : null }
  const amount = find(/^amount$|amount/i)
  const debit = find(/debit|withdraw|money out|paid out/i)
  const credit = find(/credit|deposit|money in|paid in/i)
  return {
    date: find(/date/i),
    description: find(/desc|narr|detail|particular|memo|text/i),
    reference: find(/ref|cheque|check no|transaction id/i),
    amount: amount != null && amount !== debit && amount !== credit ? amount : null,
    debit: amount == null ? debit : null,
    credit: amount == null ? credit : null,
  }
}

/**
 * The CSV's rows as statement lines: money in positive, money out negative.
 * With one amount column its sign is used; with debit / credit columns,
 * credit (money in) − debit (money out). Blank rows are skipped; rows that
 * cannot be read are reported by row number (1 = the first data row).
 */
export function mapStatementRows(rows, mapping, format) {
  const lines = []
  const errors = []
  ;(rows || []).forEach((r, i) => {
    const cell = (k) => (mapping[k] == null ? '' : r[mapping[k]] ?? '')
    const blank = r.every((c) => String(c).trim() === '')
    if (blank) return
    const date = parseDate(cell('date'), format)
    let amount
    if (mapping.amount != null) {
      amount = parseAmount(cell('amount'))
    } else {
      const inAmt = parseAmount(cell('credit'))
      const outAmt = parseAmount(cell('debit'))
      amount = inAmt == null && outAmt == null ? null
        : ((Math.round(Number(inAmt || 0) * 100) - Math.abs(Math.round(Number(outAmt || 0) * 100))) / 100).toFixed(2)
    }
    if (!date) { errors.push({ row: i + 1, key: 'accounting.bankErrDate' }); return }
    if (amount == null || Number(amount) === 0) { errors.push({ row: i + 1, key: 'accounting.bankErrAmount' }); return }
    lines.push({
      txn_date: date,
      amount,
      description: String(cell('description')).trim() || null,
      reference: String(cell('reference')).trim() || null,
    })
  })
  return { lines, errors }
}

/** The lines' total, in cents, as a 2-decimal number. */
export function linesTotal(lines) {
  return (lines || []).reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0) / 100
}

/** The latest date among the lines (the statement's date by default). */
export function lastDate(lines) {
  return (lines || []).reduce((d, l) => (l.txn_date > d ? l.txn_date : d), '')
}
