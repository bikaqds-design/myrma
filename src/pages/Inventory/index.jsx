import React, { useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useURLTab } from '../../hooks/useURLTab'
import { supabase, db } from '../../api/supabaseClient'
import { PageSkeleton } from '../../components/Skeleton'
import { PageHeader, Button } from '../../components/ui'
import { ROLES } from '../../lib/constants'
import { ExportMenu } from './ExportMenu'
import { OverviewTab } from './OverviewTab'
import { ByProductTab } from './ByProductTab'
import { WarehousesTab } from './WarehousesTab'
import { StockMovementsTab } from './StockMovementsTab'
import { StockBreakdownModal } from './StockBreakdownModal'
import { ReceiveStockModal } from './ReceiveStockModal'
// xlsx and jspdf are loaded on-demand (A-7: lazy heavy deps)

const MANAGER_OR_ABOVE = [ROLES.MANAGER, ROLES.ADMIN, ROLES.SUPER_ADMIN]

// ─── Main Inventory Component ──────────────────────────────────────────────────
export default function Inventory({ userRole, userEmail, userPermissions, onNavigateToTicket }) {
  const { t } = useTranslation()
  const canDo = (a) =>
    userRole === ROLES.ADMIN || userRole === ROLES.SUPER_ADMIN
      ? true
      : userPermissions?.inventory?.[a] === true
  const isManagerOrAbove = MANAGER_OR_ABOVE.includes(userRole)
  const [breakdownProductId, setBreakdownProductId] = useState(null)
  const [showReceiveStock, setShowReceiveStock] = useState(false)

  const queryClient = useQueryClient()
  // The shell loads only what every tab shares: the warehouses (a short
  // configuration list), the brands for the filter, and counts. Each tab reads
  // its own rows a page at a time. This used to load every unit, stock move,
  // stock row and product here, which the Data API caps at 1 000 rows. All
  // keys start with 'inventory', so one invalidation refreshes every tab.
  // (BUG-066.)
  const { data: shell, isLoading: loading } = useQuery({
    queryKey: ['inventory', 'shell'],
    queryFn: async () => {
      const [whRes, brandList, unitCount, moveCount, unitCounts] = await Promise.all([
        db.warehouses.list().catch(() => ({ missing: true, data: [] })),
        db.brands.list().catch(() => []),
        db.inventoryLists.countUnits().then(
          (count) => ({ missing: false, count }),
          (err) => {
            if (err?.code === '42P01' || err?.code === 'PGRST205') return { missing: true, count: 0 }
            throw err
          }
        ),
        db.inventoryLists.countMoves().catch(() => 0),
        db.inventoryLists.warehouseUnitCounts().catch(() => ({})),
      ])
      return { whRes, brandList, unitCount, moveCount, unitCounts }
    },
  })

  const tableMissing = shell?.unitCount?.missing ?? false
  const unitTotal = shell?.unitCount?.count ?? 0
  const moveTotal = shell?.moveCount ?? 0
  const brands = shell?.brandList ?? []
  const whMissing = shell?.whRes?.missing ?? false
  const warehouses = shell?.whRes?.data ?? []
  const unitCounts = shell?.unitCounts ?? {}

  const [tab, setTab] = useURLTab('tab', 'overview')

  const invalidateInventory = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['inventory'] }),
    [queryClient]
  )

  // Real-time: refresh when inventory_units or rma_tickets change
  useEffect(() => {
    const channel = supabase
      .channel('inventory_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_units' }, invalidateInventory)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rma_tickets' }, invalidateInventory)
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [invalidateInventory])

  if (loading) return <PageSkeleton cols={7} />

  if (tableMissing)
    return (
      <div className="max-w-3xl mx-auto mt-10 bg-amber-50 border border-amber-200 rounded-2xl p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 bg-amber-200 rounded-xl flex items-center justify-center flex-shrink-0">
            <svg
              className="w-5 h-5 text-amber-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-amber-900">{t('inventory.databaseSetupRequired')}</h2>
            <p className="text-sm text-amber-800 mt-0.5">
              {t('inventory.databaseSetupHint')}
            </p>
          </div>
        </div>
        <pre className="bg-amber-100 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 overflow-x-auto whitespace-pre">{`CREATE TABLE IF NOT EXISTS inventory_units (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  rma_ticket_id UUID, rma_number TEXT, product_name TEXT, serial_number TEXT,\n  warranty_status TEXT, status TEXT DEFAULT 'active_rma', resolution_type TEXT,\n  resolved_date TIMESTAMPTZ, manufacturer_batch_id UUID, notes TEXT,\n  created_date TIMESTAMPTZ DEFAULT now()\n);\n\nCREATE TABLE IF NOT EXISTS manufacturer_batches (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  batch_number TEXT UNIQUE, manufacturer_name TEXT, status TEXT DEFAULT 'draft',\n  sent_date DATE, tracking_number TEXT, resolution_type TEXT, resolution_date DATE,\n  resolution_notes TEXT, unit_count INT DEFAULT 0,\n  created_date TIMESTAMPTZ DEFAULT now(), created_by TEXT\n);`}</pre>
        <button
          onClick={invalidateInventory}
          className="px-5 py-2 bg-amber-600 text-white rounded-xl text-sm font-medium hover:bg-amber-700"
        >
          {t('common.refresh')}
        </button>
      </div>
    )

  // The 5 RMA-stage tabs (received/under-repair/repaired/cant-repair/rma-stock)
  // were removed in the Warehouse Module R1 redesign — RMA units now live in
  // real system locations (RMA-RECEIVED etc.), surfaced on the Overview
  // dashboard's RMA column + drawer instead of derived from ticket JSONB here.
  const TAB_IDS = ['overview', 'by-product', 'stock-movements', 'warehouses']
  const tabs = [
    { id: 'overview', label: t('inventory.overview') },
    { id: 'by-product', label: `${t('inventory.allUnits')} (${unitTotal})` },
    { id: 'stock-movements', label: `${t('inventory.stockMovements')} (${moveTotal})` },
    { id: 'warehouses', label: `${t('inventory.warehouses')} (${warehouses.length})` },
  ]
  // Stale deep links (e.g. ?tab=received from a bookmarked old URL) fall back
  // to the dashboard rather than rendering a blank page.
  const activeTab = TAB_IDS.includes(tab) ? tab : 'overview'

  return (
    <div className="space-y-6">
      <PageHeader title={t('inventory.title')} subtitle={t('inventory.subtitle')}>
        {isManagerOrAbove && (
          <Button variant="primary" size="sm" onClick={() => setShowReceiveStock(true)}>
            {t('inventory.receiveStockButton')}
          </Button>
        )}
        {canDo('export') && (
          <ExportMenu warehouses={warehouses} unitCounts={unitCounts} />
        )}
        <button
          onClick={invalidateInventory}
          className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 dark:border-[#212a38] rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          {t('common.refresh')}
        </button>
      </PageHeader>

      <div className="border-b border-gray-200 dark:border-[#212a38]">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${activeTab === tb.id ? 'border-[#4338ca] text-[#4338ca] dark:border-[#a5b4fc] dark:text-[#a5b4fc]' : 'border-transparent text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]'}`}
            >
              {tb.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && (
        <OverviewTab
          onNavigate={setBreakdownProductId}
          warehouses={warehouses}
          userEmail={userEmail}
          isManagerOrAbove={isManagerOrAbove}
          onRefresh={invalidateInventory}
          onNavigateToTicket={onNavigateToTicket}
        />
      )}
      {activeTab === 'by-product' && (
        <ByProductTab
          brands={brands}
          warehouses={warehouses}
          canResolve={canDo('resolve_units')}
          canTransfer={canDo('transfer')}
          userEmail={userEmail}
          onReload={invalidateInventory}
          onNavigateToTicket={onNavigateToTicket}
        />
      )}
      {activeTab === 'stock-movements' && (
        <StockMovementsTab />
      )}
      {activeTab === 'warehouses' && (
        <WarehousesTab
          unitCounts={unitCounts}
          warehouses={warehouses}
          whMissing={whMissing}
          userEmail={userEmail}
          canManage={canDo('manage_warehouses')}
          canTransfer={canDo('transfer')}
          onReload={invalidateInventory}
        />
      )}

      <StockBreakdownModal
        open={!!breakdownProductId}
        onClose={() => setBreakdownProductId(null)}
        productId={breakdownProductId}
        warehouses={warehouses}
        userEmail={userEmail}
        isManagerOrAbove={isManagerOrAbove}
        onRefresh={invalidateInventory}
      />

      <ReceiveStockModal
        open={showReceiveStock}
        onClose={() => setShowReceiveStock(false)}
        warehouses={warehouses}
        userEmail={userEmail}
        onSuccess={invalidateInventory}
      />
    </div>
  )
}
