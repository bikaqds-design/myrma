import React, { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { safeStorage } from '../../lib/safeStorage'
import { Pagination, downloadCSV, InvToolbar, InvFilterPanel, InvFilterField, INV_FILTER_SELECT_CLS } from './_shared'
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
      <InvToolbar
        searchRef={searchRef}
        search={search}
        onSearchChange={setSearch}
        placeholder={t('inventory.searchByProductBrand')}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters((f) => !f)}
        activeFilterCount={activeFilterCount}
        right={
          <span className="text-sm text-gray-500 dark:text-[#9aa4b2]">
            {t('inventory.productCount', { count: filtered.length })}
          </span>
        }
      />

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
      <InvFilterPanel
        show={showFilters}
        activeFilterCount={activeFilterCount}
        onClear={() => {
          setFilterBrand('')
          setFilterStatus('')
          setFilterProduct('')
        }}
      >
        <InvFilterField label={t('inventory.filterProduct')}>
          <input
            type="text"
            value={filterProduct}
            onChange={(e) => setFilterProduct(e.target.value)}
            placeholder={t('inventory.typeProductName')}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 w-44"
          />
        </InvFilterField>
        <InvFilterField label={t('inventory.filterBrand')}>
          <select value={filterBrand} onChange={(e) => setFilterBrand(e.target.value)} className={INV_FILTER_SELECT_CLS}>
            <option value="">{t('inventory.filterAll')}</option>
            {brands.map((b) => (
              <option key={b.id} value={b.brand_name}>
                {b.brand_name}
              </option>
            ))}
          </select>
        </InvFilterField>
        <InvFilterField label={t('inventory.filterStatus')}>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className={INV_FILTER_SELECT_CLS}>
            <option value="">{t('inventory.filterAll')}</option>
            <option value="active_rma">{t('inventory.statusActiveRMA')}</option>
            <option value="company_stock">{t('inventory.statusCompanyStock')}</option>
            <option value="sent_to_manufacturer">{t('inventory.statusSentToManufacturer')}</option>
            <option value="closed">{t('inventory.statusClosed')}</option>
          </select>
        </InvFilterField>
      </InvFilterPanel>

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
                        aria-label={t('common.selectAll')}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                      />
                    </th>
                    <th className="w-8 px-2 py-2 text-center text-gray-500 dark:text-[#9aa4b2] font-semibold border-b border-r border-gray-200 dark:border-[#212a38]">
                      #
                    </th>
                    <th className="px-3 py-2 text-start font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38]">
                      {t('inventory.colBrand')}
                    </th>
                    <th className="px-3 py-2 text-start font-semibold text-gray-600 dark:text-[#9aa4b2] border-b border-r border-gray-200 dark:border-[#212a38]">
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
                            aria-label={t('common.selectRow', { name: g.product_name })}
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
