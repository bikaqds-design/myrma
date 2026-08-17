import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { useURLTab } from '../hooks/useURLTab'
import { useQuery } from '@tanstack/react-query'
import * as XLSX from 'xlsx'
import { db } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../lib/sentry'
import { Spinner, PageHeader } from '../components/ui'
import { useAppearance } from '../contexts/AppearanceContext'
import { ROLES } from '../lib/constants'

// ─── CSV Utility ──────────────────────────────────────────────────────────────
function downloadCSV(rows, columns, filename, t) {
  if (!rows.length) {
    toast(t ? t('reports.noDataExport') : 'No data to export')
    return
  }
  const headers = columns.map((c) => c.label)
  const escape = (v) => {
    const s = String(v ?? '').replace(/"/g, '""')
    return s.includes(',') || s.includes('\n') || s.includes('"') ? `"${s}"` : s
  }
  const csv = [
    headers.join(','),
    ...rows.map((r) => columns.map((c) => escape(r[c.key] ?? '')).join(',')),
  ].join('\r\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  toast.success(t ? t('reports.exportedRows', { count: rows.length }) : `Exported ${rows.length} rows`)
}

// ─── Excel Utility ────────────────────────────────────────────────────────────
function downloadExcel(rows, columns, filename, t) {
  if (!rows.length) { toast(t ? t('reports.noDataExport') : 'No data to export'); return }
  const headers = columns.map((c) => c.label)
  const data = rows.map((r) => columns.map((c) => r[c.key] ?? ''))
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data])
  // Bold header row
  headers.forEach((_, i) => {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c: i })]
    if (cell) cell.s = { font: { bold: true } }
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Report')
  XLSX.writeFile(wb, filename)
  toast.success(t ? t('reports.exportedRowsExcel', { count: rows.length }) : `Exported ${rows.length} rows as Excel`)
}

// ─── Shared Export Buttons ────────────────────────────────────────────────────
function ExportButtons({ onCSV, onExcel }) {
  const btnCls = 'flex items-center gap-1.5 px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors'
  return (
    <div className="flex items-center gap-2">
      <button onClick={onCSV} className={btnCls}>
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        CSV
      </button>
      <button onClick={onExcel} className={btnCls}>
        <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        Excel
      </button>
    </div>
  )
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function startOfDay(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}
function endOfDay(date) {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
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
  // The value colours had no dark: variant, so the -700 shades stayed on the
  // dark card and measured 2.25–3.55:1 — the largest number on the card was the
  // least readable thing on it. The -300 shades clear 4.5:1 comfortably.
  const colors = {
    indigo: { bg: 'bg-indigo-50', icon: 'text-indigo-600', val: 'text-indigo-700 dark:text-indigo-300' },
    green: { bg: 'bg-green-50', icon: 'text-green-600', val: 'text-green-700 dark:text-green-300' },
    amber: { bg: 'bg-amber-50', icon: 'text-amber-600', val: 'text-amber-700 dark:text-amber-300' },
    red: { bg: 'bg-red-50', icon: 'text-red-600', val: 'text-red-700 dark:text-red-300' },
    blue: { bg: 'bg-blue-50', icon: 'text-blue-600', val: 'text-blue-700 dark:text-blue-300' },
    purple: { bg: 'bg-purple-50', icon: 'text-purple-600', val: 'text-purple-700 dark:text-purple-300' },
  }
  const c = colors[color] || colors.indigo
  return (
    <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] p-5 flex items-start gap-4">
      <div
        className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center flex-shrink-0`}
      >
        <svg className={`w-5 h-5 ${c.icon}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
        </svg>
      </div>
      <div className="min-w-0">
        <p className={`text-2xl font-bold ${c.val} leading-none`}>{value}</p>
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-1">{label}</p>
        {sub && <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

// ─── Migration Banner ─────────────────────────────────────────────────────────
function MigrationBanner({ table, children }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl">
      <svg
        className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <div className="text-sm text-amber-800">
        <span className="font-semibold">
          The <code className="font-mono bg-amber-100 px-1 rounded">{table}</code> table has not
          been set up.
        </span>{' '}
        {children || 'Run the required SQL migration in Supabase to enable this feature.'}
      </div>
    </div>
  )
}

// ─── Status Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    New: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
    'In Progress': 'bg-yellow-100 text-yellow-700',
    'On Hold': 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300',
    Completed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    Cancelled: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${map[status] || 'bg-gray-100 text-gray-600'}`}
    >
      {status || '—'}
    </span>
  )
}

function PriorityBadge({ priority }) {
  const map = {
    Critical: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
    High: 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300',
    Medium: 'bg-yellow-100 text-yellow-700',
    Low: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${map[priority] || 'bg-gray-100 text-gray-600'}`}
    >
      {priority || '—'}
    </span>
  )
}

