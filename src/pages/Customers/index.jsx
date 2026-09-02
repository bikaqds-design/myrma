import React, { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, db, storage } from '../../api/supabaseClient'
import { safeStorage } from '../../lib/safeStorage'
import toast from 'react-hot-toast'
import * as XLSX from 'xlsx'
import ExportMenu from '../../components/ExportMenu'
import ConfirmDialog from '../../components/ConfirmDialog'
import { PageSkeleton } from '../../components/Skeleton'
import { PageHeader } from '../../components/ui'
import { useTranslation } from 'react-i18next'
import EmptyState from '../../components/EmptyState'
import { customerSchema, getFirstError } from '../../lib/schemas'
import { ROLES } from '../../lib/constants'
import { captureException } from '../../lib/sentry'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { EMPTY_FORM } from './_constants'
import { AddCustomerModal, BulkUploadCustomersModal } from './_modals'

const generateCustomerCode = () => `CB-${Math.floor(10000000 + Math.random() * 90000000)}`

export default function Customers({
  currentUserRole,
  currentUserEmail,
  currentUserPermissions,
  onNavigateToCustomer,
}) {
  const { t } = useTranslation()
  const searchRef = useRef(null)
  const queryClient = useQueryClient()

  // P-1: TanStack Query — cached fetch; returning to this page shows stale data instantly
  // `= EMPTY_ARRAY`, not `= []`: `customers` is a dependency of the filter effect
  // below, and a fresh `[]` each render looped it until the data landed.
  const { data: customers = EMPTY_ARRAY, isLoading: loading } = useQuery({
    queryKey: ['customers'],
    queryFn: () => db.customers.list(),
    staleTime: 60_000,
  })
  const { data: usersList = EMPTY_ARRAY } = useQuery({
    queryKey: ['users'],
    queryFn: () => db.userRoles.directory(),
    staleTime: 5 * 60_000,
  })
  const { data: customersTotalCount = null } = useQuery({
    queryKey: ['customers-count'],
    queryFn: async () => {
      const r = await db.customers.listPaged(0, 1)
      return r.count
    },
    staleTime: 60_000,
  })

  const [filteredCustomers, setFilteredCustomers] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCustomers, setSelectedCustomers] = useState([])
  const [showAddCustomer, setShowAddCustomer] = useState(false)
  const [editingCustomer, setEditingCustomer] = useState(null)
  const [openMenuId, setOpenMenuId] = useState(null)
  const [filterStatus, setFilterStatus] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterCompany, setFilterCompany] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  // usersList now comes from useQuery above
  const [customerForm, setCustomerForm] = useState(EMPTY_FORM)
  const [pendingFiles, setPendingFiles] = useState([])
  const [showBulkUpload, setShowBulkUpload] = useState(false)
  const [showAddDropdown, setShowAddDropdown] = useState(false)

  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(
    () => safeStorage.get('customersPerPage', 25)
  )
  const [jumpToPage, setJumpToPage] = useState('')

  // Sorting
  const [sortConfig, setSortConfig] = useState(() =>
    safeStorage.get('customersSortConfig', { key: 'created_date', direction: 'desc' })
  )

  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    message: '',
    onConfirm: null,
  })
  const openConfirm = (title, message, onConfirm) =>
    setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog((d) => ({ ...d, open: false }))

  /**
   * How many RMA tickets these customers own.
   *
   * Deleting a customer used to take their tickets with them — units, comments,
   * activity and all — while the confirmation said only "this action cannot be
   * undone". Migration 20260774 changed that: rma_tickets.customer_id is now
   * ON DELETE RESTRICT, matching the sales documents, so the database refuses
   * instead of cascading.
   *
   * The count is therefore no longer a warning about what will be destroyed but
   * a check for what will be refused, asked before the dialog opens so the user
   * gets the reason rather than a confirm-then-fail. A failed count returns
   * null, which reads as "no known blocker" and lets the attempt proceed — the
   * database is the real guard, and the catch surfaces its message.
   */
  const countLinkedTickets = async (customerIds) => {
    try {
      const { count, error } = await supabase
        .from('rma_tickets')
        .select('id', { count: 'exact', head: true })
        .in('customer_id', customerIds)
      if (error) throw error
      return count ?? 0
    } catch {
      return null
    }
  }

  /** Companies are known by their company name; only a B2C walk-in is not. */
  const customerLabel = (c) => c.company_name || c.contact_person || t('common.unknown')

  const canDo = (action) => {
    if (currentUserRole === ROLES.SUPER_ADMIN || currentUserRole === ROLES.ADMIN) return true
    return currentUserPermissions?.customers?.[action] === true
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
  }, [searchQuery, customers, sortConfig, filterStatus, filterType, filterCompany])
  useEffect(() => {
    safeStorage.set('customersPerPage', itemsPerPage)
  }, [itemsPerPage])
  useEffect(() => {
    safeStorage.set('customersSortConfig', sortConfig)
  }, [sortConfig])
  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, itemsPerPage, filterStatus, filterType, filterCompany])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showAddDropdown && !e.target.closest('.add-customer-dropdown')) setShowAddDropdown(false)
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [showAddDropdown])

  // Real-time: invalidate query cache when customers table changes
  useEffect(() => {
    const channel = supabase
      .channel('customers_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, () => {
        queryClient.invalidateQueries({ queryKey: ['customers'] })
        queryClient.invalidateQueries({ queryKey: ['customers-count'] })
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])

  // Keyboard shortcuts: / = focus search, N = add customer, Esc = close modal
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable
      if (e.key === 'Escape') {
        setShowAddCustomer(false)
        setEditingCustomer(null)
        return
      }
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        if (canDo('create')) setShowAddCustomer(true)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAddCustomer])

  const handleSearchAndSort = () => {
    let filtered = [...customers]
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter(
        (c) =>
          c.contact_person?.toLowerCase().includes(q) ||
          c.company_name?.toLowerCase().includes(q) ||
          c.email?.toLowerCase().includes(q) ||
          c.mobile?.toLowerCase().includes(q) ||
          c.customer_code?.toLowerCase().includes(q) ||
          c.landline?.toLowerCase().includes(q)
      )
    }
    if (filterStatus) filtered = filtered.filter((c) => c.customer_status === filterStatus)
    if (filterType) filtered = filtered.filter((c) => c.customer_type === filterType)
    if (filterCompany) {
      const q = filterCompany.toLowerCase()
      filtered = filtered.filter(
        (c) =>
          c.company_name?.toLowerCase().includes(q) || c.contact_person?.toLowerCase().includes(q)
      )
    }

    filtered.sort((a, b) => {
      let av, bv
      if (sortConfig.key === 'contact_person') {
        av = a.contact_person || ''
        bv = b.contact_person || ''
      } else if (sortConfig.key === 'company_name') {
        av = a.company_name || ''
        bv = b.company_name || ''
      } else if (sortConfig.key === 'created_date') {
        av = new Date(a.created_date || 0).getTime()
        bv = new Date(b.created_date || 0).getTime()
      } else {
        av = a[sortConfig.key] || ''
        bv = b[sortConfig.key] || ''
      }
      if (typeof av === 'string') {
        av = av.toLowerCase()
        bv = bv.toLowerCase()
      }
      if (av < bv) return sortConfig.direction === 'asc' ? -1 : 1
      if (av > bv) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })
    setFilteredCustomers(filtered)
  }

  const handleSort = (key) =>
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))

  const totalPages = Math.ceil(filteredCustomers.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = Math.min(startIndex + itemsPerPage, filteredCustomers.length)
  const paginatedCustomers = filteredCustomers.slice(startIndex, endIndex)

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
    } else toast.error(t('customers.pageMustBeBetween', { total: totalPages }))
  }

  const handleSelectCustomer = (id) =>
    setSelectedCustomers((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    )
  const handleSelectAll = () =>
    setSelectedCustomers(
      selectedCustomers.length === paginatedCustomers.length
        ? []
        : paginatedCustomers.map((c) => c.id)
    )

  const handleBulkDelete = async () => {
    // delete_customers_cascade is all-or-nothing: one selected customer with a
    // ticket refuses the whole batch. Better to say so up front than to let the
    // user confirm a delete of 25 and have none of them go.
    const ticketCount = await countLinkedTickets(selectedCustomers)
    if (ticketCount) {
      toast.error(
        t('customers.bulkDeleteBlockedByTickets', {
          count: selectedCustomers.length,
          tickets: ticketCount,
        }),
        { duration: 8000 }
      )
      return
    }
    openConfirm(
      t('customers.deleteCustomersTitle'),
      t('customers.deleteCustomersConfirm', { count: selectedCustomers.length }),
      async () => {
        closeConfirm()
        try {
          await db.customers.bulkDelete(selectedCustomers)
          toast.success(t('customers.bulkDeletedCustomers', { count: selectedCustomers.length }))
          db.auditLog
            .log(
              currentUserEmail,
              'customer_bulk_deleted',
              `Deleted ${selectedCustomers.length} customers`
            )
            .catch(() => {})
          setSelectedCustomers([])
          queryClient.invalidateQueries({ queryKey: ['customers'] })
          queryClient.invalidateQueries({ queryKey: ['customers-count'] })
        } catch (err) {
          const guarded = err?.code === 'P0001' || /RMA ticket/i.test(err?.message || '')
          toast.error(guarded ? err.message : t('customers.failedDeleteCustomers'), {
            duration: guarded ? 8000 : 4000,
          })
        }
      }
    )
  }

  const handleBulkStatusChange = async (status) => {
    try {
      await db.customers.bulkUpdateStatus(selectedCustomers, status)
      toast.success(t('customers.bulkUpdatedCustomers', { count: selectedCustomers.length }))
      db.auditLog
        .log(
          currentUserEmail,
          'customer_bulk_status_changed',
          `Changed status to "${status}" for ${selectedCustomers.length} customers`
        )
        .catch(() => {})
      setSelectedCustomers([])
      queryClient.invalidateQueries({ queryKey: ['customers'] })
    } catch {
      toast.error(t('customers.failedUpdateStatus'))
    }
  }

  const handleSaveCustomer = async () => {
    // F-1: zod schema validation — single source of truth for field rules
    const validation = customerSchema.safeParse(customerForm)
    if (!validation.success) {
      toast.error(getFirstError(validation))
      return
    }

    // Upload pending files
    const uploadedAttachments = []
    if (pendingFiles.length > 0) {
      const folderId = editingCustomer?.id?.toString() || `new_${Date.now()}`
      for (const file of pendingFiles) {
        try {
          const result = await storage.uploadCustomerAttachment(file, folderId)
          uploadedAttachments.push(result)
        } catch (err) {
          toast.error(t('customers.failedUploadFile', { name: file.name, error: err.message }))
          return
        }
      }
    }
    const allAttachments = [...(customerForm.attachments || []), ...uploadedAttachments]

    const payload = {
      customer_type: customerForm.customer_type,
      customer_status: customerForm.customer_status,
      company_name: customerForm.company_name || null,
      contact_person: customerForm.contact_person,
      account_manager: customerForm.account_manager || null,
      mobile: customerForm.mobile,
      landline: customerForm.landline || null,
      email: customerForm.email || null,
      // NULL means "use the system default country", which is almost every
      // record — so nothing had to be backfilled when the column was added.
      country_code: customerForm.country_code || null,
      address: customerForm.address || null,
      cr_number: customerForm.cr_number || null,
      tax_id: customerForm.tax_id || null,
      notes: customerForm.notes || null,
      attachments: allAttachments,
      updated_by: currentUserEmail,
      updated_date: new Date().toISOString(),
    }

    // UX-6 optimistic update: reflect the edit in the table immediately (edits only — creates need a server-generated ID)
    let previousCustomers = null
    if (editingCustomer) {
      previousCustomers = queryClient.getQueryData(['customers'])
      queryClient.setQueryData(
        ['customers'],
        (old) => old?.map((c) => (c.id === editingCustomer.id ? { ...c, ...payload } : c)) ?? []
      )
    }

    try {
      if (editingCustomer) {
        await db.customers.update(editingCustomer.id, payload)
        db.userActivity
          .create(
            currentUserEmail,
            'customer_updated',
            `Updated customer ${payload.contact_person}${payload.company_name ? ` (${payload.company_name})` : ''}`
          )
          .catch(() => {})
        db.notifications
          .create({
            type: 'customer_updated',
            title: 'Customer Updated',
            message: `${payload.contact_person}${payload.company_name ? ` (${payload.company_name})` : ''} was updated`,
            entityType: 'customer',
            entityId: editingCustomer.id,
            createdBy: currentUserEmail,
            targetRoles: ['admin', 'super_admin'],
            targetEmails: [],
          })
          .catch(() => {})
        toast.success(t('customers.customerUpdated'))
        db.auditLog
          .log(
            currentUserEmail,
            'customer_updated',
            `Updated customer ${payload.contact_person}${payload.company_name ? ` (${payload.company_name})` : ''}`
          )
          .catch(() => {})
      } else {
        const newCustomer = await db.customers.create({
          ...payload,
          customer_code: generateCustomerCode(),
          created_by: currentUserEmail,
          created_date: new Date().toISOString(),
        })
        db.userActivity
          .create(
            currentUserEmail,
            'customer_created',
            `Created customer ${payload.contact_person}${payload.company_name ? ` (${payload.company_name})` : ''}`
          )
          .catch(() => {})
        db.notifications
          .create({
            type: 'customer_created',
            title: 'New Customer Added',
            message: `${payload.contact_person}${payload.company_name ? ` (${payload.company_name})` : ''} was added as a ${payload.customer_type} customer`,
            entityType: 'customer',
            entityId: newCustomer?.id,
            createdBy: currentUserEmail,
            targetRoles: ['admin', 'super_admin'],
            targetEmails: [],
          })
          .catch(() => {})
        toast.success(t('customers.customerCreated'))
        db.auditLog
          .log(
            currentUserEmail,
            'customer_created',
            `Created customer ${payload.contact_person}${payload.company_name ? ` (${payload.company_name})` : ''}`
          )
          .catch(() => {})
      }
      setShowAddCustomer(false)
      resetForm()
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      queryClient.invalidateQueries({ queryKey: ['customers-count'] })
    } catch (error) {
      if (previousCustomers !== null) queryClient.setQueryData(['customers'], previousCustomers) // rollback
      toast.error(t('customers.failedSave', { error: error.message }))
    }
  }

  const handleEditCustomer = (customer) => {
    setEditingCustomer(customer)
    setCustomerForm({
      customer_type: customer.customer_type || 'B2B',
      customer_status: customer.customer_status || 'Active',
      company_name: customer.company_name || '',
      contact_person: customer.contact_person || '',
      account_manager: customer.account_manager || '',
      mobile: customer.mobile || '',
      landline: customer.landline || '',
      email: customer.email || '',
      country_code: customer.country_code || '',
      address: customer.address || '',
      cr_number: customer.cr_number || '',
      tax_id: customer.tax_id || '',
      notes: customer.notes || '',
      attachments: customer.attachments || [],
    })
    setPendingFiles([])
    setShowAddCustomer(true)
  }

  const handleDeleteCustomer = async (customer) => {
    const ticketCount = await countLinkedTickets([customer.id])
    // Since 20260774 the database refuses this outright rather than cascading,
    // so there is nothing to confirm — asking "are you sure?" about an action
    // that cannot happen just invites the user to click through to an error.
    // Say why, and what would unblock it.
    if (ticketCount) {
      toast.error(
        t('customers.deleteBlockedByTickets', {
          name: customerLabel(customer),
          count: ticketCount,
        }),
        { duration: 8000 }
      )
      return
    }
    openConfirm(
      t('customers.deleteCustomerTitle'),
      t('customers.deleteCustomerConfirm', { name: customerLabel(customer) }),
      async () => {
        closeConfirm()
        // UX-6 optimistic: remove from list immediately; rollback if server call fails
        const previousCustomers = queryClient.getQueryData(['customers'])
        queryClient.setQueryData(
          ['customers'],
          (old) => old?.filter((c) => c.id !== customer.id) ?? []
        )
        try {
          await db.customers.delete(customer.id)
          db.userActivity
            .create(
              currentUserEmail,
              'customer_deleted',
              `Deleted customer ${customer.contact_person}${customer.company_name ? ` (${customer.company_name})` : ''}`
            )
            .catch(() => {})
          db.notifications
            .create({
              type: 'customer_deleted',
              title: 'Customer Deleted',
              message: `${customer.contact_person}${customer.company_name ? ` (${customer.company_name})` : ''} was removed`,
              entityType: 'customer',
              entityId: customer.id,
              createdBy: currentUserEmail,
              targetRoles: ['admin', 'super_admin'],
              targetEmails: [],
            })
            .catch(() => {})
          toast.success(t('customers.customerDeleted'))
          db.auditLog
            .log(
              currentUserEmail,
              'customer_deleted',
              `Deleted customer ${customer.contact_person}${customer.company_name ? ` (${customer.company_name})` : ''}`
            )
            .catch(() => {})
          queryClient.invalidateQueries({ queryKey: ['customers'] })
          queryClient.invalidateQueries({ queryKey: ['customers-count'] })
        } catch (err) {
          queryClient.setQueryData(['customers'], previousCustomers) // rollback on error
          // The guard raises P0001 with a message that names the customer and
          // the count and says what to do about it. Replacing that with a flat
          // "failed to delete" throws away the only useful part.
          const guarded = err?.code === 'P0001' || /RMA ticket/i.test(err?.message || '')
          toast.error(guarded ? err.message : t('customers.failedDeleteCustomer'), {
            duration: guarded ? 8000 : 4000,
          })
        }
      }
    )
  }

  const resetForm = () => {
    setCustomerForm(EMPTY_FORM)
    setEditingCustomer(null)
    setPendingFiles([])
  }

  /**
   * Exports to xlsx via the shared sheet builder, matching Leads, Purchasing and
   * RMA Tickets.
   *
   * This replaced a hand-rolled CSV that joined each row with `.join(',')`. Only
   * `address` was quoted — someone hit the comma problem on the one field where
   * commas are unavoidable and patched that field rather than the mechanism, so
   * a company named "Acme, Ltd" still shifted every column after it. Verified
   * before changing: renaming one customer to
   * 'Metra Computer Group, Egypt "MCG"' produced 12 fields against an 11-column
   * header. No customer name in the 888 rows contains a comma today, which is
   * why it had gone unseen.
   */
  const handleExport = (rows, scope) => {
    if (!rows.length) {
      toast(t('customers.exportEmpty'))
      return
    }
    const headers = [
      t('customers.csvCode'),
      t('customers.csvType'),
      t('customers.csvStatus'),
      t('customers.csvCompany'),
      t('customers.csvContactPerson'),
      t('customers.csvMobile'),
      t('customers.csvLandline'),
      t('customers.csvEmail'),
      t('customers.csvAddress'),
      t('customers.csvAccountManager'),
      t('customers.csvCreated'),
    ]
    const aoa = [
      headers,
      ...rows.map((c) => [
        c.customer_code || '',
        c.customer_type || '',
        c.customer_status || '',
        c.company_name || '',
        c.contact_person || '',
        c.mobile || '',
        c.landline || '',
        c.email || '',
        c.address || '',
        c.account_manager || '',
        c.created_date ? new Date(c.created_date).toLocaleDateString() : '',
      ]),
    ]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    headers.forEach((_, ci) => {
      const addr = XLSX.utils.encode_cell({ r: 0, c: ci })
      if (ws[addr]) ws[addr].s = { font: { bold: true } }
    })
    ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}1` }
    ws['!cols'] = [
      { wch: 16 }, { wch: 8 }, { wch: 10 }, { wch: 30 }, { wch: 24 },
      { wch: 16 }, { wch: 16 }, { wch: 28 }, { wch: 40 }, { wch: 22 }, { wch: 14 },
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Customers')
    XLSX.writeFile(wb, `customers-${scope}-${new Date().toISOString().slice(0, 10)}.xlsx`)
    toast.success(t('customers.exportedCustomers', { count: rows.length }))
    db.auditLog
      .log(currentUserEmail, 'customers_exported', `Exported ${rows.length} customers (${scope}) to xlsx`)
      .catch(() => {})
  }


  const handleDownloadTemplate = () => {
    const csv = [
      [
        'customer_type',
        'customer_status',
        'company_name',
        'contact_person',
        'account_manager',
        'mobile',
        'landline',
        'email',
        'address',
        'cr_number',
        'tax_id',
        'notes',
      ].join(','),
      [
        'B2B',
        'Active',
        'Maximum Hardware',
        'Hany Tolba',
        '',
        '01000121589',
        '0223456789',
        'hany@maximum.com',
        '5 Nasr St Cairo',
        'CR-12345',
        'TAX-67890',
        '',
      ].join(','),
      [
        'B2C',
        'Active',
        '',
        'Ahmed Saeed',
        '',
        '01012345678',
        '',
        'ahmed@gmail.com',
        '',
        '',
        '',
        '',
      ].join(','),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'customers-template.csv'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.success(t('customers.templateDownloaded'))
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

  const handleBulkUploadCustomers = async (file) => {
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '')
      const lines = text.split('\n').filter((line) => line.trim())
      if (lines.length < 2) {
        toast.error(t('customers.csvEmpty'))
        return
      }

      const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase())
      const requiredColumns = ['company_name', 'contact_person']
      const missing = requiredColumns.filter((f) => !headers.includes(f))
      if (missing.length > 0) {
        toast.error(t('customers.csvMissingColumns', { columns: missing.join(', ') }))
        return
      }

      const existingMobiles = new Set(
        customers.map((c) => c.mobile?.trim().toLowerCase()).filter(Boolean)
      )
      const existingCompanies = new Set(
        customers.map((c) => c.company_name?.trim().toLowerCase()).filter(Boolean)
      )
      const existingContacts = new Set(
        customers.map((c) => c.contact_person?.trim().toLowerCase()).filter(Boolean)
      )

      const toImport = []
      const errors = []
      let skippedCount = 0

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i])
        const row = {}
        headers.forEach((h, idx) => {
          row[h] = values[idx] || ''
        })

        const type = ['B2B', 'B2C'].includes((row.customer_type || '').toUpperCase())
          ? row.customer_type.toUpperCase()
          : 'B2C'

        if (type === 'B2B' && !row.company_name) {
          errors.push(`Row ${i + 1}: company_name is required for B2B`)
          continue
        }
        if (type === 'B2C' && !row.contact_person) {
          errors.push(`Row ${i + 1}: contact_person is required for B2C`)
          continue
        }

        const mobile = row.mobile?.trim().toLowerCase()
        const company = row.company_name?.trim().toLowerCase()
        const contact = row.contact_person?.trim().toLowerCase()

        if (mobile && existingMobiles.has(mobile)) {
          skippedCount++
          continue
        }
        if (!mobile && type === 'B2B' && company && existingCompanies.has(company)) {
          skippedCount++
          continue
        }
        if (!mobile && type === 'B2C' && contact && existingContacts.has(contact)) {
          skippedCount++
          continue
        }

        const status = ['Active', 'Inactive'].includes(row.customer_status)
          ? row.customer_status
          : 'Active'
        toImport.push({
          customer_type: type,
          customer_status: status,
          company_name: row.company_name || null,
          contact_person: row.contact_person || null,
          account_manager: row.account_manager || null,
          mobile: row.mobile || null,
          landline: row.landline || null,
          email: row.email || null,
          address: row.address || null,
          cr_number: row.cr_number || null,
          tax_id: row.tax_id || null,
          notes: row.notes || null,
          customer_code: generateCustomerCode(),
          created_by: currentUserEmail,
          updated_by: currentUserEmail,
          created_date: new Date().toISOString(),
          updated_date: new Date().toISOString(),
        })
      }

      if (toImport.length === 0) {
        if (skippedCount > 0) {
          toast.error(t('customers.allExistSkipped', { count: skippedCount }))
        } else {
          toast.error(t('customers.noValidCustomers'))
          if (errors.length > 0) captureException(new Error('CSV import errors'), { errors })
        }
        return
      }

      await db.customers.bulkCreate(toImport)
      // Rows rejected by validation used to vanish here: the toast reported
      // `skippedCount` (duplicates) but never `errors`, so a 500-row file with
      // 40 missing company names reported "460 imported" and the operator had
      // no way to learn the 40 existed. Both counts are now surfaced, and the
      // per-row reasons go to the console so they can be acted on rather than
      // guessed at.
      if (errors.length > 0) {
        console.warn(['Customer CSV import — rejected rows:', ...errors].join('\n'))
        captureException(new Error('CSV import errors'), { errors })
      }
      if (skippedCount > 0 || errors.length > 0) {
        toast.success(
          t('customers.importedWithIssues', {
            count: toImport.length,
            skipped: skippedCount,
            rejected: errors.length,
          }),
          { duration: 8000 }
        )
      } else {
        toast.success(t('customers.importedSuccess', { count: toImport.length }))
      }
      db.auditLog
        .log(
          currentUserEmail,
          'customers_imported',
          `Imported ${toImport.length} customers from CSV${skippedCount ? `, skipped ${skippedCount} duplicates` : ''}`
        )
        .catch(() => {})
      if (errors.length > 0) {
        toast.error(t('customers.importRowErrors', { count: errors.length }))
        captureException(new Error('CSV import errors'), { errors })
      }
      setShowBulkUpload(false)
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      queryClient.invalidateQueries({ queryKey: ['customers-count'] })
    } catch (error) {
      toast.error(t('customers.failedImport', { error: error.message }))
    }
  }

  const getStatusBadge = (status) => {
    const map = {
      Active:    'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400',
      Inactive:  'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
      Suspended: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
      VIP:       'bg-purple-100 dark:bg-purple-900/20 text-purple-800 dark:text-purple-300',
    }
    return (
      <span
        className={`px-2 py-0.5 text-xs rounded-full font-medium ${map[status] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'}`}
      >
        {/* Rendered raw, so the badge stayed English under Arabic while every
            header around it translated — same gap as BUG #29 on tickets. */}
        {status ? t(`customerStatusValues.${status}`, status) : '—'}
      </span>
    )
  }

  const SortIcon = ({ col }) => {
    if (sortConfig.key !== col)
      return (
        <svg
          className="w-3.5 h-3.5 text-[#e6e9ef] dark:text-[#212a38] ml-1"
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
      )
    return sortConfig.direction === 'asc' ? (
      <svg
        className="w-3.5 h-3.5 text-[#4338ca] dark:text-[#a5b4fc] ml-1"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
      </svg>
    ) : (
      <svg
        className="w-3.5 h-3.5 text-[#4338ca] dark:text-[#a5b4fc] ml-1"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    )
  }

  const Th = ({ label, col }) => {
    const isActive = sortConfig.key === col
    const ariaSort = isActive ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending') : 'none'
    return (
      <button
        onClick={() => handleSort(col)}
        aria-label={`Sort by ${label}`}
        aria-sort={ariaSort}
        className="flex items-center text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase hover:text-gray-800"
      >
        {label}
        <SortIcon col={col} />
      </button>
    )
  }

  const renderPageNumbers = () => {
    const pages = []
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i)
    } else if (currentPage <= 4) {
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
    return pages.map((p, i) =>
      p === '...' ? (
        <span key={`e${i}`} className="px-2 text-gray-500 dark:text-[#9aa4b2]">
          …
        </span>
      ) : (
        <button
          key={p}
          onClick={() => handlePageChange(p)}
          className={`w-8 h-8 rounded text-sm ${currentPage === p ? 'bg-indigo-600 text-white' : 'text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-100 dark:bg-[#1a2230]'}`}
        >
          {p}
        </button>
      )
    )
  }

  if (loading) return <PageSkeleton cols={7} />

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader title={t('customers.title')} subtitle={t('customers.subtitle')} />

      {/* Table Card */}
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] shadow-sm">
        <div className="p-5 space-y-4">
          {/* Toolbar */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-1">
              <div className="relative flex-1 max-w-md">
                <input
                  ref={searchRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('customers.searchPlaceholder')}
                  aria-label={t('customers.searchPlaceholder')}
                  className="w-full pl-9 pr-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#746f65] dark:placeholder:text-[#a4acb7]"
                />
                <svg
                  className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
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
              <button
                onClick={() => setShowFilters(!showFilters)}
                aria-expanded={showFilters}
                aria-controls="customer-filters-panel"
                className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${showFilters || filterStatus || filterType || filterCompany ? 'border-[#4338ca] text-[#4338ca] bg-indigo-50 dark:bg-indigo-900/20 dark:border-[#a5b4fc] dark:text-[#a5b4fc]' : 'border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'}`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"
                  />
                </svg>
                {t('common.filters')}
                {(filterStatus || filterType || filterCompany) && (
                  <span className="w-4 h-4 bg-indigo-600 text-white text-xs rounded-full flex items-center justify-center">
                    {[filterStatus, filterType, filterCompany].filter(Boolean).length}
                  </span>
                )}
              </button>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {canDo('export') && (
                <ExportMenu
                  allRows={customers}
                  filteredRows={filteredCustomers}
                  selectedRows={customers.filter((c) => selectedCustomers.includes(c.id))}
                  ns="customers"
                  onExport={handleExport}
                />
              )}
              {canDo('create') && (
                <div className="relative add-customer-dropdown">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setShowAddDropdown(!showAddDropdown)
                    }}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 flex items-center gap-2 text-sm"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                      />
                    </svg>
                    {t('customers.addCustomer')}
                    <svg
                      className={`w-4 h-4 transition-transform ${showAddDropdown ? 'rotate-180' : ''}`}
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
                    <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-[#121823] rounded-lg shadow-lg border border-gray-200 dark:border-[#212a38] z-20">
                      <button
                        onClick={() => {
                          resetForm()
                          setShowAddCustomer(true)
                          setShowAddDropdown(false)
                        }}
                        className="w-full px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] flex items-center gap-3 border-b border-gray-100 dark:border-[#212a38] rounded-t-lg"
                      >
                        <svg
                          className="w-5 h-5 text-gray-500 dark:text-[#9aa4b2]"
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
                          <div className="font-medium text-gray-900 dark:text-[#e8ebf0]">{t('customers.addSingleCustomer')}</div>
                          <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t('customers.createOneCustomer')}</div>
                        </div>
                      </button>
                      {canDo('import') && (
                        <button
                          onClick={() => {
                            setShowBulkUpload(true)
                            setShowAddDropdown(false)
                          }}
                          className="w-full px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] flex items-center gap-3 rounded-b-lg"
                        >
                          <svg
                            className="w-5 h-5 text-gray-500 dark:text-[#9aa4b2]"
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
                            <div className="font-medium text-gray-900 dark:text-[#e8ebf0]">{t('customers.bulkImport')}</div>
                            <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t('customers.importFromCSV')}</div>
                          </div>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Filters */}
          {showFilters && (
            <div id="customer-filters-panel" className="flex flex-wrap gap-3 items-center p-4 bg-gray-50 dark:bg-[#0f1520] rounded-lg">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0]">{t('common.status')}:</label>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm"
                >
                  <option value="">{t('common.all')}</option>
                  {['Active', 'Inactive', 'Suspended'].map((st) => (
                    <option key={st} value={st}>{t(`customerStatusValues.${st}`, st)}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0]">{t('common.type')}:</label>
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm"
                >
                  <option value="">{t('common.all')}</option>
                  <option value="B2B">B2B</option>
                  <option value="B2C">B2C</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0]">{t('customers.contactCompany')}:</label>
                <input
                  type="text"
                  value={filterCompany}
                  onChange={(e) => setFilterCompany(e.target.value)}
                  placeholder={t('customers.filterPlaceholder')}
                  aria-label={t('customers.filterPlaceholder')}
                  className="px-3 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm w-44 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
              {(filterStatus || filterType || filterCompany) && (
                <button
                  onClick={() => {
                    setFilterStatus('')
                    setFilterType('')
                    setFilterCompany('')
                  }}
                  className="text-sm text-red-600 hover:underline"
                >
                  {t('common.clearAll')}
                </button>
              )}
            </div>
          )}

          {/* Cap warning banner (H-4) */}
          {customersTotalCount !== null && customersTotalCount > customers.length && (
            <div className="mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm flex items-center gap-2">
              <span>⚠️</span>
              <span>
                {t('customers.capWarning', { shown: customers.length, total: customersTotalCount })}
              </span>
            </div>
          )}

          {/* Bulk action bar */}
          {selectedCustomers.length > 0 && (
            <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-[#4338ca]/20 dark:border-[#a5b4fc]/20 rounded-[14px] px-4 py-2.5 flex items-center gap-3 flex-wrap">
              <span className="text-sm font-medium text-[#4338ca] dark:text-[#a5b4fc]">
                {selectedCustomers.length} {t('common.selected')}
              </span>
              <div className="w-px h-5 bg-[#4338ca]/20 dark:bg-[#a5b4fc]/20" />
              <select
                onChange={(e) => { if (e.target.value) { handleBulkStatusChange(e.target.value); e.target.value = '' } }}
                defaultValue=""
                className="text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
              >
                <option value="">{t('customers.changeStatus')}</option>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
                <option value="Suspended">Suspended</option>
              </select>
              {canDo('delete') && (
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
                onClick={() => setSelectedCustomers([])}
                className="ml-auto text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]"
              >
                {t('common.clear')}
              </button>
            </div>
          )}

          {/* Count + per-page */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-sm text-gray-600 dark:text-[#9aa4b2]">
            <span>
              {t('customers.showingRange', { from: filteredCustomers.length === 0 ? 0 : startIndex + 1, to: endIndex, total: filteredCustomers.length })}
            </span>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600 dark:text-[#9aa4b2]">{t('common.itemsPerPage')}:</label>
              <select
                aria-label={t('common.itemsPerPage')}
                value={itemsPerPage}
                onChange={(e) => setItemsPerPage(parseInt(e.target.value))}
                className="px-3 py-1 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-[#0f1520] border-y border-gray-200 dark:border-[#212a38]">
                <tr>
                  <th className="px-4 py-3 text-left w-10">
                    <input
                      type="checkbox"
                      checked={
                        paginatedCustomers.length > 0 &&
                        selectedCustomers.length === paginatedCustomers.length
                      }
                      onChange={handleSelectAll}
                      aria-label={t('common.selectAll')}
                      className="w-4 h-4 text-indigo-600 rounded"
                    />
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-[#9aa4b2] uppercase w-10">
                    #
                  </th>
                  <th className="px-4 py-3 text-left">
                    <Th label={t('common.code')} col="customer_code" />
                  </th>
                  <th className="px-4 py-3 text-left">
                    <Th label={t('customers.contactCompany')} col="contact_person" />
                  </th>
                  <th className="px-4 py-3 text-left">
                    <Th label={t('common.type')} col="customer_type" />
                  </th>
                  <th className="px-4 py-3 text-left">
                    <Th label={t('customers.mobile')} col="mobile" />
                  </th>
                  <th className="px-4 py-3 text-left">
                    <Th label={t('common.email')} col="email" />
                  </th>
                  <th className="px-4 py-3 text-left">
                    <Th label={t('common.status')} col="customer_status" />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">
                    {t('common.actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {paginatedCustomers.length === 0 ? (
                  <tr>
                    <td colSpan="9">
                      <EmptyState
                        preset="customers"
                        description={
                          customers.length > 0
                            ? t('customers.adjustFilters')
                            : t('customers.noCustomersHint')
                        }
                        action={
                          canDo('create') && customers.length === 0
                            ? () => setShowAddCustomer(true)
                            : undefined
                        }
                        actionLabel={t('customers.addFirstCustomer')}
                      />
                    </td>
                  </tr>
                ) : (
                  paginatedCustomers.map((c, idx) => (
                    <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] transition-colors">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedCustomers.includes(c.id)}
                          onChange={() => handleSelectCustomer(c.id)}
                          aria-label={t('common.selectRow', { name: customerLabel(c) })}
                          className="w-4 h-4 text-indigo-600 rounded"
                        />
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-500 dark:text-[#9aa4b2] tabular-nums">
                        {(currentPage - 1) * itemsPerPage + idx + 1}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-mono text-gray-500 dark:text-[#9aa4b2]">
                          {c.customer_code || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                            <span className="text-indigo-600 font-semibold text-xs">
                              {(c.contact_person || c.company_name || '?')[0].toUpperCase()}
                            </span>
                          </div>
                          <div>
                            <button
                              onClick={() => onNavigateToCustomer(c.id)}
                              className="font-medium text-gray-900 dark:text-[#e8ebf0] hover:text-indigo-600 text-sm text-left"
                            >
                              {c.contact_person || '—'}
                            </button>
                            {c.company_name && (
                              <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{c.company_name}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 text-xs rounded font-medium ${c.customer_type === 'B2B' ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400' : 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'}`}
                        >
                          {c.customer_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-[#9aa4b2]">{c.mobile || '—'}</td>
                      <td className="px-4 py-3 text-sm">
                        {c.email ? (
                          <a href={`mailto:${c.email}`} className="text-indigo-600 hover:underline">
                            {c.email}
                          </a>
                        ) : (
                          <span className="text-gray-500 dark:text-[#9aa4b2]">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">{getStatusBadge(c.customer_status)}</td>
                      <td className="px-4 py-3 relative action-menu">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setOpenMenuId(openMenuId === c.id ? null : c.id)
                          }}
                          aria-label={`Actions for ${c.contact_person || c.company_name || 'customer'}`}
                          aria-expanded={openMenuId === c.id}
                          aria-haspopup="menu"
                          className="p-1.5 rounded-lg text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-100 dark:bg-[#1a2230] transition-colors"
                        >
                          <svg className="w-4 h-4" aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
                            <circle cx="12" cy="5" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="12" cy="19" r="1.5" />
                          </svg>
                        </button>
                        {openMenuId === c.id && (
                          <div className="absolute right-0 top-9 z-30 w-44 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-gray-200 dark:border-[#212a38] py-1 overflow-hidden">
                            <button
                              onClick={() => {
                                onNavigateToCustomer(c.id)
                                setOpenMenuId(null)
                              }}
                              className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] flex items-center gap-2.5"
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
                            {canDo('edit') && (
                              <button
                                onClick={() => {
                                  handleEditCustomer(c)
                                  setOpenMenuId(null)
                                }}
                                className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] flex items-center gap-2.5"
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
                            {canDo('delete') && (
                              <button
                                onClick={() => {
                                  handleDeleteCustomer(c)
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

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-gray-200 dark:border-[#212a38]">
              <div className="text-sm text-gray-600 dark:text-[#9aa4b2]">
                {t('common.showingRange', {
                  start: startIndex + 1,
                  end: Math.min(startIndex + itemsPerPage, filteredCustomers.length),
                  total: filteredCustomers.length,
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
                <span className="text-sm text-gray-600 dark:text-[#9aa4b2]">{t('common.jumpToPage')}:</span>
                <input
                  type="number"
                  min="1"
                  max={totalPages}
                  aria-label={t('common.jumpToPage')}
                  value={jumpToPage}
                  onChange={(e) => setJumpToPage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleJumpToPage()}
                  placeholder={currentPage.toString()}
                  className="w-20 px-3 py-1 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
                />
                <button
                  onClick={handleJumpToPage}
                  className="px-3 py-1 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm"
                >
                  {t('common.go')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showAddCustomer && (
        <AddCustomerModal
          form={customerForm}
          setForm={setCustomerForm}
          editing={editingCustomer}
          usersList={usersList}
          pendingFiles={pendingFiles}
          setPendingFiles={setPendingFiles}
          onSave={handleSaveCustomer}
          onClose={() => {
            setShowAddCustomer(false)
            resetForm()
          }}
        />
      )}

      {showBulkUpload && (
        <BulkUploadCustomersModal
          onClose={() => setShowBulkUpload(false)}
          onUpload={handleBulkUploadCustomers}
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
