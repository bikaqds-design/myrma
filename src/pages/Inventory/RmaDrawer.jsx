import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { captureException } from '../../lib/sentry'
import Modal from '../../components/Modal'
import { Select } from '../../components/ui'
import { SYSTEM_WAREHOUSE_CODES, warehouseCapabilities } from '../../lib/constants'
import { locationI18nKey, WarrantyBadge, daysSince, fmt } from './_shared'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'

const MOVE_CODE_ORDER = [
  SYSTEM_WAREHOUSE_CODES.RMA_RECEIVED,
  SYSTEM_WAREHOUSE_CODES.RMA_REPAIR,
  SYSTEM_WAREHOUSE_CODES.RMA_REPAIRED,
  SYSTEM_WAREHOUSE_CODES.RMA_CANTREPAIR,
  SYSTEM_WAREHOUSE_CODES.RMA_STOCK,
  SYSTEM_WAREHOUSE_CODES.REPLACEMENT,
  SYSTEM_WAREHOUSE_CODES.CREDIT_NOTE,
  SYSTEM_WAREHOUSE_CODES.SCRAP,
]

// ─── RMA drill-down — per-system-location unit list + move/promote actions ──
// (Warehouse Module R1). Built on the shared Modal, same pattern as
// StockBreakdownModal/BranchesDrawer.
export function RmaDrawer({
  open,
  onClose,
  productSummary,
  warehouses,
  isManagerOrAbove,
  userEmail,
  onRefresh,
  onNavigateToTicket,
}) {
  const { t } = useTranslation()
  const [busyUnitId, setBusyUnitId] = useState(null)

  // This product's RMA units, read when the drawer opens — not filtered out of
  // every unit in the system, which the Data API caps. (BUG-066.)
  const { data: rmaUnits = EMPTY_ARRAY, isLoading: loadingUnits } = useQuery({
    queryKey: ['inventory', 'rma-units', productSummary?.product_id],
    queryFn: () =>
      db.inventoryLists.allUnits(
        productSummary.in_catalog
          ? { productId: productSummary.product_id, status: 'active_rma' }
          : { unmatchedName: productSummary.product_name, status: 'active_rma' }
      ),
    enabled: Boolean(open && productSummary),
  })

  const systemWarehouses = useMemo(() => warehouses.filter((w) => w.is_system), [warehouses])
  const sellableWarehouses = useMemo(
    () => warehouses.filter((w) => !w.is_system && warehouseCapabilities(w.warehouse_type).sellable),
    [warehouses]
  )
  const grouped = useMemo(() => {
    const buckets = {}
    for (const u of rmaUnits) {
      const key = u.warehouse_id || 'unplaced'
      if (!buckets[key]) buckets[key] = []
      buckets[key].push(u)
    }
    const ordered = MOVE_CODE_ORDER.map((code) => {
      const w = systemWarehouses.find((sw) => sw.code === code)
      if (!w) return null
      return { key: w.id, code, name: w.name, list: buckets[w.id] || [] }
    }).filter(Boolean)
    if (buckets.unplaced?.length) {
      ordered.push({ key: 'unplaced', code: null, name: t('inventory.locUnplaced'), list: buckets.unplaced })
    }
    return ordered.filter((g) => g.list.length > 0)
  }, [rmaUnits, systemWarehouses, t])

  if (!productSummary) return null

  async function handleMove(unit, toCode) {
    if (!toCode || !unit.rma_ticket_id) return
    setBusyUnitId(unit.id)
    try {
      await db.inventory.moveRmaUnits(unit.rma_ticket_id, [{ unit_id: unit.id, to_code: toCode }], userEmail)
      onRefresh()
    } catch (err) {
      captureException(err, { page: 'Inventory', context: 'RmaDrawer:move' })
      toast.error(t('inventory.autoMoveFailed'))
    } finally {
      setBusyUnitId(null)
    }
  }

  async function handlePromote(unit, warehouseId) {
    if (!warehouseId) return
    setBusyUnitId(unit.id)
    try {
      await db.inventory.promoteRmaUnit({ unitId: unit.id, warehouseId, actorEmail: userEmail })
      toast.success(t('inventory.promoteSuccess'))
      onRefresh()
    } catch (err) {
      captureException(err, { page: 'Inventory', context: 'RmaDrawer:promote' })
      toast.error(t('inventory.promoteFailed'))
    } finally {
      setBusyUnitId(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('inventory.rmaDrawerTitle', { product: productSummary.product_name })}
      className="max-w-2xl"
    >
      <div className="space-y-5">
        {loadingUnits ? (
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('common.loading')}</p>
        ) : grouped.length === 0 ? (
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('inventory.noRmaActivity')}</p>
        ) : (
          grouped.map((group) => (
            <section key={group.key}>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[#6c6760] dark:text-[#9aa4b2] mb-2">
                {group.code ? t(locationI18nKey(group.code)) : group.name} ({group.list.length})
              </h4>
              <ul className="space-y-2 text-sm">
                {group.list.map((u) => (
                  <li
                    key={u.id}
                    className="flex items-center justify-between gap-3 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-lg px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-[#211f1b] dark:text-[#e8ebf0] font-medium truncate">
                        {u.serial_number || t('inventory.noSerial')}
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <WarrantyBadge status={u.warranty_status} />
                        <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
                          {t('inventory.daysInStage', { count: daysSince(u.created_date) })} · {fmt(u.created_date)}
                        </span>
                        {u.rma_ticket_id && (
                          <button
                            onClick={() => onNavigateToTicket?.(u.rma_ticket_id)}
                            className="text-xs text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                          >
                            {u.rma_number || t('inventory.viewTicket')}
                          </button>
                        )}
                      </div>
                    </div>
                    {isManagerOrAbove && (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Select
                          className="text-xs py-1"
                          disabled={busyUnitId === u.id}
                          value=""
                          onChange={(e) => handleMove(u, e.target.value)}
                        >
                          <option value="">{t('inventory.moveToLocation')}</option>
                          {systemWarehouses.map((w) => (
                            <option key={w.id} value={w.code} disabled={w.id === u.warehouse_id}>
                              {t(locationI18nKey(w.code))}
                            </option>
                          ))}
                        </Select>
                        <Select
                          className="text-xs py-1"
                          disabled={busyUnitId === u.id}
                          value=""
                          onChange={(e) => handlePromote(u, e.target.value)}
                        >
                          <option value="">{t('inventory.promoteToSellable')}</option>
                          {sellableWarehouses.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </Modal>
  )
}
