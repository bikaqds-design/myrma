import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import Pagination from '../../components/Pagination'
import { SearchInput } from '../../components/SearchInput'
import { Input, Label } from '../../components/ui'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { SOURCE_TYPE_KEYS, accountName, entryTotal, sourceLink } from './_ledger'

// Accounting › Journal (A-01c). Read-only: every entry was written by the
// posting engine from a document step; a mistake is corrected by a reversal,
// which shows here as its own entry.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const th = 'px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]'

export default function JournalTab({ perPage, setPerPage }) {
  const { t, i18n } = useTranslation()
  const [page, setPage] = useState(1)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(() => new Set())
  const debouncedSearch = useDebouncedValue(search)
  useEffect(() => setPage(1), [debouncedSearch, from, to, perPage])

  const { data: result, isLoading, error } = useQuery({
    queryKey: ['ledger', 'journal', page, perPage, from, to, debouncedSearch],
    queryFn: () => db.ledger.journalPage(page, perPage, { from, to, search: debouncedSearch }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  const rows = result?.data ?? EMPTY_ARRAY
  const count = result?.count ?? 0

  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder={t('accounting.glSearch')} className="max-w-md" />
        <div>
          <Label htmlFor="gl-from">{t('accounting.glFrom')}</Label>
          <Input id="gl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="gl-to">{t('accounting.glTo')}</Label>
          <Input id="gl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              <th className={`${th} text-start`}>{t('accounting.glColEntry')}</th>
              <th className={`${th} text-start`}>{t('accounting.colDate')}</th>
              <th className={`${th} text-start`}>{t('accounting.glColSource')}</th>
              <th className={`${th} text-start`}>{t('accounting.glColMemo')}</th>
              <th className={`${th} text-end`}>{t('accounting.colAmount')}</th>
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
              rows.map((e) => {
                const href = sourceLink(e)
                const isOpen = open.has(e.id)
                return (
                  <React.Fragment key={e.id}>
                    <tr className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => toggle(e.id)}
                          aria-expanded={isOpen}
                          aria-controls={`gl-lines-${e.id}`}
                          className="font-mono text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                        >
                          {e.entry_no}
                        </button>
                        {e.reverses_entry_id && (
                          <span className="ms-2 text-[11px] px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
                            {t('accounting.glReversal')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[#6c6760] dark:text-[#9aa4b2]">{e.entry_date}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
                          {SOURCE_TYPE_KEYS[e.source_type] ? t(SOURCE_TYPE_KEYS[e.source_type]) : e.source_type}
                        </span>{' '}
                        {href ? (
                          <Link to={href} className="font-mono text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc] hover:underline">
                            {e.source_code || '—'}
                          </Link>
                        ) : (
                          <span className="font-mono text-xs text-[#211f1b] dark:text-[#e8ebf0]">{e.source_code || '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[#6c6760] dark:text-[#9aa4b2]">{e.memo || ''}</td>
                      <td className="px-4 py-3 text-end font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(entryTotal(e))}</td>
                    </tr>
                    {isOpen && (
                      <tr id={`gl-lines-${e.id}`} className="border-b border-[#f0f2f6] dark:border-[#1a2230] bg-[#f8f9fb] dark:bg-[#0f1520]">
                        <td colSpan={5} className="px-4 py-2">
                          <table className="w-full text-xs">
                            <thead>
                              <tr>
                                <th className="py-1 text-start font-semibold text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.glColAccount')}</th>
                                <th className="py-1 text-end font-semibold text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.glDebit')}</th>
                                <th className="py-1 text-end font-semibold text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.glCredit')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {e.journal_lines.map((l) => (
                                <tr key={l.id}>
                                  <td className="py-1 text-[#211f1b] dark:text-[#e8ebf0]">
                                    <span className="font-mono">{l.account?.code}</span> {accountName(l.account, i18n.language)}
                                  </td>
                                  <td className="py-1 text-end text-[#211f1b] dark:text-[#e8ebf0]">{Number(l.debit) > 0 ? fmtMoney(l.debit) : ''}</td>
                                  <td className="py-1 text-end text-[#211f1b] dark:text-[#e8ebf0]">{Number(l.credit) > 0 ? fmtMoney(l.credit) : ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      {count > 0 && <Pagination total={count} page={page} itemsPerPage={perPage} setItemsPerPage={setPerPage} onPage={setPage} />}
    </div>
  )
}
