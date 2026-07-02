import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import Modal from '../../components/Modal'
import { TransferStockModal } from './TransferStockModal'
import { AdjustStockModal } from './AdjustStockModal'

const NAVIGABLE_DOC_TYPES = new Set(['sales_order', 'invoice', 'credit_note'])

// ─── Stock Breakdown — per-product drill-down (Sprint 8 Phase 8b) ──────────────
// Built on the existing Modal (Radix Dialog) rather than a bespoke slide-over —
// reuses the accessible focus-trap/escape/aria pattern already established for
// every other detail overlay in this codebase instead of inventing a new one.
export function StockBreakdownModal({
  open,
  onClose,
  productSummary,
  product,
  units,
  warehouseStockRows,
  warehouses,
  flatProducts,
  moves,
  userEmail,
  isManagerOrAbove,
  onRefresh,
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const isBulk = productSummary?.stock_tracking_mode === 'bulk'
  const [transferTarget, setTransferTarget] = useState(null)
  const [adjustTarget, setAdjustTarget] = useState(null)

  const warehouseRows = useMemo(() => {
    if (!productSummary) return []
    if (isBulk) {
      return warehouseStockRows
        .filter((w) => w.product_id === productSummary.product_id)
        .map((w) => ({
          key: w.warehouse_id,
          warehouseId: w.warehouse_id,
          name: warehouses.find((wh) => wh.id === w.warehouse_id)?.name || w.warehouse_id,
          quantity: w.quantity,
        }))
    }
    const productUnits = units.filter(
      (u) => u.product_id === productSummary.product_id && u.status === 'company_stock'
    )
    const byWarehouse = {}
    for (const u of productUnits) {
      const key = u.warehouse_id || 'unassigned'
      if (!byWarehouse[key]) {
        byWarehouse[key] = {
          key,
          warehouseId: u.warehouse_id,
          name: u.warehouse_id
            ? warehouses.find((wh) => wh.id === u.warehouse_id)?.name || u.warehouse_id
            : t('inventory.noWarehouseAssigned'),
          quantity: 0,
        }
      }
      byWarehouse[key].quantity += 1
    }
    return Object.values(byWarehouse)
  }, [productSummary, isBulk, warehouseStockRows, units, warehouses, t])

  // Individually actionable serialized units — only 'available' ones, matching
  // transfer_stock/adjust_stock's own guard (can't transfer a unit promised
  // to an open order; adjust is safe on any status but scoping the action
  // list to available units keeps this section focused on "stock you can
  // still act on freely").
  const availableUnits = useMemo(() => {
    if (!productSummary || isBulk) return []
    return units.filter(
      (u) =>
        u.product_id === productSummary.product_id &&
        u.status === 'company_stock' &&
        u.reservation_status === 'available'
    )
  }, [productSummary, isBulk, units])

  const reservedRows = useMemo(() => {
    if (!productSummary) return []
    if (isBulk) {
      const wsIds = new Set(
        warehouseStockRows.filter((w) => w.product_id === productSummary.product_id).map((w) => w.id)
      )
      const byDoc = {}
      for (const m of moves) {
        if (m.ref_type !== 'warehouse_stock' || !wsIds.has(m.ref_id)) continue
        const key = `${m.doc_type}|${m.doc_id}`
        if (!byDoc[key]) byDoc[key] = { docType: m.doc_type, docId: m.doc_id, qty: 0 }
        if (m.move_type === 'reserve') byDoc[key].qty += m.qty
        if (m.move_type === 'release' || m.move_type === 'deliver') byDoc[key].qty -= m.qty
      }
      return Object.values(byDoc).filter((r) => r.qty > 0)
    }
    const reservedUnits = units.filter(
      (u) => u.product_id === productSummary.product_id && u.reservation_status === 'reserved'
    )
    const byDoc = {}
    for (const u of reservedUnits) {
      const key = `${u.reserved_by_doc_type}|${u.reserved_by_doc_id}`
      if (!byDoc[key]) byDoc[key] = { docType: u.reserved_by_doc_type, docId: u.reserved_by_doc_id, qty: 0 }
      byDoc[key].qty += 1
    }
    return Object.values(byDoc)
  }, [productSummary, isBulk, warehouseStockRows, moves, units])

  // Ticket product_status buckets — matched by product_name since RMA ticket
  // line items have no FK to the catalog (free-text, pre-dates the funnel).
  // Shown as the real stored status labels rather than force-mapped into
  // "Received/Inspection/Repair/Ready" buckets — there's no existing status
  // that cleanly means "Inspection", and inventing one wasn't confirmed.
  const rmaRows = useMemo(() => {
    if (!productSummary) return []
    const matching = flatProducts.filter((p) => p.product_name === productSummary.product_name)
    const counts = {}
    for (const p of matching) {
      const status = p.product_status || 'Received'
      counts[status] = (counts[status] || 0) + 1
    }
    return Object.entries(counts).map(([status, count]) => ({ status, count }))
  }, [productSummary, flatProducts])

  if (!productSummary) return null

  const total = productSummary.available + productSummary.reserved + productSummary.delivered

  return (
    <Modal open={open} onClose={onClose} title={productSummary.product_name} className="max-w-2xl">
      <div className="space-y-6">
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[#6c6760] dark:text-[#9aa4b2] mb-2">
            {t('inventory.productInfo')}
          </h4>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <div>
              <span className="text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.colSku')}: </span>
              <span className="text-[#211f1b] dark:text-[#e8ebf0]">{product?.sku || '—'}</span>
            </div>
            <div>
              <span className="text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.colBrand')}: </span>
              <span className="text-[#211f1b] dark:text-[#e8ebf0]">{product?.brand?.brand_name || '—'}</span>
            </div>
            <div>
              <span className="text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.colCategoryLabel')}: </span>
              <span className="text-[#211f1b] dark:text-[#e8ebf0]">{product?.category?.category_name || '—'}</span>
            </div>
            <div>
              <span className="text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.colTotal')}: </span>
              <span className="font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{total}</span>
            </div>
          </div>
        </section>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[#6c6760] dark:text-[#9aa4b2] mb-2">
            {t('inventory.warehouseDistribution')}
          </h4>
          {warehouseRows.length === 0 ? (
            <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.noWarehouseStock')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {warehouseRows.map((w) => (
                <li key={w.key} className="flex items-center justify-between">
                  <span className="text-[#211f1b] dark:text-[#e8ebf0]">{w.name}</span>
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-[#211f1b] dark:text-[#e8ebf0]">{w.quantity}</span>
                    {isBulk && isManagerOrAbove && w.warehouseId && (
                      <>
                        <button
                          onClick={() =>
                            setTransferTarget({ warehouseId: w.warehouseId, unitId: null })
                          }
                          className="text-xs text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                        >
                          {t('inventory.actionTransfer')}
                        </button>
                        <button
                          onClick={() => setAdjustTarget({ warehouseId: w.warehouseId, unit: null })}
                          className="text-xs text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                        >
                          {t('inventory.actionAdjust')}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {!isBulk && isManagerOrAbove && (
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[#6c6760] dark:text-[#9aa4b2] mb-2">
              {t('inventory.availableUnits')}
            </h4>
            {availableUnits.length === 0 ? (
              <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.noAvailableUnits')}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {availableUnits.map((u) => (
                  <li key={u.id} className="flex items-center justify-between">
                    <span className="text-[#211f1b] dark:text-[#e8ebf0]">
                      {u.serial_number || t('inventory.noSerial')}
                    </span>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() =>
                          setTransferTarget({ warehouseId: u.warehouse_id, unitId: u.id })
                        }
                        className="text-xs text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                      >
                        {t('inventory.actionTransfer')}
                      </button>
                      <button
                        onClick={() => setAdjustTarget({ warehouseId: u.warehouse_id, unit: u })}
                        className="text-xs text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                      >
                        {t('inventory.actionAdjust')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[#6c6760] dark:text-[#9aa4b2] mb-2">
            {t('inventory.reservedDistribution')}
          </h4>
          {reservedRows.length === 0 ? (
            <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.noReservations')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {reservedRows.map((r) => (
                <li key={`${r.docType}-${r.docId}`} className="flex justify-between">
                  {NAVIGABLE_DOC_TYPES.has(r.docType) && r.docId ? (
                    <button
                      onClick={() => {
                        onClose()
                        navigate(`/sales/${r.docType}/${r.docId}`)
                      }}
                      className="text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                    >
                      {t(`inventory.docType_${r.docType}`)}
                    </button>
                  ) : (
                    <span className="text-[#211f1b] dark:text-[#e8ebf0]">{t(`inventory.docType_${r.docType}`)}</span>
                  )}
                  <span className="font-medium text-[#211f1b] dark:text-[#e8ebf0]">{r.qty}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[#6c6760] dark:text-[#9aa4b2] mb-2">
            {t('inventory.rmaDistribution')}
          </h4>
          {rmaRows.length === 0 ? (
            <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.noRmaActivity')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {rmaRows.map((r) => (
                <li key={r.status} className="flex justify-between">
                  <span className="text-[#211f1b] dark:text-[#e8ebf0]">{r.status}</span>
                  <span className="font-medium text-[#211f1b] dark:text-[#e8ebf0]">{r.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {transferTarget && (
        <TransferStockModal
          open
          onClose={() => setTransferTarget(null)}
          isBulk={isBulk}
          productId={productSummary.product_id}
          fromWarehouseId={transferTarget.warehouseId}
          unitId={transferTarget.unitId}
          warehouses={warehouses}
          userEmail={userEmail}
          onSuccess={onRefresh}
        />
      )}

      {adjustTarget && (
        <AdjustStockModal
          open
          onClose={() => setAdjustTarget(null)}
          isBulk={isBulk}
          productId={productSummary.product_id}
          warehouseId={adjustTarget.warehouseId}
          unit={adjustTarget.unit}
          userEmail={userEmail}
          onSuccess={onRefresh}
        />
      )}
    </Modal>
  )
}
