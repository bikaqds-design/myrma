import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import Modal from '../../components/Modal'
import { Button, Label, Select, Input, Textarea } from '../../components/ui'

// Reuses the existing status i18n keys already defined for the filter panel
// (inventory.statusActiveRMA etc.) rather than deriving new key names.
const SERIALIZED_STATUS_KEYS = {
  active_rma: 'statusActiveRMA',
  company_stock: 'statusCompanyStock',
  sent_to_manufacturer: 'statusSentToManufacturer',
  closed: 'statusClosed',
}

// ─── Adjust Stock — manual correction, dual-mode (Sprint 8 Phase 8b) ───────────
export function AdjustStockModal({ open, onClose, isBulk, productId, warehouseId, unit, userEmail, onSuccess }) {
  const { t } = useTranslation()
  const [newStatus, setNewStatus] = useState(unit?.status || '')
  const [qtyDelta, setQtyDelta] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  function reset() {
    setNewStatus(unit?.status || '')
    setQtyDelta('')
    setReason('')
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function handleSubmit() {
    if (isBulk) {
      const delta = parseInt(qtyDelta, 10)
      if (!delta) {
        toast.error(t('inventory.adjustDeltaRequired'))
        return
      }
    } else if (!newStatus) {
      toast.error(t('inventory.adjustStatusRequired'))
      return
    }
    setSaving(true)
    try {
      await db.inventory.adjustStock({
        productId,
        warehouseId,
        actorEmail: userEmail,
        unitId: isBulk ? undefined : unit?.id,
        newStatus: isBulk ? undefined : newStatus,
        qtyDelta: isBulk ? parseInt(qtyDelta, 10) : undefined,
        reason: reason || undefined,
      })
      toast.success(t('inventory.adjustSuccess'))
      onSuccess()
      handleClose()
    } catch (err) {
      toast.error(err.message || t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title={t('inventory.adjustTitle')} className="max-w-md">
      <div className="space-y-4">
        {isBulk ? (
          <div>
            <Label>{t('inventory.adjustQtyDelta')}</Label>
            <Input
              type="number"
              value={qtyDelta}
              onChange={(e) => setQtyDelta(e.target.value)}
              placeholder={t('inventory.adjustQtyDeltaPlaceholder')}
              className="mt-1 w-full"
            />
            <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">{t('inventory.adjustQtyDeltaHint')}</p>
          </div>
        ) : (
          <div>
            <Label>{t('inventory.adjustNewStatus')}</Label>
            <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value)} className="mt-1 w-full">
              <option value="">{t('common.select')}</option>
              {Object.entries(SERIALIZED_STATUS_KEYS).map(([value, key]) => (
                <option key={value} value={value}>
                  {t(`inventory.${key}`)}
                </option>
              ))}
            </Select>
          </div>
        )}

        <div>
          <Label>{t('inventory.adjustReason')}</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="mt-1 w-full"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={saving} loading={saving}>
            {t('inventory.adjustSubmit')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
