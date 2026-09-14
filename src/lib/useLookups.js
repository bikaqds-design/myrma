/**
 * Customer and product lookups for pickers and name columns. (Audit finding
 * BUG-066, phase 4.)
 *
 * Every picker and every "customer name" column used to load the whole
 * customer or product table and search or index it in the browser. The Data
 * API returns at most 1 000 rows per request, so past that a picker could not
 * find a customer who exists, and a list showed "—" for a customer it simply
 * had not loaded. These ask the database for exactly what is needed: the
 * matches for what was typed, or the records these ids name.
 */
import { useMemo } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
import { useDebouncedValue } from './useDebouncedValue'
import { EMPTY_ARRAY } from './stableEmpty'

const EMPTY_MAP = Object.freeze({})

/** Sorted, de-duplicated, truthy ids — so the same set is one cache entry however it was built. */
function idSet(ids) {
  return [...new Set((ids || []).filter(Boolean))].sort()
}

/**
 * Customers matching `term`, from the database.
 *
 * @param {string} term           what was typed; debounced here
 * @param {object} [opts]
 * @param {number} [opts.limit]   most rows to return (default 8)
 * @param {number} [opts.minLength] characters needed before searching; 0 lists
 *                                the first `limit` alphabetically (default 1)
 * @param {boolean} [opts.enabled]
 * @returns {{ results: object[], isFetching: boolean }}
 */
export function useCustomerSearch(term, { limit = 8, minLength = 1, enabled = true } = {}) {
  const settled = useDebouncedValue(String(term ?? '').trim(), 250)
  const active = enabled && settled.length >= minLength
  const { data, isFetching } = useQuery({
    queryKey: ['customers', 'search', settled, limit],
    queryFn: () => db.customers.search(settled, limit),
    enabled: active,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  return { results: active ? data ?? EMPTY_ARRAY : EMPTY_ARRAY, isFetching: active && isFetching }
}

/** One customer by id, or null. */
export function useCustomer(id) {
  const { data } = useQuery({
    queryKey: ['customers', 'one', id],
    queryFn: () => db.customers.get(id),
    enabled: Boolean(id),
    staleTime: 60_000,
  })
  return id ? data ?? null : null
}

/** The customers these ids name, as `{ [id]: customer }`. Unknown ids are absent. */
export function useCustomersById(ids) {
  const key = idSet(ids)
  const { data } = useQuery({
    queryKey: ['customers', 'by-ids', key],
    queryFn: () => db.customers.getMany(key),
    enabled: key.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
  return useMemo(() => (data ? Object.fromEntries(data.map((c) => [c.id, c])) : EMPTY_MAP), [data])
}

/**
 * Products matching `term`, from the database.
 *
 * @param {string} term
 * @param {object} [opts]
 * @param {number} [opts.limit]          default 8
 * @param {number} [opts.minLength]      default 1
 * @param {string} [opts.brandId]        one brand only (a vendor's products)
 * @param {boolean} [opts.excludeService] leave out service products
 * @param {boolean} [opts.enabled]
 */
export function useProductSearch(term, { limit = 8, minLength = 1, brandId, excludeService = false, enabled = true } = {}) {
  const settled = useDebouncedValue(String(term ?? '').trim(), 250)
  const active = enabled && settled.length >= minLength
  const { data, isFetching } = useQuery({
    queryKey: ['products', 'search', settled, limit, brandId ?? null, excludeService],
    queryFn: () => db.products.search(settled, { limit, brandId, excludeService }),
    enabled: active,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  return { results: active ? data ?? EMPTY_ARRAY : EMPTY_ARRAY, isFetching: active && isFetching }
}

/** The products these ids name, as `{ [id]: product }`. */
export function useProductsById(ids) {
  const key = idSet(ids)
  const { data } = useQuery({
    queryKey: ['products', 'by-ids', key],
    queryFn: () => db.products.getMany(key),
    enabled: key.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
  return useMemo(() => (data ? Object.fromEntries(data.map((p) => [p.id, p])) : EMPTY_MAP), [data])
}
