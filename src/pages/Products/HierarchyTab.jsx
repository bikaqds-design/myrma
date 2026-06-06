import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function HierarchyTab({
  brands,
  categories,
  products,
  getBrandCategories,
  getCategoryProducts,
  getBrandProductCount,
  getCategoryCount,
  setShowAddBrand,
  setShowAddCategory,
  handleEditBrand,
  handleEditCategory,
  handleDeleteBrand,
  handleDeleteCategory,
  setCategoryForm,
  handleViewProduct,
}) {
  const [selectedBrandId, setSelectedBrandId] = useState(null)
  const [selectedCategoryId, setSelectedCategoryId] = useState(null)
  const [brandMenuId, setBrandMenuId] = useState(null)
  const [catMenuId, setCatMenuId] = useState(null)

  const { t } = useTranslation()
  const selectedBrand = brands.find((b) => b.id === selectedBrandId)
  const selectedCategory = categories.find((c) => c.id === selectedCategoryId)
  const visibleCategories = selectedBrandId ? getBrandCategories(selectedBrandId) : []
  const visibleProducts = selectedCategoryId ? getCategoryProducts(selectedCategoryId) : []

  const handleSelectBrand = (brand) => {
    setSelectedBrandId(brand.id)
    setSelectedCategoryId(null)
    setBrandMenuId(null)
  }

  const handleSelectCategory = (cat) => {
    setSelectedCategoryId(cat.id)
    setCatMenuId(null)
  }

  const statusPill = (status) => (
    <span
      className={`px-2 py-0.5 text-xs rounded-full font-medium ${status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
    >
      {status}
    </span>
  )

  return (
    <div className="space-y-5">
      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-4">
        {[
          {
            label: t('products.brandsColumn'),
            value: brands.length,
            color: 'bg-violet-50 text-violet-700',
            icon: (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
              />
            ),
          },
          {
            label: t('products.categoriesColumn'),
            value: categories.length,
            color: 'bg-blue-50 text-blue-700',
            icon: (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              />
            ),
          },
          {
            label: t('products.productsColumn'),
            value: products.length,
            color: 'bg-emerald-50 text-emerald-700',
            icon: (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            ),
          },
        ].map(({ label, value, color, icon }) => (
          <div
            key={label}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl ${color} bg-opacity-60`}
          >
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${color}`}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {icon}
              </svg>
            </div>
            <div>
              <div className="text-2xl font-bold">{value}</div>
              <div className="text-xs font-medium opacity-70">{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 3-column explorer */}
      <div className="grid grid-cols-3 gap-0 border border-gray-200 rounded-xl overflow-hidden min-h-[480px]">
        {/* ── Column 1: Brands ── */}
        <div className="flex flex-col border-r border-gray-200">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {t('products.brandsColumn')}
            </span>
            <button
              onClick={() => setShowAddBrand(true)}
              className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 px-2 py-1 rounded-md hover:bg-indigo-50 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              {t('common.add')}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {brands.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                    />
                  </svg>
                </div>
                <p className="text-sm text-gray-500">{t('products.noBrandsYet')}</p>
                <button
                  onClick={() => setShowAddBrand(true)}
                  className="text-xs text-indigo-600 hover:underline"
                >
                  {t('products.addFirstBrand')}
                </button>
              </div>
            ) : (
              brands.map((brand) => (
                <div
                  key={brand.id}
                  onClick={() => handleSelectBrand(brand)}
                  className={`group flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${selectedBrandId === brand.id ? 'bg-indigo-50 border-l-2 border-indigo-500' : 'hover:bg-gray-50 border-l-2 border-transparent'}`}
                >
                  {brand.brand_logo_url ? (
                    <img
                      src={brand.brand_logo_url}
                      alt={brand.brand_name}
                      className="w-9 h-9 object-contain rounded-lg border border-gray-100 bg-white flex-shrink-0"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-100 to-indigo-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-sm font-bold text-indigo-500">
                        {brand.brand_name[0]?.toUpperCase()}
                      </span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-800 truncate">
                      {brand.brand_name}
                    </div>
                    <div className="text-xs text-gray-500">
                      {t('products.brandStats', { cats: getCategoryCount(brand.id), products: getBrandProductCount(brand.id) })}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {statusPill(brand.status)}
                    <div className="relative" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => setBrandMenuId(brandMenuId === brand.id ? null : brand.id)}
                        className="p-1 rounded text-gray-300 hover:text-gray-600 hover:bg-gray-200 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <circle cx="12" cy="5" r="1.5" />
                          <circle cx="12" cy="12" r="1.5" />
                          <circle cx="12" cy="19" r="1.5" />
                        </svg>
                      </button>
                      {brandMenuId === brand.id && (
                        <div className="absolute right-0 top-7 z-30 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                          <button
                            onClick={() => {
                              setCategoryForm((prev) => ({ ...prev, brand_id: brand.id }))
                              setShowAddCategory(true)
                              setBrandMenuId(null)
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
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
                                d="M12 4v16m8-8H4"
                              />
                            </svg>
                            {t('products.addCategoryAction')}
                          </button>
                          <button
                            onClick={() => {
                              handleEditBrand(brand)
                              setBrandMenuId(null)
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
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
                            {t('products.editBrand')}
                          </button>
                          <div className="border-t border-gray-100 my-0.5" />
                          <button
                            onClick={() => {
                              handleDeleteBrand(brand)
                              setBrandMenuId(null)
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
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
                            {t('products.deleteBrand')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Column 2: Categories ── */}
        <div className="flex flex-col border-r border-gray-200">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                {t('products.categoriesColumn')}
              </span>
              {selectedBrand && (
                <span className="text-xs text-indigo-600 font-medium bg-indigo-50 px-2 py-0.5 rounded-full">
                  {selectedBrand.brand_name}
                </span>
              )}
            </div>
            {selectedBrandId && (
              <button
                onClick={() => {
                  setCategoryForm((prev) => ({ ...prev, brand_id: selectedBrandId }))
                  setShowAddCategory(true)
                }}
                className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 px-2 py-1 rounded-md hover:bg-indigo-50 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                {t('common.add')}
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {!selectedBrandId ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                <svg
                  className="w-8 h-8 text-gray-300"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
                  />
                </svg>
                <p className="text-sm text-gray-500">{t('products.selectBrandPrompt')}</p>
              </div>
            ) : visibleCategories.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                    />
                  </svg>
                </div>
                <p className="text-sm text-gray-500">{t('products.noCategoriesYet')}</p>
                <button
                  onClick={() => {
                    setCategoryForm((prev) => ({ ...prev, brand_id: selectedBrandId }))
                    setShowAddCategory(true)
                  }}
                  className="text-xs text-indigo-600 hover:underline"
                >
                  {t('products.addFirstCategory')}
                </button>
              </div>
            ) : (
              visibleCategories.map((cat) => (
                <div
                  key={cat.id}
                  onClick={() => handleSelectCategory(cat)}
                  className={`group flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${selectedCategoryId === cat.id ? 'bg-indigo-50 border-l-2 border-indigo-500' : 'hover:bg-gray-50 border-l-2 border-transparent'}`}
                >
                  <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-100 to-indigo-100 flex items-center justify-center flex-shrink-0">
                    <svg
                      className="w-4 h-4 text-blue-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                      />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-800 truncate">
                      {cat.category_name}
                    </div>
                    <div className="text-xs text-gray-500">
                      {t('products.itemsCount', { count: getCategoryProducts(cat.id).length })}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {statusPill(cat.status)}
                    <div className="relative" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => setCatMenuId(catMenuId === cat.id ? null : cat.id)}
                        className="p-1 rounded text-gray-300 hover:text-gray-600 hover:bg-gray-200 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <circle cx="12" cy="5" r="1.5" />
                          <circle cx="12" cy="12" r="1.5" />
                          <circle cx="12" cy="19" r="1.5" />
                        </svg>
                      </button>
                      {catMenuId === cat.id && (
                        <div className="absolute right-0 top-7 z-30 w-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                          <button
                            onClick={() => {
                              handleEditCategory(cat)
                              setCatMenuId(null)
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
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
                            {t('common.edit')}
                          </button>
                          <div className="border-t border-gray-100 my-0.5" />
                          <button
                            onClick={() => {
                              handleDeleteCategory(cat)
                              setCatMenuId(null)
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
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
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Column 3: Products ── */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                {t('products.productsColumn')}
              </span>
              {selectedCategory && (
                <span className="text-xs text-indigo-600 font-medium bg-indigo-50 px-2 py-0.5 rounded-full">
                  {selectedCategory.category_name}
                </span>
              )}
            </div>
            {selectedCategoryId && (
              <span className="text-xs text-gray-500">{t('products.itemsCount', { count: visibleProducts.length })}</span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {!selectedCategoryId ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                <svg
                  className="w-8 h-8 text-gray-300"
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
                <p className="text-sm text-gray-500">{t('products.selectCategoryPrompt')}</p>
              </div>
            ) : visibleProducts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-gray-500"
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
                <p className="text-sm text-gray-500">{t('products.noProductsInCategory')}</p>
              </div>
            ) : (
              visibleProducts.map((product) => (
                <div
                  key={product.id}
                  onClick={() => handleViewProduct(product)}
                  className="group flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
                >
                  {product.product_image_url ? (
                    <img
                      src={product.product_image_url}
                      alt={product.product_name}
                      className="w-10 h-10 object-cover rounded-lg border border-gray-100 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-100 to-teal-100 flex items-center justify-center flex-shrink-0">
                      <svg
                        className="w-5 h-5 text-emerald-500"
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
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-800 truncate group-hover:text-indigo-600 transition-colors">
                      {product.product_name}
                    </div>
                    <div className="text-xs text-gray-500 font-mono">{product.sku}</div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span
                      className={`px-2 py-0.5 text-xs rounded-full font-medium ${product.status === 'active' ? 'bg-green-100 text-green-700' : product.status === 'discontinued' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}
                    >
                      {product.status}
                    </span>
                    <svg
                      className="w-4 h-4 text-gray-300 group-hover:text-indigo-400 transition-colors"
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
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
