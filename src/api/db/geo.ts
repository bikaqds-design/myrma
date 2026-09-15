import { supabase } from '../client.js'
import { fetchAllRows } from './_paging.js'
import { assertAffected } from './_assertUpdated.js'

/**
 * Countries and their phone-number rules (20260799).
 *
 * Reference data rather than configuration: every staff member reads it to
 * validate a number, and only an administrator changes it.
 */

export interface CountryAreaCodeRow {
  id: string
  country_code: string
  /** National form, no trunk prefix: Cairo is '2', dialled as 02. */
  area_code: string
  name: string
  /** Subscriber digits AFTER the area code. */
  digits: number
}

export interface CountryRow {
  code: string
  name: string
  dial_code: string
  currency_code: string | null
  /** '0' in Egypt, '' where there is none. See the note in phone.js. */
  trunk_prefix: string
  mobile_prefixes: string[]
  mobile_digits: number | null
  has_area_codes: boolean
  landline_digits: number | null
  is_active: boolean
}

/** A country plus its area codes, in the shape src/lib/phone.js expects. */
export interface CountryRules {
  code: string
  name: string
  dialCode: string
  trunkPrefix: string
  mobilePrefixes: string[]
  mobileDigits: number | null
  hasAreaCodes: boolean
  landlineDigits: number | null
  areaCodes: { areaCode: string; name: string; digits: number }[]
}

const NOT_PROVISIONED = ['42P01', 'PGRST205']

export function toRules(country: CountryRow, areas: CountryAreaCodeRow[]): CountryRules {
  return {
    code: country.code,
    name: country.name,
    dialCode: country.dial_code,
    // The column is NOT NULL, but a row written before the column existed could
    // still arrive undefined through a stale cache. phone.js defaults to '0'.
    trunkPrefix: country.trunk_prefix ?? '0',
    mobilePrefixes: country.mobile_prefixes ?? [],
    mobileDigits: country.mobile_digits,
    hasAreaCodes: country.has_area_codes,
    landlineDigits: country.landline_digits,
    areaCodes: areas
      .filter((a) => a.country_code === country.code)
      .map((a) => ({ areaCode: a.area_code, name: a.name, digits: a.digits })),
  }
}

export const geo = {
  async listCountries(): Promise<{ data: CountryRow[]; missing: boolean }> {
    try {
      const data = await fetchAllRows<CountryRow>((from, to) =>
        supabase.from('countries').select('*').order('name').order('code').range(from, to)
      )
      return { data, missing: false }
    } catch (error) {
      if (NOT_PROVISIONED.includes((error as { code?: string })?.code ?? '')) return { data: [], missing: true }
      throw error
    }
  },

  async listAreaCodes(): Promise<CountryAreaCodeRow[]> {
    try {
      return await fetchAllRows<CountryAreaCodeRow>((from, to) =>
        supabase
          .from('country_area_codes')
          .select('*')
          .order('country_code')
          .order('area_code')
          .order('id', { ascending: true })
          .range(from, to)
      )
    } catch (error) {
      if (NOT_PROVISIONED.includes((error as { code?: string })?.code ?? '')) return []
      throw error
    }
  },

  async updateCountry(code: string, patch: Partial<CountryRow>): Promise<void> {
    const { data, error } = await supabase.from('countries').update(patch).eq('code', code).select('id')
    if (error) throw error
    assertAffected(data, 'Country')
  },

  async addAreaCode(input: {
    countryCode: string
    areaCode: string
    name: string
    digits: number
  }): Promise<void> {
    const { error } = await supabase.from('country_area_codes').insert({
      country_code: input.countryCode,
      area_code: input.areaCode.replace(/^0+/, ''), // stored without the trunk prefix
      name: input.name.trim(),
      digits: input.digits,
    })
    if (error) throw error
  },

  async removeAreaCode(id: string): Promise<void> {
    const { data, error } = await supabase.from('country_area_codes').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Area code')
  },

  /**
   * The gapless document counters. Read through an RPC because the table itself
   * refuses client access by design (20260712) — being unable to WRITE them is
   * correct; being unable to SEE them is how a restore quietly reissues codes.
   */
  async documentCounters(): Promise<
    { data: { seq_type: string; last_value: number; seq_year: number }[]; missing: boolean }
  > {
    const { data, error } = await supabase.rpc('rma_document_counters')
    if (error) {
      // 42883 undefined_function: the migration has not been applied here yet.
      if (error.code === '42883' || NOT_PROVISIONED.includes(error.code)) {
        return { data: [], missing: true }
      }
      throw error
    }
    return { data: data ?? [], missing: false }
  },
}
