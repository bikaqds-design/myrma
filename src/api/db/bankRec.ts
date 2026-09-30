import { supabase } from '../client.js'
import { fetchAllRows, fetchPage } from './_paging.js'

// Bank reconciliation (A-07, 20260920). Statements and their lines are read
// directly (managers and accountants); every change goes through the
// database's functions, which accountants and administrators may call.

export interface BankAccountRow {
  id: string
  code: string
  name: string
  name_ar: string | null
}

export interface BankStatementRow {
  id: string
  account_id: string
  statement_date: string
  reference: string | null
  opening_balance: number
  closing_balance: number
  status: 'open' | 'completed'
  created_by: string | null
  created_at: string
  completed_by: string | null
  completed_at: string | null
}

export interface BankStatementLineRow {
  id: string
  statement_id: string
  line_no: number
  txn_date: string
  description: string | null
  reference: string | null
  amount: number
  journal_line_id: string | null
  booked_entry_id: string | null
  matched_by: string | null
  matched_at: string | null
  // the entry it clears, when matched
  journal_line?: { id: string; entry: { entry_no: string; entry_date: string; source_type: string; source_id: string | null; source_code: string | null } | null } | null
}

export interface BankMatchCandidateRow {
  statement_line_id: string
  journal_line_id: string
  entry_no: string
  entry_date: string
  source_type: string
  source_id: string | null
  source_code: string | null
  memo: string | null
  amount: number
  days_apart: number
}

export interface BankStatementSummaryRow {
  opening_balance: number
  lines_total: number
  closing_balance: number
  lines_count: number
  unmatched_count: number
  statement_balances: boolean
  ledger_balance: number
  uncleared_total: number
  uncleared_count: number
  difference: number
  previous_closing: number | null
}

export interface BankStatementLineInput {
  txn_date: string
  amount: string | number
  description?: string | null
  reference?: string | null
}

const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw error
  return data as T
}

export const bankRec = {
  /** The accounts that can be reconciled: bank / cash, taking postings, active. */
  async accounts(): Promise<BankAccountRow[]> {
    return fetchAllRows<BankAccountRow>((from, to) =>
      supabase
        .from('gl_accounts')
        .select('id, code, name, name_ar')
        .eq('is_bank', true)
        .eq('is_postable', true)
        .eq('is_active', true)
        .order('code', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
  },

  /** One account's statements, newest first, a page at a time. */
  async statementsPage(accountId: string, page: number, pageSize: number) {
    return fetchPage<BankStatementRow>(
      (from, to) =>
        supabase
          .from('bank_statements')
          .select('*', { count: 'exact' })
          .eq('account_id', accountId)
          .order('statement_date', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      page,
      pageSize,
    )
  },

  /** The latest statement on an account (its closing opens the next). */
  async latest(accountId: string): Promise<BankStatementRow | null> {
    const { data, error } = await supabase
      .from('bank_statements')
      .select('*')
      .eq('account_id', accountId)
      .order('statement_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(0, 0)
    if (error) throw error
    return ((data ?? []) as BankStatementRow[])[0] ?? null
  },

  async statement(id: string): Promise<BankStatementRow | null> {
    const { data, error } = await supabase.from('bank_statements').select('*').eq('id', id).maybeSingle()
    if (error) throw error
    return data as BankStatementRow | null
  },

  /** Every line of a statement (up to 5 000), with the entry each one clears. */
  async lines(statementId: string): Promise<BankStatementLineRow[]> {
    return fetchAllRows<BankStatementLineRow>((from, to) =>
      supabase
        .from('bank_statement_lines')
        .select('*, journal_line:journal_lines(id, entry:journal_entries(entry_no, entry_date, source_type, source_id, source_code))')
        .eq('statement_id', statementId)
        .order('line_no', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
  },

  async candidates(statementId: string): Promise<BankMatchCandidateRow[]> {
    return (await rpc<BankMatchCandidateRow[]>('rma_bank_match_candidates', { p_statement_id: statementId })) ?? []
  },

  async summary(statementId: string): Promise<BankStatementSummaryRow | null> {
    const rows = await rpc<BankStatementSummaryRow[]>('rma_bank_statement_summary', { p_statement_id: statementId })
    return (rows ?? [])[0] ?? null
  },

  async create(input: {
    accountId: string
    statementDate: string
    reference?: string | null
    openingBalance: number
    closingBalance: number
    lines: BankStatementLineInput[]
  }): Promise<string> {
    return rpc<string>('create_bank_statement', {
      p_account_id: input.accountId,
      p_statement_date: input.statementDate,
      p_reference: input.reference ?? null,
      p_opening_balance: input.openingBalance,
      p_closing_balance: input.closingBalance,
      p_lines: input.lines,
    })
  },

  addLine: (statementId: string, line: BankStatementLineInput) => rpc<string>('add_bank_statement_line', { p_statement_id: statementId, p_line: line }),
  remove: (statementId: string) => rpc<void>('delete_bank_statement', { p_statement_id: statementId }),
  match: (lineId: string, journalLineId: string) => rpc<void>('match_bank_line', { p_line_id: lineId, p_journal_line_id: journalLineId }),
  unmatch: (lineId: string) => rpc<void>('unmatch_bank_line', { p_line_id: lineId }),
  autoMatch: (statementId: string) => rpc<number>('auto_match_bank_statement', { p_statement_id: statementId }),
  book: (lineId: string, accountId: string, memo: string | null) => rpc<string>('book_bank_line', { p_line_id: lineId, p_account_id: accountId, p_memo: memo }),
  complete: (statementId: string) => rpc<void>('complete_bank_statement', { p_statement_id: statementId }),
  reopen: (statementId: string) => rpc<void>('reopen_bank_statement', { p_statement_id: statementId }),
}
