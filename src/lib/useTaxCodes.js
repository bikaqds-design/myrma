import { useQuery } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
import { EMPTY_ARRAY } from './stableEmpty'

/** Every tax code, shared by all line editors (a handful of rows, cached). */
export function useTaxCodes() {
  const { data = EMPTY_ARRAY } = useQuery({
    queryKey: ['tax-codes'],
    queryFn: () => db.taxCodes.list(),
    staleTime: 5 * 60_000,
  })
  return data
}
