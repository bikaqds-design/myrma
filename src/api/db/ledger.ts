import { supabase } from '../client.js'
import { fetchAllRows, fetchPage } from './_paging.js'

// The general ledger (A-01, 20260905–20260907). Journals are written only by
// the database's posting engine — nothing here writes one. The chart of
// accounts and the posting rules are written by administrators (RLS), and the
// database refuses any change that would break an account with postings.

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export interface GlAccountRow {
  id: string
  code: string
  name: string
  name_ar: string | null
  account_type: AccountType
  parent_id: string | null
  is_postable: boolean
  is_active: boolean
  description: string | null
}

export interface PostingRuleRow {
  role: string
  account_id: string
}

export interface JournalLineRow {
  id: string
  line_no: number
  account_id: string
  debit: number
  credit: number
  customer_id: string | null
  vendor_id: string | null
  memo: string | null
  account: { code: string; name: string; name_ar: string | null } | null
}

export interface JournalEntryRow {
  id: string
  entry_no: string
  entry_date: string
  source_type: string
  source_id: string | null
  source_code: string | null
  event: string
  memo: string | null
  reverses_entry_id: string | null
  created_by: string
  created_at: string
  journal_lines: JournalLineRow[]
}

export interface TrialBalanceRow {
  account_id: string
  code: string
  name: string
  name_ar: string | null
  account_type: AccountType
  debit: number
  credit: number
  balance: number
}

export interface JournalFilters {
  from?: string | null
  to?: string | null
  search?: string | null
}

const ENTRY_SELECT =
  'id, entry_no, entry_date, source_type, source_id, source_code, event, memo, reverses_entry_id, created_by, created_at, ' +
  'journal_lines(id, line_no, account_id, debit, credit, customer_id, vendor_id, memo, account:gl_accounts(code, name, name_ar))'

// PostgREST's or() takes a comma-separated filter list: characters that end a
// filter or start a group are dropped from the search text rather than escaped.
const cleanSearch = (s: string) => s.replace(/[,()*%\\]/g, ' ').trim()

export const ledger = {
  /** One page of journal entries, newest first, each with its lines. */
  async journalPage(page: number, pageSize: number, filters: JournalFilters = {}) {
    return fetchPage<JournalEntryRow>(
      (from, to) => {
        let q = supabase.from('journal_entries').select(ENTRY_SELECT, { count: 'exact' })
        if (filters.from) q = q.gte('entry_date', filters.from)
        if (filters.to) q = q.lte('entry_date', filters.to)
        const s = cleanSearch(filters.search ?? '')
        if (s) q = q.or(`entry_no.ilike.*${s}*,source_code.ilike.*${s}*,memo.ilike.*${s}*`)
        return q
          .order('entry_date', { ascending: false })
          .order('entry_no', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to)
      },
      page,
      pageSize
    ).then((r) => ({
      ...r,
      data: r.data.map((e) => ({ ...e, journal_lines: [...(e.journal_lines || [])].sort((a, b) => a.line_no - b.line_no) })),
    }))
  },

  /** Debits, credits and normal-side balance per account over the dates (either may be empty). */
  async trialBalance(from: string | null, to: string | null): Promise<TrialBalanceRow[]> {
    const { data, error } = await supabase.rpc('rma_trial_balance', { p_from: from || null, p_to: to || null })
    if (error) throw error
    return (data ?? []) as TrialBalanceRow[]
  },

  /** The whole chart, by code (a chart is small; read in chunks all the same). */
  async accounts(): Promise<GlAccountRow[]> {
    return fetchAllRows<GlAccountRow>((from, to) =>
      supabase
        .from('gl_accounts')
        .select('id, code, name, name_ar, account_type, parent_id, is_postable, is_active, description')
        .order('code', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    )
  },

  async postingRules(): Promise<PostingRuleRow[]> {
    return fetchAllRows<PostingRuleRow>((from, to) =>
      supabase.from('posting_rules').select('role, account_id').order('role', { ascending: true }).range(from, to)
    )
  },

  /** A new account (administrators). */
  async createAccount(fields: {
    code: string
    name: string
    name_ar?: string | null
    account_type: AccountType
    parent_id?: string | null
    is_postable: boolean
  }): Promise<GlAccountRow> {
    const { data, error } = await supabase.from('gl_accounts').insert(fields).select().single()
    if (error) throw error
    return data as GlAccountRow
  },

  /** Rename an account, or make it active / inactive (administrators). */
  async updateAccount(
    id: string,
    fields: Partial<Pick<GlAccountRow, 'name' | 'name_ar' | 'is_active' | 'description'>>
  ): Promise<GlAccountRow> {
    const { data, error } = await supabase.from('gl_accounts').update(fields).eq('id', id).select().single()
    if (error) throw error
    return data as GlAccountRow
  },

  /** Point a posting role at another account (administrators). */
  async setPostingRule(role: string, accountId: string): Promise<void> {
    const { error } = await supabase.from('posting_rules').update({ account_id: accountId }).eq('role', role)
    if (error) throw error
  },
}
