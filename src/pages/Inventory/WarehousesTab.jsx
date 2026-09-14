import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { safeStorage } from '../../lib/safeStorage'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { Spinner } from '../../components/ui'
import ConfirmDialog from '../../components/ConfirmDialog'
import {
  WAREHOUSE_SQL,
  TICKET_STATUS_CLS,
  STATUS_META,
  RESOLUTION_META,
  StatusBadge,
  ResolutionBadge,
  WarrantyBadge,
  daysSince,
  Pagination,
  InvToolbar,
  InvFilterPanel,
  InvFilterField,
  INV_FILTER_SELECT_CLS,
} from './_shared'
import { TransferModal } from './TransferModal'

const WAREHOUSE_TYPES = ['main', 'branch', 'service_center', 'rma', 'transit', 'virtual']

// ─── Warehouse export helpers ──────────────────────────────────────────────────
// Note: toast messages in these module-level async functions are left hardcoded
// because hooks cannot be used at module scope. Pass `t` as a parameter to translate.
// `units` are v_inventory_units rows, which carry the brand and ticket fields.
async function exportWarehouseExcel(wh, units, t) {
  const XLSX = await import('xlsx')
  const rows = units.map((u, i) => ({
    '#': i + 1,
    'Warehouse Code': wh.code || '',
    Warehouse: wh.name || '',
    Product: u.product_name || '',
    Brand: u.brand_name || '',
    'Serial #': u.serial_number || '',
    Warranty: u.warranty_status || '',
    Status: STATUS_META[u.status]?.label || u.status || '',
    Resolution: RESOLUTION_META[u.resolution_type]?.label || u.resolution_type || '',
    'RMA #': u.rma_number || '',
    Customer: u.ticket_customer_name || '',
    'RMA Status': u.ticket_status || '',
    'Date Added': u.created_date ? new Date(u.created_date).toLocaleDateString() : '',
    Days: daysSince(u.created_date),
  }))
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Units')
  XLSX.writeFile(wb, `${wh.code || wh.name}-${new Date().toISOString().split('T')[0]}.xlsx`)
  toast.success(t ? t('inventory.exportedExcelRows', { count: rows.length }) : `Exported ${rows.length} rows to Excel`)
}

async function exportWarehousePDF(wh, units, t) {
  const { default: jsPDF } = await import('jspdf')
  const date = new Date().toLocaleDateString()
  const rows = units.map((u, i) => [
    i + 1,
    u.product_name || '—',
    u.brand_name || '—',
    u.serial_number || '—',
    u.warranty_status || '—',
    STATUS_META[u.status]?.label || u.status || '—',
    RESOLUTION_META[u.resolution_type]?.label || u.resolution_type || '—',
    u.rma_number || '—',
    u.ticket_customer_name || '—',
    `${daysSince(u.created_date)}d`,
  ])

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
  const pw = doc.internal.pageSize.getWidth()

  doc.setFontSize(16)
  doc.setFont(undefined, 'bold')
  doc.text(`${wh.name}${wh.code ? ` (${wh.code})` : ''}`, 40, 40)
  doc.setFontSize(9)
  doc.setFont(undefined, 'normal')
  doc.setTextColor(120)
  doc.text(
    `${units.length} unit${units.length !== 1 ? 's' : ''} · ${wh.location || ''} · Exported ${date}`,
    40,
    58
  )
  doc.setTextColor(0)

  const cols = [
    '#',
    'Product',
    'Brand',
    'Serial #',
    'Warranty',
    'Status',
    'Resolution',
    'RMA #',
    'Customer',
    'Days',
  ]
  const colW = [20, 110, 70, 70, 55, 65, 75, 80, 100, 35]
  const startY = 75
  const rowH = 16
  const pad = 4

  // header
  doc.setFillColor(240, 240, 245)
  doc.rect(40, startY, pw - 80, rowH, 'F')
  doc.setFontSize(7)
  doc.setFont(undefined, 'bold')
  let x = 40
  cols.forEach((c, i) => {
    doc.text(c, x + pad, startY + 11)
    x += colW[i]
  })

  // rows
  doc.setFont(undefined, 'normal')
  rows.forEach((row, ri) => {
    const y = startY + (ri + 1) * rowH
    if (y > doc.internal.pageSize.getHeight() - 40) {
      doc.addPage()
      // re-draw header on new page
      doc.setFillColor(240, 240, 245)
      doc.rect(40, 40, pw - 80, rowH, 'F')
      doc.setFont(undefined, 'bold')
      let hx = 40
      cols.forEach((c, i) => {
        doc.text(c, hx + pad, 51)
        hx += colW[i]
      })
      doc.setFont(undefined, 'normal')
    }
    const ry = y > doc.internal.pageSize.getHeight() - 40 ? 40 + rowH : y
    if (ri % 2 === 1) {
      doc.setFillColor(250, 250, 252)
      doc.rect(40, ry, pw - 80, rowH, 'F')
    }
    let cx = 40
    row.forEach((cell, i) => {
      const text = String(cell)
      const maxW = colW[i] - pad * 2
      doc.text(doc.splitTextToSize(text, maxW)[0], cx + pad, ry + 11)
      cx += colW[i]
    })
  })

  doc.save(`${wh.code || wh.name}-${new Date().toISOString().split('T')[0]}.pdf`)
  toast.success(t ? t('inventory.pdfSaved') : 'PDF saved')
}

