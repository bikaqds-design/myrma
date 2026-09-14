import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import Modal from '../../components/Modal'
import { Button, Label, Select, Input, Textarea } from '../../components/ui'
import { ProductSearchInput } from '../Pipeline/_shared'
import { destinationWarehouses } from '../../lib/warehouseDestinations.js'

// ─── Receive Stock — interim manual stock-entry path (Sprint 8 Phase 8a/8b) ────
// Sprint 9's Purchase Module replaces this with vendor-invoice-driven receipt.
// Branches by the selected product's stock_tracking_mode: serial entry
// (multi-line, one receive_stock call per serial) for serialized products;
// quantity + warehouse for bulk-tracked ones.
export function ReceiveStockModal({ open, onClose, warehouses, userEmail, onSuccess }) {
  const { t } = useTranslation()
  const [productQuery, setProductQuery] = useState('')
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [warehouseId, setWarehouseId] = useState('')
  const [serialsText, setSerialsText] = useState('')
  const [qty, setQty] = useState('')
  const [saving, setSaving] = useState(false)

  const isBulk = selectedProduct?.stock_tracking_mode === 'bulk'

  function reset() {
    setProductQuery('')
    setSelectedProduct(null)
    setWarehouseId('')
    setSerialsText('')
    setQty('')
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function handleSubmit() {
    if (!selectedProduct || !warehouseId) {
      toast.error(t('inventory.receiveStockValidation'))
      return
    }

    setSaving(true)
    try {
      if (isBulk) {
        const qtyNum = parseInt(qty, 10)
        if (!qtyNum || qtyNum <= 0) {
          toast.error(t('inventory.receiveStockQtyRequired'))
          setSaving(false)
          return
        }
        await db.inventory.receiveStock({
          productId: selectedProduct.id,
          warehouseId,
          actorEmail: userEmail,
          qty: qtyNum,
        })
        toast.success(t('inventory.receiveStockBulkSuccess', { qty: qtyNum }))
      } else {
        const serials = [...new Set(serialsText.split('\n').map((s) => s.trim()).filter(Boolean))]
        if (!serials.length) {
          toast.error(t('inventory.receiveStockSerialRequired'))
          setSaving(false)
          return
        }
        let successCount = 0
        for (const serial of serials) {
          try {
            await db.inventory.receiveStock({
              productId: selectedProduct.id,
              warehouseId,
              actorEmail: userEmail,
              serial,
            })
            successCount++
          } catch (err) {
            toast.error(t('inventory.receiveStockSerialFailed', { serial, error: err.message }))
          }
        }
        if (successCount > 0) toast.success(t('inventory.receiveStockSuccess', { count: successCount }))
        if (successCount === 0) {
          setSaving(false)
          return
        }
      }
      onSuccess()
      handleClose()
    } catch (err) {
      toast.error(err.message || t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title={t('inventory.receiveStockTitle')} className="max-w-lg">
      <div className="space-y-4">
        <div>
          <Label>{t('inventory.selectProduct')}</Label>
          <ProductSearchInput
            value={productQuery}
            onChange={setProductQuery}
            onSelectProduct={(p) => {
              setSelectedProduct(p)
              setProductQuery(p.product_name)
            }}
            // Service products never hold stock; the search leaves them out.
            // It filtered the whole loaded catalogue before. (BUG-066.)
            excludeService
            placeholder={t('inventory.typeProductName')}
            className="mt-1"
          />
        </div>

        {selectedProduct && (
          <>
            <div>
              <Label>{t('inventory.selectDestWarehouse')}</Label>
              <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="mt-1 w-full">
                <option value="">{t('common.select')}</option>
                {destinationWarehouses(warehouses).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </div>

            {isBulk ? (
              <div>
                <Label>{t('inventory.quantity')}</Label>
                <Input
                  type="number"
                  min="1"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="mt-1 w-full"
                />
              </div>
            ) : (
              <div>
                <Label>{t('inventory.serialNumbers')}</Label>
                <Textarea
                  value={serialsText}
                  onChange={(e) => setSerialsText(e.target.value)}
                  placeholder={t('inventory.serialNumbersPlaceholder')}
                  rows={5}
                  className="mt-1 w-full font-mono"
                />
                <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">
                  {t('inventory.serialNumbersHint')}
                </p>
              </div>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={saving || !selectedProduct || !warehouseId}
            loading={saving}
          >
            {t('inventory.receiveStockSubmit')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
