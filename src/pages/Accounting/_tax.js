// Tax codes and the VAT return (A-04b over 20260911): what the screens offer
// and how they read the return. The database enforces every rule; these only
// decide what to show and name a bad field before the round trip.

export const TAX_KINDS = ['standard', 'reduced', 'zero', 'exempt', 'out_of_scope']
const ZERO_KINDS = new Set(['zero', 'exempt', 'out_of_scope'])

/** A rate as people write it: 14, 12.5. */
export const fmtRate = (rate) => String(Number(rate) || 0)

/** The codes a line may pick: the active ones, plus the line's own if it is no longer active. */
export function codeOptions(codes, current) {
  const list = (codes || []).filter((c) => c.is_active || c.code === current)
  return [...list].sort((a, b) => Number(b.rate) - Number(a.rate) || a.code.localeCompare(b.code))
}

/** The line fields a picked code sets: the code and its rate (what the database will store). */
export function applyTaxCode(codes, code) {
  if (!code) return { tax_code: null }
  const c = (codes || []).find((x) => x.code === code)
  return c ? { tax_code: c.code, tax_pct: Number(c.rate) } : { tax_code: code }
}

/** The code's name in the viewer's language. */
export const taxCodeName = (c, lang) => (lang === 'ar' && c?.name_ar ? c.name_ar : c?.name || '')

/** null when the new code will be accepted, else { field, key }. */
export function validateTaxCode({ code, name, kind, rate }) {
  if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(String(code || '').trim().toUpperCase())) return { field: 'code', key: 'accounting.taxErrCode' }
  if (!String(name || '').trim()) return { field: 'name', key: 'accounting.taxErrName' }
  if (!TAX_KINDS.includes(kind)) return { field: 'kind', key: 'accounting.taxErrKind' }
  const r = Number(rate)
  if (String(rate).trim() === '' || !Number.isFinite(r) || r < 0 || r > 100) return { field: 'rate', key: 'accounting.taxErrRate' }
  if (ZERO_KINDS.has(kind) && r !== 0) return { field: 'rate', key: 'accounting.taxErrZeroRate' }
  if (!ZERO_KINDS.has(kind) && r === 0) return { field: 'rate', key: 'accounting.taxErrPositiveRate' }
  return null
}

const cents = (n) => Math.round((Number(n) || 0) * 100)

/**
 * The return's totals per side, and whether each ties to the ledger's VAT
 * accounts (to the cent). `ledger` may be missing while it loads.
 */
export function vatSummary(rows, ledger) {
  const side = (s) => (rows || []).filter((r) => r.side === s)
  const sum = (list, k) => list.reduce((acc, r) => acc + cents(r[k]), 0) / 100
  const out = side('output')
  const inp = side('input')
  const output = { net: sum(out, 'net_amount'), tax: sum(out, 'tax_amount') }
  const input = { net: sum(inp, 'net_amount'), tax: sum(inp, 'tax_amount') }
  const payable = (cents(output.tax) - cents(input.tax)) / 100
  const tie = ledger
    ? {
        output: cents(ledger.output_tax) === cents(output.tax),
        input: cents(ledger.input_tax) === cents(input.tax),
        outputDiff: (cents(ledger.output_tax) - cents(output.tax)) / 100,
        inputDiff: (cents(ledger.input_tax) - cents(input.tax)) / 100,
      }
    : null
  return { output, input, payable, tie }
}

/** The first and last day of the month before `today`, as YYYY-MM-DD. */
export function lastMonth(today = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const first = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const last = new Date(today.getFullYear(), today.getMonth(), 0)
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return { from: iso(first), to: iso(last) }
}
