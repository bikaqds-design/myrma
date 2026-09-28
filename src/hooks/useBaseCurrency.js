import { useQuery } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
import { FALLBACK_CURRENCY } from '../lib/money'

/**
 * The installation's base currency.
 *
 * Totals, balances and reports are in the base currency; a single document
 * (sales since 20260912, purchasing before that) may be in another and states
 * its own currency and rate, and anything that adds documents together converts
 * each at its own rate first (20260913). So one code answers "what currency is
 * this total" for the whole UI.
 *
 * Cached for the session rather than per-component: it is installation config
 * that cannot change once any document exists (20260791 enforces that), so
 * re-fetching it would be pure noise.
 *
 * Falls back to EGP rather than rendering nothing. A wrong-but-stated currency
 * is recoverable; a money figure with no currency at all is the bug this whole
 * change exists to remove.
 */
export function useBaseCurrency() {
  const { data } = useQuery({
    queryKey: ['base-currency'],
    queryFn: async () => {
      const result = await db.rmaConfig.getAll()
      if (result.missing) return FALLBACK_CURRENCY
      const row = result.data.find((r) => r.config_key === 'default_currency')
      const code = typeof row?.config_value === 'string'
        ? row.config_value
        : row?.config_value?.toString?.()
      return code || FALLBACK_CURRENCY
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  })
  return data || FALLBACK_CURRENCY
}
