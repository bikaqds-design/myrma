/**
 * purchasingCurrency.test.js — the arithmetic that must not mix currencies.
 *
 * Purchasing screens used to add `total` across documents and label the result
 * EGP. Once a single import exists that number is wrong by roughly the exchange
 * rate: a $10,000 shipment landed in the spend total as though it were
 * E£10,000. These tests pin the two rules that stop it — totals are summed in
 * base currency, and a currency code is shown only where it is not the base
 * one — plus the settlement rule the database enforces in 20260793.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { docTotalBase, hasMissingRate, isForeignDoc } from '../pages/Purchasing/_shared.js'

describe('docTotalBase', () => {
  it('uses the generated base column when the database supplies it', () => {
    // 2,000 USD at 48.5 was stored as 97,000 by the database, not recomputed
    // here — a client that recalculates can disagree with what was posted.
    expect(docTotalBase({ total: 2000, exchange_rate: 48.5, total_base: 97_000 })).toBe(97_000)
  })

  it('prefers total_base even when it disagrees with total x rate', () => {
    // The stored figure is the one the cost of stock was derived from. If they
    // ever disagree, the database is right and the screen must not quietly
    // substitute its own arithmetic.
    expect(docTotalBase({ total: 100, exchange_rate: 2, total_base: 250 })).toBe(250)
  })

  it('falls back to total x rate against a database without the column', () => {
    expect(docTotalBase({ total: 100, exchange_rate: 48.5 })).toBe(4850)
  })

  it('treats a document with no rate as base currency', () => {
    expect(docTotalBase({ total: 1500 })).toBe(1500)
  })

  it('is zero rather than NaN for a document with no total', () => {
    expect(docTotalBase({})).toBe(0)
    expect(docTotalBase(null)).toBe(0)
    expect(docTotalBase({ total: null, exchange_rate: null })).toBe(0)
  })

  it('does not treat total_base of 0 as missing', () => {
    // `??` and not `||`: a genuinely zero document must not fall through to the
    // multiplication branch, which is the classic version of this bug.
    expect(docTotalBase({ total: 500, exchange_rate: 48.5, total_base: 0 })).toBe(0)
  })

  // The failure this whole helper exists to prevent, stated as arithmetic.
  it('sums a mixed-currency set to the base-currency figure', () => {
    const docs = [
      { total: 5000, exchange_rate: 1, total_base: 5000 }, // local
      { total: 2000, exchange_rate: 48.5, total_base: 97_000 }, // imported
    ]
    expect(docs.reduce((s, d) => s + docTotalBase(d), 0)).toBe(102_000)
    // What the screens did before: 7,000, reported as EGP.
    expect(docs.reduce((s, d) => s + d.total, 0)).toBe(7000)
  })
})

describe('isForeignDoc', () => {
  it('is false for a document in the base currency', () => {
    expect(isForeignDoc({ currency: 'EGP' }, 'EGP')).toBe(false)
  })
  it('is true for one that is not', () => {
    expect(isForeignDoc({ currency: 'USD' }, 'EGP')).toBe(true)
  })
  it('is false when the currency is unknown, rather than labelling it wrongly', () => {
    // A row from before the currency columns existed. Showing no badge is
    // right; showing one that guesses a currency would be a lie on a document.
    expect(isForeignDoc({}, 'EGP')).toBe(false)
    expect(isForeignDoc(null, 'EGP')).toBe(false)
  })
  it('follows the configured base currency, not a hardcoded EGP', () => {
    expect(isForeignDoc({ currency: 'EGP' }, 'USD')).toBe(true)
    expect(isForeignDoc({ currency: 'USD' }, 'USD')).toBe(false)
  })
})

/**
 * Source-level checks.
 *
 * These read the screens rather than rendering them. The bug is not a wrong
 * pixel — it is a `+` applied to the wrong column, which renders perfectly and
 * is wrong. Asserting the aggregation expression directly is what catches a
 * future edit that reverts it.
 */
