import React, { useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useURLTab } from '../../hooks/useURLTab'
import { supabase, db } from '../../api/supabaseClient'
import { StatCardSkeleton, CardSkeleton } from '../../components/Skeleton'
import { PageHeader } from '../../components/ui'
import AIAssist from '../../components/AIAssist'
import { ROLES } from '../../lib/constants'
import { groupByProduct } from './_shared'
import { ExportMenu } from './ExportMenu'
import { ProductStatusTab } from './ProductStatusTab'
import { OverviewTab } from './OverviewTab'
import { ByProductTab } from './ByProductTab'
import { WarehousesTab } from './WarehousesTab'
// xlsx and jspdf are loaded on-demand (A-7: lazy heavy deps)

// ─── Main Inventory Component ──────────────────────────────────────────────────
export default function Inventory({ userRole, userEmail, userPermissions, onNavigateToTicket }) {
  const { t } = useTranslation()
  const canDo = (a) =>
    userRole === ROLES.ADMIN || userRole === ROLES.SUPER_ADMIN
      ? true
      : userPermissions?.inventory?.[a] === true

  const queryClient = useQueryClient()
  const { data: invData, isLoading: loading } = useQuery({
    queryKey: ['inventory'],
    queryFn: async () => {
      const [ur, br, sr, brandList, productList, whRes, tkRes] = await Promise.all([
        db.inventory.listUnits(),
        db.inventory.listBatches(),
        db.inventory.getStats(),
        db.brands.list().catch(() => []),
        db.products.list().catch(() => []),
        db.warehouses.list().catch(() => ({ missing: true, data: [] })),
        supabase
          .from('rma_tickets')
          .select('id,rma_number,ticket_status,customer_name,assigned_technician,created_date,products')
          .then((r) => r.data || []),
      ])
      const map = {}
      for (const p of productList || [])
        if (p.product_name) map[p.product_name] = p.brand?.brand_name || ''
      return { ur, br, sr, brandList, brandMap: map, whRes, tkRes }
    },
  })

  const tableMissing = invData?.ur?.missing ?? false
  const units = invData?.ur?.data ?? []
  const batches = invData?.br?.missing ? [] : (invData?.br?.data ?? [])
  const stats = invData?.sr ?? null
  const brands = invData?.brandList ?? []
  const brandMap = invData?.brandMap ?? {}
  const whMissing = invData?.whRes?.missing ?? false
  const warehouses = invData?.whRes?.data ?? []
  const rmaTickets = invData?.tkRes ?? []

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

  if (loading)
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="h-8 w-32 animate-pulse bg-gray-200 rounded-lg" />
          <div className="h-4 w-56 animate-pulse bg-gray-200 rounded-lg" />
        </div>
        <StatCardSkeleton count={4} />
        <CardSkeleton lines={6} />
      </div>
    )

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
            <h2 className="text-base font-semibold text-amber-900">Database Setup Required</h2>
            <p className="text-sm text-amber-800 mt-0.5">
              Run the SQL below in your Supabase SQL Editor, then click Retry.
            </p>
          </div>
        </div>
        <pre className="bg-amber-100 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 overflow-x-auto whitespace-pre">{`CREATE TABLE IF NOT EXISTS inventory_units (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  rma_ticket_id UUID, rma_number TEXT, product_name TEXT, serial_number TEXT,\n  warranty_status TEXT, status TEXT DEFAULT 'active_rma', resolution_type TEXT,\n  resolved_date TIMESTAMPTZ, manufacturer_batch_id UUID, notes TEXT,\n  created_date TIMESTAMPTZ DEFAULT now()\n);\n\nCREATE TABLE IF NOT EXISTS manufacturer_batches (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  batch_number TEXT UNIQUE, manufacturer_name TEXT, status TEXT DEFAULT 'draft',\n  sent_date DATE, tracking_number TEXT, resolution_type TEXT, resolution_date DATE,\n  resolution_notes TEXT, unit_count INT DEFAULT 0,\n  created_date TIMESTAMPTZ DEFAULT now(), created_by TEXT\n);`}</pre>
        <button
          onClick={invalidateInventory}
          className="px-5 py-2 bg-amber-600 text-white rounded-xl text-sm font-medium hover:bg-amber-700"
        >
          Retry
        </button>
      </div>
    )

  const stockUnits = units.filter((u) => u.status === 'company_stock')
  const allGroups = groupByProduct(units, brandMap)
  const _stockGroups = groupByProduct(stockUnits, brandMap)

  // Inventory logic per ticket + product status:
  // Cancelled tickets           → removed from all inventory tabs
  // Completed + Received/UnderRepair/Repaired/CantRepair → removed from all inventory tabs
  // Completed + Replacement/CreditNote → kept in RMA Stock
  // New/InProgress/OnHold + any product status → shown in the matching inventory tab
  const flatProducts = rmaTickets
    .filter((t) => t.ticket_status !== 'Cancelled')
    .flatMap((t) =>
      (t.products || []).map((p) => ({
        ...p,
        ticket_id: t.id,
        rma_number: t.rma_number,
        customer_name: t.customer_name,
        ticket_status: t.ticket_status,
        assigned_technician: t.assigned_technician,
        created_date: t.created_date,
      }))
    )
    .filter((p) => {
      // Completed tickets: only Replacement/CreditNote remain in inventory (RMA Stock)
      if (p.ticket_status === 'Completed') {
        return p.product_status === 'Replacement' || p.product_status === 'Credit Note'
      }
      return true
    })

  // Active-only tabs (New / In Progress / On Hold)
  const receivedProds = flatProducts.filter(
    (p) => p.ticket_status !== 'Completed' && (p.product_status === 'Received' || !p.product_status)
  )
  const underRepairProds = flatProducts.filter(
    (p) => p.ticket_status !== 'Completed' && p.product_status === 'Under Repair'
  )
  const repairedProds = flatProducts.filter(
    (p) => p.ticket_status !== 'Completed' && p.product_status === 'Repaired'
  )
  const cantRepairProds = flatProducts.filter(
    (p) => p.ticket_status !== 'Completed' && p.product_status === "Can't Repair"
  )

  // Build a set of unit keys that have already been transferred to a warehouse
  const transferredKeys = new Set(
    units
      .filter((u) => u.warehouse_id)
      .map((u) => `${u.rma_ticket_id}||${u.serial_number || u.product_name}`)
  )
  const rmaStockProds = flatProducts.filter((p) => {
    if (p.product_status !== 'Replacement' && p.product_status !== 'Credit Note') return false
    const key = `${p.ticket_id}||${p.serial_number || p.product_name}`
    return !transferredKeys.has(key)
  })

  const tabs = [
    { id: 'overview', label: t('inventory.overview') },
    { id: 'by-product', label: `${t('inventory.allUnits')} (${units.length})` },
    { id: 'received', label: `${t('inventory.received')} (${receivedProds.length})` },
    { id: 'under-repair', label: `${t('inventory.underRepair')} (${underRepairProds.length})` },
    { id: 'repaired', label: `${t('inventory.repaired')} (${repairedProds.length})` },
    { id: 'cant-repair', label: `${t('inventory.cantRepair')} (${cantRepairProds.length})` },
    { id: 'rma-stock', label: `${t('inventory.rmaStock')} (${rmaStockProds.length})` },
    { id: 'warehouses', label: `${t('inventory.warehouses')} (${warehouses.length})` },
  ]

  return (
    <div className="space-y-6">
      <PageHeader title={t('inventory.title')} subtitle={t('inventory.subtitle')}>
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

      <AIAssist
        contextType="dashboard"
        data={{
          range: 'Current inventory snapshot',
          open: stats?.total ?? units.length,
          in_progress: units.filter((u) => u.status === 'Under Repair').length,
          pending: units.filter((u) => u.status === 'Received').length,
          overdue: units.filter((u) => u.status === "Can't Repair").length,
          resolved: units.filter((u) => u.status === 'Repaired').length,
          total: units.length,
          sla_percent: 100,
          resolution_rate: units.length ? Math.round((units.filter((u) => u.status === 'Repaired').length / units.length) * 100) : 0,
        }}
      />

      <div className="border-b border-gray-200 dark:border-[#212a38]">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab === t.id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:text-[#e8ebf0]'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' && (
        <OverviewTab
          stats={stats}
          units={units}
          brands={brands}
          brandMap={brandMap}
          onNavigate={setTab}
        />
      )}
      {tab === 'by-product' && (
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
      {tab === 'received' && (
        <ProductStatusTab
          products={receivedProds}
          brandMap={brandMap}
          onNavigateToTicket={onNavigateToTicket}
        />
      )}
      {tab === 'under-repair' && (
        <ProductStatusTab
          products={underRepairProds}
          brandMap={brandMap}
          onNavigateToTicket={onNavigateToTicket}
        />
      )}
      {tab === 'repaired' && (
        <ProductStatusTab
          products={repairedProds}
          brandMap={brandMap}
          onNavigateToTicket={onNavigateToTicket}
        />
      )}
      {tab === 'cant-repair' && (
        <ProductStatusTab
          products={cantRepairProds}
          brandMap={brandMap}
          onNavigateToTicket={onNavigateToTicket}
        />
      )}
      {tab === 'rma-stock' && (
        <ProductStatusTab
          products={rmaStockProds}
          showTypeCol
          brandMap={brandMap}
          onNavigateToTicket={onNavigateToTicket}
          warehouses={warehouses}
          units={units}
          canTransfer={canDo('transfer')}
          userEmail={userEmail}
          onReload={invalidateInventory}
        />
      )}
      {tab === 'warehouses' && (
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
    </div>
  )
}
