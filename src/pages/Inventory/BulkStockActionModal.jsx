import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import Modal from '../../components/Modal'
import { Button, Label, Select, Input } from '../../components/ui'

// ─── Bulk Stock Actions — transfer / adjust / recalculate across a multi-select
// product set (Sprint 8 Phase 8c). Each action is a loop of the same
// already-proven single-item RPC calls (transferStock/adjustStock/
// recalculateStock) — there is no server-side "bulk" RPC, since each
// operation is inherently per-product-per-warehouse. Per-item try/catch with
// a running success/failure count, same pattern as ReceiveStockModal's
// multi-serial loop, so one bad row doesn't block the rest of the batch.
//
// Defined scope (documented here since these are genuine simplifications,
// not full generality):
//   - Bulk Transfer: moves ALL current stock of each selected product to one
//     destination warehouse. Bulk-tracked products: one transfer per
//     warehouse_stock row with quantity > 0. Serialized products: one
//     transfer per currently-available unit that has a warehouse assigned
//     (units with no warehouse_id are skipped — transfer_stock has no
//     "from nowhere" case).
//   - Bulk Adjust: bulk-tracked products only, applies the same quantity
//     delta to one chosen warehouse for every selected product. Serialized
//     products are skipped (adjusting every available unit's status
//     uniformly wasn't a clearly-requested behavior; the single-item Adjust
//     action in the Stock Breakdown modal covers per-unit status changes).
//   - Recalculate: bulk-tracked products only (serialized availability is
//     always a live COUNT, nothing to recalculate) — re-sums
//     reserved_quantity across every warehouse_stock row of each selected
//     product.
export function BulkStockActionModal({
  open,
  onClose,
  action,
  selectedSummaries,
  units,
  warehouseStockRows,
  warehouses,
  userEmail,
  onSuccess,
}) {
  const { t } = useTranslation()
  const [destWarehouseId, setDestWarehouseId] = useState('')
  const [qtyDelta, setQtyDelta] = useState('')
  const [warehouseIdForAdjust, setWarehouseIdForAdjust] = useState('')
  const [running, setRunning] = useState(false)

  function reset() {
    setDestWarehouseId('')
    setQtyDelta('')
    setWarehouseIdForAdjust('')
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function runTransfer() {
    let ok = 0
    let fail = 0
    for (const summary of selectedSummaries) {
      if (summary.stock_tracking_mode === 'bulk') {
        const rows = warehouseStockRows.filter(
          (w) => w.product_id === summary.product_id && w.quantity > 0 && w.warehouse_id !== destWarehouseId
        )
        for (const row of rows) {
          try {
            await db.inventory.transferStock({
              productId: summary.product_id,
              fromWarehouseId: row.warehouse_id,
              toWarehouseId: destWarehouseId,
              actorEmail: userEmail,
              qty: row.quantity,
            })
            ok++
          } catch {
            fail++
          }
        }
      } else {
        const available = units.filter(
          (u) =>
            u.product_id === summary.product_id &&
            u.status === 'company_stock' &&
            u.reservation_status === 'available' &&
            u.warehouse_id &&
            u.warehouse_id !== destWarehouseId
        )
        for (const unit of available) {
          try {
            await db.inventory.transferStock({
              productId: summary.product_id,
              fromWarehouseId: unit.warehouse_id,
              toWarehouseId: destWarehouseId,
              actorEmail: userEmail,
              unitId: unit.id,
            })
            ok++
          } catch {
            fail++
          }
        }
      }
    }
    return { ok, fail }
  }

  async function runAdjust() {
    let ok = 0
    let fail = 0
    const delta = parseInt(qtyDelta, 10)
    const bulkOnly = selectedSummaries.filter((s) => s.stock_tracking_mode === 'bulk')
    for (const summary of bulkOnly) {
      try {
        await db.inventory.adjustStock({
          productId: summary.product_id,
          warehouseId: warehouseIdForAdjust,
          actorEmail: userEmail,
          qtyDelta: delta,
        })
        ok++
      } catch {
        fail++
      }
    }
    return { ok, fail, skipped: selectedSummaries.length - bulkOnly.length }
  }

  async function runRecalculate() {
    let ok = 0
    let fail = 0
    const bulkOnly = selectedSummaries.filter((s) => s.stock_tracking_mode === 'bulk')
    for (const summary of bulkOnly) {
      const rows = warehouseStockRows.filter((w) => w.product_id === summary.product_id)
      for (const row of rows) {
        try {
          await db.inventory.recalculateStock(summary.product_id, row.warehouse_id, userEmail)
          ok++
        } catch {
          fail++
        }
      }
    }
    return { ok, fail, skipped: selectedSummaries.length - bulkOnly.length }
  }

  async function handleRun() {
    if (action === 'transfer' && !destWarehouseId) {
      toast.error(t('inventory.transferValidation'))
      return
    }
    if (action === 'adjust' && (!warehouseIdForAdjust || !parseInt(qtyDelta, 10))) {
      toast.error(t('inventory.adjustDeltaRequired'))
      return
    }
    setRunning(true)
    try {
      const result =
        action === 'transfer' ? await runTransfer() : action === 'adjust' ? await runAdjust() : await runRecalculate()
      if (result.ok > 0) toast.success(t('inventory.bulkActionSuccess', { count: result.ok }))
      if (result.fail > 0) toast.error(t('inventory.bulkActionPartialFailure', { count: result.fail }))
      if (result.skipped > 0) toast(t('inventory.bulkActionSkippedSerialized', { count: result.skipped }))
      onSuccess()
      handleClose()
    } finally {
      setRunning(false)
    }
  }

  const title =
    action === 'transfer'
      ? t('inventory.bulkTransferTitle')
      : action === 'adjust'
        ? t('inventory.bulkAdjustTitle')
        : t('inventory.bulkRecalculateTitle')

  return (
    <Modal open={open} onClose={handleClose} title={title} className="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
          {t('inventory.bulkActionScope', { count: selectedSummaries.length })}
        </p>

        {action === 'transfer' && (
          <div>
            <Label>{t('inventory.selectDestWarehouse')}</Label>
            <Select value={destWarehouseId} onChange={(e) => setDestWarehouseId(e.target.value)} className="mt-1 w-full">
              <option value="">{t('common.select')}</option>
              {warehouses
                .filter((w) => w.is_active)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </Select>
          </div>
        )}

        {(action === 'adjust' || action === 'recalculate') && action === 'adjust' && (
          <>
            <div>
              <Label>{t('inventory.selectDestWarehouse')}</Label>
              <Select
                value={warehouseIdForAdjust}
                onChange={(e) => setWarehouseIdForAdjust(e.target.value)}
                className="mt-1 w-full"
              >
                <option value="">{t('common.select')}</option>
                {warehouses
                  .filter((w) => w.is_active)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
              </Select>
            </div>
            <div>
              <Label>{t('inventory.adjustQtyDelta')}</Label>
              <Input
                type="number"
                value={qtyDelta}
                onChange={(e) => setQtyDelta(e.target.value)}
                placeholder={t('inventory.adjustQtyDeltaPlaceholder')}
                className="mt-1 w-full"
              />
            </div>
            <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.bulkAdjustSkipNote')}</p>
          </>
        )}

        {action === 'recalculate' && (
          <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.bulkRecalculateNote')}</p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleRun} loading={running} disabled={running}>
            {t('inventory.bulkActionRun')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
