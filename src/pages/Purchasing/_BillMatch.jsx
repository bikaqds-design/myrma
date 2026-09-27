import React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'

// A supplier bill against its purchase order and the goods received (P-04,
// 20260900): per line ordered, received, billed, the order's net unit price
// and the billed one. The database refuses to submit a bill that charges for
// more than was ordered or received, and asks for a reason when a price is
// above the order (beyond the tenant's tolerance) or a product is not on it;
// that reason is shown here for the approver.
//
// Purchase prices are for managers and accountants: for anyone else the call
// is refused and the panel stays hidden.

const ISSUE_PILL = {
  over_billed: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  price_above: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  not_on_order: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
}

export default function BillMatch({ vendorInvoice, fmtMoney }) {
  const { t } = useTranslation()
  const { data: rows = EMPTY_ARRAY, isError } = useQuery({
    queryKey: ['vendor-invoice-match', vendorInvoice.id, vendorInvoice.updated_at],
    queryFn: () => db.vendorInvoices.match(vendorInvoice.id),
    enabled: !!vendorInvoice.purchase_order_id,
    retry: false,
  })
  if (!vendorInvoice.purchase_order_id || isError || rows.length === 0) return null

  const issues = rows.filter((r) => r.issue).length
  const hasReceived = rows.some((r) => r.received_qty != null)
  const th = 'px-3 py-2 text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]'
  const td = 'px-3 py-2 text-[#211f1b] dark:text-[#e8ebf0]'
  const price = (n) => (n == null ? '—' : fmtMoney(n))

  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] mb-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#e6e9ef] dark:border-[#212a38]">
        <h3 className="text-sm font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('purchasing.matchTitle')}</h3>
        <span
          className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
            issues ? ISSUE_PILL.price_above : 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
          }`}
        >
          {issues ? t('purchasing.matchIssues', { count: issues }) : t('purchasing.matchOk')}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
              <th className={`${th} text-start ps-4`}>{t('purchasing.matchColProduct')}</th>
              <th className={`${th} text-center`}>{t('purchasing.matchColOrdered')}</th>
              {hasReceived && <th className={`${th} text-center`}>{t('purchasing.matchColReceived')}</th>}
              <th className={`${th} text-center`}>{t('purchasing.matchColBilled')}</th>
              <th className={`${th} text-end`}>{t('purchasing.matchColOrderPrice')}</th>
              <th className={`${th} text-end`}>{t('purchasing.matchColBilledPrice')}</th>
              <th className={`${th} text-start pe-4`}>{t('purchasing.matchColStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line_no} className="border-b border-[#f0f2f6] dark:border-[#1a2230] last:border-0">
                <td className={`${td} ps-4 font-medium`}>{r.product_name}</td>
                <td className={`${td} text-center`}>{r.ordered_qty ?? '—'}</td>
                {hasReceived && <td className={`${td} text-center`}>{r.received_qty ?? '—'}</td>}
                <td className={`${td} text-center`}>{r.billed_qty}</td>
                <td className={`${td} text-end`}>{price(r.order_unit_net)}</td>
                <td className={`${td} text-end`}>{price(r.billed_unit_net)}</td>
                <td className={`${td} pe-4`}>
                  {r.issue ? (
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${ISSUE_PILL[r.issue]}`}>
                      {t(`purchasing.matchIssue_${r.issue}`, { pct: r.price_diff_pct ?? '' })}
                    </span>
                  ) : (
                    <span className="text-xs text-green-700 dark:text-green-400">{t('purchasing.matchLineOk')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {vendorInvoice.price_variance_reason && (
        <div className="px-4 py-3 border-t border-[#e6e9ef] dark:border-[#212a38] text-sm">
          <span className="text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.priceReasonGiven')}: </span>
          <span className="text-[#211f1b] dark:text-[#e8ebf0]">{vendorInvoice.price_variance_reason}</span>
        </div>
      )}
      <p className="px-4 pb-3 text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.matchHint')}</p>
    </div>
  )
}
