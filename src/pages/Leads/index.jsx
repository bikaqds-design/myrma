import React, { useState, useMemo, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueries, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ownershipScope } from '../../lib/permissions'
import toast from 'react-hot-toast'
import { toUserMessage } from '../../lib/errorMessage'
import { db, supabase } from '../../api/supabaseClient'
import { PageSkeleton } from '../../components/Skeleton'
import { PageHeader, Ltr } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import ExportMenu from '../../components/ExportMenu'
import ConfirmDialog from '../../components/ConfirmDialog'
import { leadSchema, getFirstError } from '../../lib/schemas'
import { LEAD_STATUS_LIST, LEAD_SOURCE_LIST } from '../../lib/constants'
import { captureException } from '../../lib/sentry'
import { safeStorage } from '../../lib/safeStorage'
import { useUrlState, useResetOnFilterChange } from '../../lib/useUrlState'
import { EMPTY_FORM, EMPTY_CONVERT_FORM } from './_constants'
import { CreateLeadModal, ConvertLeadModal, BulkUploadLeadsModal } from './_modals'
import { SortableHeader } from './_shared'
import * as XLSX from 'xlsx'
import { useURLTab } from '../../hooks/useURLTab'
import LeadsKanbanView from './LeadsKanbanView'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { contactFieldProblems } from '../../lib/importValidation'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import { SearchInput } from '../../components/SearchInput'

/** Cards each Kanban column shows before "Show more". */
const KANBAN_PAGE = 50

const STATUS_BADGE = {
  new:          'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  contacted:    'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  qualified:    'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300',
  nurturing:    'bg-teal-100 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400',
  inactive:     'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300',
  converted:    'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  disqualified: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
}

const SOURCE_BADGE = {
  'walk-in':   'bg-cyan-100 dark:bg-cyan-900/20 text-cyan-700 dark:text-cyan-400',
  phone:       'bg-rose-100 dark:bg-rose-900/20 text-rose-700 dark:text-rose-400',
  referral:    'bg-fuchsia-100 dark:bg-fuchsia-900/20 text-fuchsia-700 dark:text-fuchsia-400',
  exhibition:  'bg-lime-100 dark:bg-lime-900/20 text-lime-700 dark:text-lime-400',
  website:     'bg-sky-100 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400',
  whatsapp:    'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400',
}

function KanbanIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <rect x="1" y="1" width="4" height="14" rx="1" />
      <rect x="6" y="1" width="4" height="10" rx="1" />
      <rect x="11" y="1" width="4" height="12" rx="1" />
    </svg>
  )
}
function ListIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M2 4h12v1.5H2V4zm0 3.5h12V9H2V7.5zm0 3.5h12v1.5H2V11z" />
    </svg>
  )
}
const LEADS_VIEWS = [
  { key: 'list', Icon: ListIcon },
  { key: 'kanban', Icon: KanbanIcon },
]

