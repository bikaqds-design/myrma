import { supabase } from '../client.js'
import { fetchAllRows } from './_paging.js'

// Exchange rates and document currencies (A-05, 20260912). Rates are base
// units per one unit of the currency, from a date; the rate for a day is the
// latest on or before it. Administrators and accountants write them (RLS).

export interface ExchangeRateRow {
  currency: string
  rate_date: string
  rate: number
  note: string | null
  created_by: string | null
  created_at: string
}

export type CurrencyDocType = 'quotation' | 'sales_order' | 'invoice' | 'credit_note'

export const exchangeRates = {
  /** Every rate, newest first (a few per currency per month; read in chunks all the same). */
  async list(): Promise<ExchangeRateRow[]> {
    const rows = await fetchAllRows<ExchangeRateRow>((from, to) =>
      supabase
        .from('exchange_rates')
        .select('currency, rate_date, rate, note, created_by, created_at')
        .order('rate_date', { ascending: false })
        .order('currency', { ascending: true })
        .range(from, to)
    )
    return rows.map((r) => ({ ...r, rate: Number(r.rate) }))
  },

  /** Add or replace the rate of a currency for a day (administrators and accountants). */
  async save(input: { currency: string; rate_date: string; rate: number; note?: string | null }): Promise<void> {
    const { error } = await supabase
      .from('exchange_rates')
      .upsert({ currency: input.currency, rate_date: input.rate_date, rate: input.rate, note: input.note ?? null }, { onConflict: 'currency,rate_date' })
    if (error) throw error
  },

  async remove(currency: string, rateDate: string): Promise<void> {
    const { error } = await supabase.from('exchange_rates').delete().eq('currency', currency).eq('rate_date', rateDate)
    if (error) throw error
  },

  /** The rate for a day (the latest on or before it); 1 for the base currency; null when none is on file. */
  async rateFor(currency: string, date?: string | null): Promise<number | null> {
    const { data, error } = await supabase.rpc('rma_exchange_rate', { p_currency: currency, p_date: date || null })
    if (error) throw error
    return data == null ? null : Number(data)
  },

  /** Change a draft document's currency or rate (its author; the database checks who and when). */
  async setDocumentCurrency(docType: CurrencyDocType, id: string, currency: string, rate?: number | null): Promise<{ currency: string; exchange_rate: number }> {
    const { data, error } = await supabase.rpc('set_document_currency', {
      p_doc_type: docType,
      p_id: id,
      p_currency: currency,
      p_rate: rate ?? null,
    })
    if (error) throw error
    return data as { currency: string; exchange_rate: number }
  },
}
