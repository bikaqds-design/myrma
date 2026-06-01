import React, { useState, useEffect, useMemo, Suspense, lazy } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db, supabase } from '../api/supabaseClient'
import { safeStorage } from '../lib/safeStorage'
import { useAppearance } from '../contexts/AppearanceContext'
import { Spinner, PageHeader } from '../components/ui'
import { TICKET_STATUS, TICKET_STATUS_RESOLVED } from '../lib/constants'

const DashboardCharts = lazy(() => import('./DashboardCharts'))

// eslint-disable-next-line react-refresh/only-export-components
export const WIDGET_CATALOG = [
  {
    id: 'stat_tickets',
    label: 'Ticket KPIs',
    desc: '4 stat cards: Total, Open, Closed, Overdue',
    size: 'full',
  },
  {
    id: 'stat_inventory',
    label: 'Inventory Snapshot',
    desc: '4 inventory status counts',
    size: 'full',
  },
  {
    id: 'sla_health',
    label: 'SLA Health',
    desc: 'On-time ticket completion rate gauge',
    size: 'half',
  },
  {
    id: 'resolution_rate',
    label: 'Resolution Rate',
    desc: 'Percentage of closed tickets gauge',
    size: 'half',
  },
  {
    id: 'recent_tickets',
    label: 'Recent Tickets',
    desc: 'Last 10 RMA tickets with status',
    size: 'half',
  },
  {
    id: 'overdue_tickets',
    label: 'Overdue Tickets',
    desc: 'All tickets past their due date',
    size: 'half',
  },
  {
    id: 'weekly_trend',
    label: 'Weekly Trend',
    desc: '7-day ticket creation line chart',
    size: 'half',
  },
  {
    id: 'monthly_trend',
    label: 'Monthly Trend (30d)',
    desc: '30-day ticket creation bar chart',
    size: 'half',
  },
  {
    id: 'status_distribution',
    label: 'Status Distribution',
    desc: 'Pie chart of ticket statuses',
    size: 'half',
  },
  {
    id: 'priority_distribution',
    label: 'Priority Distribution',
    desc: 'Pie chart of ticket priorities',
    size: 'half',
  },
  {
    id: 'technician_performance',
    label: 'Technician Performance',
    desc: 'Bar chart of top 5 technicians by close rate',
    size: 'full',
  },
  {
    id: 'top_issues',
    label: 'Top Issues',
    desc: 'Ranked list of most common product issues',
    size: 'full',
  },
]

