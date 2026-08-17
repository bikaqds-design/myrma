import React, { useState, useEffect, useMemo, Suspense, lazy } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db, supabase } from '../api/supabaseClient'
import { safeStorage } from '../lib/safeStorage'
import { WIDGET_CATALOG, resolveEnabledWidgets } from '../lib/dashboardWidgets'
import { useAppearance } from '../contexts/AppearanceContext'
import { Spinner } from '../components/ui'
import { TICKET_STATUS, TICKET_STATUS_LIST, TICKET_STATUS_RESOLVED, ROLES } from '../lib/constants'
import { useTranslation } from 'react-i18next'
import { EMPTY_ARRAY } from '../lib/stableEmpty'

const DashboardCharts = lazy(() => import('./DashboardCharts'))

// Catalog moved to lib/dashboardWidgets so AccountSettings can read it without
// importing this page. Re-exported because existing imports point here.
export { WIDGET_CATALOG }
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
function fmtCurrency(val) {
  if (!val) return '$0'
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`
  return `$${val.toFixed(0)}`
}

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
export default function Dashboard({ currentUserEmail, currentUserRole, onNavigate }) {
  const { darkMode } = useAppearance()
  const { t } = useTranslation()
  const tk = tokens(darkMode)
  const chartTickStyle  = { fontSize: 10, fill: tk.textFaint }
  const chartGridColor  = tk.grid
  const chartTooltipStyle = darkMode
    ? { backgroundColor: '#121823', border: `1px solid ${tk.border}`, borderRadius: 8, color: tk.text }
    : { backgroundColor: '#fff',    border: `1px solid ${tk.border}`, borderRadius: 8 }
  const storageKey = `dashboard_widgets_${currentUserEmail}`

  // resolveEnabledWidgets, not a fallback list: a stored preference records what
  // is switched *off*, so widgets added to the catalog since it was saved are on
  // rather than invisible. The old fallback was AppearanceContext's ten-id array,
  // which predated the CRM widgets and hid all four of them.
  const [enabledWidgets, setEnabledWidgets] = useState(() =>
    resolveEnabledWidgets(safeStorage.get(storageKey, null))
  )
  const [range, setRange] = useState('30d')
  const [rmaOpen, setRmaOpen] = useState(() => safeStorage.get('dashboard_rma_open', false))

  const queryClient = useQueryClient()
  const { data: tickets = EMPTY_ARRAY, isLoading: loading } = useQuery({
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

  // Re-read when the account changes. Must resolve, like the initial state and
  // the change listener below — assigning the raw stored value here is what
  // crashed the page with "enabledWidgets.includes is not a function" once the
  // stored shape became { v, off }.
  useEffect(() => {
    setEnabledWidgets(resolveEnabledWidgets(safeStorage.get(storageKey, null)))
  }, [storageKey])

  useEffect(() => {
    const handler = () => {
      // Resolve rather than assigning the raw value: the stored shape is
      // { v, off } now, and setting that directly would leave enabledWidgets an
      // object whose .includes() is not a function. Resolving null too, so
      // clearing the preference falls back to the whole catalog.
      setEnabledWidgets(resolveEnabledWidgets(safeStorage.get(storageKey, null)))
    }
    window.addEventListener('dashboard-widgets-changed', handler)
    return () => window.removeEventListener('dashboard-widgets-changed', handler)
  }, [storageKey])

  const on = (id) => enabledWidgets.includes(id)
  // Which widgets live under the collapsed RMA heading — everything that is not
  // one of the four CRM ones. Used to hide the disclosure entirely when a user
  // has switched all of them off, rather than leave an empty toggle.
  const CRM_WIDGET_IDS = ['crm_kpi', 'pipeline_by_stage', 'rep_leaderboard', 'overdue_followups']
  const rmaWidgetsPresent = WIDGET_CATALOG.some((w) => !CRM_WIDGET_IDS.includes(w.id) && on(w.id))
  const nav = (page) => () => onNavigate?.(page)

  const { data: overdueFollowups = EMPTY_ARRAY } = useQuery({
    queryKey: ['activities', 'overdue-count'],
    queryFn: () => db.activities.listOverdue(),
    staleTime: 60_000,
    enabled: on('overdue_followups') || on('crm_kpi'),
  })

  const crmDataEnabled = on('crm_kpi') || on('pipeline_by_stage') || on('rep_leaderboard')
  const { data: crmDeals = EMPTY_ARRAY } = useQuery({
    queryKey: ['crm-deals'],
    queryFn: () => db.deals.list(),
    staleTime: 60_000,
    enabled: crmDataEnabled,
  })
  const { data: crmLeads = EMPTY_ARRAY } = useQuery({
    queryKey: ['crm-leads'],
    queryFn: () => db.leads.list(),
    staleTime: 60_000,
    enabled: on('crm_kpi'),
  })
  const { data: crmPipelines = EMPTY_ARRAY } = useQuery({
    queryKey: ['crm-pipelines'],
    queryFn: () => db.pipelines.list(),
    staleTime: 5 * 60_000,
    enabled: on('pipeline_by_stage'),
  })

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

  const myOpenTickets = useMemo(() => {
    if (currentUserRole !== ROLES.TECHNICIAN && currentUserRole !== ROLES.VIEWER) return []
    return tickets
      .filter((t) => t.assigned_technician === currentUserEmail && !TICKET_STATUS_RESOLVED.includes(t.ticket_status))
      .sort((a, b) => {
        if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date)
        if (a.due_date) return -1
        if (b.due_date) return 1
        return new Date(b.created_date || 0) - new Date(a.created_date || 0)
      })
  }, [tickets, currentUserEmail, currentUserRole])

  const monthStart = useMemo(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString()
  }, [])

  const crmStats = useMemo(() => {
    const openPipelineValue = crmDeals.filter((d) => d.status === 'open').reduce((s, d) => s + (d.value || 0), 0)
    const dealsWonThisMonth = crmDeals.filter((d) => d.status === 'won' && d.won_at && d.won_at >= monthStart).length
    const leadsThisMonth = crmLeads.filter((l) => l.created_at >= monthStart).length
    return { openPipelineValue, dealsWonThisMonth, leadsThisMonth }
  }, [crmDeals, crmLeads, monthStart])

  const pipelineByStage = useMemo(() => {
    const openDeals = crmDeals.filter((d) => d.status === 'open')
    const allStages = crmPipelines.flatMap((p) => (p.stages || []).filter((s) => !s.is_won && !s.is_lost))
    const stageMap = {}
    openDeals.forEach((d) => {
      const stage = allStages.find((s) => s.id === d.stage)
      const name = stage?.name || d.stage
      const order = stage?.order ?? 99
      if (!stageMap[name]) stageMap[name] = { name, count: 0, value: 0, order }
      stageMap[name].count++
      stageMap[name].value += d.value || 0
    })
    return Object.values(stageMap).sort((a, b) => a.order - b.order)
  }, [crmDeals, crmPipelines])

  const repLeaderboard = useMemo(() => {
    const wonThisMonth = crmDeals.filter((d) => d.status === 'won' && d.won_at && d.won_at >= monthStart)
    const repMap = {}
    wonThisMonth.forEach((d) => {
      const rep = d.assigned_rep || '—'
      if (!repMap[rep]) repMap[rep] = { rep, count: 0, value: 0 }
      repMap[rep].count++
      repMap[rep].value += d.value || 0
    })
    return Object.values(repMap).sort((a, b) => b.count - a.count || b.value - a.value).slice(0, 5)
  }, [crmDeals, monthStart])

  const RANK_COLORS = ['#f59e0b', '#94a3b8', '#cd7f32']

  const daysBetween = (a) => Math.ceil((new Date() - new Date(a)) / 86400000)
  const openActive = (statusCounts[TICKET_STATUS.OPEN] || 0) + (statusCounts[TICKET_STATUS.IN_PROGRESS] || 0) +
    (statusCounts[TICKET_STATUS.PENDING] || 0) + (statusCounts[TICKET_STATUS.ON_HOLD] || 0)
  const sparkWeekly = weeklyTrend.map((d) => d.tickets)

  // Payload for the currently-hidden <AIAssist> panel. Kept (underscore-prefixed
  // to satisfy lint) because the ai-assist Edge Function and ai.assist() helper
  // are retained for future re-enabling — see CLAUDE.md.
  const _dashboardAIData = useMemo(() => ({
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
          <h1 style={{ margin: 0, fontSize: 25, fontWeight: 750, letterSpacing: -0.5, color: tk.text }}>{t('dashboard.title')}</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13.5, color: tk.textMuted }}>{t('dashboard.systemOverview')} · {t('dashboard.updatedJustNow')}</p>
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

      {!hasWidgets && (
        <div style={{ background: tk.surface, border: `2px dashed ${tk.border}`, borderRadius: 14, padding: '56px 0', textAlign: 'center' }}>
          <p style={{ color: tk.textMuted, fontWeight: 600, margin: 0 }}>{t('dashboard.noWidgets')}</p>
          <p style={{ color: tk.textFaint, fontSize: 13, marginTop: 4 }}>{t('dashboard.noWidgetsHint')}</p>
        </div>
      )}

      {/* ── My Open Tickets (technician / viewer only) ── */}
      {myOpenTickets.length > 0 && (
        <div className="mb-4"
          style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18 }}>
          <CardHead title={t('dashboard.myOpenTickets')} action={`${myOpenTickets.length} ${t('common.open')}`} tk={tk} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {myOpenTickets.slice(0, 6).map((ticket) => {
              const isDue = ticket.due_date && new Date(ticket.due_date) < new Date()
              const dueInDays = ticket.due_date
                ? Math.ceil((new Date(ticket.due_date) - new Date()) / 86400000)
                : null
              return (
                <div key={ticket.id}
                  onClick={() => onNavigate?.(`/rma-tickets?ticket=${ticket.id}`)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                    borderRadius: 10, background: tk.surfaceInset, cursor: 'pointer',
                    border: `1px solid ${tk.borderSoft}`,
                  }}>
                  <StatusPill status={ticket.ticket_status} />
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: tk.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ticket.rma_number} · {ticket.customer_name}
                  </span>
                  {dueInDays !== null && (
                    <span style={{ fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', color: isDue ? tk.bad : dueInDays <= 2 ? tk.warn : tk.textMuted }}>
                      {isDue ? t('dashboard.overdue') : `${t('dashboard.dueSoon')} ${dueInDays}d`}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">

        {/* ── Section: CRM ── */}
        {(on('crm_kpi') || on('pipeline_by_stage') || on('rep_leaderboard') || on('overdue_followups')) && (
          <SectionLabel tk={tk}>{t('dashboard.crmSection')}</SectionLabel>
        )}

        {/* CRM KPI tiles */}
        {on('crm_kpi') && (
          <>
            {[
              { label: t('dashboard.openPipelineValue'), value: fmtCurrency(crmStats.openPipelineValue), color: tk.accent,  caption: t('dashboard.openDealsCaption') },
              { label: t('dashboard.dealsWonThisMonth'), value: crmStats.dealsWonThisMonth,              color: tk.good,    caption: t('dashboard.thisMonth') },
              { label: t('dashboard.leadsThisMonth'),   value: crmStats.leadsThisMonth,                 color: '#6366f1',  caption: t('dashboard.thisMonth') },
              { label: t('dashboard.overdueFollowupsKpi'), value: overdueFollowups.length,              color: tk.bad,     caption: t('dashboard.needsAttention') },
            ].map(({ label, value, color, caption }) => (
              <div key={label} className="col-span-12 sm:col-span-6 lg:col-span-3"
                style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', gap: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: tk.textMuted, letterSpacing: 0.1 }}>{label}</span>
                <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 8 }}>
                  <span style={{ fontSize: 40, fontWeight: 780, color, letterSpacing: -1.4, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
                </div>
                <div style={{ marginTop: 10 }}>
                  <span style={{ fontSize: 12, color: tk.textMuted }}>{caption}</span>
                </div>
              </div>
            ))}
          </>
        )}

        {/* Pipeline by Stage */}
        {on('pipeline_by_stage') && (
          <div className="col-span-12 lg:col-span-6"
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18 }}>
            <CardHead title={t('dashboard.pipelineByStage')} action={t('dashboard.openDealsOnly')} tk={tk} />
            {pipelineByStage.length === 0 ? (
              <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>{t('dashboard.noOpenDeals')}</p>
            ) : (() => {
              const maxCount = Math.max(...pipelineByStage.map((s) => s.count), 1)
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {pipelineByStage.map((s) => (
                    <div key={s.name}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: tk.text }}>{s.name}</span>
                        <span style={{ fontSize: 12, color: tk.textMuted }}>{s.count} · {fmtCurrency(s.value)}</span>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: tk.track }}>
                        <div style={{ height: 6, borderRadius: 3, background: tk.accent, width: `${(s.count / maxCount) * 100}%`, transition: 'width 0.5s ease' }} />
                      </div>
                    </div>
                  ))}
                </div>
              )
            })()}
          </div>
        )}

        {/* Rep Leaderboard */}
        {on('rep_leaderboard') && (
          <div className="col-span-12 lg:col-span-6"
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18 }}>
            <CardHead title={t('dashboard.repLeaderboard')} action={t('dashboard.dealsWonThisMonthLabel')} tk={tk} />
            {repLeaderboard.length === 0 ? (
              <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>{t('dashboard.noDealsWonYet')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {repLeaderboard.map((r, i) => (
                  <div key={r.rep} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: i ? `1px solid ${tk.borderSoft}` : 'none' }}>
                    <span style={{ width: 24, height: 24, borderRadius: '50%', background: i < 3 ? RANK_COLORS[i] : tk.track, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                      {i + 1}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: tk.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.rep}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: tk.good }}>{r.count}</div>
                      <div style={{ fontSize: 11, color: tk.textMuted }}>{fmtCurrency(r.value)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {on('overdue_followups') && (
          <div
            className="col-span-12 sm:col-span-6 lg:col-span-3"
            onClick={nav('/activities?tab=overdue')}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}
          >
            <CardHead title={t('dashboard.overdueFollowups')} action={String(overdueFollowups.length)} tk={tk} />
            {overdueFollowups.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <svg className="mx-auto mb-2" width="32" height="32" fill="none" stroke={tk.good} strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p style={{ color: tk.good, fontSize: 13, fontWeight: 600, margin: 0 }}>{t('dashboard.allClear')}</p>
              </div>
            ) : overdueFollowups.slice(0, 8).map((a, i) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: i ? `1px solid ${tk.borderSoft}` : 'none' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: tk.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</div>
                  <div style={{ fontSize: 11.5, color: tk.textMuted }}>{a.assigned_rep ?? '—'}</div>
                </div>
                <span style={{ flexShrink: 0, marginLeft: 8, padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, color: tk.bad, background: tk.bad + '1a' }}>
                  {Math.ceil((new Date() - new Date(a.due_date)) / 86400000)}d
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ── RMA block ────────────────────────────────────────────────────
            Collapsed by default. Twelve of the sixteen widgets describe RMA
            tickets, of which this database has 13, against 888 customers and
            57 deals. The tickets still matter, so nothing is removed — the
            page just no longer opens on them. State is per browser, not per
            account, because it is a viewing preference rather than a setting. */}
        {rmaWidgetsPresent && (
          <div className="col-span-12" style={{ display: "flex", alignItems: "center", gap: 12, margin: "10px 0 -4px" }}>
            <button
              onClick={() => setRmaOpen((o) => { safeStorage.set("dashboard_rma_open", !o); return !o })}
              aria-expanded={rmaOpen}
              style={{ display: "flex", alignItems: "center", gap: 7, background: "none", border: "none", padding: 0, cursor: "pointer",
                       fontSize: 11, fontWeight: 700, letterSpacing: "1.2px", color: tk.textFaint, textTransform: "uppercase", whiteSpace: "nowrap" }}
            >
              <span style={{ display: "inline-block", transition: "transform .18s", transform: rmaOpen ? "rotate(90deg)" : "none" }}>▸</span>
              {t("dashboard.rmaSection")}
            </button>
            <span style={{ flex: 1, height: 1, background: tk.border }} />
          </div>
        )}

        {rmaOpen && (<>
        {/* ── Hero KPI tiles ── */}
        {on('stat_tickets') && (
          <>
            {[
              { label: t('dashboard.totalTickets'), value: totalTickets, color: tk.text, spark: sparkWeekly, delta: '+8%', deltaUp: true },
              { label: t('dashboard.activeOpen'),  value: openActive,   color: tk.accent, spark: [12,14,11,17,15,16,openActive], caption: t('dashboard.across4States') },
              { label: t('dashboard.overdue'),        value: overdueList.length, color: tk.bad, spark: [3,4,5,4,6,6,overdueList.length], caption: t('dashboard.needsAttention') },
              { label: t('dashboard.slaOntime'),    value: `${slaPercent}%`, color: tk.good, spark: [92,93,94,95,95,96,slaPercent], delta: '+2%', deltaUp: true },
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
              { label: t('statusValues.Open'),        value: statusCounts[TICKET_STATUS.OPEN],        navPath: `/rma-tickets?status=${TICKET_STATUS.OPEN}` },
              { label: t('statusValues.In Progress'), value: statusCounts[TICKET_STATUS.IN_PROGRESS], navPath: `/rma-tickets?status=${TICKET_STATUS.IN_PROGRESS}` },
              { label: t('statusValues.Pending'),     value: statusCounts[TICKET_STATUS.PENDING],     navPath: `/rma-tickets?status=${TICKET_STATUS.PENDING}` },
              { label: t('statusValues.On Hold'),     value: statusCounts[TICKET_STATUS.ON_HOLD],     navPath: `/rma-tickets?status=${TICKET_STATUS.ON_HOLD}` },
              { label: t('statusValues.Completed'),   value: statusCounts[TICKET_STATUS.COMPLETED],   navPath: `/rma-tickets?status=${TICKET_STATUS.COMPLETED}` },
              { label: t('statusValues.Closed'),      value: statusCounts[TICKET_STATUS.CLOSED],      navPath: `/rma-tickets?status=${TICKET_STATUS.CLOSED}` },
              { label: t('statusValues.Cancelled'),   value: statusCounts[TICKET_STATUS.CANCELLED],   navPath: `/rma-tickets?status=${TICKET_STATUS.CANCELLED}` },
              { label: t('statusValues.Overdue'),     value: overdueList.length,                      navPath: '/rma-tickets?overdue=true' },
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
          <SectionLabel tk={tk}>{t('dashboard.performance')}</SectionLabel>
        )}

        {on('sla_health') && (
          <div className="col-span-12 sm:col-span-6 lg:col-span-3" onClick={nav('/rma-tickets?overdue=true')}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
            <CardHead title={t('dashboard.slaHealth')} tk={tk} />
            <SvgGauge percent={slaPercent} color={slaPercent >= 80 ? tk.good : slaPercent >= 60 ? tk.warn : tk.bad} tk={tk} />
            <p style={{ margin: '10px 0 0', fontSize: 11.5, color: tk.textMuted, textAlign: 'center' }}>
              {onScheduleCount}/{trackedCount} {t('dashboard.onSchedule')}
            </p>
          </div>
        )}

        {on('resolution_rate') && (
          <div className="col-span-12 sm:col-span-6 lg:col-span-3" onClick={nav(`/rma-tickets?status=${TICKET_STATUS.CLOSED}`)}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
            <CardHead title={t('dashboard.resolutionRate')} tk={tk} />
            <SvgGauge percent={resolutionPercent} color={resolutionPercent >= 70 ? tk.good : resolutionPercent >= 40 ? tk.warn : tk.accent} tk={tk} />
            <p style={{ margin: '10px 0 0', fontSize: 11.5, color: tk.textMuted, textAlign: 'center' }}>
              {closedTickets}/{totalTickets} {t('dashboard.resolvedOrClosed')}
            </p>
          </div>
        )}

        {on('status_distribution') && (
          <div className="col-span-12 sm:col-span-6 lg:col-span-3" onClick={nav('/rma-tickets')}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
            <CardHead title={t('dashboard.statusMix')} tk={tk} />
            {statusDist.length === 0
              ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>{t('common.noData')}</p>
              : <DonutWithLegend segments={statusDist} tk={tk} />}
          </div>
        )}

        {on('priority_distribution') && (
          <div className="col-span-12 sm:col-span-6 lg:col-span-3" onClick={nav('/rma-tickets')}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
            <CardHead title={t('dashboard.priorityMix')} tk={tk} />
            {priorityDist.length === 0
              ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>{t('common.noData')}</p>
              : <DonutWithLegend segments={priorityDist} tk={tk} />}
          </div>
        )}

        {/* ── Section: Trends ── */}
        {(on('weekly_trend') || on('monthly_trend')) && (
          <SectionLabel tk={tk}>{t('dashboard.trends')}</SectionLabel>
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
          <SectionLabel tk={tk}>{t('dashboard.activity')}</SectionLabel>
        )}

        {on('recent_tickets') && (
          <div className="col-span-12 lg:col-span-5" onClick={nav('/rma-tickets')}
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
            <CardHead title={t('dashboard.recentTickets')} action={t('common.viewAll')} tk={tk} />
            {recentTickets.length === 0
              ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '20px 0' }}>{t('dashboard.noTicketsYet')}</p>
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
            <CardHead title={t('dashboard.overdueTickets')} action={String(overdueList.length)} tk={tk} />
            {overdueList.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <svg className="mx-auto mb-2" width="32" height="32" fill="none" stroke={tk.good} strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p style={{ color: tk.good, fontSize: 13, fontWeight: 600, margin: 0 }}>{t('dashboard.allClear')}</p>
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
            <CardHead title={t('dashboard.topIssues')} tk={tk} />
            {topIssues.length === 0
              ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '20px 0' }}>{t('dashboard.noIssuesRecorded')}</p>
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
          <SectionLabel tk={tk}>{t('dashboard.teamInventory')}</SectionLabel>
        )}

        {on('technician_performance') && (
          <div className="col-span-12 lg:col-span-7"
            style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column' }}>
            <CardHead title={t('dashboard.technicianPerformance')} action={t('dashboard.top5ByCloseRate')} tk={tk} />
            {technicianPerformance.length === 0
              ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>{t('dashboard.noAssignedTickets')}</p>
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
                        <div style={{ fontSize: 11, color: tk.textFaint }}>{tech.closed}/{tech.total} {t('dashboard.closedLabel')}</div>
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
            <CardHead title={t('dashboard.inventorySnapshot')} action={`${invProductCounts.allUnits} ${t('dashboard.units')}`} tk={tk} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, flex: 1 }}>
              {[
                { label: t('inventory.received'),    value: invProductCounts.received,    color: '#0ea5e9' },
                { label: t('inventory.underRepair'), value: invProductCounts.underRepair, color: '#f97316' },
                { label: t('inventory.repaired'),    value: invProductCounts.repaired,    color: '#14b8a6' },
                { label: t('inventory.cantRepair'),  value: invProductCounts.cantRepair,  color: '#ef4444' },
                { label: t('inventory.rmaStock'),    value: invProductCounts.rmaStock,    color: '#6366f1' },
              ].map((c) => (
                <button key={c.label} onClick={() => onNavigate?.('/inventory')}
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

        </>)}

      </div>
    </div>
  )
}
