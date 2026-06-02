import React, { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { Spinner } from '../../components/ui'

const STATUS_STYLES = {
  pending:   'bg-gray-100 text-gray-600 dark:bg-[#1a2230] dark:text-[#9aa4b2]',
  queued:    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  sent:      'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-[#a5b4fc]',
  delivered: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  read:      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  failed:    'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'bg-gray-100 text-gray-500 dark:bg-[#1a2230] dark:text-[#4a5568]',
}

const PAGE_SIZE = 25

export default function WALogs() {
  const qc = useQueryClient()
  const [page, setPage]         = useState(0)
  const [provider, setProvider] = useState('')
  const [status, setStatus]     = useState('')
  const [search, setSearch]     = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [exporting, setExporting] = useState(false)
  const [retrying, setRetrying]   = useState(null)

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
      toast.success('Queued for retry')
      qc.invalidateQueries({ queryKey: ['notification-logs'] })
    } catch (err) {
      toast.error(`Retry failed: ${err.message}`)
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
      toast.success(`Exported ${rows.length} rows`)
    } catch (err) {
      toast.error(`Export failed: ${err.message}`)
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
            { label: 'Total',     value: stats.total,     color: 'bg-gray-50 dark:bg-[#121823] text-gray-700 dark:text-[#e8ebf0]' },
            { label: 'Sent',      value: stats.sent,      color: 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-[#a5b4fc]' },
            { label: 'Delivered', value: stats.delivered, color: 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' },
            { label: 'Read',      value: stats.read,      color: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' },
            { label: 'Failed',    value: stats.failed,    color: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400' },
          ].map((s) => (
            <div key={s.label} className={`rounded-xl p-3 border border-[#e6e9ef] dark:border-[#212a38] ${s.color}`}>
              <p className="text-xl font-bold">{s.value ?? 0}</p>
              <p className="text-xs font-medium opacity-80">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }}
            placeholder="Search recipient, event…"
            className={inp} />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0) }} className={inp}>
            <option value="">All Statuses</option>
            {Object.keys(STATUS_STYLES).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setPage(0) }} className={inp}>
            <option value="">All Providers</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
          <div className="flex gap-2">
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={`${inp} flex-1`} />
            <input type="date" value={dateTo}   onChange={(e) => setDateTo(e.target.value)}   className={`${inp} flex-1`} />
          </div>
        </div>
        <div className="flex items-center justify-between mt-3">
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">
            {isFetching ? 'Loading…' : `${count.toLocaleString()} result${count !== 1 ? 's' : ''}`}
          </p>
          <button onClick={handleExport} disabled={exporting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-[#e6e9ef] dark:border-[#212a38] rounded-lg hover:bg-gray-50 dark:hover:bg-[#1a2230] text-gray-700 dark:text-[#e8ebf0] transition-colors disabled:opacity-50">
            {exporting ? <Spinner size="sm" /> : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            )}
            Export CSV
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : logs.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-gray-500 dark:text-[#9aa4b2]">No notification logs found</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  {['Date', 'Recipient', 'Event', 'Provider', 'Status', 'Actions'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e6e9ef] dark:divide-[#212a38]">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] transition-colors">
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-[#9aa4b2] whitespace-nowrap">{fmt(log.sent_at)}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800 dark:text-[#e8ebf0] font-mono text-xs">{log.recipient}</p>
                      {log.recipient_name && <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">{log.recipient_name}</p>}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600 dark:text-[#9aa4b2] whitespace-nowrap">{log.event_type}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-indigo-100 text-indigo-700 dark:bg-[#1a2230] dark:text-[#a5b4fc] capitalize">{log.provider}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_STYLES[log.delivery_status] ?? STATUS_STYLES.pending}`}>
                          {log.delivery_status}
                        </span>
                        {log.error_message && (
                          <p className="text-[10px] text-red-500 dark:text-red-400 max-w-[160px] truncate" title={log.error_message}>
                            {log.error_message}
                          </p>
                        )}
                        {log.delivered_at && <p className="text-[10px] text-gray-400 dark:text-[#4a5568]">✓ {fmt(log.delivered_at)}</p>}
                        {log.read_at      && <p className="text-[10px] text-emerald-500">👁 {fmt(log.read_at)}</p>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {log.delivery_status === 'failed' && (
                        <button onClick={() => handleRetry(log)} disabled={retrying === log.id}
                          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-600 dark:text-[#a5b4fc] border border-indigo-200 dark:border-[#212a38] rounded-lg hover:bg-indigo-50 dark:hover:bg-[#1a2230] transition-colors disabled:opacity-50">
                          {retrying === log.id ? <Spinner size="sm" /> : '↻'} Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">
            Page {page + 1} of {totalPages} · {count.toLocaleString()} total
          </p>
          <div className="flex gap-2">
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1.5 text-xs border border-[#e6e9ef] dark:border-[#212a38] rounded-lg hover:bg-gray-50 dark:hover:bg-[#1a2230] disabled:opacity-40 text-gray-700 dark:text-[#e8ebf0]">
              ← Prev
            </button>
            <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1.5 text-xs border border-[#e6e9ef] dark:border-[#212a38] rounded-lg hover:bg-gray-50 dark:hover:bg-[#1a2230] disabled:opacity-40 text-gray-700 dark:text-[#e8ebf0]">
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const inp = 'w-full px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent'