describe('screens aggregate in base currency', () => {
  const files = {
    'PurchasingGraphView.jsx': 'src/pages/Purchasing/PurchasingGraphView.jsx',
    'PurchasingPivotView.jsx': 'src/pages/Purchasing/PurchasingPivotView.jsx',
    'VendorDetails.jsx': 'src/pages/Purchasing/VendorDetails.jsx',
    'index.jsx': 'src/pages/Purchasing/index.jsx',
  }

  it.each(Object.entries(files))('%s never sums a raw document total', (_name, path) => {
    const src = readFileSync(path, 'utf8')
    // The three shapes the old code used, in any of these files.
    expect(src).not.toMatch(/\+=\s*Number\(doc\.total\)/)
    expect(src).not.toMatch(/sum\s*\+\s*\(Number\(d\.total\)\s*\|\|\s*0\)/)
    expect(src).not.toMatch(/reduce\([^)]*Number\(\w+\.total\)/)
  })

  // Since BUG-066 the adding happens in the database, over every document: the
  // screens sum the `spend` of document buckets, and the bucket spend is the sum
  // of each document's base-currency total — docTotalBase's rule, in SQL.
  it.each(['PurchasingGraphView.jsx', 'PurchasingPivotView.jsx', 'VendorDetails.jsx'])(
    '%s adds base-currency spend from the document buckets',
    (name) => {
      expect(readFileSync(files[name], 'utf8')).toMatch(/summarizeBuckets|groupBuckets|row\.spend/)
    }
  )

  it('buckets spend from each document\'s base-currency total', () => {
    const sql = readFileSync('supabase/migrations/20260862_purchasing_lists.sql', 'utf8')
    expect(sql).toContain('coalesce(d.total_base, coalesce(d.total, 0) * coalesce(nullif(d.exchange_rate, 0), 1)) AS total_base_value')
    expect(sql).toContain('sum(d.total_base_value)')
  })

  // The label was a locale string that read "EGP" whatever the system was set
  // to, so a business configured in USD saw dollar figures labelled EGP.
  it.each(Object.entries(files))('%s does not label totals with a fixed currency string', (_n, path) => {
    expect(readFileSync(path, 'utf8')).not.toContain("purchasing.currencyCode")
  })

  it('sorts the purchasing list by base currency', async () => {
    const { resolvePurchaseDocSort } = await import('../api/db/purchasing')
    expect(resolvePurchaseDocSort({ key: 'total', direction: 'desc' }).column).toBe('total_base_value')
  })

  // A running balance is a sum, so it has to use the base column too.
  it('runs the vendor statement balance in base currency', () => {
    const src = readFileSync(files['VendorDetails.jsx'], 'utf8')
    expect(src).toMatch(/running \+= Number\(entry\.amount_base \?\? entry\.amount\)/)
  })
})

describe('vendor payment settlement stays within one currency', () => {
  const modals = readFileSync('src/pages/Purchasing/_modals.jsx', 'utf8')

  it('offers only invoices in the payment currency', () => {
    expect(modals).toMatch(/payableInvoices/)
    expect(modals).toMatch(/openInvoices\.filter\(\(vi\) => \(vi\.currency \|\| cur\.baseCurrency\) === cur\.currency\)/)
  })

  it('allocates, auto-allocates and lists from the filtered set, not the raw one', () => {
    // Any one of these left on `openInvoices` reintroduces the cross-currency
    // allocation the server then refuses.
    expect(modals).toContain('for (const inv of payableInvoices)')
    expect(modals).toContain('{payableInvoices.map((inv) => {')
    expect(modals).toContain('payableInvoices.length === 0')
  })

  it('clears allocations when the currency changes', () => {
    expect(modals).toMatch(/currencyRef\.current !== cur\.currency/)
    expect(modals).toMatch(/setAllocations\(\{\}\)/)
  })

  it('sends the currency and rate to the server', () => {
    expect(modals).toContain('currency: cur.payload.currency')
    expect(modals).toContain('exchangeRate: cur.payload.exchangeRate')
  })

  it('will not save a foreign payment without a valid rate', () => {
    expect(modals).toMatch(/allocatedTotal <= totalAmount \+ 0\.001 && cur\.rateValid/)
  })
})

