import React, { useState, useEffect, useRef } from 'react'
import { supabase, db, storage } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import ConfirmDialog from '../components/ConfirmDialog'
import { PageSkeleton } from '../components/Skeleton'
import { Button, Spinner, PageHeader } from '../components/ui'
import { useURLTab } from '../hooks/useURLTab'

export default function Products({ currentUserRole, currentUserEmail, currentUserPermissions, onNavigateToProduct }) {
  const searchRef = useRef(null)
  const [activeTab, setActiveTab] = useURLTab('tab', 'products')
  const [loading, setLoading] = useState(true)
  
  const [products, setProducts] = useState([])
  const [filteredProducts, setFilteredProducts] = useState([])
  const [productsTotalCount, setProductsTotalCount] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedProducts, setSelectedProducts] = useState([])
  
  // Pagination State
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(() => {
    return parseInt(localStorage.getItem('productsPerPage')) || 25
  })
  const [jumpToPage, setJumpToPage] = useState('')
  
  // Sorting State
  const [sortConfig, setSortConfig] = useState(() => {
    const saved = localStorage.getItem('productsSortConfig')
    return saved ? JSON.parse(saved) : { key: 'created_date', direction: 'desc' }
  })
  
  const [brands, setBrands] = useState([])
  const [categories, setCategories] = useState([])
  const [subcategories, setSubcategories] = useState([])
  const [expandedBrands, setExpandedBrands] = useState({})
  const [expandedCategories, setExpandedCategories] = useState({})
  const [openBrandMenu, setOpenBrandMenu] = useState(null)
  const [openMenuId, setOpenMenuId] = useState(null)
  const [showAddDropdown, setShowAddDropdown] = useState(false)
  
  const [showAddProduct, setShowAddProduct] = useState(false)
  const [showAddBrand, setShowAddBrand] = useState(false)
  const [showAddCategory, setShowAddCategory] = useState(false)
  const [showBulkUpload, setShowBulkUpload] = useState(false)

  const [confirmDialog, setConfirmDialog] = useState({ open: false, title: '', message: '', onConfirm: null })
  const openConfirm = (title, message, onConfirm) => setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog(d => ({ ...d, open: false }))
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
    product_image_url: null
  })
  
  const [brandForm, setBrandForm] = useState({
    brand_name: '',
    brand_description: '',
    status: 'active',
    brand_logo_url: null
  })
  
  const [categoryForm, setCategoryForm] = useState({
    brand_id: '',
    category_name: '',
    category_description: '',
    status: 'active'
  })
  
  const [imageFile, setImageFile] = useState(null)
  const [imagePreview, setImagePreview] = useState(null)
  const [logoFile, setLogoFile] = useState(null)
  const [logoPreview, setLogoPreview] = useState(null)

  const canDo = (action) => {
    if (currentUserRole === 'super_admin' || currentUserRole === 'admin') return true
    return currentUserPermissions?.products?.[action] === true
  }

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    const handler = (e) => { if (!e.target.closest('.action-menu')) setOpenMenuId(null) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    handleSearchAndSort()
  }, [searchQuery, products, sortConfig])

  // Real-time: refresh when products table changes
  useEffect(() => {
    const channel = supabase.channel('products_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => loadData())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // Keyboard shortcuts: / = focus search, N = add product, Esc = close modal
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable
      if (e.key === 'Escape') { setShowAddProduct(false); setShowAddBrand(false); setShowAddCategory(false); return }
      if (typing) return
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); if (canDo('create')) setShowAddProduct(true) }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [showAddProduct, showAddBrand, showAddCategory])

  useEffect(() => {
    localStorage.setItem('productsPerPage', itemsPerPage.toString())
  }, [itemsPerPage])

  useEffect(() => {
    localStorage.setItem('productsSortConfig', JSON.stringify(sortConfig))
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

  const loadData = async () => {
    setLoading(true)
    try {
      const [productsData, brandsData, categoriesData, subcategoriesData] = await Promise.all([
        db.products.list(),
        db.brands.list(),
        db.categories.list(),
        db.subcategories.list()
      ])
      
      db.products.listPaged(0, 1).then(r => setProductsTotalCount(r.count)).catch(() => {})
      setProducts(productsData)
      setBrands(brandsData)
      setCategories(categoriesData)
      setSubcategories(subcategoriesData)
    } catch (error) {
      console.error('Error loading data:', error)
      toast.error('Failed to load products')
    } finally {
      setLoading(false)
    }
  }

  const handleSearchAndSort = () => {
    let filtered = [...products]

    // Apply search
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(product =>
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
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
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
    setSelectedProducts(prev =>
      prev.includes(productId)
        ? prev.filter(id => id !== productId)
        : [...prev, productId]
    )
  }

  const handleSelectAll = () => {
    if (selectedProducts.length === paginatedProducts.length) {
      setSelectedProducts([])
    } else {
      setSelectedProducts(paginatedProducts.map(p => p.id))
    }
  }

  const handleBulkDelete = () => {
    if (selectedProducts.length === 0) { toast.error('No products selected'); return }
    openConfirm(
      'Delete Products',
      `Delete ${selectedProducts.length} selected product${selectedProducts.length !== 1 ? 's' : ''}? This cannot be undone.`,
      async () => {
        closeConfirm()
        try {
          await db.products.bulkDelete(selectedProducts)
          toast.success(`Deleted ${selectedProducts.length} products`)
          db.auditLog.log(currentUserEmail, 'product_bulk_deleted', `Deleted ${selectedProducts.length} products`).catch(() => {})
          setSelectedProducts([])
          loadData()
        } catch (error) {
          console.error('Error deleting products:', error)
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
      db.auditLog.log(currentUserEmail, 'product_bulk_status_changed', `Changed status to "${status}" for ${selectedProducts.length} products`).catch(() => {})
      setSelectedProducts([])
      loadData()
    } catch (error) {
      console.error('Error updating products:', error)
      toast.error('Failed to update products')
    }
  }

  const handleExportProducts = () => {
    const csv = [
      ['SKU', 'Product Name', 'Brand', 'Category', 'Type', 'Status', 'Warranty (months)', 'Description'].join(','),
      ...filteredProducts.map(p => [
        p.sku || '',
        p.product_name || '',
        p.brand?.brand_name || '',
        p.category?.category_name || '',
        p.product_type || '',
        p.status || '',
        p.warranty_months || '',
        `"${(p.product_description || '').replace(/"/g, '""')}"`
      ].join(','))
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
    db.auditLog.log(currentUserEmail, 'products_exported', `Exported ${filteredProducts.length} products to CSV`).catch(() => {})
  }

  const handleDownloadTemplate = () => {
    const csv = [
      ['sku', 'product_name', 'brand_name', 'category_name', 'subcategory_name', 'product_type', 'status', 'warranty_months', 'description', 'product_link'].join(','),
      ['PRD-001', 'Sample Product 1', 'AOC', 'Monitors', 'Gaming', 'hardware', 'active', '12', 'Sample description', 'https://example.com'].join(','),
      ['PRD-002', 'Sample Product 2', 'DAHUA', 'Cameras', 'IP Cameras', 'hardware', 'active', '24', 'Another sample', 'https://example.com'].join(',')
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
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
        else { inQuotes = !inQuotes }
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
      const text = (await file.text()).replace(/^﻿/, '')
      const lines = text.split('\n').filter(line => line.trim())

      if (lines.length < 2) {
        toast.error('CSV file is empty or invalid')
        return
      }

      const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase())
      const requiredFields = ['sku', 'product_name', 'brand_name']
      const missingFields = requiredFields.filter(f => !headers.includes(f))
      
      if (missingFields.length > 0) {
        toast.error(`Missing required columns: ${missingFields.join(', ')}`)
        return
      }

      const productsToImport = []
      const errors = []

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i])
        const row = {}
        headers.forEach((h, idx) => row[h] = values[idx] || '')

        if (!row.sku || !row.product_name || !row.brand_name) {
          errors.push(`Row ${i + 1}: Missing required fields`)
          continue
        }

        const brand = brands.find(b => b.brand_name.toLowerCase() === row.brand_name.toLowerCase())
        if (!brand) {
          errors.push(`Row ${i + 1}: Brand "${row.brand_name}" not found`)
          continue
        }

        const category = categories.find(c => 
          c.brand_id === brand.id && 
          c.category_name.toLowerCase() === (row.category_name || '').toLowerCase()
        )

        const subcategory = row.subcategory_name && category ? subcategories.find(s => 
          s.category_id === category.id && 
          s.subcategory_name.toLowerCase() === row.subcategory_name.toLowerCase()
        ) : null

        const productType = ['hardware', 'software', 'accessory', 'service'].includes((row.product_type || '').toLowerCase()) 
          ? row.product_type.toLowerCase() 
          : 'hardware'

        const status = ['active', 'inactive', 'discontinued'].includes((row.status || '').toLowerCase())
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
          updated_date: new Date().toISOString()
        })
      }

      if (productsToImport.length === 0) {
        toast.error('No valid products to import')
        if (errors.length > 0) console.error('Errors:', errors)
        return
      }

      const existingSkus = new Set(products.map(p => p.sku?.toLowerCase()))
      const newProducts = productsToImport.filter(p => !existingSkus.has(p.sku?.toLowerCase()))
      const skippedCount = productsToImport.length - newProducts.length

      if (newProducts.length === 0) {
        toast.error(`All ${skippedCount} product${skippedCount !== 1 ? 's' : ''} already exist in the system — nothing to import.`)
        return
      }

      await db.products.bulkCreate(newProducts)

      if (skippedCount > 0) {
        toast.success(`Imported ${newProducts.length} new product${newProducts.length !== 1 ? 's' : ''}. Skipped ${skippedCount} duplicate${skippedCount !== 1 ? 's' : ''}.`)
      } else {
        toast.success(`Successfully imported ${newProducts.length} product${newProducts.length !== 1 ? 's' : ''}.`)
      }
      db.auditLog.log(currentUserEmail, 'products_imported', `Imported ${newProducts.length} products, skipped ${skippedCount} duplicates`).catch(() => {})

      if (errors.length > 0) {
        toast.error(`${errors.length} rows had errors. Check console for details.`)
        console.error('Import errors:', errors)
      }

      setShowBulkUpload(false)
      loadData()
    } catch (error) {
      console.error('Bulk upload error:', error)
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
    if (!productForm.sku || !productForm.product_name || !productForm.brand_id) {
      toast.error('Please fill in all required fields')
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
        updated_date: new Date().toISOString()
      }

      if (editingProduct) {
        await db.products.update(editingProduct.id, productData)
        db.userActivity.create(currentUserEmail, 'product_updated', `Updated product ${productData.product_name} (${productData.sku})`).catch(() => {})
        db.notifications.create({
          type: 'product_updated', title: 'Product Updated',
          message: `${productData.product_name} (${productData.sku}) was updated`,
          entityType: 'product', entityId: editingProduct.id,
          createdBy: currentUserEmail, targetRoles: ['admin', 'super_admin'], targetEmails: []
        }).catch(() => {})
        toast.success('Product updated successfully')
        db.auditLog.log(currentUserEmail, 'product_updated', `Updated product ${productData.product_name} (${productData.sku})`).catch(() => {})
      } else {
        const newProduct = await db.products.create({
          ...productData,
          created_date: new Date().toISOString(),
          created_by: currentUserEmail
        })
        db.userActivity.create(currentUserEmail, 'product_created', `Created product ${productData.product_name} (${productData.sku})`).catch(() => {})
        db.notifications.create({
          type: 'product_created', title: 'New Product Added',
          message: `${productData.product_name} (${productData.sku}) was added to the catalog`,
          entityType: 'product', entityId: newProduct?.id,
          createdBy: currentUserEmail, targetRoles: ['admin', 'super_admin'], targetEmails: []
        }).catch(() => {})
        toast.success('Product added successfully')
        db.auditLog.log(currentUserEmail, 'product_created', `Created product ${productData.product_name} (${productData.sku})`).catch(() => {})
      }

      setShowAddProduct(false)
      resetProductForm()
      loadData()
    } catch (error) {
      console.error('Error saving product:', error)
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
        updated_by: currentUserEmail
      }

      if (editingBrand) {
        await db.brands.update(editingBrand.id, brandData)
        toast.success('Brand updated successfully')
        db.auditLog.log(currentUserEmail, 'brand_updated', `Updated brand ${brandData.brand_name}`).catch(() => {})
      } else {
        await db.brands.create(brandData)
        toast.success('Brand added successfully')
        db.auditLog.log(currentUserEmail, 'brand_created', `Created brand ${brandData.brand_name}`).catch(() => {})
      }

      setShowAddBrand(false)
      resetBrandForm()
      loadData()
    } catch (error) {
      console.error('Error saving brand:', error)
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
        updated_by: currentUserEmail
      }

      if (editingCategory) {
        await db.categories.update(editingCategory.id, categoryData)
        toast.success('Category updated successfully')
        db.auditLog.log(currentUserEmail, 'category_updated', `Updated category ${categoryData.category_name}`).catch(() => {})
      } else {
        await db.categories.create(categoryData)
        toast.success('Category added successfully')
        db.auditLog.log(currentUserEmail, 'category_created', `Created category ${categoryData.category_name}`).catch(() => {})
      }

      setShowAddCategory(false)
      resetCategoryForm()
      loadData()
    } catch (error) {
      console.error('Error saving category:', error)
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
          db.userActivity.create(currentUserEmail, 'product_deleted', `Deleted product ${product.product_name} (${product.sku})`).catch(() => {})
          db.notifications.create({
            type: 'product_deleted', title: 'Product Deleted',
            message: `${product.product_name} (${product.sku}) was removed from the catalog`,
            entityType: 'product', entityId: product.id,
            createdBy: currentUserEmail, targetRoles: ['admin', 'super_admin'], targetEmails: []
          }).catch(() => {})
          toast.success('Product deleted')
          db.auditLog.log(currentUserEmail, 'product_deleted', `Deleted product ${product.product_name} (${product.sku})`).catch(() => {})
          loadData()
        } catch (error) {
          console.error('Error deleting product:', error)
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
          db.auditLog.log(currentUserEmail, 'brand_deleted', `Deleted brand ${brand.brand_name}`).catch(() => {})
          setOpenBrandMenu(null)
          loadData()
        } catch (error) {
          console.error('Error deleting brand:', error)
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
          db.auditLog.log(currentUserEmail, 'category_deleted', `Deleted category ${category.category_name}`).catch(() => {})
          loadData()
        } catch (error) {
          console.error('Error deleting category:', error)
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
      product_image_url: product.product_image_url || null
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
      brand_logo_url: brand.brand_logo_url || null
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
      status: category.status || 'active'
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
      product_image_url: null
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
      brand_logo_url: null
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
      status: 'active'
    })
    setEditingCategory(null)
  }

  const toggleBrandExpand = (brandId) => {
    setExpandedBrands(prev => ({ ...prev, [brandId]: !prev[brandId] }))
  }

  const toggleCategoryExpand = (categoryId) => {
    setExpandedCategories(prev => ({ ...prev, [categoryId]: !prev[categoryId] }))
  }

  const getBrandCategories = (brandId) => {
    return categories.filter(c => c.brand_id === brandId)
  }

  const getCategoryProducts = (categoryId) => {
    return products.filter(p => p.category_id === categoryId)
  }

  const getBrandProductCount = (brandId) => {
    return products.filter(p => p.brand_id === brandId).length
  }

  const getCategoryCount = (brandId) => {
    return categories.filter(c => c.brand_id === brandId).length
  }

  if (loading) return <PageSkeleton cols={6} />

  return (
    <div className="space-y-6">
      <PageHeader title="Products" subtitle="Manage product catalog and hierarchy" />

      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="border-b border-gray-200">
          <nav className="flex gap-8 px-6">
            <button
              onClick={() => setActiveTab('products')}
              className={'py-4 border-b-2 font-medium transition-colors ' + (activeTab === 'products' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700')}
            >
              Products
            </button>
            <button
              onClick={() => setActiveTab('hierarchy')}
              className={'py-4 border-b-2 font-medium transition-colors ' + (activeTab === 'hierarchy' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700')}
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
// ============================================
// PRODUCTS LIST TAB COMPONENT WITH PAGINATION & SORTING
// ============================================
function ProductsListTab({
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
  handleSort
}) {
  const SortableHeader = ({ label, sortKey }) => {
    const isActive = sortConfig.key === sortKey
    const direction = isActive ? sortConfig.direction : null

    return (
      <button
        onClick={() => handleSort(sortKey)}
        className="flex items-center gap-1 hover:text-gray-900 transition-colors"
      >
        <span>{label}</span>
        {isActive ? (
          direction === 'asc' ? (
            <svg className="w-3.5 h-3.5 text-indigo-600 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5 text-indigo-600 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          )
        ) : (
          <svg className="w-3.5 h-3.5 text-gray-300 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
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
          <span key={`ellipsis-${idx}`} className="px-3 py-2 text-gray-400">
            ...
          </span>
        )
      }
      return (
        <button
          key={page}
          onClick={() => handlePageChange(page)}
          className={`px-3 py-2 rounded transition-colors ${
            currentPage === page
              ? 'bg-indigo-600 text-white'
              : 'text-gray-700 hover:bg-gray-100'
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
            <svg className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
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
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
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
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
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
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                Add Product
                <svg className={'w-4 h-4 transition-transform ' + (showAddDropdown ? 'rotate-180' : '')} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
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
                    <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
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
                      <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
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

      {/* Cap warning banner (H-4) */}
      {productsTotalCount !== null && productsTotalCount > products.length && (
        <div className="mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm flex items-center gap-2">
          <span>⚠️</span>
          <span>Showing first <strong>{products.length}</strong> of <strong>{productsTotalCount}</strong> products. Use filters or search to find specific records.</span>
        </div>
      )}

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
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-400 uppercase w-10">#</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Image</th>
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
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {products.length === 0 ? (
              <tr>
                <td colSpan="10" className="px-4 py-20 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center">
                      <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                      </svg>
                    </div>
                    <div>
                      <p className="font-semibold text-gray-700">No products found</p>
                      <p className="text-sm text-gray-400 mt-0.5">Add your first product to start managing your catalog</p>
                    </div>
                    {canCreate && (
                      <button onClick={() => setShowAddProduct(true)} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                        Add First Product
                      </button>
                    )}
                  </div>
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
                  <td className="px-3 py-3 text-xs text-gray-400 tabular-nums">{startIndex + idx + 1}</td>
                  <td className="px-4 py-3">
                    {product.product_image_url ? (
                      <img src={product.product_image_url} alt={product.product_name} className="w-12 h-12 object-cover rounded" />
                    ) : (
                      <div className="w-12 h-12 bg-gray-200 rounded flex items-center justify-center">
                        <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
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
                  <td className="px-4 py-3 text-sm text-gray-600">{product.brand?.brand_name || '-'}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{product.category?.category_name || '-'}</td>
                  <td className="px-4 py-3">
                    <span className="capitalize text-sm text-gray-600">{product.product_type}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={'px-2 py-1 text-xs rounded-full ' + (
                      product.status === 'active' ? 'bg-green-100 text-green-800' :
                      product.status === 'inactive' ? 'bg-gray-100 text-gray-800' :
                      'bg-red-100 text-red-800'
                    )}>
                      {product.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 relative action-menu">
                    <button onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === product.id ? null : product.id) }}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors">
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                    </button>
                    {openMenuId === product.id && (
                      <div className="absolute right-0 top-9 z-30 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                        <button onClick={() => { handleViewProduct(product); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                          View
                        </button>
                        {canEdit && (
                          <button onClick={() => { handleEditProduct(product); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5">
                            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                            Edit
                          </button>
                        )}
                        {canDelete && (
                          <button onClick={() => { handleDeleteProduct(product); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2.5">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
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
            <div className="flex items-center gap-1">
              {renderPageNumbers()}
            </div>
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
// ============================================
// HIERARCHY TAB COMPONENT — 3-column explorer
// ============================================
function HierarchyTab({
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
  handleViewProduct
}) {
  const [selectedBrandId, setSelectedBrandId] = useState(null)
  const [selectedCategoryId, setSelectedCategoryId] = useState(null)
  const [brandMenuId, setBrandMenuId] = useState(null)
  const [catMenuId, setCatMenuId] = useState(null)

  const selectedBrand = brands.find(b => b.id === selectedBrandId)
  const selectedCategory = categories.find(c => c.id === selectedCategoryId)
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
    <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
      {status}
    </span>
  )

  return (
    <div className="space-y-5">

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Brands', value: brands.length, color: 'bg-violet-50 text-violet-700', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /> },
          { label: 'Categories', value: categories.length, color: 'bg-blue-50 text-blue-700', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /> },
          { label: 'Products', value: products.length, color: 'bg-emerald-50 text-emerald-700', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /> },
        ].map(({ label, value, color, icon }) => (
          <div key={label} className={`flex items-center gap-3 px-4 py-3 rounded-xl ${color} bg-opacity-60`}>
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${color}`}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">{icon}</svg>
            </div>
            <div>
              <div className="text-2xl font-bold">{value}</div>
              <div className="text-xs font-medium opacity-70">{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 3-column explorer */}
      <div className="grid grid-cols-3 gap-0 border border-gray-200 rounded-xl overflow-hidden" style={{ minHeight: 480 }}>

        {/* ── Column 1: Brands ── */}
        <div className="flex flex-col border-r border-gray-200">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Brands</span>
            <button onClick={() => setShowAddBrand(true)}
              className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 px-2 py-1 rounded-md hover:bg-indigo-50 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              Add
            </button>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {brands.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>
                </div>
                <p className="text-sm text-gray-500">No brands yet</p>
                <button onClick={() => setShowAddBrand(true)} className="text-xs text-indigo-600 hover:underline">Add your first brand</button>
              </div>
            ) : brands.map(brand => (
              <div key={brand.id}
                onClick={() => handleSelectBrand(brand)}
                className={`group flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${selectedBrandId === brand.id ? 'bg-indigo-50 border-l-2 border-indigo-500' : 'hover:bg-gray-50 border-l-2 border-transparent'}`}>
                {brand.brand_logo_url ? (
                  <img src={brand.brand_logo_url} alt={brand.brand_name} className="w-9 h-9 object-contain rounded-lg border border-gray-100 bg-white flex-shrink-0" />
                ) : (
                  <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-100 to-indigo-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-sm font-bold text-indigo-500">{brand.brand_name[0]?.toUpperCase()}</span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-800 truncate">{brand.brand_name}</div>
                  <div className="text-xs text-gray-400">{getCategoryCount(brand.id)} cats · {getBrandProductCount(brand.id)} products</div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {statusPill(brand.status)}
                  <div className="relative" onClick={e => e.stopPropagation()}>
                    <button onClick={() => setBrandMenuId(brandMenuId === brand.id ? null : brand.id)}
                      className="p-1 rounded text-gray-300 hover:text-gray-600 hover:bg-gray-200 transition-colors opacity-0 group-hover:opacity-100">
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                    </button>
                    {brandMenuId === brand.id && (
                      <div className="absolute right-0 top-7 z-30 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                        <button onClick={() => { setCategoryForm(prev => ({ ...prev, brand_id: brand.id })); setShowAddCategory(true); setBrandMenuId(null) }}
                          className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                          Add Category
                        </button>
                        <button onClick={() => { handleEditBrand(brand); setBrandMenuId(null) }}
                          className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                          Edit Brand
                        </button>
                        <div className="border-t border-gray-100 my-0.5" />
                        <button onClick={() => { handleDeleteBrand(brand); setBrandMenuId(null) }}
                          className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          Delete Brand
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Column 2: Categories ── */}
        <div className="flex flex-col border-r border-gray-200">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Categories</span>
              {selectedBrand && <span className="text-xs text-indigo-600 font-medium bg-indigo-50 px-2 py-0.5 rounded-full">{selectedBrand.brand_name}</span>}
            </div>
            {selectedBrandId && (
              <button onClick={() => { setCategoryForm(prev => ({ ...prev, brand_id: selectedBrandId })); setShowAddCategory(true) }}
                className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 px-2 py-1 rounded-md hover:bg-indigo-50 transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                Add
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {!selectedBrandId ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>
                <p className="text-sm text-gray-400">Select a brand to view categories</p>
              </div>
            ) : visibleCategories.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                </div>
                <p className="text-sm text-gray-500">No categories yet</p>
                <button onClick={() => { setCategoryForm(prev => ({ ...prev, brand_id: selectedBrandId })); setShowAddCategory(true) }}
                  className="text-xs text-indigo-600 hover:underline">Add first category</button>
              </div>
            ) : visibleCategories.map(cat => (
              <div key={cat.id}
                onClick={() => handleSelectCategory(cat)}
                className={`group flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${selectedCategoryId === cat.id ? 'bg-indigo-50 border-l-2 border-indigo-500' : 'hover:bg-gray-50 border-l-2 border-transparent'}`}>
                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-100 to-indigo-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-800 truncate">{cat.category_name}</div>
                  <div className="text-xs text-gray-400">{getCategoryProducts(cat.id).length} products</div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {statusPill(cat.status)}
                  <div className="relative" onClick={e => e.stopPropagation()}>
                    <button onClick={() => setCatMenuId(catMenuId === cat.id ? null : cat.id)}
                      className="p-1 rounded text-gray-300 hover:text-gray-600 hover:bg-gray-200 transition-colors opacity-0 group-hover:opacity-100">
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                    </button>
                    {catMenuId === cat.id && (
                      <div className="absolute right-0 top-7 z-30 w-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                        <button onClick={() => { handleEditCategory(cat); setCatMenuId(null) }}
                          className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                          Edit
                        </button>
                        <div className="border-t border-gray-100 my-0.5" />
                        <button onClick={() => { handleDeleteCategory(cat); setCatMenuId(null) }}
                          className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Column 3: Products ── */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Products</span>
              {selectedCategory && <span className="text-xs text-indigo-600 font-medium bg-indigo-50 px-2 py-0.5 rounded-full">{selectedCategory.category_name}</span>}
            </div>
            {selectedCategoryId && <span className="text-xs text-gray-400">{visibleProducts.length} items</span>}
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {!selectedCategoryId ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                <p className="text-sm text-gray-400">Select a category to view products</p>
              </div>
            ) : visibleProducts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                </div>
                <p className="text-sm text-gray-500">No products in this category</p>
              </div>
            ) : visibleProducts.map(product => (
              <div key={product.id}
                onClick={() => handleViewProduct(product)}
                className="group flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors">
                {product.product_image_url ? (
                  <img src={product.product_image_url} alt={product.product_name} className="w-10 h-10 object-cover rounded-lg border border-gray-100 flex-shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-100 to-teal-100 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-800 truncate group-hover:text-indigo-600 transition-colors">{product.product_name}</div>
                  <div className="text-xs text-gray-400 font-mono">{product.sku}</div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${product.status === 'active' ? 'bg-green-100 text-green-700' : product.status === 'discontinued' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
                    {product.status}
                  </span>
                  <svg className="w-4 h-4 text-gray-300 group-hover:text-indigo-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}

// ============================================
// ADD PRODUCT MODAL
// ============================================
function AddProductModal({
  productForm,
  setProductForm,
  brands,
  categories,
  subcategories,
  imagePreview,
  handleImageChange,
  handleSaveProduct,
  onClose,
  editingProduct
}) {
  const filteredCategories = categories.filter(c => c.brand_id === productForm.brand_id)
  const filteredSubcategories = subcategories.filter(s => s.category_id === productForm.category_id)

  return (
    <div className="modal-overlay-bg fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4 overflow-y-auto overscroll-contain">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl my-8">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">
              {editingProduct ? 'Edit Product' : 'Add New Product'}
            </h2>
            <p className="text-xs text-gray-400 mt-0.5"><span className="text-red-500">*</span> Required fields</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
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
              onChange={(e) => setProductForm({ ...productForm, brand_id: e.target.value, category_id: '', subcategory_id: '' })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              required
            >
              <option value="">Select Brand</option>
              {brands.map(brand => (
                <option key={brand.id} value={brand.id}>{brand.brand_name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Category</label>
            <select
              value={productForm.category_id}
              onChange={(e) => setProductForm({ ...productForm, category_id: e.target.value, subcategory_id: '' })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              disabled={!productForm.brand_id}
            >
              <option value="">Select Category</option>
              {filteredCategories.map(category => (
                <option key={category.id} value={category.id}>{category.category_name}</option>
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
              {filteredSubcategories.map(subcategory => (
                <option key={subcategory.id} value={subcategory.id}>{subcategory.subcategory_name}</option>
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
            <label className="block text-sm font-medium text-gray-700 mb-2">Warranty (months)</label>
            <input
              type="number"
              value={productForm.warranty_months}
              onChange={(e) => setProductForm({ ...productForm, warranty_months: parseInt(e.target.value) || 0 })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              min="0"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
            <textarea
              value={productForm.product_description}
              onChange={(e) => setProductForm({ ...productForm, product_description: e.target.value })}
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
                <img src={imagePreview} alt="Preview" className="w-32 h-32 object-cover rounded border" />
                <div className="flex flex-col gap-2">
                  <label className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 cursor-pointer text-center">
                    Change Photo
                    <input type="file" accept="image/*" onChange={handleImageChange} className="hidden" />
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
                <svg className="w-12 h-12 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-gray-600 mb-2">Click to upload product photo</p>
                <p className="text-sm text-gray-500">PNG, JPG up to 5MB</p>
                <input type="file" accept="image/*" onChange={handleImageChange} className="hidden" />
              </label>
            )}
          </div>
        </div>

        <div className="flex gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>Cancel</Button>
          <Button className="flex-1 justify-center" onClick={handleSaveProduct}>
            {editingProduct ? 'Update Product' : 'Add Product'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================
// ADD BRAND MODAL
// ============================================
function AddBrandModal({
  brandForm,
  setBrandForm,
  logoPreview,
  handleLogoChange,
  handleSaveBrand,
  onClose,
  editingBrand
}) {
  return (
    <div className="modal-overlay-bg fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4 overscroll-contain">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">
            {editingBrand ? 'Edit Brand' : 'Add New Brand'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
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
                <img src={logoPreview} alt="Logo preview" className="w-24 h-24 object-contain rounded border" />
                <div className="flex flex-col gap-2">
                  <label className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 cursor-pointer text-center">
                    Change Logo
                    <input type="file" accept="image/*" onChange={handleLogoChange} className="hidden" />
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
                <svg className="w-10 h-10 text-gray-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-gray-600 mb-2">Click to upload logo</p>
                <p className="text-sm text-gray-500">PNG, JPG up to 2MB</p>
                <input type="file" accept="image/*" onChange={handleLogoChange} className="hidden" />
              </label>
            )}
          </div>
        </div>

        <div className="flex gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>Cancel</Button>
          <Button className="flex-1 justify-center" onClick={handleSaveBrand}>
            {editingBrand ? 'Update Brand' : 'Add Brand'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================
// ADD CATEGORY MODAL
// ============================================
function AddCategoryModal({
  categoryForm,
  setCategoryForm,
  brands,
  handleSaveCategory,
  onClose,
  editingCategory
}) {
  return (
    <div className="modal-overlay-bg fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4 overscroll-contain">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">
            {editingCategory ? 'Edit Category' : 'Add New Category'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
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
              {brands.map(brand => (
                <option key={brand.id} value={brand.id}>{brand.brand_name}</option>
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
              onChange={(e) => setCategoryForm({ ...categoryForm, category_description: e.target.value })}
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
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>Cancel</Button>
          <Button className="flex-1 justify-center" onClick={handleSaveCategory}>
            {editingCategory ? 'Update Category' : 'Add Category'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================
// BULK UPLOAD MODAL
// ============================================
function BulkUploadModal({ onClose, onUpload, onDownloadTemplate }) {
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
    <div className="modal-overlay-bg fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4 overscroll-contain">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">Bulk Upload Products</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="font-medium text-blue-900 mb-2">📋 Instructions:</h3>
            <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
              <li>Download the CSV template first</li>
              <li>Fill in your product data following the template format</li>
              <li>Required fields: <strong>sku, product_name, brand_name</strong></li>
              <li>Brand must already exist in the system</li>
              <li>Optional fields: category_name, subcategory_name, product_type, status, warranty_months, description, product_link</li>
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
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Download CSV Template
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Upload CSV File</label>
            <label className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-indigo-500 transition-colors block">
              {file ? (
                <div className="space-y-2">
                  <svg className="w-12 h-12 text-green-500 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="font-medium text-gray-900">{file.name}</p>
                  <p className="text-sm text-gray-500">{(file.size / 1024).toFixed(2)} KB</p>
                  <p className="text-xs text-indigo-600">Click to change file</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <svg className="w-12 h-12 text-gray-400 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
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
              ⚠️ Make sure your brands exist in the system before uploading. Categories and subcategories will be matched if they exist.
            </div>
          )}
        </div>

        <div className="flex gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>Cancel</Button>
          <Button className="flex-1 justify-center" onClick={handleUpload} disabled={!file} loading={uploading}>
            {!uploading && (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {uploading ? 'Uploading...' : 'Upload Products'}
          </Button>
        </div>
      </div>
    </div>
  )
}