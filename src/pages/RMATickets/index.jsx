import React, { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, db, branding as brandingAPI } from '../../api/supabaseClient'
import { safeStorage } from '../../lib/safeStorage'
import toast from 'react-hot-toast'
import QRCode from 'qrcode'
import ConfirmDialog from '../../components/ConfirmDialog'
import { PageSkeleton } from '../../components/Skeleton'
import { Button, PageHeader } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import { ROLES, TICKET_STATUS_RESOLVED } from '../../lib/constants'
import { captureException } from '../../lib/sentry'
import { SortableHeader } from './_shared'
import { getStatusColor, getPriorityColor, fmt } from './_utils'
import { TicketForm } from './TicketForm'
import { TicketDrawer } from './TicketDrawer'

export default function RMATickets({ userRole, userEmail, userPermissions, initialTicketId }) {
  const queryClient = useQueryClient()

  // P-1: TanStack Query — cached fetch; stale data renders instantly on re-visit
  const { data: tickets = [], isLoading: loading } = useQuery({
    queryKey: ['rma-tickets'],
    queryFn: () => db.rmaTickets.list(),
    staleTime: 60_000,
  })
  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: () => db.customers.list(),
    staleTime: 60_000,
  })
  const { data: products = [] } = useQuery({
    queryKey: ['products'],
    queryFn: () => db.products.list(),
    staleTime: 5 * 60_000,
  })
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => db.userRoles.listAllRoles(),
    staleTime: 5 * 60_000,
  })
  const { data: ticketsTotalCount = null } = useQuery({
    queryKey: ['rma-tickets-count'],
    queryFn: async () => {
      const r = await db.rmaTickets.listPaged(0, 1)
      return r.count
    },
    staleTime: 60_000,
  })

  const [filteredTickets, setFilteredTickets] = useState([])
  const [searchTerm, setSearchTerm] = useState('')

  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(
    () => safeStorage.get('rmaTicketsPerPage', 25)
  )
  const [jumpToPage, setJumpToPage] = useState('')
  const [sortConfig, setSortConfig] = useState(() =>
    safeStorage.get('rmaTicketsSortConfig', { key: 'created_date', direction: 'desc' })
  )

  const [filterStatus, setFilterStatus] = useState(
    () => new URLSearchParams(window.location.search).get('status') || ''
  )
  const [filterOverdue, setFilterOverdue] = useState(
    () => new URLSearchParams(window.location.search).get('overdue') === 'true'
  )
  const [showFilters, setShowFilters] = useState(() => {
    const p = new URLSearchParams(window.location.search)
    return !!(p.get('status') || p.get('overdue'))
  })
  const [filterPriority, setFilterPriority] = useState('')
  const [filterAssigned, setFilterAssigned] = useState('')
  const [filterCustomer, setFilterCustomer] = useState('')
  const [filterCustomerSearch, setFilterCustomerSearch] = useState('')
  const [showFilterCustomerDropdown, setShowFilterCustomerDropdown] = useState(false)

  const [showModal, setShowModal] = useState(false)
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const [editingTicket, setEditingTicket] = useState(null)
  const [selectedTicket, setSelectedTicket] = useState(null)

  const searchInputRef = useRef(null)

  const [openMenuId, setOpenMenuId] = useState(null)

  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    message: '',
    onConfirm: null,
  })
  const openConfirm = (title, message, onConfirm) =>
    setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog((d) => ({ ...d, open: false }))

  const [selectedTickets, setSelectedTickets] = useState([])
  const [bulkTicketStatus, setBulkTicketStatus] = useState('')
  const [bulkProductStatus, setBulkProductStatus] = useState('')
  const [bulkProcessing, setBulkProcessing] = useState(false)

  useEffect(() => {
    handleSearchAndSort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    searchTerm,
    tickets,
    sortConfig,
    filterStatus,
    filterOverdue,
    filterPriority,
    filterAssigned,
    filterCustomer,
  ])
  useEffect(() => {
    safeStorage.set('rmaTicketsPerPage', itemsPerPage)
  }, [itemsPerPage])
  useEffect(() => {
    safeStorage.set('rmaTicketsSortConfig', sortConfig)
  }, [sortConfig])
  useEffect(() => {
    setCurrentPage(1)
    setSelectedTickets([])
  }, [
    searchTerm,
    itemsPerPage,
    filterStatus,
    filterPriority,
    filterAssigned,
    filterCustomer,
    sortConfig,
  ])

  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable
      if (e.key === 'Escape') {
        setShowModal(false)
        handleCloseDetails()
        return
      }
      if (typing) return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        handleAddNew()
      }
      if (e.key === '/') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showModal, showDetailsModal])

  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.filter-customer-dropdown')) setShowFilterCustomerDropdown(false)
      if (!e.target.closest('.action-menu')) setOpenMenuId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    const channel = supabase
      .channel('rma_tickets_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rma_tickets' }, () => {
        queryClient.invalidateQueries({ queryKey: ['rma-tickets'] })
        queryClient.invalidateQueries({ queryKey: ['rma-tickets-count'] })
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])

  const canDo = (action) => {
    if (userRole === ROLES.ADMIN || userRole === ROLES.SUPER_ADMIN) return true
    return userPermissions?.rma_tickets?.[action] === true
  }

  useEffect(() => {
    if (!tickets.length) return
    const urlTicketId = new URLSearchParams(window.location.search).get('ticket')
    const targetId = initialTicketId || urlTicketId
    if (!targetId) return
    const t = tickets.find((tk) => tk.id === targetId)
    if (t) {
      setSelectedTicket(t)
      setShowDetailsModal(true)
    }
  }, [initialTicketId, tickets])

  useEffect(() => {
    const onPop = () => {
      const ticketId = new URLSearchParams(window.location.search).get('ticket')
      if (!ticketId) {
        setShowDetailsModal(false)
        setSelectedTicket(null)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const handleSearchAndSort = () => {
    let filtered = [...tickets]
    if (searchTerm) {
      const q = searchTerm.toLowerCase()
      filtered = filtered.filter(
        (t) =>
          t.rma_number?.toLowerCase().includes(q) ||
          t.customer_name?.toLowerCase().includes(q) ||
          t.ticket_status?.toLowerCase().includes(q) ||
          t.priority?.toLowerCase().includes(q) ||
          t.assigned_technician?.toLowerCase().includes(q)
      )
    }
    if (filterStatus) filtered = filtered.filter((t) => t.ticket_status === filterStatus)
    if (filterOverdue) {
      const now = new Date()
      filtered = filtered.filter(
        (t) => t.due_date && new Date(t.due_date) < now && !TICKET_STATUS_RESOLVED.includes(t.ticket_status)
      )
    }
    if (filterPriority) filtered = filtered.filter((t) => t.priority === filterPriority)
    if (filterAssigned) filtered = filtered.filter((t) => t.assigned_technician === filterAssigned)
    if (filterCustomer) filtered = filtered.filter((t) => t.customer_name === filterCustomer)
    filtered.sort((a, b) => {
      let aVal = a[sortConfig.key] || ''
      let bVal = b[sortConfig.key] || ''
      if (
        sortConfig.key === 'created_date' ||
        sortConfig.key === 'due_date' ||
        sortConfig.key === 'updated_date'
      ) {
        aVal = new Date(aVal || 0).getTime()
        bVal = new Date(bVal || 0).getTime()
      } else {
        aVal = aVal.toString().toLowerCase()
        bVal = bVal.toString().toLowerCase()
      }
      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })
    setFilteredTickets(filtered)
  }

  const handleSort = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  const totalPages = Math.ceil(filteredTickets.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = Math.min(startIndex + itemsPerPage, filteredTickets.length)
  const paginatedTickets = filteredTickets.slice(startIndex, endIndex)

  const handlePageChange = (page) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page)
      setSelectedTickets([])
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  const handleJumpToPage = () => {
    const pageNum = parseInt(jumpToPage)
    if (pageNum >= 1 && pageNum <= totalPages) {
      handlePageChange(pageNum)
      setJumpToPage('')
    } else toast.error(`Page must be between 1 and ${totalPages}`)
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
    return pages.map((page, idx) =>
      page === '...' ? (
        <span key={`e-${idx}`} className="px-3 py-2 text-gray-500">
          ...
        </span>
      ) : (
        <button
          key={page}
          onClick={() => handlePageChange(page)}
          className={`px-3 py-2 rounded transition-colors ${currentPage === page ? 'bg-indigo-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
        >
          {page}
        </button>
      )
    )
  }

  const handleEdit = (ticket) => {
    if (!canDo('edit_all') && !canDo('edit_assigned')) {
      toast.error('You do not have permission to edit tickets')
      return
    }
    if (canDo('edit_assigned') && !canDo('edit_all') && ticket.assigned_technician !== userEmail) {
      toast.error('You can only edit tickets assigned to you')
      return
    }
    setEditingTicket(ticket)
    setShowModal(true)
  }

  const handleDelete = (id) => {
    if (!canDo('delete')) {
      toast.error('You do not have permission to delete tickets')
      return
    }
    openConfirm('Delete Ticket', 'Delete this ticket? This cannot be undone.', async () => {
      closeConfirm()
      // UX-6 optimistic: remove from list immediately; rollback on error
      const previousTickets = queryClient.getQueryData(['rma-tickets'])
      queryClient.setQueryData(['rma-tickets'], (old) => old?.filter((t) => t.id !== id) ?? [])
      try {
        await db.rmaTickets.delete(id)
        db.userActivity
          .create(userEmail, 'ticket_deleted', `Deleted ticket ID ${id}`)
          .catch(() => {})
        db.notifications
          .create({
            type: 'ticket_deleted',
            title: 'Ticket Deleted',
            message: `A ticket was deleted by ${userEmail}`,
            entityType: 'ticket',
            entityId: id,
            entityRef: null,
            createdBy: userEmail,
            targetRoles: ['admin', 'super_admin'],
            targetEmails: [],
          })
          .catch(() => {})
        toast.success('Ticket deleted!')
        queryClient.invalidateQueries({ queryKey: ['rma-tickets'] })
        queryClient.invalidateQueries({ queryKey: ['rma-tickets-count'] })
      } catch (err) {
        captureException(err, { page: 'RMATickets', context: 'deleteTicket' })
        queryClient.setQueryData(['rma-tickets'], previousTickets) // rollback on error
        toast.error('Failed to delete ticket')
      }
    })
  }

  const handleBulkDelete = () => {
    if (!canDo('delete')) {
      toast.error('You do not have permission to delete tickets')
      return
    }
    openConfirm(
      'Delete Tickets',
      `Delete ${selectedTickets.length} ticket${selectedTickets.length !== 1 ? 's' : ''}? This cannot be undone.`,
      async () => {
        closeConfirm()
        setBulkProcessing(true)
        try {
          await Promise.all(selectedTickets.map((id) => db.rmaTickets.delete(id)))
          db.notifications
            .create({
              type: 'ticket_deleted',
              title: 'Tickets Deleted',
              message: `${selectedTickets.length} ticket(s) were deleted by ${userEmail}`,
              entityType: 'ticket',
              entityId: null,
              createdBy: userEmail,
              targetRoles: ['admin', 'super_admin'],
              targetEmails: [],
            })
            .catch(() => {})
          toast.success(`${selectedTickets.length} ticket(s) deleted`)
          db.auditLog
            .log(userEmail, 'ticket_bulk_deleted', `Deleted ${selectedTickets.length} tickets`)
            .catch(() => {})
          setSelectedTickets([])
          queryClient.invalidateQueries({ queryKey: ['rma-tickets'] })
          queryClient.invalidateQueries({ queryKey: ['rma-tickets-count'] })
        } catch (err) {
          captureException(err, { page: 'RMATickets', context: 'bulkDeleteTickets' })
          toast.error('Failed to delete tickets')
        } finally {
          setBulkProcessing(false)
        }
      }
    )
  }

  const handleBulkTicketStatus = async () => {
    if (!bulkTicketStatus) return
    if (!(canDo('edit_all') || canDo('change_status'))) {
      toast.error('No permission to change status')
      return
    }
    setBulkProcessing(true)
    try {
      await Promise.all(
        selectedTickets.map((id) =>
          db.rmaTickets.update(id, {
            ticket_status: bulkTicketStatus,
            updated_by: userEmail,
            updated_date: new Date().toISOString(),
          })
        )
      )
      db.notifications
        .create({
          type: 'ticket_status_changed',
          title: 'Bulk Status Update',
          message: `${selectedTickets.length} ticket(s) status changed to "${bulkTicketStatus}" by ${userEmail}`,
          entityType: 'ticket',
          entityId: null,
          createdBy: userEmail,
          targetRoles: ['admin', 'super_admin'],
          targetEmails: [],
        })
        .catch(() => {})
      toast.success(
        `Status updated to "${bulkTicketStatus}" for ${selectedTickets.length} ticket(s)`
      )
      db.auditLog
        .log(
          userEmail,
          'ticket_bulk_status_changed',
          `Changed ${selectedTickets.length} tickets to "${bulkTicketStatus}"`
        )
        .catch(() => {})
      setSelectedTickets([])
      setBulkTicketStatus('')
      queryClient.invalidateQueries({ queryKey: ['rma-tickets'] })
    } catch (err) {
      captureException(err, { page: 'RMATickets', context: 'bulkUpdateStatus' })
      toast.error('Failed to update status')
    } finally {
      setBulkProcessing(false)
    }
  }

  const handleBulkProductStatus = async () => {
    if (!bulkProductStatus) return
    if (!(canDo('edit_all') || canDo('edit_assigned'))) {
      toast.error('No permission to edit tickets')
      return
    }
    setBulkProcessing(true)
    try {
      await Promise.all(
        selectedTickets.map((id) => {
          const ticket = tickets.find((t) => t.id === id)
          if (!ticket) return Promise.resolve()
          const updatedProducts = (ticket.products || []).map((p) => ({
            ...p,
            product_status: bulkProductStatus,
            status_date: new Date().toISOString(),
          }))
          return db.rmaTickets.update(id, {
            products: updatedProducts,
            updated_by: userEmail,
            updated_date: new Date().toISOString(),
          })
        })
      )
      toast.success(
        `Product status updated to "${bulkProductStatus}" for ${selectedTickets.length} ticket(s)`
      )
      db.auditLog
        .log(
          userEmail,
          'ticket_bulk_product_status_changed',
          `Changed product status to "${bulkProductStatus}" for ${selectedTickets.length} tickets`
        )
        .catch(() => {})
      setSelectedTickets([])
      setBulkProductStatus('')
      queryClient.invalidateQueries({ queryKey: ['rma-tickets'] })
    } catch (err) {
      captureException(err, { page: 'RMATickets', context: 'bulkUpdateProductStatus' })
      toast.error('Failed to update product status')
    } finally {
      setBulkProcessing(false)
    }
  }

  const toggleSelectTicket = (id) =>
    setSelectedTickets((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  const toggleSelectAll = () =>
    setSelectedTickets(
      selectedTickets.length === paginatedTickets.length ? [] : paginatedTickets.map((t) => t.id)
    )

  const handleCloseDetails = () => {
    const params = new URLSearchParams(window.location.search)
    params.delete('ticket')
    const qs = params.toString()
    window.history.replaceState({}, '', '/rma-tickets' + (qs ? `?${qs}` : ''))
    setShowDetailsModal(false)
  }

  const handleViewDetails = (ticket) => {
    window.history.pushState({ ticket: ticket.id }, '', `/rma-tickets?ticket=${ticket.id}`)
    setSelectedTicket(ticket)
    setShowDetailsModal(true)
  }

  const handleExportPDF = async (ticket) => {
    const esc = (s) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    let qrCodeUrl = ''
    try {
      qrCodeUrl = await QRCode.toDataURL(ticket.rma_number)
    } catch {}

    // Load PDF layout config and branding in parallel
    const PDF_DEFAULT = {
      paperSize: 'A4',
      orientation: 'portrait',
      font: 'Arial, sans-serif',
      fontSize: 11,
      primaryColor: '#4F46E5',
      headerStyle: 'colored',
      showLogo: false,
      logoPosition: 'right',
      showCompanyName: true,
      showRmaNumber: true,
      showDate: true,
      sections: {
        ticketInfo: true,
        generalDescription: true,
        products: true,
        accessories: true,
        attachments: true,
        signatureLine: false,
      },
      sectionOrder: [
        'ticketInfo',
        'generalDescription',
        'products',
        'accessories',
        'attachments',
        'signatureLine',
      ],
      footerText: '',
      showGeneratedDate: true,
      showWatermark: false,
    }
    let pdfCfg = PDF_DEFAULT
    let brandingData = {}
    try {
      const [cfgResult, brd] = await Promise.all([db.rmaConfig.getAll(), brandingAPI.getBranding()])
      if (!cfgResult.missing) {
        const row = cfgResult.data.find((r) => r.config_key === 'pdf_layout')
        if (row?.config_value) {
          const val =
            typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
          pdfCfg = {
            ...PDF_DEFAULT,
            ...val,
            sections: { ...PDF_DEFAULT.sections, ...(val.sections || {}) },
            sectionOrder: val.sectionOrder?.length ? val.sectionOrder : PDF_DEFAULT.sectionOrder,
          }
        }
      }
      if (brd) brandingData = brd
    } catch {}

    const color = pdfCfg.primaryColor || '#4F46E5'
    const font = pdfCfg.font || 'Arial, sans-serif'
    const fontSize = pdfCfg.fontSize || 11
    const sec = pdfCfg.sections || PDF_DEFAULT.sections
    const companyName = brandingData.company_name || 'myRMA'
    const logoUrl = pdfCfg.showLogo ? brandingData.logo_url || null : null

    const fmtPdf = (d) =>
      d
        ? new Date(d).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })
        : 'N/A'
    const fmtTS = (d) => {
      if (!d) return 'N/A'
      const dt = new Date(d)
      return (
        dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) +
        ' at ' +
        dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      )
    }

    const productsHtml = (ticket.products || [])
      .map(
        (p, i) => `
      <div style="border:1px solid #E5E7EB;border-radius:6px;padding:12px;margin-bottom:12px">
        <h4 style="margin:0 0 8px;font-size:${fontSize + 1}px;color:#1F2937">Product ${i + 1}: ${esc(p.product_name) || '—'}</h4>
        <table style="width:100%;font-size:${fontSize}px;border-collapse:collapse">
          <tr><td style="color:#6B7280;padding:3px 8px;width:40%">Serial Number</td><td style="font-family:monospace"><strong>${esc(p.serial_number) || '—'}</strong></td></tr>
          <tr><td style="color:#6B7280;padding:3px 8px">Product Status</td><td><strong>${esc(p.product_status) || '—'}</strong></td></tr>
          <tr><td style="color:#6B7280;padding:3px 8px">Warranty Status</td><td><strong>${esc(p.warranty_status) || '—'}</strong></td></tr>
          <tr><td colspan="2" style="padding:6px 8px 0"><strong>Issue:</strong> ${esc(p.issue_description) || '—'}</td></tr>
        </table>
      </div>`
      )
      .join('')

    const attachHtml = (ticket.attachments || []).length
      ? (ticket.attachments || [])
          .map(
            (a) =>
              `<li style="margin-bottom:4px">${esc(a.name)} <span style="color:#9CA3AF">(${(a.size / 1024).toFixed(1)} KB)</span></li>`
          )
          .join('')
      : '<li style="color:#9CA3AF">No attachments</li>'

    const priorityColors = {
      Critical: '#FEE2E2;color:#991B1B',
      High: '#FFEDD5;color:#9A3412',
      Medium: '#DBEAFE;color:#1E40AF',
      Low: '#F3F4F6;color:#374151',
    }
    const pc = priorityColors[ticket.priority] || priorityColors.Medium

    const headerBorderStyle =
      pdfCfg.headerStyle === 'colored'
        ? `border-bottom:3px solid ${color};background:linear-gradient(135deg,${color}15 0%,transparent 100%)`
        : pdfCfg.headerStyle === 'minimal'
          ? 'border-bottom:1px solid #E5E7EB'
          : 'border-bottom:none'

    const logoHtml = logoUrl
      ? `<img src="${logoUrl}" style="max-height:60px;max-width:140px;object-fit:contain" />`
      : ''

    const headerLeft =
      pdfCfg.logoPosition === 'left'
        ? `<div style="display:flex;align-items:center;gap:12px">${logoHtml}<div>${pdfCfg.showCompanyName ? `<div style="font-size:${fontSize + 4}px;font-weight:bold;color:${color}">${esc(companyName)}</div>` : ''}${pdfCfg.showRmaNumber ? `<div style="font-size:${fontSize + 2}px;color:#6B7280;margin-top:2px">${esc(ticket.rma_number)}</div>` : ''}${pdfCfg.showDate ? `<div style="font-size:${fontSize - 1}px;color:#9CA3AF;margin-top:2px">${esc(fmtTS(ticket.created_date))}</div>` : ''}<div style="margin-top:6px"><span class="badge" style="background:#DBEAFE;color:#1E40AF">${esc(ticket.ticket_status)}</span><span class="badge" style="background:${pc}">${esc(ticket.priority)}</span></div></div></div>`
        : `<div>${pdfCfg.showCompanyName ? `<div style="font-size:${fontSize + 4}px;font-weight:bold;color:${color}">${esc(companyName)}</div>` : ''}${pdfCfg.showRmaNumber ? `<div style="font-size:${fontSize + 2}px;color:#6B7280;margin-top:2px">${esc(ticket.rma_number)}</div>` : ''}${pdfCfg.showDate ? `<div style="font-size:${fontSize - 1}px;color:#9CA3AF;margin-top:2px">${esc(fmtTS(ticket.created_date))}</div>` : ''}<div style="margin-top:6px"><span class="badge" style="background:#DBEAFE;color:#1E40AF">${esc(ticket.ticket_status)}</span><span class="badge" style="background:${pc}">${esc(ticket.priority)}</span></div></div>`

    const headerRight =
      pdfCfg.logoPosition === 'right'
        ? `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">${logoHtml}${qrCodeUrl ? `<div style="text-align:center"><img src="${qrCodeUrl}" width="80" height="80"/><div style="font-size:10px;color:#6B7280;margin-top:2px">Scan to view</div></div>` : ''}</div>`
        : qrCodeUrl
          ? `<div style="text-align:center"><img src="${qrCodeUrl}" width="80" height="80"/><div style="font-size:10px;color:#6B7280;margin-top:2px">Scan to view</div></div>`
          : ''

    const watermarkHtml = pdfCfg.showWatermark
      ? `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:80px;font-weight:bold;color:${color};opacity:0.05;pointer-events:none;z-index:-1">DRAFT</div>`
      : ''

    const footerContent = [
      pdfCfg.showGeneratedDate ? `Generated: ${new Date().toLocaleString()}` : '',
      pdfCfg.footerText || companyName,
    ].filter(Boolean)

    const w = window.open('', '_blank')
    w.document.write(`<!DOCTYPE html><html><head><title>RMA Ticket - ${esc(ticket.rma_number)}</title>
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:${font};font-size:${fontSize}px;color:#1F2937;padding:30px}
        .header{display:flex;justify-content:space-between;align-items:flex-start;${headerBorderStyle};padding-bottom:20px;margin-bottom:24px}
        .badge{display:inline-block;padding:3px 10px;border-radius:9999px;font-size:${fontSize - 1}px;font-weight:bold;margin-right:6px;margin-top:6px}
        .section{margin-bottom:20px}
        .section-title{font-size:${fontSize - 1}px;text-transform:uppercase;letter-spacing:0.05em;color:${color};border-bottom:2px solid ${color}33;padding-bottom:6px;margin-bottom:12px;font-weight:600}
        .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
        .info-label{font-size:${fontSize - 2}px;color:#6B7280;margin-bottom:2px}
        .info-value{font-size:${fontSize}px;font-weight:bold}
        .desc-box{background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;padding:12px;white-space:pre-wrap}
        .footer{margin-top:30px;border-top:1px solid #E5E7EB;padding-top:12px;display:flex;justify-content:space-between;color:#9CA3AF;font-size:${fontSize - 2}px}
        .sig-box{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px}
        .sig-line{border-top:1px solid #374151;padding-top:6px;font-size:${fontSize - 1}px;color:#6B7280;text-align:center}
        @media print{body{padding:15px}}
      </style></head>
      <body>
      ${watermarkHtml}
      <div class="header">
        ${headerLeft}
        ${headerRight}
      </div>

      ${pdfCfg.sectionOrder
        .map((key) => {
          if (!sec[key]) return ''
          if (key === 'ticketInfo')
            return `
        <div class="section">
          <div class="section-title">Ticket Information</div>
          <div class="grid">
            <div><div class="info-label">Customer</div><div class="info-value">${esc(ticket.customer_name) || '—'}</div></div>
            <div><div class="info-label">Assigned To</div><div class="info-value">${esc(ticket.assigned_technician) || 'Unassigned'}</div></div>
            <div><div class="info-label">Due Date</div><div class="info-value">${esc(fmtPdf(ticket.due_date))}</div></div>
            <div><div class="info-label">Created</div><div class="info-value">${esc(fmtTS(ticket.created_date))}</div></div>
            <div><div class="info-label">Created By</div><div class="info-value">${esc(ticket.created_by) || '—'}</div></div>
          </div>
        </div>`
          if (key === 'generalDescription')
            return ticket.general_description
              ? `
        <div class="section">
          <div class="section-title">General RMA Description</div>
          <div class="desc-box">${esc(ticket.general_description)}</div>
        </div>`
              : ''
          if (key === 'products')
            return `
        <div class="section">
          <div class="section-title">Products (${(ticket.products || []).length})</div>
          ${productsHtml || '<p style="color:#9CA3AF">No products listed</p>'}
        </div>`
          if (key === 'accessories')
            return ticket.accessories_received
              ? `
        <div class="section">
          <div class="section-title">Accessories Received</div>
          <div class="desc-box">${esc(ticket.accessories_received)}</div>
        </div>`
              : ''
          if (key === 'attachments')
            return `
        <div class="section">
          <div class="section-title">Attachments</div>
          <ul style="padding-left:20px">${attachHtml}</ul>
        </div>`
          if (key === 'signatureLine')
            return `
        <div class="sig-box">
          <div><div class="sig-line">Customer Signature</div></div>
          <div><div class="sig-line">Technician Signature</div></div>
        </div>`
          return ''
        })
        .join('')}

      <div class="footer">
        <span>${esc(footerContent[0]) || ''}</span>
        <span>${esc(footerContent[1]) || ''}</span>
      </div>
      <script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>
      </body></html>`)
    w.document.close()
    db.auditLog
      .log(userEmail, 'ticket_exported_pdf', `Exported ticket ${ticket.rma_number} to PDF`)
      .catch(() => {})
  }

  const handleExport = () => {
    if (!canDo('export')) {
      toast.error('No permission to export')
      return
    }
    const csv = [
      ['RMA Number', 'Customer', 'Status', 'Priority', 'Assigned To', 'Due Date', 'Created Date'],
      ...filteredTickets.map((t) => [
        t.rma_number,
        t.customer_name,
        t.ticket_status,
        t.priority,
        t.assigned_technician || 'Unassigned',
        t.due_date || 'N/A',
        new Date(t.created_date).toLocaleDateString(),
      ]),
    ]
      .map((r) => r.join(','))
      .join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `rma-tickets-${Date.now()}.csv`
    a.click()
    toast.success('Exported!')
    db.auditLog
      .log(userEmail, 'tickets_exported', `Exported ${filteredTickets.length} tickets to CSV`)
      .catch(() => {})
  }

  const handleAddNew = () => {
    if (!canDo('create')) {
      toast.error('No permission to create tickets')
      return
    }
    setEditingTicket(null)
    setShowModal(true)
  }

  // eslint-disable-next-line no-unused-vars
  const SLABadge = ({ dueDate, status }) => {
    if (!dueDate || ['Completed', 'Cancelled'].includes(status))
      return <span className="text-gray-500 text-xs">{dueDate ? fmt(dueDate) : '—'}</span>
    const days = Math.ceil((new Date(dueDate) - Date.now()) / 86400000)
    if (days < 0)
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
          Overdue {Math.abs(days)}d
        </span>
      )
    if (days === 0)
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
          Due today
        </span>
      )
    if (days <= 2)
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
          {days}d left
        </span>
      )
    if (days <= 5)
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-700">
          {days}d left
        </span>
      )
    return <span className="text-xs text-gray-500">{fmt(dueDate)}</span>
  }

  if (loading) return <PageSkeleton cols={9} />

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader title="RMA Tickets" subtitle="Manage return merchandise authorization" />

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-1 max-w-2xl">
          <div className="relative flex-1">
            <input
              ref={searchInputRef}
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by RMA number, customer, status, priority... (Press / to focus)"
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
          <button
            onClick={() => setShowFilters(!showFilters)}
            aria-expanded={showFilters}
            aria-controls="ticket-filters-panel"
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${showFilters || filterStatus || filterOverdue || filterPriority || filterAssigned || filterCustomer ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"
              />
            </svg>
            Filters
            {(filterStatus || filterOverdue || filterPriority || filterAssigned || filterCustomer) && (
              <span className="w-4 h-4 bg-indigo-600 text-white text-xs rounded-full flex items-center justify-center">
                {[filterStatus, filterOverdue, filterPriority, filterAssigned, filterCustomer].filter(Boolean).length}
              </span>
            )}
          </button>
        </div>
        <div className="flex items-center gap-2">
          {canDo('export') && (
            <Button variant="secondary" onClick={handleExport}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              Export
            </Button>
          )}
          {canDo('create') && (
            <Button onClick={handleAddNew}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                />
              </svg>
              Create Ticket
            </Button>
          )}
        </div>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div id="ticket-filters-panel" className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Status:</label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
            >
              <option value="">All</option>
              <option value="Open">Open</option>
              <option value="In Progress">In Progress</option>
              <option value="Pending">Pending</option>
              <option value="On Hold">On Hold</option>
              <option value="Completed">Completed</option>
              <option value="Closed">Closed</option>
              <option value="Cancelled">Cancelled</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={filterOverdue}
                onChange={(e) => setFilterOverdue(e.target.checked)}
                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              Overdue only
            </label>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Priority:</label>
            <select
              value={filterPriority}
              onChange={(e) => setFilterPriority(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
            >
              <option value="">All</option>
              <option value="Low">Low</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
              <option value="Critical">Critical</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Assigned To:</label>
            <select
              value={filterAssigned}
              onChange={(e) => setFilterAssigned(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
            >
              <option value="">All</option>
              {[...new Set(tickets.map((t) => t.assigned_technician).filter(Boolean))]
                .sort()
                .map((email) => (
                  <option key={email} value={email}>
                    {email}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Customer:</label>
            <div className="relative filter-customer-dropdown">
              <div className="flex items-center">
                <input
                  type="text"
                  value={filterCustomerSearch}
                  onChange={(e) => {
                    setFilterCustomerSearch(e.target.value)
                    setShowFilterCustomerDropdown(true)
                    if (!e.target.value) {
                      setFilterCustomer('')
                    }
                  }}
                  onFocus={() => setShowFilterCustomerDropdown(true)}
                  placeholder={filterCustomer || 'All customers...'}
                  className={`w-52 px-3 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 ${filterCustomer ? 'border-indigo-400 bg-indigo-50 pr-7' : 'border-gray-300'}`}
                />
                {filterCustomer && (
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setFilterCustomer('')
                      setFilterCustomerSearch('')
                    }}
                    className="absolute right-2 text-gray-500 hover:text-gray-600"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                )}
              </div>
              {showFilterCustomerDropdown &&
                (() => {
                  const q = filterCustomerSearch.toLowerCase()
                  const dbNames = customers
                    .map((c) =>
                      c.customer_type === 'B2B' && c.company_name
                        ? c.company_name
                        : c.contact_person
                    )
                    .filter(Boolean)
                  const ticketNames = tickets.map((t) => t.customer_name).filter(Boolean)
                  const allNames = [...new Set([...dbNames, ...ticketNames])].sort()
                  const filtered = q
                    ? allNames.filter((n) => n.toLowerCase().includes(q))
                    : allNames
                  return filtered.length > 0 ? (
                    <div className="absolute z-30 left-0 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-xl max-h-52 overflow-y-auto">
                      {filtered.map((name) => (
                        <button
                          key={name}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            setFilterCustomer(name)
                            setFilterCustomerSearch('')
                            setShowFilterCustomerDropdown(false)
                          }}
                          className={`w-full px-3 py-2 text-left text-sm hover:bg-indigo-50 ${filterCustomer === name ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-gray-700'}`}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  ) : null
                })()}
            </div>
          </div>
          {(filterStatus || filterPriority || filterAssigned || filterCustomer) && (
            <button
              onClick={() => {
                setFilterStatus('')
                setFilterPriority('')
                setFilterAssigned('')
                setFilterCustomer('')
                setFilterCustomerSearch('')
              }}
              className="text-sm text-red-600 hover:underline"
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* Cap warning banner (H-4) */}
      {ticketsTotalCount !== null && ticketsTotalCount > tickets.length && (
        <div className="mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm flex items-center gap-2">
          <span>⚠️</span>
          <span>
            Showing first <strong>{tickets.length}</strong> of <strong>{ticketsTotalCount}</strong>{' '}
            tickets. Use filters or search to find specific tickets.
          </span>
        </div>
      )}

      {/* Pagination top bar */}
      <div className="flex items-center justify-between text-sm text-gray-600">
        <div>
          Showing {filteredTickets.length === 0 ? 0 : startIndex + 1}–{endIndex} of{' '}
          {filteredTickets.length} tickets
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Items per page:</label>
          <select
            value={itemsPerPage}
            onChange={(e) => {
              setItemsPerPage(parseInt(e.target.value))
              setCurrentPage(1)
            }}
            className="px-3 py-1 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedTickets.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-xl flex-wrap">
          <div className="flex items-center gap-2 text-sm font-medium text-indigo-700">
            <span className="w-6 h-6 bg-indigo-600 text-white rounded-full flex items-center justify-center text-xs font-bold">
              {selectedTickets.length}
            </span>
            ticket{selectedTickets.length !== 1 ? 's' : ''} selected
          </div>
          <button
            onClick={() => setSelectedTickets([])}
            className="text-xs text-indigo-500 hover:text-indigo-700 underline"
          >
            Clear
          </button>
          <div className="h-5 w-px bg-indigo-200 hidden sm:block" />

          {/* Change ticket status */}
          {(canDo('edit_all') || canDo('change_status')) && (
            <div className="flex items-center gap-1.5">
              <select
                value={bulkTicketStatus}
                onChange={(e) => setBulkTicketStatus(e.target.value)}
                className="px-2.5 py-1.5 border border-indigo-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              >
                <option value="">Ticket Status…</option>
                <option>New</option>
                <option>In Progress</option>
                <option>On Hold</option>
                <option>Completed</option>
                <option>Cancelled</option>
              </select>
              <button
                onClick={handleBulkTicketStatus}
                disabled={!bulkTicketStatus || bulkProcessing}
                className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              >
                Apply
              </button>
            </div>
          )}

          {/* Change product status */}
          {(canDo('edit_all') || canDo('edit_assigned')) && (
            <div className="flex items-center gap-1.5">
              <select
                value={bulkProductStatus}
                onChange={(e) => setBulkProductStatus(e.target.value)}
                className="px-2.5 py-1.5 border border-indigo-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              >
                <option value="">Product Status…</option>
                <option>Received</option>
                <option>Under Repair</option>
                <option>Repaired</option>
                <option>Can&apos;t Repair</option>
                <option>Replacement</option>
                <option>Credit Note</option>
              </select>
              <button
                onClick={handleBulkProductStatus}
                disabled={!bulkProductStatus || bulkProcessing}
                className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              >
                Apply
              </button>
            </div>
          )}

          {/* Delete */}
          {canDo('delete') && (
            <>
              <div className="h-5 w-px bg-indigo-200 hidden sm:block" />
              <button
                onClick={handleBulkDelete}
                disabled={bulkProcessing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 disabled:opacity-40 transition-colors"
              >
                {bulkProcessing ? (
                  <div className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                ) : (
                  <svg
                    className="w-3.5 h-3.5"
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
                )}
                Delete Selected
              </button>
            </>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-y border-gray-200">
            <tr>
              <th className="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  checked={
                    paginatedTickets.length > 0 &&
                    selectedTickets.length === paginatedTickets.length
                  }
                  onChange={toggleSelectAll}
                  className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase w-10">
                #
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader
                  label="RMA Number"
                  sortKey="rma_number"
                  sortConfig={sortConfig}
                  onSort={handleSort}
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader
                  label="Customer"
                  sortKey="customer_name"
                  sortConfig={sortConfig}
                  onSort={handleSort}
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader
                  label="Status"
                  sortKey="ticket_status"
                  sortConfig={sortConfig}
                  onSort={handleSort}
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader
                  label="Priority"
                  sortKey="priority"
                  sortConfig={sortConfig}
                  onSort={handleSort}
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader
                  label="Assigned To"
                  sortKey="assigned_technician"
                  sortConfig={sortConfig}
                  onSort={handleSort}
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <SortableHeader
                  label="Created Date"
                  sortKey="created_date"
                  sortConfig={sortConfig}
                  onSort={handleSort}
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {paginatedTickets.map((t, idx) => (
              <tr
                key={t.id}
                className={`hover:bg-gray-50 transition-colors ${selectedTickets.includes(t.id) ? 'bg-indigo-50/60' : ''}`}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selectedTickets.includes(t.id)}
                    onChange={() => toggleSelectTicket(t.id)}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                  />
                </td>
                <td className="px-3 py-3 text-xs text-gray-500 tabular-nums">
                  {startIndex + idx + 1}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleViewDetails(t)}
                    className="font-mono text-sm font-medium text-indigo-600 hover:text-indigo-800"
                  >
                    {t.rma_number}
                  </button>
                </td>
                <td className="px-4 py-3 text-sm text-gray-900">{t.customer_name}</td>
                <td className="px-4 py-3">
                  <span
                    className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(t.ticket_status)}`}
                  >
                    {t.ticket_status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`px-2 py-1 text-xs font-medium rounded-full ${getPriorityColor(t.priority)}`}
                  >
                    {t.priority}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {t.assigned_technician || 'Unassigned'}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">{fmt(t.created_date)}</td>
                <td className="px-4 py-3 relative action-menu">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenMenuId(openMenuId === t.id ? null : t.id)
                    }}
                    aria-label={`Actions for ticket ${t.rma_number}`}
                    aria-expanded={openMenuId === t.id}
                    aria-haspopup="menu"
                    className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                  >
                    <svg className="w-4 h-4" aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
                      <circle cx="12" cy="5" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="12" cy="19" r="1.5" />
                    </svg>
                  </button>
                  {openMenuId === t.id && (
                    <div className="absolute right-0 top-9 z-30 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                      <button
                        onClick={() => {
                          handleViewDetails(t)
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
                      {(canDo('edit_all') || canDo('edit_assigned')) && (
                        <button
                          onClick={() => {
                            handleEdit(t)
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
                      <button
                        onClick={() => {
                          handleExportPDF(t)
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
                            d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                        Export PDF
                      </button>
                      {canDo('delete') && (
                        <button
                          onClick={() => {
                            handleDelete(t.id)
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
            ))}
            {paginatedTickets.length === 0 && (
              <tr>
                <td colSpan={9}>
                  <EmptyState
                    preset="tickets"
                    description={
                      tickets.length > 0
                        ? 'Try adjusting your filters or search term'
                        : 'Create your first RMA ticket to get started'
                    }
                    action={canDo('create') && tickets.length === 0 ? handleAddNew : undefined}
                    actionLabel="Create First Ticket"
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
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

      {/* ─── CREATE / EDIT MODAL ─── */}
      {showModal && (
        <TicketForm
          editingTicket={editingTicket}
          onClose={() => {
            setShowModal(false)
            setEditingTicket(null)
          }}
          onSaved={() => {
            setShowModal(false)
            setEditingTicket(null)
          }}
          customers={customers}
          products={products}
          users={users}
          tickets={tickets}
          userEmail={userEmail}
          userRole={userRole}
          userPermissions={userPermissions}
        />
      )}

      {/* ─── DETAILS MODAL ─── */}
      {showDetailsModal && selectedTicket && (
        <TicketDrawer
          ticket={selectedTicket}
          onClose={() => {
            handleCloseDetails()
            setSelectedTicket(null)
          }}
          onEdit={(ticket) => {
            handleEdit(ticket)
          }}
          onDelete={handleDelete}
          onExportPDF={handleExportPDF}
          onNavigateToTicket={(t) => {
            setSelectedTicket(t)
          }}
          userEmail={userEmail}
          userRole={userRole}
          userPermissions={userPermissions}
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
