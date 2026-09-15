import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
// marginTotalsFromRaw comes from its own module: supabaseClient.js is a namespace
// barrel (db, auth, storage, …) and does not forward loose helpers.
import { marginTotalsFromRaw } from '../api/db/margin'
import Pagination from '../components/Pagination'
import { safeStorage } from '../lib/safeStorage'
import { useBaseCurrency } from '../hooks/useBaseCurrency'
import { formatMoney } from '../lib/money'
import EmptyState from '../components/EmptyState'
import { EMPTY_ARRAY } from '../lib/stableEmpty'

/**
 * Profit and loss on what was sold — in total, and per sales rep.
 *
 * The rule this whole screen is built around: AN INVOICE WHOSE COST IS UNKNOWN
 * IS NEVER SHOWN AS PROFIT. A E£100,000 sale with no recorded cost would
 * otherwise appear as E£100,000 of pure margin, indistinguishable from a
 * genuinely excellent deal, and one of them can carry a rep's whole quarter.
 *
 * So margin is measured against COSTED revenue, not total revenue, and the
 * number of invoices that could not be costed is shown on every row rather
 * than tucked into a footnote. A rep whose margin covers three of their twenty
 * invoices should see that at the same moment they see the margin.
 */
export default function ProfitabilityTab() {
  const { t } = useTranslation()
  const baseCurrency = useBaseCurrency()
  const fmt = (v) => (v === null || v === undefined ? '—' : formatMoney(v, baseCurrency))
  const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`)

  // Totals are summed in the database over every invoice, and the invoice table
  // is paged there — it used to read every margin row (capped at 1 000) and add
  // them up here. (BUG-066.)
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(() => safeStorage.get('reportsPerPage', 25))
  useEffect(() => { safeStorage.set('reportsPerPage', perPage) }, [perPage])
  useEffect(() => { setPage(1) }, [perPage])

  const { data: rawTotals, isLoading: loadingTotals } = useQuery({
    queryKey: ['margin', 'totals'],
    queryFn: () => db.margin.totals(),
  })
  const { data: invoiceRes, isLoading: loadingInvoices } = useQuery({
    queryKey: ['margin', 'by-invoice', page, perPage],
    queryFn: () => db.margin.byInvoicePage(page, perPage),
    placeholderData: keepPreviousData,
  })
  const { data: repRes, isLoading: loadingReps } = useQuery({
    queryKey: ['margin', 'by-rep'],
    queryFn: () => db.margin.byRep(),
  })

  const invoices = invoiceRes?.data ?? EMPTY_ARRAY
  const reps = repRes?.data ?? EMPTY_ARRAY
  const missing = invoiceRes?.missing || repRes?.missing || (!loadingTotals && rawTotals === null)
  const totals = rawTotals ? marginTotalsFromRaw(rawTotals) : null

  if (loadingTotals || loadingInvoices || loadingReps) {
    return <div className="py-12 text-center text-sm text-gray-500 dark:text-[#9aa4b2]">{t('common.loading')}</div>
  }

  // The views are created by a migration that may not be applied yet. Saying so
  // is better than an empty table that looks like "no sales".
  if (missing) {
    return (
      <EmptyState
        title={t('reports.marginNotProvisioned')}
        description={t('reports.marginNotProvisionedHint')}
      />
    )
  }

  if (!totals || totals.invoices === 0) {
    return <EmptyState title={t('reports.marginNoInvoices')} description={t('reports.marginNoInvoicesHint')} />
  }

  const th = 'px-4 py-3 text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]'
  const td = 'px-4 py-3 text-sm text-[#211f1b] dark:text-[#e8ebf0]'

  return (
    <div className="space-y-6">
      {/* ── Totals ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label={t('reports.marginRevenue')} value={fmt(totals.revenueBase)} />
        <Tile
          label={t('reports.marginCostedRevenue')}
          value={fmt(totals.costedRevenueBase)}
          hint={t('reports.marginCostedRevenueHint')}
        />
        <Tile label={t('reports.marginCogs')} value={fmt(totals.cogsBase)} />
        <Tile
          label={t('reports.marginProfit')}
          value={fmt(totals.marginBase)}
          hint={pct(totals.marginPct) + ' ' + t('reports.marginOfCosted')}
          accent
        />
      </div>

      {/* The gap, stated plainly rather than left to be inferred from two
          revenue figures that happen to differ. */}
      {totals.invoicesCostUnknown > 0 && (
        <div className="border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 rounded-[14px] p-4">
          <div className="text-sm font-semibold text-amber-900 dark:text-amber-300">
            {t('reports.marginIncompleteTitle', {
              unknown: totals.invoicesCostUnknown,
              total: totals.invoices,
            })}
          </div>
          <p className="text-sm text-amber-800 dark:text-amber-300/90 mt-1">
            {t('reports.marginIncompleteBody', {
              amount: fmt(totals.revenueBase - totals.costedRevenueBase),
            })}
          </p>
        </div>
      )}

      {/* ── Per rep ────────────────────────────────────────────────────────── */}
      <Card title={t('reports.marginByRep')}>
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
            <tr>
              <th className={`${th} text-start`}>{t('reports.marginRep')}</th>
              <th className={`${th} text-end`}>{t('reports.marginInvoices')}</th>
              <th className={`${th} text-end`}>{t('reports.marginRevenue')}</th>
              <th className={`${th} text-end`}>{t('reports.marginCostedRevenue')}</th>
              <th className={`${th} text-end`}>{t('reports.marginCogs')}</th>
              <th className={`${th} text-end`}>{t('reports.marginProfit')}</th>
              <th className={`${th} text-end`}>{t('reports.marginPct')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-[#1a2230]">
            {reps.map((r) => (
              <tr key={r.assigned_rep}>
                <td className={`${td} font-medium`}>{r.assigned_rep}</td>
                <td className={`${td} text-end`}>
                  {r.invoices_total}
                  {r.invoices_cost_unknown > 0 && (
                    <span
                      className="ms-1 text-xs font-semibold text-amber-600 dark:text-amber-400"
                      title={t('reports.marginRepUnknownHint', { n: r.invoices_cost_unknown })}
                    >
                      {' '}({t('reports.marginUnknownShort', { n: r.invoices_cost_unknown })})
                    </span>
                  )}
                </td>
                <td className={`${td} text-end`}>{fmt(r.revenue_base)}</td>
                <td className={`${td} text-end`}>{fmt(r.costed_revenue_base)}</td>
                <td className={`${td} text-end`}>{fmt(r.cogs_base)}</td>
                <td className={`${td} text-end font-semibold`}>{fmt(r.margin_base)}</td>
                <td className={`${td} text-end`}>{pct(r.margin_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* ── Per invoice ────────────────────────────────────────────────────── */}
      <Card title={t('reports.marginByInvoice')}>
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
            <tr>
              <th className={`${th} text-start`}>{t('reports.marginInvoice')}</th>
              <th className={`${th} text-start`}>{t('reports.marginCustomer')}</th>
              <th className={`${th} text-start`}>{t('reports.marginRep')}</th>
              <th className={`${th} text-end`}>{t('reports.marginRevenue')}</th>
              <th className={`${th} text-end`}>{t('reports.marginCogs')}</th>
              <th className={`${th} text-end`}>{t('reports.marginProfit')}</th>
              <th className={`${th} text-end`}>{t('reports.marginPct')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-[#1a2230]">
            {invoices.map((i) => (
              <tr key={i.id}>
                <td className={`${td} font-mono text-xs`}>{i.inv_code || '—'}</td>
                <td className={td}>{i.customer_name || '—'}</td>
                <td className={td}>{i.assigned_rep || '—'}</td>
                <td className={`${td} text-end`}>{fmt(i.revenue_base)}</td>
                <td className={`${td} text-end`}>{i.cogs_complete ? fmt(i.cogs_base) : '—'}</td>
                <td className={`${td} text-end font-semibold`}>
                  {/* Never a number when the cost is incomplete. A dash reads as
                      "cannot tell"; a zero would read as "made nothing". */}
                  {i.cogs_complete ? (
                    fmt(i.margin_base)
                  ) : (
                    <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                      {/* Two different situations, and saying "cost unknown (0)"
                          for the first reads as a contradiction. An invoice
                          posted before costing existed has no cost captured at
                          all; one posted since may have a cost covering only
                          part of what it shipped. */}
                      {i.cogs_unknown_qty > 0
                        ? t('reports.marginUnknown', { n: i.cogs_unknown_qty })
                        : t('reports.marginNotCaptured')}
                    </span>
                  )}
                </td>
                <td className={`${td} text-end`}>{pct(i.margin_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-4 pb-3">
          <Pagination total={invoiceRes?.count ?? 0} page={page} itemsPerPage={perPage} setItemsPerPage={setPerPage} onPage={setPage} />
        </div>
      </Card>
    </div>
  )
}

function Tile({ label, value, hint, accent }) {
  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-4">
      <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2]">{label}</div>
      <div
        className={`text-xl font-bold mt-1 ${
          accent ? 'text-indigo-600 dark:text-[#a5b4fc]' : 'text-[#211f1b] dark:text-[#e8ebf0]'
        }`}
      >
        {value}
      </div>
      {hint && <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">{hint}</div>}
    </div>
  )
}

function Card({ title, children }) {
  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-hidden">
      <div className="px-5 py-3 border-b border-[#e6e9ef] dark:border-[#212a38]">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{title}</h2>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}
