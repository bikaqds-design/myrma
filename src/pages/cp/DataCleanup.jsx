import React, { useState, useEffect } from 'react'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'

export default function DataCleanup() {
  const [tickets, setTickets] = useState([])
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [completedDays, setCompletedDays] = useState(90)
  const [cancelledDays, setCancelledDays] = useState(30)
  const [preview, setPreview] = useState(null)

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    setLoading(true)
    try {
      const [t, c] = await Promise.all([db.rmaTickets.list(), db.customers.list()])
      setTickets(t)
      setCustomers(c)
    } catch {
      toast.error('Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  const cutoff = (days) => {
    const d = new Date()
    d.setDate(d.getDate() - days)
    return d
  }

  const staleCompleted = tickets.filter(
    (t) =>
      t.ticket_status === 'Completed' &&
      t.updated_date &&
      new Date(t.updated_date) < cutoff(completedDays)
  )
  const staleCancelled = tickets.filter(
    (t) =>
      t.ticket_status === 'Cancelled' &&
      t.updated_date &&
      new Date(t.updated_date) < cutoff(cancelledDays)
  )

  const ticketIds = [...new Set(tickets.map((t) => t.customer_name).filter(Boolean))]
  const orphanCustomers = customers.filter((c) => {
    const name = c.customer_type === 'B2B' && c.company_name ? c.company_name : c.contact_person
    return !ticketIds.includes(name)
  })

  const nameCounts = customers.reduce((acc, c) => {
    const name = (c.company_name || c.contact_person || '').toLowerCase().trim()
    if (name) acc[name] = (acc[name] || []).concat(c)
    return acc
  }, {})
  const duplicateGroups = Object.values(nameCounts).filter((g) => g.length > 1)

  const handleDeleteTickets = async (list, label) => {
    if (!list.length) return
    if (!confirm(`Delete ${list.length} ${label} tickets? This cannot be undone.`)) return
    setWorking(true)
    try {
      ;(await db.rmaTickets.bulkDelete)
        ? db.rmaTickets.bulkDelete(list.map((t) => t.id))
        : Promise.all(list.map((t) => db.rmaTickets.delete(t.id)))
      toast.success(`Deleted ${list.length} ${label} tickets`)
      load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setWorking(false)
    }
  }

  // eslint-disable-next-line no-unused-vars
  const StatCard = ({ label, count, sub, color, action, actionLabel, disabled }) => (
    <div
      className={`bg-white rounded-xl border p-5 shadow-sm ${color === 'red' ? 'border-red-200' : color === 'amber' ? 'border-amber-200' : 'border-gray-200'}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div
            className={`text-3xl font-bold ${color === 'red' ? 'text-red-600' : color === 'amber' ? 'text-amber-600' : 'text-gray-900'}`}
          >
            {count}
          </div>
          <div className="text-sm font-medium text-gray-700 mt-1">{label}</div>
          <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
        </div>
      </div>
      {action && (
        <button
          onClick={action}
          disabled={disabled || count === 0 || working}
          className={`mt-4 w-full py-1.5 text-sm font-medium rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            color === 'red'
              ? 'border-red-300 text-red-700 hover:bg-red-50'
              : 'border-gray-300 text-gray-700 hover:bg-gray-50'
          }`}
        >
          {working ? 'Working...' : actionLabel}
        </button>
      )}
    </div>
  )

  if (loading)
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
      </div>
    )

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Data Cleanup</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Remove stale records and identify data quality issues
        </p>
      </div>

      {/* Ticket cleanup */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm space-y-5">
        <h3 className="text-base font-semibold text-gray-900">Ticket Cleanup</h3>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Completed tickets older than (days)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={completedDays}
                onChange={(e) => setCompletedDays(parseInt(e.target.value) || 90)}
                className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
              />
              <span className="text-sm text-gray-500">
                days — <strong>{staleCompleted.length}</strong> tickets found
              </span>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Cancelled tickets older than (days)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={cancelledDays}
                onChange={(e) => setCancelledDays(parseInt(e.target.value) || 30)}
                className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
              />
              <span className="text-sm text-gray-500">
                days — <strong>{staleCancelled.length}</strong> tickets found
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-2xl font-bold text-gray-900">{staleCompleted.length}</span>
                <p className="text-sm text-gray-600">Stale completed tickets</p>
                <p className="text-xs text-gray-500">Completed &gt;{completedDays} days ago</p>
              </div>
              <span className="text-3xl">✅</span>
            </div>
            <button
              onClick={() => handleDeleteTickets(staleCompleted, 'completed')}
              disabled={staleCompleted.length === 0 || working}
              className="w-full py-1.5 text-sm font-medium rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Delete {staleCompleted.length} tickets
            </button>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-2xl font-bold text-gray-900">{staleCancelled.length}</span>
                <p className="text-sm text-gray-600">Stale cancelled tickets</p>
                <p className="text-xs text-gray-500">Cancelled &gt;{cancelledDays} days ago</p>
              </div>
              <span className="text-3xl">❌</span>
            </div>
            <button
              onClick={() => handleDeleteTickets(staleCancelled, 'cancelled')}
              disabled={staleCancelled.length === 0 || working}
              className="w-full py-1.5 text-sm font-medium rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Delete {staleCancelled.length} tickets
            </button>
          </div>
        </div>
      </div>

      {/* Customer quality */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm space-y-5">
        <h3 className="text-base font-semibold text-gray-900">Customer Data Quality</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-2xl font-bold text-gray-900">{orphanCustomers.length}</span>
                <p className="text-sm text-gray-600">Customers with no tickets</p>
                <p className="text-xs text-gray-500">Have never submitted an RMA</p>
              </div>
              <span className="text-3xl">👤</span>
            </div>
            <button
              onClick={() => setPreview({ type: 'orphans', items: orphanCustomers })}
              disabled={orphanCustomers.length === 0}
              className="w-full py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Review list
            </button>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-2xl font-bold text-amber-600">{duplicateGroups.length}</span>
                <p className="text-sm text-gray-600">Potential duplicate groups</p>
                <p className="text-xs text-gray-500">Same company or contact name</p>
              </div>
              <span className="text-3xl">⚠️</span>
            </div>
            <button
              onClick={() => setPreview({ type: 'duplicates', items: duplicateGroups })}
              disabled={duplicateGroups.length === 0}
              className="w-full py-1.5 text-sm font-medium rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Review duplicates
            </button>
          </div>
        </div>
      </div>

      {/* Preview panel */}
      {preview && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">
              {preview.type === 'orphans'
                ? `Customers with no tickets (${preview.items.length})`
                : `Duplicate groups (${preview.items.length})`}
            </h3>
            <button onClick={() => setPreview(null)} className="text-gray-500 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {preview.type === 'orphans' &&
              preview.items.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between py-1.5 px-3 rounded hover:bg-gray-50 text-sm"
                >
                  <span className="text-gray-800">{c.company_name || c.contact_person}</span>
                  <span className="text-xs text-gray-500">
                    {c.customer_type} · {c.customer_status}
                  </span>
                </div>
              ))}
            {preview.type === 'duplicates' &&
              preview.items.map((group, i) => (
                <div key={i} className="mb-3 p-3 bg-amber-50 rounded-lg">
                  <p className="text-xs font-semibold text-amber-800 mb-1.5">
                    {group.length} records with same name:
                  </p>
                  {group.map((c) => (
                    <div key={c.id} className="text-xs text-gray-700 py-0.5">
                      {c.company_name || c.contact_person} · {c.email || c.mobile || 'no contact'} ·
                      created {new Date(c.created_date).toLocaleDateString()}
                    </div>
                  ))}
                </div>
              ))}
          </div>
          <p className="text-xs text-gray-500 mt-3">
            To merge or delete records, go to the Customers page and edit them directly.
          </p>
        </div>
      )}
    </div>
  )
}
