import { useQuery } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
import { toRules } from '../api/db/geo'

/**
 * Phone-number rules for a record, resolving the system default and any
 * per-record override.
 *
 * A customer or vendor may carry its own `country_code`; NULL means "use the
 * system default", which is why the column is nullable and nothing had to be
 * backfilled. This business already has four overseas vendors, so the override
 * is not hypothetical.
 *
 * Returns null while loading, or when the country tables are not provisioned.
 * Null means "no rules" — and the validators treat that as "stay silent"
 * rather than "everything is valid", because a screen that quietly approves
 * whatever is typed is worse than one that says nothing.
 */
export function useCountryRules(recordCountryCode) {
  const { data: countriesRes } = useQuery({
    queryKey: ['countries'],
    queryFn: () => db.geo.listCountries(),
    staleTime: 60 * 60_000,
    retry: 1,
  })
  const { data: areaCodes } = useQuery({
    queryKey: ['country-area-codes'],
    queryFn: () => db.geo.listAreaCodes(),
    staleTime: 60 * 60_000,
    retry: 1,
  })
  const { data: config } = useQuery({
    queryKey: ['rma-config', 'default_country'],
    queryFn: async () => {
      const result = await db.rmaConfig.getAll()
      if (result.missing) return null
      const row = result.data.find((r) => r.config_key === 'default_country')
      const v = row?.config_value
      return typeof v === 'string' ? v : (v?.toString?.() ?? null)
    },
    staleTime: 60 * 60_000,
  })

  const countries = countriesRes?.data ?? []
  if (countries.length === 0) return null

  const wanted = recordCountryCode || config
  if (!wanted) return null

  const country = countries.find((c) => c.code === wanted)
  if (!country) return null

  return toRules(country, areaCodes ?? [])
}

/**
 * The list of countries a record can be set to, for the override picker.
 * Active ones only — an inactive country is one this business has stopped
 * dealing with, and offering it invites the wrong choice.
 */
export function useCountryOptions() {
  const { data } = useQuery({
    queryKey: ['countries'],
    queryFn: () => db.geo.listCountries(),
    staleTime: 60 * 60_000,
    retry: 1,
  })
  return (data?.data ?? []).filter((c) => c.is_active)
}
