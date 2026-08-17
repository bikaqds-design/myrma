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
import ExportMenu from '../../components/ExportMenu'
import PurchasingGraphView from './PurchasingGraphView'
import PurchasingPivotView from './PurchasingPivotView'
import { DOC_TYPE_BADGE, DOC_TYPE_LABEL_KEY, statusLabel, statusPillCls } from './_shared'
import { CreateVendorModal, VendorEditModal, CreatePurchaseOrderModal, VendorInvoiceFormModal } from './_modals'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { useConfirm } from '../../hooks/useConfirm'

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
        <svg className="w-3.5 h-3.5 text-gray-300 dark:text-[#a4acb7] ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
      )}
    </button>
  )
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <div className="relative flex-1 max-w-md">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        // Named from the placeholder each caller passes — same reason as
        // InvToolbar's search: a placeholder is not an accessible name.
        aria-label={placeholder}
        className="w-full pl-9 pr-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#746f65] dark:placeholder:text-[#a4acb7]"
      />
      <svg className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    </div>
  )
}

/**
 * The "showing 1–25 of 60" strip above a table, with the page-size picker.
 * Extracted when the Vendors tab gained paging, so the two tables cannot drift.
 */
function ListRangeBar({ from, to, total, itemsPerPage, onItemsPerPage }) {
  const { t } = useTranslation()
  return (
    <div className="px-5 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-[#e6e9ef] dark:border-[#212a38]">
      <span className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
        {t('purchasing.showingRange', { from, to, total })}
      </span>
      <div className="flex items-center gap-2">
        <label className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('common.itemsPerPage')}:</label>
        <select
          aria-label={t('common.itemsPerPage')}
          value={itemsPerPage}
          onChange={(e) => onItemsPerPage(parseInt(e.target.value))}
          className="px-3 py-1 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
        >
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>
    </div>
  )
}

/** Page buttons + jump-to-page footer, shared by the documents and Vendors tabs. */
function PaginationBar({
  currentPage, totalPages, from, to, total,
  onPage, jumpToPage, setJumpToPage, onJump, renderPageNumbers,
}) {
  const { t } = useTranslation()
  if (totalPages <= 1) return null
  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-3 border-t border-[#e6e9ef] dark:border-[#212a38]">
      <div className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
        {t('purchasing.showingRange', { from, to, total })}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(currentPage - 1)}
          disabled={currentPage === 1}
          className="px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t('common.previous')}
        </button>
        <div className="flex items-center gap-1">{renderPageNumbers()}</div>
        <button
          onClick={() => onPage(currentPage + 1)}
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
          onKeyDown={(e) => e.key === 'Enter' && onJump()}
          placeholder={currentPage.toString()}
          className="w-20 px-3 py-1 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
        />
        <button
          onClick={onJump}
          className="px-3 py-1 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] rounded-lg hover:opacity-90 text-sm transition-opacity"
        >
          {t('common.go')}
        </button>
      </div>
    </div>
  )
}

