import React, { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { safeStorage } from '../../lib/safeStorage'
import { Pagination, downloadCSV } from './_shared'
import { ProductDetailModal } from './ProductDetailModal'

// ─── All Units — By Product ───────────────────────────────────────────────────
export function ByProductTab({
  groups,
  brands,
  warehouses,
  canResolve: _canResolve,
  canTransfer,
  userEmail,
  onReload,
  onNavigateToTicket,
}) {
  const { t } = useTranslation()
  const searchRef = useRef(null)
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterBrand, setFilterBrand] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterProduct, setFilterProduct] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(
    () => safeStorage.get('invByProductPerPage', 25)
  )
  const [selectedRows, setSelectedRows] = useState([])

  const activeFilterCount = [filterBrand, filterStatus, filterProduct].filter(Boolean).length
  const filtered = groups.filter((g) => {
    const matchSearch =
      !search ||
      g.product_name.toLowerCase().includes(search.toLowerCase()) ||
      g.brand?.toLowerCase().includes(search.toLowerCase())
    const matchBrand = !filterBrand || g.brand === filterBrand
    const matchStatus = !filterStatus || g[filterStatus] > 0
    const matchProduct =
      !filterProduct || g.product_name.toLowerCase().includes(filterProduct.toLowerCase())
    return matchSearch && matchBrand && matchStatus && matchProduct
  })
  const paginated = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)

  React.useEffect(() => {
    setCurrentPage(1)
  }, [search, filterBrand, filterStatus, filterProduct, itemsPerPage])
  React.useEffect(() => {
    safeStorage.set('invByProductPerPage', itemsPerPage)
  }, [itemsPerPage])

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

  const handleExportSelected = () => {
    const rows = selectedRows
      .map((name) => {
        const g = groups.find((x) => x.product_name === name)
        if (!g) return null
        return {
          brand: g.brand,
          product: g.product_name,
          active_rma: g.active_rma,
          company_stock: g.company_stock,
          sent_to_manufacturer: g.sent_to_manufacturer,
          total: g.units.length,
        }
      })
      .filter(Boolean)
    downloadCSV(rows, 'inventory-selected.csv')
    setSelectedRows([])
  }

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
              className="w-full pl-9 pr-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#a09d99] dark:placeholder:text-[#4a5568]"
            />
            <svg
              className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute left-3 top-1/2 -translate-y-1/2"
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
        </div>
        <span className="text-sm text-gray-500 dark:text-[#9aa4b2]">
          {t('inventory.productCount', { count: filtered.length })}
        </span>
      </div>

      {selectedRows.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-xl">
          <span className="w-6 h-6 bg-indigo-600 text-white rounded-full flex items-center justify-center text-xs font-bold">
            {selectedRows.length}
          </span>
          <span className="text-sm font-medium text-indigo-700">
            {t('inventory.productsSelected', { count: selectedRows.length })}
          </span>
          <button
            onClick={() => setSelectedRows([])}
            className="text-xs text-indigo-500 hover:text-indigo-700 underline"
          >
            {t('common.clear')}
          </button>
          <div className="h-5 w-px bg-indigo-200" />
          <button
            onClick={handleExportSelected}
            className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-[#121823] border border-indigo-300 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50 dark:hover:bg-[#1a2230] transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            {t('inventory.exportSelected')}
          </button>
        </div>
      )}

      {/* Filter panel */}
      {showFilters && (
        <div className="flex items-center gap-4 p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] flex-wrap">
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
              className="px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
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
            <label className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0]">{t('inventory.filterStatus')}</label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
            >
              <option value="">{t('inventory.filterAll')}</option>
              <option value="active_rma">{t('inventory.statusActiveRMA')}</option>
              <option value="company_stock">{t('inventory.statusCompanyStock')}</option>
              <option value="sent_to_manufacturer">{t('inventory.statusSentToManufacturer')}</option>
              <option value="closed">{t('inventory.statusClosed')}</option>
            </select>
          </div>
          {activeFilterCount > 0 && (
            <button
              onClick={() => {
                setFilterBrand('')
                setFilterStatus('')
                setFilterProduct('')
              }}
              className="text-sm text-red-600 hover:underline ml-auto"
            >
              {t('inventory.clearFilters')}
            </button>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-20 bg-white dark:bg-[#121823] rounded-lg border border-gray-200 dark:border-[#212a38] flex flex-col items-center gap-3">
          <div className="w-12 h-12 bg-gray-100 dark:bg-[#1a2230] rounded-xl flex items-center justify-center">
            <svg
              className="w-6 h-6 text-gray-500 dark:text-[#9aa4b2]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-gray-600 dark:text-[#9aa4b2] text-sm">{t('inventory.noProductsFound')}</p>
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
              {search || filterBrand || filterStatus || filterProduct
                ? t('common.noResults')
                : t('inventory.noProductsHint')}
            </p>
          </div>
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
                    <th className="w-8 px-2 py-2 text-center text-gray-500 dark:text-[#9aa4b2] font-semibold border-b border-r border-gray-200 dark:border-[#212a38]">
                      #
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38]">
                      {t('inventory.colBrand')}
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38]">
                      {t('inventory.colProduct')}
                    </th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38] whitespace-nowrap">
                      {t('inventory.statusActiveRMA')}
                    </th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38] whitespace-nowrap">
                      {t('inventory.statusCompanyStock')}
                    </th>

                    <th className="px-3 py-2 text-center font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38]">
                      {t('inventory.colTotal')}
                    </th>
                    <th className="px-3 py-2 border-b border-gray-200 dark:border-[#212a38] w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((g, idx) => {
                    const isSelected = selectedRows.includes(g.product_name)
                    const rowBg = isSelected
                      ? 'bg-indigo-50'
                      : idx % 2 === 0
                        ? 'bg-white dark:bg-[#121823]'
                        : 'bg-gray-50 dark:bg-[#0f1520]/60'
                    return (
                      <tr
                        key={g.product_name}
                        className={`${rowBg} border-b border-gray-100 dark:border-[#212a38] transition-colors cursor-pointer hover:bg-indigo-50 dark:hover:bg-[#1a2230]/40`}
                        onClick={() => setSelectedProduct(g)}
                      >
                        <td
                          className="px-3 py-1.5 text-center border-r border-gray-100 dark:border-[#212a38]"
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
                            checked={isSelected}
                            onChange={() => {}}
                            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                          />
                        </td>
                        <td className="px-2 py-1.5 text-center text-gray-500 dark:text-[#9aa4b2] tabular-nums border-r border-gray-100 dark:border-[#212a38]">
                          {(currentPage - 1) * itemsPerPage + idx + 1}
                        </td>
                        <td className="px-3 py-1.5 border-r border-gray-100 dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] font-medium">
                          {g.brand || '—'}
                        </td>
                        <td className="px-3 py-1.5 font-semibold text-gray-900 dark:text-[#e8ebf0] border-r border-gray-100 dark:border-[#212a38]">
                          {g.product_name}
                        </td>
                        <td className="px-3 py-1.5 text-center border-r border-gray-100 dark:border-[#212a38]">
                          {g.active_rma > 0 ? (
                            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400">
                              {g.active_rma}
                            </span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-center border-r border-gray-100 dark:border-[#212a38]">
                          {g.company_stock > 0 ? (
                            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
                              {g.company_stock}
                            </span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>

                        <td className="px-3 py-1.5 text-center font-bold text-gray-800 border-r border-gray-100 dark:border-[#212a38]">
                          {g.units.length}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          <span className="text-indigo-500">→</span>
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
          mode="view"
          warehouses={warehouses}
          canTransfer={canTransfer}
          userEmail={userEmail}
          onClose={() => setSelectedProduct(null)}
          onReload={onReload}
          onNavigateToTicket={onNavigateToTicket}
        />
      )}
    </div>
  )
}