// ─── Tickets Tab ──────────────────────────────────────────────────────────────
function TicketsTab({ tickets, onNavigateToTicket, formatDate }) {
  const { t } = useTranslation()
  const [filterStatus, setFilterStatus] = useState('')
  const [filterPriority, setFilterPriority] = useState('')
  const [filterTechnician, setFilterTechnician] = useState('')

  const statuses = useMemo(
    () => [...new Set(tickets.map((tk) => tk.ticket_status).filter(Boolean))].sort(),
    [tickets]
  )
  const priorities = useMemo(
    () => [...new Set(tickets.map((tk) => tk.priority).filter(Boolean))].sort(),
    [tickets]
  )
  const technicians = useMemo(
    () => [...new Set(tickets.map((tk) => tk.assigned_technician).filter(Boolean))].sort(),
    [tickets]
  )

  const filtered = useMemo(() => {
    let list = [...tickets]
    if (filterStatus) list = list.filter((tk) => tk.ticket_status === filterStatus)
    if (filterPriority) list = list.filter((tk) => tk.priority === filterPriority)
    if (filterTechnician) list = list.filter((tk) => tk.assigned_technician === filterTechnician)
    return list
  }, [tickets, filterStatus, filterPriority, filterTechnician])

  const total = filtered.length
  const completed = filtered.filter((tk) => tk.ticket_status === 'Completed')
  const overdue = filtered.filter(
    (tk) =>
      tk.due_date &&
      new Date(tk.due_date) < new Date() &&
      tk.ticket_status !== 'Completed' &&
      tk.ticket_status !== 'Cancelled'
  )
  const resolveTimes = completed
    .map((tk) => resolutionHours(tk))
    .filter((v) => v !== null)
    .map(Number)
  const avgResolve = resolveTimes.length
    ? (resolveTimes.reduce((s, v) => s + v, 0) / resolveTimes.length).toFixed(1)
    : '—'

  const completedWithDue = completed.filter((tk) => tk.due_date)
  const slaMet = completedWithDue.filter(
    (tk) => !tk.due_date || new Date(tk.updated_date) <= new Date(tk.due_date)
  )
  const slaPct = completedWithDue.length
    ? Math.round((slaMet.length / completedWithDue.length) * 100)
    : '—'

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
    const rows = filtered.map((tk) => ({
      rma_number: tk.rma_number || '',
      customer_name: tk.customer_name || '',
      ticket_status: tk.ticket_status || '',
      priority: tk.priority || '',
      assigned_technician: tk.assigned_technician || '',
      created_date: formatDate(tk.created_date),
      due_date: formatDate(tk.due_date),
      resolved_date: tk.ticket_status === 'Completed' ? formatDate(tk.updated_date) : '',
      resolution_hrs: resolutionHours(tk) ?? 'Open',
    }))
    downloadCSV(rows, columns, `tickets-report-${toYMD(new Date())}.csv`, t)
  }
  const handleExportExcel = () => {
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
    const rows = filtered.map((tk) => ({
      rma_number: tk.rma_number || '',
      customer_name: tk.customer_name || '',
      ticket_status: tk.ticket_status || '',
      priority: tk.priority || '',
      assigned_technician: tk.assigned_technician || '',
      created_date: formatDate(tk.created_date),
      due_date: formatDate(tk.due_date),
      resolved_date: tk.ticket_status === 'Completed' ? formatDate(tk.updated_date) : '',
      resolution_hrs: resolutionHours(tk) ?? 'Open',
    }))
    downloadExcel(rows, columns, `tickets-report-${toYMD(new Date())}.xlsx`, t)
  }

  const sel =
    'px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0]'

  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <KpiCard
          label={t('reports.kpiTotalTickets')}
          value={total}
          color="indigo"
          icon="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
        />
        <KpiCard
          label={t('reports.kpiAvgResolution')}
          value={avgResolve === '—' ? '—' : `${avgResolve}h`}
          color="blue"
          icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
        <KpiCard
          label={t('reports.kpiSlaCompliance')}
          value={slaPct === '—' ? '—' : `${slaPct}%`}
          color="green"
          icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
        <KpiCard
          label={t('reports.kpiOverdueRate')}
          value={total ? `${Math.round((overdue.length / total) * 100)}%` : '—'}
          color="red"
          icon="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          sub={t('reports.overdueCount', { count: overdue.length })}
        />
      </div>

      {/* Filters + Export */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className={sel}
        >
          <option value="">{t('reports.allStatuses')}</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          className={sel}
        >
          <option value="">{t('reports.allPriorities')}</option>
          {priorities.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={filterTechnician}
          onChange={(e) => setFilterTechnician(e.target.value)}
          className={sel}
        >
          <option value="">{t('reports.allTechnicians')}</option>
          {technicians.map((tech) => (
            <option key={tech} value={tech}>
              {tech}
            </option>
          ))}
        </select>
        <span className="text-sm text-gray-500 dark:text-[#9aa4b2]">
          {t('reports.ticketCount', { count: filtered.length })}
        </span>
        <div className="ml-auto">
          <ExportButtons onCSV={handleExport} onExcel={handleExportExcel} />
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('reports.noTicketsMatch')}</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  {[
                    t('reports.colRmaNum'),
                    t('reports.colCustomer'),
                    t('reports.colStatus'),
                    t('reports.colPriority'),
                    t('reports.colTechnician'),
                    t('reports.colCreated'),
                    t('reports.colDue'),
                    t('reports.colResolved'),
                    t('reports.colResolution'),
                  ].map((h, i) => (
                    <th
                      key={i}
                      className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e6e9ef] dark:divide-[#212a38]">
                {filtered.map((tk) => {
                  const hrs = resolutionHours(tk)
                  return (
                    <tr key={tk.id} className="hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => onNavigateToTicket?.(tk.id)}
                          className="font-mono text-indigo-600 hover:text-indigo-800 hover:underline text-xs font-medium"
                        >
                          {tk.rma_number || tk.id?.slice(0, 8)}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-[#e8ebf0] max-w-[160px] truncate">
                        {tk.customer_name || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={tk.ticket_status} />
                      </td>
                      <td className="px-4 py-3">
                        <PriorityBadge priority={tk.priority} />
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] text-xs max-w-[120px] truncate">
                        {tk.assigned_technician || '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] text-xs whitespace-nowrap">
                        {formatDate(tk.created_date)}
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">
                        {tk.due_date ? (
                          <span
                            className={
                              new Date(tk.due_date) < new Date() && tk.ticket_status !== 'Completed'
                                ? 'text-red-600 font-medium'
                                : 'text-gray-500'
                            }
                          >
                            {formatDate(tk.due_date)}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] text-xs whitespace-nowrap">
                        {tk.ticket_status === 'Completed' ? (
                          formatDate(tk.updated_date)
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {hrs !== null ? (
                          <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">
                            {hrs}h
                          </span>
                        ) : (
                          <span className="text-gray-500">{t('reports.openStatus')}</span>
                        )}
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
  const { t } = useTranslation()
  const customerStats = useMemo(() => {
    const map = {}
    for (const tk of tickets) {
      if (!tk.customer_id && !tk.customer_name) continue
      const key = tk.customer_id || tk.customer_name
      if (!map[key])
        map[key] = {
          total: 0,
          open: 0,
          lastActivity: null,
          customerId: tk.customer_id,
          customerName: tk.customer_name,
        }
      map[key].total++
      if (tk.ticket_status !== 'Completed' && tk.ticket_status !== 'Cancelled') map[key].open++
      if (!map[key].lastActivity || tk.created_date > map[key].lastActivity)
        map[key].lastActivity = tk.created_date
    }
    return map
  }, [tickets])

  const enriched = useMemo(
    () =>
      customers
        .map((c) => {
          const stats = customerStats[c.id] || { total: 0, open: 0, lastActivity: null }
          return {
            ...c,
            totalTickets: stats.total,
            openTickets: stats.open,
            lastActivity: stats.lastActivity,
          }
        })
        .sort((a, b) => b.totalTickets - a.totalTickets),
    [customers, customerStats]
  )

  const totalActive = customers.filter((c) => c.customer_status === 'Active').length
  const avgTickets = customers.length ? (tickets.length / customers.length).toFixed(1) : '—'
  const topReturning = enriched.filter((c) => c.totalTickets > 1).length

  const handleExport = () => {
    const columns = [
      { key: 'name', label: 'Customer Name' },
      { key: 'company', label: 'Company' },
      { key: 'total', label: 'Total Tickets' },
      { key: 'open', label: 'Open Tickets' },
      { key: 'last', label: 'Last Activity' },
    ]
    const rows = enriched.map((c) => ({
      name: c.contact_person || c.company_name || '',
      company: c.company_name || '',
      total: c.totalTickets,
      open: c.openTickets,
      last: formatDate(c.lastActivity),
    }))
    downloadCSV(rows, columns, `customers-report-${toYMD(new Date())}.csv`, t)
  }
  const handleExportExcel = () => {
    const columns = [
      { key: 'name', label: 'Customer Name' },
      { key: 'company', label: 'Company' },
      { key: 'total', label: 'Total Tickets' },
      { key: 'open', label: 'Open Tickets' },
      { key: 'last', label: 'Last Activity' },
    ]
    const rows = enriched.map((c) => ({
      name: c.contact_person || c.company_name || '',
      company: c.company_name || '',
      total: c.totalTickets,
      open: c.openTickets,
      last: formatDate(c.lastActivity),
    }))
    downloadExcel(rows, columns, `customers-report-${toYMD(new Date())}.xlsx`, t)
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <KpiCard
          label={t('reports.kpiActiveCustomers')}
          value={totalActive}
          color="indigo"
          icon="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
        />
        <KpiCard
          label={t('reports.kpiAvgTicketsPerCustomer')}
          value={avgTickets}
          color="blue"
          icon="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
        />
        <KpiCard
          label={t('reports.kpiReturningCustomers')}
          value={topReturning}
          color="green"
          icon="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </div>

      <div className="flex justify-end">
        <ExportButtons onCSV={handleExport} onExcel={handleExportExcel} />
      </div>

      {enriched.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('reports.noCustomerData')}</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  {[
                    t('reports.colCustomerName'),
                    t('reports.colCompany'),
                    t('reports.colTotalTickets'),
                    t('reports.colOpenTickets'),
                    t('reports.colLastActivity'),
                  ].map((h, i) => (
                    <th
                      key={i}
                      className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e6e9ef] dark:divide-[#212a38]">
                {enriched.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-[#e8ebf0]">
                      {c.contact_person || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2]">{c.company_name || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700">
                        {c.totalTickets}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {c.openTickets > 0 ? (
                        <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
                          {c.openTickets}
                        </span>
                      ) : (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] text-xs">
                      {c.lastActivity ? formatDate(c.lastActivity) : '—'}
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

// ─── Technicians Tab ──────────────────────────────────────────────────────────
function TechniciansTab({ tickets, timeEntries, timeEntriesMissing, formatDate: _formatDate }) {
  const { t } = useTranslation()
  const stats = useMemo(() => {
    const map = {}
    for (const tk of tickets) {
      const tech = tk.assigned_technician
      if (!tech) continue
      if (!map[tech])
        map[tech] = { email: tech, assigned: 0, completed: 0, resolveTimes: [], hoursLogged: 0 }
      map[tech].assigned++
      if (tk.ticket_status === 'Completed') {
        map[tech].completed++
        const hrs = resolutionHours(tk)
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
  const totalHours = timeEntriesMissing
    ? null
    : stats.reduce((s, ts) => s + ts.hoursLogged, 0).toFixed(1)

  const handleExport = () => {
    const columns = [
      { key: 'email', label: 'Technician' },
      { key: 'assigned', label: 'Assigned Tickets' },
      { key: 'completed', label: 'Completed Tickets' },
      { key: 'avgResolve', label: 'Avg Resolution (hrs)' },
      { key: 'hoursLogged', label: 'Hours Logged' },
    ]
    const rows = stats.map((ts) => ({
      email: ts.email,
      assigned: ts.assigned,
      completed: ts.completed,
      avgResolve: ts.resolveTimes.length
        ? (ts.resolveTimes.reduce((s, v) => s + v, 0) / ts.resolveTimes.length).toFixed(1)
        : '—',
      hoursLogged: timeEntriesMissing ? 'N/A' : ts.hoursLogged.toFixed(1),
    }))
    downloadCSV(rows, columns, `technicians-report-${toYMD(new Date())}.csv`, t)
  }
  const handleExportExcel = () => {
    const columns = [
      { key: 'email', label: 'Technician' },
      { key: 'assigned', label: 'Assigned Tickets' },
      { key: 'completed', label: 'Completed Tickets' },
      { key: 'avgResolve', label: 'Avg Resolution (hrs)' },
      { key: 'hoursLogged', label: 'Hours Logged' },
    ]
    const rows = stats.map((ts) => ({
      email: ts.email,
      assigned: ts.assigned,
      completed: ts.completed,
      avgResolve: ts.resolveTimes.length
        ? (ts.resolveTimes.reduce((s, v) => s + v, 0) / ts.resolveTimes.length).toFixed(1)
        : '—',
      hoursLogged: timeEntriesMissing ? 'N/A' : ts.hoursLogged.toFixed(1),
    }))
    downloadExcel(rows, columns, `technicians-report-${toYMD(new Date())}.xlsx`, t)
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <KpiCard
          label={t('reports.kpiActiveTechnicians')}
          value={activeTechs}
          color="purple"
          icon="M16 7a4 4 0 11-8 0 4 4 0 018 0M12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
        />
        <KpiCard
          label={t('reports.kpiAvgTicketsAssigned')}
          value={avgAssigned}
          color="blue"
          icon="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
        />
        <KpiCard
          label={t('reports.kpiTotalHoursLogged')}
          value={totalHours !== null ? `${totalHours}h` : t('reports.naValue')}
          color="green"
          icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          sub={timeEntriesMissing ? t('reports.timeEntriesNotSetup') : undefined}
        />
      </div>

      {timeEntriesMissing && (
        <MigrationBanner table="time_entries">
          {t('reports.timeTrackingUnavailable')}
        </MigrationBanner>
      )}

      <div className="flex justify-end">
        <ExportButtons onCSV={handleExport} onExcel={handleExportExcel} />
      </div>

      {stats.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('reports.noAssignedTickets')}</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  {[
                    t('reports.colTechnician'),
                    t('reports.colAssigned'),
                    t('reports.colCompleted'),
                    t('reports.colAvgResolutionHrs'),
                    t('reports.colHoursLogged'),
                  ].map((h, i) => (
                    <th
                      key={i}
                      className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e6e9ef] dark:divide-[#212a38]">
                {stats.map((ts) => {
                  const avgRes = ts.resolveTimes.length
                    ? (ts.resolveTimes.reduce((s, v) => s + v, 0) / ts.resolveTimes.length).toFixed(1)
                    : null
                  return (
                    <tr key={ts.email} className="hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-[#e8ebf0] text-xs">{ts.email}</td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700">
                          {ts.assigned}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400">
                          {ts.completed}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {avgRes !== null ? (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400">
                            {avgRes}h
                          </span>
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] text-xs">
                        {timeEntriesMissing ? t('reports.naValue') : `${ts.hoursLogged.toFixed(1)}h`}
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
/**
 * Financial reporting over the CRM tables.
 *
 * This used to read the pre-CRM `invoices` table, which has 0 rows — the Sprint
 * 6/7 funnel work moved invoicing to `crm_invoices` and Reports was never
 * repointed. Every tile showed $0.00 and the table said "no invoices in range",
 * which reads as an empty business rather than a broken query.
 *
 * The two schemas do not line up, so this is a rewire rather than a rename:
 * `total` not `total_amount`, and status splits into `doc_status` (draft /
 * posted / cancelled) and `payment_status` (unpaid / partial / paid / reversed).
 * Quotes come from their own table now; the old "Quotes Value" filtered
 * `invoices` for `type === 'quote'`, a column that exists on neither schema and
 * so could never have returned anything.
 */
function FinancialTab({ invoices, quotations, customers, formatDate }) {
  const { t } = useTranslation()

  const DOC_STATUS_CLS = {
    posted:    'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    draft:     'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
    cancelled: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  }
  const PAY_STATUS_CLS = {
    paid:     'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    partial:  'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
    unpaid:   'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
    reversed: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
  }

  const customerName = (id) => {
    const c = customers.find((x) => x.id === id)
    return c ? c.company_name || c.contact_person || '—' : '—'
  }

  // Cancelled invoices are excluded from every money total — counting them
  // would overstate revenue — but they stay in the table below, because "three
  // were voided" is itself worth seeing.
  const live = invoices.filter((i) => i.doc_status !== 'cancelled')
  const num = (v) => Number(v) || 0

  const totalInvoiced = live.reduce((s, i) => s + num(i.total), 0)
  const totalPaid = live.reduce((s, i) => s + num(i.amount_paid), 0)
  // "Outstanding", not the old "Pending / Overdue": the CRM has no overdue
  // status. Overdue is a due date in the past on an unpaid invoice, which is a
  // different question and is shown per-row instead of folded into a tile.
  const outstanding = live.reduce((s, i) => s + Math.max(num(i.total) - num(i.amount_paid), 0), 0)
  const quotesVal = quotations
    .filter((q) => !['cancelled', 'declined', 'expired'].includes(q.status))
    .reduce((s, q) => s + num(q.total), 0)

  const fmt$ = (v) =>
    `$${Number(v)
      .toFixed(2)
      .replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`

  const handleExport = () => {
    const columns = [
      { key: 'invoice_number', label: 'Invoice #' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'doc_status', label: 'Document' },
      { key: 'payment_status', label: 'Payment' },
      { key: 'amount', label: 'Total' },
      { key: 'paid', label: 'Paid' },
      { key: 'due_date', label: 'Due Date' },
    ]
    const rows = invoices.map((i) => ({
      invoice_number: i.inv_code || '',
      customer_name: customerName(i.customer_id),
      doc_status: i.doc_status || '',
      payment_status: i.payment_status || '',
      amount: Number(i.total) || 0,
      paid: Number(i.amount_paid) || 0,
      due_date: formatDate(i.due_date),
    }))
    downloadCSV(rows, columns, `financial-report-${toYMD(new Date())}.csv`, t)
  }
  const handleExportExcel = () => {
    const columns = [
      { key: 'invoice_number', label: 'Invoice #' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'doc_status', label: 'Document' },
      { key: 'payment_status', label: 'Payment' },
      { key: 'amount', label: 'Total' },
      { key: 'paid', label: 'Paid' },
      { key: 'due_date', label: 'Due Date' },
    ]
    const rows = invoices.map((i) => ({
      invoice_number: i.inv_code || '',
      customer_name: customerName(i.customer_id),
      doc_status: i.doc_status || '',
      payment_status: i.payment_status || '',
      amount: Number(i.total) || 0,
      paid: Number(i.amount_paid) || 0,
      due_date: formatDate(i.due_date),
    }))
    downloadExcel(rows, columns, `financial-report-${toYMD(new Date())}.xlsx`, t)
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <KpiCard
          label={t('reports.kpiTotalInvoiced')}
          value={fmt$(totalInvoiced)}
          color="indigo"
          icon="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
        />
        <KpiCard
          label={t('reports.kpiTotalPaid')}
          value={fmt$(totalPaid)}
          color="green"
          icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
        <KpiCard
          label={t('reports.kpiOutstanding')}
          value={fmt$(outstanding)}
          color="amber"
          icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
        <KpiCard
          label={t('reports.kpiQuotesValue')}
          value={fmt$(quotesVal)}
          color="blue"
          icon="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </div>

      <div className="flex justify-end">
        <ExportButtons onCSV={handleExport} onExcel={handleExportExcel} />
      </div>

      {invoices.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('reports.noInvoicesInRange')}</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  {[
                    t('invoices.colInvoiceNum'),
                    t('reports.colCustomer'),
                    t('reports.colDocStatus'),
                    t('reports.colPaymentStatus'),
                    t('reports.colTotal'),
                    t('reports.colPaid'),
                    t('reports.colDueDate'),
                  ].map((h, i) => (
                    <th
                      key={i}
                      className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e6e9ef] dark:divide-[#212a38]">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors">
                    <td className="px-4 py-3 font-mono text-xs font-medium text-gray-900 dark:text-[#e8ebf0]">
                      {inv.inv_code || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-[#e8ebf0] max-w-[150px] truncate">
                      {customerName(inv.customer_id)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${DOC_STATUS_CLS[inv.doc_status] || 'bg-gray-100 text-gray-600'}`}
                      >
                        {inv.doc_status || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PAY_STATUS_CLS[inv.payment_status] || 'bg-gray-100 text-gray-600'}`}
                      >
                        {inv.payment_status || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold text-gray-900 dark:text-[#e8ebf0] tabular-nums">
                      {fmt$(inv.total)}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-[#e8ebf0] tabular-nums">
                      {fmt$(inv.amount_paid)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] text-xs whitespace-nowrap">
                      {inv.due_date ? (
                        <span
                          className={
                            new Date(inv.due_date) < new Date() && inv.payment_status !== 'paid'
                              ? 'text-red-600 font-medium'
                              : ''
                          }
                        >
                          {formatDate(inv.due_date)}
                        </span>
                      ) : (
                        '—'
                      )}
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
export default function Reports({
  currentUserRole,
  currentUserEmail: _currentUserEmail,
  currentUserPermissions,
  onNavigateToTicket,
}) {
  const { formatDate: _formatDate2, formatDateTime: _formatDateTime } = useAppearance()
  const { t } = useTranslation()

  const _canDo = (action) => {
    if (currentUserRole === ROLES.SUPER_ADMIN || currentUserRole === ROLES.ADMIN) return true
    return currentUserPermissions?.reports?.[action] === true
  }

  const isAdminOrManager =
    currentUserRole === ROLES.SUPER_ADMIN ||
    currentUserRole === ROLES.ADMIN ||
    currentUserRole === ROLES.MANAGER
  const _isViewer = currentUserRole === ROLES.VIEWER
  const _isTechnician = currentUserRole === ROLES.TECHNICIAN

  // Date range state
  const today = toYMD(new Date())
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return toYMD(d)
  })
  const [toDate, setToDate] = useState(today)

  // Tab state — viewers/technicians can only see Tickets
  const allTabs = [
    { id: 'tickets', label: t('reports.tabTickets') },
    ...(isAdminOrManager
      ? [
          { id: 'customers', label: t('reports.tabCustomers') },
          { id: 'technicians', label: t('reports.tabTechnicians') },
          { id: 'financial', label: t('reports.tabFinancial') },
        ]
      : []),
  ]
  const [activeTab, setActiveTab] = useURLTab('tab', 'tickets')

  const { data: reportData, isLoading: loading, isError, error, refetch } = useQuery({
    queryKey: ['reports', isAdminOrManager],
    queryFn: async () => {
      // crmInvoices + quotations, not db.invoices. The legacy `invoices` table
      // this used to read holds 0 rows — every invoice the business has raised
      // is in `crm_invoices`, and quotations are their own table. The old query
      // succeeded and returned nothing, so the Financial tab reported $0.00
      // across the board instead of erroring.
      const [tkRes, custRes, teRes, invRes, qtRes] = await Promise.all([
        db.rmaTickets.list(),
        db.customers.list(),
        isAdminOrManager ? db.timeEntries.listAll() : { missing: false, data: [] },
        isAdminOrManager ? db.crmInvoices.list() : [],
        isAdminOrManager ? db.quotations.list() : [],
      ])
      return { tkRes, custRes, teRes, invRes, qtRes }
    },
  })


  useEffect(() => {
    if (isError) {
      captureException(error, { page: 'Reports', context: 'loadData' })
      toast.error(i18next.t('reports.errorLoad'))
    }
  }, [isError, error])

  const tickets = useMemo(() => reportData?.tkRes || [], [reportData])
  const customers = useMemo(() => reportData?.custRes || [], [reportData])
  const timeEntriesMissing = reportData?.teRes?.missing ?? false
  const timeEntries = useMemo(() => reportData?.teRes?.data ?? [], [reportData])
  const invoices = useMemo(() => reportData?.invRes ?? [], [reportData])
  const quotations = useMemo(() => reportData?.qtRes ?? [], [reportData])

  // Apply date range filter
  const filteredTickets = useMemo(
    () => tickets.filter((tk) => inRange(tk.created_date, fromDate, toDate)),
    [tickets, fromDate, toDate]
  )
  const filteredCustomers = useMemo(
    () => customers.filter((c) => inRange(c.created_date, fromDate, toDate)),
    [customers, fromDate, toDate]
  )
  // `created_at`, not `created_date`. The CRM tables use the former; the legacy
  // `invoices` table used the latter. Filtering on the wrong key would have left
  // this tab empty even after repointing it at the right table — the same
  // silent-empty failure, one layer down.
  const filteredInvoices = useMemo(
    () => invoices.filter((i) => inRange(i.created_at, fromDate, toDate)),
    [invoices, fromDate, toDate]
  )
  const filteredQuotations = useMemo(
    () => quotations.filter((q) => inRange(q.created_at, fromDate, toDate)),
    [quotations, fromDate, toDate]
  )

  // Display formatter passed to the tab sub-components (was referenced but never defined).
  const formatDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')

  // Preset date ranges
  const applyPreset = (days) => {
    const d = new Date()
    d.setDate(d.getDate() - days)
    setFromDate(toYMD(d))
    setToDate(today)
  }
  const applyThisYear = () => {
    setFromDate(`${new Date().getFullYear()}-01-01`)
    setToDate(today)
  }

  const inputCls =
    'px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0]'
  const presetCls = (active) =>
    `px-3 py-1.5 text-xs rounded-lg border transition-colors ${active ? 'bg-indigo-600 text-white border-indigo-600' : 'border-[#e6e9ef] dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230]'}`

  const isPreset7 =
    fromDate ===
    toYMD(
      (() => {
        const d = new Date()
        d.setDate(d.getDate() - 7)
        return d
      })()
    )
  const isPreset30 =
    fromDate ===
    toYMD(
      (() => {
        const d = new Date()
        d.setDate(d.getDate() - 30)
        return d
      })()
    )
  const isPreset90 =
    fromDate ===
    toYMD(
      (() => {
        const d = new Date()
        d.setDate(d.getDate() - 90)
        return d
      })()
    )
  const isThisYear = fromDate === `${new Date().getFullYear()}-01-01`

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title={t('reports.title')}
        subtitle={t('reports.subtitle')}
      >
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1.5 px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          {t('common.refresh')}
        </button>
      </PageHeader>


      {/* Date Range Bar */}
      <div className="flex items-center gap-3 flex-wrap bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] px-4 py-3">
        <svg
          className="w-4 h-4 text-gray-500 dark:text-[#9aa4b2] flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <input
          type="date"
          aria-label={t('reports.dateFrom')}
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          max={toDate}
          className={inputCls}
        />
        <span className="text-gray-500 dark:text-[#9aa4b2] text-sm">{t('reports.to')}</span>
        <input
          type="date"
          aria-label={t('reports.dateTo')}
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          min={fromDate}
          max={today}
          className={inputCls}
        />
        <div className="flex items-center gap-1.5 flex-wrap ml-2">
          <button
            onClick={() => applyPreset(7)}
            className={presetCls(isPreset7 && toDate === today)}
          >
            {t('reports.last7Days')}
          </button>
          <button
            onClick={() => applyPreset(30)}
            className={presetCls(isPreset30 && toDate === today)}
          >
            {t('reports.last30Days')}
          </button>
          <button
            onClick={() => applyPreset(90)}
            className={presetCls(isPreset90 && toDate === today)}
          >
            {t('reports.last90Days')}
          </button>
          <button onClick={applyThisYear} className={presetCls(isThisYear && toDate === today)}>
            {t('reports.thisYear')}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-[#e6e9ef] dark:border-[#212a38]">
        <div className="flex gap-1 overflow-x-auto">
          {allTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${activeTab === tab.id ? 'border-indigo-600 text-indigo-600 dark:text-[#a5b4fc]' : 'border-transparent text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:hover:text-[#e8ebf0]'}`}
            >
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
              quotations={filteredQuotations}
              customers={customers}
              formatDate={formatDate}
            />
          )}
        </>
      )}
    </div>
  )
}
