import React from 'react'
import EmptyState from '../../components/EmptyState'

export default function ProductsListTab({
  products,
  totalProducts,
  searchQuery,
  setSearchQuery,
  searchRef,
  selectedProducts,
  handleSelectProduct,
  handleSelectAll,
  handleBulkDelete,
  handleBulkStatusChange,
  handleExportProducts,
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
              className="w-3.5 h-3.5 text-indigo-600 ml-0.5"
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
              className="w-3.5 h-3.5 text-indigo-600 ml-0.5"
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
            className="w-3.5 h-3.5 text-gray-300 ml-0.5"
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
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex-1 max-w-md">
          <div className="relative">
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, SKU, brand, model, or description... (Press / to focus)"
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            />
            <svg
              className="w-5 h-5 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2"
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
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {selectedProducts.length > 0 && canDelete && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleBulkDelete}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
                Delete ({selectedProducts.length})
              </button>
              <select
                onChange={(e) => {
                  if (e.target.value) {
                    handleBulkStatusChange(e.target.value)
                    e.target.value = ''
                  }
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                defaultValue=""
              >
                <option value="">Change Status...</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="discontinued">Discontinued</option>
              </select>
            </div>
          )}

          {canExport && (
            <button
              onClick={handleExportProducts}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              Export
            </button>
          )}

          {canCreate && (
            <div className="relative add-product-dropdown">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setShowAddDropdown(!showAddDropdown)
                }}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
                Add Product
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
                <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 z-20">
                  <button
                    onClick={() => {
                      setShowAddProduct(true)
                      setShowAddDropdown(false)
                    }}
                    className="w-full px-4 py-3 text-left hover:bg-gray-50 flex items-center gap-3 border-b border-gray-100"
                  >
                    <svg
                      className="w-5 h-5 text-gray-500"
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
                      <div className="font-medium text-gray-900">Add Single Product</div>
                      <div className="text-xs text-gray-500">Create one product</div>
                    </div>
                  </button>
                  {canImport && (
                    <button
                      onClick={() => {
                        setShowBulkUpload(true)
                        setShowAddDropdown(false)
                      }}
                      className="w-full px-4 py-3 text-left hover:bg-gray-50 flex items-center gap-3"
                    >
                      <svg
                        className="w-5 h-5 text-gray-500"
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
                        <div className="font-medium text-gray-900">Bulk Add / Upload</div>
                        <div className="text-xs text-gray-500">Upload CSV file</div>
                      </div>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Pagination Top Bar */}
      <div className="flex items-center justify-between text-sm text-gray-600">
        <div>
          Showing {startIndex + 1}-{endIndex} of {totalProducts} products
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Items per page:</label>
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
                Image
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader label="SKU" sortKey="sku" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader label="Product Name" sortKey="product_name" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader label="Brand" sortKey="brand" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader label="Category" sortKey="category" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader label="Type" sortKey="product_type" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader label="Status" sortKey="status" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {products.length === 0 ? (
              <tr>
                <td colSpan="10">
                  <EmptyState
                    preset="products"
                    description="Add your first product to start managing your catalog"
                    action={canCreate ? () => setShowAddProduct(true) : undefined}
                    actionLabel="Add First Product"
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
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {product.brand?.brand_name || '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {product.category?.category_name || '-'}
                  </td>
                  <td className="px-4 py-3">
                    <span className="capitalize text-sm text-gray-600">{product.product_type}</span>
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
                      {product.status}
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
                      className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                    >
                      <svg className="w-4 h-4" aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="5" r="1.5" />
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="12" cy="19" r="1.5" />
                      </svg>
                    </button>
                    {openMenuId === product.id && (
                      <div className="absolute right-0 top-9 z-30 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                        <button
                          onClick={() => {
                            handleViewProduct(product)
                            setOpenMenuId(null)
                          }}
                          className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5"
                        >
                          <svg
                            className="w-4 h-4 text-gray-500"
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
                          View
                        </button>
                        {canEdit && (
                          <button
                            onClick={() => {
                              handleEditProduct(product)
                              setOpenMenuId(null)
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5"
                          >
                            <svg
                              className="w-4 h-4 text-gray-500"
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
                            Edit
                          </button>
                        )}
                        {canDelete && (
                          <button
                            onClick={() => {
                              handleDeleteProduct(product)
                              setOpenMenuId(null)
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2.5"
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
                            Delete
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
        <div className="flex items-center justify-between pt-4 border-t border-gray-200">
          <div className="flex items-center gap-2">
            <button
              onClick={() => handlePageChange(currentPage - 1)}
              disabled={currentPage === 1}
              className="px-3 py-2 border border-gray-300 rounded text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <div className="flex items-center gap-1">{renderPageNumbers()}</div>
            <button
              onClick={() => handlePageChange(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="px-3 py-2 border border-gray-300 rounded text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">Jump to page:</span>
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
              Go
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
