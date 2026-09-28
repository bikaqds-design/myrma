import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { db } from '../../api/supabaseClient'
import { ModalOverlay, ModalCard, Button } from '../../components/ui'
import Pagination from '../../components/Pagination'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { SOURCE_TYPE_KEYS, accountName, sourceLink } from './_ledger'

// Drill-down (A-08a, rma_account_activity): every journal line on one account
// in a period, in date order with a running balance, each naming the entry and
// the document behind it. Paged in the database (BUG-066). `from` null means
// from the first entry.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const th = 'px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]'
const td = 'px-3 py-2 text-[#211f1b] dark:text-[#e8ebf0]'

export default function AccountActivityModal({ account, from, to, onClose }) {
  const { t, i18n } = useTranslation()
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(50)

  const { data, isLoading, error } = useQuery({
    queryKey: ['ledger', 'activity', account.id, from, to, page, perPage],
    queryFn: () => db.ledger.accountActivity(account.id, from, to, page, perPage),
    placeholderData: keepPreviousData,
  })
  const rows = data?.data ?? EMPTY_ARRAY
  const title = `${account.code} ${accountName(account, i18n.language)}`

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={title} className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-4xl w-full">
        <div className="p-5 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-[#211f1b] dark:text-[#e8ebf0]">{title}</h2>
              <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
                {from ? t('accounting.repPeriodLabel', { from, to }) : t('accounting.repUpTo', { to })}
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.close')}</Button>
          </div>

          {from && data?.opening != null && (
            <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
              {t('accounting.repOpening', { date: from })} <span className="font-semibold text-[#211f1b] dark:text-[#e8ebf0] tabular-nums">{fmtMoney(data.opening)}</span>
            </p>
          )}

          <div className="border border-[#e6e9ef] dark:border-[#212a38] rounded-[10px] overflow-x-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
                  <th className={`${th} text-start`}>{t('accounting.repColDate')}</th>
                  <th className={`${th} text-start`}>{t('accounting.glColEntry')}</th>
                  <th className={`${th} text-start`}>{t('accounting.glColSource')}</th>
                  <th className={`${th} text-end`}>{t('accounting.glDebit')}</th>
                  <th className={`${th} text-end`}>{t('accounting.glCredit')}</th>
                  <th className={`${th} text-end`}>{t('accounting.glBalance')}</th>
                </tr>
              </thead>
              <tbody>
                {error ? (
                  <tr><td colSpan={6} role="alert" className="py-8 text-center text-sm text-red-600 dark:text-red-400">{error.message}</td></tr>
                ) : !isLoading && rows.length === 0 ? (
                  <tr><td colSpan={6} className="py-8 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.repNoActivity')}</td></tr>
                ) : rows.map((r, i) => {
                  const href = sourceLink(r)
                  const srcType = SOURCE_TYPE_KEYS[r.source_type] ? t(SOURCE_TYPE_KEYS[r.source_type]) : r.source_type
                  return (
                    <tr key={`${r.entry_id}-${i}`} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                      <td className={`${td} tabular-nums whitespace-nowrap`}>{r.entry_date}</td>
                      <td className={`${td} font-mono text-xs whitespace-nowrap`}>{r.entry_no}</td>
                      <td className={td}>
                        <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{srcType} </span>
                        {href ? (
                          <Link to={href} onClick={onClose} className="font-mono text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc] hover:underline">{r.source_code || '—'}</Link>
                        ) : (
                          <span className="font-mono text-xs">{r.source_code || '—'}</span>
                        )}
                        {r.memo && <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{r.memo}</div>}
                      </td>
                      <td className={`${td} text-end tabular-nums`}>{Number(r.debit) ? fmtMoney(r.debit) : ''}</td>
                      <td className={`${td} text-end tabular-nums`}>{Number(r.credit) ? fmtMoney(r.credit) : ''}</td>
                      <td className={`${td} text-end tabular-nums font-semibold`}>{fmtMoney(r.running_balance)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {(data?.count ?? 0) > 0 && (
            <Pagination total={data.count} page={page} itemsPerPage={perPage} setItemsPerPage={(n) => { setPerPage(n); setPage(1) }} onPage={setPage} />
          )}
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}
