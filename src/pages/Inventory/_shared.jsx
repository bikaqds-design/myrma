/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import toast from 'react-hot-toast'

// ─── Constants ─────────────────────────────────────────────────────────────────
export const STATUS_META = {
  active_rma:           { label: 'Active RMA',    cls: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-900/30' },
  company_stock:        { label: 'Company Stock', cls: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900/30' },
  sent_to_manufacturer: { label: 'Sent to Mfr',  cls: 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-900/30' },
  closed:               { label: 'Closed',        cls: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2] border-gray-200 dark:border-[#212a38]' },
}
export const RESOLUTION_META = {
  return_to_customer: { label: 'Return to Customer', cls: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400' },
  credit_note:        { label: 'Credit Note',         cls: 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300' },
  replacement:        { label: 'Replacement',          cls: 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300' },
  can_t_repair:       { label: "Can't Repair",         cls: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300' },
}
export const BATCH_STATUS_META = {
  draft:    { label: 'Draft',    cls: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]' },
  sent:     { label: 'Sent',     cls: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400' },
  resolved: { label: 'Resolved', cls: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400' },
}
export const _SYSTEM_WAREHOUSES = [
  {
    id: '__active_rma',
    name: 'Active RMA',
    status: 'active_rma',
    cls: 'bg-blue-50 border-blue-200',
    tc: 'text-blue-700',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
  },
  {
    id: '__company_stock',
    name: 'Company Stock',
    status: 'company_stock',
    cls: 'bg-amber-50 border-amber-200',
    tc: 'text-amber-700',
    icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  },
  {
    id: '__sent_to_manufacturer',
    name: 'Sent to Manufacturer',
    status: 'sent_to_manufacturer',
    cls: 'bg-purple-50 border-purple-200',
    tc: 'text-purple-700',
    icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
  },
  {
    id: '__closed',
    name: 'Closed',
    status: 'closed',
    cls: 'bg-gray-50 border-gray-200',
    tc: 'text-gray-600',
    icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  },
]
export const WAREHOUSE_SQL = `-- Run in Supabase SQL Editor to enable warehouses:

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

export const PRODUCT_STATUS_CLS = {
  Received:      'bg-gray-100 dark:bg-[#1a2230] text-gray-700 dark:text-[#9aa4b2]',
  'Under Repair':'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  Repaired:      'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  "Can't Repair":'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
  Replacement:   'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300',
  'Credit Note': 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300',
}
export const TICKET_STATUS_CLS = {
  New:          'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  'In Progress':'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400',
  'On Hold':    'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300',
  Completed:    'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
}

// System RMA/transit/virtual location code (e.g. 'RMA-RECEIVED') -> its i18n
// key (e.g. 'inventory.loc_RMA_RECEIVED'). DB codes stay English/fixed —
// only the displayed label is translated.
export function locationI18nKey(code) {
  return `inventory.loc_${String(code || '').replace(/-/g, '_')}`
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
export function daysSince(iso) {
  if (!iso) return 0
  return Math.floor((Date.now() - new Date(iso)) / 86400000)
}
export function fmt(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}
export function groupByProduct(units, brandMap) {
  const map = {}
  for (const u of units) {
    const key = u.product_name || 'Unknown Product'
    if (!map[key])
      map[key] = {
        product_name: key,
        brand: brandMap[key] || '',
        units: [],
        active_rma: 0,
        company_stock: 0,
        sent_to_manufacturer: 0,
        closed: 0,
        replacement: 0,
        credit_note: 0,
      }
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
export function downloadCSV(rows, filename) {
  if (!rows.length) {
    toast('No data to export')
    return
  }
  const headers = Object.keys(rows[0])
  const escape = (v) => {
    const s = String(v ?? '').replace(/"/g, '""')
    return s.includes(',') || s.includes('\n') || s.includes('"') ? `"${s}"` : s
  }
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\r\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  toast.success(i18next.t('inventory.exportedRows', { count: rows.length }))
}

// ─── Pagination ─────────────────────────────────────────────────────────────
// Moved to components/Pagination.jsx — it was imported by sixteen files across
// nine modules while living in an Inventory private file. Re-exported here so
// those callers keep working unchanged.
export { default as Pagination } from '../../components/Pagination'

// ─── Unified search + filter toolbar (shared across all Inventory tabs) ────────
// The canonical pattern (established in ByProductTab): a search box with a
// leading magnifier icon + a "Filters" toggle button carrying an active-count
// badge. Every Inventory tab renders this identical chrome; each tab supplies
// its own filter-panel body via InvFilterPanel below.
export function InvToolbar({
  searchRef,
  search,
  onSearchChange,
  placeholder,
  showFilters,
  onToggleFilters,
  activeFilterCount = 0,
  hasFilters = true,
  right = null,
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-2 flex-1 max-w-2xl">
        <div className="relative flex-1">
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={placeholder}
            // Named from the placeholder every caller already passes. A
            // placeholder is not an accessible name, so without this the search
            // box on every Inventory tab was an unlabelled text field.
            aria-label={placeholder}
            className="w-full ps-9 pe-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#746f65] dark:placeholder:text-[#a4acb7]"
          />
          <svg
            className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute start-3 top-1/2 -translate-y-1/2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        {hasFilters && (
          <button
            onClick={onToggleFilters}
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${showFilters || activeFilterCount > 0 ? 'border-[#4338ca] text-[#4338ca] bg-indigo-50 dark:bg-indigo-900/20 dark:border-[#a5b4fc] dark:text-[#a5b4fc]' : 'border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'}`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"
              />
            </svg>
            {t('common.filters')}
            {activeFilterCount > 0 && (
              <span className="w-4 h-4 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] text-xs rounded-full flex items-center justify-center">
                {activeFilterCount}
              </span>
            )}
          </button>
        )}
      </div>
      {right}
    </div>
  )
}

// Collapsible filter-panel container — the tab passes its own controls as
// children; the shared shell keeps the styling + "Clear filters" identical.
export function InvFilterPanel({ show, onClear, activeFilterCount = 0, children }) {
  const { t } = useTranslation()
  if (!show) return null
  return (
    <div className="flex items-center gap-4 p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] flex-wrap">
      {children}
      {activeFilterCount > 0 && (
        <button onClick={onClear} className="text-sm text-red-600 hover:underline ms-auto">
          {t('inventory.clearFilters')}
        </button>
      )}
    </div>
  )
}

// A single labeled filter control (label + select/input), for consistent
// spacing inside InvFilterPanel.
export function InvFilterField({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0]">{label}</label>
      {children}
    </div>
  )
}

export const INV_FILTER_SELECT_CLS =
  'px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent'

// ─── Shared UI Atoms ──────────────────────────────────────────────────────────
export function StatusBadge({ status }) {
  const m = STATUS_META[status] || {
    label: status,
    cls: 'bg-gray-100 text-gray-600 border-gray-200',
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${m.cls}`}
    >
      {m.label}
    </span>
  )
}
export function ResolutionBadge({ type }) {
  if (!type) return <span className="text-gray-500 text-xs">—</span>
  const m = RESOLUTION_META[type] || { label: type, cls: 'bg-gray-100 text-gray-600' }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${m.cls}`}
    >
      {m.label}
    </span>
  )
}
export function WarrantyBadge({ status }) {
  if (!status) return <span className="text-gray-500 text-xs">—</span>
  const cls =
    status === 'In Warranty'
      ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
      : status === 'Unknown'
        ? 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'
        : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300'
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{status}</span>
}
export function BrandAvatar({ name, size = 'md' }) {
  const palette = [
    'bg-blue-500',
    'bg-indigo-500',
    'bg-violet-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-rose-500',
    'bg-orange-500',
    'bg-amber-500',
    'bg-teal-500',
    'bg-cyan-500',
  ]
  const color =
    palette[(name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % palette.length]
  const sz =
    size === 'lg'
      ? 'w-12 h-12 text-base'
      : size === 'md'
        ? 'w-9 h-9 text-sm'
        : size === 'sm'
          ? 'w-7 h-7 text-xs'
          : 'w-5 h-5 text-[10px]'
  return (
    <div
      className={`${sz} ${color} rounded-xl flex items-center justify-center flex-shrink-0 text-white font-bold`}
    >
      {(name || '?')[0].toUpperCase()}
    </div>
  )
}

// ─── Brand Filter Bar ──────────────────────────────────────────────────────────
export function BrandBar({ brands, groups, selected, onSelect }) {
  const { t } = useTranslation()
  const brandUnitCount = {}
  for (const g of groups) brandUnitCount[g.brand] = (brandUnitCount[g.brand] || 0) + g.units.length
  const total = groups.reduce((s, g) => s + g.units.length, 0)
  const chip = (isActive) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-sm font-medium whitespace-nowrap transition-all ${isActive ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600'}`
  const cnt = (isActive, n) => (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded-full ${isActive ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-600'}`}
    >
      {n}
    </span>
  )
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 flex-wrap">
      <button onClick={() => onSelect(null)} className={chip(!selected)}>
        {' '}
        {t('inventory.allBrands')} {cnt(!selected, total)}
      </button>
      {brands.map((b) => {
        const isA = selected === b.brand_name
        return (
          <button
            key={b.id}
            onClick={() => onSelect(isA ? null : b.brand_name)}
            className={chip(isA)}
          >
            <BrandAvatar name={b.brand_name} size="xs" />
            {b.brand_name}
            {cnt(isA, brandUnitCount[b.brand_name] || 0)}
          </button>
        )
      })}
    </div>
  )
}

// ─── Inventory Sort Button ────────────────────────────────────────────────────
export function InvSortBtn({ label, sortKey, activeSortKey, activeSortDir, onSort }) {
  const { t } = useTranslation()
  const isActive = activeSortKey === sortKey
  const ariaSort = isActive ? (activeSortDir === 'asc' ? 'ascending' : 'descending') : 'none'
  return (
    <button
      onClick={() => onSort(sortKey)}
      aria-label={t('inventory.sortBy', { label })}
      aria-sort={ariaSort}
      className="flex items-center gap-1 hover:text-gray-900 transition-colors"
    >
      {label}
      {isActive ? (
        activeSortDir === 'asc' ? (
          <svg
            className="w-3 h-3 text-indigo-600 ms-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        ) : (
          <svg
            className="w-3 h-3 text-indigo-600 ms-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )
      ) : (
        <svg
          className="w-3 h-3 text-gray-300 ms-0.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
          />
        </svg>
      )}
    </button>
  )
}