function exportLeadsXlsx(leads, t, label = 'leads') {
  if (!leads.length) {
    toast(t('leads.exportEmpty'))
    return
  }
  const headers = [
    t('leadModal.fullName'),
    t('leadModal.companyName'),
    t('leadModal.phone'),
    t('common.email'),
    t('leads.colSource'),
    t('common.status'),
    t('leads.colAssignedRep'),
    t('common.createdAt'),
    t('leads.createdBy'),
    t('common.notes'),
  ]
  const rows = leads.map((l) => [
    l.full_name || '',
    l.company_name || '',
    l.phone || '',
    l.email || '',
    l.source || '',
    l.status || '',
    l.assigned_rep || '',
    l.created_at ? new Date(l.created_at).toLocaleDateString() : '',
    l.created_by || '',
    l.notes || '',
  ])
  const aoa = [headers, ...rows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  headers.forEach((_, ci) => {
    const addr = XLSX.utils.encode_cell({ r: 0, c: ci })
    if (ws[addr]) ws[addr].s = { font: { bold: true } }
  })
  ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}1` }
  ws['!cols'] = [
    { wch: 28 }, { wch: 28 }, { wch: 16 }, { wch: 28 },
    { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 14 },
    { wch: 28 }, { wch: 40 },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Leads')
  XLSX.writeFile(wb, `${label}-${new Date().toISOString().slice(0, 10)}.xlsx`)
  toast.success(t('leads.exportSuccess', { count: rows.length }))
}

function parseCSVLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  result.push(current.trim())
  return result
}

// ─── Multi-select filter dropdown ────────────────────────────────────────────
function MultiCheckFilter({ label, selected, onChange, options }) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef(null)

  React.useEffect(() => {
    const handler = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const toggle = (value) => {
    const next = new Set(selected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange(next)
  }

  const active = selected.size > 0

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 px-3 py-2 border rounded-lg text-sm transition-colors ${
          active
            ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20 dark:border-indigo-400 text-indigo-700 dark:text-indigo-300'
            : 'border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#121823] text-[#6c6760] dark:text-[#9aa4b2]'
        }`}
      >
        <span>{active ? `${label.replace(/^All /, '')} (${selected.size})` : label}</span>
        <svg className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 min-w-[170px] bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-xl shadow-lg py-1.5">
          {options.map(({ value, label: optLabel }) => (
            <label
              key={value}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] cursor-pointer text-sm text-[#211f1b] dark:text-[#e8ebf0]"
            >
              <input
                type="checkbox"
                checked={selected.has(value)}
                onChange={() => toggle(value)}
                className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500"
              />
              {optLabel}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Leads({ currentUserRole, currentUserEmail, currentUserPermissions , scopeEmail}) {
  const { t } = useTranslation()
  const ownScope = ownershipScope(currentUserRole, currentUserPermissions, 'leads', scopeEmail ?? currentUserEmail)
  const navigate = useNavigate()
  const searchRef = useRef(null)
  const queryClient = useQueryClient()

  const { data: pipelines = EMPTY_ARRAY } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => db.pipelines.list(),
    staleTime: 5 * 60_000,
  })
  const { data: usersList = EMPTY_ARRAY } = useQuery({
    queryKey: ['users'],
    queryFn: () => db.userRoles.directory(),
    staleTime: 5 * 60_000,
  })
  const salesReps = usersList.filter((u) =>
    u.role === 'sales_rep' || u.role === 'manager' || u.role === 'admin' || u.role === 'super_admin'
  )

  const [sortConfig, setSortConfig] = useState(() =>
    safeStorage.get('leadsSortConfig', { key: 'created_at', direction: 'desc' })
  )
  // Filters live in the URL (UX-SEARCH-001). The multi-select Sets below are
  // not URL-backed yet; they need list encoding.
  const [searchQuery, setSearchQuery] = useUrlState('q', '')
  const [filterStatuses, setFilterStatuses] = useState(new Set())
  const [filterSources, setFilterSources] = useState(new Set())
  const [filterReps, setFilterReps] = useState(new Set())
  const [showFilters, setShowFilters] = useState(false)
  const [openMenuId, setOpenMenuId] = useState(null)
  const [menuAnchor, setMenuAnchor] = useState(null)
  const [statusMenu, setStatusMenu] = useState({ id: null, anchor: null })
  const [sourceMenu, setSourceMenu] = useState({ id: null, anchor: null })
  const [showAddLead, setShowAddLead] = useState(false)
  const [showBulkUpload, setShowBulkUpload] = useState(false)
  const [showAddLeadDropdown, setShowAddLeadDropdown] = useState(false)
  const [editingLead, setEditingLead] = useState(null)
  const [leadForm, setLeadForm] = useState(EMPTY_FORM)
  const [convertingLead, setConvertingLead] = useState(null)
  const [convertForm, setConvertForm] = useState(EMPTY_CONVERT_FORM)
  const [confirmDialog, setConfirmDialog] = useState({ open: false, title: '', message: '', onConfirm: null })
  const [activeView, setActiveView] = useURLTab('view', 'list')
  const [statusTab, setStatusTab] = useURLTab('status', 'active')

  // Kanban is a status board, so it only makes sense on the 'all' tab — every
  // other tab is a single-status slice. Derived rather than forced into state so
  // a deep link like ?status=converted&view=kanban degrades to list instead of
  // rendering an empty board, and the chosen view is remembered on return to 'all'.
  const kanbanAllowed = statusTab === 'all'
  const effectiveView = kanbanAllowed ? activeView : 'list'
  const [selectedLeads, setSelectedLeads] = useState(new Set())
  const [pendingLeadCode, setPendingLeadCode] = useState('')

  // Pagination
  const [currentPage, setCurrentPage] = useUrlState('page', 1)
  const [itemsPerPage, setItemsPerPage] = useState(() => safeStorage.get('leadsPerPage', 25))
  const [jumpToPage, setJumpToPage] = useState('')

  // The leads on screen, read from the database a page — or a Kanban column —
  // at a time, with the search, filters, tab and sort applied there. This page
  // used to load every lead and do all of that in the browser, which the Data
  // API caps at 1 000 rows. (BUG-066.) A rep sees only leads assigned to them;
  // RLS enforces it, and the owner filter keeps the counts consistent with it.
  const debouncedSearch = useDebouncedValue(searchQuery)
  const listFilters = useMemo(
    () => ({
      tab: statusTab,
      statuses: [...filterStatuses],
      sources: [...filterSources],
      reps: [...filterReps],
      search: debouncedSearch,
      ownerEmail: ownScope || null,
    }),
    [statusTab, filterStatuses, filterSources, filterReps, debouncedSearch, ownScope]
  )
  const { data: tabCounts, isLoading: countsLoading } = useQuery({
    queryKey: ['leads', 'tab-counts', ownScope || null],
    queryFn: () => db.leads.tabCounts(ownScope || null),
  })
  const { data: pageResult, isLoading: pageLoading } = useQuery({
    queryKey: ['leads', 'page', listFilters, sortConfig, currentPage, itemsPerPage],
    queryFn: () => db.leads.listPage(listFilters, sortConfig, currentPage, itemsPerPage),
    placeholderData: keepPreviousData,
    enabled: effectiveView === 'list',
  })
  const paginatedLeads = pageResult?.data ?? EMPTY_ARRAY
  const matchingCount = pageResult?.count ?? 0
  const loading = countsLoading || (effectiveView === 'list' && pageLoading)

  const [columnLimits, setColumnLimits] = useState({})
  const kanbanQueries = useQueries({
    queries: LEAD_STATUS_LIST.map((status) => {
      const limit = columnLimits[status] ?? KANBAN_PAGE
      return {
        queryKey: ['leads', 'kanban', status, listFilters, sortConfig, limit],
        queryFn: () => db.leads.listColumn(status, LEAD_STATUS_LIST, listFilters, sortConfig, limit),
        placeholderData: keepPreviousData,
        enabled: effectiveView === 'kanban',
      }
    }),
  })
  const kanbanColumns = LEAD_STATUS_LIST.map((status, i) => ({
    status,
    leads: kanbanQueries[i]?.data?.data ?? EMPTY_ARRAY,
    count: kanbanQueries[i]?.data?.count ?? 0,
  }))
  useEffect(() => setColumnLimits({}), [listFilters, sortConfig])
  // The rows a menu or a card action can refer to: what is on screen.
  const visibleLeads = effectiveView === 'kanban' ? kanbanColumns.flatMap((c) => c.leads) : paginatedLeads
  // A selection belongs to the page it was made on (bulk actions act on what is shown).
  useEffect(() => setSelectedLeads(new Set()), [currentPage, itemsPerPage, listFilters, sortConfig])

  const openConfirm = (title, message, onConfirm) => setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog((d) => ({ ...d, open: false }))

  useEffect(() => {
    safeStorage.set('leadsSortConfig', sortConfig)
  }, [sortConfig])
  useEffect(() => {
    safeStorage.set('leadsPerPage', itemsPerPage)
  }, [itemsPerPage])
  // Reset to page one only when a filter really changes, never on mount —
  // otherwise a shared link like ?q=acme&page=3 lands on page 1.
  useResetOnFilterChange([searchQuery, itemsPerPage, filterStatuses, filterSources, filterReps, statusTab], () => setCurrentPage(1))

  const canDo = (action) => {
    if (currentUserRole === 'super_admin' || currentUserRole === 'admin') return true
    return currentUserPermissions?.leads?.[action] === true
  }

  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.action-menu')) setOpenMenuId(null)
      if (!e.target.closest('.status-menu')) setStatusMenu({ id: null, anchor: null })
      if (!e.target.closest('.source-menu')) setSourceMenu({ id: null, anchor: null })
      if (!e.target.closest('.add-lead-dropdown')) setShowAddLeadDropdown(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // The table wrapper scrolls horizontally (overflow-x-auto), which per the CSS
  // overflow spec also forces overflow-y to auto — an absolutely-positioned menu
  // inside it gets clipped/scrollable instead of floating over the page. Close
  // the menu on scroll/resize instead of trying to keep a portal-rendered menu
  // repositioned through it.
  useEffect(() => {
    if (openMenuId === null && statusMenu.id === null && sourceMenu.id === null) return
    const close = () => {
      setOpenMenuId(null)
      setStatusMenu({ id: null, anchor: null })
      setSourceMenu({ id: null, anchor: null })
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [openMenuId, statusMenu.id, sourceMenu.id])

  const MENU_WIDTH = 176
  const handleToggleMenu = (e, leadId) => {
    e.stopPropagation()
    if (openMenuId === leadId) {
      setOpenMenuId(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const estimatedHeight = 168
    let top = rect.bottom + 4
    if (top + estimatedHeight > window.innerHeight - 8) top = rect.top - estimatedHeight - 4
    let left = rect.right - MENU_WIDTH
    if (left < 8) left = 8
    setMenuAnchor({ top, left })
    setOpenMenuId(leadId)
  }

  // Inline status pill — manual status changes (not 'converted', which only the
  // Convert flow may set). Converted leads are locked (immutable rule).
  const STATUS_MENU_WIDTH = 160
  const inlineStatusList = LEAD_STATUS_LIST.filter((s) => s !== 'converted')
  const canEditStatus = (lead) => canDo('edit') && lead.status !== 'converted'

  const handleToggleStatusMenu = (e, leadId) => {
    e.stopPropagation()
    if (statusMenu.id === leadId) {
      setStatusMenu({ id: null, anchor: null })
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const estimatedHeight = 8 + inlineStatusList.length * 30
    let top = rect.bottom + 4
    if (top + estimatedHeight > window.innerHeight - 8) top = rect.top - estimatedHeight - 4
    let left = rect.left
    if (left + STATUS_MENU_WIDTH > window.innerWidth - 8) left = window.innerWidth - STATUS_MENU_WIDTH - 8
    setStatusMenu({ id: leadId, anchor: { top, left } })
  }

  const handleInlineStatus = async (lead, newStatus) => {
    setStatusMenu({ id: null, anchor: null })
    if (lead.status === newStatus) return
    try {
      await db.leads.updateStatus(lead.id, newStatus, currentUserEmail)
      toast.success(t('leads.statusUpdated'))
      db.auditLog.log(currentUserEmail, 'lead_status_changed', `Lead ${lead.full_name}: ${lead.status} → ${newStatus}`).catch(() => {})
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  // Inline source pill — same gate as status: blocked once a lead is converted
  // (db.leads.update() rejects any field but notes once converted_at is set).
  const SOURCE_MENU_WIDTH = 160

  const handleToggleSourceMenu = (e, leadId) => {
    e.stopPropagation()
    if (sourceMenu.id === leadId) {
      setSourceMenu({ id: null, anchor: null })
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const estimatedHeight = 8 + LEAD_SOURCE_LIST.length * 30
    let top = rect.bottom + 4
    if (top + estimatedHeight > window.innerHeight - 8) top = rect.top - estimatedHeight - 4
    let left = rect.left
    if (left + SOURCE_MENU_WIDTH > window.innerWidth - 8) left = window.innerWidth - SOURCE_MENU_WIDTH - 8
    setSourceMenu({ id: leadId, anchor: { top, left } })
  }

  const handleInlineSource = async (lead, newSource) => {
    setSourceMenu({ id: null, anchor: null })
    if (lead.source === newSource) return
    try {
      await db.leads.update(lead.id, { source: newSource })
      toast.success(t('leads.sourceUpdated'))
      db.auditLog.log(currentUserEmail, 'lead_source_changed', `Lead ${lead.full_name}: ${lead.source} → ${newSource}`).catch(() => {})
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  // Real-time: invalidate query cache when leads table changes
  useEffect(() => {
    const channel = supabase
      .channel('leads_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => {
        queryClient.invalidateQueries({ queryKey: ['leads'] })
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])

  const statusMenuLead = visibleLeads.find((l) => l.id === statusMenu.id)
  const sourceMenuLead = visibleLeads.find((l) => l.id === sourceMenu.id)

  const handleSort = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  const totalPages = Math.ceil(matchingCount / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = Math.min(startIndex + itemsPerPage, matchingCount)
  // The last page can empty under the user (a delete, a narrower filter): step back.
  useEffect(() => {
    if (pageResult && totalPages >= 1 && currentPage > totalPages) setCurrentPage(totalPages)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageResult, totalPages, currentPage])

  const loadExportRows = (scope) =>
    scope === 'selected'
      ? db.leads.getMany([...selectedLeads])
      : db.leads.listAllMatching(scope === 'filtered' ? listFilters : { ownerEmail: ownScope || null }, sortConfig)

  const handlePageChange = (page) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  const handleJumpToPage = () => {
    const pageNum = parseInt(jumpToPage)
    if (pageNum >= 1 && pageNum <= totalPages) {
      handlePageChange(pageNum)
      setJumpToPage('')
    } else {
      toast.error(t('leads.pageMustBeBetween', { total: totalPages }))
    }
  }

  const renderLeadsPageNumbers = () => {
    const pages = []
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i)
    } else if (currentPage <= 4) {
      for (let i = 1; i <= 5; i++) pages.push(i)
      pages.push('...')
      pages.push(totalPages)
    } else if (currentPage >= totalPages - 3) {
      pages.push(1)
      pages.push('...')
      for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i)
    } else {
      pages.push(1)
      pages.push('...')
      for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i)
      pages.push('...')
      pages.push(totalPages)
    }
    return pages.map((p, i) =>
      p === '...' ? (
        <span key={`e${i}`} className="px-2 text-[#6c6760] dark:text-[#9aa4b2]">…</span>
      ) : (
        <button
          key={p}
          onClick={() => handlePageChange(p)}
          className={`w-8 h-8 rounded text-sm ${currentPage === p ? 'bg-[#4338ca] text-white' : 'text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230]'}`}
        >
          {p}
        </button>
      )
    )
  }

  const generateLeadCode = () => `LD-${Math.floor(10000000 + Math.random() * 90000000)}`

  const resetForm = () => {
    setLeadForm(EMPTY_FORM)
    setEditingLead(null)
    setPendingLeadCode(generateLeadCode())
  }

  const handleSaveLead = async () => {
    const validation = leadSchema.safeParse(leadForm)
    if (!validation.success) {
      toast.error(getFirstError(validation))
      return
    }
    const payload = {
      full_name: leadForm.full_name,
      company_name: leadForm.company_name || null,
      phone: leadForm.phone || null,
      email: leadForm.email || null,
      source: leadForm.source,
      status: leadForm.status,
      assigned_rep: leadForm.assigned_rep || null,
      notes: leadForm.notes || null,
    }
    try {
      if (editingLead) {
        const statusChanged = editingLead.status !== payload.status
        await db.leads.update(editingLead.id, payload)
        if (statusChanged) {
          db.activities
            .logSystem('lead', editingLead.id, `status_changed|${editingLead.status}|${payload.status}`, currentUserEmail)
            .catch(() => {})
        }
        toast.success(t('leads.leadUpdated'))
        db.auditLog.log(currentUserEmail, 'lead_updated', `Updated lead ${payload.full_name}`).catch(() => {})
      } else {
        await db.leads.create({ ...payload, lead_code: pendingLeadCode, created_by: currentUserEmail })
        toast.success(t('leads.leadCreated'))
        db.auditLog.log(currentUserEmail, 'lead_created', `Created lead ${payload.full_name}`).catch(() => {})
      }
      setShowAddLead(false)
      resetForm()
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  const handleEditLead = (lead) => {
    setEditingLead(lead)
    setLeadForm({
      full_name: lead.full_name || '',
      company_name: lead.company_name || '',
      phone: lead.phone || '',
      email: lead.email || '',
      source: lead.source || 'walk-in',
      status: lead.status || 'new',
      assigned_rep: lead.assigned_rep || '',
      notes: lead.notes || '',
    })
    setShowAddLead(true)
  }

  const handleDeleteLead = (lead) => {
    openConfirm(t('leads.deleteLeadTitle'), t('leads.deleteLeadConfirm', { name: lead.full_name }), async () => {
      closeConfirm()
      try {
        await db.leads.update(lead.id, { status: 'disqualified' })
        toast.success(t('leads.leadDisqualified'))
        db.auditLog.log(currentUserEmail, 'lead_disqualified', `Disqualified lead ${lead.full_name}`).catch(() => {})
        queryClient.invalidateQueries({ queryKey: ['leads'] })
      } catch (error) {
        toast.error(t('leads.failedSave', { error: error.message }))
      }
    })
  }

  // Reopen a disqualified lead back into the active pool. Returns it to 'new'
  // rather than a remembered prior status — the lead is being re-qualified from
  // scratch, and no prior-status column exists to restore from.
  const handleReopenLead = async (lead) => {
    try {
      await db.leads.update(lead.id, { status: 'new' })
      toast.success(t('leads.leadReopened'))
      db.auditLog.log(currentUserEmail, 'lead_reopened', `Reopened lead ${lead.full_name}`).catch(() => {})
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  const handleOpenConvert = (lead) => {
    const pid = pipelines[0]?.id ?? ''
    const firstStage = pipelines[0]?.stages
      ? [...pipelines[0].stages].sort((a, b) => a.order - b.order).find((s) => !s.is_won && !s.is_lost)
      : null
    setConvertingLead(lead)
    setConvertForm({
      ...EMPTY_CONVERT_FORM,
      title: `${lead.full_name} — Deal`,
      pipeline_id: pid,
      stage_id: firstStage?.id ?? '',
    })
  }

  const handleConvert = async () => {
    if (!convertForm.title.trim() || !convertForm.pipeline_id) {
      toast.error(t('leadModal.convertValidation'))
      return
    }
    try {
      const result = await db.leads.convert(convertingLead.id, {
        title: convertForm.title,
        pipelineId: convertForm.pipeline_id,
        value: convertForm.value ? Number(convertForm.value) : undefined,
      })
      // If the user chose a non-default stage, move the deal after creation.
      //
      // This used to be fire-and-forget with the error discarded, and without
      // the actor email that every other moveStage call passes. So a failure
      // left the deal sitting in the pipeline's first stage — not the one the
      // user picked in this very form — under a "Lead converted" toast, with
      // nothing recording who moved it.
      //
      // The conversion itself has already succeeded at this point, so a failed
      // move is reported as a partial success rather than an error: the lead is
      // converted either way, and saying otherwise would send the user looking
      // for a deal that exists.
      let stageMoved = true
      if (convertForm.stage_id) {
        try {
          await db.deals.moveStage(result.deal.id, convertForm.stage_id, currentUserEmail)
        } catch (stageError) {
          stageMoved = false
          captureException(stageError, { page: 'Leads', context: 'convert/moveStage' })
        }
      }
      if (stageMoved) {
        toast.success(t('leads.leadConverted'))
      } else {
        toast(t('leads.convertedButStageFailed'), { icon: '⚠️' })
      }
      db.auditLog
        .log(currentUserEmail, 'lead_converted', `Converted lead ${convertingLead.full_name} to deal ${result.deal.id}`)
        .catch(() => {})
      setConvertingLead(null)
      // Conversion creates a customer and a deal as well as changing the lead,
      // so invalidating only ['leads'] left the Pipeline board and the Customers
      // list showing state from before the conversion until something else
      // happened to refetch them.
      queryClient.invalidateQueries({ queryKey: ['leads'] })
      queryClient.invalidateQueries({ queryKey: ['deals'] })
      queryClient.invalidateQueries({ queryKey: ['customers'] })
    } catch (error) {
      toast.error(t('leads.failedConvert', { error: error.message }))
    }
  }

  const nonConvertedSelected = () =>
    [...selectedLeads].filter((id) => paginatedLeads.find((l) => l.id === id)?.status !== 'converted')

  const handleBulkDelete = () => {
    const ids = nonConvertedSelected()
    // Uses this page's existing openConfirm rather than the useConfirm hook —
    // Leads already owns a confirmDialog for the single-lead delete, and two
    // dialogs in one component is one too many.
    openConfirm(
      t('leads.bulkDeleteTitle', { count: ids.length }),
      t('leads.bulkDeleteConfirm', { count: ids.length }),
      async () => {
        closeConfirm()
        try {
          await db.leads.bulkDelete(ids)
          toast.success(t('leads.bulkDeleted', { count: ids.length }))
          setSelectedLeads(new Set())
          queryClient.invalidateQueries({ queryKey: ['leads'] })
        } catch (err) {
          toast.error(toUserMessage(err))
          // Part of the selection may have changed (BUG-074): show the real state.
          queryClient.invalidateQueries({ queryKey: ['leads'] })
        }
      }
    )
  }

  const handleBulkStatusChange = async (status) => {
    const ids = nonConvertedSelected()
    try {
      await db.leads.bulkUpdate(ids, { status }, currentUserEmail)
      toast.success(t('leads.bulkStatusChanged', { count: ids.length }))
      setSelectedLeads(new Set())
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (err) {
      toast.error(toUserMessage(err))
      // Part of the selection may have changed (BUG-074): show the real state.
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    }
  }

  const handleBulkSourceChange = async (source) => {
    const ids = nonConvertedSelected()
    try {
      await db.leads.bulkUpdate(ids, { source }, currentUserEmail)
      toast.success(t('leads.bulkSourceChanged', { count: ids.length }))
      setSelectedLeads(new Set())
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (err) {
      toast.error(toUserMessage(err))
      // Part of the selection may have changed (BUG-074): show the real state.
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    }
  }

  const handleDownloadTemplate = () => {
    const csv = [
      ['full_name', 'company_name', 'phone', 'email', 'source', 'status', 'notes'].join(','),
      ['Ahmed Saeed', 'Maximum Hardware', '01000121589', 'ahmed@maximum.com', 'phone', 'new', ''].join(','),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'leads-template.csv'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleBulkUpload = async (file) => {
    try {
      const rawText = await file.text()
      const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText
      const lines = text.split('\n').filter((line) => line.trim())
      if (lines.length < 2) {
        toast.error(t('leads.csvEmpty'))
        return
      }
      const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase())
      if (!headers.includes('full_name') || !headers.includes('source')) {
        toast.error(t('leads.csvMissingColumns'))
        return
      }
      const validSources = new Set(['walk-in', 'phone', 'referral', 'exhibition', 'website', 'whatsapp'])
      const validStatuses = new Set(['new', 'contacted', 'qualified', 'nurturing', 'inactive', 'disqualified'])
      const toImport = []
      const errors = []
      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i])
        const row = {}
        headers.forEach((h, idx) => {
          row[h] = values[idx] || ''
        })
        if (!row.full_name) {
          errors.push(`Row ${i + 1}: full_name is required`)
          continue
        }
        const problems = contactFieldProblems(row)
        if (problems.length) {
          errors.push(`Row ${i + 1}: ${problems.join('; ')}`)
          continue
        }

        const source = validSources.has(row.source) ? row.source : 'website'
        const status = validStatuses.has(row.status) ? row.status : 'new'
        toImport.push({
          lead_code: `LD-${Math.floor(10000000 + Math.random() * 90000000)}`,
          full_name: row.full_name,
          company_name: row.company_name || null,
          phone: row.phone || null,
          email: row.email || null,
          source,
          status,
          notes: row.notes || null,
          created_by: currentUserEmail,
        })
      }
      if (toImport.length === 0) {
        toast.error(t('leads.noValidLeads'))
        if (errors.length > 0) captureException(new Error('Lead CSV import errors'), { errors })
        return
      }
      // Chunked insert instead of one request per row (BUG-045): a 2,000-row
      // file used to make 2,000 sequential round trips, and a failure part-way
      // left a partial import nobody was told about.
      let importedCount = 0
      try {
        const created = await db.leads.bulkCreate(toImport)
        importedCount = created.length
      } catch (err) {
        const landed = err?.insertedBefore ?? 0
        captureException(err, { context: 'leads/csvImport', landed })
        toast.error(t('leads.importPartial', { count: landed }), { duration: 8000 })
        queryClient.invalidateQueries({ queryKey: ['leads'] })
        return
      }
      toast.success(t('leads.importedSuccess', { count: importedCount }))
      db.auditLog.log(currentUserEmail, 'leads_imported', `Imported ${toImport.length} leads from CSV`).catch(() => {})
      if (errors.length > 0) {
        toast.error(t('leads.importRowErrors', { count: errors.length }))
        captureException(new Error('Lead CSV import errors'), { errors })
      }
      setShowBulkUpload(false)
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (error) {
      toast.error(t('leads.failedImport', { error: error.message }))
    }
  }

  const handleKanbanStatusChange = async (leadId, newStatus) => {
    const lead = visibleLeads.find((l) => l.id === leadId)
    if (!lead) return
    try {
      await db.leads.updateStatus(lead.id, newStatus, currentUserEmail)
      toast.success(t('leads.statusUpdated'))
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  if (loading) return <PageSkeleton cols={6} />

  return (
    <div className="space-y-4">
      <PageHeader title={t('leads.title')} subtitle={t('leads.subtitle')}>
        {/* View switcher */}
        <div className="flex gap-1 bg-[#f4f6f9] dark:bg-[#0f1520] rounded-lg p-1">
          {LEADS_VIEWS.filter(({ key }) => key !== 'kanban' || kanbanAllowed).map(({ key, Icon }) => (
            <button
              key={key}
              onClick={() => setActiveView(key)}
              title={t(`leads.view_${key}`)}
              className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
                effectiveView === key
                  ? 'bg-white dark:bg-[#121823] text-[#4338ca] dark:text-[#a5b4fc] shadow-sm'
                  : 'text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]'
              }`}
            >
              <Icon />
            </button>
          ))}
        </div>
        <ExportMenu
          allCount={tabCounts?.all ?? 0}
          filteredCount={effectiveView === 'list' ? matchingCount : kanbanColumns.reduce((n, c) => n + c.count, 0)}
          selectedCount={selectedLeads.size}
          loadRows={loadExportRows}
          label={t('leads.export')}
          ns="leads"
          onExport={(rows, scope) => exportLeadsXlsx(rows, t, `leads-${scope}`)}
        />
        {canDo('create') && (
          <div className="relative add-lead-dropdown">
            <button
              onClick={(e) => { e.stopPropagation(); setShowAddLeadDropdown(!showAddLeadDropdown) }}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 flex items-center gap-2 text-sm font-medium"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              {t('leads.addLead')}
              <svg className={`w-4 h-4 transition-transform ${showAddLeadDropdown ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showAddLeadDropdown && (
              <div className="absolute end-0 mt-2 w-56 bg-white dark:bg-[#121823] rounded-lg shadow-lg border border-gray-200 dark:border-[#212a38] z-20">
                <button
                  onClick={() => { resetForm(); setShowAddLead(true); setShowAddLeadDropdown(false); }}
                  className="w-full px-4 py-3 text-start hover:bg-gray-50 dark:hover:bg-[#1a2230] flex items-center gap-3 border-b border-gray-100 dark:border-[#212a38]"
                >
                  <svg className="w-5 h-5 text-gray-500 dark:text-[#9aa4b2]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  <div>
                    <div className="font-medium text-gray-900 dark:text-[#e8ebf0]">{t('leadModal.addSingle')}</div>
                    <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t('leadModal.addSingleDesc')}</div>
                  </div>
                </button>
                <button
                  onClick={() => { setShowBulkUpload(true); setShowAddLeadDropdown(false) }}
                  className="w-full px-4 py-3 text-start hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] flex items-center gap-3 rounded-b-lg"
                >
                  <svg className="w-5 h-5 text-gray-500 dark:text-[#9aa4b2]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <div>
                    <div className="font-medium text-gray-900 dark:text-[#e8ebf0]">{t('leadModal.bulkImport')}</div>
                    <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t('leadModal.bulkImportDesc')}</div>
                  </div>
                </button>
              </div>
            )}
          </div>
        )}
      </PageHeader>

      {/* Status tabs — Active (default) vs Converted (view-only) */}
      <div className="flex gap-1 border-b border-[#e6e9ef] dark:border-[#212a38]">
        {[
          { id: 'all', label: t('leads.tabAll'), count: tabCounts?.all ?? 0 },
          { id: 'active', label: t('leads.tabActive'), count: tabCounts?.active ?? 0 },
          { id: 'converted', label: t('leads.tabConverted'), count: tabCounts?.converted ?? 0 },
          { id: 'disqualified', label: t('leads.tabDisqualified'), count: tabCounts?.disqualified ?? 0 },
        ].map(({ id, label, count }) => (
          <button
            key={id}
            onClick={() => setStatusTab(id)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
              statusTab === id
                ? 'border-[#4338ca] dark:border-[#a5b4fc] text-[#4338ca] dark:text-[#a5b4fc]'
                : 'border-transparent text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]'
            }`}
          >
            {label}
            {count > 0 && (
              <span className={`px-1.5 py-0.5 rounded-full text-xs ${
                statusTab === id
                  ? 'bg-[#4338ca]/10 dark:bg-[#a5b4fc]/10 text-[#4338ca] dark:text-[#a5b4fc]'
                  : 'bg-[#f4f6f9] dark:bg-[#1a2230] text-[#6c6760] dark:text-[#9aa4b2]'
              }`}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Search + filter — shared across both views */}
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] shadow-sm">
        <div className="px-5 py-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <SearchInput ref={searchRef} value={searchQuery} onChange={setSearchQuery} placeholder={t('leads.searchPlaceholder')} aria-label={t('leads.searchPlaceholder')} className="flex-1 max-w-md" />
              <button
                onClick={() => setShowFilters(!showFilters)}
                aria-expanded={showFilters}
                aria-controls="leads-filters-panel"
                className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${
                  showFilters || filterStatuses.size || filterSources.size || filterReps.size
                    ? 'border-indigo-500 text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 dark:border-indigo-400 dark:text-indigo-300'
                    : 'border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'
                }`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
                </svg>
                {t('common.filters')}
                {(filterStatuses.size + filterSources.size + filterReps.size) > 0 && (
                  <span className="w-4 h-4 bg-indigo-600 text-white text-xs rounded-full flex items-center justify-center">
                    {filterStatuses.size + filterSources.size + filterReps.size}
                  </span>
                )}
              </button>
            </div>
            {showFilters && (
              <div id="leads-filters-panel" className="p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
                <div className="flex flex-wrap gap-3">
                  <MultiCheckFilter
                    label={t('leads.allStatuses')}
                    selected={filterStatuses}
                    onChange={setFilterStatuses}
                    options={LEAD_STATUS_LIST.filter((s) => statusTab === 'converted' || s !== 'converted').map((s) => ({ value: s, label: t(`leadStatus.${s}`) }))}
                  />
                  <MultiCheckFilter
                    label={t('leads.allSources')}
                    selected={filterSources}
                    onChange={setFilterSources}
                    options={['walk-in','phone','referral','exhibition','website','whatsapp'].map((s) => ({ value: s, label: t(`leadSource.${s.replace('-','_')}`) }))}
                  />
                  <MultiCheckFilter
                    label={t('leads.allReps')}
                    selected={filterReps}
                    onChange={setFilterReps}
                    options={salesReps.map((r) => ({ value: r.user_email, label: r.user_email }))}
                  />
                  {(filterStatuses.size || filterSources.size || filterReps.size) ? (
                    <button
                      onClick={() => { setFilterStatuses(new Set()); setFilterSources(new Set()); setFilterReps(new Set()) }}
                      className="text-sm text-red-500 dark:text-red-400 hover:underline self-center"
                    >
                      {t('common.clear')}
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedLeads.size > 0 && (
        <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-[#4338ca]/20 dark:border-[#a5b4fc]/20 rounded-[14px] px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-[#4338ca] dark:text-[#a5b4fc]">
            {selectedLeads.size} {t('common.selected')}
          </span>
          <div className="w-px h-5 bg-[#4338ca]/20 dark:bg-[#a5b4fc]/20" />
          <select
            defaultValue=""
            onChange={(e) => { if (e.target.value) { handleBulkStatusChange(e.target.value); e.target.value = '' } }}
            className="text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
          >
            <option value="">{t('leads.bulkChangeStatus')}</option>
            {['new','contacted','qualified','nurturing','inactive','disqualified'].map((s) => (
              <option key={s} value={s}>{t(`leadStatus.${s}`)}</option>
            ))}
          </select>
          <select
            defaultValue=""
            onChange={(e) => { if (e.target.value) { handleBulkSourceChange(e.target.value); e.target.value = '' } }}
            className="text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
          >
            <option value="">{t('leads.bulkChangeSource')}</option>
            {['walk-in','phone','referral','exhibition','website','whatsapp'].map((s) => (
              <option key={s} value={s}>{t(`leadSource.${s.replace('-','_')}`)}</option>
            ))}
          </select>
          {canDo('delete') && (
            <button
              onClick={handleBulkDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors border border-red-200 dark:border-red-800"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {t('common.delete')}
            </button>
          )}
          <button
            onClick={() => setSelectedLeads(new Set())}
            className="ms-auto text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]"
          >
            {t('common.clear')}
          </button>
        </div>
      )}

      {/* List view */}
      {effectiveView === 'list' && (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
          {/* Count + per-page row */}
          <div className="px-5 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-[#e6e9ef] dark:border-[#212a38]">
            <span className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
              {t('leads.showingRange', { from: matchingCount === 0 ? 0 : startIndex + 1, to: endIndex, total: matchingCount })}
            </span>
            <div className="flex items-center gap-2">
              <label className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('common.itemsPerPage')}:</label>
              <select
                aria-label={t('common.itemsPerPage')}
                value={itemsPerPage}
                onChange={(e) => setItemsPerPage(parseInt(e.target.value))}
                className="px-3 py-1 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  <th className="ps-4 pe-2 py-3 w-8">
                    <input
                      type="checkbox"
                      className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500"
                      checked={paginatedLeads.filter((l) => l.status !== 'converted').length > 0 && paginatedLeads.filter((l) => l.status !== 'converted').every((l) => selectedLeads.has(l.id))}
                      onChange={(e) => {
                        const selectable = paginatedLeads.filter((l) => l.status !== 'converted').map((l) => l.id)
                        if (e.target.checked) setSelectedLeads((prev) => new Set([...prev, ...selectable]))
                        else setSelectedLeads((prev) => { const next = new Set(prev); selectable.forEach((id) => next.delete(id)); return next })
                      }}
                      aria-label={t('common.selectAll')}
                    />
                  </th>
                  <th className="px-2 py-3 text-start text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase w-10">#</th>
                  <th className="px-2 py-3 text-start text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase w-32">{t('common.code')}</th>
                  <th className="px-4 py-3 text-start text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                    <SortableHeader label={t('leads.colName')} sortKey="full_name" sortConfig={sortConfig} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-3 text-start text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('leads.colContact')}</th>
                  <th className="px-4 py-3 text-start text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                    <SortableHeader label={t('leads.colSource')} sortKey="source" sortConfig={sortConfig} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-3 text-start text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                    <SortableHeader label={t('common.status')} sortKey="status" sortConfig={sortConfig} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-3 text-start text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                    <SortableHeader label={t('leads.colAssignedRep')} sortKey="assigned_rep" sortConfig={sortConfig} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-3 text-start text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                    <SortableHeader label={t('common.createdAt')} sortKey="created_at" sortConfig={sortConfig} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-3 text-start text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e6e9ef] dark:divide-[#212a38]">
                {paginatedLeads.length === 0 ? (
                  <tr>
                    <td colSpan="10">
                      <EmptyState
                        title={t('leads.noLeadsFound')}
                        description={(tabCounts?.all ?? 0) > 0 ? t('leads.adjustFilters') : t('leads.noLeadsHint')}
                        action={canDo('create') && (tabCounts?.all ?? 0) === 0 ? () => setShowAddLead(true) : undefined}
                        actionLabel={t('leads.addFirstLead')}
                      />
                    </td>
                  </tr>
                ) : (
                  paginatedLeads.map((l, idx) => (
                    <tr key={l.id} className={`hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] transition-colors ${selectedLeads.has(l.id) ? 'bg-indigo-50/50 dark:bg-indigo-900/10' : ''}`}>
                      <td className="ps-4 pe-2 py-3">
                        <input
                          type="checkbox"
                          disabled={l.status === 'converted'}
                          className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed"
                          checked={selectedLeads.has(l.id)}
                          onChange={(e) => {
                            const next = new Set(selectedLeads)
                            if (e.target.checked) next.add(l.id)
                            else next.delete(l.id)
                            setSelectedLeads(next)
                          }}
                          aria-label={t('common.selectRow', { name: l.full_name })}
                        />
                      </td>
                      <td className="px-2 py-3 text-xs text-[#746f65] dark:text-[#a4acb7] font-mono">{startIndex + idx + 1}</td>
                      <td className="px-2 py-3">
                        <button
                          onClick={() => navigate(`/leads/${l.id}`)}
                          className="text-xs font-mono font-semibold text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                        >
                          {l.lead_code || '—'}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-[#211f1b] dark:text-[#e8ebf0] text-sm">
                          {l.company_name || l.full_name}
                        </div>
                        {l.company_name && <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{l.full_name}</div>}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-[#9aa4b2]">
                        {l.phone || l.email ? <Ltr>{l.phone || l.email}</Ltr> : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {canEditStatus(l) ? (
                          <button
                            onClick={(e) => handleToggleSourceMenu(e, l.id)}
                            aria-haspopup="menu"
                            aria-expanded={sourceMenu.id === l.id}
                            className={`source-menu px-2 py-0.5 text-xs rounded-full font-medium inline-flex items-center gap-1 hover:opacity-80 transition-opacity ${SOURCE_BADGE[l.source] || SOURCE_BADGE['walk-in']}`}
                          >
                            {t(`leadSource.${l.source?.replace('-', '_')}`)}
                            <svg className="w-2.5 h-2.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                        ) : (
                          <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${SOURCE_BADGE[l.source] || SOURCE_BADGE['walk-in']}`}>
                            {t(`leadSource.${l.source?.replace('-', '_')}`)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {canEditStatus(l) ? (
                          <button
                            onClick={(e) => handleToggleStatusMenu(e, l.id)}
                            aria-haspopup="menu"
                            aria-expanded={statusMenu.id === l.id}
                            className={`status-menu px-2 py-0.5 text-xs rounded-full font-medium inline-flex items-center gap-1 hover:opacity-80 transition-opacity ${STATUS_BADGE[l.status] || STATUS_BADGE.new}`}
                          >
                            {t(`leadStatus.${l.status}`)}
                            <svg className="w-2.5 h-2.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                        ) : (
                          <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${STATUS_BADGE[l.status] || STATUS_BADGE.new}`}>
                            {t(`leadStatus.${l.status}`)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-[#9aa4b2]">{l.assigned_rep || '—'}</td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-[#9aa4b2] whitespace-nowrap">
                        {l.created_at ? new Date(l.created_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-3 relative action-menu">
                        <button
                          onClick={(e) => handleToggleMenu(e, l.id)}
                          aria-label={t('leads.actionsFor', { name: l.full_name })}
                          aria-expanded={openMenuId === l.id}
                          aria-haspopup="menu"
                          className="p-1.5 rounded-lg text-gray-500 dark:text-[#9aa4b2] hover:bg-gray-100 dark:hover:bg-[#1a2230] transition-colors"
                        >
                          <svg className="w-4 h-4" aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
                            <circle cx="12" cy="5" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="12" cy="19" r="1.5" />
                          </svg>
                        </button>
                        {openMenuId === l.id &&
                          menuAnchor &&
                          createPortal(
                            <div
                              role="menu"
                              style={{ position: 'fixed', top: menuAnchor.top, left: menuAnchor.left, width: MENU_WIDTH, zIndex: 9999 }}
                              className="action-menu bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-gray-200 dark:border-[#212a38] py-1 overflow-hidden"
                            >
                              <button
                                onClick={() => {
                                  navigate(`/leads/${l.id}`)
                                  setOpenMenuId(null)
                                }}
                                className="w-full px-4 py-2 text-start text-sm text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230]"
                              >
                                {t('leads.viewLead')}
                              </button>
                              {l.status !== 'converted' && canDo('edit') && (
                                <button
                                  onClick={() => {
                                    handleEditLead(l)
                                    setOpenMenuId(null)
                                  }}
                                  className="w-full px-4 py-2 text-start text-sm text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230]"
                                >
                                  {t('common.edit')}
                                </button>
                              )}
                              {l.status !== 'converted' && canDo('create') && (
                                <button
                                  onClick={() => {
                                    handleOpenConvert(l)
                                    setOpenMenuId(null)
                                  }}
                                  className="w-full px-4 py-2 text-start text-sm text-indigo-600 hover:bg-gray-50 dark:hover:bg-[#1a2230]"
                                >
                                  {t('leads.convertToDeal')}
                                </button>
                              )}
                              {l.status !== 'converted' && l.status !== 'disqualified' && canDo('edit') && (
                                <button
                                  onClick={() => {
                                    handleDeleteLead(l)
                                    setOpenMenuId(null)
                                  }}
                                  className="w-full px-4 py-2 text-start text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                                >
                                  {t('leads.disqualify')}
                                </button>
                              )}
                              {l.status === 'disqualified' && canDo('edit') && (
                                <button
                                  onClick={() => {
                                    handleReopenLead(l)
                                    setOpenMenuId(null)
                                  }}
                                  className="w-full px-4 py-2 text-start text-sm text-indigo-600 hover:bg-gray-50 dark:hover:bg-[#1a2230]"
                                >
                                  {t('leads.reopenLead')}
                                </button>
                              )}
                            </div>,
                            document.body
                          )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {/* Pagination footer */}
          {totalPages > 1 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-3 border-t border-[#e6e9ef] dark:border-[#212a38]">
              <div className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
                {t('leads.showingRange', { from: startIndex + 1, to: endIndex, total: matchingCount })}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage === 1}
                  className="px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t('common.previous')}
                </button>
                <div className="flex items-center gap-1">{renderLeadsPageNumbers()}</div>
                <button
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  className="px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t('common.next')}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('common.jumpToPage')}:</span>
                <input
                  type="number"
                  min="1"
                  max={totalPages}
                  aria-label={t('common.jumpToPage')}
                  value={jumpToPage}
                  onChange={(e) => setJumpToPage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleJumpToPage()}
                  placeholder={currentPage.toString()}
                  className="w-20 px-3 py-1 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
                />
                <button
                  onClick={handleJumpToPage}
                  className="px-3 py-1 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] rounded-lg hover:opacity-90 text-sm transition-opacity"
                >
                  {t('common.go')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Kanban view */}
      {effectiveView === 'kanban' && (
        <LeadsKanbanView
          columns={kanbanColumns}
          onLoadMore={(status) =>
            setColumnLimits((prev) => ({ ...prev, [status]: (prev[status] ?? KANBAN_PAGE) + KANBAN_PAGE }))
          }
          onStatusChange={handleKanbanStatusChange}
          canEdit={canDo('edit')}
        />
      )}

      {showAddLead && (
        <CreateLeadModal
          form={leadForm}
          setForm={setLeadForm}
          editing={editingLead}
          leadCode={editingLead ? editingLead.lead_code : pendingLeadCode}
          salesReps={salesReps}
          onSave={handleSaveLead}
          onClose={() => {
            setShowAddLead(false)
            resetForm()
          }}
        />
      )}

      {showBulkUpload && (
        <BulkUploadLeadsModal
          onClose={() => setShowBulkUpload(false)}
          onUpload={handleBulkUpload}
          onDownloadTemplate={handleDownloadTemplate}
        />
      )}

      {convertingLead && (
        <ConvertLeadModal
          lead={convertingLead}
          stages={
            pipelines[0]?.stages
              ? [...pipelines[0].stages].sort((a, b) => a.order - b.order).filter((s) => !s.is_won && !s.is_lost)
              : []
          }
          form={convertForm}
          setForm={setConvertForm}
          onConvert={handleConvert}
          onClose={() => setConvertingLead(null)}
        />
      )}

      {statusMenu.id &&
        statusMenu.anchor &&
        statusMenuLead &&
        createPortal(
          <div
            role="menu"
            style={{ position: 'fixed', top: statusMenu.anchor.top, left: statusMenu.anchor.left, width: STATUS_MENU_WIDTH, zIndex: 9999 }}
            className="status-menu bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-gray-200 dark:border-[#212a38] py-1 overflow-hidden"
          >
            {inlineStatusList.map((s) => (
              <button
                key={s}
                onClick={() => handleInlineStatus(statusMenuLead, s)}
                className={`w-full px-3 py-1.5 text-start flex items-center transition-colors ${statusMenuLead.status === s ? 'opacity-40 cursor-default' : 'hover:bg-gray-50 dark:hover:bg-[#1a2230]'}`}
              >
                <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${STATUS_BADGE[s] || STATUS_BADGE.new}`}>
                  {t(`leadStatus.${s}`)}
                </span>
              </button>
            ))}
          </div>,
          document.body
        )}

      {sourceMenu.id &&
        sourceMenu.anchor &&
        sourceMenuLead &&
        createPortal(
          <div
            role="menu"
            style={{ position: 'fixed', top: sourceMenu.anchor.top, left: sourceMenu.anchor.left, width: SOURCE_MENU_WIDTH, zIndex: 9999 }}
            className="source-menu bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-gray-200 dark:border-[#212a38] py-1 overflow-hidden"
          >
            {LEAD_SOURCE_LIST.map((s) => (
              <button
                key={s}
                onClick={() => handleInlineSource(sourceMenuLead, s)}
                className={`w-full px-3 py-1.5 text-start flex items-center transition-colors ${sourceMenuLead.source === s ? 'opacity-40 cursor-default' : 'hover:bg-gray-50 dark:hover:bg-[#1a2230]'}`}
              >
                <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${SOURCE_BADGE[s] || SOURCE_BADGE['walk-in']}`}>
                  {t(`leadSource.${s.replace('-', '_')}`)}
                </span>
              </button>
            ))}
          </div>,
          document.body
        )}

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        onConfirm={confirmDialog.onConfirm}
        onCancel={closeConfirm}
      />
    </div>
  )
}
