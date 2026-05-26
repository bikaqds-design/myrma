import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useURLTab } from '../hooks/useURLTab'
import { supabase, db } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import ConfirmDialog from '../components/ConfirmDialog'
import { StatCardSkeleton, CardSkeleton } from '../components/Skeleton'
import { Spinner, PageHeader } from '../components/ui'
import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'

// ─── Constants ─────────────────────────────────────────────────────────────────
const STATUS_META = {
  active_rma:           { label: 'Active RMA',   cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  company_stock:        { label: 'Company Stock', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  sent_to_manufacturer: { label: 'Sent to Mfr',  cls: 'bg-purple-100 text-purple-700 border-purple-200' },
  closed:               { label: 'Closed',        cls: 'bg-gray-100 text-gray-500 border-gray-200' },
}
const RESOLUTION_META = {
  return_to_customer: { label: 'Return to Customer', cls: 'bg-green-100 text-green-700' },
  credit_note:        { label: 'Credit Note',         cls: 'bg-orange-100 text-orange-700' },
  replacement:        { label: 'Replacement',         cls: 'bg-indigo-100 text-indigo-700' },
  can_t_repair:       { label: "Can't Repair",        cls: 'bg-red-100 text-red-700' },
}
const BATCH_STATUS_META = {
  draft:    { label: 'Draft',    cls: 'bg-gray-100 text-gray-600' },
  sent:     { label: 'Sent',     cls: 'bg-blue-100 text-blue-700' },
  resolved: { label: 'Resolved', cls: 'bg-green-100 text-green-700' },
}
const SYSTEM_WAREHOUSES = [
  { id: '__active_rma',           name: 'Active RMA',           status: 'active_rma',           cls: 'bg-blue-50 border-blue-200',     tc: 'text-blue-700',   icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
  { id: '__company_stock',        name: 'Company Stock',         status: 'company_stock',        cls: 'bg-amber-50 border-amber-200',   tc: 'text-amber-700',  icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
  { id: '__sent_to_manufacturer', name: 'Sent to Manufacturer', status: 'sent_to_manufacturer', cls: 'bg-purple-50 border-purple-200', tc: 'text-purple-700', icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4' },
  { id: '__closed',               name: 'Closed',                status: 'closed',               cls: 'bg-gray-50 border-gray-200',     tc: 'text-gray-600',   icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
]
const WAREHOUSE_SQL = `-- Run in Supabase SQL Editor to enable warehouses:

CREATE TABLE IF NOT EXISTS warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT,
  description TEXT,
  location TEXT,
  is_active BOOLEAN DEFAULT true,
  created_date TIMESTAMPTZ DEFAULT now(),
  created_by TEXT
);

ALTER TABLE inventory_units
  ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL;`

// Product statuses that map to inventory tabs

const PRODUCT_STATUS_CLS = {
  'Received':     'bg-gray-100 text-gray-700',
  'Under Repair': 'bg-amber-100 text-amber-700',
  'Repaired':     'bg-green-100 text-green-700',
  "Can't Repair": 'bg-red-100 text-red-700',
  'Replacement':  'bg-indigo-100 text-indigo-700',
  'Credit Note':  'bg-orange-100 text-orange-700',
}
const TICKET_STATUS_CLS = {
  New: 'bg-blue-100 text-blue-700',
  'In Progress': 'bg-yellow-100 text-yellow-700',
  'On Hold': 'bg-orange-100 text-orange-700',
  Completed: 'bg-green-100 text-green-700',
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function daysSince(iso) {
  if (!iso) return 0
  return Math.floor((Date.now() - new Date(iso)) / 86400000)
}
function fmt(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function groupByProduct(units, brandMap) {
  const map = {}
  for (const u of units) {
    const key = u.product_name || 'Unknown Product'
    if (!map[key]) map[key] = { product_name: key, brand: brandMap[key] || '', units: [], active_rma: 0, company_stock: 0, sent_to_manufacturer: 0, closed: 0, replacement: 0, credit_note: 0 }
    map[key].units.push(u)
    if (map[key][u.status] !== undefined) map[key][u.status]++
    if (u.status === 'company_stock') {
      if (u.resolution_type === 'replacement') map[key].replacement++
      else map[key].credit_note++
    }
  }
  return Object.values(map).sort((a, b) => {
    const bc = (a.brand || '').localeCompare(b.brand || '')
    return bc !== 0 ? bc : a.product_name.localeCompare(b.product_name)
  })
}
function downloadCSV(rows, filename) {
  if (!rows.length) { toast('No data to export'); return }
  const headers = Object.keys(rows[0])
  const escape = v => { const s = String(v ?? '').replace(/"/g, '""'); return s.includes(',') || s.includes('\n') || s.includes('"') ? `"${s}"` : s }
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\r\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
  toast.success(`Exported ${rows.length} rows`)
}

// ─── Pagination ────────────────────────────────────────────────────────────────
function Pagination({ total, page, itemsPerPage, setItemsPerPage, onPage }) {
  const pages = Math.ceil(total / itemsPerPage)
  const startIndex = (page - 1) * itemsPerPage
  return (
    <div className="flex items-center justify-between text-sm text-gray-600 pt-2">
      <div>Showing {total === 0 ? 0 : startIndex + 1}–{Math.min(startIndex + itemsPerPage, total)} of {total}</div>
      <div className="flex items-center gap-2">
        <label className="text-sm text-gray-600">Per page:</label>
        <select value={itemsPerPage} onChange={e => { setItemsPerPage(parseInt(e.target.value)); onPage(1) }}
          className="px-3 py-1 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 text-sm">
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
        {pages > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page === 1}
              className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">← Prev</button>
            {Array.from({length: pages}, (_, i) => i + 1).filter(p => p === 1 || p === pages || Math.abs(p - page) <= 1).reduce((acc, p, i, arr) => {
              if (i > 0 && p - arr[i-1] > 1) acc.push('…')
              acc.push(p); return acc
            }, []).map((p, i) => p === '…'
              ? <span key={`e${i}`} className="px-1 text-gray-500 text-xs">…</span>
              : <button key={p} onClick={() => onPage(p)} className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${p === page ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>{p}</button>
            )}
            <button onClick={() => onPage(Math.min(pages, page + 1))} disabled={page === pages}
              className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">Next →</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Shared UI Atoms ──────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const m = STATUS_META[status] || { label: status, cls: 'bg-gray-100 text-gray-500 border-gray-200' }
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${m.cls}`}>{m.label}</span>
}
function ResolutionBadge({ type }) {
  if (!type) return <span className="text-gray-500 text-xs">—</span>
  const m = RESOLUTION_META[type] || { label: type, cls: 'bg-gray-100 text-gray-600' }
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${m.cls}`}>{m.label}</span>
}
function WarrantyBadge({ status }) {
  if (!status) return <span className="text-gray-500 text-xs">—</span>
  const cls = status === 'In Warranty' ? 'bg-green-100 text-green-700' : status === 'Unknown' ? 'bg-gray-100 text-gray-500' : 'bg-red-100 text-red-700'
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{status}</span>
}
function BrandAvatar({ name, size = 'md' }) {
  const palette = ['bg-blue-500','bg-indigo-500','bg-violet-500','bg-purple-500','bg-pink-500','bg-rose-500','bg-orange-500','bg-amber-500','bg-teal-500','bg-cyan-500']
  const color = palette[(name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % palette.length]
  const sz = size === 'lg' ? 'w-12 h-12 text-base' : size === 'md' ? 'w-9 h-9 text-sm' : size === 'sm' ? 'w-7 h-7 text-xs' : 'w-5 h-5 text-[10px]'
  return <div className={`${sz} ${color} rounded-xl flex items-center justify-center flex-shrink-0 text-white font-bold`}>{(name || '?')[0].toUpperCase()}</div>
}

// ─── Brand Filter Bar ──────────────────────────────────────────────────────────
function BrandBar({ brands, groups, selected, onSelect }) {
  const brandUnitCount = {}
  for (const g of groups) brandUnitCount[g.brand] = (brandUnitCount[g.brand] || 0) + g.units.length
  const total = groups.reduce((s, g) => s + g.units.length, 0)
  const chip = (isActive) => `flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-sm font-medium whitespace-nowrap transition-all ${isActive ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600'}`
  const cnt = (isActive, n) => <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isActive ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'}`}>{n}</span>
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 flex-wrap">
      <button onClick={() => onSelect(null)} className={chip(!selected)}> All Brands {cnt(!selected, total)}</button>
      {brands.map(b => { const isA = selected === b.brand_name; return (
        <button key={b.id} onClick={() => onSelect(isA ? null : b.brand_name)} className={chip(isA)}>
          <BrandAvatar name={b.brand_name} size="xs" />{b.brand_name}{cnt(isA, brandUnitCount[b.brand_name] || 0)}
        </button>
      )})}
    </div>
  )
}

// ─── Export Menu ───────────────────────────────────────────────────────────────
function ExportMenu({ units, batches, warehouses, brandMap }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const wName = id => warehouses.find(w => w.id === id)?.name || ''

  const exportAll = () => {
    downloadCSV(units.map(u => ({
      'RMA #': u.rma_number || '',
      'Product': u.product_name || '',
      'Brand': brandMap[u.product_name] || '',
      'Serial #': u.serial_number || '',
      'Warranty': u.warranty_status || '',
      'Status': STATUS_META[u.status]?.label || u.status || '',
      'Resolution': RESOLUTION_META[u.resolution_type]?.label || u.resolution_type || '',
      'Warehouse': u.warehouse_id ? wName(u.warehouse_id) : 'System',
      'Days': daysSince(u.created_date),
      'Date Added': fmt(u.created_date),
    })), `inventory-all-${new Date().toISOString().split('T')[0]}.csv`)
    setOpen(false)
  }

  const exportStock = () => {
    const stock = units.filter(u => u.status === 'company_stock')
    downloadCSV(stock.map(u => ({
      'Product': u.product_name || '',
      'Brand': brandMap[u.product_name] || '',
      'Serial #': u.serial_number || '',
      'Warranty': u.warranty_status || '',
      'Resolution': RESOLUTION_META[u.resolution_type]?.label || u.resolution_type || '',
      'Source RMA': u.rma_number || '',
      'Warehouse': u.warehouse_id ? wName(u.warehouse_id) : 'System',
      'Days in Stock': daysSince(u.resolved_date || u.created_date),
    })), `company-stock-${new Date().toISOString().split('T')[0]}.csv`)
    setOpen(false)
  }

  const exportBatches = () => {
    downloadCSV(batches.map(b => ({
      'Batch #': b.batch_number || '',
      'Manufacturer': b.manufacturer_name || '',
      'Status': BATCH_STATUS_META[b.status]?.label || b.status || '',
      'Unit Count': b.unit_count || 0,
      'Sent Date': fmt(b.sent_date),
      'Tracking #': b.tracking_number || '',
      'Resolution': b.resolution_type || '',
      'Created': fmt(b.created_date),
    })), `manufacturer-batches-${new Date().toISOString().split('T')[0]}.csv`)
    setOpen(false)
  }

  const exportWarehouses = () => {
    const rows = warehouses.map(w => ({
      'Name': w.name,
      'Code': w.code || '',
      'Location': w.location || '',
      'Description': w.description || '',
      'Unit Count': units.filter(u => u.warehouse_id === w.id).length,
      'Active': w.is_active ? 'Yes' : 'No',
      'Created': fmt(w.created_date),
    }))
    downloadCSV(rows, `warehouses-${new Date().toISOString().split('T')[0]}.csv`)
    setOpen(false)
  }

  const options = [
    { label: 'All Inventory Units', sub: `${units.length} units`, fn: exportAll, icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
    { label: 'Company Stock', sub: `${units.filter(u => u.status === 'company_stock').length} units`, fn: exportStock, icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4' },
    { label: 'Manufacturer Batches', sub: `${batches.length} batches`, fn: exportBatches, icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
    { label: 'Warehouses', sub: `${warehouses.length} warehouses`, fn: exportWarehouses, icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4' },
  ]

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
        Export
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-xl border border-gray-200 shadow-xl z-30 py-1 overflow-hidden">
          <p className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Export as CSV</p>
          {options.map(o => (
            <button key={o.label} onClick={o.fn}
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-indigo-50 transition-colors text-left">
              <svg className="w-4 h-4 text-indigo-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={o.icon}/></svg>
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

// ─── Inventory Sort Button ────────────────────────────────────────────────────
function InvSortBtn({ label, sortKey, activeSortKey, activeSortDir, onSort }) {
  const isActive = activeSortKey === sortKey
  return (
    <button onClick={() => onSort(sortKey)} className="flex items-center gap-1 hover:text-gray-900 transition-colors">
      {label}
      {isActive
        ? activeSortDir === 'asc'
          ? <svg className="w-3 h-3 text-indigo-600 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7"/></svg>
          : <svg className="w-3 h-3 text-indigo-600 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
        : <svg className="w-3 h-3 text-gray-300 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"/></svg>
      }
    </button>
  )
}

// ─── Product Status Tab (Received / Under Repair / Repaired / Can't Repair / RMA Stock) ──
function ProductStatusTab({ products, showTypeCol, brandMap = {}, onNavigateToTicket, warehouses = [], units = [], canTransfer = false, userEmail, onReload }) {
  const [search, setSearch]                               = useState('')
  const [filterProduct, setFilterProduct]                 = useState('')
  const [filterBrand, setFilterBrand]                     = useState('')
  const [filterProductStatus, setFilterProductStatus]     = useState('')
  const [filterRmaStatus, setFilterRmaStatus]             = useState('')
  const [showFilters, setShowFilters]                     = useState(false)
  const [sortKey, setSortKey]                             = useState('product_name')
  const [sortDir, setSortDir]                             = useState('asc')
  const [currentPage, setCurrentPage]                     = useState(1)
  const [itemsPerPage, setItemsPerPage]                   = useState(25)
  const [expanded, setExpanded]                           = useState(new Set())
  const [selectedGroups, setSelectedGroups]               = useState([])
  const [showTransfer, setShowTransfer]                   = useState(false)
  const [transferring, setTransferring]                   = useState(false)

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }
  const toggleExpand = (name) => setExpanded(prev => {
    const next = new Set(prev); next.has(name) ? next.delete(name) : next.add(name); return next
  })
  const toggleSelect = (name) => setSelectedGroups(prev =>
    prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]
  )

  const grouped = useMemo(() => {
    const map = {}
    for (const p of products) {
      const key = p.product_name || 'Unknown Product'
      if (!map[key]) map[key] = { product_name: key, qty: 0, in_warranty: 0, out_warranty: 0, items: [], latest_date: null }
      map[key].qty++
      if (p.warranty_status === 'In Warranty') map[key].in_warranty++
      else map[key].out_warranty++
      map[key].items.push(p)
      const d = p.status_date || p.created_date
      if (d && (!map[key].latest_date || d > map[key].latest_date)) map[key].latest_date = d
    }
    return Object.values(map)
  }, [products])

  // Match selected product groups to inventory_units rows for transfer
  const { selectedUnitIds, expectedUnitCount } = useMemo(() => {
    if (!canTransfer || !units.length) return { selectedUnitIds: [], expectedUnitCount: 0 }
    const unitMap = {}
    for (const u of units) {
      const key = `${u.rma_ticket_id}||${u.serial_number || u.product_name}`
      unitMap[key] = u.id
    }
    const targetItems = grouped
      .filter(g => selectedGroups.includes(g.product_name))
      .flatMap(g => g.items)
    const ids = targetItems
      .map(p => unitMap[`${p.ticket_id}||${p.serial_number || p.product_name}`])
      .filter(Boolean)
    return { selectedUnitIds: ids, expectedUnitCount: targetItems.length }
  }, [selectedGroups, grouped, units, canTransfer])

  const handleBulkTransfer = async (warehouseId) => {
    if (!selectedUnitIds.length) { toast.error('No matching units found in inventory'); return }
    const skipped = expectedUnitCount - selectedUnitIds.length
    if (skipped > 0 && !window.confirm(`${skipped} of ${expectedUnitCount} selected unit${expectedUnitCount !== 1 ? 's' : ''} are not tracked in inventory and will be skipped. Transfer the remaining ${selectedUnitIds.length}?`)) return
    setTransferring(true)
    try {
      await db.inventory.transferUnits(selectedUnitIds, warehouseId)
      toast.success(`${selectedUnitIds.length} unit${selectedUnitIds.length !== 1 ? 's' : ''} transferred${skipped > 0 ? ` (${skipped} skipped)` : ''}`)
      db.auditLog.log(userEmail, 'inventory_units_transferred', `Transferred ${selectedUnitIds.length} unit${selectedUnitIds.length !== 1 ? 's' : ''} to warehouse ${warehouseId}`).catch(() => {})
      setSelectedGroups([])
      setShowTransfer(false)
      onReload?.()
    } catch { toast.error('Transfer failed') }
    finally { setTransferring(false) }
  }

  const uniqueBrands   = useMemo(() => [...new Set(products.map(p => brandMap[p.product_name]).filter(Boolean))].sort(), [products, brandMap])
  const uniqueStatuses = useMemo(() => [...new Set(products.map(p => p.product_status).filter(Boolean))].sort(), [products])

  const activeFilterCount = [filterProduct, filterBrand, filterProductStatus, filterRmaStatus].filter(Boolean).length

  const filtered = useMemo(() => {
    let list = [...grouped]
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(g =>
        g.product_name.toLowerCase().includes(q) ||
        g.items.some(p =>
          p.rma_number?.toLowerCase().includes(q) ||
          p.customer_name?.toLowerCase().includes(q) ||
          p.serial_number?.toLowerCase().includes(q)
        )
      )
    }
    if (filterProduct)       list = list.filter(g => g.product_name.toLowerCase().includes(filterProduct.toLowerCase()))
    if (filterBrand)         list = list.filter(g => brandMap[g.product_name] === filterBrand)
    if (filterProductStatus) list = list.filter(g => g.items.some(p => p.product_status === filterProductStatus))
    if (filterRmaStatus)     list = list.filter(g => g.items.some(p => p.ticket_status === filterRmaStatus))
    return list.sort((a, b) => {
      const av = sortKey === 'qty' ? a.qty : a.product_name.toLowerCase()
      const bv = sortKey === 'qty' ? b.qty : b.product_name.toLowerCase()
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [grouped, search, filterProduct, filterBrand, filterProductStatus, filterRmaStatus, sortKey, sortDir, brandMap])

  useEffect(() => { setCurrentPage(1) }, [search, filterProduct, filterBrand, filterProductStatus, filterRmaStatus, sortKey, sortDir, products])

  const startIndex  = (currentPage - 1) * itemsPerPage
  const paginated   = filtered.slice(startIndex, startIndex + itemsPerPage)
  const fmtDate     = d => d ? new Date(d).toLocaleDateString() : '—'
  const colSpanData = showTypeCol ? 6 : 5
  const pageNames   = paginated.map(g => g.product_name)
  const allPageChk  = pageNames.length > 0 && pageNames.every(n => selectedGroups.includes(n))

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search product, RMA#, customer, serial…"
            className="w-full pl-9 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
          <svg className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        </div>
        <button onClick={() => setShowFilters(f => !f)}
          className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm transition-colors ${showFilters || activeFilterCount > 0 ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"/></svg>
          Filters
          {activeFilterCount > 0 && <span className="w-4 h-4 bg-indigo-600 text-white text-[10px] rounded-full flex items-center justify-center">{activeFilterCount}</span>}
        </button>
        <span className="text-xs text-gray-500 ml-auto whitespace-nowrap">
          {filtered.length} product{filtered.length !== 1 ? 's' : ''} · {products.length} unit{products.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Product</label>
              <input value={filterProduct} onChange={e => setFilterProduct(e.target.value)}
                placeholder="Filter by product…"
                className="w-full px-2.5 py-1 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 bg-white" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Brand</label>
              <select value={filterBrand} onChange={e => setFilterBrand(e.target.value)}
                className="w-full px-2.5 py-1 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 bg-white">
                <option value="">All brands</option>
                {uniqueBrands.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Product Status</label>
              <select value={filterProductStatus} onChange={e => setFilterProductStatus(e.target.value)}
                className="w-full px-2.5 py-1 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 bg-white">
                <option value="">All statuses</option>
                {uniqueStatuses.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">RMA Status</label>
              <select value={filterRmaStatus} onChange={e => setFilterRmaStatus(e.target.value)}
                className="w-full px-2.5 py-1 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 bg-white">
                <option value="">All</option>
                <option value="New">New</option>
                <option value="In Progress">In Progress</option>
                <option value="On Hold">On Hold</option>
                <option value="Completed">Completed</option>
              </select>
            </div>
          </div>
          {activeFilterCount > 0 && (
            <div className="flex justify-end">
              <button onClick={() => { setFilterProduct(''); setFilterBrand(''); setFilterProductStatus(''); setFilterRmaStatus('') }}
                className="text-xs text-red-500 hover:text-red-700 underline">Clear all filters</button>
            </div>
          )}
        </div>
      )}

      {/* Selection bar */}
      {selectedGroups.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg flex-wrap">
          <span className="w-5 h-5 bg-indigo-600 text-white rounded-full flex items-center justify-center text-[10px] font-bold">{selectedGroups.length}</span>
          <span className="text-sm font-medium text-indigo-700">
            {selectedGroups.length} product{selectedGroups.length !== 1 ? 's' : ''} selected
            {canTransfer && selectedUnitIds.length > 0 && (
              <span className="text-indigo-400 ml-1">({selectedUnitIds.length} unit{selectedUnitIds.length !== 1 ? 's' : ''})</span>
            )}
          </span>
          <button onClick={() => setSelectedGroups([])} className="text-xs text-indigo-400 hover:text-indigo-700 underline">Clear</button>
          <div className="h-4 w-px bg-indigo-200 ml-1"/>
          {canTransfer && (
            <button
              onClick={() => { if (!selectedUnitIds.length) { toast.error('No matching units found in inventory'); return } setShowTransfer(true) }}
              disabled={transferring}
              className="flex items-center gap-1.5 px-2.5 py-1 bg-white border border-indigo-300 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50 disabled:opacity-50">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/></svg>
              Transfer to Warehouse
            </button>
          )}
          <button onClick={() => {
            const rows = selectedGroups.map(name => {
              const g = grouped.find(x => x.product_name === name)
              return g ? { product: g.product_name, qty: g.qty, in_warranty: g.in_warranty, out_of_warranty: g.out_warranty } : null
            }).filter(Boolean)
            downloadCSV(rows, 'inventory-selected.csv')
            setSelectedGroups([])
          }} className="flex items-center gap-1.5 px-2.5 py-1 bg-white border border-indigo-300 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            Export
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500 text-sm">{search || activeFilterCount ? 'No products match your filters' : 'No products in this category'}</p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-gray-100 sticky top-0 z-10">
                  <tr>
                    <th className="w-9 px-3 py-2 border-b border-r border-gray-200 text-center">
                      <input type="checkbox" checked={allPageChk}
                        onChange={e => setSelectedGroups(e.target.checked
                          ? [...new Set([...selectedGroups, ...pageNames])]
                          : selectedGroups.filter(n => !pageNames.includes(n))
                        )}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer" />
                    </th>
                    <th className="w-8 px-2 py-2 text-center text-gray-500 font-semibold border-b border-r border-gray-200">#</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 border-b border-r border-gray-200">
                      <InvSortBtn label="Product" sortKey="product_name" activeSortKey={sortKey} activeSortDir={sortDir} onSort={handleSort}/>
                    </th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 border-b border-r border-gray-200 w-16">
                      <InvSortBtn label="Qty" sortKey="qty" activeSortKey={sortKey} activeSortDir={sortDir} onSort={handleSort}/>
                    </th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 border-b border-r border-gray-200 whitespace-nowrap">In Warranty</th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 border-b border-r border-gray-200 whitespace-nowrap">Out of Warranty</th>
                    {showTypeCol && <th className="px-3 py-2 text-left font-semibold text-gray-600 border-b border-r border-gray-200 min-w-[160px]">Types</th>}
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 border-b border-gray-200 w-28 whitespace-nowrap">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((g, idx) => {
                    const isOpen     = expanded.has(g.product_name)
                    const isSelected = selectedGroups.includes(g.product_name)
                    const typeBreakdown = showTypeCol
                      ? g.items.reduce((acc, p) => { acc[p.product_status] = (acc[p.product_status] || 0) + 1; return acc }, {})
                      : null
                    const rowBg = isSelected ? 'bg-indigo-50' : idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'
                    return (
                      <React.Fragment key={g.product_name}>
                        <tr className={`${rowBg} border-b border-gray-100 transition-colors cursor-pointer hover:bg-indigo-50/40`}
                          onClick={() => toggleExpand(g.product_name)}>
                          <td className="px-3 py-1.5 text-center border-r border-gray-100"
                            onClick={e => { e.stopPropagation(); toggleSelect(g.product_name) }}>
                            <input type="checkbox" checked={isSelected} onChange={() => {}}
                              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"/>
                          </td>
                          <td className="px-2 py-1.5 text-center text-gray-500 tabular-nums border-r border-gray-100">{startIndex + idx + 1}</td>
                          <td className="px-3 py-1.5 font-medium text-gray-900 border-r border-gray-100">
                            <div className="flex items-center gap-1.5">
                              <svg className={`w-3 h-3 text-gray-500 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
                              {g.product_name}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-center border-r border-gray-100">
                            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-indigo-100 text-indigo-700">{g.qty}</span>
                          </td>
                          <td className="px-3 py-1.5 text-center border-r border-gray-100">
                            {g.in_warranty > 0
                              ? <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">{g.in_warranty}</span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-center border-r border-gray-100">
                            {g.out_warranty > 0
                              ? <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">{g.out_warranty}</span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                          {showTypeCol && (
                            <td className="px-3 py-1.5 border-r border-gray-100">
                              <div className="flex flex-wrap gap-1">
                                {Object.entries(typeBreakdown).map(([type, count]) => (
                                  <span key={type} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${PRODUCT_STATUS_CLS[type] || 'bg-gray-100 text-gray-600'}`}>{type} ×{count}</span>
                                ))}
                              </div>
                            </td>
                          )}
                          <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">
                            {fmtDate(g.latest_date)}
                          </td>
                        </tr>
                        {isOpen && g.items.map((p, i) => (
                          <tr key={`${p.rma_number}-${p.serial_number || i}`} className="bg-blue-50/20 border-b border-blue-100/40">
                            <td className="border-r border-gray-100" />
                            <td className="border-r border-gray-100" />
                            <td colSpan={colSpanData} className="px-4 py-1.5">
                              <div className="flex items-center gap-4 flex-wrap pl-3 border-l-2 border-indigo-200">
                                <span className="font-mono text-gray-500">{p.serial_number || 'No S/N'}</span>
                                <WarrantyBadge status={p.warranty_status}/>
                                {p.rma_number
                                  ? <button onClick={e => { e.stopPropagation(); onNavigateToTicket?.(p.ticket_id) }}
                                      className="font-mono text-indigo-600 hover:text-indigo-800 hover:underline">{p.rma_number}</button>
                                  : <span className="text-gray-300">—</span>}
                                <span className="text-gray-700">{p.customer_name || '—'}</span>
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${TICKET_STATUS_CLS[p.ticket_status] || 'bg-gray-100 text-gray-500'}`}>{p.ticket_status || '—'}</span>
                                {p.assigned_technician && <span className="text-gray-500">{p.assigned_technician}</span>}
                                <span className="text-gray-500">{fmtDate(p.status_date || p.created_date)}</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <Pagination total={filtered.length} page={currentPage} itemsPerPage={itemsPerPage} setItemsPerPage={setItemsPerPage} onPage={setCurrentPage} />
        </>
      )}
      {showTransfer && (
        <TransferModal
          units={selectedUnitIds}
          warehouses={warehouses}
          onConfirm={handleBulkTransfer}
          onClose={() => setShowTransfer(false)}
        />
      )}
    </div>
  )
}

// ─── Main Inventory Component ──────────────────────────────────────────────────
export default function Inventory({ userRole, userEmail, userPermissions, onNavigateToTicket }) {
  const canDo = a => (userRole === 'admin' || userRole === 'super_admin') ? true : userPermissions?.inventory?.[a] === true

  const [tab, setTab]                   = useURLTab('tab', 'overview')
  const [units, setUnits]               = useState([])
  const [batches, setBatches]           = useState([])
  const [brands, setBrands]             = useState([])
  const [brandMap, setBrandMap]         = useState({})
  const [warehouses, setWarehouses]     = useState([])
  const [whMissing, setWhMissing]       = useState(false)
  const [stats, setStats]               = useState(null)
  const [loading, setLoading]           = useState(true)
  const [tableMissing, setTableMissing] = useState(false)
  const [rmaTickets, setRmaTickets]     = useState([])

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [ur, br, sr, brandList, productList, whRes, tkRes] = await Promise.all([
        db.inventory.listUnits(),
        db.inventory.listBatches(),
        db.inventory.getStats(),
        db.brands.list().catch(() => []),
        db.products.list().catch(() => []),
        db.warehouses.list().catch(() => ({ missing: true, data: [] })),
        supabase.from('rma_tickets').select('id,rma_number,ticket_status,customer_name,assigned_technician,created_date,products').then(r => r.data || []),
      ])
      if (ur.missing) { setTableMissing(true); setLoading(false); return }
      setTableMissing(false)
      setUnits(ur.data)
      setBatches(br.missing ? [] : br.data)
      setStats(sr)
      setBrands(brandList || [])
      const map = {}
      for (const p of productList || []) if (p.product_name) map[p.product_name] = p.brand?.brand_name || ''
      setBrandMap(map)
      setWhMissing(whRes.missing)
      setWarehouses(whRes.data || [])
      setRmaTickets(tkRes)
    } catch { toast.error('Failed to load inventory') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  // Real-time: refresh when inventory_units or rma_tickets change
  useEffect(() => {
    const channel = supabase.channel('inventory_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_units' }, () => loadAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rma_tickets' }, () => loadAll())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadAll])

  if (loading) return (
    <div className="space-y-6">
      <div className="space-y-2"><div className="h-8 w-32 animate-pulse bg-gray-200 rounded-lg" /><div className="h-4 w-56 animate-pulse bg-gray-200 rounded-lg" /></div>
      <StatCardSkeleton count={4} />
      <CardSkeleton lines={6} />
    </div>
  )

  if (tableMissing) return (
    <div className="max-w-3xl mx-auto mt-10 bg-amber-50 border border-amber-200 rounded-2xl p-6 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-amber-200 rounded-xl flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        </div>
        <div>
          <h2 className="text-base font-semibold text-amber-900">Database Setup Required</h2>
          <p className="text-sm text-amber-800 mt-0.5">Run the SQL below in your Supabase SQL Editor, then click Retry.</p>
        </div>
      </div>
      <pre className="bg-amber-100 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 overflow-x-auto whitespace-pre">{`CREATE TABLE IF NOT EXISTS inventory_units (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  rma_ticket_id UUID, rma_number TEXT, product_name TEXT, serial_number TEXT,\n  warranty_status TEXT, status TEXT DEFAULT 'active_rma', resolution_type TEXT,\n  resolved_date TIMESTAMPTZ, manufacturer_batch_id UUID, notes TEXT,\n  created_date TIMESTAMPTZ DEFAULT now()\n);\n\nCREATE TABLE IF NOT EXISTS manufacturer_batches (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  batch_number TEXT UNIQUE, manufacturer_name TEXT, status TEXT DEFAULT 'draft',\n  sent_date DATE, tracking_number TEXT, resolution_type TEXT, resolution_date DATE,\n  resolution_notes TEXT, unit_count INT DEFAULT 0,\n  created_date TIMESTAMPTZ DEFAULT now(), created_by TEXT\n);`}</pre>
      <button onClick={loadAll} className="px-5 py-2 bg-amber-600 text-white rounded-xl text-sm font-medium hover:bg-amber-700">Retry</button>
    </div>
  )

  const stockUnits  = units.filter(u => u.status === 'company_stock')
  const allGroups   = groupByProduct(units, brandMap)
  const stockGroups = groupByProduct(stockUnits, brandMap)

  // Inventory logic per ticket + product status:
  // Cancelled tickets           → removed from all inventory tabs
  // Completed + Received/UnderRepair/Repaired/CantRepair → removed from all inventory tabs
  // Completed + Replacement/CreditNote → kept in RMA Stock
  // New/InProgress/OnHold + any product status → shown in the matching inventory tab
  const flatProducts = rmaTickets
    .filter(t => t.ticket_status !== 'Cancelled')
    .flatMap(t => (t.products || []).map(p => ({
      ...p,
      ticket_id:           t.id,
      rma_number:          t.rma_number,
      customer_name:       t.customer_name,
      ticket_status:       t.ticket_status,
      assigned_technician: t.assigned_technician,
      created_date:        t.created_date,
    })))
    .filter(p => {
      // Completed tickets: only Replacement/CreditNote remain in inventory (RMA Stock)
      if (p.ticket_status === 'Completed') {
        return p.product_status === 'Replacement' || p.product_status === 'Credit Note'
      }
      return true
    })

  // Active-only tabs (New / In Progress / On Hold)
  const receivedProds    = flatProducts.filter(p => p.ticket_status !== 'Completed' && (p.product_status === 'Received' || !p.product_status))
  const underRepairProds = flatProducts.filter(p => p.ticket_status !== 'Completed' && p.product_status === 'Under Repair')
  const repairedProds    = flatProducts.filter(p => p.ticket_status !== 'Completed' && p.product_status === 'Repaired')
  const cantRepairProds  = flatProducts.filter(p => p.ticket_status !== 'Completed' && p.product_status === "Can't Repair")

  // Build a set of unit keys that have already been transferred to a warehouse
  const transferredKeys = new Set(
    units
      .filter(u => u.warehouse_id)
      .map(u => `${u.rma_ticket_id}||${u.serial_number || u.product_name}`)
  )
  const rmaStockProds = flatProducts.filter(p => {
    if (p.product_status !== 'Replacement' && p.product_status !== 'Credit Note') return false
    const key = `${p.ticket_id}||${p.serial_number || p.product_name}`
    return !transferredKeys.has(key)
  })

  const tabs = [
    { id: 'overview',     label: 'Overview' },
    { id: 'by-product',   label: `All Units (${units.length})` },
    { id: 'received',     label: `Received (${receivedProds.length})` },
    { id: 'under-repair', label: `Under Repair (${underRepairProds.length})` },
    { id: 'repaired',     label: `Repaired (${repairedProds.length})` },
    { id: 'cant-repair',  label: `Can't Repair (${cantRepairProds.length})` },
    { id: 'rma-stock',    label: `RMA Stock (${rmaStockProds.length})` },
    { id: 'warehouses',   label: `Warehouses (${warehouses.length})` },
  ]

  return (
    <div className="space-y-6">
      <PageHeader title="Inventory" subtitle="Track RMA units through their full lifecycle">
        {canDo('export') && <ExportMenu units={units} batches={batches} warehouses={warehouses} brandMap={brandMap} />}
        <button onClick={loadAll} className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          Refresh
        </button>
      </PageHeader>

      <div className="border-b border-gray-200">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab === t.id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview'     && <OverviewTab stats={stats} units={units} brands={brands} brandMap={brandMap} onNavigate={setTab} />}
      {tab === 'by-product'   && <ByProductTab groups={allGroups} brands={brands} warehouses={warehouses} canResolve={canDo('resolve_units')} canTransfer={canDo('transfer')} userEmail={userEmail} onReload={loadAll} onNavigateToTicket={onNavigateToTicket} />}
      {tab === 'received'     && <ProductStatusTab products={receivedProds} brandMap={brandMap} onNavigateToTicket={onNavigateToTicket} />}
      {tab === 'under-repair' && <ProductStatusTab products={underRepairProds} brandMap={brandMap} onNavigateToTicket={onNavigateToTicket} />}
      {tab === 'repaired'     && <ProductStatusTab products={repairedProds} brandMap={brandMap} onNavigateToTicket={onNavigateToTicket} />}
      {tab === 'cant-repair'  && <ProductStatusTab products={cantRepairProds} brandMap={brandMap} onNavigateToTicket={onNavigateToTicket} />}
      {tab === 'rma-stock'    && <ProductStatusTab products={rmaStockProds} showTypeCol brandMap={brandMap} onNavigateToTicket={onNavigateToTicket} warehouses={warehouses} units={units} canTransfer={canDo('transfer')} userEmail={userEmail} onReload={loadAll} />}
      {tab === 'warehouses'   && <WarehousesTab units={units} warehouses={warehouses} whMissing={whMissing} brands={brands} brandMap={brandMap} userEmail={userEmail} canManage={canDo('manage_warehouses')} canTransfer={canDo('transfer')} onReload={loadAll} />}
    </div>
  )
}

// ─── Overview ──────────────────────────────────────────────────────────────────
function OverviewTab({ stats, units, brands, brandMap, onNavigate }) {
  const brandGroups = groupByProduct(units, brandMap)
  const perBrand = {}
  for (const g of brandGroups) {
    const b = g.brand || 'Unknown'
    if (!perBrand[b]) perBrand[b] = { active: 0, stock: 0, sent: 0, total: 0 }
    perBrand[b].active += g.active_rma; perBrand[b].stock += g.company_stock
    perBrand[b].sent += g.sent_to_manufacturer; perBrand[b].total += g.units.length
  }
  return (
    <div className="space-y-4">
      {Object.keys(perBrand).length === 0 ? (
        <div className="text-center py-20 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500 text-sm">No inventory data yet</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">Stock by Brand</h3>
            <span className="text-xs text-gray-500">{units.length} total units</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>{['Brand','Active RMA','Company Stock','Sent to Mfr','Total'].map(h => <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {Object.entries(perBrand).sort((a,b) => b[1].total - a[1].total).map(([brand, cnt]) => (
                  <tr key={brand} className="hover:bg-indigo-50 cursor-pointer transition-colors" onClick={() => onNavigate('by-product')}>
                    <td className="px-5 py-3 font-medium text-gray-900">{brand}</td>
                    <td className="px-5 py-3"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">{cnt.active}</span></td>
                    <td className="px-5 py-3"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">{cnt.stock}</span></td>
                    <td className="px-5 py-3"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">{cnt.sent}</span></td>
                    <td className="px-5 py-3 font-bold text-gray-800">{cnt.total}</td>
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

// ─── All Units — By Product ───────────────────────────────────────────────────
function ByProductTab({ groups, brands, warehouses, canResolve, canTransfer, userEmail, onReload, onNavigateToTicket }) {
  const searchRef                               = useRef(null)
  const [selectedProduct, setSelectedProduct]   = useState(null)
  const [search, setSearch]                     = useState('')
  const [showFilters, setShowFilters]           = useState(false)
  const [filterBrand, setFilterBrand]           = useState('')
  const [filterStatus, setFilterStatus]         = useState('')
  const [filterProduct, setFilterProduct]       = useState('')
  const [currentPage, setCurrentPage]           = useState(1)
  const [itemsPerPage, setItemsPerPage]         = useState(() => parseInt(localStorage.getItem('invByProductPerPage')) || 25)
  const [selectedRows, setSelectedRows]         = useState([])

  const activeFilterCount = [filterBrand, filterStatus, filterProduct].filter(Boolean).length
  const filtered = groups.filter(g => {
    const matchSearch  = !search || g.product_name.toLowerCase().includes(search.toLowerCase()) || g.brand?.toLowerCase().includes(search.toLowerCase())
    const matchBrand   = !filterBrand || g.brand === filterBrand
    const matchStatus  = !filterStatus || g[filterStatus] > 0
    const matchProduct = !filterProduct || g.product_name.toLowerCase().includes(filterProduct.toLowerCase())
    return matchSearch && matchBrand && matchStatus && matchProduct
  })
  const paginated = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)

  React.useEffect(() => { setCurrentPage(1) }, [search, filterBrand, filterStatus, filterProduct, itemsPerPage])
  React.useEffect(() => { localStorage.setItem('invByProductPerPage', itemsPerPage.toString()) }, [itemsPerPage])

  // Keyboard shortcuts: / = focus search, Esc = close detail modal
  React.useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable
      if (e.key === 'Escape') { setSelectedProduct(null); return }
      if (typing) return
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const handleExportSelected = () => {
    const rows = selectedRows.map(name => {
      const g = groups.find(x => x.product_name === name)
      if (!g) return null
      return { brand: g.brand, product: g.product_name, active_rma: g.active_rma, company_stock: g.company_stock, sent_to_manufacturer: g.sent_to_manufacturer, total: g.units.length }
    }).filter(Boolean)
    downloadCSV(rows, 'inventory-selected.csv')
    setSelectedRows([])
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-1 max-w-2xl">
          <div className="relative flex-1">
            <input ref={searchRef} type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by product name or brand... (Press / to focus)"
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent" />
            <svg className="w-5 h-5 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
          </div>
          <button onClick={() => setShowFilters(f => !f)}
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${showFilters || activeFilterCount > 0 ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"/></svg>
            Filters
            {activeFilterCount > 0 && <span className="w-4 h-4 bg-indigo-600 text-white text-xs rounded-full flex items-center justify-center">{activeFilterCount}</span>}
          </button>
        </div>
        <span className="text-sm text-gray-500">{filtered.length} product{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {selectedRows.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-xl">
          <span className="w-6 h-6 bg-indigo-600 text-white rounded-full flex items-center justify-center text-xs font-bold">{selectedRows.length}</span>
          <span className="text-sm font-medium text-indigo-700">{selectedRows.length} product{selectedRows.length !== 1 ? 's' : ''} selected</span>
          <button onClick={() => setSelectedRows([])} className="text-xs text-indigo-500 hover:text-indigo-700 underline">Clear</button>
          <div className="h-5 w-px bg-indigo-200" />
          <button onClick={handleExportSelected} className="flex items-center gap-2 px-3 py-1.5 bg-white border border-indigo-300 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            Export selected
          </button>
        </div>
      )}

      {/* Filter panel */}
      {showFilters && (
        <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Product:</label>
            <input type="text" value={filterProduct} onChange={e => setFilterProduct(e.target.value)}
              placeholder="Type product name..."
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 w-44" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Brand:</label>
            <select value={filterBrand} onChange={e => setFilterBrand(e.target.value)} className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600">
              <option value="">All</option>
              {brands.map(b => <option key={b.id} value={b.brand_name}>{b.brand_name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Status:</label>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600">
              <option value="">All</option>
              <option value="active_rma">Active RMA</option>
              <option value="company_stock">Company Stock</option>
              <option value="sent_to_manufacturer">Sent to Manufacturer</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          {activeFilterCount > 0 && (
            <button onClick={() => { setFilterBrand(''); setFilterStatus(''); setFilterProduct('') }} className="text-sm text-red-600 hover:underline ml-auto">Clear filters</button>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-lg border border-gray-200 flex flex-col items-center gap-3">
          <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center">
            <svg className="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
          </div>
          <div>
            <p className="font-semibold text-gray-600 text-sm">No products found</p>
            <p className="text-xs text-gray-500 mt-0.5">{search || filterBrand || filterStatus || filterProduct ? 'Try adjusting your filters' : 'Products appear here once inventory units are added via RMA tickets'}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-gray-100 sticky top-0 z-10">
                  <tr>
                    <th className="w-9 px-3 py-2 border-b border-r border-gray-200 text-center">
                      <input type="checkbox" checked={paginated.length > 0 && selectedRows.filter(r => paginated.some(g => g.product_name === r)).length === paginated.length} onChange={e => setSelectedRows(e.target.checked ? paginated.map(g => g.product_name) : [])} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer" />
                    </th>
                    <th className="w-8 px-2 py-2 text-center text-gray-500 font-semibold border-b border-r border-gray-200">#</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 border-b border-r border-gray-200">Brand</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 border-b border-r border-gray-200">Product</th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 border-b border-r border-gray-200 whitespace-nowrap">Active RMA</th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 border-b border-r border-gray-200 whitespace-nowrap">Company Stock</th>

                    <th className="px-3 py-2 text-center font-semibold text-gray-600 border-b border-r border-gray-200">Total</th>
                    <th className="px-3 py-2 border-b border-gray-200 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((g, idx) => {
                    const isSelected = selectedRows.includes(g.product_name)
                    const rowBg = isSelected ? 'bg-indigo-50' : idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'
                    return (
                    <tr key={g.product_name} className={`${rowBg} border-b border-gray-100 transition-colors cursor-pointer hover:bg-indigo-50/40`} onClick={() => setSelectedProduct(g)}>
                      <td className="px-3 py-1.5 text-center border-r border-gray-100" onClick={e => { e.stopPropagation(); setSelectedRows(r => r.includes(g.product_name) ? r.filter(x => x !== g.product_name) : [...r, g.product_name]) }}><input type="checkbox" checked={isSelected} onChange={() => {}} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer" /></td>
                      <td className="px-2 py-1.5 text-center text-gray-500 tabular-nums border-r border-gray-100">{(currentPage - 1) * itemsPerPage + idx + 1}</td>
                      <td className="px-3 py-1.5 border-r border-gray-100 text-gray-600 font-medium">{g.brand||'—'}</td>
                      <td className="px-3 py-1.5 font-semibold text-gray-900 border-r border-gray-100">{g.product_name}</td>
                      <td className="px-3 py-1.5 text-center border-r border-gray-100">{g.active_rma > 0 ? <span className="px-2 py-0.5 rounded text-xs font-semibold bg-blue-100 text-blue-700">{g.active_rma}</span> : <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-1.5 text-center border-r border-gray-100">{g.company_stock > 0 ? <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700">{g.company_stock}</span> : <span className="text-gray-300">—</span>}</td>

                      <td className="px-3 py-1.5 text-center font-bold text-gray-800 border-r border-gray-100">{g.units.length}</td>
                      <td className="px-3 py-1.5 text-center"><span className="text-indigo-500">→</span></td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </div>
          </div>
          <Pagination total={filtered.length} page={currentPage} itemsPerPage={itemsPerPage} setItemsPerPage={setItemsPerPage} onPage={setCurrentPage} />
        </>
      )}
      {selectedProduct && <ProductDetailModal group={selectedProduct} mode="view" warehouses={warehouses} canTransfer={canTransfer} userEmail={userEmail} onClose={() => setSelectedProduct(null)} onReload={onReload} onNavigateToTicket={onNavigateToTicket} />}
    </div>
  )
}

function CompanyStockTab({ groups, brands, warehouses, userEmail, canManageBatches, canTransfer, onReload, onNavigateToTicket }) {
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [search, setSearch]                   = useState('')
  const [showFilters, setShowFilters]         = useState(false)
  const [filterBrand, setFilterBrand]           = useState('')
  const [filterResolution, setFilterResolution] = useState('')
  const [filterProduct, setFilterProduct]       = useState('')
  const [currentPage, setCurrentPage]           = useState(1)
  const [itemsPerPage, setItemsPerPage]         = useState(() => parseInt(localStorage.getItem('invStockPerPage')) || 25)
  const [selectedRows, setSelectedRows]         = useState([])
  const [showTransfer, setShowTransfer]         = useState(false)
  const [showBatch, setShowBatch]               = useState(false)
  const [bulkProcessing, setBulkProcessing]     = useState(false)

  const activeFilterCount = [filterBrand, filterResolution, filterProduct].filter(Boolean).length
  const filtered = groups.filter(g => {
    const matchSearch  = !search || g.product_name.toLowerCase().includes(search.toLowerCase()) || g.brand?.toLowerCase().includes(search.toLowerCase())
    const matchBrand   = !filterBrand || g.brand === filterBrand
    const matchRes     = !filterResolution || (filterResolution === 'replacement' ? g.replacement > 0 : filterResolution === 'credit_note' ? g.credit_note > 0 : (g.units.length - g.replacement - g.credit_note) > 0)
    const matchProduct = !filterProduct || g.product_name.toLowerCase().includes(filterProduct.toLowerCase())
    return matchSearch && matchBrand && matchRes && matchProduct
  })
  const paginated = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)

  React.useEffect(() => { setCurrentPage(1) }, [search, filterBrand, filterResolution, filterProduct, itemsPerPage])
  React.useEffect(() => { localStorage.setItem('invStockPerPage', itemsPerPage.toString()) }, [itemsPerPage])

  const searchRef = useRef(null)

  // Keyboard shortcuts: / = focus search, Esc = close detail modal
  React.useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable
      if (e.key === 'Escape') { setSelectedProduct(null); return }
      if (typing) return
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // All unbatched unit IDs for the selected product groups
  const selectedUnitIds = selectedRows.flatMap(name => {
    const g = groups.find(x => x.product_name === name)
    return g ? g.units.filter(u => !u.manufacturer_batch_id).map(u => u.id) : []
  })

  const handleExportSelected = () => {
    const rows = selectedRows.map(name => {
      const g = groups.find(x => x.product_name === name)
      if (!g) return null
      const other = g.units.length - g.replacement - g.credit_note
      return { brand: g.brand, product: g.product_name, replacement: g.replacement, credit_note: g.credit_note, other, total: g.units.length }
    }).filter(Boolean)
    downloadCSV(rows, 'company-stock-selected.csv')
    setSelectedRows([])
  }

  const handleBulkTransfer = async (warehouseId) => {
    if (!selectedUnitIds.length) { toast.error('No transferable units in selection'); return }
    setBulkProcessing(true)
    try {
      await db.inventory.transferUnits(selectedUnitIds, warehouseId)
      toast.success(`${selectedUnitIds.length} unit${selectedUnitIds.length !== 1 ? 's' : ''} transferred`)
      db.auditLog.log(userEmail, 'inventory_units_transferred', `Transferred ${selectedUnitIds.length} unit${selectedUnitIds.length !== 1 ? 's' : ''} to warehouse ${warehouseId}`).catch(() => {})
      setSelectedRows([])
      setShowTransfer(false)
      onReload()
    } catch (err) {
      console.error('Transfer error:', err)
      toast.error('Transfer failed')
    } finally { setBulkProcessing(false) }
  }

  const handleBulkBatch = async (brandName) => {
    if (!selectedUnitIds.length) { toast.error('No unbatched units in selection'); return }
    setBulkProcessing(true)
    try {
      await db.inventory.createBatch(selectedUnitIds, brandName, userEmail)
      toast.success(`Batch created with ${selectedUnitIds.length} unit${selectedUnitIds.length !== 1 ? 's' : ''}`)
      db.auditLog.log(userEmail, 'inventory_batch_created', `Created batch with ${selectedUnitIds.length} unit${selectedUnitIds.length !== 1 ? 's' : ''} for ${brandName}`).catch(() => {})
      setSelectedRows([])
      setShowBatch(false)
      onReload()
    } catch { toast.error('Failed to create batch') }
    finally { setBulkProcessing(false) }
  }

  if (groups.length === 0) return (
    <div className="text-center py-20 bg-white rounded-lg border border-gray-200 flex flex-col items-center gap-3">
      <div className="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center">
        <svg className="w-6 h-6 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
      </div>
      <div>
        <p className="font-semibold text-gray-600 text-sm">No company stock yet</p>
        <p className="text-xs text-gray-500 mt-0.5">Units resolved as "Company Stock" from RMA tickets will appear here</p>
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-1 max-w-2xl">
          <div className="relative flex-1">
            <input ref={searchRef} type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by product name or brand... (Press / to focus)"
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent" />
            <svg className="w-5 h-5 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
          </div>
          <button onClick={() => setShowFilters(f => !f)}
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${showFilters || activeFilterCount > 0 ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"/></svg>
            Filters
            {activeFilterCount > 0 && <span className="w-4 h-4 bg-indigo-600 text-white text-xs rounded-full flex items-center justify-center">{activeFilterCount}</span>}
          </button>
        </div>
        <span className="text-sm text-gray-500">{filtered.length} product{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Product:</label>
            <input type="text" value={filterProduct} onChange={e => setFilterProduct(e.target.value)}
              placeholder="Type product name..."
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 w-44" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Brand:</label>
            <select value={filterBrand} onChange={e => setFilterBrand(e.target.value)} className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600">
              <option value="">All</option>
              {brands.map(b => <option key={b.id} value={b.brand_name}>{b.brand_name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Resolution:</label>
            <select value={filterResolution} onChange={e => setFilterResolution(e.target.value)} className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600">
              <option value="">All</option>
              <option value="replacement">Replacement</option>
              <option value="credit_note">Credit Note</option>
              <option value="other">Other</option>
            </select>
          </div>
          {activeFilterCount > 0 && (
            <button onClick={() => { setFilterBrand(''); setFilterResolution(''); setFilterProduct('') }} className="text-sm text-red-600 hover:underline ml-auto">Clear filters</button>
          )}
        </div>
      )}

      {selectedRows.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-xl flex-wrap">
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="w-6 h-6 bg-indigo-600 text-white rounded-full flex items-center justify-center text-xs font-bold">{selectedRows.length}</span>
            <span className="text-sm font-medium text-indigo-700">
              {selectedRows.length} product{selectedRows.length !== 1 ? 's' : ''} selected
              {selectedUnitIds.length > 0 && <span className="text-indigo-400 ml-1">({selectedUnitIds.length} unit{selectedUnitIds.length !== 1 ? 's' : ''})</span>}
            </span>
            <button onClick={() => setSelectedRows([])} className="text-xs text-indigo-400 hover:text-indigo-700 underline">Clear</button>
          </div>
          <div className="h-5 w-px bg-indigo-200 flex-shrink-0" />
          {canTransfer && (
            <button
              onClick={() => { if (!selectedUnitIds.length) { toast.error('No unbatched units in selection'); return } setShowTransfer(true) }}
              disabled={bulkProcessing}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-indigo-300 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50 transition-colors disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/></svg>
              Transfer to Warehouse
            </button>
          )}
          {canManageBatches && (
            <button
              onClick={() => { if (!selectedUnitIds.length) { toast.error('No unbatched units in selection'); return } setShowBatch(true) }}
              disabled={bulkProcessing}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-purple-300 text-purple-700 rounded-lg text-xs font-medium hover:bg-purple-50 transition-colors disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>
              Send to Manufacturer
            </button>
          )}
          <button onClick={handleExportSelected} disabled={bulkProcessing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-300 text-gray-600 rounded-lg text-xs font-medium hover:bg-gray-50 transition-colors disabled:opacity-50">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            Export
          </button>
        </div>
      )}

      {filtered.length === 0 ? <div className="text-center py-16 bg-white rounded-lg border border-gray-200"><p className="text-gray-500 text-sm">No products match filter</p></div> : (
        <>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 w-10"><input type="checkbox" checked={paginated.length > 0 && selectedRows.filter(r => paginated.some(g => g.product_name === r)).length === paginated.length} onChange={e => setSelectedRows(e.target.checked ? paginated.map(g => g.product_name) : [])} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer" /></th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-10">#</th>
                    {['Brand','Product','Replacement','Credit Note','Other','Total',''].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {paginated.map((g, idx) => { const other = g.units.length - g.replacement - g.credit_note; return (
                    <tr key={g.product_name} className={`hover:bg-amber-50/30 transition-colors cursor-pointer ${selectedRows.includes(g.product_name) ? 'bg-amber-50/50' : ''}`} onClick={() => setSelectedProduct(g)}>
                      <td className="px-4 py-3" onClick={e => { e.stopPropagation(); setSelectedRows(r => r.includes(g.product_name) ? r.filter(x => x !== g.product_name) : [...r, g.product_name]) }}><input type="checkbox" checked={selectedRows.includes(g.product_name)} onChange={() => {}} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer" /></td>
                      <td className="px-3 py-3 text-xs text-gray-500 tabular-nums">{(currentPage - 1) * itemsPerPage + idx + 1}</td>
                      <td className="px-4 py-3"><div className="flex items-center gap-2"><BrandAvatar name={g.brand||'?'} size="sm"/><span className="text-xs text-gray-500 font-medium">{g.brand||'—'}</span></div></td>
                      <td className="px-4 py-3 text-gray-900 font-semibold">{g.product_name}</td>
                      <td className="px-4 py-3">{g.replacement > 0 ? <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700">{g.replacement}</span> : <span className="text-gray-300 text-xs">—</span>}</td>
                      <td className="px-4 py-3">{g.credit_note > 0 ? <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">{g.credit_note}</span> : <span className="text-gray-300 text-xs">—</span>}</td>
                      <td className="px-4 py-3">{other > 0 ? <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">{other}</span> : <span className="text-gray-300 text-xs">—</span>}</td>
                      <td className="px-4 py-3 font-bold text-gray-800">{g.units.length}</td>
                      <td className="px-4 py-3 text-right"><span className="text-xs text-indigo-600 font-medium">Manage →</span></td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </div>
          </div>
          <Pagination total={filtered.length} page={currentPage} itemsPerPage={itemsPerPage} setItemsPerPage={setItemsPerPage} onPage={setCurrentPage} />
        </>
      )}
      {selectedProduct && <ProductDetailModal group={selectedProduct} mode="stock" warehouses={warehouses} canManageBatches={canManageBatches} canTransfer={canTransfer} userEmail={userEmail} onClose={() => setSelectedProduct(null)} onReload={onReload} onNavigateToTicket={onNavigateToTicket} />}
      {showTransfer && <TransferModal units={selectedUnitIds} warehouses={warehouses} onConfirm={handleBulkTransfer} onClose={() => setShowTransfer(false)} />}
      {showBatch && <CreateBatchModal count={selectedUnitIds.length} brands={brands} onConfirm={handleBulkBatch} onClose={() => setShowBatch(false)} />}
    </div>
  )
}

// ─── Ticket Preview Modal ─────────────────────────────────────────────────────
function TicketPreviewModal({ rmaNumber, onClose, onOpenFull }) {
  const [ticket, setTicket] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    db.rmaTracker.getTicketByRmaNumber(rmaNumber)
      .then(data => { setTicket(data || null); setLoading(false) })
  }, [rmaNumber])

  const priorityColor = { Critical:'bg-red-100 text-red-700', High:'bg-orange-100 text-orange-700', Medium:'bg-blue-100 text-blue-700', Low:'bg-gray-100 text-gray-500' }
  const statusColor   = { New:'bg-blue-100 text-blue-700','In Progress':'bg-yellow-100 text-yellow-700','On Hold':'bg-orange-100 text-orange-700',Completed:'bg-green-100 text-green-700',Cancelled:'bg-gray-100 text-gray-500' }
  const fmt = d => d ? new Date(d).toLocaleDateString() : '—'

  return (
    <div className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <p className="text-xs text-gray-500 font-mono mb-0.5">{rmaNumber}</p>
            <h3 className="text-base font-bold text-gray-900">{loading ? 'Loading…' : ticket?.products?.[0]?.product_name || 'Ticket Details'}</h3>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="p-5">
          {loading && (
            <div className="flex items-center justify-center py-8 gap-2 text-gray-500">
              <Spinner size="sm" />
              <span className="text-sm">Loading ticket…</span>
            </div>
          )}
          {!loading && !ticket && (
            <p className="text-center text-sm text-gray-500 py-6">Ticket not found for {rmaNumber}</p>
          )}
          {!loading && ticket && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                {ticket.ticket_status && <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${statusColor[ticket.ticket_status]||'bg-gray-100 text-gray-500'}`}>{ticket.ticket_status}</span>}
                {ticket.priority      && <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${priorityColor[ticket.priority]||'bg-gray-100 text-gray-500'}`}>{ticket.priority}</span>}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div><p className="text-xs text-gray-500">Customer</p><p className="font-medium text-gray-800">{ticket.customer_name||'—'}</p></div>
                <div><p className="text-xs text-gray-500">Assigned To</p><p className="font-medium text-gray-800">{ticket.assigned_to||'—'}</p></div>
                <div><p className="text-xs text-gray-500">Created</p><p className="font-medium text-gray-800">{fmt(ticket.created_date)}</p></div>
                <div><p className="text-xs text-gray-500">Due Date</p><p className="font-medium text-gray-800">{fmt(ticket.due_date)}</p></div>
              </div>
              {ticket.general_description && (
                <div className="bg-gray-50 rounded-xl p-3 text-sm text-gray-700 line-clamp-3">{ticket.general_description}</div>
              )}
            </div>
          )}
        </div>
        <div className="px-5 pb-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50">Close</button>
          {!loading && ticket && onOpenFull && (
            <button onClick={() => onOpenFull(ticket.id)} className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700">Open Ticket →</button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Product Detail Modal ──────────────────────────────────────────────────────
function ProductDetailModal({ group, mode, warehouses, canManageBatches, canTransfer, userEmail, onClose, onReload, onNavigateToTicket }) {
  const [tickets, setTickets]         = useState({})
  const [selected, setSelected]       = useState([])
  const [showBatch, setShowBatch]     = useState(false)
  const [showTransfer, setShowTransfer] = useState(false)
  const [loadingTickets, setLoadingTickets] = useState(true)
  const [previewRma, setPreviewRma]   = useState(null)

  const isStock     = mode === 'stock'
  const stockUnits  = isStock ? group.units.filter(u => !u.manufacturer_batch_id) : []
  const batchedUnits = isStock ? group.units.filter(u =>  u.manufacturer_batch_id) : []

  useEffect(() => {
    const nums = [...new Set(group.units.map(u => u.rma_number).filter(Boolean))]
    if (!nums.length) { setLoadingTickets(false); return }
    supabase.from('rma_tickets').select('id,rma_number,ticket_status,customer_name,customer_type,product_name,priority,assigned_to,description,created_date,due_date')
      .in('rma_number', nums)
      .then(({ data }) => { const m = {}; for (const t of data||[]) m[t.rma_number]=t; setTickets(m); setLoadingTickets(false) })
  }, [group.units])

  const toggleUnit = id => setSelected(p => p.includes(id) ? p.filter(x=>x!==id) : [...p, id])
  const toggleAll  = () => setSelected(selected.length === stockUnits.length ? [] : stockUnits.map(u=>u.id))

  const handleCreateBatch = async (brandName) => {
    try {
      await db.inventory.createBatch(selected, brandName, userEmail)
      toast.success('Batch created!')
      db.auditLog.log(userEmail, 'inventory_batch_created', `Created batch with ${selected.length} unit${selected.length !== 1 ? 's' : ''} for ${brandName}`).catch(() => {})
      setSelected([]); setShowBatch(false); onClose(); onReload()
    }
    catch { toast.error('Failed to create batch') }
  }

  const handleTransfer = async (warehouseId) => {
    const ids = selected.length > 0 ? selected : group.units.map(u=>u.id)
    try {
      await db.inventory.transferUnits(ids, warehouseId)
      toast.success(`${ids.length} unit(s) transferred`)
      db.auditLog.log(userEmail, 'inventory_units_transferred', `Transferred ${ids.length} unit(s) to warehouse ${warehouseId}`).catch(() => {})
      setSelected([]); setShowTransfer(false); onReload()
    }
    catch { toast.error('Transfer failed') }
  }

  const tsCls = { New:'bg-blue-100 text-blue-700','In Progress':'bg-yellow-100 text-yellow-700','On Hold':'bg-orange-100 text-orange-700',Completed:'bg-green-100 text-green-700',Cancelled:'bg-gray-100 text-gray-500' }
  const wName = id => warehouses.find(w=>w.id===id)?.name

  const unitRows = isStock ? stockUnits : group.units
  const allIds   = isStock ? stockUnits.map(u=>u.id) : group.units.map(u=>u.id)

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-4">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <BrandAvatar name={group.brand||'?'} size="lg"/>
            <div>
              <h3 className="text-lg font-bold text-gray-900">{group.product_name}</h3>
              <div className="flex items-center gap-3 mt-0.5">
                <span className="text-sm text-gray-500">{group.brand||'Unknown Brand'}</span>
                <span className="text-gray-300">·</span>
                <span className="text-sm text-gray-500">{group.units.length} unit{group.units.length!==1?'s':''}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canTransfer && (
              <button onClick={() => setShowTransfer(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-indigo-300 text-indigo-700 rounded-xl text-xs font-medium hover:bg-indigo-50 transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/></svg>
                Transfer{selected.length > 0 ? ` (${selected.length})` : ' All'}
              </button>
            )}
            <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        {/* Stock summary */}
        {isStock && (
          <div className="flex gap-3 px-6 py-3 bg-gray-50 border-b border-gray-100 flex-wrap">
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">{group.replacement} Replacement</span>
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-700">{group.credit_note} Credit Note</span>
            {(group.units.length-group.replacement-group.credit_note) > 0 && <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">{group.units.length-group.replacement-group.credit_note} Other</span>}
          </div>
        )}

        {/* Batch / select bar */}
        {isStock && canManageBatches && stockUnits.length > 0 && (
          <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 bg-indigo-50/50">
            <div className="flex items-center gap-3">
              <input type="checkbox" checked={stockUnits.length>0 && selected.length===stockUnits.length} onChange={toggleAll} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"/>
              <span className="text-sm text-gray-600">{selected.length>0 ? `${selected.length} selected` : 'Select to batch'}</span>
            </div>
            {selected.length > 0 && (
              <button onClick={() => setShowBatch(true)}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>
                Send to Manufacturer ({selected.length})
              </button>
            )}
          </div>
        )}

        {/* Units table */}
        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          {loadingTickets && <div className="flex items-center gap-2 text-sm text-gray-500 mb-2"><Spinner size="sm" />Loading RMA details...</div>}

          <div className="rounded-xl border border-gray-200 overflow-hidden">
            {isStock && stockUnits.length>0 && <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wider">Pending Batch ({stockUnits.length})</div>}
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  {isStock && canManageBatches && <th className="px-4 py-3 w-10"/>}
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Serial #</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Warranty</th>
                  {!isStock && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Status</th>}
                  {isStock  && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Resolution</th>}
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">RMA #</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Ticket Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Customer</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Warehouse</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {unitRows.map(u => { const tk=tickets[u.rma_number]; const age=daysSince(u.resolved_date||u.created_date); return (
                  <tr key={u.id} className={`hover:bg-gray-50 transition-colors ${selected.includes(u.id)?'bg-indigo-50/60':''}`}>
                    {isStock && canManageBatches && <td className="px-4 py-3"><input type="checkbox" checked={selected.includes(u.id)} onChange={()=>toggleUnit(u.id)} className="rounded border-gray-300 text-indigo-600"/></td>}
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{u.serial_number||'—'}</td>
                    <td className="px-4 py-3"><WarrantyBadge status={u.warranty_status}/></td>
                    {!isStock && <td className="px-4 py-3"><StatusBadge status={u.status}/></td>}
                    {isStock  && <td className="px-4 py-3"><ResolutionBadge type={u.resolution_type}/></td>}
                    <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">
                      {u.rma_number ? <button onClick={() => setPreviewRma(u.rma_number)} className="text-indigo-600 hover:text-indigo-800 hover:underline cursor-pointer">{u.rma_number}</button> : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3">{tk?<span className={`px-2 py-0.5 rounded-full text-xs font-medium ${tsCls[tk.ticket_status]||'bg-gray-100 text-gray-500'}`}>{tk.ticket_status}</span>:<span className="text-gray-300 text-xs">—</span>}</td>
                    <td className="px-4 py-3 text-gray-700 text-xs max-w-[120px] truncate" title={tk?.customer_name||''}>{tk?.customer_name||'—'}</td>
                    <td className="px-4 py-3">{u.warehouse_id ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">{wName(u.warehouse_id)||'Custom'}</span> : <span className="text-gray-300 text-xs">System</span>}</td>
                    <td className="px-4 py-3"><span className={`text-xs font-semibold ${age>30?'text-red-600':age>14?'text-amber-600':'text-gray-500'}`}>{age}d</span></td>
                  </tr>
                )})}
                {unitRows.length===0 && <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-500 text-sm">No units</td></tr>}
              </tbody>
            </table>
          </div>

          {isStock && batchedUnits.length>0 && (
            <div className="rounded-xl border border-purple-200 overflow-hidden">
              <div className="px-4 py-2 bg-purple-50 border-b border-purple-100 text-xs font-semibold text-purple-700 uppercase tracking-wider">In Manufacturer Batch ({batchedUnits.length})</div>
              <table className="w-full text-sm"><tbody className="divide-y divide-gray-50">
                {batchedUnits.map(u => { const tk=tickets[u.rma_number]; return (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{u.serial_number||'—'}</td>
                    <td className="px-4 py-3"><WarrantyBadge status={u.warranty_status}/></td>
                    <td className="px-4 py-3"><ResolutionBadge type={u.resolution_type}/></td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {u.rma_number ? <button onClick={() => setPreviewRma(u.rma_number)} className="text-indigo-600 hover:text-indigo-800 hover:underline cursor-pointer">{u.rma_number}</button> : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{tk?.customer_name||'—'}</td>
                    <td className="px-4 py-3"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">Batched</span></td>
                  </tr>
                )})}
              </tbody></table>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50">Close</button>
        </div>
      </div>

      {showBatch    && <CreateBatchModal count={selected.length} brands={[]} onConfirm={handleCreateBatch} onClose={() => setShowBatch(false)} />}
      {showTransfer && <TransferModal units={selected.length>0?selected:allIds} warehouses={warehouses} onConfirm={handleTransfer} onClose={() => setShowTransfer(false)} />}
      {previewRma && (
        <TicketPreviewModal
          rmaNumber={previewRma}
          onClose={() => setPreviewRma(null)}
          onOpenFull={onNavigateToTicket ? (ticketId) => { setPreviewRma(null); onClose(); onNavigateToTicket(ticketId) } : null}
        />
      )}
    </div>
  )
}

// ─── Warehouse export helpers ──────────────────────────────────────────────────
function exportWarehouseExcel(wh, units, brandMap, ticketMap) {
  const rows = units.map((u, i) => ({
    '#': i + 1,
    'Warehouse Code': wh.code || '',
    'Warehouse': wh.name || '',
    'Product': u.product_name || '',
    'Brand': brandMap[u.product_name] || '',
    'Serial #': u.serial_number || '',
    'Warranty': u.warranty_status || '',
    'Status': STATUS_META[u.status]?.label || u.status || '',
    'Resolution': RESOLUTION_META[u.resolution_type]?.label || u.resolution_type || '',
    'RMA #': u.rma_number || '',
    'Customer': ticketMap[u.rma_number]?.customer_name || '',
    'RMA Status': ticketMap[u.rma_number]?.ticket_status || '',
    'Date Added': u.created_date ? new Date(u.created_date).toLocaleDateString() : '',
    'Days': daysSince(u.created_date),
  }))
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Units')
  XLSX.writeFile(wb, `${wh.code || wh.name}-${new Date().toISOString().split('T')[0]}.xlsx`)
  toast.success(`Exported ${rows.length} rows to Excel`)
}

function exportWarehousePDF(wh, units, brandMap, ticketMap) {
  const date = new Date().toLocaleDateString()
  const rows = units.map((u, i) => [
    i + 1,
    u.product_name || '—',
    brandMap[u.product_name] || '—',
    u.serial_number || '—',
    u.warranty_status || '—',
    STATUS_META[u.status]?.label || u.status || '—',
    RESOLUTION_META[u.resolution_type]?.label || u.resolution_type || '—',
    u.rma_number || '—',
    ticketMap[u.rma_number]?.customer_name || '—',
    `${daysSince(u.created_date)}d`,
  ])

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
  const pw = doc.internal.pageSize.getWidth()

  doc.setFontSize(16); doc.setFont(undefined, 'bold')
  doc.text(`${wh.name}${wh.code ? ` (${wh.code})` : ''}`, 40, 40)
  doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(120)
  doc.text(`${units.length} unit${units.length !== 1 ? 's' : ''} · ${wh.location || ''} · Exported ${date}`, 40, 58)
  doc.setTextColor(0)

  const cols  = ['#','Product','Brand','Serial #','Warranty','Status','Resolution','RMA #','Customer','Days']
  const colW  = [20, 110, 70, 70, 55, 65, 75, 80, 100, 35]
  const startY = 75
  const rowH   = 16
  const pad    = 4

  // header
  doc.setFillColor(240, 240, 245); doc.rect(40, startY, pw - 80, rowH, 'F')
  doc.setFontSize(7); doc.setFont(undefined, 'bold')
  let x = 40
  cols.forEach((c, i) => { doc.text(c, x + pad, startY + 11); x += colW[i] })

  // rows
  doc.setFont(undefined, 'normal')
  rows.forEach((row, ri) => {
    const y = startY + (ri + 1) * rowH
    if (y > doc.internal.pageSize.getHeight() - 40) {
      doc.addPage()
      // re-draw header on new page
      doc.setFillColor(240, 240, 245); doc.rect(40, 40, pw - 80, rowH, 'F')
      doc.setFont(undefined, 'bold')
      let hx = 40
      cols.forEach((c, i) => { doc.text(c, hx + pad, 51); hx += colW[i] })
      doc.setFont(undefined, 'normal')
    }
    const ry = y > doc.internal.pageSize.getHeight() - 40 ? 40 + rowH : y
    if (ri % 2 === 1) { doc.setFillColor(250, 250, 252); doc.rect(40, ry, pw - 80, rowH, 'F') }
    let cx = 40
    row.forEach((cell, i) => {
      const text = String(cell)
      const maxW = colW[i] - pad * 2
      doc.text(doc.splitTextToSize(text, maxW)[0], cx + pad, ry + 11)
      cx += colW[i]
    })
  })

  doc.save(`${wh.code || wh.name}-${new Date().toISOString().split('T')[0]}.pdf`)
  toast.success(`PDF saved`)
}

// ─── Warehouses Tab ────────────────────────────────────────────────────────────
function WarehousesTab({ units, warehouses, whMissing, brands, brandMap, userEmail, canManage, canTransfer, onReload }) {
  const [selectedWh, setSelectedWh]   = useState(null)
  const [editingWh, setEditingWh]     = useState(null)
  const [showCreate, setShowCreate]   = useState(false)
  const [deleting, setDeleting]       = useState(null)
  const [showSQL, setShowSQL]         = useState(whMissing)
  const [confirmDialog, setConfirmDialog] = useState({ open: false, title: '', message: '', onConfirm: null })
  const openConfirm = (title, message, onConfirm) => setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog(d => ({ ...d, open: false }))

  const whUnits  = (id)     => units.filter(u => u.warehouse_id === id)
  const sysUnits = (status) => units.filter(u => u.status === status && !u.warehouse_id)

  const handleDelete = (wh) => {
    openConfirm(
      'Delete Warehouse',
      `Delete warehouse "${wh.name}"? Units will become unassigned.`,
      async () => {
        closeConfirm(); setDeleting(wh.id)
        try {
          await db.warehouses.delete(wh.id)
          toast.success('Warehouse deleted')
          db.auditLog.log(userEmail, 'warehouse_deleted', `Deleted warehouse ${wh.name}`).catch(() => {})
          onReload()
        }
        catch { toast.error('Failed to delete warehouse') }
        finally { setDeleting(null) }
      }
    )
  }

  return (
    <div className="space-y-4">
      {showSQL && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 bg-amber-200 rounded-lg flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-amber-900">Warehouse tables not set up yet</p>
                <p className="text-xs text-amber-700 mt-0.5">Run the SQL below in your Supabase SQL Editor to enable custom warehouses and unit transfer.</p>
              </div>
            </div>
            <button onClick={() => setShowSQL(false)} className="text-amber-500 hover:text-amber-700 text-xs underline flex-shrink-0">Hide</button>
          </div>
          <pre className="bg-amber-100 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 overflow-x-auto whitespace-pre">{WAREHOUSE_SQL}</pre>
          <button onClick={onReload} className="px-4 py-1.5 bg-amber-600 text-white rounded-xl text-xs font-medium hover:bg-amber-700">Retry after running SQL</button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-gray-500">
          {warehouses.length} warehouse{warehouses.length !== 1 ? 's' : ''}
          {warehouses.length > 0 && <span className="ml-2 text-gray-500">· {warehouses.reduce((n, w) => n + whUnits(w.id).length, 0)} total units</span>}
        </p>
        {canManage && !whMissing && (
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
            New Warehouse
          </button>
        )}
      </div>

      {/* Warehouse table */}
      {whMissing ? (
        <div className="rounded-2xl border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">Run the SQL above to enable custom warehouses</div>
      ) : warehouses.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 p-16 text-center space-y-3">
          <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto">
            <svg className="w-7 h-7 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
          </div>
          <p className="text-gray-500 font-medium text-sm">No warehouses yet</p>
          <p className="text-gray-500 text-xs">Create a warehouse to start transferring RMA stock units</p>
          {canManage && (
            <button onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 mt-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
              New Warehouse
            </button>
          )}
        </div>
      ) : (
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead className="bg-gray-100 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold text-gray-600 border-b border-r border-gray-200 w-28">Code</th>
                  <th className="px-4 py-2.5 text-left font-semibold text-gray-600 border-b border-r border-gray-200">Name</th>
                  <th className="px-4 py-2.5 text-left font-semibold text-gray-600 border-b border-r border-gray-200">Location</th>
                  <th className="px-4 py-2.5 text-left font-semibold text-gray-600 border-b border-r border-gray-200">Description</th>
                  <th className="px-4 py-2.5 text-center font-semibold text-gray-600 border-b border-r border-gray-200 w-20">Units</th>
                  <th className="px-4 py-2.5 text-center font-semibold text-gray-600 border-b border-r border-gray-200 w-20">Status</th>
                  <th className="px-4 py-2.5 text-left font-semibold text-gray-600 border-b border-r border-gray-200 w-32">Created</th>
                  {canManage && <th className="px-4 py-2.5 border-b border-gray-200 w-20"/>}
                </tr>
              </thead>
              <tbody>
                {warehouses.map((wh, idx) => {
                  const cnt = whUnits(wh.id).length
                  return (
                    <tr key={wh.id}
                      onClick={() => setSelectedWh({ ...wh, isSystem: false })}
                      className={`border-b border-gray-100 cursor-pointer hover:bg-indigo-50/40 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'} ${!wh.is_active ? 'opacity-60' : ''}`}>
                      <td className="px-4 py-2.5 border-r border-gray-100">
                        <span className="font-mono text-indigo-700 font-semibold">{wh.code || '—'}</span>
                      </td>
                      <td className="px-4 py-2.5 border-r border-gray-100 font-medium text-gray-900">{wh.name}</td>
                      <td className="px-4 py-2.5 border-r border-gray-100 text-gray-500">{wh.location || '—'}</td>
                      <td className="px-4 py-2.5 border-r border-gray-100 text-gray-500 max-w-[200px] truncate">{wh.description || '—'}</td>
                      <td className="px-4 py-2.5 border-r border-gray-100 text-center">
                        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${cnt > 0 ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500'}`}>{cnt}</span>
                      </td>
                      <td className="px-4 py-2.5 border-r border-gray-100 text-center">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${wh.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                          {wh.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 border-r border-gray-100 text-gray-500">{wh.created_date ? new Date(wh.created_date).toLocaleDateString() : '—'}</td>
                      {canManage && (
                        <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1 justify-center">
                            <button onClick={() => setEditingWh(wh)} className="p-1 text-gray-500 hover:text-indigo-600 rounded hover:bg-indigo-50 transition-colors">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                            </button>
                            <button onClick={() => handleDelete(wh)} disabled={deleting === wh.id} className="p-1 text-gray-500 hover:text-red-600 rounded hover:bg-red-50 transition-colors disabled:opacity-40">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

      {selectedWh && (
        <WarehouseDetailModal
          wh={selectedWh}
          units={selectedWh.isSystem
            ? units.filter(u => u.status === selectedWh.status && !u.warehouse_id)
            : units.filter(u => u.warehouse_id === selectedWh.id)}
          warehouses={warehouses}
          brandMap={brandMap}
          canTransfer={canTransfer}
          userEmail={userEmail}
          onClose={() => setSelectedWh(null)}
          onReload={() => { setSelectedWh(null); onReload() }}
        />
      )}
      {showCreate && (
        <CreateWarehouseModal
          warehouses={warehouses}
          onSave={async d => { await db.warehouses.create({ ...d, created_by: userEmail, created_date: new Date().toISOString() }); toast.success('Warehouse created!'); db.auditLog.log(userEmail, 'warehouse_created', `Created warehouse ${d.name}`).catch(() => {}); setShowCreate(false); onReload() }}
          onClose={() => setShowCreate(false)}
        />
      )}
      {editingWh && (
        <CreateWarehouseModal
          initialData={editingWh}
          warehouses={warehouses}
          onSave={async d => { await db.warehouses.update(editingWh.id, d); toast.success('Warehouse updated!'); db.auditLog.log(userEmail, 'warehouse_updated', `Updated warehouse ${d.name || editingWh.name}`).catch(() => {}); setEditingWh(null); onReload() }}
          onClose={() => setEditingWh(null)}
        />
      )}
      <ConfirmDialog open={confirmDialog.open} title={confirmDialog.title} message={confirmDialog.message} onConfirm={confirmDialog.onConfirm} onCancel={closeConfirm} />
    </div>
  )
}

// ─── Warehouse Detail Modal ────────────────────────────────────────────────────
function WarehouseDetailModal({ wh, units, warehouses, brandMap, canTransfer, userEmail, onClose, onReload }) {
  const [selected, setSelected]       = useState([])
  const [showTransfer, setShowTransfer] = useState(false)
  const [search, setSearch]           = useState('')
  const [ticketMap, setTicketMap]     = useState({})

  useEffect(() => {
    const nums = [...new Set(units.map(u => u.rma_number).filter(Boolean))]
    if (!nums.length) return
    supabase.from('rma_tickets').select('rma_number,customer_name,ticket_status')
      .in('rma_number', nums)
      .then(({ data }) => {
        const m = {}
        for (const t of data || []) m[t.rma_number] = t
        setTicketMap(m)
      })
  }, [units])

  const filtered = useMemo(() => {
    if (!search.trim()) return units
    const q = search.toLowerCase()
    return units.filter(u =>
      (u.product_name || '').toLowerCase().includes(q) ||
      (u.serial_number || '').toLowerCase().includes(q) ||
      (u.rma_number || '').toLowerCase().includes(q) ||
      (brandMap[u.product_name] || '').toLowerCase().includes(q) ||
      (ticketMap[u.rma_number]?.customer_name || '').toLowerCase().includes(q)
    )
  }, [units, search, brandMap, ticketMap])

  const toggle    = id => setSelected(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])
  const toggleAll = () => setSelected(selected.length === filtered.length ? [] : filtered.map(u => u.id))

  const handleTransfer = async (warehouseId) => {
    const ids = selected.length > 0 ? selected : filtered.map(u => u.id)
    try {
      await db.inventory.transferUnits(ids, warehouseId)
      toast.success(`${ids.length} unit(s) transferred`)
      db.auditLog.log(userEmail, 'inventory_units_transferred', `Transferred ${ids.length} unit(s) from ${wh.name} to warehouse ${warehouseId}`).catch(() => {})
      setSelected([]); setShowTransfer(false); onReload()
    }
    catch { toast.error('Transfer failed') }
  }

  const fmtDate = d => d ? new Date(d).toLocaleDateString() : '—'

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl flex flex-col" style={{ maxHeight: '90vh' }}>

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <div className="flex items-center gap-2">
              {wh.code && <span className="font-mono text-xs font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">{wh.code}</span>}
              <h3 className="text-lg font-bold text-gray-900">{wh.name}</h3>
              {!wh.isSystem && wh.is_active === false && <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">Inactive</span>}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {units.length} unit{units.length !== 1 ? 's' : ''}
              {wh.location ? ` · ${wh.location}` : ''}
              {wh.description ? ` · ${wh.description}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {units.length > 0 && <>
              <button onClick={() => exportWarehouseExcel(wh, filtered, brandMap, ticketMap)}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-green-300 text-green-700 rounded-lg text-xs font-medium hover:bg-green-50">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                Excel
              </button>
              <button onClick={() => exportWarehousePDF(wh, filtered, brandMap, ticketMap)}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-red-300 text-red-700 rounded-lg text-xs font-medium hover:bg-red-50">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
                PDF
              </button>
            </>}
            {canTransfer && units.length > 0 && (
              <button onClick={() => setShowTransfer(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-indigo-300 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/></svg>
                Transfer{selected.length > 0 ? ` (${selected.length})` : ''}
              </button>
            )}
            <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-gray-600 hover:bg-gray-100 rounded-lg">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-6 py-3 border-b border-gray-100 flex-shrink-0">
          <div className="relative max-w-sm">
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search product, serial, RMA#, customer…"
              className="w-full pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"/>
            <svg className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <div className="text-center py-16 text-gray-500 text-sm">{search ? 'No units match your search' : 'No units in this warehouse'}</div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="bg-gray-100 sticky top-0 z-10">
                <tr>
                  {canTransfer && (
                    <th className="w-9 px-3 py-2.5 border-b border-r border-gray-200 text-center">
                      <input type="checkbox" checked={filtered.length > 0 && selected.length === filtered.length} onChange={toggleAll} className="rounded border-gray-300 text-indigo-600 cursor-pointer"/>
                    </th>
                  )}
                  <th className="w-8 px-2 py-2.5 border-b border-r border-gray-200 text-center text-gray-500 font-semibold">#</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 border-b border-r border-gray-200 min-w-[140px]">Product</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 border-b border-r border-gray-200 w-24">Brand</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 border-b border-r border-gray-200 w-28">Serial #</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-600 border-b border-r border-gray-200 w-28">Warranty</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-600 border-b border-r border-gray-200 w-28">Status</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-600 border-b border-r border-gray-200 w-28">Resolution</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 border-b border-r border-gray-200 w-32">RMA #</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 border-b border-r border-gray-200 min-w-[120px]">Customer</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-600 border-b border-r border-gray-200 w-24">RMA Status</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-600 border-b border-r border-gray-200 w-28">Date Added</th>
                  <th className="px-3 py-2.5 text-center font-semibold text-gray-600 border-b border-gray-200 w-16">Days</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u, idx) => {
                  const isSelected = selected.includes(u.id)
                  const age = daysSince(u.created_date)
                  const tk  = ticketMap[u.rma_number]
                  return (
                    <tr key={u.id}
                      onClick={() => canTransfer && toggle(u.id)}
                      className={`border-b border-gray-100 transition-colors ${isSelected ? 'bg-indigo-50' : idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'} ${canTransfer ? 'cursor-pointer hover:bg-indigo-50/40' : ''}`}>
                      {canTransfer && (
                        <td className="px-3 py-1.5 text-center border-r border-gray-100">
                          <input type="checkbox" checked={isSelected} onChange={() => {}} className="rounded border-gray-300 text-indigo-600 cursor-pointer"/>
                        </td>
                      )}
                      <td className="px-2 py-1.5 text-center text-gray-500 tabular-nums border-r border-gray-100">{idx + 1}</td>
                      <td className="px-3 py-1.5 font-medium text-gray-900 border-r border-gray-100 max-w-[160px] truncate" title={u.product_name || ''}>{u.product_name || '—'}</td>
                      <td className="px-3 py-1.5 text-gray-500 border-r border-gray-100">{brandMap[u.product_name] || '—'}</td>
                      <td className="px-3 py-1.5 font-mono text-gray-600 border-r border-gray-100">{u.serial_number || '—'}</td>
                      <td className="px-3 py-1.5 text-center border-r border-gray-100"><WarrantyBadge status={u.warranty_status}/></td>
                      <td className="px-3 py-1.5 text-center border-r border-gray-100"><StatusBadge status={u.status}/></td>
                      <td className="px-3 py-1.5 text-center border-r border-gray-100"><ResolutionBadge type={u.resolution_type}/></td>
                      <td className="px-3 py-1.5 font-mono text-indigo-600 border-r border-gray-100">{u.rma_number || '—'}</td>
                      <td className="px-3 py-1.5 text-gray-700 border-r border-gray-100">{tk?.customer_name || '—'}</td>
                      <td className="px-3 py-1.5 text-center border-r border-gray-100">
                        {tk?.ticket_status
                          ? <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${TICKET_STATUS_CLS[tk.ticket_status] || 'bg-gray-100 text-gray-500'}`}>{tk.ticket_status}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-gray-500 border-r border-gray-100">{fmtDate(u.created_date)}</td>
                      <td className="px-3 py-1.5 text-center">
                        <span className={`text-xs font-semibold ${age > 30 ? 'text-red-600' : age > 14 ? 'text-amber-600' : 'text-gray-500'}`}>{age}d</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-between flex-shrink-0">
          <span className="text-xs text-gray-500">
            {search ? `${filtered.length} of ${units.length} units` : `${units.length} unit${units.length !== 1 ? 's' : ''} total`}
            {selected.length > 0 && <span className="ml-2 text-indigo-600 font-medium">{selected.length} selected</span>}
          </span>
          <button onClick={onClose} className="px-4 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50">Close</button>
        </div>
      </div>
      {showTransfer && (
        <TransferModal
          units={selected.length > 0 ? selected : filtered.map(u => u.id)}
          warehouses={warehouses}
          currentWarehouseId={wh.isSystem ? null : wh.id}
          onConfirm={handleTransfer}
          onClose={() => setShowTransfer(false)}
        />
      )}
    </div>
  )
}

// ─── Create / Edit Warehouse Modal ─────────────────────────────────────────────
function CreateWarehouseModal({ initialData, warehouses = [], onSave, onClose }) {
  const isEdit = !!initialData?.id

  const autoCode = useMemo(() => {
    if (isEdit) return initialData?.code || ''
    const nums = warehouses.map(w => {
      const m = (w.code || '').match(/^WH-(\d+)$/)
      return m ? parseInt(m[1]) : 0
    }).filter(n => n > 0)
    const max = nums.length ? Math.max(...nums) : 0
    return `WH-${String(max + 1).padStart(3, '0')}`
  }, [isEdit, warehouses, initialData])

  const [name, setName]         = useState(initialData?.name || '')
  const [code, setCode]         = useState(autoCode)
  const [location, setLocation] = useState(initialData?.location || '')
  const [desc, setDesc]         = useState(initialData?.description || '')
  const [active, setActive]     = useState(initialData?.is_active ?? true)
  const [saving, setSaving]     = useState(false)

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try { await onSave({ name: name.trim(), code: code.trim() || null, location: location.trim() || null, description: desc.trim() || null, is_active: active }) }
    catch { toast.error('Failed to save warehouse') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="p-6 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">{isEdit ? 'Edit Warehouse' : 'New Warehouse'}</h3>
          {!isEdit && <p className="text-xs text-gray-500 mt-0.5">Auto-assigned code: <span className="font-mono font-semibold text-indigo-600">{autoCode}</span></p>}
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">Warehouse Name <span className="text-red-500">*</span></label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Dubai Main Warehouse"
              className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent" autoFocus/>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">Code</label>
              <input value={code} onChange={e => setCode(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent font-mono"/>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">Location</label>
              <input value={location} onChange={e => setLocation(e.target.value)} placeholder="City, Area"
                className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent"/>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">Description</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="Optional notes…"
              className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm resize-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent"/>
          </div>
          {isEdit && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"/>
              <span className="text-sm text-gray-700">Active</span>
            </label>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50">Cancel</button>
          <button onClick={handleSave} disabled={!name.trim()||saving}
            className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 min-w-[100px] text-center">
            {saving ? <Spinner size="sm" color="white" /> : isEdit ? 'Save Changes' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Transfer Modal ────────────────────────────────────────────────────────────
function TransferModal({ units: unitIds, warehouses, currentWarehouseId, onConfirm, onClose }) {
  const [dest, setDest]   = useState('')
  const [saving, setSaving] = useState(false)
  const handleConfirm = async () => {
    if (!dest && dest !== '__system') return
    setSaving(true)
    await onConfirm(dest === '__system' ? null : dest)
    setSaving(false)
  }
  return (
    <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="p-6 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">Transfer Units</h3>
          <p className="text-sm text-gray-500 mt-1">{unitIds.length} unit{unitIds.length!==1?'s':''} selected</p>
        </div>
        <div className="p-6 space-y-2">
          <label className="block text-xs font-semibold text-gray-700 mb-2">Select Destination Warehouse</label>
          <label className={`flex items-center gap-3 p-3 border-2 rounded-xl cursor-pointer transition-all ${dest==='__system'?'border-gray-400 bg-gray-50':'border-gray-200 hover:border-gray-300'}`}>
            <input type="radio" name="dest" value="__system" checked={dest==='__system'} onChange={()=>setDest('__system')} className="text-indigo-600"/>
            <div>
              <div className="font-medium text-sm text-gray-900">System Pool</div>
              <div className="text-xs text-gray-500">Remove from custom warehouse, return to status-based tracking</div>
            </div>
          </label>
          {warehouses.filter(w => w.is_active && w.id !== currentWarehouseId).map(wh => (
            <label key={wh.id} className={`flex items-center gap-3 p-3 border-2 rounded-xl cursor-pointer transition-all ${dest===wh.id?'border-indigo-400 bg-indigo-50':'border-gray-200 hover:border-indigo-200'}`}>
              <input type="radio" name="dest" value={wh.id} checked={dest===wh.id} onChange={()=>setDest(wh.id)} className="text-indigo-600"/>
              <div>
                <div className="font-medium text-sm text-gray-900">{wh.name}</div>
                {(wh.code||wh.location) && <div className="text-xs text-gray-500">{[wh.code,wh.location].filter(Boolean).join(' · ')}</div>}
              </div>
            </label>
          ))}
          {warehouses.filter(w => w.is_active && w.id !== currentWarehouseId).length === 0 && warehouses.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-4">No custom warehouses available. Create one in the Warehouses tab.</p>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50">Cancel</button>
          <button onClick={handleConfirm} disabled={!dest||saving}
            className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 min-w-[120px] text-center">
            {saving ? <Spinner size="sm" color="white" /> : 'Confirm Transfer'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Manufacturer Returns ──────────────────────────────────────────────────────
function ManufacturerTab({ batches, units, brands, userEmail, canManageBatches, onReload }) {
  const [selectedBrand, setSelectedBrand] = useState(null)
  const [selectedBatch, setSelectedBatch] = useState(null)
  const getBatchUnits  = batchId => units.filter(u => u.manufacturer_batch_id === batchId)
  const getBrandBatches = name => batches.filter(b => b.manufacturer_name?.toLowerCase() === name?.toLowerCase())
  const getBrandStats = name => {
    const bb = getBrandBatches(name)
    return { total: bb.length, draft: bb.filter(b=>b.status==='draft').length, sent: bb.filter(b=>b.status==='sent').length, resolved: bb.filter(b=>b.status==='resolved').length, units: bb.reduce((s,b) => s+(getBatchUnits(b.id).length||b.unit_count||0),0) }
  }
  const knownNames = brands.map(b => b.brand_name?.toLowerCase())
  const otherBatches = batches.filter(b => !knownNames.includes(b.manufacturer_name?.toLowerCase()))
  const displayBatches = selectedBrand==='__other' ? otherBatches : selectedBrand ? getBrandBatches(selectedBrand) : batches

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">Brand Warehouses</h3>
          {selectedBrand && <button onClick={()=>setSelectedBrand(null)} className="text-xs text-indigo-600 hover:underline">Clear filter</button>}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {brands.map(brand => {
            const s = getBrandStats(brand.brand_name); const isA = selectedBrand===brand.brand_name
            return (
              <button key={brand.id} onClick={()=>setSelectedBrand(isA?null:brand.brand_name)}
                className={`rounded-2xl border p-4 text-left transition-all ${isA?'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-300':'border-gray-200 bg-white hover:border-indigo-200 hover:bg-indigo-50/40'}`}>
                <BrandAvatar name={brand.brand_name} size="md"/>
                <div className="mt-3"><div className="font-semibold text-sm text-gray-900 truncate">{brand.brand_name}</div><div className="text-xs text-gray-500 mt-0.5">{s.total} batch{s.total!==1?'es':''} · {s.units} unit{s.units!==1?'s':''}</div></div>
                {s.total>0 ? (
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {s.draft>0    && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">{s.draft} draft</span>}
                    {s.sent>0     && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700">{s.sent} sent</span>}
                    {s.resolved>0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">{s.resolved} done</span>}
                  </div>
                ) : <div className="mt-2 text-[10px] text-gray-300 font-medium">No batches yet</div>}
              </button>
            )
          })}
          {otherBatches.length>0 && (
            <button onClick={()=>setSelectedBrand(selectedBrand==='__other'?null:'__other')}
              className={`rounded-2xl border p-4 text-left transition-all ${selectedBrand==='__other'?'border-gray-400 bg-gray-50 ring-2 ring-gray-300':'border-dashed border-gray-300 bg-white hover:border-gray-400'}`}>
              <div className="w-9 h-9 bg-gray-200 rounded-xl flex items-center justify-center text-gray-500 text-base font-bold">?</div>
              <div className="mt-3"><div className="font-semibold text-sm text-gray-900">Other</div><div className="text-xs text-gray-500 mt-0.5">{otherBatches.length} batch{otherBatches.length!==1?'es':''}</div></div>
            </button>
          )}
        </div>
      </div>

      {displayBatches.length===0 ? (
        <div className="text-center py-16 bg-white rounded-2xl border border-gray-200 space-y-3">
          <div className="w-14 h-14 bg-purple-100 rounded-2xl flex items-center justify-center mx-auto"><svg className="w-7 h-7 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg></div>
          <p className="text-gray-600 font-medium">{selectedBrand?`No batches for ${selectedBrand} yet`:'No manufacturer batches yet'}</p>
          <p className="text-gray-500 text-sm">Go to Company Stock, open a product, and select units to create a batch.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          {selectedBrand && selectedBrand!=='__other' && (
            <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 bg-indigo-50/60">
              <BrandAvatar name={selectedBrand} size="md"/>
              <div><div className="font-semibold text-gray-900">{selectedBrand} — Return Batches</div><div className="text-xs text-gray-500">{displayBatches.length} batch{displayBatches.length!==1?'es':''}</div></div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>{['Batch #','Manufacturer','Units','Status','Sent Date','Tracking #','Resolution','Created'].map(h=><th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>)}<th className="px-4 py-3 w-16"/></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {displayBatches.map(b => {
                  const sm=BATCH_STATUS_META[b.status]||{label:b.status,cls:'bg-gray-100 text-gray-600'}
                  const resLabel = b.resolution_type==='replacement_received'?{label:'Replacement Rcvd',cls:'bg-green-100 text-green-700'}:b.resolution_type==='credit_note_received'?{label:'Credit Note Rcvd',cls:'bg-blue-100 text-blue-700'}:null
                  return (
                    <tr key={b.id} className="hover:bg-gray-50 cursor-pointer" onClick={()=>setSelectedBatch(b)}>
                      <td className="px-4 py-3 font-mono text-xs font-bold text-indigo-600">{b.batch_number}</td>
                      <td className="px-4 py-3"><div className="flex items-center gap-2"><BrandAvatar name={b.manufacturer_name} size="xs"/><span className="text-gray-900 font-medium text-sm">{b.manufacturer_name}</span></div></td>
                      <td className="px-4 py-3 text-gray-600">{getBatchUnits(b.id).length||b.unit_count||0}</td>
                      <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sm.cls}`}>{sm.label}</span></td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmt(b.sent_date)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{b.tracking_number||'—'}</td>
                      <td className="px-4 py-3">{resLabel?<span className={`px-2 py-0.5 rounded-full text-xs font-medium ${resLabel.cls}`}>{resLabel.label}</span>:<span className="text-gray-500 text-xs">—</span>}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmt(b.created_date)}</td>
                      <td className="px-4 py-3 text-right"><span className="text-xs text-indigo-600 hover:underline">View</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {selectedBatch && <BatchDetailModal batch={selectedBatch} batchUnits={getBatchUnits(selectedBatch.id)} canEdit={canManageBatches} onClose={()=>setSelectedBatch(null)} onReload={()=>{setSelectedBatch(null);onReload()}} />}
    </div>
  )
}

// ─── Resolve Modal ─────────────────────────────────────────────────────────────
function ResolveModal({ count, onConfirm, onClose }) {
  const [resolution, setResolution] = useState('')
  const [notes, setNotes]           = useState('')
  const [saving, setSaving]         = useState(false)
  const options = [
    {value:'return_to_customer',label:'Return to Customer', desc:'Unit returned — exits inventory.',          active:'border-green-400 bg-green-50'},
    {value:'credit_note',       label:'Credit Note Issued',desc:'Credit note — moves to Company Stock.',     active:'border-orange-400 bg-orange-50'},
    {value:'replacement',       label:'Replacement Issued', desc:'Replacement sent — moves to Company Stock.',active:'border-indigo-400 bg-indigo-50'},
  ]
  const handleConfirm = async () => { if(!resolution)return; setSaving(true); await onConfirm(resolution,notes); setSaving(false) }
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6 border-b border-gray-100"><h3 className="text-lg font-semibold text-gray-900">Set Resolution</h3><p className="text-sm text-gray-500 mt-1">{count} unit{count!==1?'s':''} selected</p></div>
        <div className="p-6 space-y-3">
          {options.map(o => (<label key={o.value} className={`flex items-start gap-3 p-4 border-2 rounded-xl cursor-pointer transition-all ${resolution===o.value?o.active:'border-gray-200 hover:border-gray-300 bg-white'}`}><input type="radio" name="resolution" value={o.value} checked={resolution===o.value} onChange={()=>setResolution(o.value)} className="mt-0.5 text-indigo-600"/><div><div className="font-medium text-sm text-gray-900">{o.label}</div><div className="text-xs text-gray-500 mt-0.5">{o.desc}</div></div></label>))}
          <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Notes (optional)" rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm resize-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent"/>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50">Cancel</button>
          <button onClick={handleConfirm} disabled={!resolution||saving} className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 min-w-[140px] text-center">{saving?<Spinner size="sm" color="white" />:'Confirm Resolution'}</button>
        </div>
      </div>
    </div>
  )
}

// ─── Create Batch Modal ────────────────────────────────────────────────────────
function CreateBatchModal({ count, brands, onConfirm, onClose }) {
  const [brandName, setBrandName]   = useState('')
  const [customName, setCustomName] = useState('')
  const [saving, setSaving]         = useState(false)
  const effectiveName = brandName==='__custom' ? customName.trim() : brandName
  const handleConfirm = async () => { if(!effectiveName)return; setSaving(true); await onConfirm(effectiveName); setSaving(false) }
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="p-6 border-b border-gray-100"><h3 className="text-lg font-semibold text-gray-900">Create Manufacturer Batch</h3><p className="text-sm text-gray-500 mt-1">{count} unit{count!==1?'s':''} will be added</p></div>
        <div className="p-6 space-y-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">Manufacturer Name</label>
          {brands.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {brands.map(b => (<button key={b.id||b.brand_name} type="button" onClick={()=>setBrandName(b.brand_name||b)} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all text-left ${brandName===(b.brand_name||b)?'border-indigo-400 bg-indigo-50 text-indigo-700':'border-gray-200 hover:border-indigo-200 text-gray-700'}`}><BrandAvatar name={b.brand_name||b} size="xs"/>{b.brand_name||b}</button>))}
              <button type="button" onClick={()=>setBrandName('__custom')} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all ${brandName==='__custom'?'border-gray-400 bg-gray-50':'border-dashed border-gray-300 hover:border-gray-400 text-gray-500'}`}><div className="w-5 h-5 bg-gray-200 rounded flex items-center justify-center text-xs font-bold">+</div>Other</button>
            </div>
          ) : null}
          {(brands.length === 0 || brandName === '__custom') && (
            <input value={customName} onChange={e=>setCustomName(e.target.value)} placeholder="Manufacturer name..." autoFocus
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600"
              onKeyDown={e=>e.key==='Enter'&&handleConfirm()} />
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50">Cancel</button>
          <button onClick={handleConfirm} disabled={!effectiveName||saving} className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 min-w-[120px] text-center">{saving?<Spinner size="sm" color="white" />:'Create Batch'}</button>
        </div>
      </div>
    </div>
  )
}

// ─── Batch Detail Modal ────────────────────────────────────────────────────────
function BatchDetailModal({ batch, batchUnits, canEdit, onClose, onReload }) {
  const [sentDate, setSentDate] = useState(batch.sent_date||new Date().toISOString().split('T')[0])
  const [tracking, setTracking] = useState(batch.tracking_number||'')
  const [resType, setResType]   = useState(batch.resolution_type||'')
  const [resDate, setResDate]   = useState(batch.resolution_date||new Date().toISOString().split('T')[0])
  const [resNotes, setResNotes] = useState(batch.resolution_notes||'')
  const [saving, setSaving]     = useState(false)
  const sm = BATCH_STATUS_META[batch.status]||{label:batch.status,cls:'bg-gray-100 text-gray-600'}

  const handleMarkSent = async () => { setSaving(true); try { await db.inventory.markBatchSent(batch.id,sentDate,tracking); toast.success('Batch marked as sent'); onReload() } catch { toast.error('Failed') } finally { setSaving(false) } }
  const handleMarkResolved = async () => { if(!resType)return; setSaving(true); try { await db.inventory.markBatchResolved(batch.id,resType,resDate,resNotes); toast.success('Batch resolved!'); onReload() } catch { toast.error('Failed') } finally { setSaving(false) } }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-4">
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <BrandAvatar name={batch.manufacturer_name} size="lg"/>
            <div><h3 className="text-lg font-bold text-gray-900 font-mono">{batch.batch_number}</h3><div className="flex items-center gap-3 mt-0.5"><span className="text-sm text-gray-600 font-medium">{batch.manufacturer_name}</span><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sm.cls}`}>{sm.label}</span></div></div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg></button>
        </div>
        {(batch.sent_date||batch.tracking_number) && (
          <div className="px-6 py-3 bg-gray-50 border-b border-gray-100 flex gap-6 text-sm">
            {batch.sent_date && <div><span className="text-gray-500 text-xs">Sent:</span> <span className="font-medium text-gray-700">{fmt(batch.sent_date)}</span></div>}
            {batch.tracking_number && <div><span className="text-gray-500 text-xs">Tracking:</span> <span className="font-mono font-medium text-gray-700">{batch.tracking_number}</span></div>}
          </div>
        )}
        <div className="p-6 border-b border-gray-100">
          <h4 className="text-sm font-semibold text-gray-700 mb-3">Units in Batch ({batchUnits.length})</h4>
          {batchUnits.length===0 ? <p className="text-sm text-gray-500">No units.</p> : (
            <div className="rounded-xl border border-gray-100 overflow-hidden">
              <table className="w-full text-sm"><thead className="bg-gray-50"><tr>{['Product','Serial #','Warranty','RMA Source','Resolution'].map(h=><th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-gray-50">{batchUnits.map(u=><tr key={u.id} className="hover:bg-gray-50"><td className="px-3 py-2.5 text-gray-900 font-medium">{u.product_name||'—'}</td><td className="px-3 py-2.5 font-mono text-xs text-gray-500">{u.serial_number||'—'}</td><td className="px-3 py-2.5"><WarrantyBadge status={u.warranty_status}/></td><td className="px-3 py-2.5 font-mono text-xs text-indigo-600">{u.rma_number||'—'}</td><td className="px-3 py-2.5"><ResolutionBadge type={u.resolution_type}/></td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
        {canEdit && batch.status==='draft' && (
          <div className="p-6 border-b border-gray-100">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
              <h4 className="text-sm font-semibold text-blue-900">Mark as Sent to Manufacturer</h4>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-xs font-medium text-blue-700 mb-1">Sent Date</label><input type="date" value={sentDate} onChange={e=>setSentDate(e.target.value)} className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500"/></div>
                <div><label className="block text-xs font-medium text-blue-700 mb-1">Tracking Number</label><input value={tracking} onChange={e=>setTracking(e.target.value)} placeholder="AWB / courier tracking..." className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500"/></div>
              </div>
              <button onClick={handleMarkSent} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50">{saving?<div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"/>:<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/></svg>}Mark as Sent</button>
            </div>
          </div>
        )}
        {canEdit && batch.status==='sent' && (
          <div className="p-6 border-b border-gray-100">
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
              <h4 className="text-sm font-semibold text-green-900">Mark Batch as Resolved</h4>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-xs font-medium text-green-700 mb-1">Resolution Type</label><select value={resType} onChange={e=>setResType(e.target.value)} className="w-full px-3 py-2 border border-green-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-green-500"><option value="">Select...</option><option value="replacement_received">Replacement Units Received</option><option value="credit_note_received">Credit Note Received</option></select></div>
                <div><label className="block text-xs font-medium text-green-700 mb-1">Resolution Date</label><input type="date" value={resDate} onChange={e=>setResDate(e.target.value)} className="w-full px-3 py-2 border border-green-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-green-500"/></div>
              </div>
              <textarea value={resNotes} onChange={e=>setResNotes(e.target.value)} placeholder="Notes..." rows={2} className="w-full px-3 py-2 border border-green-200 rounded-lg text-sm bg-white resize-none focus:ring-2 focus:ring-green-500"/>
              <button onClick={handleMarkResolved} disabled={!resType||saving} className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 disabled:opacity-50">{saving?<div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"/>:<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>}Mark as Resolved</button>
            </div>
          </div>
        )}
        {batch.status==='resolved' && (
          <div className="p-6 border-b border-gray-100">
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-1.5">
              <div className="flex items-center gap-2 mb-2"><svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span className="font-semibold text-green-900">Batch Resolved</span></div>
              <p className="text-sm text-green-800">Resolution: <strong>{batch.resolution_type==='replacement_received'?'Replacement Units Received':'Credit Note Received'}</strong></p>
              {batch.resolution_date && <p className="text-sm text-green-800">Date: <strong>{fmt(batch.resolution_date)}</strong></p>}
              {batch.resolution_notes && <p className="text-sm text-green-800">Notes: <strong>{batch.resolution_notes}</strong></p>}
            </div>
          </div>
        )}
        <div className="px-6 py-4 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50">Close</button>
        </div>
      </div>
    </div>
  )
}
