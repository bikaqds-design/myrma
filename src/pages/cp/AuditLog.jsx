import React, { useState, useEffect } from 'react'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../../lib/sentry'

export default function AuditLog() {
  const [logs, setLogs] = useState([])
  const [filtered, setFiltered] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterUser, setFilterUser] = useState('')
  const [filterAction, setFilterAction] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')

  useEffect(() => {
    load()
  }, [])
  useEffect(() => {
    applyFilters()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs, search, filterUser, filterAction, filterFrom, filterTo])

  const load = async () => {
    setLoading(true)
    try {
      const data = await db.auditLog.listAll(500)
      setLogs(data)
    } catch (err) {
      captureException(err)
      toast.error('Failed to load audit log')
    } finally {
      setLoading(false)
    }
  }

  const applyFilters = () => {
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
    setFiltered(f)
  }

  const handleExport = () => {
    const csv = [
      'Date,User,Action,Details',
      ...filtered.map((l) =>
        [
          new Date(l.created_date).toLocaleString(),
          l.user_email || '',
          l.action_type || '',
          `"${(l.action_details || '').replace(/"/g, '""')}"`,
        ].join(',')
      ),
    ].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `audit-log-${new Date().toISOString().split('T')[0]}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    toast.success(`Exported ${filtered.length} records`)
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
  const hasFilters = search || filterUser || filterAction || filterFrom || filterTo
  const inp =
    'px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent'

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
          <h2 className="text-lg font-semibold text-gray-900">Audit Log</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            All user activity across the system — {logs.length} records
          </p>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search user, action, details..."
            className={`w-full pl-9 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent`}
          />
          <svg
            className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        <select value={filterUser} onChange={(e) => setFilterUser(e.target.value)} className={inp}>
          <option value="">All users</option>
          {uniqueUsers.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value)}
          className={inp}
        >
          <option value="">All actions</option>
          {uniqueActions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={filterFrom}
          onChange={(e) => setFilterFrom(e.target.value)}
          className={inp}
          title="From date"
        />
        <input
          type="date"
          value={filterTo}
          onChange={(e) => setFilterTo(e.target.value)}
          className={inp}
          title="To date"
        />
        {hasFilters && (
          <button onClick={clearFilters} className="text-sm text-red-600 hover:underline">
            Clear
          </button>
        )}
      </div>

      <div className="text-xs text-gray-500">
        Showing {filtered.length} of {logs.length} records
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
              <tr>
                {['Date & Time', 'User', 'Action', 'Details'].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-gray-500">
                    No log entries match your filters
                  </td>
                </tr>
              )}
              {filtered.map((l, i) => (
                <tr key={l.id || i} className="hover:bg-gray-50 text-sm">
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                    {new Date(l.created_date).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-gray-700 font-medium">{l.user_email}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded text-xs font-mono">
                      {l.action_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 max-w-sm truncate">
                    {l.action_details || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
