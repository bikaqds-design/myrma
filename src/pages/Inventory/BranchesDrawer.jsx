import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../components/Modal'
import { TransferStockModal } from './TransferStockModal'
import { AdjustStockModal } from './AdjustStockModal'

// ─── Branches drill-down — Main + per-branch sellable-stock breakdown ───────
// (Warehouse Module R1). Built on the shared Modal, same as StockBreakdownModal
// — a centered dialog, not a bespoke slide-over, matching every other detail
// overlay already in this codebase.
export function BranchesDrawer({ open, onClose, productSummary, warehouses, isManagerOrAbove, userEmail, onRefresh }) {
  const { t } = useTranslation()
  const [transferTarget, setTransferTarget] = useState(null)
  const [adjustTarget, setAdjustTarget] = useState(null)

  if (!productSummary) return null
  const isBulk = productSummary.stock_tracking_mode === 'bulk'
  const branches = productSummary.branches || []

  return (
    <Modal open={open} onClose={onClose} title={t('inventory.branchesDrawerTitle', { product: productSummary.product_name })} className="max-w-lg">
      <div className="space-y-4">
        <div className="flex items-center justify-between text-sm bg-[#f8f9fb] dark:bg-[#0f1520] rounded-lg px-3 py-2">
          <span className="font-medium text-[#211f1b] dark:text-[#e8ebf0]">{t('inventory.colMain')}</span>
          <span className="font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{productSummary.main_qty}</span>
        </div>

        {branches.length === 0 ? (
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.noBranchStock')}</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {branches.map((b) => (
              <li key={b.warehouse_id} className="flex items-center justify-between">
                <span className="text-[#211f1b] dark:text-[#e8ebf0]">{b.name}</span>
                <div className="flex items-center gap-3">
                  <span className="font-medium text-[#211f1b] dark:text-[#e8ebf0]">{b.qty}</span>
                  {isBulk && isManagerOrAbove && (
                    <>
                      <button
                        onClick={() => setTransferTarget({ warehouseId: b.warehouse_id, unitId: null })}
                        className="text-xs text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                      >
                        {t('inventory.actionTransfer')}
                      </button>
                      <button
                        onClick={() => setAdjustTarget({ warehouseId: b.warehouse_id, unit: null })}
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
