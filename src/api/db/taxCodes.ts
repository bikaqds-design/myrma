import { supabase } from '../client.js'
import { fetchAllRows } from './_paging.js'

// Tax codes and the VAT return (A-04, 20260911). Codes are read by staff and
// written by administrators and accountants (RLS); the database keeps a used
// code's code and kind, and stamps each line with its code's rate when the
// line is written, so nothing here can change posted tax.

export type TaxKind = 'standard' | 'reduced' | 'zero' | 'exempt' | 'out_of_scope'

export interface TaxCodeRow {
  code: string
  name: string
  name_ar: string | null
  kind: TaxKind
  rate: number
  is_default: boolean
  is_active: boolean
  description: string | null
}

export interface VatReturnRow {
  side: 'output' | 'input'
  tax_code: string | null
  name: string | null
  name_ar: string | null
  kind: TaxKind | null
  rate: number
  net_amount: number
  tax_amount: number
  documents: number
}

export interface VatLedgerRow {
  output_tax: number
  input_tax: number
}

const num = (v: unknown): number => (v == null ? 0 : Number(v))

export const taxCodes = {
  /** Every code, by code (a handful per tenant; read in chunks all the same). */
  async list(): Promise<TaxCodeRow[]> {
    const rows = await fetchAllRows<TaxCodeRow>((from, to) =>
      supabase
        .from('tax_codes')
        .select('code, name, name_ar, kind, rate, is_default, is_active, description')
        .order('code', { ascending: true })
        .range(from, to)
    )
    return rows.map((r) => ({ ...r, rate: num(r.rate) }))
  },

  /** A new code (administrators and accountants). */
  async create(fields: Omit<TaxCodeRow, 'description'> & { description?: string | null }): Promise<TaxCodeRow> {
    const { data, error } = await supabase.from('tax_codes').insert(fields).select().single()
    if (error) throw error
    return data as TaxCodeRow
  },

  /** Rename, re-rate, make default or (in)active. The code itself never changes. */
  async update(
    code: string,
    fields: Partial<Pick<TaxCodeRow, 'name' | 'name_ar' | 'rate' | 'is_default' | 'is_active' | 'description'>>
  ): Promise<TaxCodeRow> {
    const { data, error } = await supabase.from('tax_codes').update(fields).eq('code', code).select().single()
    if (error) throw error
    return data as TaxCodeRow
  },

  /** Output and input tax by code and rate, from what the ledger posted between the dates. */
  async vatReturn(from: string, to: string): Promise<VatReturnRow[]> {
    const { data, error } = await supabase.rpc('rma_vat_return', { p_from: from, p_to: to })
    if (error) throw error
    return ((data ?? []) as VatReturnRow[]).map((r) => ({
      ...r,
      rate: num(r.rate),
      net_amount: num(r.net_amount),
      tax_amount: num(r.tax_amount),
      documents: num(r.documents),
    }))
  },

  /** The VAT accounts' movement over the same dates, to tie the return to. */
  async vatLedger(from: string, to: string): Promise<VatLedgerRow> {
    const { data, error } = await supabase.rpc('rma_vat_return_ledger', { p_from: from, p_to: to })
    if (error) throw error
    const row = (Array.isArray(data) ? data[0] : data) as VatLedgerRow | undefined
    return { output_tax: num(row?.output_tax), input_tax: num(row?.input_tax) }
  },
}
