import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { db } from '../../api/supabaseClient'
import { Button, Spinner } from '../../components/ui'
import Pagination from '../../components/Pagination'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { useBaseCurrency } from '../../hooks/useBaseCurrency'
import { accountName } from './_ledger'
import { areaMatches, differenceReason, reconDocLink } from './_reports'

// Accounting › Ledger checks (A-08b, rma_subledger_reconciliation): does the
// ledger agree with the records behind it? Receivables against every customer
// statement, payables against every supplier statement (matched per document,
// so a difference names the document), inventory against the cost of the stock
// on hand. As things stand now; documents final before the ledger started were
// never posted and show as such.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const card = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]'
const th = 'px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]'
const td = 'px-3 py-2 text-[#211f1b] dark:text-[#e8ebf0]'

function Figure({ label, value, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-[#6c6760] dark:text-[#9aa4b2]">{label}</span>
      <span className={`tabular-nums ${strong ? 'font-bold' : ''} text-[#211f1b] dark:text-[#e8ebf0]`}>{fmtMoney(value)}</span>
    </div>
  )
}

function Differences({ area }) {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(25)
  const { data, isLoading, error } = useQuery({
    queryKey: ['ledger', 'reconciliation-differences', area, page, perPage],
    queryFn: () => db.ledger.reconciliationDifferences(area, page, perPage),
    placeholderData: keepPreviousData,
  })
  const rows = data?.data ?? EMPTY_ARRAY
  return (
    <div className="space-y-2">
      <div className="border border-[#e6e9ef] dark:border-[#212a38] rounded-[10px] overflow-x-auto">
        <table className="w-full text-sm" aria-label={t(`accounting.recArea_${area}`)}>
          <thead>
            <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              <th className={`${th} text-start`}>{t('accounting.recColDocument')}</th>
              <th className={`${th} text-start`}>{t(area === 'payables' ? 'accounting.recColSupplier' : 'accounting.recColCustomer')}</th>
              <th className={`${th} text-end`}>{t('accounting.recColRecords')}</th>
              <th className={`${th} text-end`}>{t('accounting.recColLedger')}</th>
              <th className={`${th} text-start`}>{t('accounting.recColWhy')}</th>
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr><td colSpan={5} role="alert" className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error.message}</td></tr>
            ) : isLoading ? (
              <tr><td colSpan={5} className="py-6"><div className="flex justify-center"><Spinner /></div></td></tr>
            ) : rows.map((r) => {
              const href = reconDocLink(r)
              const code = r.doc_code || '—'
              return (
                <tr key={r.doc_id} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                  <td className={td}>
                    <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t(`accounting.recDoc_${r.doc_type}`, { defaultValue: r.doc_type })} </span>
                    {href
                      ? <Link to={href} className="font-mono text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc] hover:underline">{code}</Link>
                      : <span className="font-mono text-xs">{code}</span>}
                    {r.doc_date && <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] tabular-nums">{r.doc_date}</div>}
                  </td>
                  <td className={td}>{r.party_name || '—'}</td>
                  <td className={`${td} text-end tabular-nums`}>{fmtMoney(r.subledger_amount)}</td>
                  <td className={`${td} text-end tabular-nums`}>{fmtMoney(r.ledger_amount)}</td>
                  <td className={`${td} text-xs`}>{t(differenceReason(r))}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {(data?.count ?? 0) > perPage && (
        <Pagination total={data.count} page={page} itemsPerPage={perPage} setItemsPerPage={(n) => { setPerPage(n); setPage(1) }} onPage={setPage} />
      )}
    </div>
  )
}

function AreaCard({ row, baseCurrency, open, onToggle }) {
  const { t, i18n } = useTranslation()
  const ok = areaMatches(row)
  const matched = row.area !== 'inventory'
  return (
    <section className={`${card} p-[18px] space-y-3`} aria-label={t(`accounting.recArea_${row.area}`)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t(`accounting.recArea_${row.area}`)}</h3>
          {row.account_code && (
            <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
              <span className="font-mono">{row.account_code}</span> {accountName({ name: row.account_name, name_ar: row.account_name_ar }, i18n.language)}
            </p>
          )}
        </div>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ok
          ? 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400'
          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400'}`}>
          {t(ok ? 'accounting.recMatches' : 'accounting.recDiffers')}
        </span>
      </div>
      <div className="space-y-1">
        <Figure label={t('accounting.recLedger')} value={row.ledger_balance} />
        <Figure label={t(`accounting.recRecords_${row.area}`)} value={row.subledger_balance} />
        <Figure label={t('accounting.recDifference', { currency: baseCurrency })} value={row.difference} strong />
      </div>
      {matched && Number(row.documents_differing) > 0 && (
        <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
          {t('accounting.recDocsDiffer', { count: Number(row.documents_differing), before: Number(row.documents_before_ledger) || 0 })}
        </p>
      )}
      {row.area === 'inventory' && (
        <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
          {t('accounting.recInventoryNote')}
          {Number(row.uncosted_units) > 0 && <> {t('accounting.recUncosted', { count: Number(row.uncosted_units) })}</>}
        </p>
      )}
      {matched && Number(row.documents_differing) > 0 && (
        <Button size="sm" variant="secondary" onClick={onToggle} aria-expanded={open} aria-controls="ledger-check-docs">
          {t(open ? 'accounting.recHideDocs' : 'accounting.recShowDocs')}
        </Button>
      )}
    </section>
  )
}

export default function LedgerChecksTab() {
  const { t } = useTranslation()
  const baseCurrency = useBaseCurrency()
  // one area's documents at a time, full width under the cards (a card is too
  // narrow for the table)
  const [openArea, setOpenArea] = useState(null)
  const { data: rows = EMPTY_ARRAY, isLoading, error } = useQuery({
    queryKey: ['ledger', 'reconciliation'],
    queryFn: () => db.ledger.reconciliation(),
    staleTime: 30_000,
  })
  return (
    <div className="space-y-4">
      <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] max-w-[75ch]">{t('accounting.recHint')}</p>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error.message}</p>
      ) : isLoading ? (
        <div className="py-12 flex justify-center"><Spinner /></div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3 items-start">
            {rows.map((r) => (
              <AreaCard key={r.area} row={r} baseCurrency={baseCurrency} open={openArea === r.area}
                onToggle={() => setOpenArea((a) => (a === r.area ? null : r.area))} />
            ))}
          </div>
          {openArea && (
            <section id="ledger-check-docs" className="space-y-2">
              <h3 className="text-sm font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t(`accounting.recArea_${openArea}`)}</h3>
              <Differences key={openArea} area={openArea} />
            </section>
          )}
        </>
      )}
    </div>
  )
}
