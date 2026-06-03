import React, { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, db, storage } from '../../api/supabaseClient'
import { safeStorage } from '../../lib/safeStorage'
import toast from 'react-hot-toast'
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
    warranty_months: 12,
    product_description: '',
    product_link: '',
    product_image_url: null,
  })

  const [brandForm, setBrandForm] = useState({
    brand_name: '',
    brand_description: '',
    status: 'active',
    brand_logo_url: null,
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
  }, [searchQuery, products, sortConfig])

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
      toast.error(`Page must be between 1 and ${totalPages}`)
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
      toast.error('No products selected')
      return
    }
    openConfirm(
      'Delete Products',
      `Delete ${selectedProducts.length} selected product${selectedProducts.length !== 1 ? 's' : ''}? This cannot be undone.`,
      async () => {
        closeConfirm()
        try {
          await db.products.bulkDelete(selectedProducts)
          toast.success(`Deleted ${selectedProducts.length} products`)
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
          toast.error('Failed to delete products')
        }
      }
    )
  }

  const handleBulkStatusChange = async (status) => {
    if (selectedProducts.length === 0) {
      toast.error('No products selected')
      return
    }

    try {
      await db.products.bulkUpdateStatus(selectedProducts, status)
      toast.success(`Updated ${selectedProducts.length} products to ${status}`)
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
      toast.error('Failed to update products')
    }
  }

  const handleExportProducts = () => {
    const csv = [
      [
        'SKU',
        'Product Name',
        'Brand',
        'Category',
        'Type',
        'Status',
        'Warranty (months)',
        'Description',
      ].join(','),
      ...filteredProducts.map((p) =>
        [
          p.sku || '',
          p.product_name || '',
          p.brand?.brand_name || '',
          p.category?.category_name || '',
          p.product_type || '',
          p.status || '',
          p.warranty_months || '',
          `"${(p.product_description || '').replace(/"/g, '""')}"`,
        ].join(',')
      ),
    ].join('\n')

    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `products-export-${new Date().toISOString().split('T')[0]}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast.success(`Exported ${filteredProducts.length} products`)
    db.auditLog
      .log(
        currentUserEmail,
        'products_exported',
        `Exported ${filteredProducts.length} products to CSV`
      )
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
    toast.success('Template downloaded')
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
        toast.error('CSV file is empty or invalid')
        return
      }

      const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase())
      const requiredFields = ['sku', 'product_name', 'brand_name']
      const missingFields = requiredFields.filter((f) => !headers.includes(f))

      if (missingFields.length > 0) {
        toast.error(`Missing required columns: ${missingFields.join(', ')}`)
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
        toast.error('No valid products to import')
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
        toast.error(`${errors.length} rows had errors. Check console for details.`)
        captureException(new Error('CSV import errors'), { errors })
      }

      setShowBulkUpload(false)
      queryClient.invalidateQueries({ queryKey: ['products-page'] })
    } catch (error) {
      captureException(error)
      toast.error(`Failed to import: ${error.message}`)
    }
  }

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

  const handleLogoChange = (e) => {
    const file = e.target.files[0]
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast.error('Please select an image file')
        return
      }
      if (file.size > 2 * 1024 * 1024) {
        toast.error('Logo must be less than 2MB')
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
        toast.success('Product updated successfully')
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
        toast.success('Product added successfully')
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
      toast.error(`Failed to save product: ${error.message}`)
    }
  }

  const handleSaveBrand = async () => {
    if (!brandForm.brand_name) {
      toast.error('Brand name is required')
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
        created_by: currentUserEmail,
        updated_by: currentUserEmail,
      }

      if (editingBrand) {
        await db.brands.update(editingBrand.id, brandData)
        toast.success('Brand updated successfully')
        db.auditLog
          .log(currentUserEmail, 'brand_updated', `Updated brand ${brandData.brand_name}`)
          .catch(() => {})
      } else {
        await db.brands.create(brandData)
        toast.success('Brand added successfully')
        db.auditLog
          .log(currentUserEmail, 'brand_created', `Created brand ${brandData.brand_name}`)
          .catch(() => {})
      }

      setShowAddBrand(false)
      resetBrandForm()
      queryClient.invalidateQueries({ queryKey: ['products-page'] })
    } catch (error) {
      captureException(error)
      toast.error(`Failed to save brand: ${error.message}`)
    }
  }

  const handleSaveCategory = async () => {
    if (!categoryForm.brand_id || !categoryForm.category_name) {
      toast.error('Brand and category name are required')
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
        toast.success('Category updated successfully')
        db.auditLog
          .log(
            currentUserEmail,
            'category_updated',
            `Updated category ${categoryData.category_name}`
          )
          .catch(() => {})
      } else {
        await db.categories.create(categoryData)
        toast.success('Category added successfully')
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
      toast.error(`Failed to save category: ${error.message}`)
    }
  }

  const handleDeleteProduct = (product) => {
    openConfirm(
      'Delete Product',
      `Delete product "${product.product_name}"? This cannot be undone.`,
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
          toast.success('Product deleted')
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
          toast.error('Failed to delete product')
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
          toast.success('Brand deleted')
          db.auditLog
            .log(currentUserEmail, 'brand_deleted', `Deleted brand ${brand.brand_name}`)
            .catch(() => {})
          setOpenBrandMenu(null)
          queryClient.invalidateQueries({ queryKey: ['products-page'] })
        } catch (error) {
          captureException(error)
          toast.error('Failed to delete brand')
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
          toast.success('Category deleted')
          db.auditLog
            .log(currentUserEmail, 'category_deleted', `Deleted category ${category.category_name}`)
            .catch(() => {})
          queryClient.invalidateQueries({ queryKey: ['products-page'] })
        } catch (error) {
          captureException(error)
          toast.error('Failed to delete category')
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
      warranty_months: product.warranty_months || 12,
      product_description: product.product_description || '',
      product_link: product.product_link || '',
      product_image_url: product.product_image_url || null,
    })
    setImagePreview(product.product_image_url)
    setImageFile(null)
    setShowAddProduct(true)
  }

  const handleEditBrand = (brand) => {
    setEditingBrand(brand)
    setBrandForm({
      brand_name: brand.brand_name || '',
      brand_description: brand.brand_description || '',
      status: brand.status || 'active',
      brand_logo_url: brand.brand_logo_url || null,
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
      warranty_months: 12,
      product_description: '',
      product_link: '',
      product_image_url: null,
    })
    setImageFile(null)
    setImagePreview(null)
    setEditingProduct(null)
  }

  const resetBrandForm = () => {
    setBrandForm({
      brand_name: '',
      brand_description: '',
      status: 'active',
      brand_logo_url: null,
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
      <PageHeader title="Products" subtitle="Manage product catalog and hierarchy" />

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
              Products
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
              Product Hierarchy
            </button>
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 'products' && (
            <ProductsListTab
              products={paginatedProducts}
              totalProducts={filteredProducts.length}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              selectedProducts={selectedProducts}
              handleSelectProduct={handleSelectProduct}
              handleSelectAll={handleSelectAll}
              handleBulkDelete={handleBulkDelete}
              handleBulkStatusChange={handleBulkStatusChange}
              searchRef={searchRef}
              handleExportProducts={handleExportProducts}
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
