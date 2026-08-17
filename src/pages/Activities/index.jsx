import React, { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { useURLTab } from '../../hooks/useURLTab'
import { canDo } from '../../lib/permissions'
import { PageHeader } from '../../components/ui'
import { safeStorage } from '../../lib/safeStorage'
import { PageSkeleton } from '../../components/Skeleton'
import { APPROVAL_DOC_TYPE_LABEL_KEY, approvalRequestLabel } from '../../lib/approvalLabels'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { useConfirm } from '../../hooks/useConfirm'

// ── Type icons + colors ────────────────────────────────────────────────────
const TYPE_ICON_PATHS = {
  call:     'M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z',
  meeting:  'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  whatsapp: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
  email:    'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  task:     'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  note:     'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  approval: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
}
const TYPE_COLORS = {
  call:     '#4338ca',
  meeting:  '#7c3aed',
  whatsapp: '#059669',
  email:    '#0284c7',
  task:     '#d97706',
  note:     '#6c6760',
  approval: '#4338ca',
}

function ActivityTypeIcon({ type, size = 14 }) {
  const path = TYPE_ICON_PATHS[type] ?? TYPE_ICON_PATHS.task
  const color = TYPE_COLORS[type] ?? TYPE_COLORS.task
  return (
    <svg width={size} height={size} fill="none" stroke={color} strokeWidth={1.8} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  )
}

// Source badge colors. Scheduled activities use their related_type (lead/deal);
// approval activities use the document type they were raised for.
const SOURCE_BADGE = {
  lead:        'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  deal:        'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
  quotation:   'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400',
  sales_order: 'bg-teal-100 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400',
  invoice:     'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  credit_note: 'bg-rose-100 dark:bg-rose-900/20 text-rose-700 dark:text-rose-400',
}

// lead/deal are the non-approval sources (an activity's own related_type); the
// document types come from the shared approval map so the Source column, the
// filter dropdown and the "… Approval Request" label can never disagree.
const SOURCE_LABEL_KEY = {
  lead:            'activities.sourceLead',
  deal:            'activities.sourceDeal',
  ...APPROVAL_DOC_TYPE_LABEL_KEY,
}

// The selectable document sources in the filter dropdown (approval pool).
const DOC_SOURCES = Object.keys(APPROVAL_DOC_TYPE_LABEL_KEY)

// Doc types whose detail page lives under /purchasing instead of /sales.
const PURCHASE_DOC_TYPES = new Set(['purchase_order', 'vendor_invoice'])

// Approval pool format: approval|docType|docId|code|total|customer
function parseApprovalTitle(title) {
  const parts = (title || '').split('|')
  return {
    docType: parts[1] || 'quotation',
    docId: parts[2] || '',
    code: parts[3] || '—',
    total: Number(parts[4]) || 0,
    customer: parts[5] || '—',
  }
}

// An approval-type activity surfaces its document type as the source
// (Quotation / Sales Order / Invoice / Credit Note); everything else uses
// the underlying related_type.
function activitySource(a) {
  return a.type === 'approval' ? parseApprovalTitle(a.title).docType : (a.related_type || 'deal')
}

function sourceLabelKey(source) {
  return SOURCE_LABEL_KEY[source] || 'activities.sourceDeal'
}

function SortableHeader({ label, sortKey, sortConfig, onSort }) {
  const isActive = sortConfig.key === sortKey
  const ariaSort = isActive ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending') : 'none'
  return (
    <button
      onClick={() => onSort(sortKey)}
      aria-label={`Sort by ${label}`}
      aria-sort={ariaSort}
      className="flex items-center gap-1 hover:text-[#211f1b] dark:hover:text-[#e8ebf0] transition-colors"
    >
      <span>{label}</span>
      {isActive ? (
        sortConfig.direction === 'asc' ? (
          <svg className="w-3.5 h-3.5 text-indigo-600 dark:text-[#a5b4fc] ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5 text-indigo-600 dark:text-[#a5b4fc] ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )
      ) : (
        <svg className="w-3.5 h-3.5 text-gray-300 dark:text-[#768292] ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
      )}
    </button>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
export default function Activities({ currentUserRole, currentUserEmail, currentUserPermissions }) {
  const { confirm, confirmDialog } = useConfirm()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Tabs: all (default) → today → overdue → logs
  const [tab, setTab] = useURLTab('tab', 'all')

  // Search & filters
  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterType, setFilterType] = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')
  const [filterSource, setFilterSource] = useState('')

  // Selection
  const [selectedActivities, setSelectedActivities] = useState(new Set())

  // Inline reschedule (parent-level: only one row open at a time)
  const [reschedulingId, setReschedulingId] = useState(null)
  const [rescheduleDate, setRescheduleDate] = useState('')

  // Sorting
  const [sortConfig, setSortConfig] = useState(() =>
    safeStorage.get('activitiesSortConfig', { key: 'due_date', direction: 'asc' })
  )

  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(() => safeStorage.get('activitiesPerPage', 25))
  const [jumpToPage, setJumpToPage] = useState('')

  const today = new Date().toISOString().split('T')[0]

  // ── Data queries ──────────────────────────────────────────────────────────
  const { data: activities = EMPTY_ARRAY, isLoading } = useQuery({
    queryKey: ['activities', 'planned'],
    queryFn: () => db.activities.listAllPlanned(),
    staleTime: 30_000,
  })
  const { data: completedActivities = EMPTY_ARRAY } = useQuery({
    queryKey: ['activities', 'completed'],
    queryFn: () => db.activities.listCompleted(),
    staleTime: 30_000,
  })
  const { data: leads = EMPTY_ARRAY } = useQuery({
    queryKey: ['leads'],
    queryFn: () => db.leads.list(),
    staleTime: 60_000,
  })
  const { data: deals = EMPTY_ARRAY } = useQuery({
    queryKey: ['deals'],
    queryFn: () => db.deals.list(),
    staleTime: 60_000,
  })
  const { data: customers = EMPTY_ARRAY } = useQuery({
    queryKey: ['customers'],
    queryFn: () => db.customers.list(),
    staleTime: 60_000,
  })

  const leadMap     = useMemo(() => Object.fromEntries(leads.map((l) => [l.id, l])),     [leads])
  const dealMap     = useMemo(() => Object.fromEntries(deals.map((d) => [d.id, d])),     [deals])
  const customerMap = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c])), [customers])

  // ── Name resolution ───────────────────────────────────────────────────────
  const getCustomerName = React.useCallback((a) => {
    // Approval rows (deal- or customer-linked) carry the customer name in the
    // encoded title, so they resolve uniformly regardless of related_type.
    if (a.type === 'approval') return parseApprovalTitle(a.title).customer || '—'
    if (a.related_type === 'lead') {
      const l = leadMap[a.related_id]
      return l ? (l.company_name || l.full_name || '—') : '—'
    }
    if (a.related_type === 'deal') {
      const d = dealMap[a.related_id]
      if (!d) return '—'
      const c = customerMap[d.customer_id]
      return c ? (c.company_name || c.contact_person || '—') : '—'
    }
    if (a.related_type === 'customer') {
      const c = customerMap[a.related_id]
      return c ? (c.company_name || c.contact_person || '—') : '—'
    }
    return '—'
  }, [leadMap, dealMap, customerMap])

  // Source record code — lets users search the Activities page directly by
  // the underlying lead/deal/QT/SO/INV/CN code instead of just title/customer.
  const getSourceCode = React.useCallback((a) => {
    if (a.type === 'approval') return parseApprovalTitle(a.title).code || ''
    if (a.related_type === 'lead') return leadMap[a.related_id]?.lead_code || ''
    if (a.related_type === 'deal') return dealMap[a.related_id]?.deal_code || ''
    return ''
  }, [leadMap, dealMap])

  // Navigation link — open the source: a lead/deal's scheduled activity opens
  // that record; an approval opens the underlying document detail (works for
  // both deal- and customer-linked quotations). Not the customer page.
  const getCustomerLink = React.useCallback((a) => {
    if (a.type === 'approval') {
      const { docType, docId } = parseApprovalTitle(a.title)
      if (!docId) return null
      return PURCHASE_DOC_TYPES.has(docType) ? `/purchasing/${docType}/${docId}` : `/sales/${docType}/${docId}`
    }
    if (a.related_type === 'lead') return leadMap[a.related_id] ? `/leads/${a.related_id}` : null
    if (a.related_type === 'deal') return dealMap[a.related_id] ? `/pipeline/${a.related_id}` : null
    return null
  }, [leadMap, dealMap])

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => { safeStorage.set('activitiesPerPage', itemsPerPage) }, [itemsPerPage])
  useEffect(() => { safeStorage.set('activitiesSortConfig', sortConfig) }, [sortConfig])
  useEffect(() => { setCurrentPage(1) }, [search, filterType, filterAssignee, filterSource, tab, itemsPerPage, sortConfig])
  // Clear selection when tab changes
  useEffect(() => { setSelectedActivities(new Set()) }, [tab])

  const handleSort = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  // ── Tab counts ─────────────────────────────────────────────────────────────
  const overdueCount = useMemo(
    () => activities.filter((a) => { const d = a.due_date?.split('T')[0]; return d && d < today }).length,
    [activities, today]
  )
  const todayCount = useMemo(
    () => activities.filter((a) => { const d = a.due_date?.split('T')[0]; return d && d === today }).length,
    [activities, today]
  )

  // ── Source pool for current tab ────────────────────────────────────────────
  const sourcePool = tab === 'logs' ? completedActivities : activities

  // ── Filtering ─────────────────────────────────────────────────────────────
  const tabFiltered = useMemo(() => {
    if (tab === 'logs')    return completedActivities
    if (tab === 'overdue') return activities.filter((a) => { const d = a.due_date?.split('T')[0]; return d && d < today })
    if (tab === 'today')   return activities.filter((a) => { const d = a.due_date?.split('T')[0]; return d && d === today })
    return activities
  }, [activities, completedActivities, tab, today])

  const filtered = useMemo(() => {
    let f = tabFiltered
    if (search) {
      const q = search.toLowerCase()
      f = f.filter((a) =>
        a.title.toLowerCase().includes(q) ||
        getCustomerName(a).toLowerCase().includes(q) ||
        (a.assigned_rep ?? '').toLowerCase().includes(q) ||
        getSourceCode(a).toLowerCase().includes(q)
      )
    }
    if (filterType)     f = f.filter((a) => a.type === filterType)
    if (filterAssignee) f = f.filter((a) => a.assigned_rep === filterAssignee)
    if (filterSource)   f = f.filter((a) => activitySource(a) === filterSource)

    // Sort
    const isLogs = tab === 'logs'
    f = [...f].sort((a, b) => {
      let aVal, bVal
      if (sortConfig.key === 'due_date') {
        const dateKey = isLogs ? 'completed_at' : 'due_date'
        aVal = new Date(a[dateKey] || 0).getTime()
        bVal = new Date(b[dateKey] || 0).getTime()
      } else if (sortConfig.key === 'customer') {
        aVal = getCustomerName(a).toLowerCase()
        bVal = getCustomerName(b).toLowerCase()
      } else {
        aVal = (a[sortConfig.key] ?? '').toString().toLowerCase()
        bVal = (b[sortConfig.key] ?? '').toString().toLowerCase()
      }
      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })

    return f
  }, [tabFiltered, search, filterType, filterAssignee, filterSource, getCustomerName, getSourceCode, sortConfig, tab])

  const allAssignees = useMemo(
    () => [...new Set(sourcePool.map((a) => a.assigned_rep).filter(Boolean))].sort(),
    [sourcePool]
  )

  const activeFilterCount = [filterType, filterAssignee, filterSource].filter(Boolean).length

  // ── Permissions ───────────────────────────────────────────────────────────
  const canEdit =
    canDo(currentUserRole, currentUserPermissions, 'deals', 'edit') ||
    canDo(currentUserRole, currentUserPermissions, 'leads', 'edit')

  // Only managers and admins may approve/reject a quotation approval request.
  const canApprove = ['manager', 'admin', 'super_admin'].includes(currentUserRole)

  // ── Pagination ────────────────────────────────────────────────────────────
  const totalPages  = Math.ceil(filtered.length / itemsPerPage)
  const startIndex  = (currentPage - 1) * itemsPerPage
  const endIndex    = Math.min(startIndex + itemsPerPage, filtered.length)
  const paginatedActivities = filtered.slice(startIndex, endIndex)

  const handlePageChange = (page) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }
  const handleJumpToPage = () => {
    const pageNum = parseInt(jumpToPage)
    if (pageNum >= 1 && pageNum <= totalPages) { handlePageChange(pageNum); setJumpToPage('') }
    else toast.error(t('activities.pageMustBeBetween', { total: totalPages }))
  }
  const renderPageNumbers = () => {
    const pages = []
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i)
    } else if (currentPage <= 4) {
      for (let i = 1; i <= 5; i++) pages.push(i)
      pages.push('...')
      pages.push(totalPages)
    } else if (currentPage >= totalPages - 3) {
      pages.push(1); pages.push('...')
      for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i)
    } else {
      pages.push(1); pages.push('...')
      for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i)
      pages.push('...'); pages.push(totalPages)
    }
    return pages.map((p, i) =>
      p === '...' ? (
        <span key={`e${i}`} className="px-2 text-[#6c6760] dark:text-[#9aa4b2]">…</span>
      ) : (
        <button key={p} onClick={() => handlePageChange(p)}
          className={`w-8 h-8 rounded text-sm ${currentPage === p ? 'bg-[#4338ca] text-white' : 'text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230]'}`}>
          {p}
        </button>
      )
    )
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  const allPageSelected = paginatedActivities.length > 0 && paginatedActivities.every((a) => selectedActivities.has(a.id))
  const handleSelectAll = (checked) => {
    const next = new Set(selectedActivities)
    paginatedActivities.forEach((a) => { if (checked) next.add(a.id); else next.delete(a.id) })
    setSelectedActivities(next)
  }

  // ── Mutations ──────────────────────────────────────────────────────────────
  const invalidateAll = () => queryClient.invalidateQueries({ queryKey: ['activities'] })

  const handleMarkDone = async (id) => {
    try { await db.activities.complete(id); invalidateAll(); toast.success(t('activities.markedDoneToast')) }
    catch { toast.error(t('common.error')) }
  }

  const handleReopen = async (id) => {
    try { await db.activities.reopen(id); invalidateAll(); toast.success(t('activities.reopenedToast')) }
    catch { toast.error(t('common.error')) }
  }

  const handleCancel = (id) => {
    confirm({
      title: t('activities.deleteTitle'),
      message: t('activities.deleteConfirm'),
      // Not the default "Delete": this dialog asks "Cancel this activity?" and
      // its dismiss button already reads Cancel. [Cancel][Delete] would be two
      // different meanings of the same word sitting next to each other.
      confirmLabel: t('common.confirm'),
      onConfirm: async () => {
        try { await db.activities.delete(id); invalidateAll(); toast.success(t('activities.deletedToast')) }
        catch { toast.error(t('common.error')) }
      },
    })
  }

  const handleReschedule = async () => {
    if (!reschedulingId || !rescheduleDate) return
    try {
      await db.activities.reschedule(reschedulingId, rescheduleDate)
      invalidateAll()
      setReschedulingId(null)
      toast.success(t('activityChatter.activityRescheduled'))
    } catch { toast.error(t('common.error')) }
  }

  // ── Document approvals (from an 'approval'-type activity) ───────────────────
  // The activity title encodes the document type + id; approving/rejecting
  // dispatches to that document's lifecycle action so the decision syncs across
  // the system (status, inventory, codes), then completes the activity with a
  // who-stamped outcome note. Quotation is reachable today; the other three are
  // wired for when their document UIs gain a "Submit for Approval" action.
  const approveDocument = (docType, docId) => {
    switch (docType) {
      case 'quotation':      return db.quotations.markAccepted(docId)
      case 'sales_order':    return db.salesOrders.markAccepted(docId, currentUserEmail)
      case 'invoice':        return db.crmInvoices.post(docId, currentUserEmail)
      case 'credit_note':    return db.creditNotes.issue(docId, currentUserEmail)
      case 'purchase_order': return db.purchaseOrders.markConfirmed(docId)
      case 'vendor_invoice': return db.vendorInvoices.approve(docId)
      default:               return Promise.resolve()
    }
  }
  // An invoice awaiting approval is still a draft, and void_invoice refuses
  // drafts ("Only posted invoices can be voided") — its job is to undo a post
  // by restoring delivered inventory. So route by the invoice's actual state:
  // draft → cancelDraft, posted (a re-raised approval) → the full void.
  // Both land on doc_status = 'cancelled'.
  const rejectInvoice = async (docId) => {
    const reason = `Rejected by ${currentUserEmail}`
    const inv = await db.crmInvoices.get(docId)
    return inv?.doc_status === 'draft'
      ? db.crmInvoices.cancelDraft(docId, reason, currentUserEmail)
      : db.crmInvoices.void_(docId, reason, currentUserEmail)
  }

  const rejectDocument = (docType, docId) => {
    switch (docType) {
      case 'quotation':      return db.quotations.markDeclined(docId)
      case 'sales_order':    return db.salesOrders.markDeclined(docId, currentUserEmail)
      case 'invoice':        return rejectInvoice(docId)
      case 'credit_note':    return db.creditNotes.void_(docId, `Rejected by ${currentUserEmail}`, currentUserEmail)
      // PO/VI rejection sends them back to draft (editable/resubmittable),
      // not cancelled — user-chosen (2026-07-05/06), unlike the stricter
      // sales-invoice void-on-reject pattern above.
      case 'purchase_order': return db.purchaseOrders.rejectToDraft(docId)
      case 'vendor_invoice': return db.vendorInvoices.rejectToDraft(docId)
      default:               return Promise.resolve()
    }
  }

  const handleApproveActivity = async (activity) => {
    const { docType, docId } = parseApprovalTitle(activity.title)
    if (!docId) { toast.error(t('common.error')); return }
    try {
      await approveDocument(docType, docId)
      await db.activities.complete(activity.id, `Approved by ${currentUserEmail}`)
      invalidateAll()
      if (PURCHASE_DOC_TYPES.has(docType)) {
        queryClient.invalidateQueries({ queryKey: ['purchase-document', docType, docId] })
        queryClient.invalidateQueries({ queryKey: ['purchase-documents'] })
      } else {
        queryClient.invalidateQueries({ queryKey: ['sales-document', docType, docId] })
        queryClient.invalidateQueries({ queryKey: ['sales-documents'] })
      }
      toast.success(t('activities.approvedToast'))
    } catch (err) {
      console.error('Approve failed', err)
      toast.error(t('common.error'))
    }
  }

  const handleRejectActivity = async (activity) => {
    const { docType, docId } = parseApprovalTitle(activity.title)
    if (!docId) { toast.error(t('common.error')); return }
    try {
      await rejectDocument(docType, docId)
      await db.activities.complete(activity.id, `Rejected by ${currentUserEmail}`)
      invalidateAll()
      if (PURCHASE_DOC_TYPES.has(docType)) {
        queryClient.invalidateQueries({ queryKey: ['purchase-document', docType, docId] })
        queryClient.invalidateQueries({ queryKey: ['purchase-documents'] })
      } else {
        queryClient.invalidateQueries({ queryKey: ['sales-document', docType, docId] })
        queryClient.invalidateQueries({ queryKey: ['sales-documents'] })
      }
      toast.success(t('activities.rejectedToast'))
    } catch (err) {
      console.error('Reject failed', err)
      toast.error(t('common.error'))
    }
  }

  const handleBulkMarkDone = () => {
    if (!selectedActivities.size) return
    const count = selectedActivities.size
    confirm({
      title: t('activities.bulkDoneTitle', { count }),
      message: t('activities.bulkDoneConfirm', { count }),
      confirmLabel: t('activities.markDone'),
      onConfirm: async () => {
        try {
          await Promise.all([...selectedActivities].map((id) => db.activities.complete(id)))
          invalidateAll()
          toast.success(t('activities.bulkDoneToast', { count }))
          setSelectedActivities(new Set())
        } catch { toast.error(t('common.error')) }
      },
    })
  }

  const handleBulkCancel = () => {
    if (!selectedActivities.size) return
    const count = selectedActivities.size
    confirm({
      title: t('activities.bulkCancelTitle', { count }),
      message: t('activities.bulkCancelConfirm', { count }),
      confirmLabel: t('common.confirm'),
      onConfirm: async () => {
        try {
          await Promise.all([...selectedActivities].map((id) => db.activities.delete(id)))
          invalidateAll()
          toast.success(t('activities.bulkCancelToast', { count }))
          setSelectedActivities(new Set())
        } catch { toast.error(t('common.error')) }
      },
    })
  }

  // ── Tab config ─────────────────────────────────────────────────────────────
  const TABS = [
    { id: 'all',     label: t('activities.tabAll'),     count: activities.length },
    { id: 'today',   label: t('activities.tabToday'),   count: todayCount },
    { id: 'overdue', label: t('activities.tabOverdue'), count: overdueCount },
    { id: 'logs',    label: t('activities.tabLogs'),    count: completedActivities.length },
  ]

  const EMPTY = {
    all:     { title: t('activities.noActivities'), hint: t('activities.noActivitiesHint') },
    today:   { title: t('activities.noToday'),      hint: t('activities.noTodayHint') },
    overdue: { title: t('activities.noOverdue'),     hint: t('activities.noOverdueHint') },
    logs:    { title: t('activities.noLogs'),        hint: t('activities.noLogsHint') },
  }

  const isLogsTab = tab === 'logs'
  const dateColHeader = isLogsTab ? t('activities.colCompletedAt') : t('activities.colDueDate')

  if (isLoading) return <PageSkeleton cols={7} />

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('activities.title')}
        subtitle={t('activities.subtitle', { count: activities.length })}
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#e6e9ef] dark:border-[#212a38]">
        {TABS.map(({ id, label, count }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === id
                ? 'border-[#4338ca] dark:border-[#a5b4fc] text-[#4338ca] dark:text-[#a5b4fc]'
                : 'border-transparent text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]'
            }`}
          >
            {label}
            {count > 0 && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                id === 'overdue'
                  ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                  : 'bg-[#f0f2f6] dark:bg-[#1a2230] text-[#6c6760] dark:text-[#9aa4b2]'
              }`}>{count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Search + filter card — matches Leads/Pipeline design */}
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] shadow-sm">
        <div className="px-5 py-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 max-w-md">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('activities.searchPlaceholder')}
                  aria-label={t('activities.searchPlaceholder')}
                  className="w-full pl-9 pr-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#777268] dark:placeholder:text-[#768292]"
                />
                <svg className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <button
                onClick={() => setShowFilters(!showFilters)}
                aria-expanded={showFilters}
                aria-controls="activities-filter-panel"
                className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${
                  showFilters || activeFilterCount > 0
                    ? 'border-indigo-500 text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 dark:border-indigo-400 dark:text-indigo-300'
                    : 'border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'
                }`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
                </svg>
                {t('common.filters')}
                {activeFilterCount > 0 && (
                  <span className="w-4 h-4 bg-indigo-600 text-white text-xs rounded-full flex items-center justify-center">
                    {activeFilterCount}
                  </span>
                )}
              </button>
            </div>

            {showFilters && (
              <div id="activities-filter-panel" className="p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
                <div className="flex flex-wrap gap-3">
                  <select
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    className="px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
                  >
                    <option value="">{t('activities.allTypes')}</option>
                    {Object.keys(TYPE_ICON_PATHS).map((type) => (
                      <option key={type} value={type}>{t(`activityType.${type}`)}</option>
                    ))}
                  </select>
                  <select
                    value={filterAssignee}
                    onChange={(e) => setFilterAssignee(e.target.value)}
                    className="px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
                  >
                    <option value="">{t('activities.allAssignees')}</option>
                    {allAssignees.map((rep) => <option key={rep} value={rep}>{rep}</option>)}
                  </select>
                  <select
                    value={filterSource}
                    onChange={(e) => setFilterSource(e.target.value)}
                    className="px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
                  >
                    <option value="">{t('activities.allSources')}</option>
                    <option value="lead">{t('activities.sourceLead')}</option>
                    <option value="deal">{t('activities.sourceDeal')}</option>
                    {DOC_SOURCES.map((s) => (
                      <option key={s} value={s}>{t(sourceLabelKey(s))}</option>
                    ))}
                  </select>
                  {activeFilterCount > 0 && (
                    <button
                      onClick={() => { setFilterType(''); setFilterAssignee(''); setFilterSource('') }}
                      className="text-sm text-red-500 dark:text-red-400 hover:underline self-center"
                    >
                      {t('common.clear')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedActivities.size > 0 && (
        <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-[#4338ca]/20 dark:border-[#a5b4fc]/20 rounded-[14px] px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-[#4338ca] dark:text-[#a5b4fc]">
            {selectedActivities.size} {t('common.selected')}
          </span>
          <div className="w-px h-5 bg-[#4338ca]/20 dark:bg-[#a5b4fc]/20" />
          {canEdit && !isLogsTab && (
            <button
              onClick={handleBulkMarkDone}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 text-sm hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-colors border border-emerald-200 dark:border-emerald-800"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
              {t('activityChatter.markDone')}
            </button>
          )}
          {!isLogsTab && (
            <button
              onClick={handleBulkCancel}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors border border-red-200 dark:border-red-800"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              {t('activityChatter.cancelActivity')}
            </button>
          )}
          <button
            onClick={() => setSelectedActivities(new Set())}
            className="ml-auto text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]"
          >
            {t('common.clear')}
          </button>
        </div>
      )}

      {/* Table card */}
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
        {/* Count + per-page row */}
        <div className="px-5 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-[#e6e9ef] dark:border-[#212a38]">
          <span className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
            {t('activities.showingRange', {
              from: filtered.length === 0 ? 0 : startIndex + 1,
              to: endIndex,
              total: filtered.length,
            })}
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

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
                <th className="pl-4 pr-2 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500"
                    aria-label={t('common.selectAll')}
                  />
                </th>
                <th className="px-2 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase w-10">#</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('activities.colSource')} sortKey="related_type" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('activities.colUser')} sortKey="assigned_rep" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('activities.colCustomer')} sortKey="customer" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('activities.colDetails')} sortKey="title" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('activities.colCreated')} sortKey="created_at" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={dateColHeader} sortKey="due_date" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {paginatedActivities.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <div className="py-16 flex flex-col items-center text-center">
                      <svg className="w-12 h-12 text-[#777268] dark:text-[#768292] mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                      </svg>
                      <p className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{EMPTY[tab]?.title}</p>
                      <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">{EMPTY[tab]?.hint}</p>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedActivities.map((activity, idx) => {
                  const isRescheduling = reschedulingId === activity.id
                  const custName = getCustomerName(activity)
                  const custLink = getCustomerLink(activity)

                  // Date display: logs tab shows completed_at, others show due_date
                  const dateStr = isLogsTab
                    ? (activity.completed_at ? activity.completed_at.split('T')[0] : null)
                    : (activity.due_date ? activity.due_date.split('T')[0] : null)
                  const isActOverdue = !isLogsTab && dateStr && dateStr < today
                  const isActToday   = !isLogsTab && dateStr && dateStr === today
                  const dateColor = isActOverdue
                    ? 'text-red-600 dark:text-red-400'
                    : isActToday
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-[#6c6760] dark:text-[#9aa4b2]'

                  return (
                    <tr
                      key={activity.id}
                      className={`border-t border-[#e6e9ef] dark:border-[#212a38] hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] transition-colors ${
                        selectedActivities.has(activity.id) ? 'bg-indigo-50/50 dark:bg-indigo-900/10' : ''
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="pl-4 pr-2 py-3">
                        <input
                          type="checkbox"
                          className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500"
                          checked={selectedActivities.has(activity.id)}
                          onChange={(e) => {
                            const next = new Set(selectedActivities)
                            if (e.target.checked) next.add(activity.id); else next.delete(activity.id)
                            setSelectedActivities(next)
                          }}
                          aria-label={t('common.selectRow', { name: activity.title })}
                        />
                      </td>

                      {/* Row # */}
                      <td className="px-2 py-3 text-xs text-[#777268] dark:text-[#768292] font-mono">
                        {startIndex + idx + 1}
                      </td>

                      {/* Source — badge only, no record name below */}
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${SOURCE_BADGE[activitySource(activity)] ?? 'bg-gray-100 dark:bg-[#1a2230] text-[#6c6760] dark:text-[#9aa4b2]'}`}>
                          {t(sourceLabelKey(activitySource(activity)))}
                        </span>
                      </td>

                      {/* User / Assignee */}
                      <td className="px-4 py-3 text-sm text-[#6c6760] dark:text-[#9aa4b2] whitespace-nowrap">
                        {activity.assigned_rep || t('activities.noAssignee')}
                      </td>

                      {/* Customer — clickable when link is available */}
                      <td className="px-4 py-3 max-w-[160px]">
                        {custLink ? (
                          <button
                            onClick={() => navigate(custLink)}
                            className="text-sm text-[#4338ca] dark:text-[#a5b4fc] hover:underline line-clamp-1 text-left"
                          >
                            {custName}
                          </button>
                        ) : (
                          <span className="text-sm text-[#211f1b] dark:text-[#e8ebf0] line-clamp-1">{custName}</span>
                        )}
                      </td>

                      {/* Details: type icon + title */}
                      <td className="px-4 py-3 max-w-[220px]">
                        <div className="flex items-start gap-2">
                          <div
                            className="mt-0.5 w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
                            style={{ background: (TYPE_COLORS[activity.type] ?? '#6c6760') + '18' }}
                          >
                            <ActivityTypeIcon type={activity.type} size={13} />
                          </div>
                          {activity.type === 'approval' ? (
                            (() => { const { docType, code, total } = parseApprovalTitle(activity.title); return (
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0] line-clamp-1">
                                  {approvalRequestLabel(t, docType)} · {code}
                                </p>
                                <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
                                  {t('activityType.approval')} · {total.toLocaleString()}
                                </p>
                              </div>
                            )})()
                          ) : (
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0] line-clamp-1">{activity.title}</p>
                              <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t(`activityType.${activity.type}`)}</p>
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Created date */}
                      <td className="px-4 py-3 text-xs text-[#6c6760] dark:text-[#9aa4b2] whitespace-nowrap">
                        {activity.created_at ? new Date(activity.created_at).toLocaleDateString() : '—'}
                      </td>

                      {/* Date column — due_date for planned tabs, completed_at for logs */}
                      <td className={`px-4 py-3 text-xs font-medium whitespace-nowrap ${isLogsTab ? 'text-emerald-600 dark:text-emerald-400' : dateColor}`}>
                        {dateStr
                          ? new Date(dateStr + 'T00:00:00').toLocaleDateString()
                          : <span className="text-[#777268] dark:text-[#768292]">{t('activities.noDueDate')}</span>
                        }
                        {isActOverdue && (
                          <div className="text-[10px] font-semibold text-red-500 dark:text-red-400 mt-0.5">{t('pipeline.actOverdue')}</div>
                        )}
                        {isActToday && (
                          <div className="text-[10px] font-semibold text-amber-500 dark:text-amber-400 mt-0.5">{t('pipeline.actToday')}</div>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        {activity.type === 'approval' ? (
                          /* Approval rows: Approve/Reject (managers+) when pending;
                             the recorded outcome once completed. */
                          isLogsTab ? (
                            <span className={`text-xs font-medium whitespace-nowrap ${
                              (activity.outcome_notes || '').startsWith('Approved')
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-red-500 dark:text-red-400'
                            }`}>
                              {(activity.outcome_notes || '').startsWith('Approved')
                                ? `✓ ${t('activityChatter.approvalApprove')}`
                                : `✗ ${t('activityChatter.approvalReject')}`}
                            </span>
                          ) : canApprove ? (
                            <div className="flex items-center gap-3 flex-wrap">
                              <button
                                onClick={() => handleApproveActivity(activity)}
                                className="text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline whitespace-nowrap"
                              >
                                ✓ {t('activityChatter.approvalApprove')}
                              </button>
                              <button
                                onClick={() => handleRejectActivity(activity)}
                                className="text-xs font-medium text-red-500 dark:text-red-400 hover:underline whitespace-nowrap"
                              >
                                ✗ {t('activityChatter.approvalReject')}
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-[#777268] dark:text-[#768292] italic whitespace-nowrap">
                              {t('activityChatter.pendingApproval')}
                            </span>
                          )
                        ) : isLogsTab ? (
                          canEdit ? (
                            <button
                              onClick={() => handleReopen(activity.id)}
                              className="text-xs font-medium text-[#4338ca] dark:text-[#a5b4fc] hover:underline whitespace-nowrap"
                            >
                              ↩ {t('activities.reopen')}
                            </button>
                          ) : (
                            <span className="text-xs text-[#777268] dark:text-[#768292]">—</span>
                          )
                        ) : isRescheduling ? (
                          <div className="flex items-center gap-2 flex-wrap">
                            <input
                              type="date"
                              value={rescheduleDate}
                              onChange={(e) => setRescheduleDate(e.target.value)}
                              className="px-2 py-1 text-xs border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
                            />
                            <button onClick={handleReschedule} className="text-xs text-[#4338ca] dark:text-[#a5b4fc] font-medium hover:underline">
                              {t('common.save')}
                            </button>
                            <button onClick={() => setReschedulingId(null)} className="text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:underline">
                              {t('common.cancel')}
                            </button>
                          </div>
                        ) : canEdit ? (
                          <div className="flex items-center gap-3 flex-wrap">
                            <button
                              onClick={() => handleMarkDone(activity.id)}
                              className="text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline whitespace-nowrap"
                            >
                              ✓ {t('activityChatter.markDone')}
                            </button>
                            <button
                              onClick={() => {
                                setReschedulingId(activity.id)
                                setRescheduleDate(activity.due_date?.split('T')[0] ?? '')
                              }}
                              className="text-xs font-medium text-[#4338ca] dark:text-[#a5b4fc] hover:underline whitespace-nowrap"
                            >
                              {t('activityChatter.reschedule')}
                            </button>
                            <button
                              onClick={() => handleCancel(activity.id)}
                              className="text-xs font-medium text-red-500 dark:text-red-400 hover:underline whitespace-nowrap"
                            >
                              {t('activityChatter.cancelActivity')}
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-[#777268] dark:text-[#768292]">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination footer */}
        {totalPages > 1 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-3 border-t border-[#e6e9ef] dark:border-[#212a38]">
            <div className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
              {t('activities.showingRange', { from: startIndex + 1, to: endIndex, total: filtered.length })}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage === 1}
                className="px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {t('common.previous')}
              </button>
              <div className="flex items-center gap-1">{renderPageNumbers()}</div>
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
      {confirmDialog}
    </div>
  )
}
