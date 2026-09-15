import React, { useState, useEffect } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { db, storage } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import ConfirmDialog from '../components/ConfirmDialog'
import { CardSkeleton } from '../components/Skeleton'
import { Button } from '../components/ui'
import { useURLTab } from '../hooks/useURLTab'
import { ROLES, TICKET_STATUS } from '../lib/constants'
import { captureException } from '../lib/sentry'
import ProductDocuments from '../components/ProductDocuments'
import Pagination from '../components/Pagination'
import { safeStorage } from '../lib/safeStorage'

export default function ProductDetails({
  productId,
  currentUserRole,
  currentUserEmail,
  currentUserPermissions,
  onBack,
  onNavigateToTicket,
}) {
  const { t } = useTranslation()
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

  const { data: productPageData, isLoading: loading, refetch } = useQuery({
    queryKey: ['product-details', productId],
    queryFn: async () => {
      const [productData, brandsData, categoriesData, subcategoriesData] =
        await Promise.all([
          db.products.get(productId),
          db.brands.list(),
          db.categories.list(),
          db.subcategories.list(),
        ])
      return { productData, brandsData, categoriesData, subcategoriesData }
    },
    enabled: !!productId,
  })

  const product = productPageData?.productData ?? null
  const brands = productPageData?.brandsData ?? []
  const categories = productPageData?.categoriesData ?? []
  const subcategories = productPageData?.subcategoriesData ?? []

  // The tickets any unit of this product came in on, one page at a time
  // (rma_product_tickets). It read every unit's ticket id and then every one of
  // those tickets in a single request — both capped at 1 000 rows. (BUG-066.)
  const [ticketPage, setTicketPage] = useState(1)
  const [ticketsPerPage, setTicketsPerPage] = useState(() => safeStorage.get('productTicketsPerPage', 25))
  useEffect(() => { safeStorage.set('productTicketsPerPage', ticketsPerPage) }, [ticketsPerPage])
  useEffect(() => { setTicketPage(1) }, [productId, ticketsPerPage])
  const { data: ticketsResult } = useQuery({
    queryKey: ['product-tickets', productId, ticketPage, ticketsPerPage],
    queryFn: () => db.products.relatedTicketsPage(productId, ticketPage, ticketsPerPage),
    placeholderData: keepPreviousData,
    enabled: !!productId,
  })
  const relatedTickets = ticketsResult?.data ?? []
  const relatedTicketCount = ticketsResult?.count ?? 0

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
        toast.error(t('products.errorSelectImage'))
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        toast.error(t('products.errorImageSize'))
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
      toast.error(t('products.errorRequiredFields'))
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
      toast.success(t('products.successUpdated'))
      db.auditLog
        .log(
          currentUserEmail,
          'product_updated',
          `Updated product ${productData.product_name} (${productData.sku})`
        )
        .catch(() => {})
      setEditMode(false)
      setImageFile(null)
      refetch()
    } catch (error) {
      captureException(error)
      toast.error(t('products.failedSave', { error: error.message }))
    }
  }

  const handleDelete = () => {
    openConfirm(
      t('products.deleteTitle'),
      t('products.deleteMsg', { name: product.product_name }),
      async () => {
        closeConfirm()
        try {
          await db.products.delete(productId)
          toast.success(t('products.successDeleted'))
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
          toast.error(t('products.errorDeleteProduct'))
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
        <h2 className="text-2xl font-bold text-gray-900 mb-2">{t('products.notFound')}</h2>
        <button
          onClick={onBack}
          className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-medium"
        >
          {t('products.backToProducts')}
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
            {t('common.back')}
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
              {t('common.edit')}
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
              {t('common.delete')}
            </Button>
          </div>
        )}

        {editMode && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={handleCancelEdit}>
              {t('common.cancel')}
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
              {t('customerDetails.saveChanges')}
            </Button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="border-b border-gray-200">
          <nav className="flex gap-4 sm:gap-8 px-6">
            <button
              onClick={() => setActiveTab('details')}
              className={
                'py-4 border-b-2 font-medium transition-colors ' +
                (activeTab === 'details'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700')
              }
            >
              {t('products.tabDetails')}
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
              {t('products.tabRMAHistory', { count: relatedTicketCount })}
            </button>
            {/* The datasheet lives with the product, not in a separate uploads
                area — the moment someone wants to attach one is the moment they
                are looking at the product. */}
            <button
              onClick={() => setActiveTab('documents')}
              className={
                'py-4 border-b-2 font-medium transition-colors ' +
                (activeTab === 'documents'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700')
              }
            >
              {t('documents.tab')}
            </button>
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 'details' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Image Section */}
              <div className="lg:col-span-1">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">{t('products.productPhoto')}</h3>
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
                            {t('products.changePhoto')}
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
                            {t('products.removePhoto')}
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
                          {t('products.uploadPhotoPrompt')}
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
                        {t('products.sku')} <span className="text-red-500">*</span>
                      </label>
                      <input aria-label={t('products.sku')}
                        type="text"
                        value={editForm.sku}
                        onChange={(e) => setEditForm({ ...editForm, sku: e.target.value })}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        {t('products.productName')} <span className="text-red-500">*</span>
                      </label>
                      <input aria-label={t('products.productName')}
                        type="text"
                        value={editForm.product_name}
                        onChange={(e) => setEditForm({ ...editForm, product_name: e.target.value })}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {t('products.brand')} <span className="text-red-500">*</span>
                        </label>
                        <select aria-label={t('products.brand')}
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
                          {t('products.category')}
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
                          <option value="">{t('products.selectCategory')}</option>
                          {filteredCategories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.category_name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {t('products.subcategory')}
                        </label>
                        <select
                          value={editForm.subcategory_id}
                          onChange={(e) =>
                            setEditForm({ ...editForm, subcategory_id: e.target.value })
                          }
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                          disabled={!editForm.category_id}
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
                          {t('products.productType')}
                        </label>
                        <select
                          value={editForm.product_type}
                          onChange={(e) =>
                            setEditForm({ ...editForm, product_type: e.target.value })
                          }
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                        >
                          <option value="hardware">{t('products.typeHardware')}</option>
                          <option value="software">{t('products.typeSoftware')}</option>
                          <option value="accessory">{t('products.typeAccessory')}</option>
                          <option value="service">{t('products.typeService')}</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {t('common.status')}
                        </label>
                        <select
                          value={editForm.status}
                          onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
                        >
                          <option value="active">{t('products.statusActive')}</option>
                          <option value="inactive">{t('products.statusInactive')}</option>
                          <option value="discontinued">{t('products.statusDiscontinued')}</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {t('products.warrantyMonths')}
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
                        {t('common.description')}
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
                        {t('products.productLink')}
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <DetailField label={t('products.brand')} value={product.brand?.brand_name || '-'} />
                      <DetailField
                        label={t('products.category')}
                        value={product.category?.category_name || '-'}
                      />
                      <DetailField
                        label={t('products.subcategory')}
                        value={product.subcategory?.subcategory_name || '-'}
                      />
                      <DetailField
                        label={t('products.productType')}
                        value={product.product_type || '-'}
                        capitalize
                      />
                      <DetailField
                        label={t('common.status')}
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
                        label={t('products.warrantyMonths')}
                        value={`${product.warranty_months || 0} months`}
                      />
                    </div>

                    {product.product_description && (
                      <div>
                        <label className="block text-sm font-medium text-gray-500 mb-1">
                          {t('common.description')}
                        </label>
                        <p className="text-gray-900 whitespace-pre-wrap">
                          {product.product_description}
                        </p>
                      </div>
                    )}

                    {product.product_link && (
                      <div>
                        <label className="block text-sm font-medium text-gray-500 mb-1">
                          {t('products.productLink')}
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

                    <div className="pt-4 border-t border-gray-200 grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <DetailField label={t('products.labelCreated')} value={formatDate(product.created_date)} />
                      <DetailField label={t('products.labelCreatedBy')} value={product.created_by || '-'} />
                      <DetailField label={t('products.labelLastUpdated')} value={formatDate(product.updated_date)} />
                      <DetailField label={t('products.labelUpdatedBy')} value={product.updated_by || '-'} />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {activeTab === 'documents' && (
            <ProductDocuments
              product={product}
              currentUserEmail={currentUserEmail}
              // This page already has its own canDo(action) closure over the
              // current role and permissions; importing the library one shadowed
              // it with a different signature.
              canEdit={canDo('edit')}
            />
          )}

          {activeTab === 'rma-history' && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900">{t('products.relatedRMATickets')}</h3>

              {relatedTicketCount === 0 ? (
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
                  <p className="text-gray-500">{t('products.noRelatedTickets')}</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-y border-gray-200">
                      <tr>
                        <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 uppercase">
                          {t('customerDetails.colRmaNumber')}
                        </th>
                        <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 uppercase">
                          {t('products.colCustomer')}
                        </th>
                        <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 uppercase">
                          {t('common.status')}
                        </th>
                        <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 uppercase">
                          {t('common.priority')}
                        </th>
                        <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 uppercase">
                          {t('products.colCreated')}
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
                                (ticket.ticket_status === TICKET_STATUS.OPEN
                                  ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-400'
                                  : ticket.ticket_status === TICKET_STATUS.IN_PROGRESS
                                    ? 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-400'
                                    : ticket.ticket_status === TICKET_STATUS.ON_HOLD
                                      ? 'bg-orange-100 dark:bg-orange-900/20 text-orange-800 dark:text-orange-300'
                                      : ticket.ticket_status === TICKET_STATUS.COMPLETED
                                        ? 'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400'
                                        : 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]')
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
                                    ? 'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-300'
                                    : ticket.priority === 'Medium'
                                      ? 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-400'
                                      : 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]')
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
                  <Pagination total={relatedTicketCount} page={ticketPage} itemsPerPage={ticketsPerPage} setItemsPerPage={setTicketsPerPage} onPage={setTicketPage} />
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
              ? 'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400'
              : badgeColor === 'red'
                ? 'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-300'
                : 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]')
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
