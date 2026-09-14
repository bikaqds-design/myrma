import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { toUserMessage } from '../../lib/errorMessage'
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

  // Data integrity. (Audit finding BUG-041.) Run on demand rather than on
  // mount: the checks scan every invoice, order and unit, and this screen is
  // opened to tidy tickets far more often than to audit the books.
  const [integrity, setIntegrity] = useState(null) // null = not run yet
  const [integrityRows, setIntegrityRows] = useState(null)
  const [integrityLoading, setIntegrityLoading] = useState(false)
  const [expandedCheck, setExpandedCheck] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [tickets, customers] = await Promise.all([db.rmaTickets.list(), db.customers.list()])
      setTickets(tickets)
      setCustomers(customers)
    } catch (err) {
      captureException(err)
      toast.error(i18next.t('cp.dataCleanup.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const runIntegrityChecks = async () => {
    setIntegrityLoading(true)
    try {
      const [summary, rows] = await Promise.all([
        db.dataIntegrity.summary(),
        db.dataIntegrity.issues(),
      ])
      setIntegrity(summary)
      setIntegrityRows(rows)
    } catch (err) {
      captureException(err, { page: 'cp/DataCleanup', context: 'integrityChecks' })
      toast.error(t('cp.dataCleanup.integrityFailed', { error: toUserMessage(err) }))
      setIntegrity([])
      setIntegrityRows([])
    } finally {
      setIntegrityLoading(false)
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

  // A customer counts as linked if a ticket references it by id OR by display
  // name. Matching on the name alone (as this did) offered any customer whose
  // name had since changed for deletion, even though the FK still bound it —
  // the delete would then be refused and the count was simply wrong (BUG-012).
  // Matching on id alone would mis-flag legacy tickets that carry only a name,
  // so the union is used: it can only ever reduce false orphans.
  const linkedIds = new Set(tickets.map((t) => t.customer_id).filter(Boolean))
  const linkedNames = new Set(tickets.map((t) => t.customer_name).filter(Boolean))
  const orphanCustomers = customers.filter((c) => {
    const name = c.customer_type === 'B2B' && c.company_name ? c.company_name : c.contact_person
    return !linkedIds.has(c.id) && !linkedNames.has(name)
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
      // Previously: `;(await db.rmaTickets.bulkDelete) ? … : Promise.all(…)`.
      // That awaited the *function reference* rather than a call, and neither
      // branch of the ternary was awaited — so the success toast and reload
      // fired before a single delete had resolved, and any failure became an
      // unhandled rejection that never reached the catch below. These are hard
      // deletes that cascade to inventory_units, ticket_comments,
      // ticket_activity, time_entries, ticket_parts and ticket_resolutions, so
      // reporting success without confirming them is the worst case (BUG-012).
      await db.rmaTickets.bulkDelete(list.map((t) => t.id))
      toast.success(t('cp.dataCleanup.deleted', { count: list.length, label }))
      await load()
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
      // Some of the tickets may already be gone (BUG-074): reload the counts.
      await load()
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

      {/* Data integrity (BUG-041) */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">{t('cp.dataCleanup.integrityHeader')}</h3>
            <p className="text-sm text-gray-500 mt-0.5">{t('cp.dataCleanup.integrityDesc')}</p>
          </div>
          <button
            onClick={runIntegrityChecks}
            disabled={integrityLoading}
            className="shrink-0 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            {integrityLoading ? t('cp.dataCleanup.integrityRunning') : t('cp.dataCleanup.integrityRun')}
          </button>
        </div>

        {integrity !== null && integrity.length === 0 && !integrityLoading && (
          <p className="text-sm text-gray-500">{t('cp.dataCleanup.integrityClean')}</p>
        )}

        {integrity !== null && integrity.length > 0 && (
          <div className="space-y-2">
            {integrity.map((group) => {
              const open = expandedCheck === group.check_name
              const rows = (integrityRows || []).filter((r) => r.check_name === group.check_name)
              return (
                <div key={group.check_name} className="border border-gray-200 rounded-lg">
                  <div className="flex items-center gap-3 p-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                      group.severity === 'high' ? 'bg-red-100 text-red-700'
                        : group.severity === 'medium' ? 'bg-amber-100 text-amber-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {t(`cp.dataCleanup.severity_${group.severity}`)}
                    </span>
                    <span className="text-sm text-gray-800 flex-1">
                      {/* Falls back to the raw check name so a check added in a
                          later migration still reads sensibly on an older build. */}
                      {t(`cp.dataCleanup.check_${group.check_name}`, { defaultValue: group.check_name })}
                    </span>
                    <span className="text-sm font-semibold text-gray-900 tabular-nums">{group.issue_count}</span>
                    <button
                      onClick={() => setExpandedCheck(open ? null : group.check_name)}
                      className="text-xs text-indigo-600 hover:underline whitespace-nowrap"
                    >
                      {open ? t('cp.dataCleanup.integrityHideRows') : t('cp.dataCleanup.integrityShowRows')}
                    </button>
                  </div>
                  {open && rows.length > 0 && (
                    <div className="border-t border-gray-100 divide-y divide-gray-100 max-h-64 overflow-y-auto">
                      {rows.map((r) => (
                        <div key={r.entity_id} className="px-3 py-2 text-xs">
                          <span className="font-mono text-gray-700">{r.reference}</span>
                          <span className="text-gray-500"> — {r.detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
