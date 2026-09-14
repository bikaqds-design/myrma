import React, { useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useURLTab } from '../../hooks/useURLTab'
import { supabase, db } from '../../api/supabaseClient'
import { PageSkeleton } from '../../components/Skeleton'
import { PageHeader, Button } from '../../components/ui'
import { ROLES } from '../../lib/constants'
import { groupByProduct } from './_shared'
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
  const { data: invData, isLoading: loading } = useQuery({
    queryKey: ['inventory'],
    queryFn: async () => {
      const [ur, br, brandList, productList, whRes, stockSummary, movesRes, wsRes] = await Promise.all([
        db.inventory.listUnits(),
        db.inventory.listBatches(),
        db.brands.list().catch(() => []),
        db.products.list().catch(() => []),
        db.warehouses.list().catch(() => ({ missing: true, data: [] })),
        db.inventory.getStockSummary().catch(() => []),
        db.stockMoves.list().catch(() => ({ missing: true, data: [] })),
        db.warehouseStock.list().catch(() => ({ missing: true, data: [] })),
      ])
      const map = {}
      for (const p of productList || [])
        if (p.product_name) map[p.product_name] = p.brand?.brand_name || ''
      return { ur, br, brandList, productList, brandMap: map, whRes, stockSummary, movesRes, wsRes }
    },
  })

  const tableMissing = invData?.ur?.missing ?? false
  const units = invData?.ur?.data ?? []
  const batches = invData?.br?.missing ? [] : (invData?.br?.data ?? [])
  const brands = invData?.brandList ?? []
  const brandMap = invData?.brandMap ?? {}
  const whMissing = invData?.whRes?.missing ?? false
  const warehouses = invData?.whRes?.data ?? []
  const stockSummary = invData?.stockSummary ?? []
  const stockMoves = invData?.movesRes?.missing ? [] : (invData?.movesRes?.data ?? [])
  const products = invData?.productList ?? []
  const warehouseStockRows = invData?.wsRes?.missing ? [] : (invData?.wsRes?.data ?? [])

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

  const allGroups = groupByProduct(units, brandMap)

  // The 5 RMA-stage tabs (received/under-repair/repaired/cant-repair/rma-stock)
  // were removed in the Warehouse Module R1 redesign — RMA units now live in
  // real system locations (RMA-RECEIVED etc.), surfaced on the Overview
  // dashboard's RMA column + drawer instead of derived from ticket JSONB here.
  const TAB_IDS = ['overview', 'by-product', 'stock-movements', 'warehouses']
  const tabs = [
    { id: 'overview', label: t('inventory.overview') },
    { id: 'by-product', label: `${t('inventory.allUnits')} (${units.length})` },
    { id: 'stock-movements', label: `${t('inventory.stockMovements')} (${stockMoves.length})` },
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
          <ExportMenu units={units} batches={batches} warehouses={warehouses} brandMap={brandMap} />
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
          stockSummary={stockSummary}
          onNavigate={setBreakdownProductId}
          units={units}
          warehouseStockRows={warehouseStockRows}
          warehouses={warehouses}
          userEmail={userEmail}
          isManagerOrAbove={isManagerOrAbove}
          onRefresh={invalidateInventory}
          onNavigateToTicket={onNavigateToTicket}
        />
      )}
      {activeTab === 'by-product' && (
        <ByProductTab
          groups={allGroups}
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
        <StockMovementsTab
          moves={stockMoves}
          units={units}
          warehouseStockRows={warehouseStockRows}
          products={products}
          warehouses={warehouses}
        />
      )}
      {activeTab === 'warehouses' && (
        <WarehousesTab
          units={units}
          warehouses={warehouses}
          whMissing={whMissing}
          brands={brands}
          brandMap={brandMap}
          userEmail={userEmail}
          canManage={canDo('manage_warehouses')}
          canTransfer={canDo('transfer')}
          onReload={invalidateInventory}
        />
      )}

      <StockBreakdownModal
        open={!!breakdownProductId}
        onClose={() => setBreakdownProductId(null)}
        productSummary={stockSummary.find((s) => s.product_id === breakdownProductId) ?? null}
        product={products.find((p) => p.id === breakdownProductId) ?? null}
        units={units}
        warehouseStockRows={warehouseStockRows}
        warehouses={warehouses}
        moves={stockMoves}
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
