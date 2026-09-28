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

/** A line of the profit and loss (rma_profit_and_loss, 20260916). */
export interface ProfitLossRow {
  account_id: string
  code: string
  name: string
  name_ar: string | null
  account_type: 'income' | 'expense'
  parent_id: string | null
  parent_code: string | null
  parent_name: string | null
  parent_name_ar: string | null
  amount: number
}

/** A line of the balance sheet (rma_balance_sheet, 20260916). */
export interface BalanceSheetRow {
  kind: 'account' | 'prior_years_earnings' | 'current_year_earnings'
  section: 'asset' | 'liability' | 'equity'
  account_id: string | null
  code: string | null
  name: string | null
  name_ar: string | null
  parent_id: string | null
  parent_code: string | null
  parent_name: string | null
  parent_name_ar: string | null
  amount: number
}

/** One journal line on an account, with its running balance (rma_account_activity). */
export interface AccountActivityRow {
  entry_id: string
  entry_no: string
  entry_date: string
  source_type: string
  source_id: string | null
  source_code: string | null
  event: string
  memo: string | null
  debit: number
  credit: number
  running_balance: number
  opening_balance: number
  total_count: number
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
  /** Profit and loss for a period (both dates required). */
  async profitAndLoss(from: string, to: string): Promise<ProfitLossRow[]> {
    const { data, error } = await supabase.rpc('rma_profit_and_loss', { p_from: from, p_to: to })
    if (error) throw error
    return (data ?? []) as ProfitLossRow[]
  },

  /** Balance sheet at a date, with the profit or loss not yet closed as equity. */
  async balanceSheet(asOf: string): Promise<BalanceSheetRow[]> {
    const { data, error } = await supabase.rpc('rma_balance_sheet', { p_as_of: asOf })
    if (error) throw error
    return (data ?? []) as BalanceSheetRow[]
  },

  /**
   * One page of an account's lines in date order, paged in the database
   * (BUG-066). `opening` is the balance before `from`; `count` all lines.
   */
  async accountActivity(accountId: string, from: string | null, to: string, page: number, pageSize: number) {
    const { data, error } = await supabase.rpc('rma_account_activity', {
      p_account_id: accountId, p_from: from || null, p_to: to,
      p_limit: pageSize, p_offset: (Math.max(page, 1) - 1) * pageSize,
    })
    if (error) throw error
    const rows = (data ?? []) as AccountActivityRow[]
    return {
      data: rows,
      count: rows.length ? Number(rows[0].total_count) : null,
      opening: rows.length ? Number(rows[0].opening_balance) : null,
    }
  },

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

  /** The country templates on offer (A-02), with how many accounts each has. */
  async chartTemplates(): Promise<ChartTemplateSummary[]> {
    const rows = await fetchAllRows<{ country_code: string; code: string }>((from, to) =>
      supabase
        .from('gl_chart_templates')
        .select('country_code, code')
        .order('country_code', { ascending: true })
        .order('code', { ascending: true })
        .range(from, to)
    )
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.country_code, (counts.get(r.country_code) ?? 0) + 1)
    return [...counts].map(([country, accounts]) => ({ country, accounts }))
  },

  /** The template last applied to this tenant's chart, if any. */
  async appliedTemplate(): Promise<string | null> {
    const { data, error } = await supabase
      .from('rma_config')
      .select('config_value')
      .eq('config_key', 'chart_template')
      .maybeSingle()
    if (error) throw error
    return typeof data?.config_value === 'string' ? data.config_value : null
  },

  /** Replace the chart with a country's template (administrators, only before anything is posted). */
  async applyChartTemplate(country: string): Promise<ChartApplyResult> {
    const { data, error } = await supabase.rpc('rma_apply_chart_template', { p_country: country })
    if (error) throw error
    return data as ChartApplyResult
  },

  /** Create or rename accounts from a parsed file (administrators); one result per row. */
  async importChartAccounts(rows: ChartImportRow[]): Promise<ChartImportResult[]> {
    const { data, error } = await supabase.rpc('rma_import_chart_accounts', { p_rows: rows })
    if (error) throw error
    return (data ?? []) as ChartImportResult[]
  },
}

export interface ChartTemplateSummary {
  country: string
  accounts: number
}

export interface ChartApplyResult {
  country: string
  created: number
  updated: number
  removed: number
}

export interface ChartImportRow {
  code: string
  name: string
  name_ar?: string
  type?: string
  parent_code?: string
  header?: string
}

export interface ChartImportResult {
  code: string | null
  status: 'created' | 'updated' | 'error'
  message?: string
}