// ─── Purchasing — Vendor(=Brand) -> Purchase Order -> Vendor Invoice -> Receive ─
export default function Purchasing({ currentUserRole, currentUserEmail, currentUserPermissions }) {
  const { t } = useTranslation()
  const { confirm, confirmDialog } = useConfirm()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canCreate = canDo(currentUserRole, currentUserPermissions, 'deals', 'create')

  const [tab, setTab] = useURLTab('tab', 'all')
  // 'list' | 'graph' — URL-persisted so a chart can be shared as a link, the
  // same convention Pipeline uses for its ?view= switcher.
  const [view, setView] = useURLTab('view', 'list')

  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [createType, setCreateType] = useState(null)
  const [editVendor, setEditVendor] = useState(null)
  const newMenuRef = useRef(null)

  const [selectedKeys, setSelectedKeys] = useState(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const rowKey = (d) => `${d.doc_type}-${d.id}`

  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('')
  const [filterVendor, setFilterVendor] = useState('')

  const isVendorsTab = tab === 'vendors'

  const [sortConfig, setSortConfig] = useState(() =>
    safeStorage.get('purchasingSortConfig', { key: 'created_at', direction: 'desc' })
  )
  const [vendorSort, setVendorSort] = useState(() =>
    safeStorage.get('purchasingVendorSort', { key: 'brand_name', direction: 'asc' })
  )

  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(() => safeStorage.get('purchasingPerPage', 25))
  const [jumpToPage, setJumpToPage] = useState('')

  // ── Data ────────────────────────────────────────────────────────────────────
  const { data: docsRes, isLoading } = useQuery({
    queryKey: ['purchase-documents'],
    queryFn: () => db.purchaseDocuments.listAll(),
    staleTime: 30_000,
  })
  const documents = useMemo(() => (docsRes?.missing ? [] : (docsRes?.data ?? [])), [docsRes])

  const { data: vendorList = EMPTY_ARRAY } = useQuery({
    queryKey: ['brands-as-vendors'],
    queryFn: () => db.brands.list(),
    staleTime: 60_000,
  })
  const vendorMap = useMemo(() => Object.fromEntries(vendorList.map((v) => [v.id, v])), [vendorList])
  const vendorName = React.useCallback((id) => vendorMap[id]?.brand_name || '—', [vendorMap])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['purchase-documents'] })
  const invalidateVendors = () => queryClient.invalidateQueries({ queryKey: ['brands-as-vendors'] })

  // ── Effects ─────────────────────────────────────────────────────────────────
  useEffect(() => { safeStorage.set('purchasingPerPage', itemsPerPage) }, [itemsPerPage])
  useEffect(() => { safeStorage.set('purchasingSortConfig', sortConfig) }, [sortConfig])
  useEffect(() => { safeStorage.set('purchasingVendorSort', vendorSort) }, [vendorSort])
  useEffect(() => { setCurrentPage(1) }, [search, filterStatus, filterVendor, tab, itemsPerPage, sortConfig, vendorSort])
  // The search box is shared between documents and vendors, and a code that
  // matched a PO will match no vendor. Carrying it across reads as an empty tab.
  useEffect(() => { setSearch('') }, [tab])
  useEffect(() => { setSelectedKeys(new Set()) }, [tab])
  useEffect(() => {
    const handler = (e) => { if (!newMenuRef.current?.contains(e.target)) setNewMenuOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleCreated = (docType, row) => {
    setCreateType(null)
    invalidate()
    if (row?.id) navigate(`/purchasing/${docType}/${row.id}`)
  }

  const handleSort = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  // ── Tab counts ────────────────────────────────────────────────────────────────
  const countByType = useMemo(() => {
    const c = { all: 0, purchase_order: 0, vendor_invoice: 0, archive: 0 }
    for (const d of documents) {
      if (d.archived) { c.archive += 1; continue }
      c.all += 1
      c[d.doc_type] = (c[d.doc_type] ?? 0) + 1
    }
    return c
  }, [documents])

  const tabFiltered = useMemo(() => {
    if (tab === 'archive') return documents.filter((d) => d.archived)
    if (tab === 'vendors') return []
    const active = documents.filter((d) => !d.archived)
    return tab === 'all' ? active : active.filter((d) => d.doc_type === tab)
  }, [documents, tab])

  const allStatuses = useMemo(
    () => [...new Set(tabFiltered.map((d) => d.doc_status).filter(Boolean))].sort(),
    [tabFiltered]
  )

  const filtered = useMemo(() => {
    let f = tabFiltered
    if (search) {
      const q = search.toLowerCase()
      f = f.filter((d) => (d.doc_code ?? '').toLowerCase().includes(q) || vendorName(d.vendor_id).toLowerCase().includes(q))
    }
    if (filterStatus) f = f.filter((d) => d.doc_status === filterStatus)
    if (filterVendor) f = f.filter((d) => d.vendor_id === filterVendor)

    f = [...f].sort((a, b) => {
      let aVal, bVal
      if (sortConfig.key === 'total') {
        aVal = Number(a.total) || 0; bVal = Number(b.total) || 0
      } else if (sortConfig.key === 'created_at' || sortConfig.key === 'type_specific_date') {
        aVal = new Date(a[sortConfig.key] || 0).getTime()
        bVal = new Date(b[sortConfig.key] || 0).getTime()
      } else if (sortConfig.key === 'vendor') {
        aVal = vendorName(a.vendor_id).toLowerCase(); bVal = vendorName(b.vendor_id).toLowerCase()
      } else {
        aVal = (a[sortConfig.key] ?? '').toString().toLowerCase()
        bVal = (b[sortConfig.key] ?? '').toString().toLowerCase()
      }
      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })
    return f
  }, [tabFiltered, search, filterStatus, filterVendor, sortConfig, vendorName])

  const activeFilterCount = [filterStatus, filterVendor].filter(Boolean).length

  // Vendors are a different shape to documents — no status, no total, no dates —
  // so they get their own search and sort rather than being forced through the
  // document pipeline above. They share the paging state below, since only one
  // tab is ever on screen.
  const vendorFiltered = useMemo(() => {
    let f = vendorList
    if (search) {
      const q = search.toLowerCase()
      f = f.filter((v) =>
        [v.brand_name, v.contact_person, v.email, v.phone].some((field) =>
          (field ?? '').toLowerCase().includes(q)
        )
      )
    }
    return [...f].sort((a, b) => {
      const aVal = (a[vendorSort.key] ?? '').toString().toLowerCase()
      const bVal = (b[vendorSort.key] ?? '').toString().toLowerCase()
      // Blanks sort last in either direction; a contact-less vendor at the top
      // of an A-Z list is noise, not information.
      if (!aVal && bVal) return 1
      if (aVal && !bVal) return -1
      if (aVal < bVal) return vendorSort.direction === 'asc' ? -1 : 1
      if (aVal > bVal) return vendorSort.direction === 'asc' ? 1 : -1
      return 0
    })
  }, [vendorList, search, vendorSort])

  const handleVendorSort = (key) => {
    setVendorSort((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  // ── Pagination ───────────────────────────────────────────────────────────────
  const rows = isVendorsTab ? vendorFiltered : filtered
  const totalPages = Math.ceil(rows.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = Math.min(startIndex + itemsPerPage, rows.length)
  const paginated = rows.slice(startIndex, endIndex)
  const rangeFrom = rows.length === 0 ? 0 : startIndex + 1

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

  const TABS = [
    { id: 'all', label: t('purchasing.tabAll'), count: countByType.all },
    { id: 'purchase_order', label: t('purchasing.tabPurchaseOrders'), count: countByType.purchase_order },
    { id: 'vendor_invoice', label: t('purchasing.tabVendorInvoices'), count: countByType.vendor_invoice },
    { id: 'archive', label: t('purchasing.tabArchive'), count: countByType.archive },
    { id: 'vendors', label: t('purchasing.tabVendors'), count: vendorList.length },
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
    if (rows.length === 0) { toast.error(t('purchasing.exportEmpty')); return }
    const data = rows.map((d) => ({
      [t('purchasing.colType')]: t(DOC_TYPE_LABEL_KEY[d.doc_type]),
      [t('purchasing.colCode')]: d.doc_code || '',
      [t('purchasing.colVendor')]: vendorName(d.vendor_id),
      [t('purchasing.colStatus')]: statusLabel(d.doc_status, t),
      [t('purchasing.colTotal')]: Number(d.total) || 0,
      [t('purchasing.colDate')]: d.type_specific_date ? new Date(d.type_specific_date).toLocaleDateString() : '',
      [t('purchasing.colCreated')]: new Date(d.created_at).toLocaleDateString(),
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, t('purchasing.title'))
    XLSX.writeFile(wb, `purchasing-${new Date().toISOString().slice(0, 10)}.xlsx`)
    toast.success(t('purchasing.exportSuccess', { count: rows.length }))
  }

  // ── Bulk archive / restore ───────────────────────────────────────────────────
  const handleBulkArchive = async (archived) => {
    if (selectedRows.length === 0) return
    const confirmKey = archived ? 'purchasing.bulkArchiveConfirm' : 'purchasing.bulkRestoreConfirm'
    const titleKey = archived ? 'purchasing.bulkArchiveTitle' : 'purchasing.bulkRestoreTitle'
    const count = selectedRows.length
    confirm({
      title: t(titleKey, { count }),
      message: t(confirmKey, { count }),
      confirmLabel: archived ? t('common.archive') : t('common.restore'),
      onConfirm: () => void runBulkArchive(archived),
    })
  }

  const runBulkArchive = async (archived) => {
    setBulkBusy(true)
    let done = 0, failed = 0
    for (const d of selectedRows) {
      try { await db.purchaseDocuments.setArchived(d.doc_type, d.id, archived, currentUserEmail); done++ }
      catch { failed++ }
    }
    setBulkBusy(false)
    setSelectedKeys(new Set())
    invalidate()
    const resultKey = archived ? 'purchasing.bulkArchiveResult' : 'purchasing.bulkRestoreResult'
    toast.success(t(resultKey, { done, failed }))
  }

  if (isLoading) return <PageSkeleton cols={8} />

  return (
    <div className="space-y-4">
      <PageHeader title={t('purchasing.title')} subtitle={t('purchasing.subtitle', { count: documents.length })}>
        {isVendorsTab ? (
          canCreate && (
            <Button onClick={() => setCreateType('vendor')}>+ {t('purchasing.newVendor')}</Button>
          )
        ) : (
          <>
            {/* View switcher — list is the default; graph answers "where is the
                money going", which the table cannot. Persisted in the URL so a
                chart can be linked to, matching Pipeline's ?view= convention. */}
            <div className="flex items-center gap-1 mr-1">
              <button
                onClick={() => setView('list')}
                title={t('purchasing.viewList')}
                className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
                  view === 'list'
                    ? 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-[#a5b4fc]'
                    : 'text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <button
                onClick={() => setView('graph')}
                title={t('purchasing.viewGraph')}
                className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
                  view === 'graph'
                    ? 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-[#a5b4fc]'
                    : 'text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </button>
              <button
                onClick={() => setView('pivot')}
                title={t('purchasing.viewPivot')}
                className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
                  view === 'pivot'
                    ? 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-[#a5b4fc]'
                    : 'text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h18v18H3V3zm0 6h18M9 9v12M3 15h18" />
                </svg>
              </button>
            </div>
            <ExportMenu
              allRows={documents}
              filteredRows={filtered}
              selectedRows={selectedRows}
              onExport={(rows) => exportDocs(rows)}
              label={t('purchasing.export')}
              ns="purchasing"
            />
            {canCreate && (
              <div ref={newMenuRef} className="relative">
                <Button onClick={() => setNewMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={newMenuOpen}>
                  + {t('purchasing.newDocument')}
                  <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </Button>
                {newMenuOpen && (
                  <div role="menu" className="absolute right-0 mt-1 w-56 z-30 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-[#e6e9ef] dark:border-[#212a38] py-1">
                    <button role="menuitem" onClick={() => { setNewMenuOpen(false); setCreateType('purchase_order') }}
                      className="w-full px-3 py-2 text-left text-sm text-[#211f1b] dark:text-[#e8ebf0] hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520]">
                      {t('purchasing.newPurchaseOrder')}
                    </button>
                    <button role="menuitem" onClick={() => { setNewMenuOpen(false); setCreateType('vendor_invoice') }}
                      className="w-full px-3 py-2 text-left text-sm text-[#211f1b] dark:text-[#e8ebf0] hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520]">
                      {t('purchasing.newVendorInvoice')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </PageHeader>

      {createType === 'vendor' && (
        <CreateVendorModal onClose={() => setCreateType(null)} userEmail={currentUserEmail} onSuccess={invalidateVendors} />
      )}
      {createType === 'purchase_order' && (
        <CreatePurchaseOrderModal
          onClose={() => setCreateType(null)}
          vendors={vendorList}
          userEmail={currentUserEmail}
          onSuccess={(row) => handleCreated('purchase_order', row)}
        />
      )}
      {createType === 'vendor_invoice' && (
        <VendorInvoiceFormModal
          mode="create"
          onClose={() => setCreateType(null)}
          vendors={vendorList}
          userEmail={currentUserEmail}
          onSuccess={(row) => handleCreated('vendor_invoice', row)}
        />
      )}
      {editVendor && (
        <VendorEditModal vendor={editVendor} onClose={() => setEditVendor(null)} userEmail={currentUserEmail} onSuccess={invalidateVendors} />
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

      {isVendorsTab ? (
        <>
        {/* No status or vendor filter here — a vendor has neither, so search is
            the only narrowing that means anything on this tab. */}
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] shadow-sm">
          <div className="px-5 py-4 flex items-center gap-3 flex-wrap">
            <SearchBox value={search} onChange={setSearch} placeholder={t('purchasing.searchVendorsPlaceholder')} />
          </div>
        </div>

        <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
          <ListRangeBar
            from={rangeFrom}
            to={endIndex}
            total={rows.length}
            itemsPerPage={itemsPerPage}
            onItemsPerPage={setItemsPerPage}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  {[
                    { label: t('purchasing.colVendorName'), key: 'brand_name' },
                    { label: t('purchasing.colContactPerson'), key: 'contact_person' },
                    { label: t('common.email'), key: 'email' },
                    { label: t('purchasing.phone'), key: 'phone' },
                    { label: t('purchasing.paymentTerms'), key: 'payment_terms' },
                  ].map(({ label, key }) => (
                    <th key={key} className="px-5 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase tracking-wider">
                      <SortableHeader label={label} sortKey={key} sortConfig={vendorSort} onSort={handleVendorSort} />
                    </th>
                  ))}
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0f2f6] dark:divide-[#1a2230]">
                {paginated.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">
                      {/* Distinguishes "no vendors at all" from "none match the
                          search" — the fix for the latter is to clear the box. */}
                      {vendorList.length === 0 ? t('purchasing.noVendorsYet') : t('purchasing.noVendorsMatch')}
                    </td>
                  </tr>
                ) : (
                  paginated.map((v) => (
                    <tr key={v.id} className="hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230]">
                      <td className="px-5 py-3 font-medium">
                        {/* Name drills into the vendor page; Edit stays a separate
                            action so a quick field change does not need a round trip. */}
                        <button
                          onClick={() => navigate(`/purchasing/vendor/${v.id}`)}
                          className="text-[#4338ca] dark:text-[#a5b4fc] hover:underline text-left"
                        >
                          {v.brand_name}
                        </button>
                      </td>
                      <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{v.contact_person || '—'}</td>
                      <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{v.email || '—'}</td>
                      <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{v.phone || '—'}</td>
                      <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{v.payment_terms || '—'}</td>
                      <td className="px-5 py-3 text-right">
                        <button onClick={() => setEditVendor(v)} className="text-sm text-[#4338ca] dark:text-[#a5b4fc] hover:underline">
                          {t('common.edit')}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <PaginationBar
            currentPage={currentPage}
            totalPages={totalPages}
            from={rangeFrom}
            to={endIndex}
            total={rows.length}
            onPage={handlePageChange}
            jumpToPage={jumpToPage}
            setJumpToPage={setJumpToPage}
            onJump={handleJumpToPage}
            renderPageNumbers={renderPageNumbers}
          />
        </div>
        </>
      ) : (
        <>
          {/* Search + filters */}
          <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] shadow-sm">
            <div className="px-5 py-4">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <SearchBox value={search} onChange={setSearch} placeholder={t('purchasing.searchPlaceholder')} />
                  <button
                    onClick={() => setShowFilters(!showFilters)}
                    aria-expanded={showFilters}
                    aria-controls="purchasing-filter-panel"
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
                  <div id="purchasing-filter-panel" className="p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
                    <div className="flex flex-wrap gap-3">
                      <select
                        value={filterStatus}
                        onChange={(e) => setFilterStatus(e.target.value)}
                        className="px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
                      >
                        <option value="">{t('purchasing.allStatuses')}</option>
                        {allStatuses.map((s) => <option key={s} value={s}>{statusLabel(s, t)}</option>)}
                      </select>
                      <select
                        value={filterVendor}
                        onChange={(e) => setFilterVendor(e.target.value)}
                        className="px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
                      >
                        <option value="">{t('purchasing.allVendors')}</option>
                        {vendorList.map((v) => <option key={v.id} value={v.id}>{v.brand_name}</option>)}
                      </select>
                      {activeFilterCount > 0 && (
                        <button
                          onClick={() => { setFilterStatus(''); setFilterVendor('') }}
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
                {t('purchasing.exportSelected')}
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
                  {t('purchasing.restoreSelected')}
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
                  {t('purchasing.archiveSelected')}
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

          {/* The analytics views replace the table but keep the search/filter bar
              above them — both read from `filtered`, so narrowing the list
              narrows the analysis too. */}
          {view === 'graph' ? (
            <PurchasingGraphView documents={filtered} vendorName={vendorName} />
          ) : view === 'pivot' ? (
            <PurchasingPivotView documents={filtered} vendorName={vendorName} />
          ) : (
          <>
          {/* Table */}
          <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
            <ListRangeBar
              from={rangeFrom}
              to={endIndex}
              total={rows.length}
              itemsPerPage={itemsPerPage}
              onItemsPerPage={setItemsPerPage}
            />

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
                        <SortableHeader label={t('purchasing.colType')} sortKey="doc_type" sortConfig={sortConfig} onSort={handleSort} />
                      </th>
                    )}
                    <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                      <SortableHeader label={t('purchasing.colCode')} sortKey="doc_code" sortConfig={sortConfig} onSort={handleSort} />
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                      <SortableHeader label={t('purchasing.colVendor')} sortKey="vendor" sortConfig={sortConfig} onSort={handleSort} />
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                      <SortableHeader label={t('purchasing.colStatus')} sortKey="doc_status" sortConfig={sortConfig} onSort={handleSort} />
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                      <SortableHeader label={t('purchasing.colTotal')} sortKey="total" sortConfig={sortConfig} onSort={handleSort} />
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                      <SortableHeader label={t('purchasing.colDate')} sortKey="type_specific_date" sortConfig={sortConfig} onSort={handleSort} />
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase">
                      <SortableHeader label={t('purchasing.colCreated')} sortKey="created_at" sortConfig={sortConfig} onSort={handleSort} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.length === 0 ? (
                    <tr>
                      <td colSpan={showTypeCol ? 9 : 8}>
                        <div className="py-16 flex flex-col items-center text-center">
                          <svg className="w-12 h-12 text-[#746f65] dark:text-[#a4acb7] mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          <p className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t(isArchiveTab ? 'purchasing.noArchive' : 'purchasing.noDocumentsYet')}</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    paginated.map((doc, idx) => (
                      <tr
                        key={`${doc.doc_type}-${doc.id}`}
                        className={`border-t border-[#e6e9ef] dark:border-[#212a38] hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] transition-colors cursor-pointer ${selectedKeys.has(rowKey(doc)) ? 'bg-indigo-50/50 dark:bg-indigo-900/10' : ''}`}
                        onClick={() => navigate(`/purchasing/${doc.doc_type}/${doc.id}`)}
                      >
                        <td className="pl-4 pr-2 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedKeys.has(rowKey(doc))}
                            onChange={(e) => toggleRow(doc, e.target.checked)}
                            className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500"
                            aria-label={t('common.selectRow', { name: doc.doc_code || doc.doc_type })}
                          />
                        </td>
                        <td className="px-2 py-3 text-xs text-[#746f65] dark:text-[#a4acb7] font-mono">{startIndex + idx + 1}</td>
                        {showTypeCol && (
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${DOC_TYPE_BADGE[doc.doc_type]}`}>
                              {t(DOC_TYPE_LABEL_KEY[doc.doc_type])}
                            </span>
                          </td>
                        )}
                        <td className="px-4 py-3 font-mono text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc]">
                          {doc.doc_code || t('purchasing.pendingCode')}
                        </td>
                        <td className="px-4 py-3 max-w-[180px] text-sm text-[#211f1b] dark:text-[#e8ebf0] line-clamp-1">
                          {vendorName(doc.vendor_id)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${statusPillCls(doc.doc_status)}`}>
                              {statusLabel(doc.doc_status, t)}
                            </span>
                            {doc.doc_type === 'vendor_invoice' && doc.payment_status && (
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

            <PaginationBar
              currentPage={currentPage}
              totalPages={totalPages}
              from={rangeFrom}
              to={endIndex}
              total={rows.length}
              onPage={handlePageChange}
              jumpToPage={jumpToPage}
              setJumpToPage={setJumpToPage}
              onJump={handleJumpToPage}
              renderPageNumbers={renderPageNumbers}
            />
          </div>
          </>
          )}
        </>
      )}
      {confirmDialog}
    </div>
  )
}
