import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { downloadCSV } from './_shared'
import { BulkStockActionModal } from './BulkStockActionModal'

const TRACKING_BADGE = {
  serialized: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  bulk: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
}

// ─── Overview — funnel-aware per-product stock summary (Sprint 8 Phase 8b/8c) ──
// Replaces the old RMA-repair-centric "Stock by Brand" breakdown. Counts are
// derived from reservation_status (serialized) / warehouse_stock (bulk),
// never from the RMA-lifecycle `status` field — see Sprint 7.6 (audit A1).
export function OverviewTab({
  stockSummary,
  onNavigate,
  units,
  warehouseStockRows,
  warehouses,
  userEmail,
  isManagerOrAbove,
  onRefresh,
}) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(new Set())
  const [bulkAction, setBulkAction] = useState(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = q
      ? stockSummary.filter((r) => r.product_name.toLowerCase().includes(q))
      : stockSummary
    return [...rows].sort(
      (a, b) => b.available + b.reserved + b.delivered - (a.available + a.reserved + a.delivered)
    )
  }, [stockSummary, search])

  const selectedSummaries = useMemo(
    () => stockSummary.filter((s) => selected.has(s.product_id)),
    [stockSummary, selected]
  )

  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.product_id))

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map((r) => r.product_id)))
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
        Total: r.available + r.reserved + r.delivered,
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
      r.delivered,
      r.available + r.reserved + r.delivered,
    ])
    let y = 90
    doc.setFontSize(9)
    doc.setFont(undefined, 'bold')
    ;[
      t('inventory.colProduct'),
      t('inventory.colTrackingMode'),
      t('inventory.colAvailable'),
      t('inventory.colReserved'),
      t('inventory.colDelivered'),
      t('inventory.colTotal'),
    ].forEach((h, i) => doc.text(h, 40 + i * 130, y))
    doc.setFont(undefined, 'normal')
    y += 18
    rows.forEach((row) => {
      row.forEach((cell, i) => doc.text(String(cell), 40 + i * 130, y))
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
            className="ml-auto text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]"
          >
            {t('common.clear')}
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('inventory.searchProductPlaceholder')}
          className="max-w-md w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] shadow-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
        />
        <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
          {t('inventory.productCount', { count: filtered.length })}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20 bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38]">
          <p className="text-[#6c6760] dark:text-[#9aa4b2] text-sm">{t('inventory.noStockData')}</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  <th className="px-5 py-3 w-8">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                  </th>
                  {[
                    t('inventory.colProduct'),
                    t('inventory.colTrackingMode'),
                    t('inventory.colAvailable'),
                    t('inventory.colReserved'),
                    t('inventory.colDelivered'),
                    t('inventory.colTotal'),
                  ].map((h, i) => (
                    <th
                      key={i}
                      className="px-5 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0f2f6] dark:divide-[#1a2230]">
                {filtered.map((row) => (
                  <tr
                    key={row.product_id}
                    className="hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230] transition-colors"
                  >
                    <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(row.product_id)}
                        onChange={() => toggleRow(row.product_id)}
                      />
                    </td>
                    <td
                      className="px-5 py-3 font-medium text-[#211f1b] dark:text-[#e8ebf0] cursor-pointer"
                      onClick={() => onNavigate(row.product_id)}
                    >
                      {row.product_name}
                    </td>
                    <td className="px-5 py-3 cursor-pointer" onClick={() => onNavigate(row.product_id)}>
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${TRACKING_BADGE[row.stock_tracking_mode]}`}
                      >
                        {t(`inventory.tracking_${row.stock_tracking_mode}`)}
                      </span>
                    </td>
                    <td className="px-5 py-3 cursor-pointer" onClick={() => onNavigate(row.product_id)}>
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                        {row.available}
                      </span>
                    </td>
                    <td className="px-5 py-3 cursor-pointer" onClick={() => onNavigate(row.product_id)}>
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                        {row.reserved}
                      </span>
                    </td>
                    <td className="px-5 py-3 cursor-pointer" onClick={() => onNavigate(row.product_id)}>
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        {row.delivered}
                      </span>
                    </td>
                    <td
                      className="px-5 py-3 font-bold text-[#211f1b] dark:text-[#e8ebf0] cursor-pointer"
                      onClick={() => onNavigate(row.product_id)}
                    >
                      {row.available + row.reserved + row.delivered}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
    </div>
  )
}
