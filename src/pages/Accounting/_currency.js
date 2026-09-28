// Exchange rates and document currencies (A-05b over 20260912): what the
// screens show and check before the round trip. The database enforces every
// rule; these name a bad field first.

/** The latest rate of each currency, by currency code. */
export function latestByCurrency(rows) {
  const out = {}
  for (const r of rows || []) {
    const cur = out[r.currency]
    if (!cur || r.rate_date > cur.rate_date) out[r.currency] = r
  }
  return out
}

/** null when the rate will be accepted, else { field, key }. */
export function validateRate({ currency, rateDate, rate, baseCurrency }) {
  if (!currency) return { field: 'currency', key: 'accounting.fxErrCurrency' }
  if (currency === baseCurrency) return { field: 'currency', key: 'accounting.fxErrBase' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rateDate || ''))) return { field: 'date', key: 'accounting.fxErrDate' }
  const r = Number(rate)
  if (String(rate ?? '').trim() === '' || !Number.isFinite(r) || r <= 0 || r > 1000000) return { field: 'rate', key: 'accounting.fxErrRate' }
  return null
}

/** Amount in the document's currency, with its code: "USD 1,234.50". */
export function fmtCurrency(value, currency) {
  const n = (Number(value) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency ? `${currency} ${n}` : n
}

/** A document's amount in the base currency, rounded to cents as the ledger posts it. */
export function toBase(value, rate) {
  return Math.round((Number(value) || 0) * (Number(rate) || 1) * 100) / 100
}

/** Which documents may change currency (the database also refuses the rest). */
export function currencyLock(docType, doc) {
  if (!doc) return 'none'
  if (docType === 'credit_note' && doc.source_invoice_id) return 'both'
  if (docType === 'sales_order' && doc.quotation_id) return 'currency'
  if (docType === 'invoice' && doc.so_id) return 'currency'
  return 'none'
}
