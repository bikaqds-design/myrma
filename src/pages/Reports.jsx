import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { db } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { Spinner, PageHeader } from '../components/ui'
import { useAppearance } from '../contexts/AppearanceContext'

// ─── CSV Utility ──────────────────────────────────────────────────────────────
function downloadCSV(rows, columns, filename) {
  if (!rows.length) { toast('No data to export'); return }
  const headers = columns.map(c => c.label)
  const escape = v => { const s = String(v ?? '').replace(/"/g, '""'); return s.includes(',') || s.includes('\n') || s.includes('"') ? `"${s}"` : s }
  const csv = [headers.join(','), ...rows.map(r => columns.map(c => escape(r[c.key] ?? '')).join(','))].join('\r\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
  toast.success(`Exported ${rows.length} rows`)
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function startOfDay(date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0); return d
}
function endOfDay(date) {
  const d = new Date(date); d.setHours(23, 59, 59, 999); return d
}
function toYMD(date) {
  return new Date(date).toISOString().split('T')[0]
}
function resolutionHours(ticket) {
  if (ticket.ticket_status !== 'Completed' || !ticket.updated_date) return null
  const ms = new Date(ticket.updated_date) - new Date(ticket.created_date)
  return ms > 0 ? (ms / 3600000).toFixed(1) : null
}
function inRange(dateStr, from, to) {
  if (!dateStr) return false
  const d = new Date(dateStr)
  return d >= startOfDay(from) && d <= endOfDay(to)
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, icon, color = 'indigo', sub }) {
  const colors = {
    indigo: { bg: 'bg-indigo-50', icon: 'text-indigo-600', val: 'text-indigo-700' },
    green:  { bg: 'bg-green-50',  icon: 'text-green-600',  val: 'text-green-700'  },
    amber:  { bg: 'bg-amber-50',  icon: 'text-amber-600',  val: 'text-amber-700'  },
    red:    { bg: 'bg-red-50',    icon: 'text-red-600',    val: 'text-red-700'    },
    blue:   { bg: 'bg-blue-50',   icon: 'text-blue-600',   val: 'text-blue-700'   },
    purple: { bg: 'bg-purple-50', icon: 'text-purple-600', val: 'text-purple-700' },
  }
  const c = colors[color] || colors.indigo
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-start gap-4">
      <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center flex-shrink-0`}>
        <svg className={`w-5 h-5 ${c.icon}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
        </svg>
      </div>
      <div className="min-w-0">
        <p className={`text-2xl font-bold ${c.val} leading-none`}>{value}</p>
        <p className="text-sm text-gray-500 mt-1">{label}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

// ─── Migration Banner ─────────────────────────────────────────────────────────
function MigrationBanner({ table, children }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl">
      <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      <div className="text-sm text-amber-800">
        <span className="font-semibold">The <code className="font-mono bg-amber-100 px-1 rounded">{table}</code> table has not been set up.</span>{' '}
        {children || 'Run the required SQL migration in Supabase to enable this feature.'}
      </div>
    </div>
  )
}

// ─── Status Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    'New':         'bg-blue-100 text-blue-700',
    'In Progress': 'bg-yellow-100 text-yellow-700',
    'On Hold':     'bg-orange-100 text-orange-700',
    'Completed':   'bg-green-100 text-green-700',
    'Cancelled':   'bg-gray-100 text-gray-500',
  }
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${map[status] || 'bg-gray-100 text-gray-600'}`}>{status || '—'}</span>
}

function PriorityBadge({ priority }) {
  const map = {
    'Critical': 'bg-red-100 text-red-700',
    'High':     'bg-orange-100 text-orange-700',
    'Medium':   'bg-yellow-100 text-yellow-700',
    'Low':      'bg-gray-100 text-gray-600',
  }
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${map[priority] || 'bg-gray-100 text-gray-600'}`}>{priority || '—'}</span>
}

