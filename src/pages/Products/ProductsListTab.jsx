import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ExportMenu from '../../components/ExportMenu'
import EmptyState from '../../components/EmptyState'

/** hardware -> Hardware, so the value maps onto the typeHardware / statusActive keys. */
const cap = (v) => (v ? String(v).charAt(0).toUpperCase() + String(v).slice(1) : '')

export default function ProductsListTab({
  products,
  // `products` is only the current page. Export scopes need the whole set and
  // the filtered set, so those come in separately rather than being inferred.
  allProducts = [],
  filteredProducts = [],
  totalProducts,
  searchQuery,
  setSearchQuery,
  searchRef,
  brands,
  categories,
  filterBrand,
  setFilterBrand,
  filterCategory,
  setFilterCategory,
  filterStatus,
  setFilterStatus,
  selectedProducts,
  setSelectedProducts,
  handleSelectProduct,
  handleSelectAll,
  handleBulkDelete,
  handleBulkStatusChange,
  handleExport,
  setShowAddProduct,
  setShowBulkUpload,
  handleEditProduct,
  handleDeleteProduct,
  handleViewProduct,
  showAddDropdown,
  setShowAddDropdown,
  openMenuId,
  setOpenMenuId,
  canCreate,
  canEdit,
  canDelete,
  canExport,
  canImport,
  currentPage,
  totalPages,
  itemsPerPage,
  setItemsPerPage,
  startIndex,
  endIndex,
  handlePageChange,
  jumpToPage,
  setJumpToPage,
  handleJumpToPage,
  sortConfig,
  handleSort,
}) {
  const { t } = useTranslation()
  const [showFilters, setShowFilters] = useState(false)
  const activeFilterCount = [filterBrand, filterCategory, filterStatus].filter(Boolean).length
  const SortableHeader = ({ label, sortKey }) => {
    const isActive = sortConfig.key === sortKey
    const direction = isActive ? sortConfig.direction : null
    const ariaSort = isActive ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'

    return (
      <button
        onClick={() => handleSort(sortKey)}
        aria-label={`Sort by ${label}`}
        aria-sort={ariaSort}
        className="flex items-center gap-1 hover:text-gray-900 transition-colors"
      >
        <span>{label}</span>
        {isActive ? (
          direction === 'asc' ? (
            <svg
              className="w-3.5 h-3.5 text-[#4338ca] dark:text-[#a5b4fc] ml-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 15l7-7 7 7"
              />
            </svg>
          ) : (
            <svg
              className="w-3.5 h-3.5 text-[#4338ca] dark:text-[#a5b4fc] ml-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          )
        ) : (
          <svg
            className="w-3.5 h-3.5 text-[#e6e9ef] dark:text-[#212a38] ml-0.5"
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

  const renderPageNumbers = () => {
    const pages = []
    const maxVisible = 7

    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i)
      }
    } else {
      if (currentPage <= 4) {
        for (let i = 1; i <= 5; i++) pages.push(i)
        pages.push('...')
        pages.push(totalPages)
      } else if (currentPage >= totalPages - 3) {
        pages.push(1)
        pages.push('...')
        for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i)
      } else {
        pages.push(1)
        pages.push('...')
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i)
        pages.push('...')
        pages.push(totalPages)
      }
    }

    return pages.map((page, idx) => {
      if (page === '...') {
        return (
          <span key={`ellipsis-${idx}`} className="px-3 py-2 text-gray-500">
            ...
          </span>
        )
      }
      return (
        <button
          key={page}
          onClick={() => handlePageChange(page)}
          className={`px-3 py-2 rounded transition-colors ${
            currentPage === page ? 'bg-indigo-600 text-white' : 'text-gray-700 hover:bg-gray-100'
          }`}
        >
          {page}
        </button>
      )
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-1">
            <div className="flex-1 max-w-md">
              <div className="relative">
                <input
                  ref={searchRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('products.searchPlaceholder')}
                  className="w-full pl-9 pr-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#a09d99] dark:placeholder:text-[#4a5568]"
                />
                <svg
                  className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              aria-expanded={showFilters}
              aria-controls="products-filters-panel"
              className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${
                showFilters || activeFilterCount > 0
                  ? 'border-[#4338ca] text-[#4338ca] bg-indigo-50 dark:bg-indigo-900/20 dark:border-[#a5b4fc] dark:text-[#a5b4fc]'
                  : 'border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
              </svg>
              {t('common.filters')}
              {activeFilterCount > 0 && (
                <span className="w-4 h-4 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] text-xs rounded-full flex items-center justify-center">
                  {activeFilterCount}
                </span>
              )}
            </button>
          </div>

        <div className="flex items-center gap-2 flex-wrap">

          {canExport && (
            <ExportMenu
              allRows={allProducts}
              filteredRows={filteredProducts}
              selectedRows={allProducts.filter((p) => selectedProducts.includes(p.id))}
              ns="products"
              onExport={handleExport}
            />
          )}

          {canCreate && (
            <div className="relative add-product-dropdown">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setShowAddDropdown(!showAddDropdown)
                }}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 flex items-center gap-2 text-sm font-medium transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
                {t('products.addProduct')}
                <svg
                  className={
                    'w-4 h-4 transition-transform ' + (showAddDropdown ? 'rotate-180' : '')
                  }
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
              {showAddDropdown && (
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-[#121823] rounded-lg shadow-lg border border-gray-200 dark:border-[#212a38] z-20 overflow-hidden">
                  <button
                    onClick={() => {
                      setShowAddProduct(true)
                      setShowAddDropdown(false)
                    }}
                    className="w-full px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-[#1a2230] flex items-center gap-3 border-b border-gray-100 dark:border-[#212a38]"
                  >
                    <svg
                      className="w-4 h-4 text-gray-500 dark:text-[#9aa4b2]"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                      />
                    </svg>
                    <div>
                      <div className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0]">{t('products.addSingleProduct')}</div>
                      <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t('products.createOneProduct')}</div>
                    </div>
                  </button>
                  {canImport && (
                    <button
                      onClick={() => {
                        setShowBulkUpload(true)
                        setShowAddDropdown(false)
                      }}
                      className="w-full px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-[#1a2230] flex items-center gap-3"
                    >
                      <svg
                        className="w-4 h-4 text-gray-500 dark:text-[#9aa4b2]"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                        />
                      </svg>
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0]">{t('products.bulkUpload')}</div>
                        <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t('products.uploadCSVFile')}</div>
                      </div>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        </div>
        {showFilters && (
          <div id="products-filters-panel" className="p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
            <div className="flex flex-wrap gap-3">
              <select
                value={filterBrand}
                onChange={(e) => setFilterBrand(e.target.value)}
                className="px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
              >
                <option value="">{t('products.allBrands')}</option>
                {(brands || []).map((b) => (
                  <option key={b.id} value={b.brand_name}>{b.brand_name}</option>
                ))}
              </select>
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
              >
                <option value="">{t('products.allCategories')}</option>
                {/* De-duplicated by name because that is what the filter matches
                    on. Categories are brand-scoped, so 15 names exist under more
                    than one brand — "Gaming Monitor" belongs to Acer, AOC and LG
                    — and the list showed each one once per brand. The three
                    entries were the same choice: picking any returned all 50
                    monitors across all three. Harmless but confusing, and it
                    padded the list from 37 real options to 52. */}
                {[...new Set((categories || []).map((c) => c.category_name))]
                  .filter(Boolean)
                  .sort((a, b) => a.localeCompare(b))
                  .map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
              </select>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
              >
                <option value="">{t('products.allStatuses')}</option>
                <option value="active">{t('products.statusActive')}</option>
                <option value="inactive">{t('products.statusInactive')}</option>
                <option value="discontinued">{t('products.statusDiscontinued')}</option>
              </select>
              {activeFilterCount > 0 && (
                <button
                  onClick={() => { setFilterBrand(''); setFilterCategory(''); setFilterStatus('') }}
                  className="text-sm text-red-500 dark:text-red-400 hover:underline"
                >
                  {t('common.clear')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Pagination Top Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-sm text-gray-600">
        <div>
          {/* `from` is 0, not startIndex + 1, when nothing matched — otherwise an
              empty result reads "Showing 1-0 of 0". Same guard as Customers. */}
          {t('products.showingRange', {
            from: totalProducts === 0 ? 0 : startIndex + 1,
            to: endIndex,
            total: totalProducts,
          })}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">{t('common.itemsPerPage')}:</label>
          <select
            value={itemsPerPage}
            onChange={(e) => setItemsPerPage(parseInt(e.target.value))}
            className="px-3 py-1 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedProducts.length > 0 && (
        <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-[#4338ca]/20 dark:border-[#a5b4fc]/20 rounded-[14px] px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-[#4338ca] dark:text-[#a5b4fc]">
            {selectedProducts.length} {t('common.selected')}
          </span>
          <div className="w-px h-5 bg-[#4338ca]/20 dark:bg-[#a5b4fc]/20" />
          <select
            onChange={(e) => { if (e.target.value) { handleBulkStatusChange(e.target.value); e.target.value = '' } }}
            defaultValue=""
            className="text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
          >
            <option value="">{t('products.changeStatus')}</option>
            <option value="active">{t('products.statusActive')}</option>
            <option value="inactive">{t('products.statusInactive')}</option>
            <option value="discontinued">{t('products.statusDiscontinued')}</option>
          </select>
          {canDelete && (
            <button
              onClick={handleBulkDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors border border-red-200 dark:border-red-800"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {t('common.delete')}
            </button>
          )}
          <button
            onClick={() => setSelectedProducts([])}
            className="ml-auto text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]"
          >
            {t('common.clear')}
          </button>
        </div>
      )}

      {/* Products Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-y border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left">
                <input
                  type="checkbox"
                  checked={selectedProducts.length === products.length && products.length > 0}
                  onChange={handleSelectAll}
                  className="w-4 h-4 text-indigo-600 rounded focus:ring-2 focus:ring-indigo-600"
                />
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase w-10">
                #
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                {t('products.imageHeader')}
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader label={t('products.sku')} sortKey="sku" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader label={t('products.productName')} sortKey="product_name" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hidden md:table-cell">
                <SortableHeader label={t('products.brand')} sortKey="brand" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hidden md:table-cell">
                <SortableHeader label={t('products.category')} sortKey="category" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader label={t('common.type')} sortKey="product_type" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader label={t('common.status')} sortKey="status" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                {t('products.actionsHeader')}
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {products.length === 0 ? (
              <tr>
                <td colSpan="10">
                  <EmptyState
                    preset="products"
                    description={t('products.emptyDescription')}
                    action={canCreate ? () => setShowAddProduct(true) : undefined}
                    actionLabel={t('products.addFirstProduct')}
                  />
                </td>
              </tr>
            ) : (
              products.map((product, idx) => (
                <tr key={product.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedProducts.includes(product.id)}
                      onChange={() => handleSelectProduct(product.id)}
                      className="w-4 h-4 text-indigo-600 rounded focus:ring-2 focus:ring-indigo-600"
                    />
                  </td>
                  <td className="px-3 py-3 text-xs text-gray-500 tabular-nums">
                    {startIndex + idx + 1}
                  </td>
                  <td className="px-4 py-3">
                    {product.product_image_url ? (
                      <img
                        src={product.product_image_url}
                        alt={product.product_name}
                        className="w-12 h-12 object-cover rounded"
                      />
                    ) : (
                      <div className="w-12 h-12 bg-gray-200 rounded flex items-center justify-center">
                        <svg
                          className="w-6 h-6 text-gray-500"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleViewProduct(product)}
                      className="font-mono text-sm text-indigo-600 hover:text-indigo-900 hover:underline"
                    >
                      {product.sku}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleViewProduct(product)}
                      className="font-medium text-gray-900 hover:text-indigo-600 hover:underline text-left"
                    >
                      {product.product_name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 hidden md:table-cell">
                    {product.brand?.brand_name || '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 hidden md:table-cell">
                    {product.category?.category_name || '-'}
                  </td>
                  <td className="px-4 py-3">
                    {/* Rendered raw, so it stayed English under Arabic while every
                        header around it translated — same gap as BUG #29 and #33.
                        The typeHardware / statusActive keys already existed. */}
                    <span className="capitalize text-sm text-gray-600">
                      {t(`products.type${cap(product.product_type)}`, product.product_type)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        'px-2 py-1 text-xs rounded-full ' +
                        (product.status === 'active'
                          ? 'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400'
                          : product.status === 'inactive'
                            ? 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]'
                            : 'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-400')
                      }
                    >
                      {t(`products.status${cap(product.status)}`, product.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 relative action-menu">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenMenuId(openMenuId === product.id ? null : product.id)
                      }}
                      aria-label={`Actions for ${product.product_name}`}
                      aria-expanded={openMenuId === product.id}
                      aria-haspopup="menu"
                      className="p-1.5 rounded-lg text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:hover:text-[#e8ebf0] hover:bg-gray-100 dark:hover:bg-[#1a2230] transition-colors"
                    >
                      <svg className="w-4 h-4" aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="5" r="1.5" />
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="12" cy="19" r="1.5" />
                      </svg>
                    </button>
                    {openMenuId === product.id && (
                      <div className="absolute right-0 top-9 z-30 w-44 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-gray-200 dark:border-[#212a38] py-1 overflow-hidden">
                        <button
                          onClick={() => {
                            handleViewProduct(product)
                            setOpenMenuId(null)
                          }}
                          className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230] flex items-center gap-2.5"
                        >
                          <svg
                            className="w-4 h-4 text-gray-500 dark:text-[#9aa4b2]"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                            />
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                            />
                          </svg>
                          {t('common.view')}
                        </button>
                        {canEdit && (
                          <button
                            onClick={() => {
                              handleEditProduct(product)
                              setOpenMenuId(null)
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230] flex items-center gap-2.5"
                          >
                            <svg
                              className="w-4 h-4 text-gray-500 dark:text-[#9aa4b2]"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                              />
                            </svg>
                            {t('common.edit')}
                          </button>
                        )}
                        {canDelete && (
                          <button
                            onClick={() => {
                              handleDeleteProduct(product)
                              setOpenMenuId(null)
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2.5"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                            {t('common.delete')}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Bottom */}
      {totalPages > 1 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-gray-200">
          <div className="text-sm text-gray-600">
            {t('common.showingRange', {
              start: startIndex + 1,
              end: Math.min(endIndex, totalProducts),
              total: totalProducts,
            })}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handlePageChange(currentPage - 1)}
              disabled={currentPage === 1}
              className="px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t('common.previous')}
            </button>
            <div className="flex items-center gap-1">{renderPageNumbers()}</div>
            <button
              onClick={() => handlePageChange(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t('common.next')}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">{t('common.jumpToPage')}:</span>
            <input
              type="number"
              min="1"
              max={totalPages}
              value={jumpToPage}
              onChange={(e) => setJumpToPage(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleJumpToPage()}
              placeholder={currentPage.toString()}
              className="w-20 px-3 py-1 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
            />
            <button
              onClick={handleJumpToPage}
              className="px-3 py-1 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              {t('common.go')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
