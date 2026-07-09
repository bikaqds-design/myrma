import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

const MOVE_TYPE_BADGE = {
  receive: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  reserve: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  deliver: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  release: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  restore: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
  adjust: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  transfer: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
}

// Doc types that have a navigable detail page — 'manual' has none.
const NAVIGABLE_DOC_TYPES = new Set(['sales_order', 'invoice', 'credit_note', 'vendor_invoice', 'rma_ticket'])
const PURCHASING_DOC_TYPES = new Set(['vendor_invoice'])

function routeForMove(m) {
  if (m.doc_type === 'rma_ticket') return `/rma-tickets?ticket=${m.doc_id}`
  return `${PURCHASING_DOC_TYPES.has(m.doc_type) ? '/purchasing' : '/sales'}/${m.doc_type}/${m.doc_id}`
}

// ─── Stock Movements — flat audit-trail table over stock_moves (Sprint 8 Phase 8b) ─
export function StockMovementsTab({ moves, units, warehouseStockRows, products, warehouses }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [moveTypeFilter, setMoveTypeFilter] = useState('')

  const unitById = useMemo(() => {
    const map = {}
    for (const u of units) map[u.id] = u
    return map
  }, [units])

  const wsById = useMemo(() => {
    const map = {}
    for (const w of warehouseStockRows) map[w.id] = w
    return map
  }, [warehouseStockRows])

  const productNameById = useMemo(() => {
    const map = {}
    for (const p of products) map[p.id] = p.product_name
    return map
  }, [products])

  const warehouseNameById = useMemo(() => {
    const map = {}
    for (const w of warehouses) map[w.id] = w.name
    return map
  }, [warehouses])

  function describeRef(move) {
    if (move.ref_type === 'unit') {
      const unit = unitById[move.ref_id]
      if (!unit) return move.ref_id
      return unit.serial_number ? `${unit.product_name} (${unit.serial_number})` : unit.product_name
    }
    if (move.ref_type === 'warehouse_stock') {
      const ws = wsById[move.ref_id]
      if (!ws) return move.ref_id
      const productName = productNameById[ws.product_id] || ws.product_id
      const warehouseName = warehouseNameById[ws.warehouse_id] || ws.warehouse_id
      return `${productName} @ ${warehouseName}`
    }
    return move.ref_id
  }

  const filtered = useMemo(
    () => (moveTypeFilter ? moves.filter((m) => m.move_type === moveTypeFilter) : moves),
    [moves, moveTypeFilter]
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select
          value={moveTypeFilter}
          onChange={(e) => setMoveTypeFilter(e.target.value)}
          className="px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
        >
          <option value="">{t('inventory.filterAll')}</option>
          {Object.keys(MOVE_TYPE_BADGE).map((mt) => (
            <option key={mt} value={mt}>
              {t(`inventory.moveType_${mt}`)}
            </option>
          ))}
        </select>
        <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
          {t('inventory.movementCount', { count: filtered.length })}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20 bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38]">
          <p className="text-[#6c6760] dark:text-[#9aa4b2] text-sm">{t('inventory.noMovementsYet')}</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  {[
                    t('inventory.colDate'),
                    t('inventory.colMoveType'),
                    t('inventory.colProduct'),
                    t('inventory.colQty'),
                    t('inventory.colDoc'),
                    t('inventory.colActor'),
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
                {filtered.map((m) => (
                  <tr key={m.id} className="hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230] transition-colors">
                    <td className="px-5 py-3 text-[#6c6760] dark:text-[#9aa4b2] whitespace-nowrap">
                      {new Date(m.created_at).toLocaleString()}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${MOVE_TYPE_BADGE[m.move_type] || ''}`}>
                        {t(`inventory.moveType_${m.move_type}`)}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{describeRef(m)}</td>
                    <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{m.qty}</td>
                    <td className="px-5 py-3">
                      {NAVIGABLE_DOC_TYPES.has(m.doc_type) && m.doc_id ? (
                        <button
                          onClick={() => navigate(routeForMove(m))}
                          className="text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                        >
                          {t(`inventory.docType_${m.doc_type}`)}
                        </button>
                      ) : (
                        <span className="text-[#6c6760] dark:text-[#9aa4b2]">
                          {t(`inventory.docType_${m.doc_type}`)}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-[#6c6760] dark:text-[#9aa4b2]">{m.actor_email}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
