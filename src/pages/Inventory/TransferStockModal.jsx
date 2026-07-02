import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import Modal from '../../components/Modal'
import { Button, Label, Select, Input } from '../../components/ui'

// ─── Transfer Stock — funnel-aware atomic transfer (Sprint 8 Phase 8b) ─────────
// Deliberately separate from the existing TransferModal.jsx (used by the 5
// preserved RMA-ticket-status tabs + ByProductTab for the RMA repair
// workflow's warehouse assignment, via the old direct-mutation
// transferUnits()). That existing feature supports a "System Pool" (no
// warehouse) destination and doesn't check reservation state — behavior the
// new atomic transfer_stock RPC deliberately doesn't replicate (it requires
// a real destination warehouse and blocks non-available units). Rather than
// narrow the old feature's behavior for its existing callers, this ships as
// a new, purpose-built flow for funnel stock (product_id-linked serialized
// units and warehouse_stock), reached from the Stock Breakdown modal.
export function TransferStockModal({
  open,
  onClose,
  isBulk,
  productId,
  fromWarehouseId,
  unitId,
  warehouses,
  userEmail,
  onSuccess,
}) {
  const { t } = useTranslation()
  const [toWarehouseId, setToWarehouseId] = useState('')
  const [qty, setQty] = useState('')
  const [saving, setSaving] = useState(false)

  function reset() {
    setToWarehouseId('')
    setQty('')
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function handleSubmit() {
    if (!toWarehouseId || toWarehouseId === fromWarehouseId) {
      toast.error(t('inventory.transferValidation'))
      return
    }
    if (isBulk) {
      const qtyNum = parseInt(qty, 10)
      if (!qtyNum || qtyNum <= 0) {
        toast.error(t('inventory.receiveStockQtyRequired'))
        return
      }
    }
    setSaving(true)
    try {
      await db.inventory.transferStock({
        productId,
        fromWarehouseId,
        toWarehouseId,
        actorEmail: userEmail,
        unitId: isBulk ? undefined : unitId,
        qty: isBulk ? parseInt(qty, 10) : undefined,
      })
      toast.success(t('inventory.transferSuccess'))
      onSuccess()
      handleClose()
    } catch (err) {
      toast.error(err.message || t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title={t('inventory.transferTitle')} className="max-w-md">
      <div className="space-y-4">
        <div>
          <Label>{t('inventory.selectDestWarehouse')}</Label>
          <Select value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)} className="mt-1 w-full">
            <option value="">{t('common.select')}</option>
            {warehouses
              .filter((w) => w.is_active && w.id !== fromWarehouseId)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </Select>
        </div>

        {isBulk && (
          <div>
            <Label>{t('inventory.quantity')}</Label>
            <Input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} className="mt-1 w-full" />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={saving || !toWarehouseId} loading={saving}>
            {t('inventory.confirmTransfer')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
