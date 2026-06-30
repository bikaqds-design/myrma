import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { useURLTab } from '../../hooks/useURLTab'
import { Button, PageHeader } from '../../components/ui'
import { PageSkeleton } from '../../components/Skeleton'
import { RecordPaymentModal } from './_modals'

const METHOD_LABEL_KEY = {
  cash: 'accounting.methodCash',
  bank_transfer: 'accounting.methodBankTransfer',
  check: 'accounting.methodCheck',
  card: 'accounting.methodCard',
  other: 'accounting.methodOther',
}

const STATUS_PILL = {
  active: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  voided: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
}

const BUCKET_KEYS = ['current', 'd31_60', 'd61_90', 'd90_plus']
const BUCKET_LABEL_KEY = {
  current: 'accounting.bucketCurrent',
  d31_60: 'accounting.bucket31_60',
  d61_90: 'accounting.bucket61_90',
  d90_plus: 'accounting.bucket90Plus',
}

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function Accounting({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [tab, setTab] = useURLTab('tab', 'payments')
  const [showRecordModal, setShowRecordModal] = useState(false)
  const [search, setSearch] = useState('')

  const { data: payments = [], isLoading: paymentsLoading } = useQuery({
    queryKey: ['payments'],
    queryFn: () => db.payments.list(),
    staleTime: 30_000,
  })
  const { data: aging = [], isLoading: agingLoading } = useQuery({
    queryKey: ['ar-aging'],
    queryFn: () => db.customerLedger.agingReport(),
    staleTime: 30_000,
    enabled: tab === 'aging',
  })
  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: () => db.customers.list(),
    staleTime: 60_000,
  })

  const customerMap = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c])), [customers])
  const customerName = (id) => customerMap[id]?.company_name || customerMap[id]?.contact_person || '—'

  const filteredPayments = useMemo(() => {
    const q = search.trim().toLowerCase()
    const sorted = [...payments].sort((a, b) => new Date(b.payment_date) - new Date(a.payment_date))
    if (!q) return sorted
    return sorted.filter(
      (p) =>
        (p.payment_code || '').toLowerCase().includes(q) ||
        customerName(p.customer_id).toLowerCase().includes(q) ||
        (p.reference_number || '').toLowerCase().includes(q)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payments, search, customerMap])

  const agingByCustomer = useMemo(() => {
    const map = new Map()
    for (const row of aging) {
      const cur = map.get(row.customer_id) || {
        customer_id: row.customer_id,
        current: 0,
        d31_60: 0,
        d61_90: 0,
        d90_plus: 0,
        total: 0,
      }
      cur[row.bucket] += row.remaining
      cur.total += row.remaining
      map.set(row.customer_id, cur)
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  }, [aging])

  const agingTotals = useMemo(
    () =>
      agingByCustomer.reduce(
        (acc, r) => {
          acc.current += r.current
          acc.d31_60 += r.d31_60
          acc.d61_90 += r.d61_90
          acc.d90_plus += r.d90_plus
          acc.total += r.total
          return acc
        },
        { current: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 }
      ),
    [agingByCustomer]
  )

  const handleRecorded = () => {
    setShowRecordModal(false)
    queryClient.invalidateQueries({ queryKey: ['payments'] })
    queryClient.invalidateQueries({ queryKey: ['ar-aging'] })
    queryClient.invalidateQueries({ queryKey: ['sales-documents'] })
  }

  if ((tab === 'payments' && paymentsLoading) || (tab === 'aging' && agingLoading)) {
    return <PageSkeleton cols={6} />
  }

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <PageHeader title={t('accounting.title')} subtitle={t('accounting.subtitle')}>
        <Button onClick={() => setShowRecordModal(true)}>+ {t('accounting.recordPayment')}</Button>
      </PageHeader>

      {showRecordModal && (
        <RecordPaymentModal
          customers={customers}
          currentUserEmail={currentUserEmail}
          onClose={() => setShowRecordModal(false)}
          onRecorded={handleRecorded}
        />
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#e6e9ef] dark:border-[#212a38]">
        {[
          { id: 'payments', label: t('accounting.tabPayments') },
          { id: 'aging', label: t('accounting.tabAging') },
        ].map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              tab === tb.id
                ? 'border-[#4338ca] dark:border-[#a5b4fc] text-[#4338ca] dark:text-[#a5b4fc]'
                : 'border-transparent text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]'
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'payments' && (
        <>
          <div className="relative max-w-md">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('accounting.searchPlaceholder')}
              className="w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none"
            />
          </div>

          <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('accounting.colCode')}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('accounting.colCustomer')}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('accounting.colMethod')}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('accounting.colReference')}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('accounting.colDate')}</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('accounting.colAmount')}</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('accounting.colUnapplied')}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('accounting.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredPayments.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
                      <div className="py-16 flex flex-col items-center text-center">
                        <svg className="w-12 h-12 text-[#a09d99] dark:text-[#4a5568] mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
                        </svg>
                        <p className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.noPayments')}</p>
                        <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">{t('accounting.noPaymentsHint')}</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredPayments.map((p) => (
                    <tr key={p.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230] last:border-0 hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520]">
                      <td className="px-4 py-3 font-mono text-xs text-[#211f1b] dark:text-[#e8ebf0]">{p.payment_code}</td>
                      <td className="px-4 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{customerName(p.customer_id)}</td>
                      <td className="px-4 py-3 text-[#6c6760] dark:text-[#9aa4b2]">{t(METHOD_LABEL_KEY[p.method] ?? p.method)}</td>
                      <td className="px-4 py-3 text-[#6c6760] dark:text-[#9aa4b2]">{p.reference_number || '—'}</td>
                      <td className="px-4 py-3 text-[#6c6760] dark:text-[#9aa4b2]">{p.payment_date}</td>
                      <td className="px-4 py-3 text-right font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(p.amount)}</td>
                      <td className="px-4 py-3 text-right text-[#6c6760] dark:text-[#9aa4b2]">{p.unapplied_amount > 0 ? fmtMoney(p.unapplied_amount) : '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_PILL[p.status] ?? STATUS_PILL.active}`}>
                          {t(`accounting.status_${p.status}`)}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'aging' && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] p-3">
              <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-0.5">{t('accounting.totalOutstanding')}</div>
              <div className="font-bold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(agingTotals.total)}</div>
            </div>
            {BUCKET_KEYS.map((b) => (
              <div key={b} className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] p-3">
                <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-0.5">{t(BUCKET_LABEL_KEY[b])}</div>
                <div className={`font-bold ${b === 'd90_plus' ? 'text-red-600 dark:text-red-400' : 'text-[#211f1b] dark:text-[#e8ebf0]'}`}>
                  {fmtMoney(agingTotals[b])}
                </div>
              </div>
            ))}
          </div>

          <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('accounting.colCustomer')}</th>
                  {BUCKET_KEYS.map((b) => (
                    <th key={b} className="px-4 py-3 text-right text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t(BUCKET_LABEL_KEY[b])}</th>
                  ))}
                  <th className="px-4 py-3 text-right text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('accounting.colTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {agingByCustomer.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="py-16 flex flex-col items-center text-center">
                        <svg className="w-12 h-12 text-[#a09d99] dark:text-[#4a5568] mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <p className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.noOutstanding')}</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  agingByCustomer.map((r) => (
                    <tr key={r.customer_id} className="border-b border-[#f0f2f6] dark:border-[#1a2230] last:border-0 hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520]">
                      <td className="px-4 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{customerName(r.customer_id)}</td>
                      {BUCKET_KEYS.map((b) => (
                        <td key={b} className="px-4 py-3 text-right text-[#6c6760] dark:text-[#9aa4b2]">{r[b] > 0 ? fmtMoney(r[b]) : '—'}</td>
                      ))}
                      <td className="px-4 py-3 text-right font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(r.total)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
