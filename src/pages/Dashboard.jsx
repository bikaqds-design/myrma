import React, { useState, useEffect, useMemo, Suspense, lazy } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db, supabase } from '../api/supabaseClient'
import AIAssist from '../components/AIAssist'
import { safeStorage } from '../lib/safeStorage'
import { useAppearance } from '../contexts/AppearanceContext'
import { Spinner } from '../components/ui'
import { TICKET_STATUS, TICKET_STATUS_LIST, TICKET_STATUS_RESOLVED } from '../lib/constants'

const DashboardCharts = lazy(() => import('./DashboardCharts'))

// eslint-disable-next-line react-refresh/only-export-components
export const WIDGET_CATALOG = [
  { id: 'stat_tickets',           label: 'Ticket KPIs',               desc: 'Hero tiles + status strip',                     size: 'full' },
  { id: 'stat_inventory',         label: 'Inventory Snapshot',         desc: '5 inventory status categories',                 size: 'full' },
  { id: 'sla_health',             label: 'SLA Health',                 desc: 'On-time ticket completion rate gauge',           size: 'half' },
  { id: 'resolution_rate',        label: 'Resolution Rate',            desc: 'Percentage of closed tickets gauge',             size: 'half' },
  { id: 'recent_tickets',         label: 'Recent Tickets',             desc: 'Last 10 RMA tickets with status',               size: 'half' },
  { id: 'overdue_tickets',        label: 'Overdue Tickets',            desc: 'All tickets past their due date',               size: 'half' },
  { id: 'weekly_trend',           label: 'Weekly Trend',               desc: '7-day ticket creation line chart',              size: 'half' },
  { id: 'monthly_trend',          label: 'Monthly Trend (30d)',         desc: '30-day ticket creation bar chart',              size: 'half' },
  { id: 'status_distribution',    label: 'Status Distribution',        desc: 'Donut chart of ticket statuses',                size: 'half' },
  { id: 'priority_distribution',  label: 'Priority Distribution',      desc: 'Donut chart of ticket priorities',              size: 'half' },
  { id: 'technician_performance', label: 'Technician Performance',     desc: 'Top 5 technicians by close rate',               size: 'full' },
  { id: 'top_issues',             label: 'Top Issues',                 desc: 'Ranked list of most common product issues',     size: 'full' },
]

// ── Design tokens ─────────────────────────────────────────────────────────────
const STATUS_COLOR = {
  Open:          '#3b82f6',
  'In Progress': '#6366f1',
  Pending:       '#f59e0b',
  'On Hold':     '#eab308',
  Completed:     '#14b8a6',
  Closed:        '#10b981',
  Cancelled:     '#94a3b8',
  Overdue:       '#ef4444',
}
const PRIORITY_COLOR = {
  Critical: '#ef4444',
  High:     '#f59e0b',
  Medium:   '#6366f1',
  Low:      '#94a3b8',
}
function tokens(dark) {
  return {
    accent:      dark ? '#a5b4fc' : '#4338ca',
    surface:     dark ? '#121823' : '#ffffff',
    surfaceInset:dark ? '#0e131c' : '#f7f8fb',
    border:      dark ? '#212a38' : '#e6e9ef',
    borderSoft:  dark ? '#1a2230' : '#eef0f4',
    text:        dark ? '#e8ebf0' : '#211f1b',
    textMuted:   dark ? '#9aa4b2' : '#6c6760',
    textFaint:   dark ? '#646f7e' : '#a39e95',
    track:       dark ? '#212a38' : '#eaedf2',
    grid:        dark ? '#1a2230' : '#eef1f5',
    good:        dark ? '#34d399' : '#10b981',
    bad:         dark ? '#f87171' : '#ef4444',
    warn:        dark ? '#fbbf24' : '#f59e0b',
  }
}

