import React, { useMemo, useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { safeStorage } from '../../lib/safeStorage'
import {
  downloadCSV,
  Pagination,
  InvToolbar,
  InvFilterPanel,
  InvFilterField,
  INV_FILTER_SELECT_CLS,
} from './_shared'
import { BulkStockActionModal } from './BulkStockActionModal'
import { BranchesDrawer } from './BranchesDrawer'
import { RmaDrawer } from './RmaDrawer'

const TRACKING_BADGE = {
  serialized: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  bulk: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
}

// ─── Overview — the Warehouse Module R1 dashboard ──────────────────────────
// Product | Tracking | Available | Reserved | Physical Total | Main |
// Branches(n) -> drawer | RMA(n) -> drawer. Counts are derived server-side by
// getStockSummary() from reservation_status/warehouse location, never from
// the RMA-lifecycle ticket JSONB — see Sprint 7.6 (audit A1) and the
// Warehouse Module R1 redesign notes in CLAUDE.md.
export function OverviewTab({
  stockSummary,
  onNavigate,
  units,
  warehouseStockRows,
  warehouses,
  userEmail,
  isManagerOrAbove,
  onRefresh,
  onNavigateToTicket,
}) {
  const { t } = useTranslation()
  const searchRef = useRef(null)
  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterTracking, setFilterTracking] = useState('')
  const [filterStock, setFilterStock] = useState('')
  const [selected, setSelected] = useState(new Set())
  const [bulkAction, setBulkAction] = useState(null)
  const [branchesTarget, setBranchesTarget] = useState(null)
  const [rmaTarget, setRmaTarget] = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(() => safeStorage.get('invOverviewPerPage', 25))

  const activeFilterCount = [filterTracking, filterStock].filter(Boolean).length

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = stockSummary.filter((r) => {
      const matchSearch = !q || r.product_name.toLowerCase().includes(q)
      const matchTracking = !filterTracking || r.stock_tracking_mode === filterTracking
      const rmaTotal = r.rma.reduce((sum, x) => sum + x.count, 0)
      const matchStock =
        !filterStock ||
        (filterStock === 'available' && r.available > 0) ||
        (filterStock === 'reserved' && r.reserved > 0) ||
        (filterStock === 'rma' && rmaTotal > 0) ||
        (filterStock === 'out' && r.physical_total === 0)
      return matchSearch && matchTracking && matchStock
    })
    return [...rows].sort((a, b) => b.physical_total - a.physical_total)
  }, [stockSummary, search, filterTracking, filterStock])

  const paginated = useMemo(
    () => filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage),
    [filtered, currentPage, itemsPerPage]
  )

  useEffect(() => {
    setCurrentPage(1)
  }, [search, filterTracking, filterStock, itemsPerPage])
  useEffect(() => {
    safeStorage.set('invOverviewPerPage', itemsPerPage)
  }, [itemsPerPage])

  const selectableSummary = useMemo(() => stockSummary.filter((s) => s.in_catalog), [stockSummary])
  const selectedSummaries = useMemo(
    () => selectableSummary.filter((s) => selected.has(s.product_id)),
    [selectableSummary, selected]
  )

  const selectableFiltered = useMemo(() => filtered.filter((r) => r.in_catalog), [filtered])
  const allSelected = selectableFiltered.length > 0 && selectableFiltered.every((r) => selected.has(r.product_id))

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(selectableFiltered.map((r) => r.product_id)))
    }
  }

  function toggleRow(productId) {
    const next = new Set(selected)
    if (next.has(productId)) next.delete(productId)
    else next.add(productId)
    setSelected(next)
  }

  function handleExportSelected() {
    downloadCSV(
      selectedSummaries.map((r) => ({
        Product: r.product_name,
        Tracking: t(`inventory.tracking_${r.stock_tracking_mode}`),
        Available: r.available,
        Reserved: r.reserved,
        Delivered: r.delivered,
        PhysicalTotal: r.physical_total,
        Main: r.main_qty,
        Branches: r.branches.reduce((sum, b) => sum + b.qty, 0),
        RMA: r.rma.reduce((sum, x) => sum + x.count, 0),
      })),
      `inventory-stock-${new Date().toISOString().split('T')[0]}.csv`
    )
  }

  async function handlePrintReport() {
    const { default: jsPDF } = await import('jspdf')
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
    doc.setFontSize(16)
    doc.setFont(undefined, 'bold')
    doc.text(t('inventory.stockReportTitle'), 40, 40)
    doc.setFontSize(9)
    doc.setFont(undefined, 'normal')
    doc.setTextColor(120)
    doc.text(new Date().toLocaleDateString(), 40, 58)
    doc.setTextColor(0)

    const rows = selectedSummaries.map((r) => [
      r.product_name,
      t(`inventory.tracking_${r.stock_tracking_mode}`),
      r.available,
      r.reserved,
      r.physical_total,
      r.main_qty,
      r.branches.reduce((sum, b) => sum + b.qty, 0),
      r.rma.reduce((sum, x) => sum + x.count, 0),
    ])
    let y = 90
    doc.setFontSize(9)
    doc.setFont(undefined, 'bold')
    ;[
      t('inventory.colProduct'),
      t('inventory.colTrackingMode'),
      t('inventory.colAvailable'),
      t('inventory.colReserved'),
      t('inventory.colPhysicalTotal'),
      t('inventory.colMain'),
      t('inventory.colBranches'),
      t('inventory.colRma'),
    ].forEach((h, i) => doc.text(h, 40 + i * 95, y))
    doc.setFont(undefined, 'normal')
    y += 18
    rows.forEach((row) => {
      row.forEach((cell, i) => doc.text(String(cell), 40 + i * 95, y))
      y += 16
    })
    doc.save(`inventory-stock-report-${new Date().toISOString().split('T')[0]}.pdf`)
  }

  return (
    <div className="space-y-3">
      {selected.size > 0 && (
        <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-[#4338ca]/20 dark:border-[#a5b4fc]/20 rounded-[14px] px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-[#4338ca] dark:text-[#a5b4fc]">
            {selected.size} {t('common.selected')}
          </span>
          <div className="w-px h-5 bg-[#4338ca]/20 dark:bg-[#a5b4fc]/20" />
          <button
            onClick={handleExportSelected}
            className="text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230]"
          >
            {t('inventory.exportSelected')}
          </button>
          <button
            onClick={handlePrintReport}
            className="text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230]"
          >
            {t('inventory.printStockReport')}
          </button>
          {isManagerOrAbove && (
            <>
              <button
                onClick={() => setBulkAction('transfer')}
                className="text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230]"
              >
                {t('inventory.bulkTransfer')}
              </button>
              <button
                onClick={() => setBulkAction('adjust')}
                className="text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230]"
              >
                {t('inventory.bulkAdjust')}
              </button>
              <button
                onClick={() => setBulkAction('recalculate')}
                className="text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230]"
              >
                {t('inventory.bulkRecalculate')}
              </button>
            </>
          )}
          <button
            onClick={() => setSelected(new Set())}
            className="ms-auto text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]"
          >
            {t('common.clear')}
          </button>
        </div>
      )}

      <InvToolbar
        searchRef={searchRef}
        search={search}
        onSearchChange={setSearch}
        placeholder={t('inventory.searchProductPlaceholder')}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters((f) => !f)}
        activeFilterCount={activeFilterCount}
        right={
          <span className="text-sm text-gray-500 dark:text-[#9aa4b2]">
            {t('inventory.productCount', { count: filtered.length })}
          </span>
        }
      />

      <InvFilterPanel
        show={showFilters}
        activeFilterCount={activeFilterCount}
        onClear={() => {
          setFilterTracking('')
          setFilterStock('')
        }}
      >
        <InvFilterField label={t('inventory.colTrackingMode')}>
          <select value={filterTracking} onChange={(e) => setFilterTracking(e.target.value)} className={INV_FILTER_SELECT_CLS}>
            <option value="">{t('inventory.filterAll')}</option>
            <option value="serialized">{t('inventory.tracking_serialized')}</option>
            <option value="bulk">{t('inventory.tracking_bulk')}</option>
          </select>
        </InvFilterField>
        <InvFilterField label={t('inventory.filterStock')}>
          <select value={filterStock} onChange={(e) => setFilterStock(e.target.value)} className={INV_FILTER_SELECT_CLS}>
            <option value="">{t('inventory.filterAll')}</option>
            <option value="available">{t('inventory.filterHasAvailable')}</option>
            <option value="reserved">{t('inventory.filterHasReserved')}</option>
            <option value="rma">{t('inventory.filterHasRma')}</option>
            <option value="out">{t('inventory.filterOutOfStock')}</option>
          </select>
        </InvFilterField>
      </InvFilterPanel>

      {filtered.length === 0 ? (
        <div className="text-center py-20 bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38]">
          <p className="text-[#6c6760] dark:text-[#9aa4b2] text-sm">{t('inventory.noStockData')}</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38] sticky top-0 z-10">
                <tr>
                  <th className="px-5 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label={t('common.selectAll')}
                    />
                  </th>
                  {[
                    t('inventory.colProduct'),
                    t('inventory.colTrackingMode'),
                    t('inventory.colAvailable'),
                    t('inventory.colReserved'),
                    t('inventory.colPhysicalTotal'),
                    t('inventory.colMain'),
                    t('inventory.colBranches'),
                    t('inventory.colRma'),
                  ].map((h, i) => (
                    <th
                      key={i}
                      className="px-5 py-3 text-start text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0f2f6] dark:divide-[#1a2230]">
                {paginated.map((row) => {
                  const branchTotal = row.branches.reduce((sum, b) => sum + b.qty, 0)
                  const rmaTotal = row.rma.reduce((sum, r) => sum + r.count, 0)
                  return (
                    <tr key={row.product_id} className="hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230] transition-colors">
                      <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
                        {row.in_catalog && (
                          <input
                            type="checkbox"
                            checked={selected.has(row.product_id)}
                            onChange={() => toggleRow(row.product_id)}
                            aria-label={t('common.selectRow', { name: row.product_name })}
                          />
                        )}
                      </td>
                      <td
                        className={`px-5 py-3 font-medium text-[#211f1b] dark:text-[#e8ebf0] ${row.in_catalog ? 'cursor-pointer' : ''}`}
                        onClick={() => row.in_catalog && onNavigate(row.product_id)}
                      >
                        {row.product_name}
                        {!row.in_catalog && (
                          <span className="ms-2 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2] align-middle">
                            {t('inventory.notInCatalog')}
                          </span>
                        )}
                      </td>
                      <td
                        className={row.in_catalog ? 'px-5 py-3 cursor-pointer' : 'px-5 py-3'}
                        onClick={() => row.in_catalog && onNavigate(row.product_id)}
                      >
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${TRACKING_BADGE[row.stock_tracking_mode]}`}
                        >
                          {t(`inventory.tracking_${row.stock_tracking_mode}`)}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                          {row.available}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                          {row.reserved}
                        </span>
                      </td>
                      <td className="px-5 py-3 font-bold text-[#211f1b] dark:text-[#e8ebf0]">{row.physical_total}</td>
                      <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{row.main_qty}</td>
                      <td className="px-5 py-3">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setBranchesTarget(row)
                          }}
                          className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 hover:opacity-80"
                        >
                          {branchTotal}
                        </button>
                      </td>
                      <td className="px-5 py-3">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setRmaTarget(row)
                          }}
                          disabled={rmaTotal === 0}
                          className="px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 hover:opacity-80 disabled:opacity-40 disabled:cursor-default"
                        >
                          {rmaTotal}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {filtered.length > 0 && (
        <Pagination
          total={filtered.length}
          page={currentPage}
          itemsPerPage={itemsPerPage}
          setItemsPerPage={setItemsPerPage}
          onPage={setCurrentPage}
        />
      )}

      {bulkAction && (
        <BulkStockActionModal
          open
          onClose={() => setBulkAction(null)}
          action={bulkAction}
          selectedSummaries={selectedSummaries}
          units={units}
          warehouseStockRows={warehouseStockRows}
          warehouses={warehouses}
          userEmail={userEmail}
          onSuccess={() => {
            onRefresh()
            setSelected(new Set())
          }}
        />
      )}

      <BranchesDrawer
        open={!!branchesTarget}
        onClose={() => setBranchesTarget(null)}
        productSummary={branchesTarget}
        warehouses={warehouses}
        isManagerOrAbove={isManagerOrAbove}
        userEmail={userEmail}
        onRefresh={onRefresh}
      />

      <RmaDrawer
        open={!!rmaTarget}
        onClose={() => setRmaTarget(null)}
        productSummary={rmaTarget}
        units={units}
        warehouses={warehouses}
        isManagerOrAbove={isManagerOrAbove}
        userEmail={userEmail}
        onRefresh={onRefresh}
        onNavigateToTicket={onNavigateToTicket}
      />
    </div>
  )
}
