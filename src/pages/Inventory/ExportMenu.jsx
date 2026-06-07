import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { STATUS_META, RESOLUTION_META, BATCH_STATUS_META, downloadCSV, daysSince, fmt } from './_shared'

// ─── Export Menu ───────────────────────────────────────────────────────────────
export function ExportMenu({ units, batches, warehouses, brandMap }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const wName = (id) => warehouses.find((w) => w.id === id)?.name || ''

  const exportAll = () => {
    downloadCSV(
      units.map((u) => ({
        'RMA #': u.rma_number || '',
        Product: u.product_name || '',
        Brand: brandMap[u.product_name] || '',
        'Serial #': u.serial_number || '',
        Warranty: u.warranty_status || '',
        Status: STATUS_META[u.status]?.label || u.status || '',
        Resolution: RESOLUTION_META[u.resolution_type]?.label || u.resolution_type || '',
        Warehouse: u.warehouse_id ? wName(u.warehouse_id) : 'System',
        Days: daysSince(u.created_date),
        'Date Added': fmt(u.created_date),
      })),
      `inventory-all-${new Date().toISOString().split('T')[0]}.csv`
    )
    setOpen(false)
  }

  const exportStock = () => {
    const stock = units.filter((u) => u.status === 'company_stock')
    downloadCSV(
      stock.map((u) => ({
        Product: u.product_name || '',
        Brand: brandMap[u.product_name] || '',
        'Serial #': u.serial_number || '',
        Warranty: u.warranty_status || '',
        Resolution: RESOLUTION_META[u.resolution_type]?.label || u.resolution_type || '',
        'Source RMA': u.rma_number || '',
        Warehouse: u.warehouse_id ? wName(u.warehouse_id) : 'System',
        'Days in Stock': daysSince(u.resolved_date || u.created_date),
      })),
      `company-stock-${new Date().toISOString().split('T')[0]}.csv`
    )
    setOpen(false)
  }

  const exportBatches = () => {
    downloadCSV(
      batches.map((b) => ({
        'Batch #': b.batch_number || '',
        Manufacturer: b.manufacturer_name || '',
        Status: BATCH_STATUS_META[b.status]?.label || b.status || '',
        'Unit Count': b.unit_count || 0,
        'Sent Date': fmt(b.sent_date),
        'Tracking #': b.tracking_number || '',
        Resolution: b.resolution_type || '',
        Created: fmt(b.created_date),
      })),
      `manufacturer-batches-${new Date().toISOString().split('T')[0]}.csv`
    )
    setOpen(false)
  }

  const exportWarehouses = () => {
    const rows = warehouses.map((w) => ({
      Name: w.name,
      Code: w.code || '',
      Location: w.location || '',
      Description: w.description || '',
      'Unit Count': units.filter((u) => u.warehouse_id === w.id).length,
      Active: w.is_active ? 'Yes' : 'No',
      Created: fmt(w.created_date),
    }))
    downloadCSV(rows, `warehouses-${new Date().toISOString().split('T')[0]}.csv`)
    setOpen(false)
  }

  const options = [
    {
      label: t('inventory.exportAllUnits'),
      sub: t('inventory.countUnits', { count: units.length }),
      fn: exportAll,
      icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    },
    {
      label: t('inventory.exportCompanyStock'),
      sub: t('inventory.countUnits', { count: units.filter((u) => u.status === 'company_stock').length }),
      fn: exportStock,
      icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
    },
    {
      label: t('inventory.exportMfBatches'),
      sub: t('inventory.countBatches', { count: batches.length }),
      fn: exportBatches,
      icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
    },
    {
      label: t('inventory.exportWarehouses'),
      sub: t('inventory.countWarehouses', { count: warehouses.length }),
      fn: exportWarehouses,
      icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
    },
  ]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        {t('common.export')}
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-xl border border-gray-200 shadow-xl z-30 py-1 overflow-hidden">
          <p className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
            {t('inventory.exportAsCSV')}
          </p>
          {options.map((o) => (
            <button
              key={o.label}
              onClick={o.fn}
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-indigo-50 transition-colors text-left"
            >
              <svg
                className="w-4 h-4 text-indigo-500 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={o.icon} />
              </svg>
              <div>
                <div className="text-sm font-medium text-gray-800">{o.label}</div>
                <div className="text-[11px] text-gray-500">{o.sub}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
