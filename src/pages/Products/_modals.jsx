import React, { useState } from 'react'
import toast from 'react-hot-toast'
import Modal from '../../components/Modal'
import { Button } from '../../components/ui'

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
}) {
  const filteredCategories = categories.filter((c) => c.brand_id === productForm.brand_id)
  const filteredSubcategories = subcategories.filter(
    (s) => s.category_id === productForm.category_id
  )

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={editingProduct ? 'Edit Product' : 'Add New Product'}
      className="max-w-3xl"
      hideHeader
      noPadding
      scrollable={false}
    >
      <div>
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">
              {editingProduct ? 'Edit Product' : 'Add New Product'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              <span className="text-red-500">*</span> Required fields
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
              Brand <span className="text-red-500">*</span>
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
              <option value="">Select Brand</option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.brand_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Category</label>
            <select
              value={productForm.category_id}
              onChange={(e) =>
                setProductForm({ ...productForm, category_id: e.target.value, subcategory_id: '' })
              }
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              disabled={!productForm.brand_id}
            >
              <option value="">Select Category</option>
              {filteredCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.category_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Subcategory</label>
            <select
              value={productForm.subcategory_id}
              onChange={(e) => setProductForm({ ...productForm, subcategory_id: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              disabled={!productForm.category_id}
            >
              <option value="">Select Subcategory</option>
              {filteredSubcategories.map((subcategory) => (
                <option key={subcategory.id} value={subcategory.id}>
                  {subcategory.subcategory_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              SKU <span className="text-red-500">*</span>
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
              Product Name <span className="text-red-500">*</span>
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
              <label className="block text-sm font-medium text-gray-700 mb-2">Product Type</label>
              <select
                value={productForm.product_type}
                onChange={(e) => setProductForm({ ...productForm, product_type: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              >
                <option value="hardware">Hardware</option>
                <option value="software">Software</option>
                <option value="accessory">Accessory</option>
                <option value="service">Service</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
              <select
                value={productForm.status}
                onChange={(e) => setProductForm({ ...productForm, status: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="discontinued">Discontinued</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Warranty (months)
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
            <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
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
            <label className="block text-sm font-medium text-gray-700 mb-2">Product Link</label>
            <input
              type="url"
              value={productForm.product_link}
              onChange={(e) => setProductForm({ ...productForm, product_link: e.target.value })}
              placeholder="https://..."
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Product Photo</label>
            {imagePreview ? (
              <div className="flex items-center gap-4">
                <img
                  src={imagePreview}
                  alt="Preview"
                  className="w-32 h-32 object-cover rounded border"
                />
                <div className="flex flex-col gap-2">
                  <label className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 cursor-pointer text-center">
                    Change Photo
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
                    Remove Photo
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
                <p className="text-gray-600 mb-2">Click to upload product photo</p>
                <p className="text-sm text-gray-500">PNG, JPG up to 5MB</p>
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
            Cancel
          </Button>
          <Button className="flex-1 justify-center" onClick={handleSaveProduct}>
            {editingProduct ? 'Update Product' : 'Add Product'}
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
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={editingBrand ? 'Edit Brand' : 'Add New Brand'}
      hideHeader
      noPadding
      scrollable={false}
    >
      <div>
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">
            {editingBrand ? 'Edit Brand' : 'Add New Brand'}
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
              Brand Name <span className="text-red-500">*</span>
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
            <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
            <textarea
              value={brandForm.brand_description}
              onChange={(e) => setBrandForm({ ...brandForm, brand_description: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              rows="3"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
            <select
              value={brandForm.status}
              onChange={(e) => setBrandForm({ ...brandForm, status: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Brand Logo</label>
            {logoPreview ? (
              <div className="flex items-center gap-4">
                <img
                  src={logoPreview}
                  alt="Logo preview"
                  className="w-24 h-24 object-contain rounded border"
                />
                <div className="flex flex-col gap-2">
                  <label className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 cursor-pointer text-center">
                    Change Logo
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
                    Remove Logo
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
                <p className="text-gray-600 mb-2">Click to upload logo</p>
                <p className="text-sm text-gray-500">PNG, JPG up to 2MB</p>
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
            Cancel
          </Button>
          <Button className="flex-1 justify-center" onClick={handleSaveBrand}>
            {editingBrand ? 'Update Brand' : 'Add Brand'}
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
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={editingCategory ? 'Edit Category' : 'Add New Category'}
      hideHeader
      noPadding
      scrollable={false}
    >
      <div>
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">
            {editingCategory ? 'Edit Category' : 'Add New Category'}
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
              Brand <span className="text-red-500">*</span>
            </label>
            <select
              value={categoryForm.brand_id}
              onChange={(e) => setCategoryForm({ ...categoryForm, brand_id: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              required
            >
              <option value="">Select Brand</option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.brand_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Category Name <span className="text-red-500">*</span>
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
            <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
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
            <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
            <select
              value={categoryForm.status}
              onChange={(e) => setCategoryForm({ ...categoryForm, status: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>

        <div className="flex gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>
            Cancel
          </Button>
          <Button className="flex-1 justify-center" onClick={handleSaveCategory}>
            {editingCategory ? 'Update Category' : 'Add Category'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function BulkUploadModal({ onClose, onUpload, onDownloadTemplate }) {
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0]
    if (selectedFile) {
      if (!selectedFile.name.endsWith('.csv')) {
        toast.error('Please select a CSV file')
        return
      }
      setFile(selectedFile)
    }
  }

  const handleUpload = async () => {
    if (!file) {
      toast.error('Please select a file first')
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
      title="Bulk Upload Products"
      className="max-w-2xl"
      hideHeader
      noPadding
      scrollable={false}
    >
      <div>
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">Bulk Upload Products</h2>
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
            <h3 className="font-medium text-blue-900 mb-2">📋 Instructions:</h3>
            <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
              <li>Download the CSV template first</li>
              <li>Fill in your product data following the template format</li>
              <li>
                Required fields: <strong>sku, product_name, brand_name</strong>
              </li>
              <li>Brand must already exist in the system</li>
              <li>
                Optional fields: category_name, subcategory_name, product_type, status,
                warranty_months, description, product_link
              </li>
              <li>Valid product_type values: hardware, software, accessory, service</li>
              <li>Valid status values: active, inactive, discontinued</li>
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
              Download CSV Template
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Upload CSV File</label>
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
                  <p className="text-xs text-indigo-600">Click to change file</p>
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
                  <p className="text-gray-600">Click to upload CSV file</p>
                  <p className="text-sm text-gray-500">or drag and drop</p>
                </div>
              )}
              <input type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
            </label>
          </div>

          {file && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
              ⚠️ Make sure your brands exist in the system before uploading. Categories and
              subcategories will be matched if they exist.
            </div>
          )}
        </div>

        <div className="flex gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>
            Cancel
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
            {uploading ? 'Uploading...' : 'Upload Products'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
