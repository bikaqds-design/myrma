import React, { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { useURLTab } from '../../hooks/useURLTab'
import { canDo } from '../../lib/permissions'
import { Button, PageHeader } from '../../components/ui'
import { safeStorage } from '../../lib/safeStorage'
import { PageSkeleton } from '../../components/Skeleton'
import { CreateDocumentModal, CreateStandaloneCreditNoteModal } from './_modals'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'

// ── Document type badges ─────────────────────────────────────────────────────
const DOC_TYPE_BADGE = {
  quotation:   'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400',
  sales_order: 'bg-teal-100 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400',
  invoice:     'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  credit_note: 'bg-rose-100 dark:bg-rose-900/20 text-rose-700 dark:text-rose-400',
}

const DOC_TYPE_LABEL_KEY = {
  quotation:   'salesDocuments.typeQuotation',
  sales_order: 'salesDocuments.typeSalesOrder',
  invoice:     'salesDocuments.typeInvoice',
  credit_note: 'salesDocuments.typeCreditNote',
}

// Status pill colors — one map covering every status across all four document
// types (plus the invoice payment_status values).
const STATUS_PILL = {
  draft:     'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  sent:      'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  accepted:  'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  confirmed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  posted:    'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  delivered: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  issued:    'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  applied:   'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  paid:      'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  partial:   'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  expired:   'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  declined:  'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  voided:    'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  reversed:  'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  cancelled: 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#4a5568]',
  unpaid:    'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
}

function statusPillCls(status) {
  return STATUS_PILL[status] ?? STATUS_PILL.draft
}
function statusLabel(status, t) {
  const key = `salesDocuments.st_${status}`
  const label = t(key)
  return label === key ? status : label
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
        <svg className="w-3.5 h-3.5 text-gray-300 dark:text-[#4a5568] ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
      )}
    </button>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function SalesDocuments({ currentUserRole, currentUserEmail, currentUserPermissions }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canCreate = canDo(currentUserRole, currentUserPermissions, 'deals', 'create')

  const [tab, setTab] = useURLTab('tab', 'all')

  // "New" dropdown + active create modal
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [createType, setCreateType] = useState(null)
  const newMenuRef = useRef(null)

  // Row selection (keyed by `${doc_type}-${id}` since ids are unique per table)
  const [selectedKeys, setSelectedKeys] = useState(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const rowKey = (d) => `${d.doc_type}-${d.id}`

  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('')
  const [filterRep, setFilterRep] = useState('')

  const [sortConfig, setSortConfig] = useState(() =>
    safeStorage.get('salesDocsSortConfig', { key: 'created_at', direction: 'desc' })
  )

  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(() => safeStorage.get('salesDocsPerPage', 25))
  const [jumpToPage, setJumpToPage] = useState('')

  // ── Data ────────────────────────────────────────────────────────────────────
  const { data: documents = EMPTY_ARRAY, isLoading } = useQuery({
    queryKey: ['sales-documents'],
    queryFn: () => db.salesDocuments.listAll(),
    staleTime: 30_000,
  })
  const { data: customers = EMPTY_ARRAY } = useQuery({
    queryKey: ['customers'],
    queryFn: () => db.customers.list(),
    staleTime: 60_000,
  })
  const { data: products = EMPTY_ARRAY } = useQuery({
    queryKey: ['products'],
    queryFn: () => db.products.list(),
    staleTime: 60_000,
    enabled: canCreate,
  })
  const { data: usersList = EMPTY_ARRAY } = useQuery({
    queryKey: ['users'],
    queryFn: () => db.userRoles.listAllRoles(),
    staleTime: 5 * 60_000,
    enabled: canCreate,
  })
  const salesReps = useMemo(
    () => usersList.filter((u) => ['sales_rep', 'manager', 'admin', 'super_admin'].includes(u.role)),
    [usersList]
  )

  const customerMap = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c])), [customers])
  const customerName = React.useCallback((id) => {
    const c = customerMap[id]
    return c ? (c.company_name || c.contact_person || '—') : '—'
  }, [customerMap])

  // ── Effects ─────────────────────────────────────────────────────────────────
  useEffect(() => { safeStorage.set('salesDocsPerPage', itemsPerPage) }, [itemsPerPage])
  useEffect(() => { safeStorage.set('salesDocsSortConfig', sortConfig) }, [sortConfig])
  useEffect(() => { setCurrentPage(1) }, [search, filterStatus, filterRep, tab, itemsPerPage, sortConfig])
  useEffect(() => { setSelectedKeys(new Set()) }, [tab])
  useEffect(() => {
    const handler = (e) => { if (!newMenuRef.current?.contains(e.target)) setNewMenuOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleCreated = () => {
    setCreateType(null)
    queryClient.invalidateQueries({ queryKey: ['sales-documents'] })
  }
  const CREATE_OPTIONS = [
    { type: 'quotation', label: t('salesDocuments.newQuotation') },
    { type: 'sales_order', label: t('salesDocuments.newSalesOrder') },
    { type: 'invoice', label: t('salesDocuments.newInvoice') },
    { type: 'credit_note', label: t('salesDocuments.newCreditNote') },
  ]

  const handleSort = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  // ── Tab counts (active set per type; archived counted separately) ────────────
  const countByType = useMemo(() => {
    const c = { all: 0, quotation: 0, sales_order: 0, invoice: 0, credit_note: 0, archive: 0 }
    for (const d of documents) {
      if (d.archived) { c.archive += 1; continue }
      c.all += 1
      c[d.doc_type] = (c[d.doc_type] ?? 0) + 1
    }
    return c
  }, [documents])

  // ── Filtering ────────────────────────────────────────────────────────────────
  // Archived documents live only in the Archive tab; every other tab shows the
  // active (non-archived) set.
  const tabFiltered = useMemo(() => {
    if (tab === 'archive') return documents.filter((d) => d.archived)
    const active = documents.filter((d) => !d.archived)
    return tab === 'all' ? active : active.filter((d) => d.doc_type === tab)
  }, [documents, tab])

  const allStatuses = useMemo(
    () => [...new Set(tabFiltered.map((d) => d.doc_status).filter(Boolean))].sort(),
    [tabFiltered]
  )
  const allReps = useMemo(
    () => [...new Set(documents.map((d) => d.assigned_rep).filter(Boolean))].sort(),
    [documents]
  )

  const filtered = useMemo(() => {
    let f = tabFiltered
    if (search) {
      const q = search.toLowerCase()
      f = f.filter((d) =>
        (d.doc_code ?? '').toLowerCase().includes(q) ||
        customerName(d.customer_id).toLowerCase().includes(q) ||
        (d.assigned_rep ?? '').toLowerCase().includes(q)
      )
    }
    if (filterStatus) f = f.filter((d) => d.doc_status === filterStatus)
    if (filterRep)    f = f.filter((d) => d.assigned_rep === filterRep)

    f = [...f].sort((a, b) => {
      let aVal, bVal
      if (sortConfig.key === 'total') {
        aVal = Number(a.total) || 0; bVal = Number(b.total) || 0
      } else if (sortConfig.key === 'created_at' || sortConfig.key === 'type_specific_date') {
        aVal = new Date(a[sortConfig.key] || 0).getTime()
        bVal = new Date(b[sortConfig.key] || 0).getTime()
      } else if (sortConfig.key === 'customer') {
        aVal = customerName(a.customer_id).toLowerCase(); bVal = customerName(b.customer_id).toLowerCase()
      } else {
        aVal = (a[sortConfig.key] ?? '').toString().toLowerCase()
        bVal = (b[sortConfig.key] ?? '').toString().toLowerCase()
      }
      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })
    return f
  }, [tabFiltered, search, filterStatus, filterRep, sortConfig, customerName])

  const activeFilterCount = [filterStatus, filterRep].filter(Boolean).length

  // ── Pagination ───────────────────────────────────────────────────────────────
  const totalPages = Math.ceil(filtered.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex   = Math.min(startIndex + itemsPerPage, filtered.length)
  const paginated  = filtered.slice(startIndex, endIndex)

  const handlePageChange = (page) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }
  const handleJumpToPage = () => {
    const n = parseInt(jumpToPage)
    if (n >= 1 && n <= totalPages) { handlePageChange(n); setJumpToPage('') }
  }
  const renderPageNumbers = () => {
    const pages = []
    if (totalPages <= 7) { for (let i = 1; i <= totalPages; i++) pages.push(i) }
    else if (currentPage <= 4) { for (let i = 1; i <= 5; i++) pages.push(i); pages.push('...'); pages.push(totalPages) }
    else if (currentPage >= totalPages - 3) { pages.push(1); pages.push('...'); for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i) }
    else { pages.push(1); pages.push('...'); for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i); pages.push('...'); pages.push(totalPages) }
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

  // ── Tab config ───────────────────────────────────────────────────────────────
  const TABS = [
    { id: 'all',         label: t('salesDocuments.tabAll'),         count: countByType.all },
    { id: 'quotation',   label: t('salesDocuments.tabQuotations'),  count: countByType.quotation },
    { id: 'sales_order', label: t('salesDocuments.tabSalesOrders'), count: countByType.sales_order },
    { id: 'invoice',     label: t('salesDocuments.tabInvoices'),    count: countByType.invoice },
    { id: 'credit_note', label: t('salesDocuments.tabCreditNotes'), count: countByType.credit_note },
    { id: 'archive',     label: t('salesDocuments.tabArchive'),     count: countByType.archive },
  ]

  const isArchiveTab = tab === 'archive'
  const showTypeCol = tab === 'all' || isArchiveTab
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')

  // ── Selection ────────────────────────────────────────────────────────────────
  const allPageSelected = paginated.length > 0 && paginated.every((d) => selectedKeys.has(rowKey(d)))
  const toggleAll = (checked) => {
    const next = new Set(selectedKeys)
    paginated.forEach((d) => { if (checked) next.add(rowKey(d)); else next.delete(rowKey(d)) })
    setSelectedKeys(next)
  }
  const toggleRow = (d, checked) => {
    const next = new Set(selectedKeys)
    if (checked) next.add(rowKey(d)); else next.delete(rowKey(d))
    setSelectedKeys(next)
  }
  const selectedRows = filtered.filter((d) => selectedKeys.has(rowKey(d)))

  // ── Export (XLSX) ────────────────────────────────────────────────────────────
  const exportDocs = (rows) => {
    if (rows.length === 0) { toast.error(t('salesDocuments.exportEmpty')); return }
    const data = rows.map((d) => ({
      [t('salesDocuments.colType')]: t(DOC_TYPE_LABEL_KEY[d.doc_type]),
      [t('salesDocuments.colCode')]: d.doc_code || '',
      [t('salesDocuments.colCustomer')]: customerName(d.customer_id),
      [t('salesDocuments.colRep')]: d.assigned_rep || '',
      [t('salesDocuments.colStatus')]: statusLabel(d.doc_status, t),
      [t('salesDocuments.colTotal')]: Number(d.total) || 0,
      [t('salesDocuments.colDate')]: d.type_specific_date ? new Date(d.type_specific_date).toLocaleDateString() : '',
      [t('salesDocuments.colCreated')]: new Date(d.created_at).toLocaleDateString(),
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, t('salesDocuments.title'))
    XLSX.writeFile(wb, `sales-documents-${new Date().toISOString().slice(0, 10)}.xlsx`)
    toast.success(t('salesDocuments.exportSuccess', { count: rows.length }))
  }

  // ── Bulk archive / restore ───────────────────────────────────────────────────
  // Documents are never deleted; archiving moves them to the Archive tab and
  // restoring brings them back. Intended for admins/managers once roles return.
  const handleBulkArchive = async (archived) => {
    if (selectedRows.length === 0) return
    const confirmKey = archived ? 'salesDocuments.bulkArchiveConfirm' : 'salesDocuments.bulkRestoreConfirm'
    if (!window.confirm(t(confirmKey, { count: selectedRows.length }))) return
    setBulkBusy(true)
    let done = 0, failed = 0
    for (const d of selectedRows) {
      try { await db.salesDocuments.setArchived(d.doc_type, d.id, archived, currentUserEmail); done++ }
      catch { failed++ }
    }
    setBulkBusy(false)
    setSelectedKeys(new Set())
    queryClient.invalidateQueries({ queryKey: ['sales-documents'] })
    const resultKey = archived ? 'salesDocuments.bulkArchiveResult' : 'salesDocuments.bulkRestoreResult'
    toast.success(t(resultKey, { done, failed }))
  }

  if (isLoading) return <PageSkeleton cols={9} />

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('salesDocuments.title')}
        subtitle={t('salesDocuments.subtitle', { count: documents.length })}
      >
        <Button variant="secondary" onClick={() => exportDocs(filtered)}>
          <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {t('salesDocuments.export')}
        </Button>
        {canCreate && (
          <div ref={newMenuRef} className="relative">
            <Button onClick={() => setNewMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={newMenuOpen}>
              + {t('salesDocuments.newDocument')}
              <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Button>
            {newMenuOpen && (
              <div role="menu" className="absolute right-0 mt-1 w-48 z-30 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-[#e6e9ef] dark:border-[#212a38] py-1">
                {CREATE_OPTIONS.map((o) => (
                  <button
                    key={o.type}
                    role="menuitem"
                    onClick={() => { setNewMenuOpen(false); setCreateType(o.type) }}
                    className="w-full px-3 py-2 text-left text-sm text-[#211f1b] dark:text-[#e8ebf0] hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520]"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </PageHeader>

      {createType && createType !== 'credit_note' && (
        <CreateDocumentModal
          docType={createType}
          customers={customers}
          products={products}
          salesReps={salesReps}
          currentUserEmail={currentUserEmail}
          onClose={() => setCreateType(null)}
          onSaved={handleCreated}
        />
      )}

      {createType === 'credit_note' && (
        <CreateStandaloneCreditNoteModal
          customers={customers}
          products={products}
          currentUserEmail={currentUserEmail}
          onClose={() => setCreateType(null)}
          onCreated={() => {
            handleCreated()
          }}
        />
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#e6e9ef] dark:border-[#212a38] overflow-x-auto">
        {TABS.map(({ id, label, count }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${
              tab === id
                ? 'border-[#4338ca] dark:border-[#a5b4fc] text-[#4338ca] dark:text-[#a5b4fc]'
                : 'border-transparent text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]'
            }`}
          >
            {label}
            {count > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded-full font-medium bg-[#f0f2f6] dark:bg-[#1a2230] text-[#6c6760] dark:text-[#9aa4b2]">
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Search + filters */}
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] shadow-sm">
        <div className="px-5 py-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 max-w-md">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('salesDocuments.searchPlaceholder')}
                  className="w-full pl-9 pr-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#a09d99] dark:placeholder:text-[#4a5568]"
                />
                <svg className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <button
                onClick={() => setShowFilters(!showFilters)}
                aria-expanded={showFilters}
                aria-controls="sales-docs-filter-panel"
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
              <div id="sales-docs-filter-panel" className="p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
                <div className="flex flex-wrap gap-3">
                  <select
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                    className="px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
                  >
                    <option value="">{t('salesDocuments.allStatuses')}</option>
                    {allStatuses.map((s) => <option key={s} value={s}>{statusLabel(s, t)}</option>)}
                  </select>
                  <select
                    value={filterRep}
                    onChange={(e) => setFilterRep(e.target.value)}
                    className="px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
                  >
                    <option value="">{t('salesDocuments.allReps')}</option>
                    {allReps.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  {activeFilterCount > 0 && (
                    <button
                      onClick={() => { setFilterStatus(''); setFilterRep('') }}
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
      {selectedKeys.size > 0 && (
        <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-[#4338ca]/20 dark:border-[#a5b4fc]/20 rounded-[14px] px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-[#4338ca] dark:text-[#a5b4fc]">
            {selectedKeys.size} {t('common.selected')}
          </span>
          <div className="w-px h-5 bg-[#4338ca]/20 dark:bg-[#a5b4fc]/20" />
          <button
            onClick={() => exportDocs(selectedRows)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-[#121823] text-[#4338ca] dark:text-[#a5b4fc] text-sm hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors border border-[#4338ca]/20 dark:border-[#a5b4fc]/20"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {t('salesDocuments.exportSelected')}
          </button>
          {isArchiveTab ? (
            <button
              onClick={() => handleBulkArchive(false)}
              disabled={bulkBusy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 text-sm hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-colors border border-emerald-200 dark:border-emerald-800 disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v6h6M3 13a9 9 0 102.45-6.36L3 9" />
              </svg>
              {t('salesDocuments.restoreSelected')}
            </button>
          ) : (
            <button
              onClick={() => handleBulkArchive(true)}
              disabled={bulkBusy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 text-sm hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors border border-amber-200 dark:border-amber-800 disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
              </svg>
              {t('salesDocuments.archiveSelected')}
            </button>
          )}
          <button
            onClick={() => setSelectedKeys(new Set())}
            className="ml-auto text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]"
          >
            {t('common.clear')}
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
        <div className="px-5 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-[#e6e9ef] dark:border-[#212a38]">
          <span className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
            {t('salesDocuments.showingRange', {
              from: filtered.length === 0 ? 0 : startIndex + 1,
              to: endIndex,
              total: filtered.length,
            })}
          </span>
          <div className="flex items-center gap-2">
            <label className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('common.itemsPerPage')}:</label>
            <select
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
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
                <th className="pl-4 pr-2 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={(e) => toggleAll(e.target.checked)}
                    className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500"
                    aria-label={t('common.selectAll')}
                  />
                </th>
                <th className="px-2 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase w-10">#</th>
                {showTypeCol && (
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                    <SortableHeader label={t('salesDocuments.colType')} sortKey="doc_type" sortConfig={sortConfig} onSort={handleSort} />
                  </th>
                )}
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('salesDocuments.colCode')} sortKey="doc_code" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('salesDocuments.colCustomer')} sortKey="customer" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('salesDocuments.colRep')} sortKey="assigned_rep" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('salesDocuments.colStatus')} sortKey="doc_status" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('salesDocuments.colTotal')} sortKey="total" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('salesDocuments.colDate')} sortKey="type_specific_date" sortConfig={sortConfig} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                  <SortableHeader label={t('salesDocuments.colCreated')} sortKey="created_at" sortConfig={sortConfig} onSort={handleSort} />
                </th>
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr>
                  <td colSpan={showTypeCol ? 10 : 9}>
                    <div className="py-16 flex flex-col items-center text-center">
                      <svg className="w-12 h-12 text-[#a09d99] dark:text-[#4a5568] mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <p className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t(isArchiveTab ? 'salesDocuments.noArchive' : 'salesDocuments.noDocuments')}</p>
                      <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">{t(isArchiveTab ? 'salesDocuments.noArchiveHint' : 'salesDocuments.noDocumentsHint')}</p>
                    </div>
                  </td>
                </tr>
              ) : (
                paginated.map((doc, idx) => (
                  <tr
                    key={`${doc.doc_type}-${doc.id}`}
                    className={`border-t border-[#e6e9ef] dark:border-[#212a38] hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] transition-colors ${selectedKeys.has(rowKey(doc)) ? 'bg-indigo-50/50 dark:bg-indigo-900/10' : ''}`}
                  >
                    <td className="pl-4 pr-2 py-3">
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(rowKey(doc))}
                        onChange={(e) => toggleRow(doc, e.target.checked)}
                        className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500"
                        aria-label={t('common.selectRow', { name: doc.doc_code || doc.doc_type })}
                      />
                    </td>
                    <td className="px-2 py-3 text-xs text-[#a09d99] dark:text-[#4a5568] font-mono">{startIndex + idx + 1}</td>
                    {showTypeCol && (
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${DOC_TYPE_BADGE[doc.doc_type]}`}>
                          {t(DOC_TYPE_LABEL_KEY[doc.doc_type])}
                        </span>
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => navigate(`/sales/${doc.doc_type}/${doc.id}`)}
                        className="font-mono text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                      >
                        {doc.doc_code || t('salesDocuments.viewDocument')}
                      </button>
                    </td>
                    <td className="px-4 py-3 max-w-[180px]">
                      <button
                        onClick={() => navigate(`/customers/${doc.customer_id}`)}
                        className="text-sm text-[#4338ca] dark:text-[#a5b4fc] hover:underline line-clamp-1 text-left"
                      >
                        {customerName(doc.customer_id)}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6c6760] dark:text-[#9aa4b2] whitespace-nowrap">
                      {doc.assigned_rep || t('salesDocuments.unassigned')}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${statusPillCls(doc.doc_status)}`}>
                          {statusLabel(doc.doc_status, t)}
                        </span>
                        {doc.doc_type === 'invoice' && doc.payment_status && (
                          <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${statusPillCls(doc.payment_status)}`}>
                            {statusLabel(doc.payment_status, t)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] whitespace-nowrap">
                      {(Number(doc.total) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-3 text-xs text-[#6c6760] dark:text-[#9aa4b2] whitespace-nowrap">
                      {fmtDate(doc.type_specific_date)}
                    </td>
                    <td className="px-4 py-3 text-xs text-[#6c6760] dark:text-[#9aa4b2] whitespace-nowrap">
                      {fmtDate(doc.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-3 border-t border-[#e6e9ef] dark:border-[#212a38]">
            <div className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
              {t('salesDocuments.showingRange', { from: startIndex + 1, to: endIndex, total: filtered.length })}
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
    </div>
  )
}
