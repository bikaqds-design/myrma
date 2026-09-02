import { useQuery } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'

/**
 * Currencies a document can be raised in, base currency first.
 *
 * Base first because most purchases are local, and a picker that opens on the
 * common case is one fewer decision on every order.
 *
 * If the currencies table is unreachable — or the migration has not been
 * applied to this environment yet — this degrades to base-currency-only rather
 * than rendering an empty picker. An empty picker would make the purchase order
 * form unusable, which is a far worse failure than temporarily not offering
 * foreign currencies.
 */
export function useCurrencyOptions(baseCurrency) {
  const { data } = useQuery({
    queryKey: ['currencies'],
    queryFn: () => db.currencies.listActive(),
    staleTime: 60 * 60_000,
    retry: 1,
  })

  const rows = Array.isArray(data) ? data : []
  if (rows.length === 0) {
    return [{ code: baseCurrency, name: baseCurrency, symbol: baseCurrency, decimals: 2 }]
  }

  const base = rows.find((c) => c.code === baseCurrency)
  const rest = rows.filter((c) => c.code !== baseCurrency)
  // Base may be absent if someone deactivated it — still offer it, because a
  // document must be raisable in the currency the books are kept in.
  return [base || { code: baseCurrency, name: baseCurrency, symbol: baseCurrency, decimals: 2 }, ...rest]
}
