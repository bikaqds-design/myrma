import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../../lib/sentry'

export default function DataCleanup() {
  const { t } = useTranslation()
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
    } catch (err) {
      captureException(err)
      toast.error(t('cp.dataCleanup.loadFailed'))
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
    if (!confirm(t('cp.dataCleanup.deleteConfirm', { count: list.length, label }))) return
    setWorking(true)
    try {
      ;(await db.rmaTickets.bulkDelete)
        ? db.rmaTickets.bulkDelete(list.map((t) => t.id))
        : Promise.all(list.map((t) => db.rmaTickets.delete(t.id)))
      toast.success(t('cp.dataCleanup.deleted', { count: list.length, label }))
      load()
    } catch (err) {
      captureException(err)
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
          {working ? t('cp.dataCleanup.working') : actionLabel}
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
        <h2 className="text-lg font-semibold text-gray-900">{t('cp.dataCleanup.header')}</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          {t('cp.dataCleanup.subtitle')}
        </p>
      </div>

      {/* Ticket cleanup */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm space-y-5">
        <h3 className="text-base font-semibold text-gray-900">{t('cp.dataCleanup.ticketCleanup')}</h3>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {t('cp.dataCleanup.completedOlderThan')}
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
                {t('cp.dataCleanup.daysFound', { count: staleCompleted.length })}
              </span>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {t('cp.dataCleanup.cancelledOlderThan')}
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
                {t('cp.dataCleanup.daysFound', { count: staleCancelled.length })}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-2xl font-bold text-gray-900">{staleCompleted.length}</span>
                <p className="text-sm text-gray-600">{t('cp.dataCleanup.staleCompleted')}</p>
                <p className="text-xs text-gray-500">{t('cp.dataCleanup.completedAgo', { days: completedDays })}</p>
              </div>
              <span className="text-3xl">✅</span>
            </div>
            <button
              onClick={() => handleDeleteTickets(staleCompleted, 'completed')}
              disabled={staleCompleted.length === 0 || working}
              className="w-full py-1.5 text-sm font-medium rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('cp.dataCleanup.deleteCompleted', { count: staleCompleted.length })}
            </button>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-2xl font-bold text-gray-900">{staleCancelled.length}</span>
                <p className="text-sm text-gray-600">{t('cp.dataCleanup.staleCancelled')}</p>
                <p className="text-xs text-gray-500">{t('cp.dataCleanup.cancelledAgo', { days: cancelledDays })}</p>
              </div>
              <span className="text-3xl">❌</span>
            </div>
            <button
              onClick={() => handleDeleteTickets(staleCancelled, 'cancelled')}
              disabled={staleCancelled.length === 0 || working}
              className="w-full py-1.5 text-sm font-medium rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('cp.dataCleanup.deleteCancelled', { count: staleCancelled.length })}
            </button>
          </div>
        </div>
      </div>

      {/* Customer quality */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm space-y-5">
        <h3 className="text-base font-semibold text-gray-900">{t('cp.dataCleanup.customerQuality')}</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-2xl font-bold text-gray-900">{orphanCustomers.length}</span>
                <p className="text-sm text-gray-600">{t('cp.dataCleanup.noTickets')}</p>
                <p className="text-xs text-gray-500">{t('cp.dataCleanup.neverSubmitted')}</p>
              </div>
              <span className="text-3xl">👤</span>
            </div>
            <button
              onClick={() => setPreview({ type: 'orphans', items: orphanCustomers })}
              disabled={orphanCustomers.length === 0}
              className="w-full py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('cp.dataCleanup.reviewList')}
            </button>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-2xl font-bold text-amber-600">{duplicateGroups.length}</span>
                <p className="text-sm text-gray-600">{t('cp.dataCleanup.duplicates')}</p>
                <p className="text-xs text-gray-500">{t('cp.dataCleanup.sameCompany')}</p>
              </div>
              <span className="text-3xl">⚠️</span>
            </div>
            <button
              onClick={() => setPreview({ type: 'duplicates', items: duplicateGroups })}
              disabled={duplicateGroups.length === 0}
              className="w-full py-1.5 text-sm font-medium rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('cp.dataCleanup.reviewDuplicates')}
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
                ? t('cp.dataCleanup.noTicketsHeader', { count: preview.items.length })
                : t('cp.dataCleanup.duplicatesHeader', { count: preview.items.length })}
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
                    {t('cp.dataCleanup.groupRecords', { count: group.length })}
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
            {t('cp.dataCleanup.mergeHint')}
          </p>
        </div>
      )}
    </div>
  )
}
