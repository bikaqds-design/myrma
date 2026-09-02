/**
 * Money formatting, in one place.
 *
 * Before this there were three answers to "what currency is this number in",
 * all live at the same time:
 *
 *   Dashboard, Reports, Control Panel home   '$' hardcoded
 *   every PDF                                'EGP'
 *   the RMA resolution form                  'USD'
 *
 * For an Egyptian company that meant the dashboard showed pipeline value with a
 * dollar sign on pound amounts — not a formatting nit, a number that says
 * something untrue about how much money is in the pipeline.
 *
 * Everything that renders money goes through here. The base currency comes from
 * installation config; a document in a foreign currency passes its own code.
 */

/** Fallback until config loads, and for tests. Matches the seeded default. */
export const FALLBACK_CURRENCY = 'EGP'

/**
 * Known symbols and minor-unit digits.
 *
 * Mirrors the `currencies` table so a render never has to wait on a query.
 * The table is the source of truth for which currencies are *available*; this
 * is only how to draw one. A code missing here still formats — it just prints
 * its ISO code instead of a symbol, which is correct rather than wrong.
 */
const CURRENCY_META = {
  EGP: { symbol: 'E£', decimals: 2 },
  USD: { symbol: '$', decimals: 2 },
  EUR: { symbol: '€', decimals: 2 },
  GBP: { symbol: '£', decimals: 2 },
  AED: { symbol: 'د.إ', decimals: 2 },
  SAR: { symbol: 'ر.س', decimals: 2 },
  CNY: { symbol: '¥', decimals: 2 },
  JPY: { symbol: '¥', decimals: 0 },
  TRY: { symbol: '₺', decimals: 2 },
}

export function currencyMeta(code) {
  return CURRENCY_META[code] || { symbol: code || FALLBACK_CURRENCY, decimals: 2 }
}

/**
 * A money value, written out in full: "E£ 1,234.56".
 *
 * Uses the currency's own decimal count, so JPY prints whole and EGP prints to
 * the piastre, rather than assuming two everywhere.
 */
export function formatMoney(value, code = FALLBACK_CURRENCY, { locale } = {}) {
  const { symbol, decimals } = currencyMeta(code)
  const n = Number(value)
  const safe = Number.isFinite(n) ? n : 0
  const body = safe.toLocaleString(locale || undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return `${symbol} ${body}`
}

/**
 * The short form for dashboard tiles: "E£ 1.2M".
 *
 * The three copies of this that existed each hardcoded '$' and each rounded
 * differently. Thresholds kept from the original so tiles read the same, minus
 * the wrong symbol.
 */
export function formatMoneyCompact(value, code = FALLBACK_CURRENCY) {
  const { symbol } = currencyMeta(code)
  const n = Number(value)
  const safe = Number.isFinite(n) ? n : 0
  const abs = Math.abs(safe)
  const sign = safe < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}${symbol} ${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}${symbol} ${(abs / 1_000).toFixed(1)}K`
  return `${sign}${symbol} ${abs.toFixed(0)}`
}

/**
 * Convert a document amount into the base currency.
 *
 * The rate belongs to the document and is stored on it, so this is deliberately
 * a pure function of (amount, rate) — there is no lookup and no "current rate".
 * A document converted last year must still convert the same way today.
 *
 * Rounded to the base currency's decimals at the point of conversion, because
 * this produces a stored value rather than an intermediate one.
 */
export function toBase(amount, rate, baseCode = FALLBACK_CURRENCY) {
  // Number(null) is 0 and Number('') is 0, both of which pass isFinite. Without
  // this guard a missing rate converts at zero and costs the whole document at
  // nothing — the silent-wrong-answer this function exists to refuse.
  if (amount === null || amount === undefined || amount === '') return null
  if (rate === null || rate === undefined || rate === '') return null
  const n = Number(amount)
  const r = Number(rate)
  if (!Number.isFinite(n) || !Number.isFinite(r)) return null
  const { decimals } = currencyMeta(baseCode)
  const factor = 10 ** decimals
  return Math.round(n * r * factor) / factor
}

/**
 * Split a total across lines in proportion to their values.
 *
 * Used to apportion freight, customs and clearance into unit cost. The point of
 * doing it here rather than inline is the remainder: dividing 100 across three
 * equal lines leaves a third of a piastre that has to land somewhere explicit,
 * or the apportioned parts do not sum back to the charge and stock is costed
 * slightly wrong forever.
 *
 * The largest line absorbs it, which is the smallest relative distortion.
 * Returns an array matching `weights`, summing exactly to `total`.
 */
export function apportion(total, weights, decimals = 4) {
  const amount = Number(total)
  const ws = weights.map((w) => (Number.isFinite(Number(w)) ? Math.max(Number(w), 0) : 0))
  const sum = ws.reduce((a, b) => a + b, 0)
  if (!Number.isFinite(amount) || amount === 0 || ws.length === 0) return ws.map(() => 0)

  const factor = 10 ** decimals
  // Even split when every weight is zero — a shipment of zero-value samples
  // still incurs freight, and refusing to apportion would lose it entirely.
  const shares = sum === 0
    ? ws.map(() => Math.round((amount / ws.length) * factor) / factor)
    : ws.map((w) => Math.round((amount * (w / sum)) * factor) / factor)

  const allocated = shares.reduce((a, b) => a + b, 0)
  const drift = Math.round((amount - allocated) * factor) / factor
  if (drift !== 0) {
    let biggest = 0
    for (let i = 1; i < ws.length; i++) if (ws[i] > ws[biggest]) biggest = i
    shares[biggest] = Math.round((shares[biggest] + drift) * factor) / factor
  }
  return shares
}
