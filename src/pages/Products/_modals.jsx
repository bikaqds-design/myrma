import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import Modal from '../../components/Modal'
import { Button } from '../../components/ui'
import { VendorFieldsSection } from '../Purchasing/_modals'

export function AddProductModal({
  productForm,
  setProductForm,
  brands,
  categories,
  subcategories,
  imagePreview,
  handleImageChange,
  handleSaveProduct,
  onClose,
  editingProduct,
  trackingModeLocked = false,
}) {
  const { t } = useTranslation()
  const filteredCategories = categories.filter((c) => c.brand_id === productForm.brand_id)
  const filteredSubcategories = subcategories.filter(
    (s) => s.category_id === productForm.category_id
  )

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={editingProduct ? t('products.editProduct') : t('products.addNewProduct')}
      className="max-w-3xl"
      hideHeader
      noPadding
      scrollable={false}
    >
      <div>
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">
              {editingProduct ? t('products.editProduct') : t('products.addNewProduct')}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              <span className="text-red-500">*</span> {t('products.requiredFields')}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4 max-h-[calc(100vh-200px)] overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('products.brand')} <span className="text-red-500">*</span>
            </label>
            <select
              value={productForm.brand_id}
              onChange={(e) =>
                setProductForm({
                  ...productForm,
                  brand_id: e.target.value,
                  category_id: '',
                  subcategory_id: '',
                })
              }
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              required
            >
              <option value="">{t('products.selectBrand')}</option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.brand_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('products.category')}</label>
            <select
              value={productForm.category_id}
              onChange={(e) =>
                setProductForm({ ...productForm, category_id: e.target.value, subcategory_id: '' })
              }
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              disabled={!productForm.brand_id}
            >
              <option value="">{t('products.selectCategory')}</option>
              {filteredCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.category_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('products.subcategory')}</label>
            <select
              value={productForm.subcategory_id}
              onChange={(e) => setProductForm({ ...productForm, subcategory_id: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              disabled={!productForm.category_id}
            >
              <option value="">{t('products.selectSubcategory')}</option>
              {filteredSubcategories.map((subcategory) => (
                <option key={subcategory.id} value={subcategory.id}>
                  {subcategory.subcategory_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('products.sku')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={productForm.sku}
              onChange={(e) => setProductForm({ ...productForm, sku: e.target.value })}
              placeholder="e.g., PRD-001"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('products.productName')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={productForm.product_name}
              onChange={(e) => setProductForm({ ...productForm, product_name: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('products.productType')}</label>
              <select
                value={productForm.product_type}
                onChange={(e) => setProductForm({ ...productForm, product_type: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              >
                <option value="hardware">{t('products.typeHardware')}</option>
                <option value="software">{t('products.typeSoftware')}</option>
                <option value="accessory">{t('products.typeAccessory')}</option>
                <option value="service">{t('products.typeService')}</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('common.status')}</label>
              <select
                value={productForm.status}
                onChange={(e) => setProductForm({ ...productForm, status: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              >
                <option value="active">{t('products.statusActive')}</option>
                <option value="inactive">{t('products.statusInactive')}</option>
                <option value="discontinued">{t('products.statusDiscontinued')}</option>
              </select>
            </div>
          </div>

          {/* Tracking mode decides which table this product's stock lives in
              (inventory_units vs warehouse_stock), so it is locked once stock
              exists — see 20260772, which enforces the same rule server-side.
              Services never touch inventory, so the control is irrelevant for
              them and is hidden rather than shown disabled. */}
          {productForm.product_type !== 'service' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('products.stockTrackingMode')}
              </label>
              <select
                value={productForm.stock_tracking_mode}
                onChange={(e) =>
                  setProductForm({ ...productForm, stock_tracking_mode: e.target.value })
                }
                disabled={trackingModeLocked}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent disabled:bg-gray-100 disabled:text-gray-600 disabled:cursor-not-allowed"
              >
                {/* Reuses the inventory namespace so the words here match the
                    TRACKING column on Inventory → Overview exactly. */}
                <option value="serialized">{t('inventory.tracking_serialized')}</option>
                <option value="bulk">{t('inventory.tracking_bulk')}</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {trackingModeLocked
                  ? t('products.trackingModeLocked')
                  : t('products.trackingModeHint')}
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('products.warrantyMonths')}
            </label>
            <input
              type="number"
              value={productForm.warranty_months}
              onChange={(e) =>
                setProductForm({ ...productForm, warranty_months: parseInt(e.target.value) || 0 })
              }
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              min="0"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('common.description')}</label>
            <textarea
              value={productForm.product_description}
              onChange={(e) =>
                setProductForm({ ...productForm, product_description: e.target.value })
              }
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              rows="3"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('products.productLink')}</label>
            <input
              type="url"
              value={productForm.product_link}
              onChange={(e) => setProductForm({ ...productForm, product_link: e.target.value })}
              placeholder="https://..."
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('products.productPhoto')}</label>
            {imagePreview ? (
              <div className="flex items-center gap-4">
                <img
                  src={imagePreview}
                  alt="Preview"
                  className="w-32 h-32 object-cover rounded border"
                />
                <div className="flex flex-col gap-2">
                  <label className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 cursor-pointer text-center">
                    {t('products.changePhoto')}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleImageChange}
                      className="hidden"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setProductForm({ ...productForm, product_image_url: null })
                    }}
                    className="px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50"
                  >
                    {t('products.removePhoto')}
                  </button>
                </div>
              </div>
            ) : (
              <label className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-indigo-500 transition-colors block">
                <svg
                  className="w-12 h-12 text-gray-500 mx-auto mb-4"
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
                <p className="text-gray-600 mb-2">{t('products.uploadPhotoPrompt')}</p>
                <p className="text-sm text-gray-500">{t('products.uploadPhotoHint')}</p>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageChange}
                  className="hidden"
                />
              </label>
            )}
          </div>
        </div>

        <div className="flex gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button className="flex-1 justify-center" onClick={handleSaveProduct}>
            {editingProduct ? t('products.updateProduct') : t('products.addProduct')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function AddBrandModal({
  brandForm,
  setBrandForm,
  logoPreview,
  handleLogoChange,
  handleSaveBrand,
  onClose,
  editingBrand,
}) {
  const { t } = useTranslation()
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={editingBrand ? t('products.editBrand') : t('products.addNewBrand')}
      hideHeader
      noPadding
    >
      <div>
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">
            {editingBrand ? t('products.editBrand') : t('products.addNewBrand')}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('products.brandName')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={brandForm.brand_name}
              onChange={(e) => setBrandForm({ ...brandForm, brand_name: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('common.description')}</label>
            <textarea
              value={brandForm.brand_description}
              onChange={(e) => setBrandForm({ ...brandForm, brand_description: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              rows="3"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('common.status')}</label>
            <select
              value={brandForm.status}
              onChange={(e) => setBrandForm({ ...brandForm, status: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            >
              <option value="active">{t('products.statusActive')}</option>
              <option value="inactive">{t('products.statusInactive')}</option>
            </select>
          </div>

          <div className="border-t border-gray-200 pt-4">
            <label className="block text-sm font-semibold text-gray-700 mb-3">{t('products.vendorDetailsSection')}</label>
            <p className="text-xs text-gray-500 mb-3">{t('products.vendorDetailsHint')}</p>
            <VendorFieldsSection
              values={brandForm}
              onChange={(patch) => setBrandForm({ ...brandForm, ...patch })}
              t={t}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('products.brandLogo')}</label>
            {logoPreview ? (
              <div className="flex items-center gap-4">
                <img
                  src={logoPreview}
                  alt="Logo preview"
                  className="w-24 h-24 object-contain rounded border"
                />
                <div className="flex flex-col gap-2">
                  <label className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 cursor-pointer text-center">
                    {t('products.changeLogo')}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleLogoChange}
                      className="hidden"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setBrandForm({ ...brandForm, brand_logo_url: null })
                    }}
                    className="px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50"
                  >
                    {t('products.removeLogo')}
                  </button>
                </div>
              </div>
            ) : (
              <label className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-indigo-500 transition-colors block">
                <svg
                  className="w-10 h-10 text-gray-500 mx-auto mb-3"
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
                <p className="text-gray-600 mb-2">{t('products.uploadLogoPrompt')}</p>
                <p className="text-sm text-gray-500">{t('products.uploadLogoHint')}</p>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleLogoChange}
                  className="hidden"
                />
              </label>
            )}
          </div>
        </div>

        <div className="flex gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button className="flex-1 justify-center" onClick={handleSaveBrand}>
            {editingBrand ? t('products.updateBrand') : t('products.addBrand')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function AddCategoryModal({
  categoryForm,
  setCategoryForm,
  brands,
  handleSaveCategory,
  onClose,
  editingCategory,
}) {
  const { t } = useTranslation()
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={editingCategory ? t('products.editCategory') : t('products.addNewCategory')}
      hideHeader
      noPadding
      scrollable={false}
    >
      <div>
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">
            {editingCategory ? t('products.editCategory') : t('products.addNewCategory')}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('products.brand')} <span className="text-red-500">*</span>
            </label>
            <select
              value={categoryForm.brand_id}
              onChange={(e) => setCategoryForm({ ...categoryForm, brand_id: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              required
            >
              <option value="">{t('products.selectBrand')}</option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.brand_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('products.categoryName')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={categoryForm.category_name}
              onChange={(e) => setCategoryForm({ ...categoryForm, category_name: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('common.description')}</label>
            <textarea
              value={categoryForm.category_description}
              onChange={(e) =>
                setCategoryForm({ ...categoryForm, category_description: e.target.value })
              }
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              rows="3"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('common.status')}</label>
            <select
              value={categoryForm.status}
              onChange={(e) => setCategoryForm({ ...categoryForm, status: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            >
              <option value="active">{t('products.statusActive')}</option>
              <option value="inactive">{t('products.statusInactive')}</option>
            </select>
          </div>
        </div>

        <div className="flex gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button className="flex-1 justify-center" onClick={handleSaveCategory}>
            {editingCategory ? t('products.updateCategory') : t('products.addCategoryAction')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function BulkUploadModal({ onClose, onUpload, onDownloadTemplate }) {
  const { t } = useTranslation()
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0]
    if (selectedFile) {
      if (!selectedFile.name.endsWith('.csv')) {
        toast.error(t('products.errorSelectCSV'))
        return
      }
      setFile(selectedFile)
    }
  }

  const handleUpload = async () => {
    if (!file) {
      toast.error(t('products.errorSelectFile'))
      return
    }

    setUploading(true)
    try {
      await onUpload(file)
    } finally {
      setUploading(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={t('products.bulkUploadTitle')}
      className="max-w-2xl"
      hideHeader
      noPadding
      scrollable={false}
    >
      <div>
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">{t('products.bulkUploadTitle')}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="font-medium text-blue-900 mb-2">📋 {t('products.bulkInstructionsTitle')}</h3>
            <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
              <li>{t('products.bulkStep1')}</li>
              <li>{t('products.bulkStep2')}</li>
              <li>{t('products.bulkStep3')}</li>
              <li>{t('products.bulkStep4')}</li>
              <li>{t('products.bulkStep5')}</li>
              <li>{t('products.bulkStep6')}</li>
              <li>{t('products.bulkStep7')}</li>
            </ul>
          </div>

          <div>
            <button
              onClick={onDownloadTemplate}
              className="w-full px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              {t('products.downloadCSVTemplate')}
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('products.uploadCSVFileLabel')}</label>
            <label className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-indigo-500 transition-colors block">
              {file ? (
                <div className="space-y-2">
                  <svg
                    className="w-12 h-12 text-green-500 mx-auto"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <p className="font-medium text-gray-900">{file.name}</p>
                  <p className="text-sm text-gray-500">{(file.size / 1024).toFixed(2)} KB</p>
                  <p className="text-xs text-indigo-600">{t('products.clickToChangeFile')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <svg
                    className="w-12 h-12 text-gray-500 mx-auto"
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
                  <p className="text-gray-600">{t('products.clickToUploadCSV')}</p>
                  <p className="text-sm text-gray-500">{t('products.dragAndDrop')}</p>
                </div>
              )}
              <input type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
            </label>
          </div>

          {file && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
              ⚠️ {t('products.bulkUploadWarning')}
            </div>
          )}
        </div>

        <div className="flex gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            className="flex-1 justify-center"
            onClick={handleUpload}
            disabled={!file}
            loading={uploading}
          >
            {!uploading && (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
            {uploading ? t('products.uploading') : t('products.uploadProducts')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
