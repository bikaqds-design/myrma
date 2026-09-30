import React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'

// A-06 (20260919): a customer's credit limit and what counts against it, as
// the database counts it when it approves an order or posts an invoice (base
// currency): unpaid invoices + approved orders not yet invoiced − unused
// payments, deposits and credit notes.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function Row({ label, value, strong, tone }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-[#6c6760] dark:text-[#9aa4b2]">{label}</span>
      <span className={`tabular-nums ${strong ? 'font-bold' : ''} ${tone || 'text-[#211f1b] dark:text-[#e8ebf0]'}`}>{value}</span>
    </div>
  )
}

export default function CreditStatusPanel({ customerId }) {
  const { t } = useTranslation()
  const { data: s, error } = useQuery({
    queryKey: ['credit-status', customerId],
    queryFn: () => db.creditControl.status(customerId),
    enabled: !!customerId,
    staleTime: 30_000,
  })
  if (error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error.message}</p>
  if (!s) return null
  const hasLimit = s.credit_limit !== null && s.credit_limit !== undefined
  const over = hasLimit && Number(s.available) < 0
  return (
    <section aria-label={t('customerDetails.credTitle')}
      className={`rounded-xl border p-4 space-y-1.5 ${over
        ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
        : 'bg-gray-50 dark:bg-[#0f1520] border-gray-200 dark:border-[#212a38]'}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs uppercase font-semibold text-gray-500 dark:text-[#9aa4b2]">{t('customerDetails.credTitle')}</h3>
        <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{s.currency}</span>
      </div>
      <Row label={t('customerDetails.creditLimit')} value={hasLimit ? fmtMoney(s.credit_limit) : t('customerDetails.credNoLimit')} />
      <Row label={t('customerDetails.credOpenInvoices')} value={fmtMoney(s.open_invoices)} />
      <Row label={t('customerDetails.credOpenOrders')} value={fmtMoney(s.open_orders)} />
      <Row label={t('customerDetails.credUnusedCredits')} value={`−${fmtMoney(s.unused_credits)}`} />
      <Row label={t('customerDetails.credExposure')} value={fmtMoney(s.exposure)} strong />
      {hasLimit && (
        <Row label={t(over ? 'customerDetails.credOver' : 'customerDetails.credAvailable')}
          value={fmtMoney(Math.abs(Number(s.available)))} strong
          tone={over ? 'text-red-700 dark:text-red-400' : 'text-green-700 dark:text-green-400'} />
      )}
      <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] pt-1">{t('customerDetails.credHint')}</p>
    </section>
  )
}
