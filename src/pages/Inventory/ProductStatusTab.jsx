import React, { useState, useEffect, useMemo } from 'react'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import {
  Pagination,
  WarrantyBadge,
  InvSortBtn,
  PRODUCT_STATUS_CLS,
  TICKET_STATUS_CLS,
  downloadCSV,
} from './_shared'
import { TransferModal } from './TransferModal'

// ─── Product Status Tab (Received / Under Repair / Repaired / Can't Repair / RMA Stock) ──
export function ProductStatusTab({
  products,
  showTypeCol,
  brandMap = {},
  onNavigateToTicket,
  warehouses = [],
  units = [],
  canTransfer = false,
  userEmail,
  onReload,
}) {
  const [search, setSearch] = useState('')
  const [filterProduct, setFilterProduct] = useState('')
  const [filterBrand, setFilterBrand] = useState('')
  const [filterProductStatus, setFilterProductStatus] = useState('')
  const [filterRmaStatus, setFilterRmaStatus] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [sortKey, setSortKey] = useState('product_name')
  const [sortDir, setSortDir] = useState('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(25)
  const [expanded, setExpanded] = useState(new Set())
  const [selectedGroups, setSelectedGroups] = useState([])
  const [showTransfer, setShowTransfer] = useState(false)
  const [transferring, setTransferring] = useState(false)

  const handleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }
  const toggleExpand = (name) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  const toggleSelect = (name) =>
    setSelectedGroups((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
    )

  const grouped = useMemo(() => {
    const map = {}
    for (const p of products) {
      const key = p.product_name || 'Unknown Product'
      if (!map[key])
        map[key] = {
          product_name: key,
          qty: 0,
          in_warranty: 0,
          out_warranty: 0,
          items: [],
          latest_date: null,
        }
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
      .filter((g) => selectedGroups.includes(g.product_name))
      .flatMap((g) => g.items)
    const ids = targetItems
      .map((p) => unitMap[`${p.ticket_id}||${p.serial_number || p.product_name}`])
      .filter(Boolean)
    return { selectedUnitIds: ids, expectedUnitCount: targetItems.length }
  }, [selectedGroups, grouped, units, canTransfer])

  const handleBulkTransfer = async (warehouseId) => {
    if (!selectedUnitIds.length) {
      toast.error('No matching units found in inventory')
      return
    }
    const skipped = expectedUnitCount - selectedUnitIds.length
    if (
      skipped > 0 &&
      !window.confirm(
        `${skipped} of ${expectedUnitCount} selected unit${expectedUnitCount !== 1 ? 's' : ''} are not tracked in inventory and will be skipped. Transfer the remaining ${selectedUnitIds.length}?`
      )
    )
      return
    setTransferring(true)
    try {
      await db.inventory.transferUnits(selectedUnitIds, warehouseId)
      toast.success(
        `${selectedUnitIds.length} unit${selectedUnitIds.length !== 1 ? 's' : ''} transferred${skipped > 0 ? ` (${skipped} skipped)` : ''}`
      )
      db.auditLog
        .log(
          userEmail,
          'inventory_units_transferred',
          `Transferred ${selectedUnitIds.length} unit${selectedUnitIds.length !== 1 ? 's' : ''} to warehouse ${warehouseId}`
        )
        .catch(() => {})
      setSelectedGroups([])
      setShowTransfer(false)
      onReload?.()
    } catch {
      toast.error('Transfer failed')
    } finally {
      setTransferring(false)
    }
  }

  const uniqueBrands = useMemo(
    () => [...new Set(products.map((p) => brandMap[p.product_name]).filter(Boolean))].sort(),
    [products, brandMap]
  )
  const uniqueStatuses = useMemo(
    () => [...new Set(products.map((p) => p.product_status).filter(Boolean))].sort(),
    [products]
  )

  const activeFilterCount = [
    filterProduct,
    filterBrand,
    filterProductStatus,
    filterRmaStatus,
  ].filter(Boolean).length

  const filtered = useMemo(() => {
    let list = [...grouped]
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (g) =>
          g.product_name.toLowerCase().includes(q) ||
          g.items.some(
            (p) =>
              p.rma_number?.toLowerCase().includes(q) ||
              p.customer_name?.toLowerCase().includes(q) ||
              p.serial_number?.toLowerCase().includes(q)
          )
      )
    }
    if (filterProduct)
      list = list.filter((g) => g.product_name.toLowerCase().includes(filterProduct.toLowerCase()))
    if (filterBrand) list = list.filter((g) => brandMap[g.product_name] === filterBrand)
    if (filterProductStatus)
      list = list.filter((g) => g.items.some((p) => p.product_status === filterProductStatus))
    if (filterRmaStatus)
      list = list.filter((g) => g.items.some((p) => p.ticket_status === filterRmaStatus))
    return list.sort((a, b) => {
      const av = sortKey === 'qty' ? a.qty : a.product_name.toLowerCase()
      const bv = sortKey === 'qty' ? b.qty : b.product_name.toLowerCase()
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [
    grouped,
    search,
    filterProduct,
    filterBrand,
    filterProductStatus,
    filterRmaStatus,
    sortKey,
    sortDir,
    brandMap,
  ])

  useEffect(() => {
    setCurrentPage(1)
  }, [
    search,
    filterProduct,
    filterBrand,
    filterProductStatus,
    filterRmaStatus,
    sortKey,
    sortDir,
    products,
  ])

  const startIndex = (currentPage - 1) * itemsPerPage
  const paginated = filtered.slice(startIndex, startIndex + itemsPerPage)
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')
  const colSpanData = showTypeCol ? 6 : 5
  const pageNames = paginated.map((g) => g.product_name)
  const allPageChk = pageNames.length > 0 && pageNames.every((n) => selectedGroups.includes(n))

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product, RMA#, customer, serial…"
            className="w-full pl-9 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <svg
            className="w-4 h-4 text-gray-500 dark:text-[#9aa4b2] absolute left-2.5 top-1/2 -translate-y-1/2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        <button
          onClick={() => setShowFilters((f) => !f)}
          className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm transition-colors ${showFilters || activeFilterCount > 0 ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-gray-300 text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520]'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"
            />
          </svg>
          Filters
          {activeFilterCount > 0 && (
            <span className="w-4 h-4 bg-indigo-600 text-white text-[10px] rounded-full flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </button>
        <span className="text-xs text-gray-500 dark:text-[#9aa4b2] ml-auto whitespace-nowrap">
          {filtered.length} product{filtered.length !== 1 ? 's' : ''} · {products.length} unit
          {products.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="p-3 bg-gray-50 dark:bg-[#0f1520] border border-gray-200 dark:border-[#212a38] rounded-lg space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">
                Product
              </label>
              <input
                value={filterProduct}
                onChange={(e) => setFilterProduct(e.target.value)}
                placeholder="Filter by product…"
                className="w-full px-2.5 py-1 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-[#121823]"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">
                Brand
              </label>
              <select
                value={filterBrand}
                onChange={(e) => setFilterBrand(e.target.value)}
                className="w-full px-2.5 py-1 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-[#121823]"
              >
                <option value="">All brands</option>
                {uniqueBrands.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">
                Product Status
              </label>
              <select
                value={filterProductStatus}
                onChange={(e) => setFilterProductStatus(e.target.value)}
                className="w-full px-2.5 py-1 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-[#121823]"
              >
                <option value="">All statuses</option>
                {uniqueStatuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">
                RMA Status
              </label>
              <select
                value={filterRmaStatus}
                onChange={(e) => setFilterRmaStatus(e.target.value)}
                className="w-full px-2.5 py-1 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-[#121823]"
              >
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
              <button
                onClick={() => {
                  setFilterProduct('')
                  setFilterBrand('')
                  setFilterProductStatus('')
                  setFilterRmaStatus('')
                }}
                className="text-xs text-red-500 hover:text-red-700 underline"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      )}

      {/* Selection bar */}
      {selectedGroups.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg flex-wrap">
          <span className="w-5 h-5 bg-indigo-600 text-white rounded-full flex items-center justify-center text-[10px] font-bold">
            {selectedGroups.length}
          </span>
          <span className="text-sm font-medium text-indigo-700">
            {selectedGroups.length} product{selectedGroups.length !== 1 ? 's' : ''} selected
            {canTransfer && selectedUnitIds.length > 0 && (
              <span className="text-indigo-400 ml-1">
                ({selectedUnitIds.length} unit{selectedUnitIds.length !== 1 ? 's' : ''})
              </span>
            )}
          </span>
          <button
            onClick={() => setSelectedGroups([])}
            className="text-xs text-indigo-400 hover:text-indigo-700 underline"
          >
            Clear
          </button>
          <div className="h-4 w-px bg-indigo-200 ml-1" />
          {canTransfer && (
            <button
              onClick={() => {
                if (!selectedUnitIds.length) {
                  toast.error('No matching units found in inventory')
                  return
                }
                setShowTransfer(true)
              }}
              disabled={transferring}
              className="flex items-center gap-1.5 px-2.5 py-1 bg-white dark:bg-[#121823] border border-indigo-300 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50 dark:hover:bg-[#1a2230] disabled:opacity-50"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                />
              </svg>
              Transfer to Warehouse
            </button>
          )}
          <button
            onClick={() => {
              const rows = selectedGroups
                .map((name) => {
                  const g = grouped.find((x) => x.product_name === name)
                  return g
                    ? {
                        product: g.product_name,
                        qty: g.qty,
                        in_warranty: g.in_warranty,
                        out_of_warranty: g.out_warranty,
                      }
                    : null
                })
                .filter(Boolean)
              downloadCSV(rows, 'inventory-selected.csv')
              setSelectedGroups([])
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-white dark:bg-[#121823] border border-indigo-300 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50 dark:hover:bg-[#1a2230]"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            Export
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-[#121823] rounded-lg border border-gray-200 dark:border-[#212a38]">
          <p className="text-gray-500 dark:text-[#9aa4b2] text-sm">
            {search || activeFilterCount
              ? 'No products match your filters'
              : 'No products in this category'}
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-gray-200 dark:border-[#212a38] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-gray-100 dark:bg-[#1a2230] sticky top-0 z-10">
                  <tr>
                    <th className="w-9 px-3 py-2 border-b border-r border-gray-200 dark:border-[#212a38] text-center">
                      <input
                        type="checkbox"
                        checked={allPageChk}
                        onChange={(e) =>
                          setSelectedGroups(
                            e.target.checked
                              ? [...new Set([...selectedGroups, ...pageNames])]
                              : selectedGroups.filter((n) => !pageNames.includes(n))
                          )
                        }
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                      />
                    </th>
                    <th className="w-8 px-2 py-2 text-center text-gray-500 dark:text-[#9aa4b2] font-semibold border-b border-r border-gray-200 dark:border-[#212a38]">
                      #
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38]">
                      <InvSortBtn
                        label="Product"
                        sortKey="product_name"
                        activeSortKey={sortKey}
                        activeSortDir={sortDir}
                        onSort={handleSort}
                      />
                    </th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38] w-16">
                      <InvSortBtn
                        label="Qty"
                        sortKey="qty"
                        activeSortKey={sortKey}
                        activeSortDir={sortDir}
                        onSort={handleSort}
                      />
                    </th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38] whitespace-nowrap">
                      In Warranty
                    </th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38] whitespace-nowrap">
                      Out of Warranty
                    </th>
                    {showTypeCol && (
                      <th className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38] min-w-[160px]">
                        Types
                      </th>
                    )}
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-gray-200 dark:border-[#212a38] w-28 whitespace-nowrap">
                      Date
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((g, idx) => {
                    const isOpen = expanded.has(g.product_name)
                    const isSelected = selectedGroups.includes(g.product_name)
                    const typeBreakdown = showTypeCol
                      ? g.items.reduce((acc, p) => {
                          acc[p.product_status] = (acc[p.product_status] || 0) + 1
                          return acc
                        }, {})
                      : null
                    const rowBg = isSelected
                      ? 'bg-indigo-50'
                      : idx % 2 === 0
                        ? 'bg-white dark:bg-[#121823]'
                        : 'bg-gray-50 dark:bg-[#0f1520]/60'
                    return (
                      <React.Fragment key={g.product_name}>
                        <tr
                          className={`${rowBg} border-b border-gray-100 dark:border-[#212a38] transition-colors cursor-pointer hover:bg-indigo-50 dark:hover:bg-[#1a2230]/40`}
                          onClick={() => toggleExpand(g.product_name)}
                        >
                          <td
                            className="px-3 py-1.5 text-center border-r border-gray-100 dark:border-[#212a38]"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleSelect(g.product_name)
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {}}
                              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center text-gray-500 dark:text-[#9aa4b2] tabular-nums border-r border-gray-100 dark:border-[#212a38]">
                            {startIndex + idx + 1}
                          </td>
                          <td className="px-3 py-1.5 font-medium text-gray-900 dark:text-[#e8ebf0] border-r border-gray-100 dark:border-[#212a38]">
                            <div className="flex items-center gap-1.5">
                              <svg
                                className={`w-3 h-3 text-gray-500 dark:text-[#9aa4b2] flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M9 5l7 7-7 7"
                                />
                              </svg>
                              {g.product_name}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-center border-r border-gray-100 dark:border-[#212a38]">
                            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-indigo-100 text-indigo-700">
                              {g.qty}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-center border-r border-gray-100 dark:border-[#212a38]">
                            {g.in_warranty > 0 ? (
                              <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                                {g.in_warranty}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-center border-r border-gray-100 dark:border-[#212a38]">
                            {g.out_warranty > 0 ? (
                              <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                                {g.out_warranty}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          {showTypeCol && (
                            <td className="px-3 py-1.5 border-r border-gray-100 dark:border-[#212a38]">
                              <div className="flex flex-wrap gap-1">
                                {Object.entries(typeBreakdown).map(([type, count]) => (
                                  <span
                                    key={type}
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${PRODUCT_STATUS_CLS[type] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'}`}
                                  >
                                    {type} ×{count}
                                  </span>
                                ))}
                              </div>
                            </td>
                          )}
                          <td className="px-3 py-1.5 text-gray-500 dark:text-[#9aa4b2] whitespace-nowrap">
                            {fmtDate(g.latest_date)}
                          </td>
                        </tr>
                        {isOpen &&
                          g.items.map((p, i) => (
                            <tr
                              key={`${p.rma_number}-${p.serial_number || i}`}
                              className="bg-blue-50/20 border-b border-blue-100/40"
                            >
                              <td className="border-r border-gray-100 dark:border-[#212a38]" />
                              <td className="border-r border-gray-100 dark:border-[#212a38]" />
                              <td colSpan={colSpanData} className="px-4 py-1.5">
                                <div className="flex items-center gap-4 flex-wrap pl-3 border-l-2 border-indigo-200">
                                  <span className="font-mono text-gray-500 dark:text-[#9aa4b2]">
                                    {p.serial_number || 'No S/N'}
                                  </span>
                                  <WarrantyBadge status={p.warranty_status} />
                                  {p.rma_number ? (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        onNavigateToTicket?.(p.ticket_id)
                                      }}
                                      className="font-mono text-indigo-600 hover:text-indigo-800 hover:underline"
                                    >
                                      {p.rma_number}
                                    </button>
                                  ) : (
                                    <span className="text-gray-300">—</span>
                                  )}
                                  <span className="text-gray-700 dark:text-[#e8ebf0]">{p.customer_name || '—'}</span>
                                  <span
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${TICKET_STATUS_CLS[p.ticket_status] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#9aa4b2]'}`}
                                  >
                                    {p.ticket_status || '—'}
                                  </span>
                                  {p.assigned_technician && (
                                    <span className="text-gray-500 dark:text-[#9aa4b2]">{p.assigned_technician}</span>
                                  )}
                                  <span className="text-gray-500 dark:text-[#9aa4b2]">
                                    {fmtDate(p.status_date || p.created_date)}
                                  </span>
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
          <Pagination
            total={filtered.length}
            page={currentPage}
            itemsPerPage={itemsPerPage}
            setItemsPerPage={setItemsPerPage}
            onPage={setCurrentPage}
          />
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
