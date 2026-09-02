import { useQuery } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
import { FALLBACK_CURRENCY } from '../lib/money'

/**
 * The installation's base currency.
 *
 * Every money value in this system is in the base currency — sales documents
 * and customer payments never carry FX, and foreign purchases are converted to
 * base at the rate stored on their own document. So one code answers "what
 * currency is this number" for almost the whole UI.
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
