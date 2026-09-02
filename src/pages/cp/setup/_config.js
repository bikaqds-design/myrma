import { useQuery } from '@tanstack/react-query'
import { db } from '../../../api/supabaseClient'

/**
 * Reading and writing rma_config, shared by every System Setup panel.
 *
 * Split out of _shared.jsx because that file exports a component: a module that
 * exports both components and plain functions breaks fast refresh, and the
 * linter is right to say so.
 *
 * config_value is jsonb, so a string arrives quoted and a boolean arrives as a
 * real boolean. Unwrapping it in five panels is five chances to forget which.
 */
export function useConfigValue(key, fallback = null) {
  const { data } = useQuery({
    queryKey: ['rma-config', key],
    queryFn: async () => {
      const result = await db.rmaConfig.getAll()
      if (result.missing) return null
      const row = result.data.find((r) => r.config_key === key)
      if (!row) return null
      return row.config_value
    },
    staleTime: 5 * 60_000,
  })
  if (data === null || data === undefined) return fallback
  return data
}

/** Write one config value. Here so every panel writes it identically. */
export async function saveConfig(key, value, actorEmail) {
  return db.rmaConfig.set(key, value, actorEmail)
}
