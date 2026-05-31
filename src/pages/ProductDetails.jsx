import React, { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { db, storage } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import ConfirmDialog from '../components/ConfirmDialog'
import { CardSkeleton } from '../components/Skeleton'
import { Button } from '../components/ui'
import { useURLTab } from '../hooks/useURLTab'
import { ROLES } from '../lib/constants'
import { captureException } from '../lib/sentry'

export default function ProductDetails({
  productId,
  currentUserRole,
  currentUserEmail,
  currentUserPermissions,
  onBack,
  onNavigateToTicket,
}) {
  const [activeTab, setActiveTab] = useURLTab('tab', 'details')
  const [editMode, setEditMode] = useState(false)

  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    message: '',
    onConfirm: null,
  })
  const openConfirm = (title, message, onConfirm) =>
    setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog((d) => ({ ...d, open: false }))

  const { data: productPageData, isLoading: loading } = useQuery({
    queryKey: ['product-details', productId],
    queryFn: async () => {
      const [productData, brandsData, categoriesData, subcategoriesData, ticketsData] =
        await Promise.all([
          db.products.get(productId),
          db.brands.list(),
          db.categories.list(),
          db.subcategories.list(),
          db.products.getRelatedTickets(productId).catch(() => []),
        ])
      return { productData, brandsData, categoriesData, subcategoriesData, ticketsData }
    },
    enabled: !!productId,
  })

  const product = productPageData?.productData ?? null
  const brands = productPageData?.brandsData ?? []
  const categories = productPageData?.categoriesData ?? []
  const subcategories = productPageData?.subcategoriesData ?? []
  const relatedTickets = productPageData?.ticketsData ?? []

  const [editForm, setEditForm] = useState({
    brand_id: '',
    category_id: '',
    subcategory_id: '',
    sku: '',
    product_name: '',
    product_type: 'hardware',
    status: 'active',
    warranty_months: 12,
    product_description: '',
    product_link: '',
    product_image_url: null,
  })
  const [imageFile, setImageFile] = useState(null)
  const [imagePreview, setImagePreview] = useState(null)

  // Sync editForm and imagePreview when product data loads
  useEffect(() => {
    if (!product) return
    setEditForm({
      brand_id: product.brand_id || '',
      category_id: product.category_id || '',
      subcategory_id: product.subcategory_id || '',
      sku: product.sku || '',
      product_name: product.product_name || '',
      product_type: product.product_type || 'hardware',
      status: product.status || 'active',
      warranty_months: product.warranty_months || 12,
      product_description: product.product_description || '',
      product_link: product.product_link || '',
      product_image_url: product.product_image_url || null,
    })
    setImagePreview(product.product_image_url)
  }, [product])

  const handleImageChange = (e) => {
    const file = e.target.files[0]
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast.error('Please select an image file')
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        toast.error('Image must be less than 5MB')
        return
      }
      setImageFile(file)
      const reader = new FileReader()
      reader.onloadend = () => setImagePreview(reader.result)
      reader.readAsDataURL(file)
    }
  }

  const handleSave = async () => {
    if (!editForm.sku || !editForm.product_name || !editForm.brand_id) {
      toast.error('Please fill in all required fields')
      return
    }

    try {
      let imageUrl = editForm.product_image_url

      if (imageFile) {
        const uploaded = await storage.uploadProductImage(imageFile, editForm.sku)
        imageUrl = uploaded.url
      }

      const productData = {
        sku: editForm.sku,
        product_name: editForm.product_name,
        brand_id: editForm.brand_id || null,
        category_id: editForm.category_id || null,
        subcategory_id: editForm.subcategory_id || null,
        product_type: editForm.product_type,
        status: editForm.status,
        warranty_months: editForm.warranty_months,
        product_description: editForm.product_description,
        product_link: editForm.product_link,
        product_image_url: imageUrl,
        updated_by: currentUserEmail,
        updated_date: new Date().toISOString(),
      }

      await db.products.update(productId, productData)
      toast.success('Product updated successfully')
      db.auditLog
        .log(
          currentUserEmail,
          'product_updated',
          `Updated product ${productData.product_name} (${productData.sku})`
        )
        .catch(() => {})
      setEditMode(false)
      setImageFile(null)
      fetchProduct()
    } catch (error) {
      captureException(error)
      toast.error(`Failed to save: ${error.message}`)
    }
  }

  const handleDelete = () => {
    openConfirm(
      'Delete Product',
      `Delete product "${product.product_name}"? This cannot be undone.`,
      async () => {
        closeConfirm()
        try {
          await db.products.delete(productId)
          toast.success('Product deleted')
          db.auditLog
            .log(
              currentUserEmail,
              'product_deleted',
              `Deleted product ${product.product_name} (${product.sku})`
            )
            .catch(() => {})
          onBack()
        } catch (error) {
          captureException(error)
          toast.error('Failed to delete product')
        }
      }
    )
  }

  const handleCancelEdit = () => {
    setEditMode(false)
    setImageFile(null)
    setImagePreview(product.product_image_url)
    setEditForm({
      brand_id: product.brand_id || '',
      category_id: product.category_id || '',
      subcategory_id: product.subcategory_id || '',
      sku: product.sku || '',
      product_name: product.product_name || '',
      product_type: product.product_type || 'hardware',
      status: product.status || 'active',
      warranty_months: product.warranty_months || 12,
      product_description: product.product_description || '',
      product_link: product.product_link || '',
      product_image_url: product.product_image_url || null,
    })
  }

  const formatDate = (dateString) => {
    if (!dateString) return '-'
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const filteredCategories = categories.filter((c) => c.brand_id === editForm.brand_id)
  const filteredSubcategories = subcategories.filter((s) => s.category_id === editForm.category_id)

  const isSuperAdmin = currentUserRole === ROLES.SUPER_ADMIN
  const canDo = (action) => {
    if (isSuperAdmin) return true
    if (currentUserPermissions?.products?.[action] === true) return true
    if (currentUserRole === ROLES.ADMIN) return true
    return false
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse bg-gray-200 rounded-lg" />
        <CardSkeleton lines={5} />
        <CardSkeleton lines={4} />
      </div>
    )
  }

  if (!product) {
    return (
      <div className="text-center py-12">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Product Not Found</h2>
        <button
          onClick={onBack}
          className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-medium"
        >
          ← Back to Products
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            Back
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{product.product_name}</h1>
            <p className="text-gray-500 font-mono text-sm">SKU: {product.sku}</p>
          </div>
        </div>

        {canDo('edit') && !editMode && (
          <div className="flex items-center gap-2">
            <Button onClick={() => setEditMode(true)}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </svg>
              Edit
            </Button>
            <Button variant="danger" onClick={handleDelete}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
              Delete
            </Button>
          </div>
        )}

        {editMode && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={handleCancelEdit}>
              Cancel
            </Button>
            <Button variant="success" onClick={handleSave}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              Save Changes
            </Button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="border-b border-gray-200">
          <nav className="flex gap-8 px-6">
            <button
              onClick={() => setActiveTab('details')}
              className={
                'py-4 border-b-2 font-medium transition-colors ' +
                (activeTab === 'details'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700')
              }
            >
              Product Details
            </button>
            <button
              onClick={() => setActiveTab('rma-history')}
              className={
                'py-4 border-b-2 font-medium transition-colors ' +
                (activeTab === 'rma-history'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700')
              }
            >
              RMA History ({relatedTickets.length})
            </button>
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 'details' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Image Section */}
              <div className="lg:col-span-1">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Product Image</h3>
                  {imagePreview || product.product_image_url ? (
                    <div className="space-y-3">
                      <img
                        src={imagePreview || product.product_image_url}
                        alt={product.product_name}
                        className="w-full h-64 object-contain rounded-lg border bg-white"
                      />
                      {editMode && (
                        <div className="space-y-2">
                          <label className="block w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 cursor-pointer text-center">
                            Change Image
                            <input
                              type="file"
                              accept="image/*"
                              onChange={handleImageChange}
                              className="hidden"
                            />
                          </label>
                          <button
                            onClick={() => {
                              setEditForm({ ...editForm, product_image_url: null })
                              setImagePreview(null)
                            }}
                            className="w-full px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50"
                          >
                            Remove Image
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="w-full h-64 bg-white border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center">
                        <svg
                          className="w-16 h-16 text-gray-300"
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
                      {editMode && (
                        <label className="block w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 cursor-pointer text-center">
                          Upload Image
                          <input
                            type="file"
                            accept="image/*"
                            onChange={handleImageChange}
                            className="hidden"
                          />
                        </label>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Details Section */}
              <div className="lg:col-span-2 space-y-4">
                {editMode ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        SKU <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={editForm.sku}
                        onChange={(e) => setEditForm({ ...editForm, sku: e.target.value })}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Product Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={editForm.product_name}
                        onChange={(e) => setEditForm({ ...editForm, product_name: e.target.value })}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Brand <span className="text-red-500">*</span>
                        </label>
                        <select
                          value={editForm.brand_id}
                          onChange={(e) =>
                            setEditForm({
                              ...editForm,
                              brand_id: e.target.value,
                              category_id: '',
                              subcategory_id: '',
                            })
                          }
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
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
                          Category
                        </label>
                        <select
                          value={editForm.category_id}
                          onChange={(e) =>
                            setEditForm({
                              ...editForm,
                              category_id: e.target.value,
                              subcategory_id: '',
                            })
                          }
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                          disabled={!editForm.brand_id}
                        >
                          <option value="">Select Category</option>
                          {filteredCategories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.category_name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Subcategory
                        </label>
                        <select
                          value={editForm.subcategory_id}
                          onChange={(e) =>
                            setEditForm({ ...editForm, subcategory_id: e.target.value })
                          }
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                          disabled={!editForm.category_id}
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
                          Product Type
                        </label>
                        <select
                          value={editForm.product_type}
                          onChange={(e) =>
                            setEditForm({ ...editForm, product_type: e.target.value })
                          }
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                        >
                          <option value="hardware">Hardware</option>
                          <option value="software">Software</option>
                          <option value="accessory">Accessory</option>
                          <option value="service">Service</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Status
                        </label>
                        <select
                          value={editForm.status}
                          onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                        >
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                          <option value="discontinued">Discontinued</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Warranty (months)
                        </label>
                        <input
                          type="number"
                          value={editForm.warranty_months}
                          onChange={(e) =>
                            setEditForm({
                              ...editForm,
                              warranty_months: parseInt(e.target.value) || 0,
                            })
                          }
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                          min="0"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Description
                      </label>
                      <textarea
                        value={editForm.product_description}
                        onChange={(e) =>
                          setEditForm({ ...editForm, product_description: e.target.value })
                        }
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                        rows="4"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Product Link
                      </label>
                      <input
                        type="url"
                        value={editForm.product_link}
                        onChange={(e) => setEditForm({ ...editForm, product_link: e.target.value })}
                        placeholder="https://..."
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <DetailField label="Brand" value={product.brand?.brand_name || '-'} />
                      <DetailField
                        label="Category"
                        value={product.category?.category_name || '-'}
                      />
                      <DetailField
                        label="Subcategory"
                        value={product.subcategory?.subcategory_name || '-'}
                      />
                      <DetailField
                        label="Product Type"
                        value={product.product_type || '-'}
                        capitalize
                      />
                      <DetailField
                        label="Status"
                        value={product.status || '-'}
                        badge
                        badgeColor={
                          product.status === 'active'
                            ? 'green'
                            : product.status === 'inactive'
                              ? 'gray'
                              : 'red'
                        }
                      />
                      <DetailField
                        label="Warranty"
                        value={`${product.warranty_months || 0} months`}
                      />
                    </div>

                    {product.product_description && (
                      <div>
                        <label className="block text-sm font-medium text-gray-500 mb-1">
                          Description
                        </label>
                        <p className="text-gray-900 whitespace-pre-wrap">
                          {product.product_description}
                        </p>
                      </div>
                    )}

                    {product.product_link && (
                      <div>
                        <label className="block text-sm font-medium text-gray-500 mb-1">
                          Product Link
                        </label>
                        <a
                          href={product.product_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-600 hover:text-indigo-900 hover:underline flex items-center gap-1"
                        >
                          {product.product_link}
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
                              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                            />
                          </svg>
                        </a>
                      </div>
                    )}

                    <div className="pt-4 border-t border-gray-200 grid grid-cols-2 gap-4">
                      <DetailField label="Created" value={formatDate(product.created_date)} />
                      <DetailField label="Created By" value={product.created_by || '-'} />
                      <DetailField label="Last Updated" value={formatDate(product.updated_date)} />
                      <DetailField label="Updated By" value={product.updated_by || '-'} />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {activeTab === 'rma-history' && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900">Related RMA Tickets</h3>

              {relatedTickets.length === 0 ? (
                <div className="text-center py-12 bg-gray-50 rounded-lg">
                  <svg
                    className="w-16 h-16 text-gray-300 mx-auto mb-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"
                    />
                  </svg>
                  <p className="text-gray-500">No RMA tickets found for this product</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-y border-gray-200">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          RMA Number
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Customer
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Status
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Priority
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Created
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {relatedTickets.map((ticket) => (
                        <tr
                          key={ticket.id}
                          onClick={() => onNavigateToTicket && onNavigateToTicket(ticket.id)}
                          className="hover:bg-blue-50 cursor-pointer"
                        >
                          <td className="px-4 py-3 font-mono text-sm text-indigo-600 hover:underline">
                            {ticket.rma_number || ticket.id.slice(0, 8)}
                          </td>
                          <td className="px-4 py-3 text-sm">{ticket.customer_name || '-'}</td>
                          <td className="px-4 py-3">
                            <span
                              className={
                                'px-2 py-1 text-xs rounded-full ' +
                                (ticket.ticket_status === 'New'
                                  ? 'bg-blue-100 text-blue-800'
                                  : ticket.ticket_status === 'In Progress'
                                    ? 'bg-yellow-100 text-yellow-800'
                                    : ticket.ticket_status === 'On Hold'
                                      ? 'bg-orange-100 text-orange-800'
                                      : ticket.ticket_status === 'Completed'
                                        ? 'bg-green-100 text-green-800'
                                        : 'bg-gray-100 text-gray-800')
                              }
                            >
                              {ticket.ticket_status || '-'}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={
                                'px-2 py-1 text-xs rounded-full ' +
                                (ticket.priority === 'Critical'
                                  ? 'bg-red-200 text-red-900'
                                  : ticket.priority === 'High'
                                    ? 'bg-red-100 text-red-800'
                                    : ticket.priority === 'Medium'
                                      ? 'bg-yellow-100 text-yellow-800'
                                      : 'bg-gray-100 text-gray-800')
                              }
                            >
                              {ticket.priority || '-'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {formatDate(ticket.created_date)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        onConfirm={confirmDialog.onConfirm}
        onCancel={closeConfirm}
      />
    </div>
  )
}

// Helper Component for Detail Fields
function DetailField({ label, value, capitalize, badge, badgeColor }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-500 mb-1">{label}</label>
      {badge ? (
        <span
          className={
            'inline-block px-3 py-1 text-sm rounded-full ' +
            (badgeColor === 'green'
              ? 'bg-green-100 text-green-800'
              : badgeColor === 'red'
                ? 'bg-red-100 text-red-800'
                : 'bg-gray-100 text-gray-800')
          }
        >
          {value}
        </span>
      ) : (
        <p className={'text-gray-900 ' + (capitalize ? 'capitalize' : '')}>{value}</p>
      )}
    </div>
  )
}