function WidgetCard({ title, icon, onClick, children, className = '' }) {
  return (
    <div
      onClick={onClick}
      className={`bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 p-6 ${onClick ? 'cursor-pointer hover:shadow-md hover:border-indigo-200 dark:hover:border-indigo-500 transition-all' : ''} ${className}`}
    >
      {title && (
        <h2 className="text-base font-semibold text-gray-900 dark:text-slate-100 mb-4 flex items-center gap-2">
          {icon && <span className="text-indigo-600 dark:text-indigo-400">{icon}</span>}
          {title}
          {onClick && (
            <svg
              className="w-3.5 h-3.5 text-gray-500 dark:text-slate-500 ml-auto flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          )}
        </h2>
      )}
      {children}
    </div>
  )
}

function CircularGauge({ percent, color, label, sublabel }) {
  const r = 45
  const circ = 2 * Math.PI * r
  const dash = (Math.max(0, Math.min(percent, 100)) / 100) * circ
  return (
    <div className="flex flex-col items-center py-2">
      <svg width="140" height="140" viewBox="0 0 120 120">
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          className="text-gray-200"
        />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          transform="rotate(-90 60 60)"
          style={{ transition: 'stroke-dasharray 0.6s ease' }}
        />
        <text
          x="60"
          y="56"
          textAnchor="middle"
          style={{ fontSize: 22, fontWeight: 700 }}
          fill="currentColor"
        >
          {percent}%
        </text>
        <text
          x="60"
          y="74"
          textAnchor="middle"
          style={{ fontSize: 10 }}
          fill="currentColor"
          opacity="0.5"
        >
          {sublabel}
        </text>
      </svg>
      <p className="text-sm font-medium text-gray-700 mt-1 text-center">{label}</p>
    </div>
  )
}

function StatusBadge({ status }) {
  const colors = {
    Open: 'bg-blue-100 text-blue-700',
    'In Progress': 'bg-amber-100 text-amber-700',
    Pending: 'bg-purple-100 text-purple-700',
    Resolved: 'bg-green-100 text-green-700',
    Closed: 'bg-gray-100 text-gray-700',
    Cancelled: 'bg-red-100 text-red-700',
  }
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${colors[status] || 'bg-gray-100 text-gray-700'}`}
    >
      {status}
    </span>
  )
}

export default function Dashboard({ currentUserEmail, onNavigate }) {
  const { dashboardWidgets, darkMode } = useAppearance()
  // DM-1/DM-2: chart theming derived from dark mode
  const chartTickStyle = { fontSize: 11, fill: darkMode ? '#94a3b8' : '#6b7280' }
  const chartGridColor = darkMode ? '#334155' : '#f3f4f6'
  const chartTooltipStyle = darkMode
    ? { backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }
    : { backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }
  const storageKey = `dashboard_widgets_${currentUserEmail}`

  const [enabledWidgets, setEnabledWidgets] = useState(() =>
    safeStorage.get(storageKey, dashboardWidgets || WIDGET_CATALOG.map((w) => w.id))
  )

  // P-1: TanStack Query — cached fetch; stale data renders instantly on re-visit
  const queryClient = useQueryClient()
  const { data: tickets = [], isLoading: loading } = useQuery({
    queryKey: ['rma-tickets'],
    queryFn: () => db.rmaTickets.list(),
    staleTime: 60_000,
  })
  const { data: invStats = null } = useQuery({
    queryKey: ['inv-stats'],
    queryFn: () => db.inventory.getStats().catch(() => null),
    staleTime: 2 * 60_000,
  })

  // A-5: merge realtime payload into query cache instead of local state
  useEffect(() => {
    const channel = supabase
      .channel('dashboard-rt')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'rma_tickets' },
        ({ new: row }) => {
          queryClient.setQueryData(['rma-tickets'], (old) => (old ? [row, ...old] : [row]))
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rma_tickets' },
        ({ new: row }) => {
          queryClient.setQueryData(
            ['rma-tickets'],
            (old) => old?.map((t) => (t.id === row.id ? row : t)) ?? [row]
          )
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'rma_tickets' },
        ({ old: row }) => {
          queryClient.setQueryData(
            ['rma-tickets'],
            (old) => old?.filter((t) => t.id !== row.id) ?? []
          )
        }
      )
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [queryClient])

  // Re-read widget prefs when returning to this page (storageKey may differ per user)
  useEffect(() => {
    const stored = safeStorage.get(storageKey, null)
    if (stored) setEnabledWidgets(stored)
  }, [storageKey])

  // Listen for storage events from AccountSettings (same-tab custom event)
  useEffect(() => {
    const handler = () => {
      const stored = safeStorage.get(storageKey, null)
      if (stored) setEnabledWidgets(stored)
    }
    window.addEventListener('dashboard-widgets-changed', handler)
    return () => window.removeEventListener('dashboard-widgets-changed', handler)
  }, [storageKey])

  const on = (id) => enabledWidgets.includes(id)
  const nav = (page) => () => onNavigate?.(page)

  // A-4: all aggregations memoised — only recompute when tickets changes
  const totalTickets = useMemo(() => tickets.length, [tickets])

  const openTickets = useMemo(
    () =>
      tickets.filter((t) => !['Closed', 'Resolved', 'Cancelled'].includes(t.ticket_status)).length,
    [tickets]
  )

  const closedTickets = useMemo(
    () => tickets.filter((t) => TICKET_STATUS_RESOLVED.includes(t.ticket_status)).length,
    [tickets]
  )

  const overdueList = useMemo(
    () =>
      tickets.filter((t) => {
        if (!t.due_date || TICKET_STATUS_RESOLVED.includes(t.ticket_status))
          return false
        return new Date(t.due_date) < new Date()
      }),
    [tickets]
  )

  const { slaPercent, resolutionPercent, trackedCount, onScheduleCount } = useMemo(() => {
    const ticketsWithDue = tickets.filter((t) => t.due_date && t.ticket_status !== TICKET_STATUS.CANCELLED)
    const overdueActive = ticketsWithDue.filter(
      (t) => !TICKET_STATUS_RESOLVED.includes(t.ticket_status) && new Date(t.due_date) < new Date()
    ).length
    return {
      slaPercent:
        ticketsWithDue.length > 0
          ? Math.round(((ticketsWithDue.length - overdueActive) / ticketsWithDue.length) * 100)
          : 100,
      resolutionPercent:
        tickets.length > 0 ? Math.round((closedTickets / tickets.length) * 100) : 0,
      // Exposed for the SLA widget caption (rendered outside this memo's scope)
      trackedCount: ticketsWithDue.length,
      onScheduleCount: ticketsWithDue.length - overdueActive,
    }
  }, [tickets, closedTickets])

  const weeklyTrend = useMemo(() => {
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const ds = d.toISOString().split('T')[0]
      days.push({
        date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        tickets: tickets.filter((t) => t.created_date?.startsWith(ds)).length,
      })
    }
    return days
  }, [tickets])

  const monthlyTrend = useMemo(() => {
    const days = []
    for (let i = 29; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const ds = d.toISOString().split('T')[0]
      days.push({
        date: i % 6 === 0 ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
        fullDate: ds,
        tickets: tickets.filter((t) => t.created_date?.startsWith(ds)).length,
      })
    }
    return days
  }, [tickets])

  const statusDist = useMemo(() => {
    const counts = {}
    tickets.forEach((t) => {
      counts[t.ticket_status] = (counts[t.ticket_status] || 0) + 1
    })
    return Object.entries(counts).map(([name, value]) => ({ name, value }))
  }, [tickets])

  const priorityDist = useMemo(() => {
    const order = ['Critical', 'High', 'Medium', 'Low']
    const counts = {}
    tickets.forEach((t) => {
      if (t.priority) counts[t.priority] = (counts[t.priority] || 0) + 1
    })
    return order.filter((p) => counts[p]).map((name) => ({ name, value: counts[name] }))
  }, [tickets])

  const technicianPerformance = useMemo(() => {
    const stats = {}
    tickets.forEach((t) => {
      const tech = t.assigned_technician || 'Unassigned'
      if (!stats[tech]) stats[tech] = { total: 0, closed: 0 }
      stats[tech].total++
      if (TICKET_STATUS_RESOLVED.includes(t.ticket_status)) stats[tech].closed++
    })
    return Object.entries(stats)
      .map(([name, s]) => ({
        name,
        total: s.total,
        closed: s.closed,
        closeRate: s.total > 0 ? Math.round((s.closed / s.total) * 100) : 0,
      }))
      .sort((a, b) => b.closeRate - a.closeRate)
      .slice(0, 5)
  }, [tickets])

  const topIssues = useMemo(() => {
    const counts = {}
    tickets.forEach((t) => {
      if (!Array.isArray(t.products)) return
      t.products.forEach((p) => {
        const issue = p.issue_description?.trim()
        if (issue) counts[issue] = (counts[issue] || 0) + 1
      })
    })
    return Object.entries(counts)
      .map(([issue, count]) => ({ issue, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  }, [tickets])

  const recentTickets = useMemo(
    () =>
      [...tickets]
        .sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0))
        .slice(0, 10),
    [tickets]
  )

  const daysBetween = (a) => Math.ceil((new Date() - new Date(a)) / 86400000)

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Spinner size="lg" />
      </div>
    )
  }

  const hasWidgets = WIDGET_CATALOG.some((w) => on(w.id))

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" subtitle="RMA system overview and analytics" />

      {!hasWidgets && (
        <div className="bg-white rounded-xl border-2 border-dashed border-gray-200 p-14 text-center">
          <svg
            className="w-12 h-12 text-gray-300 mx-auto mb-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
            />
          </svg>
          <p className="text-gray-600 font-medium">No widgets enabled</p>
          <p className="text-gray-500 text-sm mt-1">
            Go to Account Settings → Appearance to enable widgets
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Ticket KPIs ── */}
        {on('stat_tickets') && (
          <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              {
                title: 'Total Tickets',
                value: totalTickets,
                color: 'indigo',
                icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
              },
              {
                title: 'Open',
                value: openTickets,
                color: 'blue',
                icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
              },
              {
                title: 'Closed',
                value: closedTickets,
                color: 'green',
                icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
              },
              {
                title: 'Overdue',
                value: overdueList.length,
                color: 'red',
                icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
              },
            ].map(({ title, value, color, icon }) => {
              const bg = {
                indigo: 'bg-indigo-100 text-indigo-600',
                blue: 'bg-blue-100 text-blue-600',
                green: 'bg-green-100 text-green-600',
                red: 'bg-red-100 text-red-600',
              }[color]
              return (
                <div
                  key={title}
                  onClick={nav('rma-tickets')}
                  className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 cursor-pointer hover:shadow-md hover:border-indigo-200 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-500">{title}</p>
                      <p className="text-3xl font-bold text-gray-900 mt-1">{value}</p>
                    </div>
                    <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${bg}`}>
                      <svg
                        className="w-6 h-6"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d={icon}
                        />
                      </svg>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ── Inventory Snapshot ── */}
        {on('stat_inventory') && invStats && (
          <WidgetCard
            className="lg:col-span-2"
            title="Inventory Snapshot"
            onClick={nav('inventory')}
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
            }
          >
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                {
                  label: 'Active RMA',
                  value: invStats.active_rma ?? 0,
                  cls: 'bg-blue-50',
                  tc: 'text-blue-700',
                },
                {
                  label: 'Company Stock',
                  value: invStats.company_stock ?? 0,
                  cls: 'bg-amber-50',
                  tc: 'text-amber-700',
                },
                {
                  label: 'Sent to Manufacturer',
                  value: invStats.sent_to_manufacturer ?? 0,
                  cls: 'bg-purple-50',
                  tc: 'text-purple-700',
                },
                {
                  label: 'Total Units',
                  value: invStats.total ?? 0,
                  cls: 'bg-gray-50',
                  tc: 'text-gray-700',
                },
              ].map((c) => (
                <div key={c.label} className={`rounded-lg p-4 ${c.cls}`}>
                  <div className={`text-2xl font-bold ${c.tc}`}>{c.value}</div>
                  <div className={`text-xs font-medium mt-0.5 opacity-70 ${c.tc}`}>{c.label}</div>
                </div>
              ))}
            </div>
          </WidgetCard>
        )}

        {/* ── SLA Health ── */}
        {on('sla_health') && (
          <WidgetCard
            title="SLA Health"
            onClick={nav('rma-tickets')}
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                />
              </svg>
            }
          >
            <div className="flex justify-center">
              <CircularGauge
                percent={slaPercent}
                color={slaPercent >= 80 ? '#10b981' : slaPercent >= 60 ? '#f59e0b' : '#ef4444'}
                label="On-time Delivery Rate"
                sublabel="of tickets"
              />
            </div>
            <p className="text-center text-xs text-gray-500 mt-1">
              {onScheduleCount} of {trackedCount} tracked tickets on schedule
            </p>
          </WidgetCard>
        )}

        {/* ── Resolution Rate ── */}
        {on('resolution_rate') && (
          <WidgetCard
            title="Resolution Rate"
            onClick={nav('rma-tickets')}
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"
                />
              </svg>
            }
          >
            <div className="flex justify-center">
              <CircularGauge
                percent={resolutionPercent}
                color={
                  resolutionPercent >= 70
                    ? '#10b981'
                    : resolutionPercent >= 40
                      ? '#f59e0b'
                      : '#6366f1'
                }
                label="Ticket Resolution Rate"
                sublabel="resolved"
              />
            </div>
            <p className="text-center text-xs text-gray-500 mt-1">
              {closedTickets} of {totalTickets} tickets resolved or closed
            </p>
          </WidgetCard>
        )}

        {/* ── Recent Tickets ── */}
        {on('recent_tickets') && (
          <WidgetCard
            title="Recent Tickets"
            onClick={nav('rma-tickets')}
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
            }
          >
            {recentTickets.length === 0 ? (
              <p className="text-center text-gray-500 py-8 text-sm">No tickets yet</p>
            ) : (
              <div className="divide-y divide-gray-100 -mx-2">
                {recentTickets.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between py-2.5 px-2 hover:bg-gray-50 rounded-lg"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {t.ticket_number || `#${String(t.id).slice(0, 8)}`}
                      </p>
                      <p className="text-xs text-gray-500 truncate">{t.customer_name || '—'}</p>
                    </div>
                    <div className="ml-3 flex-shrink-0">
                      <StatusBadge status={t.ticket_status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </WidgetCard>
        )}

        {/* ── Overdue Tickets ── */}
        {on('overdue_tickets') && (
          <WidgetCard
            title="Overdue Tickets"
            onClick={nav('rma-tickets')}
            icon={
              <svg
                className="w-5 h-5 text-red-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            }
          >
            {overdueList.length === 0 ? (
              <div className="text-center py-8">
                <svg
                  className="w-10 h-10 text-green-400 mx-auto mb-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <p className="text-sm text-green-600 font-medium">No overdue tickets!</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100 -mx-2">
                {overdueList.slice(0, 10).map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between py-2.5 px-2 hover:bg-red-50 rounded-lg"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {t.ticket_number || `#${String(t.id).slice(0, 8)}`}
                      </p>
                      <p className="text-xs text-gray-500 truncate">{t.customer_name || '—'}</p>
                    </div>
                    <span className="ml-3 flex-shrink-0 px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-xs font-medium">
                      {daysBetween(t.due_date)}d overdue
                    </span>
                  </div>
                ))}
              </div>
            )}
          </WidgetCard>
        )}

        {/* ── Chart widgets (lazy-loaded — Recharts excluded from main bundle) ── */}
        <Suspense fallback={null}>
          <DashboardCharts
            on={on}
            nav={nav}
            weeklyTrend={weeklyTrend}
            monthlyTrend={monthlyTrend}
            statusDist={statusDist}
            priorityDist={priorityDist}
            technicianPerformance={technicianPerformance}
            chartGridColor={chartGridColor}
            chartTickStyle={chartTickStyle}
            chartTooltipStyle={chartTooltipStyle}
          />
        </Suspense>

        {/* ── Top Issues ── */}
        {on('top_issues') && (
          <WidgetCard
            className="lg:col-span-2"
            title="Top Issues"
            onClick={nav('rma-tickets')}
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                />
              </svg>
            }
          >
            {topIssues.length === 0 ? (
              <p className="text-center text-gray-500 py-8 text-sm">No issues recorded yet</p>
            ) : (
              <div className="space-y-4">
                {topIssues.map((item, idx) => {
                  const max = topIssues[0]?.count || 1
                  return (
                    <div key={idx} className="flex items-center gap-3">
                      <div className="w-7 h-7 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center font-semibold text-sm flex-shrink-0">
                        {idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-sm text-gray-800 truncate">{item.issue}</p>
                          <span className="ml-3 text-sm font-semibold text-gray-600 flex-shrink-0">
                            {item.count}
                          </span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                            style={{ width: `${(item.count / max) * 100}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </WidgetCard>
        )}
      </div>
    </div>
  )
}
