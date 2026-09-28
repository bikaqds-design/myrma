import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { Input, Label, Spinner } from '../../components/ui'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { useBaseCurrency } from '../../hooks/useBaseCurrency'
import { bsLineLabel, bsSummary, groupByHeader, todayIso } from './_reports'
import ReportSection from './ReportSection'
import AccountActivityModal from './AccountActivityModal'

// Accounting › Balance sheet (A-08a, rma_balance_sheet): assets, liabilities
// and equity at a date. Profit or loss is never closed into retained earnings,
// so equity carries it on two lines (before this financial year and within
// it). Assets always equal liabilities plus equity; the page says so.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const card = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]'

export default function BalanceSheetTab() {
  const { t, i18n } = useTranslation()
  const baseCurrency = useBaseCurrency()
  const [asOf, setAsOf] = useState(todayIso)
  const [open, setOpen] = useState(null)

  const { data: rows = EMPTY_ARRAY, isLoading, error } = useQuery({
    queryKey: ['ledger', 'balance-sheet', asOf],
    queryFn: () => db.ledger.balanceSheet(asOf),
    enabled: !!asOf,
    staleTime: 30_000,
  })
  const accounts = rows.filter((r) => r.kind === 'account')
  const earnings = rows.filter((r) => r.kind !== 'account' && Number(r.amount) !== 0)
  const sum = bsSummary(rows)
  const section = (s) => groupByHeader(accounts.filter((r) => r.section === s), i18n.language)

  const earningRows = earnings.map((r) => (
    <tr key={r.kind} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
      <td className="px-4 py-2 ps-8 text-[#211f1b] dark:text-[#e8ebf0]">{bsLineLabel(r, i18n.language, t)}</td>
      <td className="px-4 py-2 text-end tabular-nums text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(r.amount)}</td>
    </tr>
  ))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="bs-as-of">{t('accounting.repAsOf')}</Label>
          <Input id="bs-as-of" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] pb-2">{t('accounting.repInCurrency', { currency: baseCurrency })}</p>
      </div>

      {!asOf ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('accounting.repErrAsOf')}</p>
      ) : error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error.message}</p>
      ) : isLoading ? (
        <div className="py-12 flex justify-center"><Spinner /></div>
      ) : !isLoading && rows.length > 0 && accounts.length === 0 && earnings.length === 0 ? (
        <p className={`${card} p-6 text-sm text-center text-[#6c6760] dark:text-[#9aa4b2]`}>{t('accounting.repBsNone')}</p>
      ) : (
        <>
          <ReportSection title={t('accounting.repAssets')} groups={section('asset')} total={sum.assets}
            totalLabel={t('accounting.repTotalAssets')} onOpen={setOpen} lang={i18n.language} />
          <ReportSection title={t('accounting.repLiabilities')} groups={section('liability')} total={sum.liabilities}
            totalLabel={t('accounting.repTotalLiabilities')} onOpen={setOpen} lang={i18n.language} />
          <ReportSection title={t('accounting.repEquity')} groups={section('equity')} total={sum.equity}
            totalLabel={t('accounting.repTotalEquity')} onOpen={setOpen} lang={i18n.language} extraRows={earningRows} />
          <div className={`${card} px-4 py-3 flex flex-wrap items-center justify-between gap-2`}>
            <span className="font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.repTotalLiabilitiesEquity')}</span>
            <span className="tabular-nums font-bold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(sum.liabilitiesAndEquity)} {baseCurrency}</span>
            <span className="w-full text-xs">
              {sum.balanced ? (
                <span className="text-green-700 dark:text-green-400">{t('accounting.repBalanced')}</span>
              ) : (
                <span role="alert" className="text-red-600 dark:text-red-400">{t('accounting.repNotBalanced')}</span>
              )}
            </span>
          </div>
        </>
      )}

      {open && (
        <AccountActivityModal account={{ id: open.account_id, code: open.code, name: open.name, name_ar: open.name_ar }}
          from={null} to={asOf} onClose={() => setOpen(null)} />
      )}
    </div>
  )
}
