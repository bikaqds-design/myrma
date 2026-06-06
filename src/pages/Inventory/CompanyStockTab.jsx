import React, { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../../lib/sentry'
import { safeStorage } from '../../lib/safeStorage'
import { BrandAvatar, Pagination, downloadCSV } from './_shared'
import { ProductDetailModal } from './ProductDetailModal'
import { TransferModal } from './TransferModal'
import { CreateBatchModal } from './ManufacturerTab'

export function CompanyStockTab({
  groups,
  brands,
  warehouses,
  userEmail,
  canManageBatches,
  canTransfer,
  onReload,
  onNavigateToTicket,
}) {
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterBrand, setFilterBrand] = useState('')
  const [filterResolution, setFilterResolution] = useState('')
  const [filterProduct, setFilterProduct] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(
    () => safeStorage.get('invStockPerPage', 25)
  )
  const { t } = useTranslation()
  const [selectedRows, setSelectedRows] = useState([])
  const [showTransfer, setShowTransfer] = useState(false)
  const [showBatch, setShowBatch] = useState(false)
  const [bulkProcessing, setBulkProcessing] = useState(false)

  const activeFilterCount = [filterBrand, filterResolution, filterProduct].filter(Boolean).length
  const filtered = groups.filter((g) => {
    const matchSearch =
      !search ||
      g.product_name.toLowerCase().includes(search.toLowerCase()) ||
      g.brand?.toLowerCase().includes(search.toLowerCase())
    const matchBrand = !filterBrand || g.brand === filterBrand
    const matchRes =
      !filterResolution ||
      (filterResolution === 'replacement'
        ? g.replacement > 0
        : filterResolution === 'credit_note'
          ? g.credit_note > 0
          : g.units.length - g.replacement - g.credit_note > 0)
    const matchProduct =
      !filterProduct || g.product_name.toLowerCase().includes(filterProduct.toLowerCase())
    return matchSearch && matchBrand && matchRes && matchProduct
  })
  const paginated = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)

  React.useEffect(() => {
    setCurrentPage(1)
  }, [search, filterBrand, filterResolution, filterProduct, itemsPerPage])
  React.useEffect(() => {
    safeStorage.set('invStockPerPage', itemsPerPage)
  }, [itemsPerPage])

  const searchRef = useRef(null)

  // Keyboard shortcuts: / = focus search, Esc = close detail modal
  React.useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable
      if (e.key === 'Escape') {
        setSelectedProduct(null)
        return
      }
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // All unbatched unit IDs for the selected product groups
  const selectedUnitIds = selectedRows.flatMap((name) => {
    const g = groups.find((x) => x.product_name === name)
    return g ? g.units.filter((u) => !u.manufacturer_batch_id).map((u) => u.id) : []
  })

  const handleExportSelected = () => {
    const rows = selectedRows
      .map((name) => {
        const g = groups.find((x) => x.product_name === name)
        if (!g) return null
        const other = g.units.length - g.replacement - g.credit_note
        return {
          brand: g.brand,
          product: g.product_name,
          replacement: g.replacement,
          credit_note: g.credit_note,
          other,
          total: g.units.length,
        }
      })
      .filter(Boolean)
    downloadCSV(rows, 'company-stock-selected.csv')
    setSelectedRows([])
  }

  const handleBulkTransfer = async (warehouseId) => {
    if (!selectedUnitIds.length) {
      toast.error(t('inventory.noTransferableUnits'))
      return
    }
    setBulkProcessing(true)
    try {
      await db.inventory.transferUnits(selectedUnitIds, warehouseId)
      toast.success(t('inventory.unitsTransferred', { count: selectedUnitIds.length }))
      db.auditLog
        .log(
          userEmail,
          'inventory_units_transferred',
          `Transferred ${selectedUnitIds.length} unit${selectedUnitIds.length !== 1 ? 's' : ''} to warehouse ${warehouseId}`
        )
        .catch(() => {})
      setSelectedRows([])
      setShowTransfer(false)
      onReload()
    } catch (err) {
      captureException(err)
      toast.error(t('inventory.transferFailed'))
    } finally {
      setBulkProcessing(false)
    }
  }

  const handleBulkBatch = async (brandName) => {
    if (!selectedUnitIds.length) {
      toast.error(t('inventory.noUnbatchedUnitsSelection'))
      return
    }
    setBulkProcessing(true)
    try {
      await db.inventory.createBatch(selectedUnitIds, brandName, userEmail)
      toast.success(t('inventory.batchCreated', { count: selectedUnitIds.length }))
      db.auditLog
        .log(
          userEmail,
          'inventory_batch_created',
          `Created batch with ${selectedUnitIds.length} unit${selectedUnitIds.length !== 1 ? 's' : ''} for ${brandName}`
        )
        .catch(() => {})
      setSelectedRows([])
      setShowBatch(false)
      onReload()
    } catch {
      toast.error(t('inventory.batchCreateFailed'))
    } finally {
      setBulkProcessing(false)
    }
  }

  if (groups.length === 0)
    return (
      <div className="text-center py-20 bg-white dark:bg-[#121823] rounded-lg border border-gray-200 dark:border-[#212a38] flex flex-col items-center gap-3">
        <div className="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center">
          <svg
            className="w-6 h-6 text-amber-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
            />
          </svg>
        </div>
        <div>
          <p className="font-semibold text-gray-600 dark:text-[#9aa4b2] text-sm">{t('inventory.noCompanyStockYet')}</p>
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
            {t('inventory.noCompanyStockHint')}
          </p>
        </div>
      </div>
    )

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-1 max-w-2xl">
          <div className="relative flex-1">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('inventory.searchByProductBrand')}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            />
            <svg
              className="w-5 h-5 text-gray-500 dark:text-[#9aa4b2] absolute left-3 top-1/2 -translate-y-1/2"
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
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${showFilters || activeFilterCount > 0 ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-gray-300 text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520]'}`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"
              />
            </svg>
            {t('common.filters')}
            {activeFilterCount > 0 && (
              <span className="w-4 h-4 bg-indigo-600 text-white text-xs rounded-full flex items-center justify-center">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
        <span className="text-sm text-gray-500 dark:text-[#9aa4b2]">
          {t('inventory.productCount', { count: filtered.length })}
        </span>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="flex items-center gap-4 p-4 bg-gray-50 dark:bg-[#0f1520] rounded-lg flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0]">{t('inventory.filterProduct')}</label>
            <input
              type="text"
              value={filterProduct}
              onChange={(e) => setFilterProduct(e.target.value)}
              placeholder={t('inventory.typeProductName')}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 w-44"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0]">{t('inventory.filterBrand')}</label>
            <select
              value={filterBrand}
              onChange={(e) => setFilterBrand(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
            >
              <option value="">{t('inventory.filterAll')}</option>
              {brands.map((b) => (
                <option key={b.id} value={b.brand_name}>
                  {b.brand_name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0]">{t('inventory.filterTypeResolution')}</label>
            <select
              value={filterResolution}
              onChange={(e) => setFilterResolution(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
            >
              <option value="">{t('inventory.filterAllResolutions')}</option>
              <option value="replacement">{t('inventory.resolutionReplacement')}</option>
              <option value="credit_note">{t('inventory.resolutionCreditNote')}</option>
              <option value="other">{t('inventory.resolutionOther')}</option>
            </select>
          </div>
          {activeFilterCount > 0 && (
            <button
              onClick={() => {
                setFilterBrand('')
                setFilterResolution('')
                setFilterProduct('')
              }}
              className="text-sm text-red-600 hover:underline ml-auto"
            >
              {t('inventory.clearFilters')}
            </button>
          )}
        </div>
      )}

      {selectedRows.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-xl flex-wrap">
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="w-6 h-6 bg-indigo-600 text-white rounded-full flex items-center justify-center text-xs font-bold">
              {selectedRows.length}
            </span>
            <span className="text-sm font-medium text-indigo-700">
              {t('inventory.productsSelected', { count: selectedRows.length })}
              {selectedUnitIds.length > 0 && (
                <span className="text-indigo-400 ml-1">
                  ({t('inventory.unitsSelected', { count: selectedUnitIds.length })})
                </span>
              )}
            </span>
            <button
              onClick={() => setSelectedRows([])}
              className="text-xs text-indigo-400 hover:text-indigo-700 underline"
            >
              {t('common.clear')}
            </button>
          </div>
          <div className="h-5 w-px bg-indigo-200 flex-shrink-0" />
          {canTransfer && (
            <button
              onClick={() => {
                if (!selectedUnitIds.length) {
                  toast.error(t('inventory.noUnbatchedUnitsSelection'))
                  return
                }
                setShowTransfer(true)
              }}
              disabled={bulkProcessing}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-[#121823] border border-indigo-300 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50 dark:hover:bg-[#1a2230] transition-colors disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                />
              </svg>
              {t('inventory.transferToWarehouse')}
            </button>
          )}
          {canManageBatches && (
            <button
              onClick={() => {
                if (!selectedUnitIds.length) {
                  toast.error(t('inventory.noUnbatchedUnitsSelection'))
                  return
                }
                setShowBatch(true)
              }}
              disabled={bulkProcessing}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-[#121823] border border-purple-300 text-purple-700 rounded-lg text-xs font-medium hover:bg-purple-50 transition-colors disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                />
              </svg>
              {t('inventory.sendToManufacturer')}
            </button>
          )}
          <button
            onClick={handleExportSelected}
            disabled={bulkProcessing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-[#121823] border border-gray-300 text-gray-600 dark:text-[#9aa4b2] rounded-lg text-xs font-medium hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] transition-colors disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            {t('common.export')}
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-16 bg-white dark:bg-[#121823] rounded-lg border border-gray-200 dark:border-[#212a38]">
          <p className="text-gray-500 dark:text-[#9aa4b2] text-sm">{t('inventory.noCompanyStockMatchFilter')}</p>
        </div>
      ) : (
        <>
          <div className="bg-white dark:bg-[#121823] rounded-lg border border-gray-200 dark:border-[#212a38] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-gray-200 dark:border-[#212a38]">
                  <tr>
                    <th className="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        checked={
                          paginated.length > 0 &&
                          selectedRows.filter((r) => paginated.some((g) => g.product_name === r))
                            .length === paginated.length
                        }
                        onChange={(e) =>
                          setSelectedRows(
                            e.target.checked ? paginated.map((g) => g.product_name) : []
                          )
                        }
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                      />
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider w-10">
                      #
                    </th>
                    {[
                      t('inventory.colBrand'),
                      t('inventory.colProduct'),
                      t('inventory.colReplacement'),
                      t('inventory.colCreditNote'),
                      t('inventory.colOther'),
                      t('inventory.colTotal'),
                      '',
                    ].map((h, i) => (
                      <th
                        key={i}
                        className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {paginated.map((g, idx) => {
                    const other = g.units.length - g.replacement - g.credit_note
                    return (
                      <tr
                        key={g.product_name}
                        className={`hover:bg-amber-50/30 transition-colors cursor-pointer ${selectedRows.includes(g.product_name) ? 'bg-amber-50/50' : ''}`}
                        onClick={() => setSelectedProduct(g)}
                      >
                        <td
                          className="px-4 py-3"
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelectedRows((r) =>
                              r.includes(g.product_name)
                                ? r.filter((x) => x !== g.product_name)
                                : [...r, g.product_name]
                            )
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selectedRows.includes(g.product_name)}
                            onChange={() => {}}
                            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                          />
                        </td>
                        <td className="px-3 py-3 text-xs text-gray-500 dark:text-[#9aa4b2] tabular-nums">
                          {(currentPage - 1) * itemsPerPage + idx + 1}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <BrandAvatar name={g.brand || '?'} size="sm" />
                            <span className="text-xs text-gray-500 dark:text-[#9aa4b2] font-medium">
                              {g.brand || '—'}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-900 dark:text-[#e8ebf0] font-semibold">{g.product_name}</td>
                        <td className="px-4 py-3">
                          {g.replacement > 0 ? (
                            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700">
                              {g.replacement}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {g.credit_note > 0 ? (
                            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">
                              {g.credit_note}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {other > 0 ? (
                            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]">
                              {other}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-bold text-gray-800">{g.units.length}</td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-xs text-indigo-600 font-medium">{t('inventory.manageLink')}</span>
                        </td>
                      </tr>
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
      {selectedProduct && (
        <ProductDetailModal
          group={selectedProduct}
          mode="stock"
          warehouses={warehouses}
          canManageBatches={canManageBatches}
          canTransfer={canTransfer}
          userEmail={userEmail}
          onClose={() => setSelectedProduct(null)}
          onReload={onReload}
          onNavigateToTicket={onNavigateToTicket}
        />
      )}
      {showTransfer && (
        <TransferModal
          units={selectedUnitIds}
          warehouses={warehouses}
          onConfirm={handleBulkTransfer}
          onClose={() => setShowTransfer(false)}
        />
      )}
      {showBatch && (
        <CreateBatchModal
          count={selectedUnitIds.length}
          brands={brands}
          onConfirm={handleBulkBatch}
          onClose={() => setShowBatch(false)}
        />
      )}
    </div>
  )
}