describe('the database enforces the same rule the UI does', () => {
  const sql = readFileSync('supabase/migrations/20260793_vendor_payment_currency.sql', 'utf8')

  it.each(['record_vendor_payment', 'apply_vendor_payment_to_invoice'])(
    '%s refuses a currency mismatch',
    (fn) => {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${fn}`))
      const end = body.indexOf('$fn$;')
      expect(body.slice(0, end)).toContain('IS DISTINCT FROM')
    }
  )

  it('keeps security_invoker on both rebuilt views', () => {
    // Rebuilding a view without it makes it run as its owner and bypass RLS —
    // the leak this project already had once.
    const created = sql.match(/CREATE VIEW public\.v_\w+ WITH \(security_invoker = true\)/g)
    expect(created).toHaveLength(2)
    expect(sql.match(/CREATE VIEW public\.v_\w+/g)).toHaveLength(2)
  })

  it('re-grants SELECT on both views it dropped', () => {
    expect(sql).toContain('GRANT SELECT ON public.v_purchase_documents')
    expect(sql).toContain('GRANT SELECT ON public.v_vendor_ledger')
  })

  it('derives amount_base rather than storing it writably', () => {
    expect(sql).toMatch(/amount_base numeric\(12,2\)\s*\n?\s*GENERATED ALWAYS AS \(round\(amount \* exchange_rate, 2\)\) STORED/)
  })

  it('guards that authenticated can still execute the recreated function', () => {
    // record_vendor_payment is DROPped and recreated, which resets its grants.
    // Without this guard the app breaks for every user on the next deploy.
    expect(sql).toContain("has_function_privilege('authenticated'")
  })
})

/**
 * A foreign document at a rate of 1.
 *
 * Not a hypothetical: 20260792 normalised the currency on existing purchase
 * orders in section 1 and only created the rate guard in section 3, so four USD
 * purchase orders took exchange_rate from the column default and were never
 * passed through it. They are recorded as worth their face value in EGP —
 * understated about forty-eight times — and nothing on screen said so, because
 * 3,750 looks perfectly reasonable until you notice which currency it is in.
 */
describe('hasMissingRate', () => {
  it('is true for a foreign document left at par', () => {
    expect(hasMissingRate({ currency: 'USD', exchange_rate: 1 }, 'EGP')).toBe(true)
  })

  it('is false once a real rate is recorded', () => {
    expect(hasMissingRate({ currency: 'USD', exchange_rate: 48.5 }, 'EGP')).toBe(false)
  })

  // A rate of exactly 1 is correct here, and flagging it would cry wolf on
  // every local purchase — which is how people learn to ignore the warning.
  it('is false for a base-currency document, where 1 is the right rate', () => {
    expect(hasMissingRate({ currency: 'EGP', exchange_rate: 1 }, 'EGP')).toBe(false)
  })

  it('is false when the currency is unknown rather than guessing', () => {
    expect(hasMissingRate({}, 'EGP')).toBe(false)
    expect(hasMissingRate(null, 'EGP')).toBe(false)
  })

  it('handles the rate arriving as a string from the wire', () => {
    // PostgREST returns numeric as a string, so a strict === 1 would miss it.
    expect(hasMissingRate({ currency: 'USD', exchange_rate: '1' }, 'EGP')).toBe(true)
    expect(hasMissingRate({ currency: 'USD', exchange_rate: '48.50' }, 'EGP')).toBe(false)
  })

  it('follows the configured base currency', () => {
    expect(hasMissingRate({ currency: 'EGP', exchange_rate: 1 }, 'USD')).toBe(true)
  })
})

describe('the missing rate is visible without running a script', () => {
  it('is flagged in the purchasing list', () => {
    const src = readFileSync('src/pages/Purchasing/index.jsx', 'utf8')
    expect(src).toContain('hasMissingRate(doc, baseCurrency)')
  })

  it('is flagged on the document itself', () => {
    const src = readFileSync('src/pages/Purchasing/PurchaseDocumentDetail.jsx', 'utf8')
    expect(src).toContain('hasMissingRate(doc, baseCurrency)')
    expect(src).toContain('purchasing.rateMissingTitle')
  })
})
