import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { Table, Pagination } from '../../components/ui'
import toast from 'react-hot-toast'
import { captureException } from '../../lib/sentry'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { toCsv, downloadCsvText } from '../../lib/csv'

export default function AuditLog() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [filterUser, setFilterUser] = useState('')
  const [filterAction, setFilterAction] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)

  const { data: logs = EMPTY_ARRAY, isLoading: loading, isError, error } = useQuery({
    queryKey: ['audit-log'],
    queryFn: () => db.auditLog.listAll(500),
  })
  useEffect(() => {
    if (isError) {
      captureException(error)
      toast.error(i18next.t('cp.auditLog.loadFailed'))
    }
  }, [isError, error])

  // The query asks for 500 rows and the table rendered every one of them. Paging
  // keeps the DOM small and gives a way to reach the older entries.
  const [page, setPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(25)

  const filtered = useMemo(() => {
    let f = [...logs]
    if (search) {
      const q = search.toLowerCase()
      f = f.filter(
        (l) =>
          l.user_email?.toLowerCase().includes(q) ||
          l.action_type?.toLowerCase().includes(q) ||
          l.action_details?.toLowerCase().includes(q)
      )
    }
    if (filterUser) f = f.filter((l) => l.user_email === filterUser)
    if (filterAction) f = f.filter((l) => l.action_type === filterAction)
    if (filterFrom) f = f.filter((l) => new Date(l.created_date) >= new Date(filterFrom))
    if (filterTo) f = f.filter((l) => new Date(l.created_date) <= new Date(filterTo + 'T23:59:59'))
    return f
  }, [logs, search, filterUser, filterAction, filterFrom, filterTo])

  const handleExport = () => {
    // A third hand-rolled CSV encoder, and the riskiest of them: action_details
    // is free text supplied by whoever wrote the log entry, and user_email and
    // action_type were not escaped at all -- a comma in either shifted every
    // later column (BUG-044).
    const csv = toCsv(
      ['Date', 'User', 'Action', 'Details'],
      filtered.map((l) => [
        new Date(l.created_date).toLocaleString(),
        l.user_email || '',
        l.action_type || '',
        l.action_details || '',
      ]),
    )
    downloadCsvText(csv, `audit-log-${new Date().toISOString().split('T')[0]}.csv`)
    toast.success(t('cp.auditLog.exported', { count: filtered.length }))
  }

  const uniqueUsers = [...new Set(logs.map((l) => l.user_email).filter(Boolean))].sort()
  const uniqueActions = [...new Set(logs.map((l) => l.action_type).filter(Boolean))].sort()
  const clearFilters = () => {
    setSearch('')
    setFilterUser('')
    setFilterAction('')
    setFilterFrom('')
    setFilterTo('')
  }
  const activeFilterCount = [filterUser, filterAction, filterFrom, filterTo].filter(Boolean).length
  const inp =
    'px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent'

  const paged = useMemo(
    () => filtered.slice((page - 1) * itemsPerPage, page * itemsPerPage),
    [filtered, page, itemsPerPage]
  )

  // Filtering while on a later page leaves the page number past the end, which
  // shows an empty table over rows that plainly exist.
  useEffect(() => {
    const lastPage = Math.max(1, Math.ceil(filtered.length / itemsPerPage))
    if (page > lastPage) setPage(1)
  }, [filtered.length, itemsPerPage, page])

  if (loading)
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
      </div>
    )

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t('cp.auditLog.header')}</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('cp.auditLog.subtitle', { count: logs.length })}
          </p>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#e6e9ef] dark:border-[#212a38] text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          {t('cp.auditLog.exportCsv')}
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('cp.auditLog.searchPlaceholder')}
            aria-label={t('cp.auditLog.searchPlaceholder')}
            className="w-full ps-9 pe-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#746f65] dark:placeholder:text-[#a4acb7]"
          />
          <svg
            className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute start-3 top-1/2 -translate-y-1/2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          aria-expanded={showFilters}
          aria-controls="audit-filters-panel"
          className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${
            showFilters || activeFilterCount > 0
              ? 'border-[#4338ca] text-[#4338ca] bg-indigo-50 dark:bg-indigo-900/20 dark:border-[#a5b4fc] dark:text-[#a5b4fc]'
              : 'border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
          </svg>
          {t('common.filters')}
          {activeFilterCount > 0 && (
            <span className="w-4 h-4 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] text-xs rounded-full flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div id="audit-filters-panel" className="p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <select value={filterUser} onChange={(e) => setFilterUser(e.target.value)} className={inp}>
              <option value="">{t('cp.auditLog.allUsers')}</option>
              {uniqueUsers.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
            <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)} className={inp}>
              <option value="">{t('cp.auditLog.allActions')}</option>
              {uniqueActions.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} className={inp} title={t('cp.auditLog.fromDate')} />
            <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} className={inp} title={t('cp.auditLog.toDate')} />
          </div>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="mt-3 text-sm text-red-500 dark:text-red-400 hover:underline">
              {t('common.clear')}
            </button>
          )}
        </div>
      )}

      {/* Only while a filter is narrowing the set. With nothing filtered it read
          "Showing 500 of 500 records" directly above the pager's "Showing 1-25
          of 500" — two sentences starting the same way and appearing to
          contradict each other. */}
      {filtered.length !== logs.length && (
        <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">
          {t('cp.auditLog.showingOf', { filtered: filtered.length, total: logs.length })}
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
          <Table
            caption={t('cp.auditLog.dateTime')}
            stickyHeader
            columns={[
              {
                key: 'when',
                header: t('cp.auditLog.dateTime'),
                cellClassName: 'whitespace-nowrap text-xs text-[#6c6760] dark:text-[#9aa4b2]',
                cell: (l) => new Date(l.created_date).toLocaleString(),
              },
              {
                key: 'user',
                header: t('cp.auditLog.userCol'),
                cellClassName: 'font-medium',
                cell: (l) => l.user_email,
              },
              {
                key: 'action',
                header: t('cp.auditLog.actionCol'),
                cell: (l) => (
                  <span className="px-2 py-0.5 bg-indigo-50 dark:bg-[#1e1b4b] text-indigo-700 dark:text-[#a5b4fc] rounded text-xs font-mono">
                    {l.action_type}
                  </span>
                ),
              },
              {
                key: 'details',
                header: t('cp.auditLog.detailsCol'),
                cellClassName: 'max-w-sm truncate text-[#6c6760] dark:text-[#9aa4b2]',
                cell: (l) => l.action_details || '—',
              },
            ]}
            rows={paged}
            rowKey={(l) => l.id}
            empty={{ title: t('cp.auditLog.noEntries') }}
          />
        </div>
        <div className="px-4 pb-3">
          <Pagination
            total={filtered.length}
            page={page}
            itemsPerPage={itemsPerPage}
            setItemsPerPage={setItemsPerPage}
            onPage={setPage}
          />
        </div>
      </div>
    </div>
  )
}