// ── Primitives ────────────────────────────────────────────────────────────────
function SvgGauge({ percent, color, tk, size = 132 }) {
  const thickness = 12
  const r = (size - thickness) / 2
  const cx = size / 2
  const C = 2 * Math.PI * r
  const len = (Math.max(0, Math.min(percent, 100)) / 100) * C
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={tk.track} strokeWidth={thickness} />
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={color} strokeWidth={thickness}
        strokeLinecap="round" strokeDasharray={`${len} ${C - len}`}
        transform={`rotate(-90 ${cx} ${cx})`}
        style={{ transition: 'stroke-dasharray 0.7s cubic-bezier(.2,.7,.3,1)' }} />
      <text x={cx} y={cx - 2} textAnchor="middle" dominantBaseline="middle"
        style={{ fontSize: 32, fontWeight: 700, letterSpacing: -0.5 }} fill={tk.text}>
        {percent}%
      </text>
      <text x={cx} y={cx + 22} textAnchor="middle"
        style={{ fontSize: 11, fontWeight: 500, letterSpacing: 0.3 }} fill={tk.textFaint}>
        on-time
      </text>
    </svg>
  )
}

function SvgDonut({ segments, tk, size = 108 }) {
  const thickness = 11
  const r = (size - thickness) / 2
  const cx = size / 2
  const C = 2 * Math.PI * r
  const total = segments.reduce((s, d) => s + d.value, 0) || 1
  const gap = 3
  let acc = 0
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke={tk.track} strokeWidth={thickness} />
        {segments.map((s, i) => {
          const frac = s.value / total
          const len = Math.max(frac * C - gap, 0)
          const el = (
            <circle key={i} cx={cx} cy={cx} r={r} fill="none" stroke={s.color}
              strokeWidth={thickness} strokeLinecap="round"
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-acc * C}
              transform={`rotate(-90 ${cx} ${cx})`} />
          )
          acc += frac
          return el
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 21, fontWeight: 760, color: tk.text, fontVariantNumeric: 'tabular-nums' }}>
          {total}
        </span>
      </div>
    </div>
  )
}

function Sparkline({ data, color, width = 76, height = 30 }) {
  if (!data || data.length < 2) return null
  const max = Math.max(...data, 1)
  const min = Math.min(...data)
  const rng = max - min || 1
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * width,
    height - ((v - min) / rng) * (height - 4) - 2,
  ])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ flexShrink: 0 }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StatusPill({ status }) {
  const color = STATUS_COLOR[status] || '#94a3b8'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 999,
      fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
      color, background: color + '1e', flexShrink: 0,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color, display: 'inline-block' }} />
      {status}
    </span>
  )
}

function CardHead({ title, action, tk }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 650, color: tk.text, letterSpacing: -0.1 }}>{title}</h3>
      {action && <span style={{ fontSize: 11.5, fontWeight: 600, color: tk.textFaint }}>{action}</span>}
    </div>
  )
}

function SectionLabel({ children, tk }) {
  return (
    <div className="col-span-12" style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0 -4px' }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1.2px', color: tk.textFaint, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
        {children}
      </span>
      <span style={{ flex: 1, height: 1, background: tk.border }} />
    </div>
  )
}

