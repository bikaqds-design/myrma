import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, db, storage } from '../../api/supabaseClient'
import { safeStorage } from '../../lib/safeStorage'
import toast from 'react-hot-toast'
import * as XLSX from 'xlsx'
import ConfirmDialog from '../../components/ConfirmDialog'
import { PageSkeleton } from '../../components/Skeleton'
import { PageHeader } from '../../components/ui'
import { useURLTab } from '../../hooks/useURLTab'
import { ROLES } from '../../lib/constants'
import { captureException } from '../../lib/sentry'
import { productSchema, getFirstError } from '../../lib/schemas'
import ProductsListTab from './ProductsListTab'
import HierarchyTab from './HierarchyTab'
import { AddProductModal, AddBrandModal, AddCategoryModal, BulkUploadModal } from './_modals'

export default function Products({
  currentUserRole,
  currentUserEmail,
  currentUserPermissions,
  onNavigateToProduct,
}) {
  const { t } = useTranslation()
  const searchRef = useRef(null)
  const [activeTab, setActiveTab] = useURLTab('tab', 'products')
  const queryClient = useQueryClient()
  const { data: productsPageData, isLoading: loading } = useQuery({
    queryKey: ['products-page'],
    queryFn: async () => {
      const [productsData, brandsData, categoriesData, subcategoriesData] = await Promise.all([
        db.products.list(),
        db.brands.list(),
        db.categories.list(),
        db.subcategories.list(),
      ])
      return { productsData, brandsData, categoriesData, subcategoriesData }
    },
  })

  const products = productsPageData?.productsData ?? []
  const [filteredProducts, setFilteredProducts] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [filterBrand, setFilterBrand] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [selectedProducts, setSelectedProducts] = useState([])

  // Pagination State
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(
    () => safeStorage.get('productsPerPage', 25)
  )
  const [jumpToPage, setJumpToPage] = useState('')

  // Sorting State
  const [sortConfig, setSortConfig] = useState(() =>
    safeStorage.get('productsSortConfig', { key: 'created_date', direction: 'desc' })
  )

  const brands = productsPageData?.brandsData ?? []
  const categories = productsPageData?.categoriesData ?? []
  const subcategories = productsPageData?.subcategoriesData ?? []
  const [expandedBrands, setExpandedBrands] = useState({})
  const [expandedCategories, setExpandedCategories] = useState({})
  const [openBrandMenu, setOpenBrandMenu] = useState(null)
  const [openMenuId, setOpenMenuId] = useState(null)
  const [showAddDropdown, setShowAddDropdown] = useState(false)

  const [showAddProduct, setShowAddProduct] = useState(false)
  const [showAddBrand, setShowAddBrand] = useState(false)
  const [showAddCategory, setShowAddCategory] = useState(false)
  const [showBulkUpload, setShowBulkUpload] = useState(false)

  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    message: '',
    onConfirm: null,
  })
  const openConfirm = (title, message, onConfirm) =>
    setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog((d) => ({ ...d, open: false }))
  const [editingProduct, setEditingProduct] = useState(null)
  const [editingBrand, setEditingBrand] = useState(null)
  const [editingCategory, setEditingCategory] = useState(null)

  const [productForm, setProductForm] = useState({
    brand_id: '',
    category_id: '',
    subcategory_id: '',
    sku: '',
    product_name: '',
    product_type: 'hardware',
    status: 'active',
    stock_tracking_mode: 'serialized',
    warranty_months: 12,
    product_description: '',
    product_link: '',
    product_image_url: null,
  })

  // Whether the product being edited already holds stock — freezes the
  // tracking-mode selector, because switching models points every reader at
  // the other (empty) table and hides the stock. Always false for a new
  // product. Resolved async on opening the edit form; defaults to locked=false
  // and only ever relaxes the UI, never the database (20260772 is the real
  // guard, so a stale false here surfaces as a server error, not corruption).
  const [trackingModeLocked, setTrackingModeLocked] = useState(false)

  const [brandForm, setBrandForm] = useState({
    brand_name: '',
    brand_description: '',
    status: 'active',
    brand_logo_url: null,
    contact_person: '',
    email: '',
    phone: '',
    tax_id: '',
    payment_terms: '',
  })

  const [categoryForm, setCategoryForm] = useState({
    brand_id: '',
    category_name: '',
    category_description: '',
    status: 'active',
  })

  const [imageFile, setImageFile] = useState(null)
  const [imagePreview, setImagePreview] = useState(null)
  const [logoFile, setLogoFile] = useState(null)
  const [logoPreview, setLogoPreview] = useState(null)

  const canDo = (action) => {
    if (currentUserRole === ROLES.SUPER_ADMIN || currentUserRole === ROLES.ADMIN) return true
    return currentUserPermissions?.products?.[action] === true
  }

  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.action-menu')) setOpenMenuId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    handleSearchAndSort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, filterBrand, filterCategory, filterStatus, products, sortConfig])

  // Real-time: refresh when products table changes
  useEffect(() => {
    const channel = supabase
      .channel('products_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
        queryClient.invalidateQueries({ queryKey: ['products-page'] })
        queryClient.invalidateQueries({ queryKey: ['products'] })
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])

  // Keyboard shortcuts: / = focus search, N = add product, Esc = close modal
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable
      if (e.key === 'Escape') {
        setShowAddProduct(false)
        setShowAddBrand(false)
        setShowAddCategory(false)
        return
      }
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        if (canDo('create')) setShowAddProduct(true)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAddProduct, showAddBrand, showAddCategory])

  useEffect(() => {
    safeStorage.set('productsPerPage', itemsPerPage)
  }, [itemsPerPage])

  useEffect(() => {
    safeStorage.set('productsSortConfig', sortConfig)
  }, [sortConfig])

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, itemsPerPage])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showAddDropdown && !e.target.closest('.add-product-dropdown')) {
        setShowAddDropdown(false)
      }
      if (openBrandMenu && !e.target.closest('.brand-menu')) {
        setOpenBrandMenu(null)
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [showAddDropdown, openBrandMenu])

  const handleSearchAndSort = () => {
    let filtered = [...products]

    // Apply search
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(
        (product) =>
          product.product_name?.toLowerCase().includes(query) ||
          product.sku?.toLowerCase().includes(query) ||
          product.brand?.brand_name?.toLowerCase().includes(query) ||
          product.category?.category_name?.toLowerCase().includes(query) ||
          product.product_description?.toLowerCase().includes(query)
      )
    }

    if (filterBrand) filtered = filtered.filter((p) => p.brand?.brand_name === filterBrand)
    if (filterCategory) filtered = filtered.filter((p) => p.category?.category_name === filterCategory)
    if (filterStatus) filtered = filtered.filter((p) => p.status === filterStatus)

    // Apply sorting
    filtered.sort((a, b) => {
      let aValue, bValue

      switch (sortConfig.key) {
        case 'sku':
          aValue = a.sku || ''
          bValue = b.sku || ''
          break
        case 'product_name':
          aValue = a.product_name || ''
          bValue = b.product_name || ''
          break
        case 'brand':
          aValue = a.brand?.brand_name || ''
          bValue = b.brand?.brand_name || ''
          break
        case 'category':
          aValue = a.category?.category_name || ''
          bValue = b.category?.category_name || ''
          break
        case 'product_type':
          aValue = a.product_type || ''
          bValue = b.product_type || ''
          break
        case 'status':
          aValue = a.status || ''
          bValue = b.status || ''
          break
        case 'created_date':
          aValue = new Date(a.created_date || 0).getTime()
          bValue = new Date(b.created_date || 0).getTime()
          break
        default:
          aValue = a[sortConfig.key] || ''
          bValue = b[sortConfig.key] || ''
      }

      if (typeof aValue === 'string') {
        aValue = aValue.toLowerCase()
        bValue = bValue.toLowerCase()
      }

      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })

    setFilteredProducts(filtered)
  }

  const handleSort = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  // Pagination calculations
  const totalPages = Math.ceil(filteredProducts.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = Math.min(startIndex + itemsPerPage, filteredProducts.length)
  const paginatedProducts = filteredProducts.slice(startIndex, endIndex)

  const handlePageChange = (page) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  const handleJumpToPage = () => {
    const pageNum = parseInt(jumpToPage)
    if (pageNum >= 1 && pageNum <= totalPages) {
      handlePageChange(pageNum)
      setJumpToPage('')
    } else {
      toast.error(t('products.pageMustBeBetween', { total: totalPages }))
    }
  }

  const handleSelectProduct = (productId) => {
    setSelectedProducts((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]
    )
  }

  const handleSelectAll = () => {
    if (selectedProducts.length === paginatedProducts.length) {
      setSelectedProducts([])
    } else {
      setSelectedProducts(paginatedProducts.map((p) => p.id))
    }
  }

  const handleBulkDelete = () => {
    if (selectedProducts.length === 0) {
      toast.error(t('products.noProductsSelected'))
      return
    }
    openConfirm(
      t('products.deleteTitle'),
      `Delete ${selectedProducts.length} selected product${selectedProducts.length !== 1 ? 's' : ''}? This cannot be undone.`,
      async () => {
        closeConfirm()
        try {
          await db.products.bulkDelete(selectedProducts)
          toast.success(t('products.bulkDeleted', { count: selectedProducts.length }))
          db.auditLog
            .log(
              currentUserEmail,
              'product_bulk_deleted',
              `Deleted ${selectedProducts.length} products`
            )
            .catch(() => {})
          setSelectedProducts([])
          queryClient.invalidateQueries({ queryKey: ['products-page'] })
        } catch (error) {
          captureException(error)
          toast.error(t('products.failedDeleteProducts'))
        }
      }
    )
  }

  const handleBulkStatusChange = async (status) => {
    if (selectedProducts.length === 0) {
      toast.error(t('products.noProductsSelected'))
      return
    }

    try {
      await db.products.bulkUpdateStatus(selectedProducts, status)
      toast.success(t('products.bulkUpdatedStatus', { count: selectedProducts.length, status }))
      db.auditLog
        .log(
          currentUserEmail,
          'product_bulk_status_changed',
          `Changed status to "${status}" for ${selectedProducts.length} products`
        )
        .catch(() => {})
      setSelectedProducts([])
      queryClient.invalidateQueries({ queryKey: ['products-page'] })
    } catch (error) {
      captureException(error)
      toast.error(t('products.failedUpdateProducts'))
    }
  }

  /**
   * Exports to xlsx via the shared sheet builder, matching Customers, Leads,
   * Purchasing and RMA Tickets.
   *
   * The CSV this replaced joined each row with `.join(',')` and quoted only
   * `product_description`. Unlike the same bug in those other modules, this one
   * was not latent: 34 of 406 product names contain a comma — the Acer and AOC
   * monitors carry it inside the model string, e.g.
   * "VG240YP6BIP (LCD QV0EE.609 60CM 23.8W,VG240YP6BIP null)". Each of those
   * rows produced 9 fields against an 8-column header, shifting Brand,
   * Category, Type, Status and Warranty one column right. Any catalog export
   * taken before this was wrong for 8% of its rows.
   */
  const handleExport = (rows, scope) => {
    if (!rows.length) {
      toast(t('products.exportEmpty'))
      return
    }
    const headers = [
      t('products.csvSku'),
      t('products.csvName'),
      t('products.csvBrand'),
      t('products.csvCategory'),
      t('products.csvType'),
      t('products.csvStatus'),
      t('products.csvWarranty'),
      t('products.csvDescription'),
    ]
    const aoa = [
      headers,
      ...rows.map((p) => [
        p.sku || '',
        p.product_name || '',
        p.brand?.brand_name || '',
        p.category?.category_name || '',
        p.product_type || '',
        p.status || '',
        p.warranty_months ?? '',
        p.product_description || '',
      ]),
    ]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    headers.forEach((_, ci) => {
      const addr = XLSX.utils.encode_cell({ r: 0, c: ci })
      if (ws[addr]) ws[addr].s = { font: { bold: true } }
    })
    ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}1` }
    ws['!cols'] = [
      { wch: 14 }, { wch: 48 }, { wch: 18 }, { wch: 22 },
      { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 40 },
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Products')
    XLSX.writeFile(wb, `products-${scope}-${new Date().toISOString().slice(0, 10)}.xlsx`)
    toast.success(t('products.exportedProducts', { count: rows.length }))
    db.auditLog
      .log(currentUserEmail, 'products_exported', `Exported ${rows.length} products (${scope}) to xlsx`)
      .catch(() => {})
  }


  const handleDownloadTemplate = () => {
    const csv = [
      [
        'sku',
        'product_name',
        'brand_name',
        'category_name',
        'subcategory_name',
        'product_type',
        'status',
        'warranty_months',
        'description',
        'product_link',
      ].join(','),
      [
        'PRD-001',
        'Sample Product 1',
        'AOC',
        'Monitors',
        'Gaming',
        'hardware',
        'active',
        '12',
        'Sample description',
        'https://example.com',
      ].join(','),
      [
        'PRD-002',
        'Sample Product 2',
        'DAHUA',
        'Cameras',
        'IP Cameras',
        'hardware',
        'active',
        '24',
        'Another sample',
        'https://example.com',
      ].join(','),
    ].join('\n')

    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'products-template.csv'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast.success(t('products.templateDownloaded'))
  }

  const parseCSVLine = (line) => {
    const result = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    result.push(current.trim())
    return result
  }

  const handleBulkUpload = async (file) => {
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '')
      const lines = text.split('\n').filter((line) => line.trim())

      if (lines.length < 2) {
        toast.error(t('products.csvEmpty'))
        return
      }

      const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase())
      const requiredFields = ['sku', 'product_name', 'brand_name']
      const missingFields = requiredFields.filter((f) => !headers.includes(f))

      if (missingFields.length > 0) {
        toast.error(t('products.csvMissingColumns', { columns: missingFields.join(', ') }))
        return
      }

      const productsToImport = []
      const errors = []

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i])
        const row = {}
        headers.forEach((h, idx) => (row[h] = values[idx] || ''))

        if (!row.sku || !row.product_name || !row.brand_name) {
          errors.push(`Row ${i + 1}: Missing required fields`)
          continue
        }

        const brand = brands.find(
          (b) => b.brand_name.toLowerCase() === row.brand_name.toLowerCase()
        )
        if (!brand) {
          errors.push(`Row ${i + 1}: Brand "${row.brand_name}" not found`)
          continue
        }

        const category = categories.find(
          (c) =>
            c.brand_id === brand.id &&
            c.category_name.toLowerCase() === (row.category_name || '').toLowerCase()
        )

        const subcategory =
          row.subcategory_name && category
            ? subcategories.find(
                (s) =>
                  s.category_id === category.id &&
                  s.subcategory_name.toLowerCase() === row.subcategory_name.toLowerCase()
              )
            : null

        const productType = ['hardware', 'software', 'accessory', 'service'].includes(
          (row.product_type || '').toLowerCase()
        )
          ? row.product_type.toLowerCase()
          : 'hardware'

        const status = ['active', 'inactive', 'discontinued'].includes(
          (row.status || '').toLowerCase()
        )
          ? row.status.toLowerCase()
          : 'active'

        productsToImport.push({
          sku: row.sku,
          product_name: row.product_name,
          brand_id: brand.id,
          category_id: category?.id || null,
          subcategory_id: subcategory?.id || null,
          product_type: productType,
          status: status,
          warranty_months: parseInt(row.warranty_months) || 12,
          product_description: row.description || '',
          product_link: row.product_link || '',
          created_by: currentUserEmail,
          updated_by: currentUserEmail,
          created_date: new Date().toISOString(),
          updated_date: new Date().toISOString(),
        })
      }

      if (productsToImport.length === 0) {
        toast.error(t('products.noValidProducts'))
        if (errors.length > 0) captureException(new Error('CSV import errors'), { errors })
        return
      }

      const existingSkus = new Set(products.map((p) => p.sku?.toLowerCase()))
      const newProducts = productsToImport.filter((p) => !existingSkus.has(p.sku?.toLowerCase()))
      const skippedCount = productsToImport.length - newProducts.length

      if (newProducts.length === 0) {
        toast.error(
          `All ${skippedCount} product${skippedCount !== 1 ? 's' : ''} already exist in the system — nothing to import.`
        )
        return
      }

      await db.products.bulkCreate(newProducts)

      if (skippedCount > 0) {
        toast.success(
          `Imported ${newProducts.length} new product${newProducts.length !== 1 ? 's' : ''}. Skipped ${skippedCount} duplicate${skippedCount !== 1 ? 's' : ''}.`
        )
      } else {
        toast.success(
          `Successfully imported ${newProducts.length} product${newProducts.length !== 1 ? 's' : ''}.`
        )
      }
      db.auditLog
        .log(
          currentUserEmail,
          'products_imported',
          `Imported ${newProducts.length} products, skipped ${skippedCount} duplicates`
        )
        .catch(() => {})

      if (errors.length > 0) {
        // The count already reaches the user — unlike the customer importer,
        // which dropped rejections silently until BUG #31. What was missing is
        // *which* rows, which is the part you can act on.
        console.warn(['Product CSV import — rejected rows:', ...errors].join('\n'))
        toast.error(t('products.importRowErrors', { count: errors.length }), { duration: 8000 })
        captureException(new Error('CSV import errors'), { errors })
      }

      setShowBulkUpload(false)
      queryClient.invalidateQueries({ queryKey: ['products-page'] })
    } catch (error) {
      captureException(error)
      toast.error(t('products.failedImport', { error: error.message }))
    }
  }

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

  const handleLogoChange = (e) => {
    const file = e.target.files[0]
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast.error(t('products.errorSelectImage'))
        return
      }
      if (file.size > 2 * 1024 * 1024) {
        toast.error(t('products.brandLogoTooLarge'))
        return
      }
      setLogoFile(file)
      const reader = new FileReader()
      reader.onloadend = () => setLogoPreview(reader.result)
      reader.readAsDataURL(file)
    }
  }

  const handleSaveProduct = async () => {
    const validation = productSchema.safeParse({
      ...productForm,
      warranty_months: productForm.warranty_months ? Number(productForm.warranty_months) : undefined,
    })
    if (!validation.success) {
      toast.error(getFirstError(validation))
      return
    }

    try {
      let imageUrl = productForm.product_image_url

      if (imageFile) {
        const uploaded = await storage.uploadProductImage(imageFile, productForm.sku)
        imageUrl = uploaded.url
      }

      const productData = {
        sku: productForm.sku,
        product_name: productForm.product_name,
        brand_id: productForm.brand_id || null,
        category_id: productForm.category_id || null,
        subcategory_id: productForm.subcategory_id || null,
        product_type: productForm.product_type,
        status: productForm.status,
        // A service never touches inventory, so it keeps the column's default
        // rather than carrying a meaningless mode. Omitting the key also means
        // an edit that only flips a product to 'service' never trips the
        // 20260772 trigger.
        ...(productForm.product_type === 'service'
          ? {}
          : { stock_tracking_mode: productForm.stock_tracking_mode }),
        warranty_months: productForm.warranty_months,
        product_description: productForm.product_description,
        product_link: productForm.product_link,
        product_image_url: imageUrl,
        updated_by: currentUserEmail,
        updated_date: new Date().toISOString(),
      }

      if (editingProduct) {
        await db.products.update(editingProduct.id, productData)
        db.userActivity
          .create(
            currentUserEmail,
            'product_updated',
            `Updated product ${productData.product_name} (${productData.sku})`
          )
          .catch(() => {})
        db.notifications
          .create({
            type: 'product_updated',
            title: 'Product Updated',
            message: `${productData.product_name} (${productData.sku}) was updated`,
            entityType: 'product',
            entityId: editingProduct.id,
            createdBy: currentUserEmail,
            targetRoles: ['admin', 'super_admin'],
            targetEmails: [],
          })
          .catch(() => {})
        toast.success(t('products.successUpdated'))
        db.auditLog
          .log(
            currentUserEmail,
            'product_updated',
            `Updated product ${productData.product_name} (${productData.sku})`
          )
          .catch(() => {})
      } else {
        const newProduct = await db.products.create({
          ...productData,
          created_date: new Date().toISOString(),
          created_by: currentUserEmail,
        })
        db.userActivity
          .create(
            currentUserEmail,
            'product_created',
            `Created product ${productData.product_name} (${productData.sku})`
          )
          .catch(() => {})
        db.notifications
          .create({
            type: 'product_created',
            title: 'New Product Added',
            message: `${productData.product_name} (${productData.sku}) was added to the catalog`,
            entityType: 'product',
            entityId: newProduct?.id,
            createdBy: currentUserEmail,
            targetRoles: ['admin', 'super_admin'],
            targetEmails: [],
          })
          .catch(() => {})
        toast.success(t('products.successAdded'))
        db.auditLog
          .log(
            currentUserEmail,
            'product_created',
            `Created product ${productData.product_name} (${productData.sku})`
          )
          .catch(() => {})
      }

      setShowAddProduct(false)
      resetProductForm()
      queryClient.invalidateQueries({ queryKey: ['products-page'] })
    } catch (error) {
      captureException(error)
      toast.error(t('products.failedSave', { error: error.message }))
    }
  }

  const handleSaveBrand = async () => {
    if (!brandForm.brand_name) {
      toast.error(t('products.brandRequired'))
      return
    }

    try {
      let logoUrl = brandForm.brand_logo_url

      if (logoFile) {
        logoUrl = await storage.uploadBrandLogo(logoFile, brandForm.brand_name)
      }

      const brandData = {
        brand_name: brandForm.brand_name,
        brand_description: brandForm.brand_description,
        status: brandForm.status,
        brand_logo_url: logoUrl,
        contact_person: brandForm.contact_person || null,
        email: brandForm.email || null,
        phone: brandForm.phone || null,
        tax_id: brandForm.tax_id || null,
        payment_terms: brandForm.payment_terms || null,
        created_by: currentUserEmail,
        updated_by: currentUserEmail,
      }

      if (editingBrand) {
        await db.brands.update(editingBrand.id, brandData)
        toast.success(t('products.brandUpdated'))
        db.auditLog
          .log(currentUserEmail, 'brand_updated', `Updated brand ${brandData.brand_name}`)
          .catch(() => {})
      } else {
        await db.brands.create(brandData)
        toast.success(t('products.brandAdded'))
        db.auditLog
          .log(currentUserEmail, 'brand_created', `Created brand ${brandData.brand_name}`)
          .catch(() => {})
      }

      setShowAddBrand(false)
      resetBrandForm()
      queryClient.invalidateQueries({ queryKey: ['products-page'] })
    } catch (error) {
      captureException(error)
      toast.error(t('products.failedSaveBrand', { error: error.message }))
    }
  }

  const handleSaveCategory = async () => {
    if (!categoryForm.brand_id || !categoryForm.category_name) {
      toast.error(t('products.brandCategoryRequired'))
      return
    }

    try {
      const categoryData = {
        brand_id: categoryForm.brand_id || null,
        category_name: categoryForm.category_name,
        category_description: categoryForm.category_description,
        status: categoryForm.status,
        created_by: currentUserEmail,
        updated_by: currentUserEmail,
      }

      if (editingCategory) {
        await db.categories.update(editingCategory.id, categoryData)
        toast.success(t('products.categoryUpdated'))
        db.auditLog
          .log(
            currentUserEmail,
            'category_updated',
            `Updated category ${categoryData.category_name}`
          )
          .catch(() => {})
      } else {
        await db.categories.create(categoryData)
        toast.success(t('products.categoryAdded'))
        db.auditLog
          .log(
            currentUserEmail,
            'category_created',
            `Created category ${categoryData.category_name}`
          )
          .catch(() => {})
      }

      setShowAddCategory(false)
      resetCategoryForm()
      queryClient.invalidateQueries({ queryKey: ['products-page'] })
    } catch (error) {
      captureException(error)
      toast.error(t('products.failedSaveCategory', { error: error.message }))
    }
  }

  const handleDeleteProduct = (product) => {
    openConfirm(
      t('products.deleteTitle'),
      t('products.deleteMsg', { name: product.product_name }),
      async () => {
        closeConfirm()
        try {
          await db.products.delete(product.id)
          db.userActivity
            .create(
              currentUserEmail,
              'product_deleted',
              `Deleted product ${product.product_name} (${product.sku})`
            )
            .catch(() => {})
          db.notifications
            .create({
              type: 'product_deleted',
              title: 'Product Deleted',
              message: `${product.product_name} (${product.sku}) was removed from the catalog`,
              entityType: 'product',
              entityId: product.id,
              createdBy: currentUserEmail,
              targetRoles: ['admin', 'super_admin'],
              targetEmails: [],
            })
            .catch(() => {})
          toast.success(t('products.successDeleted'))
          db.auditLog
            .log(
              currentUserEmail,
              'product_deleted',
              `Deleted product ${product.product_name} (${product.sku})`
            )
            .catch(() => {})
          queryClient.invalidateQueries({ queryKey: ['products-page'] })
        } catch (error) {
          captureException(error)
          toast.error(t('products.errorDeleteProduct'))
        }
      }
    )
  }

  const handleDeleteBrand = (brand) => {
    openConfirm(
      'Delete Brand',
      `Delete brand "${brand.brand_name}"? This will also delete all associated categories and products.`,
      async () => {
        closeConfirm()
        try {
          await db.brands.delete(brand.id)
          toast.success(t('products.brandDeleted'))
          db.auditLog
            .log(currentUserEmail, 'brand_deleted', `Deleted brand ${brand.brand_name}`)
            .catch(() => {})
          setOpenBrandMenu(null)
          queryClient.invalidateQueries({ queryKey: ['products-page'] })
        } catch (error) {
          captureException(error)
          toast.error(t('products.failedDeleteBrand'))
        }
      }
    )
  }

  const handleDeleteCategory = (category) => {
    openConfirm(
      'Delete Category',
      `Delete category "${category.category_name}"? This cannot be undone.`,
      async () => {
        closeConfirm()
        try {
          await db.categories.delete(category.id)
          toast.success(t('products.categoryDeleted'))
          db.auditLog
            .log(currentUserEmail, 'category_deleted', `Deleted category ${category.category_name}`)
            .catch(() => {})
          queryClient.invalidateQueries({ queryKey: ['products-page'] })
        } catch (error) {
          captureException(error)
          toast.error(t('products.failedDeleteCategory'))
        }
      }
    )
  }

  const handleEditProduct = (product) => {
    setEditingProduct(product)
    setProductForm({
      brand_id: product.brand_id || '',
      category_id: product.category_id || '',
      subcategory_id: product.subcategory_id || '',
      sku: product.sku || '',
      product_name: product.product_name || '',
      product_type: product.product_type || 'hardware',
      status: product.status || 'active',
      stock_tracking_mode: product.stock_tracking_mode || 'serialized',
      warranty_months: product.warranty_months || 12,
      product_description: product.product_description || '',
      product_link: product.product_link || '',
      product_image_url: product.product_image_url || null,
    })
    setImagePreview(product.product_image_url)
    setImageFile(null)
    setTrackingModeLocked(false)
    db.products
      .hasStock(product.id)
      .then(setTrackingModeLocked)
      .catch(() => {}) // the DB trigger still enforces it; leave the field usable
    setShowAddProduct(true)
  }

  const handleEditBrand = (brand) => {
    setEditingBrand(brand)
    setBrandForm({
      brand_name: brand.brand_name || '',
      brand_description: brand.brand_description || '',
      status: brand.status || 'active',
      brand_logo_url: brand.brand_logo_url || null,
      contact_person: brand.contact_person || '',
      email: brand.email || '',
      phone: brand.phone || '',
      tax_id: brand.tax_id || '',
      payment_terms: brand.payment_terms || '',
    })
    setLogoPreview(brand.brand_logo_url)
    setLogoFile(null)
    setShowAddBrand(true)
    setOpenBrandMenu(null)
  }

  const handleEditCategory = (category) => {
    setEditingCategory(category)
    setCategoryForm({
      brand_id: category.brand_id || '',
      category_name: category.category_name || '',
      category_description: category.category_description || '',
      status: category.status || 'active',
    })
    setShowAddCategory(true)
  }

  const handleViewProduct = (product) => {
    if (onNavigateToProduct) {
      onNavigateToProduct(product.id)
    }
  }

  const resetProductForm = () => {
    setProductForm({
      brand_id: '',
      category_id: '',
      subcategory_id: '',
      sku: '',
      product_name: '',
      product_type: 'hardware',
      status: 'active',
      stock_tracking_mode: 'serialized',
      warranty_months: 12,
      product_description: '',
      product_link: '',
      product_image_url: null,
    })
    setImageFile(null)
    setImagePreview(null)
    setEditingProduct(null)
    setTrackingModeLocked(false)
  }

  const resetBrandForm = () => {
    setBrandForm({
      brand_name: '',
      brand_description: '',
      status: 'active',
      brand_logo_url: null,
      contact_person: '',
      email: '',
      phone: '',
      tax_id: '',
      payment_terms: '',
    })
    setLogoFile(null)
    setLogoPreview(null)
    setEditingBrand(null)
  }

  const resetCategoryForm = () => {
    setCategoryForm({
      brand_id: '',
      category_name: '',
      category_description: '',
      status: 'active',
    })
    setEditingCategory(null)
  }

  const toggleBrandExpand = (brandId) => {
    setExpandedBrands((prev) => ({ ...prev, [brandId]: !prev[brandId] }))
  }

  const toggleCategoryExpand = (categoryId) => {
    setExpandedCategories((prev) => ({ ...prev, [categoryId]: !prev[categoryId] }))
  }

  const getBrandCategories = (brandId) => {
    return categories.filter((c) => c.brand_id === brandId)
  }

  const getCategoryProducts = (categoryId) => {
    return products.filter((p) => p.category_id === categoryId)
  }

  const getBrandProductCount = (brandId) => {
    return products.filter((p) => p.brand_id === brandId).length
  }

  const getCategoryCount = (brandId) => {
    return categories.filter((c) => c.brand_id === brandId).length
  }

  if (loading) return <PageSkeleton cols={6} />

  return (
    <div className="space-y-6">
      <PageHeader title={t('products.title')} subtitle={t('products.subtitle')} />

      <div className="bg-white dark:bg-[#121823] rounded-xl shadow-sm border border-gray-200 dark:border-[#212a38]">
        <div className="border-b border-gray-200 dark:border-[#212a38]">
          <nav className="flex gap-8 px-6">
            <button
              onClick={() => setActiveTab('products')}
              className={
                'py-4 border-b-2 font-medium transition-colors ' +
                (activeTab === 'products'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:text-[#e8ebf0]')
              }
            >
              {t('products.tabProducts')}
            </button>
            <button
              onClick={() => setActiveTab('hierarchy')}
              className={
                'py-4 border-b-2 font-medium transition-colors ' +
                (activeTab === 'hierarchy'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:text-[#e8ebf0]')
              }
            >
              {t('products.tabHierarchy')}
            </button>
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 'products' && (
            <ProductsListTab
              products={paginatedProducts}
              totalProducts={filteredProducts.length}
              allProducts={products}
              filteredProducts={filteredProducts}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              brands={brands}
              categories={categories}
              filterBrand={filterBrand}
              setFilterBrand={setFilterBrand}
              filterCategory={filterCategory}
              setFilterCategory={setFilterCategory}
              filterStatus={filterStatus}
              setFilterStatus={setFilterStatus}
              selectedProducts={selectedProducts}
              setSelectedProducts={setSelectedProducts}
              handleSelectProduct={handleSelectProduct}
              handleSelectAll={handleSelectAll}
              handleBulkDelete={handleBulkDelete}
              handleBulkStatusChange={handleBulkStatusChange}
              searchRef={searchRef}
              handleExport={handleExport}
              setShowAddProduct={setShowAddProduct}
              setShowBulkUpload={setShowBulkUpload}
              handleEditProduct={handleEditProduct}
              handleDeleteProduct={handleDeleteProduct}
              handleViewProduct={handleViewProduct}
              showAddDropdown={showAddDropdown}
              setShowAddDropdown={setShowAddDropdown}
              openMenuId={openMenuId}
              setOpenMenuId={setOpenMenuId}
              canCreate={canDo('create')}
              canEdit={canDo('edit')}
              canDelete={canDo('delete')}
              canExport={canDo('export')}
              canImport={canDo('import')}
              currentPage={currentPage}
              totalPages={totalPages}
              itemsPerPage={itemsPerPage}
              setItemsPerPage={setItemsPerPage}
              startIndex={startIndex}
              endIndex={endIndex}
              handlePageChange={handlePageChange}
              jumpToPage={jumpToPage}
              setJumpToPage={setJumpToPage}
              handleJumpToPage={handleJumpToPage}
              sortConfig={sortConfig}
              handleSort={handleSort}
            />
          )}

          {activeTab === 'hierarchy' && (
            <HierarchyTab
              brands={brands}
              categories={categories}
              products={products}
              expandedBrands={expandedBrands}
              expandedCategories={expandedCategories}
              toggleBrandExpand={toggleBrandExpand}
              toggleCategoryExpand={toggleCategoryExpand}
              getBrandCategories={getBrandCategories}
              getCategoryProducts={getCategoryProducts}
              getBrandProductCount={getBrandProductCount}
              getCategoryCount={getCategoryCount}
              setShowAddBrand={setShowAddBrand}
              setShowAddCategory={setShowAddCategory}
              handleEditBrand={handleEditBrand}
              handleEditCategory={handleEditCategory}
              handleDeleteBrand={handleDeleteBrand}
              handleDeleteCategory={handleDeleteCategory}
              setCategoryForm={setCategoryForm}
              openBrandMenu={openBrandMenu}
              setOpenBrandMenu={setOpenBrandMenu}
              handleViewProduct={handleViewProduct}
            />
          )}
        </div>
      </div>

      {showAddProduct && (
        <AddProductModal
          productForm={productForm}
          setProductForm={setProductForm}
          brands={brands}
          categories={categories}
          subcategories={subcategories}
          imagePreview={imagePreview}
          handleImageChange={handleImageChange}
          handleSaveProduct={handleSaveProduct}
          trackingModeLocked={trackingModeLocked}
          onClose={() => {
            setShowAddProduct(false)
            resetProductForm()
          }}
          editingProduct={editingProduct}
        />
      )}

      {showAddBrand && (
        <AddBrandModal
          brandForm={brandForm}
          setBrandForm={setBrandForm}
          logoPreview={logoPreview}
          handleLogoChange={handleLogoChange}
          handleSaveBrand={handleSaveBrand}
          onClose={() => {
            setShowAddBrand(false)
            resetBrandForm()
          }}
          editingBrand={editingBrand}
        />
      )}

      {showAddCategory && (
        <AddCategoryModal
          categoryForm={categoryForm}
          setCategoryForm={setCategoryForm}
          brands={brands}
          handleSaveCategory={handleSaveCategory}
          onClose={() => {
            setShowAddCategory(false)
            resetCategoryForm()
          }}
          editingCategory={editingCategory}
        />
      )}

      {showBulkUpload && (
        <BulkUploadModal
          onClose={() => setShowBulkUpload(false)}
          onUpload={handleBulkUpload}
          onDownloadTemplate={handleDownloadTemplate}
        />
      )}

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
