import { useQuery } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
import { TICKET_DEFAULTS, TICKET_DEFAULTS_KEY, normaliseTicketDefaults } from '../lib/ticketDefaults'

/**
 * The configured defaults for a new ticket. (Audit finding BUG-027.)
 *
 * Shares the `rma-config` query so opening the ticket form does not issue
 * another request for config the app has usually already fetched.
 *
 * Falls back to the built-in defaults on any failure rather than blocking the
 * form. Not being able to read a preference must never stop someone raising a
 * ticket — the fallbacks are the values the form used before this hook existed,
 * so the worst case is exactly the old behaviour.
 */
export function useTicketDefaults() {
  const { data } = useQuery({
    queryKey: ['rma-config', TICKET_DEFAULTS_KEY],
    queryFn: async () => {
      const result = await db.rmaConfig.getAll()
      if (result.missing) return TICKET_DEFAULTS
      const row = result.data.find((r) => r.config_key === TICKET_DEFAULTS_KEY)
      return normaliseTicketDefaults(row?.config_value)
    },
    staleTime: 5 * 60_000,
    retry: 1,
  })
  return data || TICKET_DEFAULTS
}