function DonutWithLegend({ segments, tk }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1 }}>
      <SvgDonut segments={segments} tk={tk} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1, minWidth: 0 }}>
        {segments.slice(0, 5).map((s) => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ color: tk.textMuted, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
            <span style={{ color: tk.text, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Dashboard({ currentUserEmail, onNavigate }) {
  const { dashboardWidgets, darkMode } = useAppearance()
  const tk = tokens(darkMode)
  const chartTickStyle  = { fontSize: 10, fill: tk.textFaint }
  const chartGridColor  = tk.grid
  const chartTooltipStyle = darkMode
    ? { backgroundColor: '#121823', border: `1px solid ${tk.border}`, borderRadius: 8, color: tk.text }
    : { backgroundColor: '#fff',    border: `1px solid ${tk.border}`, borderRadius: 8 }
  const storageKey = `dashboard_widgets_${currentUserEmail}`

  const [enabledWidgets, setEnabledWidgets] = useState(() =>
    safeStorage.get(storageKey, dashboardWidgets || WIDGET_CATALOG.map((w) => w.id))
  )
  const [range, setRange] = useState('30d')

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

  useEffect(() => {
    const channel = supabase
      .channel('dashboard-rt')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rma_tickets' },
        ({ new: row }) => { queryClient.setQueryData(['rma-tickets'], (old) => (old ? [row, ...old] : [row])) })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rma_tickets' },
        ({ new: row }) => { queryClient.setQueryData(['rma-tickets'], (old) => old?.map((t) => (t.id === row.id ? row : t)) ?? [row]) })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'rma_tickets' },
        ({ old: row }) => { queryClient.setQueryData(['rma-tickets'], (old) => old?.filter((t) => t.id !== row.id) ?? []) })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [queryClient])

  useEffect(() => {
    const stored = safeStorage.get(storageKey, null)
    if (stored) setEnabledWidgets(stored)
  }, [storageKey])

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

  const rangedTickets = useMemo(() => {
    if (range === 'All') return tickets
    const cutoff = new Date()
    if (range === 'Today') cutoff.setHours(0, 0, 0, 0)
    else cutoff.setDate(cutoff.getDate() - parseInt(range))
    const iso = cutoff.toISOString()
    return tickets.filter((t) => t.created_date && t.created_date >= iso)
  }, [tickets, range])

  const totalTickets = useMemo(() => rangedTickets.length, [rangedTickets])

  const closedTickets = useMemo(
    () => rangedTickets.filter((t) => TICKET_STATUS_RESOLVED.includes(t.ticket_status)).length,
    [rangedTickets]
  )

  const overdueList = useMemo(
    () => rangedTickets.filter((t) => {
      if (!t.due_date || TICKET_STATUS_RESOLVED.includes(t.ticket_status)) return false
      return new Date(t.due_date) < new Date()
    }),
    [rangedTickets]
  )

  const statusCounts = useMemo(() => {
    const counts = {}
    TICKET_STATUS_LIST.forEach((s) => { counts[s] = 0 })
    rangedTickets.forEach((t) => { if (counts[t.ticket_status] !== undefined) counts[t.ticket_status]++ })
    return counts
  }, [rangedTickets])

  const invProductCounts = useMemo(() => {
    const flat = rangedTickets
      .filter((t) => t.ticket_status !== TICKET_STATUS.CANCELLED)
      .flatMap((t) => (t.products || []).map((p) => ({ ...p, ts: t.ticket_status })))
      .filter((p) => {
        if (p.ts === TICKET_STATUS.COMPLETED)
          return p.product_status === 'Replacement' || p.product_status === 'Credit Note'
        return true
      })
    const active = (ps) => flat.filter((p) => p.ts !== TICKET_STATUS.COMPLETED && p.product_status === ps).length
    return {
      allUnits:    invStats?.total ?? 0,
      received:    flat.filter((p) => p.ts !== TICKET_STATUS.COMPLETED && (p.product_status === 'Received' || !p.product_status)).length,
      underRepair: active('Under Repair'),
      repaired:    active('Repaired'),
      cantRepair:  active("Can't Repair"),
      rmaStock:    flat.filter((p) => p.product_status === 'Replacement' || p.product_status === 'Credit Note').length,
    }
  }, [rangedTickets, invStats])

  const { slaPercent, resolutionPercent, trackedCount, onScheduleCount } = useMemo(() => {
    const ticketsWithDue = rangedTickets.filter((t) => t.due_date && t.ticket_status !== TICKET_STATUS.CANCELLED)
    const overdueActive = ticketsWithDue.filter(
      (t) => !TICKET_STATUS_RESOLVED.includes(t.ticket_status) && new Date(t.due_date) < new Date()
    ).length
    return {
      slaPercent: ticketsWithDue.length > 0
        ? Math.round(((ticketsWithDue.length - overdueActive) / ticketsWithDue.length) * 100)
        : 100,
      resolutionPercent: rangedTickets.length > 0 ? Math.round((closedTickets / rangedTickets.length) * 100) : 0,
      trackedCount: ticketsWithDue.length,
      onScheduleCount: ticketsWithDue.length - overdueActive,
    }
  }, [rangedTickets, closedTickets])

  const weeklyTrend = useMemo(() => {
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const ds = d.toISOString().split('T')[0]
      days.push({ date: d.toLocaleDateString('en-US', { weekday: 'short' }), tickets: rangedTickets.filter((t) => t.created_date?.startsWith(ds)).length })
    }
    return days
  }, [rangedTickets])

  const monthlyTrend = useMemo(() => {
    const days = []
    for (let i = 29; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const ds = d.toISOString().split('T')[0]
      days.push({
        date: i % 6 === 0 ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
        fullDate: ds,
        tickets: rangedTickets.filter((t) => t.created_date?.startsWith(ds)).length,
      })
    }
    return days
  }, [rangedTickets])

  const statusDist = useMemo(() => {
    const counts = {}
    rangedTickets.forEach((t) => { counts[t.ticket_status] = (counts[t.ticket_status] || 0) + 1 })
    return Object.entries(counts).map(([name, value]) => ({ name, value, color: STATUS_COLOR[name] || '#94a3b8' }))
  }, [rangedTickets])

  const priorityDist = useMemo(() => {
    const order = ['Critical', 'High', 'Medium', 'Low']
    const counts = {}
    rangedTickets.forEach((t) => { if (t.priority) counts[t.priority] = (counts[t.priority] || 0) + 1 })
    return order.filter((p) => counts[p]).map((name) => ({ name, value: counts[name], color: PRIORITY_COLOR[name] || '#94a3b8' }))
  }, [rangedTickets])

  const technicianPerformance = useMemo(() => {
    const stats = {}
    rangedTickets.forEach((t) => {
      const tech = t.assigned_technician || 'Unassigned'
      if (!stats[tech]) stats[tech] = { total: 0, closed: 0 }
      stats[tech].total++
      if (TICKET_STATUS_RESOLVED.includes(t.ticket_status)) stats[tech].closed++
    })
    return Object.entries(stats)
      .map(([name, s]) => ({ name, total: s.total, closed: s.closed, closeRate: s.total > 0 ? Math.round((s.closed / s.total) * 100) : 0 }))
      .sort((a, b) => b.closeRate - a.closeRate)
      .slice(0, 5)
  }, [rangedTickets])

  const topIssues = useMemo(() => {
    const counts = {}
    tickets.forEach((t) => {
      if (!Array.isArray(t.products)) return
      t.products.forEach((p) => {
        const issue = p.issue_description?.trim()
        if (issue) counts[issue] = (counts[issue] || 0) + 1
      })
    })
    return Object.entries(counts).map(([issue, count]) => ({ issue, count })).sort((a, b) => b.count - a.count).slice(0, 5)
  }, [tickets])

  const recentTickets = useMemo(
    () => [...tickets].sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0)).slice(0, 8),
    [tickets]
  )

  const daysBetween = (a) => Math.ceil((new Date() - new Date(a)) / 86400000)
  const openActive = (statusCounts[TICKET_STATUS.OPEN] || 0) + (statusCounts[TICKET_STATUS.IN_PROGRESS] || 0) +
    (statusCounts[TICKET_STATUS.PENDING] || 0) + (statusCounts[TICKET_STATUS.ON_HOLD] || 0)
  const sparkWeekly = weeklyTrend.map((d) => d.tickets)

  const dashboardAIData = useMemo(() => ({
    range,
    open: statusCounts[TICKET_STATUS.OPEN] || 0,
    in_progress: statusCounts[TICKET_STATUS.IN_PROGRESS] || 0,
    pending: statusCounts[TICKET_STATUS.PENDING] || 0,
    overdue: overdueList.length,
    resolved: closedTickets,
    total: totalTickets,
    sla_percent: slaPercent,
    resolution_rate: resolutionPercent,
  }), [range, statusCounts, overdueList.length, closedTickets, totalTickets, slaPercent, resolutionPercent])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Spinner size="lg" />
      </div>
    )
  }

  const hasWidgets = WIDGET_CATALOG.some((w) => on(w.id))
  const RANGES = ['Today', '7d', '30d', 'All']

  return (
    <div style={{ color: tk.text }}>
      {/* ── Page header ── */}
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 style={{ margin: 0, fontSize: 25, fontWeight: 750, letterSpacing: -0.5, color: tk.text }}>RMA Operations</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13.5, color: tk.textMuted }}>System overview &amp; analytics · updated just now</p>
        </div>
        <div className="flex gap-2">
          {RANGES.map((seg) => (
            <button key={seg} onClick={() => setRange(seg)}
              style={{
                padding: '7px 14px', borderRadius: 9, fontSize: 12.5, fontWeight: 650,
                background: range === seg ? tk.accent : tk.surface,
                color:      range === seg ? '#fff'     : tk.textMuted,
                border:     `1px solid ${range === seg ? tk.accent : tk.border}`,
                cursor: 'pointer', transition: 'all .15s',
              }}>
              {seg}
            </button>
          ))}
        </div>
      </div>

      <AIAssist contextType="dashboard" data={dashboardAIData} className="mb-5" />

      {!hasWidgets && (
        <div style={{ background: tk.surface, border: `2px dashed ${tk.border}`, borderRadius: 14, padding: '56px 0', textAlign: 'center' }}>
          <p style={{ color: tk.textMuted, fontWeight: 600, margin: 0 }}>No widgets enabled</p>
          <p style={{ color: tk.textFaint, fontSize: 13, marginTop: 4 }}>Go to Account Settings → Appearance to enable widgets</p>
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">

        {/* ── Hero KPI tiles ── */}
        {on('stat_tickets') && (
          <>
            {[
              { label: 'Total Tickets', value: totalTickets, color: tk.text, spark: sparkWeekly, delta: '+8%', deltaUp: true },
              { label: 'Active / Open',  value: openActive,   color: tk.accent, spark: [12,14,11,17,15,16,openActive], caption: 'across 4 live states' },
              { label: 'Overdue',        value: overdueList.length, color: tk.bad, spark: [3,4,5,4,6,6,overdueList.length], caption: 'needs attention today' },
              { label: 'SLA On-time',    value: `${slaPercent}%`, color: tk.good, spark: [92,93,94,95,95,96,slaPercent], delta: '+2%', deltaUp: true },
            ].map(({ label, value, color, spark, delta, deltaUp, caption }) => (
              <div key={label} className="col-span-12 sm:col-span-6 lg:col-span-3"
                style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', gap: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: tk.textMuted, letterSpacing: 0.1 }}>{label}</span>
                <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 8 }}>
                  <span style={{ fontSize: 40, fontWeight: 780, color, letterSpacing: -1.4, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
                  <Sparkline data={spark} color={color} />
                </div>
                <div style={{ marginTop: 10 }}>
                  {delta ? (
                    <span style={{ fontSize: 12, fontWeight: 700, color: deltaUp ? tk.good : tk.bad, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                        style={{ transform: deltaUp ? 'none' : 'rotate(180deg)' }}>
                        <path d="M4.5 7.5V1.5M4.5 1.5L1.5 4.5M4.5 1.5L7.5 4.5" />
                      </svg>
                      {delta}
                    </span>
                  ) : (
                    <span style={{ fontSize: 12, color: tk.textMuted }}>{caption}</span>
                  )}
                </div>
              </div>
            ))}
          </>
        )}

        {/* ── Ticket status strip ── */}
        {on('stat_tickets') && (
          <div className="col-span-12"
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, display: 'flex', overflow: 'hidden' }}>
            {[
              { label: 'Open',        value: statusCounts[TICKET_STATUS.OPEN],        navPath: `/rma-tickets?status=${TICKET_STATUS.OPEN}` },
              { label: 'In Progress', value: statusCounts[TICKET_STATUS.IN_PROGRESS], navPath: `/rma-tickets?status=${TICKET_STATUS.IN_PROGRESS}` },
              { label: 'Pending',     value: statusCounts[TICKET_STATUS.PENDING],     navPath: `/rma-tickets?status=${TICKET_STATUS.PENDING}` },
              { label: 'On Hold',     value: statusCounts[TICKET_STATUS.ON_HOLD],     navPath: `/rma-tickets?status=${TICKET_STATUS.ON_HOLD}` },
              { label: 'Completed',   value: statusCounts[TICKET_STATUS.COMPLETED],   navPath: `/rma-tickets?status=${TICKET_STATUS.COMPLETED}` },
              { label: 'Closed',      value: statusCounts[TICKET_STATUS.CLOSED],      navPath: `/rma-tickets?status=${TICKET_STATUS.CLOSED}` },
              { label: 'Cancelled',   value: statusCounts[TICKET_STATUS.CANCELLED],   navPath: `/rma-tickets?status=${TICKET_STATUS.CANCELLED}` },
              { label: 'Overdue',     value: overdueList.length,                      navPath: '/rma-tickets?overdue=true' },
            ].map(({ label, value, navPath }, i) => {
              const color = STATUS_COLOR[label] || '#94a3b8'
              return (
                <button key={label} onClick={nav(navPath)}
                  style={{
                    flex: 1, minWidth: 72, padding: '16px 8px',
                    borderLeft: i ? `1px solid ${tk.borderSoft}` : 'none',
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    background: 'transparent', cursor: 'pointer', transition: 'background .15s',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = tk.surfaceInset}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                    <span style={{ fontSize: 11.5, color: tk.textMuted, fontWeight: 550 }}>{label}</span>
                  </div>
                  <div style={{ fontSize: 26, fontWeight: 760, color: tk.text, letterSpacing: -0.7, fontVariantNumeric: 'tabular-nums' }}>
                    {value ?? 0}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {/* ── Section: Performance ── */}
        {(on('sla_health') || on('resolution_rate') || on('status_distribution') || on('priority_distribution')) && (
          <SectionLabel tk={tk}>Performance</SectionLabel>
        )}

        {on('sla_health') && (
          <div className="col-span-12 sm:col-span-6 lg:col-span-3" onClick={nav('/rma-tickets?overdue=true')}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
            <CardHead title="SLA Health" tk={tk} />
            <SvgGauge percent={slaPercent} color={slaPercent >= 80 ? tk.good : slaPercent >= 60 ? tk.warn : tk.bad} tk={tk} />
            <p style={{ margin: '10px 0 0', fontSize: 11.5, color: tk.textMuted, textAlign: 'center' }}>
              {onScheduleCount}/{trackedCount} on schedule
            </p>
          </div>
        )}

        {on('resolution_rate') && (
          <div className="col-span-12 sm:col-span-6 lg:col-span-3" onClick={nav(`/rma-tickets?status=${TICKET_STATUS.CLOSED}`)}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
            <CardHead title="Resolution Rate" tk={tk} />
            <SvgGauge percent={resolutionPercent} color={resolutionPercent >= 70 ? tk.good : resolutionPercent >= 40 ? tk.warn : tk.accent} tk={tk} />
            <p style={{ margin: '10px 0 0', fontSize: 11.5, color: tk.textMuted, textAlign: 'center' }}>
              {closedTickets}/{totalTickets} resolved or closed
            </p>
          </div>
        )}

        {on('status_distribution') && (
          <div className="col-span-12 sm:col-span-6 lg:col-span-3" onClick={nav('/rma-tickets')}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
            <CardHead title="Status Mix" tk={tk} />
            {statusDist.length === 0
              ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>No data</p>
              : <DonutWithLegend segments={statusDist} tk={tk} />}
          </div>
        )}

        {on('priority_distribution') && (
          <div className="col-span-12 sm:col-span-6 lg:col-span-3" onClick={nav('/rma-tickets')}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
            <CardHead title="Priority Mix" tk={tk} />
            {priorityDist.length === 0
              ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>No data</p>
              : <DonutWithLegend segments={priorityDist} tk={tk} />}
          </div>
        )}

        {/* ── Section: Trends ── */}
        {(on('weekly_trend') || on('monthly_trend')) && (
          <SectionLabel tk={tk}>Trends</SectionLabel>
        )}
        <Suspense fallback={null}>
          <DashboardCharts
            on={on} nav={nav}
            weeklyTrend={weeklyTrend} monthlyTrend={monthlyTrend}
            chartGridColor={chartGridColor} chartTickStyle={chartTickStyle} chartTooltipStyle={chartTooltipStyle}
            tk={tk}
          />
        </Suspense>

        {/* ── Section: Activity ── */}
        {(on('recent_tickets') || on('overdue_tickets') || on('top_issues')) && (
          <SectionLabel tk={tk}>Activity</SectionLabel>
        )}

        {on('recent_tickets') && (
          <div className="col-span-12 lg:col-span-5" onClick={nav('/rma-tickets')}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
            <CardHead title="Recent Tickets" action="View all" tk={tk} />
            {recentTickets.length === 0
              ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '20px 0' }}>No tickets yet</p>
              : recentTickets.map((t, i) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderTop: i ? `1px solid ${tk.borderSoft}` : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 650, color: tk.text, width: 84, flexShrink: 0 }}>{t.rma_number || '—'}</span>
                    <span style={{ fontSize: 12.5, color: tk.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.customer_name || '—'}</span>
                  </div>
                  <StatusPill status={t.ticket_status} />
                </div>
              ))}
          </div>
        )}

        {on('overdue_tickets') && (
          <div className="col-span-12 sm:col-span-6 lg:col-span-3" onClick={nav('/rma-tickets?overdue=true')}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
            <CardHead title="Overdue" action={String(overdueList.length)} tk={tk} />
            {overdueList.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <svg className="mx-auto mb-2" width="32" height="32" fill="none" stroke={tk.good} strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p style={{ color: tk.good, fontSize: 13, fontWeight: 600, margin: 0 }}>All clear!</p>
              </div>
            ) : overdueList.slice(0, 8).map((t, i) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: i ? `1px solid ${tk.borderSoft}` : 'none' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: tk.text }}>{t.rma_number || '—'}</div>
                  <div style={{ fontSize: 11.5, color: tk.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.customer_name || '—'}</div>
                </div>
                <span style={{ flexShrink: 0, marginLeft: 8, padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, color: tk.bad, background: tk.bad + '1a' }}>
                  {daysBetween(t.due_date)}d
                </span>
              </div>
            ))}
          </div>
        )}

        {on('top_issues') && (
          <div className="col-span-12 sm:col-span-6 lg:col-span-4"
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column' }}>
            <CardHead title="Top Issues" tk={tk} />
            {topIssues.length === 0
              ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '20px 0' }}>No issues recorded yet</p>
              : topIssues.map((item, idx) => {
                const maxCount = topIssues[0]?.count || 1
                return (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: idx ? 14 : 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: tk.textFaint, width: 14, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, gap: 8 }}>
                        <span style={{ fontSize: 13, color: tk.text, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.issue}</span>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: tk.textMuted, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{item.count}</span>
                      </div>
                      <div style={{ height: 6, background: tk.track, borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${(item.count / maxCount) * 100}%`, background: tk.accent, borderRadius: 3 }} />
                      </div>
                    </div>
                  </div>
                )
              })}
          </div>
        )}

        {/* ── Section: Team & Inventory ── */}
        {(on('technician_performance') || on('stat_inventory')) && (
          <SectionLabel tk={tk}>Team &amp; Inventory</SectionLabel>
        )}

        {on('technician_performance') && (
          <div className="col-span-12 lg:col-span-7"
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column' }}>
            <CardHead title="Technician Performance" action="Top 5 by close rate" tk={tk} />
            {technicianPerformance.length === 0
              ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>No assigned tickets</p>
              : (
                <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-around', gap: 12, flex: 1, paddingTop: 6 }}>
                  {technicianPerformance.map((tech) => (
                    <div key={tech.name} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: tk.text, fontVariantNumeric: 'tabular-nums' }}>{tech.closeRate}%</span>
                      <div style={{ width: '100%', maxWidth: 46, height: 120, background: tk.surfaceInset, borderRadius: 7, display: 'flex', alignItems: 'flex-end', overflow: 'hidden' }}>
                        <div style={{ width: '100%', height: `${tech.closeRate}%`, background: `linear-gradient(180deg, ${tk.accent}, ${tk.accent}8c)`, borderRadius: 6 }} />
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: tk.text, lineHeight: 1.3 }}>{tech.name}</div>
                        <div style={{ fontSize: 11, color: tk.textFaint }}>{tech.closed}/{tech.total} closed</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </div>
        )}

        {on('stat_inventory') && (
          <div className="col-span-12 sm:col-span-6 lg:col-span-5"
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column' }}>
            <CardHead title="Inventory Snapshot" action={`${invProductCounts.allUnits} units`} tk={tk} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, flex: 1 }}>
              {[
                { label: 'Received',     value: invProductCounts.received,    color: '#0ea5e9', tab: 'received'     },
                { label: 'Under Repair', value: invProductCounts.underRepair, color: '#f97316', tab: 'under-repair' },
                { label: 'Repaired',     value: invProductCounts.repaired,    color: '#14b8a6', tab: 'repaired'     },
                { label: "Can't Repair", value: invProductCounts.cantRepair,  color: '#ef4444', tab: 'cant-repair'  },
                { label: 'RMA Stock',    value: invProductCounts.rmaStock,    color: '#6366f1', tab: 'rma-stock'    },
              ].map((c) => (
                <button key={c.label} onClick={() => onNavigate?.(`/inventory?tab=${c.tab}`)}
                  style={{ background: tk.surfaceInset, borderRadius: 10, padding: '14px 12px', textAlign: 'left', border: 'none', cursor: 'pointer', transition: 'filter .15s' }}
                  onMouseEnter={(e) => e.currentTarget.style.filter = 'brightness(0.95)'}
                  onMouseLeave={(e) => e.currentTarget.style.filter = 'none'}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: c.color }} />
                    <span style={{ fontSize: 11, color: tk.textMuted, fontWeight: 550 }}>{c.label}</span>
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 760, color: tk.text, letterSpacing: -0.6, fontVariantNumeric: 'tabular-nums' }}>{c.value}</div>
                </button>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
