import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { Spinner, Table } from '../../components/ui'

const STATUS_STYLES = {
  pending:   'bg-gray-100 text-gray-600 dark:bg-[#1a2230] dark:text-[#9aa4b2]',
  queued:    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  sent:      'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-[#a5b4fc]',
  delivered: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  read:      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  failed:    'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  cancelled: 'bg-gray-100 text-gray-600 dark:bg-[#1a2230] dark:text-[#a4acb7]',
}

const PAGE_SIZE = 25

export default function WALogs() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [page, setPage]         = useState(0)
  const [provider, setProvider] = useState('')
  const [status, setStatus]     = useState('')
  const [search, setSearch]     = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [exporting, setExporting] = useState(false)
  const [retrying, setRetrying]   = useState(null)
  const [showFilters, setShowFilters] = useState(false)

  const queryKey = ['notification-logs', page, provider, status, search, dateFrom, dateTo]

  const { data, isLoading, isFetching } = useQuery({
    queryKey,
    queryFn: () =>
      db.notificationLogs.list({
        page, pageSize: PAGE_SIZE,
        provider: provider || undefined,
        status:   status   || undefined,
        search:   search   || undefined,
        dateFrom: dateFrom || undefined,
        dateTo:   dateTo   || undefined,
      }),
    keepPreviousData: true,
  })

  const { data: stats } = useQuery({
    queryKey: ['notification-log-stats'],
    queryFn: () => db.notificationLogs.stats(),
    staleTime: 30_000,
  })

  const logs      = data?.data ?? []
  const count     = data?.count ?? 0
  const totalPages = data?.totalPages ?? 1

  const handleRetry = async (log) => {
    setRetrying(log.id)
    try {
      await db.notificationLogs.retry(log.id)
      // Trigger worker immediately
      await import('../../api/supabaseClient').then(({ db: _db }) => {})
      const { supabase } = await import('../../api/client.js')
      void supabase.functions.invoke('notification-worker').catch(() => {})
      toast.success(t('cp.waLogs.retryQueued'))
      qc.invalidateQueries({ queryKey: ['notification-logs'] })
    } catch (err) {
      toast.error(t('cp.waLogs.retryFailed', { error: err.message }))
    } finally {
      setRetrying(null)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const rows = await db.notificationLogs.exportCSV({
        provider: provider || undefined,
        status:   status   || undefined,
        dateFrom: dateFrom || undefined,
        dateTo:   dateTo   || undefined,
      })
      const headers = ['id','event_type','provider','recipient','recipient_name','delivery_status','sent_at','delivered_at','error_message','retry_count']
      const csvRows = [
        headers.join(','),
        ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? '')).join(',')),
      ]
      const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `notification-logs-${new Date().toISOString().slice(0,10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(t('cp.waLogs.exported', { count: rows.length }))
    } catch (err) {
      toast.error(t('cp.waLogs.exportFailed', { error: err.message }))
    } finally {
      setExporting(false)
    }
  }

  const fmt = (d) => d ? new Date(d).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'

  return (
    <div className="space-y-5">
      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { labelKey: 'cp.waLogs.statTotal',     value: stats.total,     color: 'bg-gray-50 dark:bg-[#121823] text-gray-700 dark:text-[#e8ebf0]' },
            { labelKey: 'cp.waLogs.statSent',      value: stats.sent,      color: 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-[#a5b4fc]' },
            { labelKey: 'cp.waLogs.statDelivered', value: stats.delivered, color: 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' },
            { labelKey: 'cp.waLogs.statRead',      value: stats.read,      color: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' },
            { labelKey: 'cp.waLogs.statFailed',    value: stats.failed,    color: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400' },
          ].map((s) => (
            <div key={s.labelKey} className={`rounded-xl p-3 border border-[#e6e9ef] dark:border-[#212a38] ${s.color}`}>
              <p className="text-xl font-bold">{s.value ?? 0}</p>
              <p className="text-xs font-medium opacity-80">{t(s.labelKey)}</p>
            </div>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }}
            placeholder={t('cp.waLogs.searchPlaceholder')}
            aria-label={t('cp.waLogs.searchPlaceholder')}
            className="w-full ps-9 pe-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#746f65] dark:placeholder:text-[#a4acb7]" />
          <svg className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute start-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          aria-expanded={showFilters}
          aria-controls="walogs-filters-panel"
          className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${
            showFilters || provider || status || dateFrom || dateTo
              ? 'border-indigo-500 text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 dark:border-indigo-400 dark:text-indigo-300'
              : 'border-[#e6e9ef] dark:border-[#212a38] text-gray-700 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230]'
          }`}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
          </svg>
          {t('common.filters')}
          {[provider, status, dateFrom, dateTo].filter(Boolean).length > 0 && (
            <span className="w-4 h-4 bg-indigo-600 text-white text-xs rounded-full flex items-center justify-center">
              {[provider, status, dateFrom, dateTo].filter(Boolean).length}
            </span>
          )}
        </button>
        <button onClick={handleExport} disabled={exporting}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-[#e6e9ef] dark:border-[#212a38] rounded-lg hover:bg-gray-50 dark:hover:bg-[#1a2230] text-gray-700 dark:text-[#e8ebf0] transition-colors disabled:opacity-50">
          {exporting ? <Spinner size="sm" /> : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          )}
          {t('cp.waLogs.exportCsv')}
        </button>
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2] ms-auto whitespace-nowrap">
          {isFetching ? 'Loading…' : `${count.toLocaleString()} result${count !== 1 ? 's' : ''}`}
        </p>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div id="walogs-filters-panel" className="p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0) }} className={inp}>
              <option value="">{t('cp.waLogs.allStatuses')}</option>
              {Object.keys(STATUS_STYLES).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setPage(0) }} className={inp}>
              <option value="">{t('cp.waLogs.allProviders')}</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
            </select>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inp} />
            <input type="date" value={dateTo}   onChange={(e) => setDateTo(e.target.value)}   className={inp} />
          </div>
          {[provider, status, dateFrom, dateTo].filter(Boolean).length > 0 && (
            <button
              onClick={() => { setProvider(''); setStatus(''); setDateFrom(''); setDateTo(''); setPage(0) }}
              className="mt-3 text-sm text-red-500 dark:text-red-400 hover:underline"
            >
              {t('common.clear')}
            </button>
          )}
        </div>
      )}

      {/* Table */}
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : logs.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-gray-500 dark:text-[#9aa4b2]">{t('cp.waLogs.noLogs')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table
              caption={t('cp.waLogs.statusCol')}
              columns={[
                {
                  key: 'sent',
                  header: t('cp.waLogs.dateCol'),
                  cellClassName: 'text-xs text-gray-500 dark:text-[#9aa4b2] whitespace-nowrap',
                  cell: (log) => fmt(log.sent_at),
                },
                {
                  key: 'recipient',
                  header: t('cp.waLogs.recipientCol'),
                  cell: (log) => (
                    <>
                      {/* A phone number inside Arabic text reorders without isolation. */}
                      <p className="font-medium text-gray-800 dark:text-[#e8ebf0] font-mono text-xs" dir="ltr">
                        {log.recipient}
                      </p>
                      {log.recipient_name && (
                        <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">{log.recipient_name}</p>
                      )}
                    </>
                  ),
                },
                {
                  key: 'event',
                  header: t('cp.waLogs.eventCol'),
                  cellClassName: 'text-xs text-gray-600 dark:text-[#9aa4b2] whitespace-nowrap',
                  cell: (log) => log.event_type,
                },
                {
                  key: 'provider',
                  header: t('cp.waLogs.providerCol'),
                  cell: (log) => (
                    <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-indigo-100 text-indigo-700 dark:bg-[#1e1b4b] dark:text-[#a5b4fc]">
                      {log.provider}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: t('cp.waLogs.statusCol'),
                  cell: (log) => (
                    <div className="flex flex-col gap-1">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_STYLES[log.delivery_status] || ''}`}
                      >
                        {log.delivery_status}
                      </span>
                      {log.error_message && (
                        <p
                          className="text-[10px] text-red-500 dark:text-red-400 max-w-[160px] truncate"
                          title={log.error_message}
                        >
                          {log.error_message}
                        </p>
                      )}
                      {log.delivered_at && (
                        <p className="text-[10px] text-gray-400 dark:text-[#a4acb7]">✓ {fmt(log.delivered_at)}</p>
                      )}
                      {log.read_at && <p className="text-[10px] text-emerald-500">👁 {fmt(log.read_at)}</p>}
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  header: t('cp.waLogs.actionsCol'),
                  cell: (log) =>
                    log.delivery_status === 'failed' ? (
                      <button
                        onClick={() => handleRetry(log)}
                        disabled={retrying === log.id}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-600 dark:text-[#a5b4fc] rounded-lg hover:bg-indigo-50 dark:hover:bg-[#1e1b4b] disabled:opacity-50"
                      >
                        {retrying === log.id ? <Spinner size="sm" /> : t('cp.waLogs.retry')}
                      </button>
                    ) : null,
                },
              ]}
              rows={logs}
              rowKey={(log) => log.id}
              empty={{ preset: 'search' }}
            />
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">
            {t('cp.waLogs.pagination', { page: page + 1, total: totalPages, count: count.toLocaleString() })}
          </p>
          <div className="flex gap-2">
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1.5 text-xs border border-[#e6e9ef] dark:border-[#212a38] rounded-lg hover:bg-gray-50 dark:hover:bg-[#1a2230] disabled:opacity-40 text-gray-700 dark:text-[#e8ebf0]">
              {t('cp.waLogs.prev')}
            </button>
            <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1.5 text-xs border border-[#e6e9ef] dark:border-[#212a38] rounded-lg hover:bg-gray-50 dark:hover:bg-[#1a2230] disabled:opacity-40 text-gray-700 dark:text-[#e8ebf0]">
              {t('cp.waLogs.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const inp = 'w-full px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent'