// ─── Warehouses Tab ────────────────────────────────────────────────────────────
export function WarehousesTab({
  unitCounts,
  warehouses,
  whMissing,
  userEmail,
  canManage,
  canTransfer,
  onReload,
}) {
  const { t } = useTranslation()
  const searchRef = useRef(null)
  const [selectedWh, setSelectedWh] = useState(null)
  const [editingWh, setEditingWh] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [showSQL, setShowSQL] = useState(whMissing)
  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(() => safeStorage.get('invWarehousesPerPage', 25))
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    message: '',
    onConfirm: null,
  })
  const openConfirm = (title, message, onConfirm) =>
    setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog((d) => ({ ...d, open: false }))

  // Unit counts per warehouse come from v_warehouse_unit_counts; they were
  // counted from a load of every unit, which the Data API caps. (BUG-066.)
  const unitCountOf = (id) => unitCounts?.[id] ?? 0

  // Group warehouses (Warehouse Module R1): Sellable (main/branch/legacy-null),
  // Other (non-system service_center/rma/transit/virtual), System (the 8
  // protected RMA/transit/virtual locations). System rows show a badge and
  // have no edit/archive actions — they're protected DB-side by a trigger too.
  const groupOf = (wh) => {
    if (wh.is_system) return 'system'
    if (!wh.warehouse_type || wh.warehouse_type === 'main' || wh.warehouse_type === 'branch')
      return 'sellable'
    return 'other'
  }
  const GROUP_LABELS = {
    sellable: t('inventory.whGroupSellable'),
    other: t('inventory.whGroupOther'),
    system: t('inventory.whGroupSystem'),
  }

  const activeFilterCount = [filterType, filterStatus].filter(Boolean).length

  // Filter → order by group → paginate. Group headers are rendered inline as
  // the group changes on the current page, so grouping + pagination coexist.
  const orderedRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matches = warehouses.filter((wh) => {
      const matchSearch =
        !q ||
        [wh.name, wh.code, wh.location, wh.manager].some((v) => (v || '').toLowerCase().includes(q))
      const matchType = !filterType || wh.warehouse_type === filterType
      const matchStatus =
        !filterStatus ||
        (filterStatus === 'active' && wh.is_active) ||
        (filterStatus === 'inactive' && !wh.is_active)
      return matchSearch && matchType && matchStatus
    })
    const order = { sellable: 0, other: 1, system: 2 }
    return [...matches].sort((a, b) => order[groupOf(a)] - order[groupOf(b)])
  }, [warehouses, search, filterType, filterStatus])

  const paginatedRows = useMemo(
    () => orderedRows.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage),
    [orderedRows, currentPage, itemsPerPage]
  )

  useEffect(() => {
    setCurrentPage(1)
  }, [search, filterType, filterStatus, itemsPerPage])
  useEffect(() => {
    safeStorage.set('invWarehousesPerPage', itemsPerPage)
  }, [itemsPerPage])

  const colCount = canManage ? 8 : 7

  // Archive (soft-delete) replaces the old hard delete — calls archive_warehouse
  // (Sprint 8 Phase 8a), which blocks server-side if any live serialized units
  // or bulk quantity still reference this warehouse and surfaces a clean error
  // naming the blocking counts, instead of silently succeeding or hard-deleting
  // rows that other tables still reference.
  const handleArchive = (wh) => {
    openConfirm(
      t('inventory.archiveWarehouseTitle'),
      t('inventory.archiveWarehouseConfirm', { name: wh.name }),
      async () => {
        closeConfirm()
        setDeleting(wh.id)
        try {
          await db.warehouses.archive(wh.id, userEmail)
          toast.success(t('inventory.warehouseArchivedToast'))
          db.auditLog
            .log(userEmail, 'warehouse_archived', `Archived warehouse ${wh.name}`)
            .catch(() => {})
          onReload()
        } catch (err) {
          toast.error(err.message || t('inventory.warehouseArchiveFailed'))
        } finally {
          setDeleting(null)
        }
      }
    )
  }

  const totalUnits = warehouses.reduce((n, w) => n + unitCountOf(w.id), 0)

  return (
    <div className="space-y-4">
      {showSQL && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 bg-amber-200 rounded-lg flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-4 h-4 text-amber-700"
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
              </div>
              <div>
                <p className="text-sm font-semibold text-amber-900">
                  {t('inventory.warehouseTablesNotSetup')}
                </p>
                <p className="text-xs text-amber-700 mt-0.5">
                  {t('inventory.warehouseTablesSetupHint')}
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowSQL(false)}
              className="text-amber-500 hover:text-amber-700 text-xs underline flex-shrink-0"
            >
              {t('inventory.hideBtn')}
            </button>
          </div>
          <pre className="bg-amber-100 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 overflow-x-auto whitespace-pre">
            {WAREHOUSE_SQL}
          </pre>
          <button
            onClick={onReload}
            className="px-4 py-1.5 bg-amber-600 text-white rounded-xl text-xs font-medium hover:bg-amber-700"
          >
            {t('inventory.retryAfterSQL')}
          </button>
        </div>
      )}

      {/* Toolbar (search + filters) — only when there are warehouses to filter */}
      {!whMissing && warehouses.length > 0 && (
        <>
          <InvToolbar
            searchRef={searchRef}
            search={search}
            onSearchChange={setSearch}
            placeholder={t('inventory.searchWarehousePlaceholder')}
            showFilters={showFilters}
            onToggleFilters={() => setShowFilters((f) => !f)}
            activeFilterCount={activeFilterCount}
            right={
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 dark:text-[#9aa4b2]">
                  {t('inventory.warehouseTotalUnits', { count: totalUnits })}
                </span>
                {canManage && (
                  <button
                    onClick={() => setShowCreate(true)}
                    className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    {t('inventory.newWarehouse')}
                  </button>
                )}
              </div>
            }
          />
          <InvFilterPanel
            show={showFilters}
            activeFilterCount={activeFilterCount}
            onClear={() => {
              setFilterType('')
              setFilterStatus('')
            }}
          >
            <InvFilterField label={t('inventory.warehouseTypeLabel')}>
              <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className={INV_FILTER_SELECT_CLS}>
                <option value="">{t('inventory.filterAll')}</option>
                {WAREHOUSE_TYPES.map((wt) => (
                  <option key={wt} value={wt}>
                    {t(`inventory.warehouseType_${wt}`)}
                  </option>
                ))}
              </select>
            </InvFilterField>
            <InvFilterField label={t('inventory.colStatus')}>
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className={INV_FILTER_SELECT_CLS}>
                <option value="">{t('inventory.filterAll')}</option>
                <option value="active">{t('inventory.statusActive')}</option>
                <option value="inactive">{t('inventory.statusInactive')}</option>
              </select>
            </InvFilterField>
          </InvFilterPanel>
        </>
      )}

      {/* Warehouse table */}
      {whMissing ? (
        <div className="rounded-2xl border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">
          {t('inventory.runSQLToEnableWarehouses')}
        </div>
      ) : warehouses.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 p-16 text-center space-y-3">
          <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto">
            <svg
              className="w-7 h-7 text-gray-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
              />
            </svg>
          </div>
          <p className="text-gray-500 font-medium text-sm">{t('inventory.noWarehousesYet')}</p>
          <p className="text-gray-500 text-xs">{t('inventory.createWarehouseHint')}</p>
          {canManage && (
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 mt-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              {t('inventory.newWarehouse')}
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-2.5 text-start font-semibold text-gray-600 border-b border-r border-gray-200 w-28">
                  {t('inventory.colCode')}
                </th>
                <th className="px-4 py-2.5 text-start font-semibold text-gray-600 border-b border-r border-gray-200">
                  {t('inventory.colName')}
                </th>
                <th className="px-4 py-2.5 text-start font-semibold text-gray-600 border-b border-r border-gray-200">
                  {t('inventory.colLocation')}
                </th>
                <th className="px-4 py-2.5 text-start font-semibold text-gray-600 border-b border-r border-gray-200">
                  {t('inventory.colDescription')}
                </th>
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600 border-b border-r border-gray-200 w-20">
                  {t('inventory.warehouseUnits')}
                </th>
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600 border-b border-r border-gray-200 w-20">
                  {t('inventory.colStatus')}
                </th>
                <th className="px-4 py-2.5 text-start font-semibold text-gray-600 border-b border-r border-gray-200 w-32">
                  {t('inventory.colCreated')}
                </th>
                {canManage && <th className="px-4 py-2.5 border-b border-gray-200 w-20" />}
              </tr>
            </thead>
            <tbody>
              {paginatedRows.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="px-4 py-10 text-center text-gray-500 text-sm">
                    {t('common.noResults')}
                  </td>
                </tr>
              )}
              {(() => {
                let prevGroup = null
                const out = []
                paginatedRows.forEach((wh, idx) => {
                  const g = groupOf(wh)
                  if (g !== prevGroup) {
                    prevGroup = g
                    out.push(
                      <tr key={`hdr-${g}`}>
                        <td
                          colSpan={colCount}
                          className="px-4 py-1.5 bg-gray-50 border-b border-gray-200 text-[10px] font-bold uppercase tracking-wider text-gray-500"
                        >
                          {GROUP_LABELS[g]}
                        </td>
                      </tr>
                    )
                  }
                  const cnt = unitCountOf(wh.id)
                  out.push(
                    <tr
                      key={wh.id}
                      onClick={() => setSelectedWh({ ...wh, isSystem: false })}
                      className={`border-b border-gray-100 cursor-pointer hover:bg-indigo-50/40 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'} ${!wh.is_active ? 'opacity-60' : ''}`}
                    >
                      <td className="px-4 py-2.5 border-r border-gray-100">
                        <span className="font-mono text-indigo-700 font-semibold">
                          {wh.code || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 border-r border-gray-100 font-medium text-gray-900">
                        <div className="flex items-center gap-1.5">
                          {wh.name}
                          {wh.is_system && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-gray-200 text-gray-600 uppercase tracking-wide">
                              {t('inventory.whSystemBadge')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 border-r border-gray-100 text-gray-500">
                        {wh.location || '—'}
                      </td>
                      <td className="px-4 py-2.5 border-r border-gray-100 text-gray-500 max-w-[200px] truncate">
                        {wh.description || '—'}
                      </td>
                      <td className="px-4 py-2.5 border-r border-gray-100 text-center">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-semibold ${cnt > 0 ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'}`}
                        >
                          {cnt}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 border-r border-gray-100 text-center">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-medium ${wh.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}
                        >
                          {wh.is_active ? t('inventory.statusActive') : t('inventory.statusInactive')}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 border-r border-gray-100 text-gray-500">
                        {wh.created_date ? new Date(wh.created_date).toLocaleDateString() : '—'}
                      </td>
                      {canManage && (
                        <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                          {wh.is_system ? (
                            // Protected row: name/code/type/active are trigger-enforced
                            // (20260764), but location/description/manager/notes stay
                            // editable — so the lock opens the modal in metadata-only
                            // mode rather than blocking every edit. No archive button:
                            // archive_warehouse() rejects system rows outright.
                            <div className="flex items-center justify-center">
                              <button
                                onClick={() => setEditingWh(wh)}
                                title={t('inventory.whSystemLocked')}
                                aria-label={t('inventory.whSystemLocked')}
                                className="p-1 text-gray-300 hover:text-indigo-600 rounded hover:bg-indigo-50 transition-colors"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                                  />
                                </svg>
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1 justify-center">
                              <button
                                onClick={() => setEditingWh(wh)}
                                className="p-1 text-gray-500 hover:text-indigo-600 rounded hover:bg-indigo-50 transition-colors"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                  />
                                </svg>
                              </button>
                              <button
                                onClick={() => handleArchive(wh)}
                                disabled={deleting === wh.id}
                                title={t('inventory.archiveWarehouse')}
                                aria-label={t('inventory.archiveWarehouse')}
                                className="p-1 text-gray-500 hover:text-amber-600 rounded hover:bg-amber-50 transition-colors disabled:opacity-40"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M5 8h14M5 8a2 2 0 01-2-2V4a2 2 0 012-2h14a2 2 0 012 2v2a2 2 0 01-2 2M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                                  />
                                </svg>
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })
                return out
              })()}
            </tbody>
          </table>
        </div>
      )}

      {!whMissing && warehouses.length > 0 && orderedRows.length > 0 && (
        <Pagination
          total={orderedRows.length}
          page={currentPage}
          itemsPerPage={itemsPerPage}
          setItemsPerPage={setItemsPerPage}
          onPage={setCurrentPage}
        />
      )}

      {selectedWh && (
        <WarehouseDetailModal
          wh={selectedWh}
          warehouses={warehouses}
          canTransfer={canTransfer}
          userEmail={userEmail}
          onClose={() => setSelectedWh(null)}
          onReload={() => {
            setSelectedWh(null)
            onReload()
          }}
        />
      )}
      {showCreate && (
        <CreateWarehouseModal
          warehouses={warehouses}
          onSave={async (d) => {
            await db.warehouses.create({
              ...d,
              created_by: userEmail,
              created_date: new Date().toISOString(),
            })
            toast.success(t('inventory.warehouseCreatedToast'))
            db.auditLog
              .log(userEmail, 'warehouse_created', `Created warehouse ${d.name}`)
              .catch(() => {})
            setShowCreate(false)
            onReload()
          }}
          onClose={() => setShowCreate(false)}
        />
      )}
      {editingWh && (
        <CreateWarehouseModal
          initialData={editingWh}
          warehouses={warehouses}
          onSave={async (d) => {
            await db.warehouses.update(editingWh.id, d)
            toast.success(t('inventory.warehouseUpdatedToast'))
            db.auditLog
              .log(userEmail, 'warehouse_updated', `Updated warehouse ${d.name || editingWh.name}`)
              .catch(() => {})
            setEditingWh(null)
            onReload()
          }}
          onClose={() => setEditingWh(null)}
        />
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

// ─── Warehouse Detail Modal ────────────────────────────────────────────────────
// A warehouse's units, one page at a time, searched in the database — product,
// serial, RMA number, brand and the ticket's customer (v_inventory_units). It
// used to filter a load of every unit plus a ticket lookup by RMA number, both
// capped by the Data API. Transfer and export without a selection act on
// everything the search matches, read in full when used. (BUG-066.)
function WarehouseDetailModal({
  wh,
  warehouses,
  canTransfer,
  userEmail,
  onClose,
  onReload,
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState([])
  const [transferIds, setTransferIds] = useState(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(() => safeStorage.get('invWarehouseUnitsPerPage', 100))
  const [preparing, setPreparing] = useState(false)

  const scope = useMemo(
    () => (wh.isSystem ? { unplacedStatus: wh.status } : { warehouseId: wh.id }),
    [wh.isSystem, wh.status, wh.id]
  )
  const scopeKey = wh.isSystem ? `unplaced:${wh.status}` : wh.id
  const debouncedSearch = useDebouncedValue(search)
  const { data: pageResult, isLoading } = useQuery({
    queryKey: ['inventory', 'warehouse-units', scopeKey, { search: debouncedSearch, page, pageSize }],
    queryFn: () => db.inventoryLists.unitsPage({ ...scope, search: debouncedSearch }, page, pageSize),
    placeholderData: keepPreviousData,
  })
  const { data: totalUnits = 0 } = useQuery({
    queryKey: ['inventory', 'warehouse-unit-count', scopeKey],
    queryFn: () => db.inventoryLists.countUnits(scope),
  })
  const filtered = pageResult?.data ?? EMPTY_ARRAY
  const matchingCount = pageResult?.count ?? 0
  const totalPages = Math.ceil(matchingCount / pageSize)

  useEffect(() => {
    setPage(1)
    setSelected([])
  }, [debouncedSearch, pageSize])
  useEffect(() => {
    setSelected([])
  }, [page])
  useEffect(() => {
    if (pageResult && totalPages >= 1 && page > totalPages) setPage(totalPages)
  }, [pageResult, totalPages, page])
  useEffect(() => {
    safeStorage.set('invWarehouseUnitsPerPage', pageSize)
  }, [pageSize])

  const allMatching = () => db.inventoryLists.allUnits({ ...scope, search: debouncedSearch })

  const runExport = async (exporter) => {
    setPreparing(true)
    try {
      await exporter(wh, await allMatching(), t)
    } catch {
      toast.error(t('common.error'))
    } finally {
      setPreparing(false)
    }
  }

  const openTransfer = async () => {
    if (selected.length > 0) {
      setTransferIds(selected)
      return
    }
    setPreparing(true)
    try {
      setTransferIds((await allMatching()).map((u) => u.id))
    } catch {
      toast.error(t('common.error'))
    } finally {
      setPreparing(false)
    }
  }

  const toggle = (id) =>
    setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const toggleAll = () =>
    setSelected(selected.length === filtered.length ? [] : filtered.map((u) => u.id))

  const handleTransfer = async (warehouseId) => {
    const ids = transferIds ?? []
    try {
      await db.inventory.transferUnits(ids, warehouseId)
      toast.success(t('inventory.unitsTransferredCount', { count: ids.length }))
      db.auditLog
        .log(
          userEmail,
          'inventory_units_transferred',
          `Transferred ${ids.length} unit(s) from ${wh.name} to warehouse ${warehouseId}`
        )
        .catch(() => {})
      setSelected([])
      setTransferIds(null)
      onReload()
    } catch (err) {
      // A bulk action can change some of the selection and not the rest (BUG-074):
      // say how many did not change, and refresh so the rows that did are not shown stale.
      if (err?.code === 'RMA_NOT_ALL_UPDATED') toast.error(err.message)
      else toast.error(t('inventory.transferFailed'))
      onReload()
    }
  }

  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <div className="flex items-center gap-2">
              {wh.code && (
                <span className="font-mono text-xs font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                  {wh.code}
                </span>
              )}
              <h3 className="text-lg font-bold text-gray-900">{wh.name}</h3>
              {!wh.isSystem && wh.is_active === false && (
                <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">
                  {t('inventory.statusInactive')}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {totalUnits} unit{totalUnits !== 1 ? 's' : ''}
              {wh.location ? ` · ${wh.location}` : ''}
              {wh.description ? ` · ${wh.description}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {matchingCount > 0 && (
              <>
                <button
                  onClick={() => runExport(exportWarehouseExcel)}
                  disabled={preparing}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-green-300 text-green-700 rounded-lg text-xs font-medium hover:bg-green-50"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </svg>
                  Excel
                </button>
                <button
                  onClick={() => runExport(exportWarehousePDF)}
                  disabled={preparing}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-red-300 text-red-700 rounded-lg text-xs font-medium hover:bg-red-50"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                    />
                  </svg>
                  PDF
                </button>
              </>
            )}
            {canTransfer && matchingCount > 0 && (
              <button
                onClick={openTransfer}
                disabled={preparing}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-indigo-300 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                  />
                </svg>
                {selected.length > 0
                  ? t('inventory.transferWithCount', { count: selected.length })
                  : t('inventory.transferBtn')}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-gray-500 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
            >
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
        </div>

        {/* Search */}
        <div className="px-6 py-3 border-b border-gray-100 flex-shrink-0">
          <div className="relative max-w-sm">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('inventory.searchUnitPlaceholder')}
              aria-label={t('inventory.searchUnitPlaceholder')}
              className="w-full ps-9 pe-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
            />
            <svg
              className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute start-3 top-1/2 -translate-y-1/2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="py-16 flex justify-center">
              <Spinner />
            </div>
          ) : matchingCount === 0 ? (
            <div className="text-center py-16 text-gray-500 text-sm">
              {search
                ? t('inventory.noUnitsMatchSearch')
                : t('inventory.noUnitsInWarehouse')}
            </div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="bg-gray-100 sticky top-0 z-10">
                <tr>
                  {canTransfer && (
                    <th className="w-9 px-3 py-2.5 border-b border-r border-gray-200 text-center">
                      <input
                        type="checkbox"
                        checked={filtered.length > 0 && selected.length === filtered.length}
                        onChange={toggleAll}
                        className="rounded border-gray-300 text-indigo-600 cursor-pointer"
                      />
                    </th>
                  )}
                  <th className="w-8 px-2 py-2.5 border-b border-r border-gray-200 text-center text-gray-500 font-semibold">
                    #
                  </th>
                  {[
                    { key: 'colProduct', cls: 'min-w-[140px]' },
                    { key: 'colBrand', cls: 'w-24' },
                    { key: 'colSerialNum', cls: 'w-28' },
                    { key: 'colWarranty', cls: 'w-28 text-center' },
                    { key: 'colStatus', cls: 'w-28 text-center' },
                    { key: 'colResolution', cls: 'w-28 text-center' },
                    { key: 'colRmaNum', cls: 'w-32' },
                    { key: 'colCustomer', cls: 'min-w-[120px]' },
                    { key: 'colTicketStatus', cls: 'w-24 text-center' },
                    { key: 'colDateAdded', cls: 'w-28' },
                    { key: 'colDays', cls: 'w-16 text-center' },
                  ].map((h, i) => (
                    <th
                      key={i}
                      className={`px-3 py-2.5 text-start font-semibold text-gray-600 border-b border-r border-gray-200 ${h.cls || ''}`}
                    >
                      {t(`inventory:${h.key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((u, idx) => {
                  const isSelected = selected.includes(u.id)
                  const age = daysSince(u.created_date)
                  const tk = { customer_name: u.ticket_customer_name, ticket_status: u.ticket_status }
                  return (
                    <tr
                      key={u.id}
                      onClick={() => canTransfer && toggle(u.id)}
                      className={`border-b border-gray-100 transition-colors ${isSelected ? 'bg-indigo-50' : idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'} ${canTransfer ? 'cursor-pointer hover:bg-indigo-50/40' : ''}`}
                    >
                      {canTransfer && (
                        <td className="px-3 py-1.5 text-center border-r border-gray-100">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            className="rounded border-gray-300 text-indigo-600 cursor-pointer"
                          />
                        </td>
                      )}
                      <td className="px-2 py-1.5 text-center text-gray-500 tabular-nums border-r border-gray-100">
                        {(page - 1) * pageSize + idx + 1}
                      </td>
                      <td
                        className="px-3 py-1.5 font-medium text-gray-900 border-r border-gray-100 max-w-[160px] truncate"
                        title={u.product_name || ''}
                      >
                        {u.product_name || '—'}
                      </td>
                      <td className="px-3 py-1.5 text-gray-500 border-r border-gray-100">
                        {u.brand_name || '—'}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-gray-600 border-r border-gray-100">
                        {u.serial_number || '—'}
                      </td>
                      <td className="px-3 py-1.5 text-center border-r border-gray-100">
                        <WarrantyBadge status={u.warranty_status} />
                      </td>
                      <td className="px-3 py-1.5 text-center border-r border-gray-100">
                        <StatusBadge status={u.status} />
                      </td>
                      <td className="px-3 py-1.5 text-center border-r border-gray-100">
                        <ResolutionBadge type={u.resolution_type} />
                      </td>
                      <td className="px-3 py-1.5 font-mono text-indigo-600 border-r border-gray-100">
                        {u.rma_number || '—'}
                      </td>
                      <td className="px-3 py-1.5 text-gray-700 border-r border-gray-100">
                        {tk?.customer_name || '—'}
                      </td>
                      <td className="px-3 py-1.5 text-center border-r border-gray-100">
                        {tk?.ticket_status ? (
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${TICKET_STATUS_CLS[tk.ticket_status] || 'bg-gray-100 text-gray-600'}`}
                          >
                            {tk.ticket_status}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-gray-500 border-r border-gray-100">
                        {fmtDate(u.created_date)}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <span
                          className={`text-xs font-semibold ${age > 30 ? 'text-red-600' : age > 14 ? 'text-amber-600' : 'text-gray-500'}`}
                        >
                          {age}d
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {matchingCount > 0 && (
          <div className="px-6 flex-shrink-0">
            <Pagination
              total={matchingCount}
              page={page}
              itemsPerPage={pageSize}
              setItemsPerPage={setPageSize}
              onPage={setPage}
            />
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-between flex-shrink-0">
          <span className="text-xs text-gray-500">
            {search
              ? t('inventory.footerUnitsOf', { filtered: matchingCount, total: totalUnits })
              : t('inventory.footerUnitsTotal', { count: totalUnits })}
            {selected.length > 0 && (
              <span className="ms-2 text-indigo-600 font-medium">
                {t('inventory.footerSelected', { count: selected.length })}
              </span>
            )}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50"
          >
            {t('inventory.closeBtn')}
          </button>
        </div>
      </div>
      {transferIds && (
        <TransferModal
          units={transferIds}
          warehouses={warehouses}
          currentWarehouseId={wh.isSystem ? null : wh.id}
          onConfirm={handleTransfer}
          onClose={() => setTransferIds(null)}
        />
      )}
    </div>
  )
}

// ─── Create / Edit Warehouse Modal ─────────────────────────────────────────────
function CreateWarehouseModal({ initialData, warehouses = [], onSave, onClose }) {
  const { t } = useTranslation()
  const isEdit = !!initialData?.id
  // System locations open in metadata-only mode: the 20260764 trigger rejects any
  // change to code/name/warehouse_type/is_active, so those inputs are locked and
  // left out of the payload entirely — sending them unchanged would still work,
  // but omitting them keeps a stray edit from ever reaching the trigger.
  const isSystem = !!initialData?.is_system

  const autoCode = React.useMemo(() => {
    if (isEdit) return initialData?.code || ''
    const nums = warehouses
      .map((w) => {
        const m = (w.code || '').match(/^WH-(\d+)$/)
        return m ? parseInt(m[1]) : 0
      })
      .filter((n) => n > 0)
    const max = nums.length ? Math.max(...nums) : 0
    return `WH-${String(max + 1).padStart(3, '0')}`
  }, [isEdit, warehouses, initialData])

  const [name, setName] = useState(initialData?.name || '')
  const [code, setCode] = useState(autoCode)
  const [location, setLocation] = useState(initialData?.location || '')
  const [desc, setDesc] = useState(initialData?.description || '')
  const [active, setActive] = useState(initialData?.is_active ?? true)
  const [warehouseType, setWarehouseType] = useState(initialData?.warehouse_type || '')
  const [manager, setManager] = useState(initialData?.manager || '')
  const [notes, setNotes] = useState(initialData?.notes || '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const metadata = {
        location: location.trim() || null,
        description: desc.trim() || null,
        manager: manager.trim() || null,
        notes: notes.trim() || null,
      }
      await onSave(
        isSystem
          ? metadata
          : {
              ...metadata,
              name: name.trim(),
              code: code.trim() || null,
              is_active: active,
              warehouse_type: warehouseType || null,
            }
      )
    } catch {
      toast.error(t('inventory.failedToSaveWarehouse'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-modal flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="p-6 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">
            {isEdit ? t('inventory.editWarehouse') : t('inventory.newWarehouse')}
          </h3>
          {!isEdit && (
            <p className="text-xs text-gray-500 mt-0.5">
              {t('inventory.autoAssignedCode')}{' '}
              <span className="font-mono font-semibold text-indigo-600">{autoCode}</span>
            </p>
          )}
          {isSystem && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-2">
              {t('inventory.whSystemEditHint')}
            </p>
          )}
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">
              {t('inventory.warehouseNameRequired')}
            </label>
            <input aria-label={t('inventory.warehouseNameRequired')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('inventory.warehouseNamePlaceholder')}
              disabled={isSystem}
              className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent disabled:bg-gray-100 disabled:text-gray-600 disabled:cursor-not-allowed"
              autoFocus={!isSystem}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                {t('inventory.warehouseCodeLabel')}
              </label>
              <input aria-label={t('inventory.warehouseCodeLabel')}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={isSystem}
                className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent font-mono disabled:bg-gray-100 disabled:text-gray-600 disabled:cursor-not-allowed"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                {t('inventory.warehouseLocationLabel')}
              </label>
              <input aria-label={t('inventory.warehouseLocationLabel')}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder={t('inventory.locationPlaceholder')}
                className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">
              {t('inventory.warehouseDescLabel')}
            </label>
            <textarea aria-label={t('inventory.warehouseDescLabel')}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              placeholder={t('inventory.descriptionPlaceholder')}
              className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm resize-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                {t('inventory.warehouseTypeLabel')}
              </label>
              <select aria-label={t('inventory.warehouseTypeLabel')}
                value={warehouseType}
                onChange={(e) => setWarehouseType(e.target.value)}
                disabled={isSystem}
                className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent disabled:bg-gray-100 disabled:text-gray-600 disabled:cursor-not-allowed"
              >
                <option value="">{t('common.select')}</option>
                {['main', 'branch', 'service_center', 'rma', 'transit', 'virtual'].map((wt) => (
                  <option key={wt} value={wt}>
                    {t(`inventory.warehouseType_${wt}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                {t('inventory.warehouseManagerLabel')}
              </label>
              <input aria-label={t('inventory.warehouseManagerLabel')}
                value={manager}
                onChange={(e) => setManager(e.target.value)}
                placeholder={t('inventory.warehouseManagerPlaceholder')}
                className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">
              {t('inventory.warehouseNotesLabel')}
            </label>
            <textarea aria-label={t('inventory.warehouseNotesLabel')}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm resize-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            />
          </div>
          {isEdit && !isSystem && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-sm text-gray-700">{t('inventory.activeLabel')}</span>
            </label>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50"
          >
            {t('inventory.cancelBtn')}
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 min-w-[100px] text-center"
          >
            {saving ? (
              <Spinner size="sm" color="white" />
            ) : isEdit ? (
              t('inventory.saveChangesBtn')
            ) : (
              t('inventory.createBtn')
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
