import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { Input, Label } from '../../components/ui'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { accountName, trialBalanceTotals } from './_ledger'

// Accounting › Trial balance (A-01c) over rma_trial_balance(from, to):
// debits, credits and each account's balance on its normal side. Empty dates
// mean all time.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const th = 'px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]'

export default function TrialBalanceTab() {
  const { t, i18n } = useTranslation()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const { data: rows = EMPTY_ARRAY, isLoading, error } = useQuery({
    queryKey: ['ledger', 'trial-balance', from, to],
    queryFn: () => db.ledger.trialBalance(from || null, to || null),
    staleTime: 30_000,
  })
  const totals = trialBalanceTotals(rows)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="tb-from">{t('accounting.glFrom')}</Label>
          <Input id="tb-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="tb-to">{t('accounting.glTo')}</Label>
          <Input id="tb-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              <th className={`${th} text-start`}>{t('accounting.glColAccount')}</th>
              <th className={`${th} text-start`}>{t('accounting.glColType')}</th>
              <th className={`${th} text-end`}>{t('accounting.glDebit')}</th>
              <th className={`${th} text-end`}>{t('accounting.glCredit')}</th>
              <th className={`${th} text-end`}>{t('accounting.glBalance')}</th>
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={5} role="alert" className="py-12 text-center text-sm text-red-600 dark:text-red-400">{error.message}</td>
              </tr>
            ) : !isLoading && rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.glNone')}</td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.account_id} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                  <td className="px-4 py-3 text-[#211f1b] dark:text-[#e8ebf0]">
                    <span className="font-mono text-xs">{r.code}</span> {accountName(r, i18n.language)}
                  </td>
                  <td className="px-4 py-3 text-[#6c6760] dark:text-[#9aa4b2]">{t(`accounting.glType_${r.account_type}`)}</td>
                  <td className="px-4 py-3 text-end text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(r.debit)}</td>
                  <td className="px-4 py-3 text-end text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(r.credit)}</td>
                  <td className="px-4 py-3 text-end font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(r.balance)}</td>
                </tr>
              ))
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
                <td className="px-4 py-3 font-semibold text-[#211f1b] dark:text-[#e8ebf0]" colSpan={2}>{t('accounting.glTotal')}</td>
                <td className="px-4 py-3 text-end font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(totals.debit)}</td>
                <td className="px-4 py-3 text-end font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(totals.credit)}</td>
                <td className="px-4 py-3 text-end text-xs">
                  {totals.balanced ? (
                    <span className="text-green-700 dark:text-green-400">{t('accounting.glBalanced')}</span>
                  ) : (
                    <span role="alert" className="text-red-600 dark:text-red-400">{t('accounting.glNotBalanced')}</span>
                  )}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}
