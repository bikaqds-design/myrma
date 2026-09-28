import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { Input, Label, Spinner } from '../../components/ui'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { useBaseCurrency } from '../../hooks/useBaseCurrency'
import { groupByHeader, plSummary, validatePeriod, yearToDate } from './_reports'
import AccountActivityModal from './AccountActivityModal'
import ReportSection from './ReportSection'

// Accounting › Profit and loss (A-08a, rma_profit_and_loss): income and
// expenses for a period, grouped under their header accounts, and the net
// profit. Every figure is the journal's; click an account for its entries.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const card = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]'

export default function ProfitLossTab() {
  const { t, i18n } = useTranslation()
  const baseCurrency = useBaseCurrency()
  const [period, setPeriod] = useState(yearToDate)
  const [open, setOpen] = useState(null)
  const bad = validatePeriod(period.from, period.to)

  const { data: rows = EMPTY_ARRAY, isLoading, error } = useQuery({
    queryKey: ['ledger', 'profit-and-loss', period.from, period.to],
    queryFn: () => db.ledger.profitAndLoss(period.from, period.to),
    enabled: !bad,
    staleTime: 30_000,
  })
  const income = rows.filter((r) => r.account_type === 'income')
  const expense = rows.filter((r) => r.account_type === 'expense')
  const sum = plSummary(rows)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="pl-from">{t('accounting.glFrom')}</Label>
          <Input id="pl-from" type="date" value={period.from} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))} />
        </div>
        <div>
          <Label htmlFor="pl-to">{t('accounting.glTo')}</Label>
          <Input id="pl-to" type="date" value={period.to} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))} />
        </div>
        <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] pb-2">{t('accounting.repInCurrency', { currency: baseCurrency })}</p>
      </div>

      {bad ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(bad)}</p>
      ) : error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error.message}</p>
      ) : isLoading ? (
        <div className="py-12 flex justify-center"><Spinner /></div>
      ) : !isLoading && rows.length === 0 ? (
        <p className={`${card} p-6 text-sm text-center text-[#6c6760] dark:text-[#9aa4b2]`}>{t('accounting.repPlNone')}</p>
      ) : (
        <>
          <ReportSection title={t('accounting.repIncome')} groups={groupByHeader(income, i18n.language)} total={sum.income}
            totalLabel={t('accounting.repTotalIncome')} onOpen={setOpen} lang={i18n.language} />
          <ReportSection title={t('accounting.repExpenses')} groups={groupByHeader(expense, i18n.language)} total={sum.expense}
            totalLabel={t('accounting.repTotalExpenses')} onOpen={setOpen} lang={i18n.language} />
          <div className={`${card} px-4 py-3 flex items-center justify-between`}>
            <span className="font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t(sum.net < 0 ? 'accounting.repNetLoss' : 'accounting.repNetProfit')}</span>
            <span className={`tabular-nums font-bold ${sum.net < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>
              {fmtMoney(sum.net)} {baseCurrency}
            </span>
          </div>
        </>
      )}

      {open && (
        <AccountActivityModal account={{ id: open.account_id, code: open.code, name: open.name, name_ar: open.name_ar }}
          from={period.from} to={period.to} onClose={() => setOpen(null)} />
      )}
    </div>
  )
}