// ─── Tickets Tab ──────────────────────────────────────────────────────────────
function TicketsTab({ tickets, onNavigateToTicket, formatDate }) {
  const [filterStatus, setFilterStatus]       = useState('')
  const [filterPriority, setFilterPriority]   = useState('')
  const [filterTechnician, setFilterTechnician] = useState('')

  const statuses    = useMemo(() => [...new Set(tickets.map(t => t.ticket_status).filter(Boolean))].sort(), [tickets])
  const priorities  = useMemo(() => [...new Set(tickets.map(t => t.priority).filter(Boolean))].sort(), [tickets])
  const technicians = useMemo(() => [...new Set(tickets.map(t => t.assigned_technician).filter(Boolean))].sort(), [tickets])

  const filtered = useMemo(() => {
    let list = [...tickets]
    if (filterStatus)     list = list.filter(t => t.ticket_status === filterStatus)
    if (filterPriority)   list = list.filter(t => t.priority === filterPriority)
    if (filterTechnician) list = list.filter(t => t.assigned_technician === filterTechnician)
    return list
  }, [tickets, filterStatus, filterPriority, filterTechnician])

  const total       = filtered.length
  const completed   = filtered.filter(t => t.ticket_status === 'Completed')
  const overdue     = filtered.filter(t => t.due_date && new Date(t.due_date) < new Date() && t.ticket_status !== 'Completed' && t.ticket_status !== 'Cancelled')
  const resolveTimes = completed.map(t => resolutionHours(t)).filter(v => v !== null).map(Number)
  const avgResolve   = resolveTimes.length ? (resolveTimes.reduce((s, v) => s + v, 0) / resolveTimes.length).toFixed(1) : '—'

  const completedWithDue = completed.filter(t => t.due_date)
  const slaMet = completedWithDue.filter(t => !t.due_date || new Date(t.updated_date) <= new Date(t.due_date))
  const slaPct = completedWithDue.length ? Math.round(slaMet.length / completedWithDue.length * 100) : '—'

  const handleExport = () => {
    const columns = [
      { key: 'rma_number', label: 'RMA #' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'ticket_status', label: 'Status' },
      { key: 'priority', label: 'Priority' },
      { key: 'assigned_technician', label: 'Technician' },
      { key: 'created_date', label: 'Created' },
      { key: 'due_date', label: 'Due' },
      { key: 'resolved_date', label: 'Resolved' },
      { key: 'resolution_hrs', label: 'Resolution (hrs)' },
    ]
    const rows = filtered.map(t => ({
      rma_number: t.rma_number || '',
      customer_name: t.customer_name || '',
      ticket_status: t.ticket_status || '',
      priority: t.priority || '',
      assigned_technician: t.assigned_technician || '',
      created_date: formatDate(t.created_date),
      due_date: formatDate(t.due_date),
      resolved_date: t.ticket_status === 'Completed' ? formatDate(t.updated_date) : '',
      resolution_hrs: resolutionHours(t) ?? 'Open',
    }))
    downloadCSV(rows, columns, `tickets-report-${toYMD(new Date())}.csv`)
  }

  const sel = 'px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white'

  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Tickets" value={total} color="indigo" icon="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        <KpiCard label="Avg Resolution Time" value={avgResolve === '—' ? '—' : `${avgResolve}h`} color="blue" icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        <KpiCard label="SLA Compliance" value={slaPct === '—' ? '—' : `${slaPct}%`} color="green" icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        <KpiCard label="Overdue Rate" value={total ? `${Math.round(overdue.length / total * 100)}%` : '—'} color="red" icon="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" sub={`${overdue.length} overdue`} />
      </div>

      {/* Filters + Export */}
      <div className="flex items-center gap-3 flex-wrap">
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className={sel}>
          <option value="">All Statuses</option>
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filterPriority} onChange={e => setFilterPriority(e.target.value)} className={sel}>
          <option value="">All Priorities</option>
          {priorities.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={filterTechnician} onChange={e => setFilterTechnician(e.target.value)} className={sel}>
          <option value="">All Technicians</option>
          {technicians.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <span className="text-sm text-gray-400">{filtered.length} ticket{filtered.length !== 1 ? 's' : ''}</span>
        <button onClick={handleExport} className="ml-auto flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          Export CSV
        </button>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <p className="text-sm text-gray-400">No tickets match the selected filters</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['RMA #', 'Customer', 'Status', 'Priority', 'Technician', 'Created', 'Due', 'Resolved', 'Resolution'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(t => {
                  const hrs = resolutionHours(t)
                  return (
                    <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => onNavigateToTicket?.(t.id)}
                          className="font-mono text-indigo-600 hover:text-indigo-800 hover:underline text-xs font-medium">
                          {t.rma_number || t.id?.slice(0, 8)}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-gray-700 max-w-[160px] truncate">{t.customer_name || '—'}</td>
                      <td className="px-4 py-3"><StatusBadge status={t.ticket_status} /></td>
                      <td className="px-4 py-3"><PriorityBadge priority={t.priority} /></td>
                      <td className="px-4 py-3 text-gray-500 text-xs max-w-[120px] truncate">{t.assigned_technician || '—'}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{formatDate(t.created_date)}</td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">
                        {t.due_date
                          ? <span className={new Date(t.due_date) < new Date() && t.ticket_status !== 'Completed' ? 'text-red-600 font-medium' : 'text-gray-500'}>{formatDate(t.due_date)}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {t.ticket_status === 'Completed' ? formatDate(t.updated_date) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {hrs !== null
                          ? <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">{hrs}h</span>
                          : <span className="text-gray-400">Open</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Customers Tab ────────────────────────────────────────────────────────────
function CustomersTab({ customers, tickets, formatDate }) {
  const customerStats = useMemo(() => {
    const map = {}
    for (const t of tickets) {
      if (!t.customer_id && !t.customer_name) continue
      const key = t.customer_id || t.customer_name
      if (!map[key]) map[key] = { total: 0, open: 0, lastActivity: null, customerId: t.customer_id, customerName: t.customer_name }
      map[key].total++
      if (t.ticket_status !== 'Completed' && t.ticket_status !== 'Cancelled') map[key].open++
      if (!map[key].lastActivity || t.created_date > map[key].lastActivity) map[key].lastActivity = t.created_date
    }
    return map
  }, [tickets])

  const enriched = useMemo(() => customers.map(c => {
    const stats = customerStats[c.id] || { total: 0, open: 0, lastActivity: null }
    return { ...c, totalTickets: stats.total, openTickets: stats.open, lastActivity: stats.lastActivity }
  }).sort((a, b) => b.totalTickets - a.totalTickets), [customers, customerStats])

  const totalActive  = customers.filter(c => c.customer_status === 'Active').length
  const avgTickets   = customers.length ? (tickets.length / customers.length).toFixed(1) : '—'
  const topReturning = enriched.filter(c => c.totalTickets > 1).length

  const handleExport = () => {
    const columns = [
      { key: 'name', label: 'Customer Name' },
      { key: 'company', label: 'Company' },
      { key: 'total', label: 'Total Tickets' },
      { key: 'open', label: 'Open Tickets' },
      { key: 'last', label: 'Last Activity' },
    ]
    const rows = enriched.map(c => ({
      name: c.contact_person || c.company_name || '',
      company: c.company_name || '',
      total: c.totalTickets,
      open: c.openTickets,
      last: formatDate(c.lastActivity),
    }))
    downloadCSV(rows, columns, `customers-report-${toYMD(new Date())}.csv`)
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <KpiCard label="Active Customers" value={totalActive} color="indigo" icon="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        <KpiCard label="Avg Tickets / Customer" value={avgTickets} color="blue" icon="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        <KpiCard label="Returning Customers" value={topReturning} color="green" icon="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </div>

      <div className="flex justify-end">
        <button onClick={handleExport} className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          Export CSV
        </button>
      </div>

      {enriched.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <p className="text-sm text-gray-400">No customer data in range</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Customer Name', 'Company', 'Total Tickets', 'Open Tickets', 'Last Activity'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {enriched.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">{c.contact_person || '—'}</td>
                    <td className="px-4 py-3 text-gray-500">{c.company_name || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700">{c.totalTickets}</span>
                    </td>
                    <td className="px-4 py-3">
                      {c.openTickets > 0
                        ? <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">{c.openTickets}</span>
                        : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{c.lastActivity ? formatDate(c.lastActivity) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Technicians Tab ──────────────────────────────────────────────────────────
function TechniciansTab({ tickets, timeEntries, timeEntriesMissing, formatDate }) {
  const stats = useMemo(() => {
    const map = {}
    for (const t of tickets) {
      const tech = t.assigned_technician
      if (!tech) continue
      if (!map[tech]) map[tech] = { email: tech, assigned: 0, completed: 0, resolveTimes: [], hoursLogged: 0 }
      map[tech].assigned++
      if (t.ticket_status === 'Completed') {
        map[tech].completed++
        const hrs = resolutionHours(t)
        if (hrs !== null) map[tech].resolveTimes.push(Number(hrs))
      }
    }
    if (!timeEntriesMissing) {
      for (const e of timeEntries) {
        const tech = e.user_email || e.technician_email
        if (tech && map[tech]) map[tech].hoursLogged += (e.duration_min || 0) / 60
      }
    }
    return Object.values(map).sort((a, b) => b.assigned - a.assigned)
  }, [tickets, timeEntries, timeEntriesMissing])

  const activeTechs = stats.length
  const avgAssigned = activeTechs ? (tickets.length / activeTechs).toFixed(1) : '—'
  const totalHours  = timeEntriesMissing ? null : stats.reduce((s, t) => s + t.hoursLogged, 0).toFixed(1)

  const handleExport = () => {
    const columns = [
      { key: 'email', label: 'Technician' },
      { key: 'assigned', label: 'Assigned Tickets' },
      { key: 'completed', label: 'Completed Tickets' },
      { key: 'avgResolve', label: 'Avg Resolution (hrs)' },
      { key: 'hoursLogged', label: 'Hours Logged' },
    ]
    const rows = stats.map(t => ({
      email: t.email,
      assigned: t.assigned,
      completed: t.completed,
      avgResolve: t.resolveTimes.length ? (t.resolveTimes.reduce((s, v) => s + v, 0) / t.resolveTimes.length).toFixed(1) : '—',
      hoursLogged: timeEntriesMissing ? 'N/A' : t.hoursLogged.toFixed(1),
    }))
    downloadCSV(rows, columns, `technicians-report-${toYMD(new Date())}.csv`)
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <KpiCard label="Active Technicians" value={activeTechs} color="purple" icon="M16 7a4 4 0 11-8 0 4 4 0 018 0M12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        <KpiCard label="Avg Tickets Assigned" value={avgAssigned} color="blue" icon="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        <KpiCard
          label="Total Hours Logged"
          value={totalHours !== null ? `${totalHours}h` : 'N/A'}
          color="green"
          icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          sub={timeEntriesMissing ? 'time_entries table not set up' : undefined}
        />
      </div>

      {timeEntriesMissing && <MigrationBanner table="time_entries">Time tracking data is unavailable until the migration is run.</MigrationBanner>}

      <div className="flex justify-end">
        <button onClick={handleExport} className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          Export CSV
        </button>
      </div>

      {stats.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <p className="text-sm text-gray-400">No assigned tickets in range</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Technician', 'Assigned', 'Completed', 'Avg Resolution (hrs)', 'Hours Logged'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {stats.map(t => {
                  const avgRes = t.resolveTimes.length
                    ? (t.resolveTimes.reduce((s, v) => s + v, 0) / t.resolveTimes.length).toFixed(1)
                    : null
                  return (
                    <tr key={t.email} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900 text-xs">{t.email}</td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700">{t.assigned}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">{t.completed}</span>
                      </td>
                      <td className="px-4 py-3">
                        {avgRes !== null
                          ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">{avgRes}h</span>
                          : <span className="text-gray-300 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {timeEntriesMissing ? 'N/A' : `${t.hoursLogged.toFixed(1)}h`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Financial Tab ────────────────────────────────────────────────────────────
function FinancialTab({ invoices, invoicesMissing, formatDate }) {
  if (invoicesMissing) return (
    <div className="space-y-4">
      <MigrationBanner table="invoices">Invoice data is unavailable. Set up the invoices table to enable financial reporting.</MigrationBanner>
    </div>
  )

  const INV_STATUS_CLS = {
    paid:     'bg-green-100 text-green-700',
    pending:  'bg-yellow-100 text-yellow-700',
    overdue:  'bg-red-100 text-red-700',
    draft:    'bg-gray-100 text-gray-600',
    voided:   'bg-gray-100 text-gray-400',
  }

  const totalInvoiced = invoices.reduce((s, i) => s + (i.total_amount || i.amount || 0), 0)
  const totalPaid     = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + (i.total_amount || i.amount || 0), 0)
  const totalPending  = invoices.filter(i => i.status === 'pending' || i.status === 'overdue').reduce((s, i) => s + (i.total_amount || i.amount || 0), 0)
  const quotesVal     = invoices.filter(i => i.type === 'quote' || i.invoice_type === 'quote').reduce((s, i) => s + (i.total_amount || i.amount || 0), 0)

  const fmt$ = v => `$${Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`

  const handleExport = () => {
    const columns = [
      { key: 'invoice_number', label: 'Invoice #' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'type', label: 'Type' },
      { key: 'status', label: 'Status' },
      { key: 'amount', label: 'Total' },
      { key: 'due_date', label: 'Due Date' },
    ]
    const rows = invoices.map(i => ({
      invoice_number: i.invoice_number || '',
      customer_name: i.customer_name || '',
      type: i.type || i.invoice_type || '',
      status: i.status || '',
      amount: i.total_amount || i.amount || 0,
      due_date: formatDate(i.due_date),
    }))
    downloadCSV(rows, columns, `financial-report-${toYMD(new Date())}.csv`)
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Invoiced" value={fmt$(totalInvoiced)} color="indigo" icon="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        <KpiCard label="Total Paid" value={fmt$(totalPaid)} color="green" icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        <KpiCard label="Pending / Overdue" value={fmt$(totalPending)} color="amber" icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        <KpiCard label="Quotes Value" value={fmt$(quotesVal)} color="blue" icon="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </div>

      <div className="flex justify-end">
        <button onClick={handleExport} className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          Export CSV
        </button>
      </div>

      {invoices.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <p className="text-sm text-gray-400">No invoices in the selected date range</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Invoice #', 'Customer', 'Type', 'Status', 'Total', 'Due Date'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {invoices.map(inv => (
                  <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs font-medium text-gray-900">{inv.invoice_number || '—'}</td>
                    <td className="px-4 py-3 text-gray-700 max-w-[150px] truncate">{inv.customer_name || '—'}</td>
                    <td className="px-4 py-3 text-gray-500 capitalize text-xs">{inv.type || inv.invoice_type || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${INV_STATUS_CLS[inv.status] || 'bg-gray-100 text-gray-600'}`}>
                        {inv.status || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold text-gray-900 tabular-nums">{fmt$(inv.total_amount || inv.amount || 0)}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {inv.due_date
                        ? <span className={new Date(inv.due_date) < new Date() && inv.status !== 'paid' ? 'text-red-600 font-medium' : ''}>{formatDate(inv.due_date)}</span>
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Reports({ currentUserRole, currentUserEmail, currentUserPermissions, onNavigateToTicket }) {
  const { formatDate, formatDateTime } = useAppearance()

  const canDo = (action) => {
    if (currentUserRole === 'super_admin' || currentUserRole === 'admin') return true
    return currentUserPermissions?.reports?.[action] === true
  }

  const isAdminOrManager = currentUserRole === 'super_admin' || currentUserRole === 'admin' || currentUserRole === 'manager'
  const isViewer         = currentUserRole === 'viewer'
  const isTechnician     = currentUserRole === 'technician'

  // Date range state
  const today = toYMD(new Date())
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return toYMD(d)
  })
  const [toDate, setToDate] = useState(today)

  // Tab state — viewers/technicians can only see Tickets
  const allTabs = [
    { id: 'tickets', label: 'Tickets' },
    ...(isAdminOrManager ? [
      { id: 'customers', label: 'Customers' },
      { id: 'technicians', label: 'Technicians' },
      { id: 'financial', label: 'Financial' },
    ] : []),
  ]
  const [activeTab, setActiveTab] = useState('tickets')

  // Data state
  const [tickets, setTickets]               = useState([])
  const [customers, setCustomers]           = useState([])
  const [timeEntries, setTimeEntries]       = useState([])
  const [timeEntriesMissing, setTeam]       = useState(false)
  const [invoices, setInvoices]             = useState([])
  const [invoicesMissing, setInvMissing]    = useState(false)
  const [loading, setLoading]               = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [tkRes, custRes, teRes, invRes] = await Promise.all([
        db.rmaTickets.list(),
        db.customers.list(),
        isAdminOrManager ? db.timeEntries.listAll() : Promise.resolve({ missing: false, data: [] }),
        isAdminOrManager ? db.invoices.list() : Promise.resolve({ missing: false, data: [] }),
      ])
      setTickets(tkRes || [])
      setCustomers(custRes || [])
      if (teRes.missing) { setTeam(true); setTimeEntries([]) }
      else { setTeam(false); setTimeEntries(teRes.data || []) }
      if (invRes.missing) { setInvMissing(true); setInvoices([]) }
      else { setInvMissing(false); setInvoices(invRes.data || []) }
    } catch { toast.error('Failed to load report data') }
    finally { setLoading(false) }
  }, [isAdminOrManager])

  useEffect(() => { load() }, [load])

  // Apply date range filter
  const filteredTickets = useMemo(() =>
    tickets.filter(t => inRange(t.created_date, fromDate, toDate)),
    [tickets, fromDate, toDate]
  )
  const filteredCustomers = useMemo(() =>
    customers.filter(c => inRange(c.created_date, fromDate, toDate)),
    [customers, fromDate, toDate]
  )
  const filteredInvoices = useMemo(() =>
    invoices.filter(i => inRange(i.created_date, fromDate, toDate)),
    [invoices, fromDate, toDate]
  )

  // Preset date ranges
  const applyPreset = (days) => {
    const d = new Date(); d.setDate(d.getDate() - days)
    setFromDate(toYMD(d)); setToDate(today)
  }
  const applyThisYear = () => {
    setFromDate(`${new Date().getFullYear()}-01-01`); setToDate(today)
  }

  const inputCls = 'px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent'
  const presetCls = (active) => `px-3 py-1.5 text-xs rounded-lg border transition-colors ${active ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`

  const isPreset7   = fromDate === toYMD((() => { const d = new Date(); d.setDate(d.getDate() - 7); return d })())
  const isPreset30  = fromDate === toYMD((() => { const d = new Date(); d.setDate(d.getDate() - 30); return d })())
  const isPreset90  = fromDate === toYMD((() => { const d = new Date(); d.setDate(d.getDate() - 90); return d })())
  const isThisYear  = fromDate === `${new Date().getFullYear()}-01-01`

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader title="Reports & Analytics" subtitle="Analyse ticket performance, customer trends, and financials">
        <button onClick={load} className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          Refresh
        </button>
      </PageHeader>

      {/* Date Range Bar */}
      <div className="flex items-center gap-3 flex-wrap bg-white rounded-xl border border-gray-200 px-4 py-3">
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} max={toDate} className={inputCls} />
        <span className="text-gray-400 text-sm">to</span>
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} min={fromDate} max={today} className={inputCls} />
        <div className="flex items-center gap-1.5 flex-wrap ml-2">
          <button onClick={() => applyPreset(7)}  className={presetCls(isPreset7 && toDate === today)}>Last 7 days</button>
          <button onClick={() => applyPreset(30)} className={presetCls(isPreset30 && toDate === today)}>Last 30 days</button>
          <button onClick={() => applyPreset(90)} className={presetCls(isPreset90 && toDate === today)}>Last 90 days</button>
          <button onClick={applyThisYear}         className={presetCls(isThisYear && toDate === today)}>This year</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <div className="flex gap-1 overflow-x-auto">
          {allTabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${activeTab === tab.id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {activeTab === 'tickets' && (
            <TicketsTab
              tickets={filteredTickets}
              onNavigateToTicket={onNavigateToTicket}
              formatDate={formatDate}
            />
          )}
          {activeTab === 'customers' && isAdminOrManager && (
            <CustomersTab
              customers={filteredCustomers}
              tickets={filteredTickets}
              formatDate={formatDate}
            />
          )}
          {activeTab === 'technicians' && isAdminOrManager && (
            <TechniciansTab
              tickets={filteredTickets}
              timeEntries={timeEntries}
              timeEntriesMissing={timeEntriesMissing}
              formatDate={formatDate}
            />
          )}
          {activeTab === 'financial' && isAdminOrManager && (
            <FinancialTab
              invoices={filteredInvoices}
              invoicesMissing={invoicesMissing}
              formatDate={formatDate}
            />
          )}
        </>
      )}
    </div>
  )
}
