import React, { useState, useEffect, useRef } from 'react'
import { supabase, db, storage, branding as brandingAPI } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import QRCode from 'qrcode'
import ConfirmDialog from '../components/ConfirmDialog'
import { PageSkeleton } from '../components/Skeleton'
import { Button, Spinner, PageHeader } from '../components/ui'

const generateRmaNumber = (existingTickets = []) => {
  const now = new Date()
  const dd = String(now.getDate()).padStart(2, '0')
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const yyyy = now.getFullYear()
  const dateStr = `${dd}${mm}${yyyy}`
  const prefix = `RMA-${dateStr}-`

  const todaySerials = existingTickets
    .map(t => t.rma_number)
    .filter(n => n?.startsWith(prefix))
    .map(n => parseInt(n.replace(prefix, ''), 10))
    .filter(n => !isNaN(n))

  const nextSerial = todaySerials.length > 0 ? Math.max(...todaySerials) + 1 : 1
  return `${prefix}${String(nextSerial).padStart(4, '0')}`
}

const DEFAULT_DUE = () => {
  const d = new Date()
  d.setDate(d.getDate() + 7)
  return d.toISOString().split('T')[0]
}

const EMPTY_PRODUCT = {
  product_name: '',
  serial_number: '',
  product_status: 'Received',
  warranty_status: 'In Warranty',
  issue_description: ''
}

function SortableHeader({ label, sortKey, sortConfig, onSort }) {
  const isActive = sortConfig.key === sortKey
  return (
    <button onClick={() => onSort(sortKey)} className="flex items-center gap-1 hover:text-gray-900 transition-colors">
      <span>{label}</span>
      {isActive ? (
        sortConfig.direction === 'asc'
          ? <svg className="w-3.5 h-3.5 text-indigo-600 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
          : <svg className="w-3.5 h-3.5 text-indigo-600 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      ) : (
        <svg className="w-3.5 h-3.5 text-gray-300 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" /></svg>
      )}
    </button>
  )
}

export default function RMATickets({ userRole, userEmail, userPermissions, initialTicketId }) {
  const [tickets, setTickets] = useState([])
  const [filteredTickets, setFilteredTickets] = useState([])
  const [customers, setCustomers] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(() => parseInt(localStorage.getItem('rmaTicketsPerPage')) || 25)
  const [jumpToPage, setJumpToPage] = useState('')
  const [sortConfig, setSortConfig] = useState(() => {
    const saved = localStorage.getItem('rmaTicketsSortConfig')
    return saved ? JSON.parse(saved) : { key: 'created_date', direction: 'desc' }
  })

  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('')
  const [filterPriority, setFilterPriority] = useState('')
  const [filterAssigned, setFilterAssigned] = useState('')
  const [filterCustomer, setFilterCustomer] = useState('')
  const [filterCustomerSearch, setFilterCustomerSearch] = useState('')
  const [showFilterCustomerDropdown, setShowFilterCustomerDropdown] = useState(false)

  const [showModal, setShowModal] = useState(false)
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const [editingTicket, setEditingTicket] = useState(null)
  const [previewRmaNumber, setPreviewRmaNumber] = useState('')
  const [selectedTicket, setSelectedTicket] = useState(null)
  const [uploading, setUploading] = useState(false)

  const [customerSearch, setCustomerSearch] = useState('')
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false)
  const [productSearches, setProductSearches] = useState([''])
  const [showProductDropdowns, setShowProductDropdowns] = useState([false])
  const [pendingFiles, setPendingFiles] = useState([])
  const fileInputRef = useRef(null)
  const searchInputRef = useRef(null)

  const [users, setUsers] = useState([])
  const [openMenuId, setOpenMenuId] = useState(null)

  const [confirmDialog, setConfirmDialog] = useState({ open: false, title: '', message: '', onConfirm: null })
  const openConfirm = (title, message, onConfirm) => setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog(d => ({ ...d, open: false }))

  const [selectedTickets, setSelectedTickets] = useState([])
  const [bulkTicketStatus, setBulkTicketStatus] = useState('')
  const [bulkProductStatus, setBulkProductStatus] = useState('')
  const [bulkProcessing, setBulkProcessing] = useState(false)

  const [ticketComments, setTicketComments] = useState([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [isInternalComment, setIsInternalComment] = useState(false)
  const [submittingComment, setSubmittingComment] = useState(false)
  const [replyingTo, setReplyingTo] = useState(null)
  const [commentFiles, setCommentFiles] = useState([])
  const commentFileInputRef = useRef(null)

  const [formData, setFormData] = useState({
    customer_name: '',
    priority: 'Medium',
    ticket_status: 'New',
    assigned_technician: '',
    due_date: DEFAULT_DUE(),
    general_description: '',
    accessories_received: '',
    attachments: [],
    products: [{ ...EMPTY_PRODUCT }]
  })

  useEffect(() => { loadData() }, [])

  useEffect(() => {
    if (userEmail && !formData.assigned_technician) {
      setFormData(prev => ({ ...prev, assigned_technician: userEmail }))
    }
  }, [userEmail])
  useEffect(() => { handleSearchAndSort() }, [searchTerm, tickets, sortConfig, filterStatus, filterPriority, filterAssigned, filterCustomer])
  useEffect(() => { localStorage.setItem('rmaTicketsPerPage', itemsPerPage.toString()) }, [itemsPerPage])
  useEffect(() => { localStorage.setItem('rmaTicketsSortConfig', JSON.stringify(sortConfig)) }, [sortConfig])
  useEffect(() => { setCurrentPage(1); setSelectedTickets([]) }, [searchTerm, itemsPerPage, filterStatus, filterPriority, filterAssigned, filterCustomer, sortConfig])

  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable
      if (e.key === 'Escape') { setShowModal(false); setShowDetailsModal(false); return }
      if (typing) return
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); handleAddNew() }
      if (e.key === '/') { e.preventDefault(); searchInputRef.current?.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [showModal, showDetailsModal])

  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.customer-dropdown')) setShowCustomerDropdown(false)
      if (!e.target.closest('.product-dropdown')) setShowProductDropdowns(prev => prev.map(() => false))
      if (!e.target.closest('.filter-customer-dropdown')) setShowFilterCustomerDropdown(false)
      if (!e.target.closest('.action-menu')) setOpenMenuId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    const channel = supabase.channel('rma_tickets_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rma_tickets' }, () => {
        loadData()
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  const canDo = (action) => {
    if (userRole === 'admin' || userRole === 'super_admin') return true
    return userPermissions?.rma_tickets?.[action] === true
  }

  const loadData = async () => {
    try {
      const [ticketsData, customersData, productsData, usersData] = await Promise.all([
        db.rmaTickets.list(),
        db.customers.list(),
        db.products.list(),
        db.userRoles.listAllRoles()
      ])
      setTickets(ticketsData)
      setFilteredTickets(ticketsData)
      setCustomers(customersData)
      setProducts(productsData)
      setUsers(usersData)
    } catch (error) {
      toast.error('Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!initialTicketId || !tickets.length) return
    const t = tickets.find(tk => tk.id === initialTicketId)
    if (t) { setSelectedTicket(t); setShowDetailsModal(true) }
  }, [initialTicketId, tickets])

  const handleSearchAndSort = () => {
    let filtered = [...tickets]
    if (searchTerm) {
      const q = searchTerm.toLowerCase()
      filtered = filtered.filter(t =>
        t.rma_number?.toLowerCase().includes(q) ||
        t.customer_name?.toLowerCase().includes(q) ||
        t.ticket_status?.toLowerCase().includes(q) ||
        t.priority?.toLowerCase().includes(q) ||
        t.assigned_technician?.toLowerCase().includes(q)
      )
    }
    if (filterStatus)   filtered = filtered.filter(t => t.ticket_status === filterStatus)
    if (filterPriority) filtered = filtered.filter(t => t.priority === filterPriority)
    if (filterAssigned) filtered = filtered.filter(t => t.assigned_technician === filterAssigned)
    if (filterCustomer) filtered = filtered.filter(t => t.customer_name === filterCustomer)
    filtered.sort((a, b) => {
      let aVal = a[sortConfig.key] || ''
      let bVal = b[sortConfig.key] || ''
      if (sortConfig.key === 'created_date' || sortConfig.key === 'due_date' || sortConfig.key === 'updated_date') {
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
    setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc' }))
  }

  const totalPages = Math.ceil(filteredTickets.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = Math.min(startIndex + itemsPerPage, filteredTickets.length)
  const paginatedTickets = filteredTickets.slice(startIndex, endIndex)

  const handlePageChange = (page) => {
    if (page >= 1 && page <= totalPages) { setCurrentPage(page); setSelectedTickets([]); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  }

  const handleJumpToPage = () => {
    const pageNum = parseInt(jumpToPage)
    if (pageNum >= 1 && pageNum <= totalPages) { handlePageChange(pageNum); setJumpToPage('') }
    else toast.error(`Page must be between 1 and ${totalPages}`)
  }

  const renderPageNumbers = () => {
    const pages = []
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i)
    } else if (currentPage <= 4) {
      for (let i = 1; i <= 5; i++) pages.push(i)
      pages.push('...'); pages.push(totalPages)
    } else if (currentPage >= totalPages - 3) {
      pages.push(1); pages.push('...')
      for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i)
    } else {
      pages.push(1); pages.push('...')
      for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i)
      pages.push('...'); pages.push(totalPages)
    }
    return pages.map((page, idx) =>
      page === '...'
        ? <span key={`e-${idx}`} className="px-3 py-2 text-gray-400">...</span>
        : <button key={page} onClick={() => handlePageChange(page)} className={`px-3 py-2 rounded transition-colors ${currentPage === page ? 'bg-indigo-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}>{page}</button>
    )
  }

  const filteredCustomersList = customers.filter(c => {
    const q = customerSearch.toLowerCase()
    return !q || c.contact_person?.toLowerCase().includes(q) ||
      c.company_name?.toLowerCase().includes(q) || c.mobile?.includes(q)
  })

  const filteredProductsList = (search) => {
    if (!search) return products.slice(0, 8)
    const q = search.toLowerCase()
    return products.filter(p =>
      p.product_name?.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q)
    ).slice(0, 6)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (editingTicket && !canDo('edit_all') && !canDo('edit_assigned')) {
      toast.error('You do not have permission to edit tickets'); return
    }
    if (!editingTicket && !canDo('create')) {
      toast.error('You do not have permission to create tickets'); return
    }

    setUploading(true)
    try {
      const rmaNumber = editingTicket
        ? editingTicket.rma_number
        : generateRmaNumber(tickets)

      const newAttachments = []
      for (const file of pendingFiles) {
        try {
          const uploaded = await storage.uploadFile(file, rmaNumber)
          newAttachments.push(uploaded)
        } catch (err) {
          toast.error(`Failed to upload ${file.name}`)
        }
      }

      const allAttachments = [...(formData.attachments || []), ...newAttachments]

      const ticketData = {
        customer_name: formData.customer_name,
        priority: formData.priority,
        ticket_status: formData.ticket_status,
        assigned_technician: formData.assigned_technician,
        due_date: formData.due_date || null,
        general_description: formData.general_description || null,
        accessories_received: formData.accessories_received || null,
        attachments: allAttachments.length > 0 ? allAttachments : null,
        products: formData.products.map(p => ({
          ...p,
          status_date: p.status_date || new Date().toISOString(),
        })),
        rma_number: rmaNumber,
        updated_by: userEmail,
        updated_date: new Date().toISOString(),
      }

      if (editingTicket) {
        await db.rmaTickets.update(editingTicket.id, ticketData)
        db.userActivity.create(userEmail, 'ticket_updated', `Updated ticket ${editingTicket.rma_number || editingTicket.id}`).catch(() => {})
        const techEmails = ticketData.assigned_technician && ticketData.assigned_technician !== userEmail ? [ticketData.assigned_technician] : []
        db.notifications.create({
          type: 'ticket_updated', title: 'Ticket Updated',
          message: `Ticket ${editingTicket.rma_number} for ${ticketData.customer_name} was updated by ${userEmail}`,
          entityType: 'ticket', entityId: editingTicket.id, entityRef: editingTicket.rma_number,
          createdBy: userEmail, targetRoles: ['admin', 'super_admin'], targetEmails: techEmails
        }).catch(() => {})
        // Specific: technician assignment changed
        if (ticketData.assigned_technician && ticketData.assigned_technician !== editingTicket.assigned_technician) {
          db.notifications.create({
            type: 'ticket_assigned', title: 'Ticket Assigned',
            message: `Ticket ${editingTicket.rma_number} was assigned to ${ticketData.assigned_technician}`,
            entityType: 'ticket', entityId: editingTicket.id, entityRef: editingTicket.rma_number,
            createdBy: userEmail, targetRoles: ['admin', 'super_admin'], targetEmails: [ticketData.assigned_technician]
          }).catch(() => {})
        }
        // Specific: status changed
        if (ticketData.ticket_status !== editingTicket.ticket_status) {
          const assigneeEmails = editingTicket.assigned_technician && editingTicket.assigned_technician !== userEmail ? [editingTicket.assigned_technician] : []
          db.notifications.create({
            type: 'ticket_status_changed', title: 'Ticket Status Changed',
            message: `Ticket ${editingTicket.rma_number} moved from "${editingTicket.ticket_status}" to "${ticketData.ticket_status}"`,
            entityType: 'ticket', entityId: editingTicket.id, entityRef: editingTicket.rma_number,
            createdBy: userEmail, targetRoles: ['admin', 'super_admin'], targetEmails: assigneeEmails
          }).catch(() => {})
        }
        toast.success('Ticket updated successfully!')
      } else {
        const newTicket = await db.rmaTickets.create({ ...ticketData, created_by: userEmail, created_date: new Date().toISOString() })
        if (newTicket?.id) {
          db.inventory.createUnitsFromTicket(newTicket.id, newTicket.rma_number || rmaNumber, ticketData.products).catch((err) => {
            console.warn('Inventory unit creation failed:', err?.message || err)
          })
          const techEmails = ticketData.assigned_technician && ticketData.assigned_technician !== userEmail ? [ticketData.assigned_technician] : []
          db.notifications.create({
            type: 'ticket_created', title: 'New RMA Ticket',
            message: `Ticket ${rmaNumber} created for ${ticketData.customer_name}`,
            entityType: 'ticket', entityId: newTicket.id, entityRef: rmaNumber,
            createdBy: userEmail, targetRoles: ['admin', 'super_admin'], targetEmails: techEmails
          }).catch(() => {})
        }
        db.userActivity.create(userEmail, 'ticket_created', `Created ticket ${rmaNumber} for ${ticketData.customer_name}`).catch(() => {})
        toast.success('Ticket created successfully!')
      }

      setShowModal(false)
      setEditingTicket(null)
      resetForm()
      loadData()
    } catch (error) {
      toast.error(`Failed to save ticket: ${error.message}`)
    } finally {
      setUploading(false)
    }
  }

  const handleEdit = (ticket) => {
    if (!canDo('edit_all') && !canDo('edit_assigned')) {
      toast.error('You do not have permission to edit tickets'); return
    }
    if (canDo('edit_assigned') && !canDo('edit_all') && ticket.assigned_technician !== userEmail) {
      toast.error('You can only edit tickets assigned to you'); return
    }
    setEditingTicket(ticket)
    const prods = ticket.products?.length ? ticket.products : [{ ...EMPTY_PRODUCT }]
    setFormData({
      customer_name: ticket.customer_name || '',
      priority: ticket.priority || 'Medium',
      ticket_status: ticket.ticket_status || 'New',
      assigned_technician: ticket.assigned_technician || '',
      due_date: ticket.due_date || '',
      general_description: ticket.general_description || '',
      accessories_received: ticket.accessories_received || '',
      attachments: ticket.attachments || [],
      products: prods
    })
    setCustomerSearch(ticket.customer_name || '')
    setProductSearches(prods.map(p => p.product_name || ''))
    setShowProductDropdowns(prods.map(() => false))
    setPendingFiles([])
    setShowModal(true)
  }

  const handleDelete = (id) => {
    if (!canDo('delete')) { toast.error('You do not have permission to delete tickets'); return }
    openConfirm(
      'Delete Ticket',
      'Delete this ticket? This cannot be undone.',
      async () => {
        closeConfirm()
        try {
          await db.rmaTickets.delete(id)
          db.userActivity.create(userEmail, 'ticket_deleted', `Deleted ticket ID ${id}`).catch(() => {})
          db.notifications.create({
            type: 'ticket_deleted', title: 'Ticket Deleted',
            message: `A ticket was deleted by ${userEmail}`,
            entityType: 'ticket', entityId: id, entityRef: null,
            createdBy: userEmail, targetRoles: ['admin', 'super_admin'], targetEmails: []
          }).catch(() => {})
          toast.success('Ticket deleted!')
          loadData()
        } catch { toast.error('Failed to delete ticket') }
      }
    )
  }

  const handleBulkDelete = () => {
    if (!canDo('delete')) { toast.error('You do not have permission to delete tickets'); return }
    openConfirm(
      'Delete Tickets',
      `Delete ${selectedTickets.length} ticket${selectedTickets.length !== 1 ? 's' : ''}? This cannot be undone.`,
      async () => {
        closeConfirm()
        setBulkProcessing(true)
        try {
          await Promise.all(selectedTickets.map(id => db.rmaTickets.delete(id)))
          db.notifications.create({
            type: 'ticket_deleted', title: 'Tickets Deleted',
            message: `${selectedTickets.length} ticket(s) were deleted by ${userEmail}`,
            entityType: 'ticket', entityId: null,
            createdBy: userEmail, targetRoles: ['admin', 'super_admin'], targetEmails: []
          }).catch(() => {})
          toast.success(`${selectedTickets.length} ticket(s) deleted`)
          setSelectedTickets([])
          loadData()
        } catch { toast.error('Failed to delete tickets') }
        finally { setBulkProcessing(false) }
      }
    )
  }

  const handleBulkTicketStatus = async () => {
    if (!bulkTicketStatus) return
    if (!(canDo('edit_all') || canDo('change_status'))) { toast.error('No permission to change status'); return }
    setBulkProcessing(true)
    try {
      await Promise.all(selectedTickets.map(id => db.rmaTickets.update(id, {
        ticket_status: bulkTicketStatus,
        updated_by: userEmail,
        updated_date: new Date().toISOString(),
      })))
      db.notifications.create({
        type: 'ticket_status_changed', title: 'Bulk Status Update',
        message: `${selectedTickets.length} ticket(s) status changed to "${bulkTicketStatus}" by ${userEmail}`,
        entityType: 'ticket', entityId: null,
        createdBy: userEmail, targetRoles: ['admin', 'super_admin'], targetEmails: []
      }).catch(() => {})
      toast.success(`Status updated to "${bulkTicketStatus}" for ${selectedTickets.length} ticket(s)`)
      setSelectedTickets([])
      setBulkTicketStatus('')
      loadData()
    } catch { toast.error('Failed to update status') }
    finally { setBulkProcessing(false) }
  }

  const handleBulkProductStatus = async () => {
    if (!bulkProductStatus) return
    if (!(canDo('edit_all') || canDo('edit_assigned'))) { toast.error('No permission to edit tickets'); return }
    setBulkProcessing(true)
    try {
      await Promise.all(selectedTickets.map(id => {
        const ticket = tickets.find(t => t.id === id)
        if (!ticket) return Promise.resolve()
        const updatedProducts = (ticket.products || []).map(p => ({ ...p, product_status: bulkProductStatus, status_date: new Date().toISOString() }))
        return db.rmaTickets.update(id, {
          products: updatedProducts,
          updated_by: userEmail,
          updated_date: new Date().toISOString(),
        })
      }))
      toast.success(`Product status updated to "${bulkProductStatus}" for ${selectedTickets.length} ticket(s)`)
      setSelectedTickets([])
      setBulkProductStatus('')
      loadData()
    } catch { toast.error('Failed to update product status') }
    finally { setBulkProcessing(false) }
  }

  const toggleSelectTicket = (id) => setSelectedTickets(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  const toggleSelectAll = () => setSelectedTickets(selectedTickets.length === paginatedTickets.length ? [] : paginatedTickets.map(t => t.id))

  const handleViewDetails = (ticket) => {
    setSelectedTicket(ticket)
    setShowDetailsModal(true)
    setTicketComments([])
    setNewComment('')
    setCommentsLoading(true)
    db.ticketComments.list(ticket.id).then(res => {
      if (!res.missing) setTicketComments(res.data)
    }).catch(() => {}).finally(() => setCommentsLoading(false))
  }

  const handleAddComment = async (parentCommentId = null) => {
    if (!newComment.trim() && commentFiles.length === 0) return
    if (!selectedTicket) return
    setSubmittingComment(true)
    try {
      let attachments = []
      for (const file of commentFiles) {
        const result = await storage.uploadCommentAttachment(file, selectedTicket.id)
        if (result) attachments.push(result)
      }
      const comment = await db.ticketComments.create(
        selectedTicket.id,
        newComment.trim(),
        userEmail,
        userEmail,
        isInternalComment,
        parentCommentId,
        attachments
      )
      if (comment) {
        setTicketComments(prev => [...prev, comment])
        const targetEmails = []
        if (selectedTicket?.assigned_technician && selectedTicket.assigned_technician !== userEmail)
          targetEmails.push(selectedTicket.assigned_technician)
        if (selectedTicket?.created_by && selectedTicket.created_by !== userEmail && !targetEmails.includes(selectedTicket.created_by))
          targetEmails.push(selectedTicket.created_by)
        db.notifications.create({
          type: 'comment_added', title: 'New Comment',
          message: `${userEmail} commented on ticket ${selectedTicket.rma_number}`,
          entityType: 'ticket', entityId: selectedTicket.id, entityRef: selectedTicket.rma_number,
          createdBy: userEmail, targetRoles: ['admin', 'super_admin'], targetEmails
        }).catch(() => {})
      }
      setNewComment('')
      setCommentFiles([])
      setReplyingTo(null)
    } catch (err) {
      toast.error('Failed to post comment: ' + (err?.message || err?.code || 'unknown error'))
    } finally {
      setSubmittingComment(false)
    }
  }

  const handleDeleteComment = async (commentId) => {
    try {
      await db.ticketComments.delete(commentId)
      setTicketComments(prev => prev.filter(c => c.id !== commentId))
    } catch {
      toast.error('Failed to delete comment')
    }
  }

  const handleExportPDF = async (ticket) => {
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    let qrCodeUrl = ''
    try { qrCodeUrl = await QRCode.toDataURL(ticket.rma_number) } catch {}

    // Load PDF layout config and branding in parallel
    const PDF_DEFAULT = {
      paperSize: 'A4', orientation: 'portrait', font: 'Arial, sans-serif', fontSize: 11,
      primaryColor: '#4F46E5', headerStyle: 'colored', showLogo: false, logoPosition: 'right',
      showCompanyName: true, showRmaNumber: true, showDate: true,
      sections: { ticketInfo: true, generalDescription: true, products: true, accessories: true, attachments: true, signatureLine: false },
      sectionOrder: ['ticketInfo', 'generalDescription', 'products', 'accessories', 'attachments', 'signatureLine'],
      footerText: '', showGeneratedDate: true, showWatermark: false,
    }
    let pdfCfg = PDF_DEFAULT
    let brandingData = {}
    try {
      const [cfgResult, brd] = await Promise.all([db.rmaConfig.getAll(), brandingAPI.getBranding()])
      if (!cfgResult.missing) {
        const row = cfgResult.data.find(r => r.config_key === 'pdf_layout')
        if (row?.config_value) {
          const val = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
          pdfCfg = {
            ...PDF_DEFAULT, ...val,
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
    const logoUrl = pdfCfg.showLogo ? (brandingData.logo_url || null) : null

    const fmt = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A'
    const fmtTS = (d) => {
      if (!d) return 'N/A'
      const dt = new Date(d)
      return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) + ' at ' + dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    }

    const productsHtml = (ticket.products || []).map((p, i) => `
      <div style="border:1px solid #E5E7EB;border-radius:6px;padding:12px;margin-bottom:12px">
        <h4 style="margin:0 0 8px;font-size:${fontSize + 1}px;color:#1F2937">Product ${i + 1}: ${esc(p.product_name) || '—'}</h4>
        <table style="width:100%;font-size:${fontSize}px;border-collapse:collapse">
          <tr><td style="color:#6B7280;padding:3px 8px;width:40%">Serial Number</td><td style="font-family:monospace"><strong>${esc(p.serial_number) || '—'}</strong></td></tr>
          <tr><td style="color:#6B7280;padding:3px 8px">Product Status</td><td><strong>${esc(p.product_status) || '—'}</strong></td></tr>
          <tr><td style="color:#6B7280;padding:3px 8px">Warranty Status</td><td><strong>${esc(p.warranty_status) || '—'}</strong></td></tr>
          <tr><td colspan="2" style="padding:6px 8px 0"><strong>Issue:</strong> ${esc(p.issue_description) || '—'}</td></tr>
        </table>
      </div>`).join('')

    const attachHtml = (ticket.attachments || []).length
      ? (ticket.attachments || []).map(a => `<li style="margin-bottom:4px">${esc(a.name)} <span style="color:#9CA3AF">(${(a.size / 1024).toFixed(1)} KB)</span></li>`).join('')
      : '<li style="color:#9CA3AF">No attachments</li>'

    const priorityColors = { Critical: '#FEE2E2;color:#991B1B', High: '#FFEDD5;color:#9A3412', Medium: '#DBEAFE;color:#1E40AF', Low: '#F3F4F6;color:#374151' }
    const pc = priorityColors[ticket.priority] || priorityColors.Medium

    const headerBorderStyle = pdfCfg.headerStyle === 'colored'
      ? `border-bottom:3px solid ${color};background:linear-gradient(135deg,${color}15 0%,transparent 100%)`
      : pdfCfg.headerStyle === 'minimal'
        ? 'border-bottom:1px solid #E5E7EB'
        : 'border-bottom:none'

    const logoHtml = logoUrl
      ? `<img src="${logoUrl}" style="max-height:60px;max-width:140px;object-fit:contain" />`
      : ''

    const headerLeft = pdfCfg.logoPosition === 'left'
      ? `<div style="display:flex;align-items:center;gap:12px">${logoHtml}<div>${pdfCfg.showCompanyName ? `<div style="font-size:${fontSize + 4}px;font-weight:bold;color:${color}">${esc(companyName)}</div>` : ''}${pdfCfg.showRmaNumber ? `<div style="font-size:${fontSize + 2}px;color:#6B7280;margin-top:2px">${esc(ticket.rma_number)}</div>` : ''}${pdfCfg.showDate ? `<div style="font-size:${fontSize - 1}px;color:#9CA3AF;margin-top:2px">${esc(fmtTS(ticket.created_date))}</div>` : ''}<div style="margin-top:6px"><span class="badge" style="background:#DBEAFE;color:#1E40AF">${esc(ticket.ticket_status)}</span><span class="badge" style="background:${pc}">${esc(ticket.priority)}</span></div></div></div>`
      : `<div>${pdfCfg.showCompanyName ? `<div style="font-size:${fontSize + 4}px;font-weight:bold;color:${color}">${esc(companyName)}</div>` : ''}${pdfCfg.showRmaNumber ? `<div style="font-size:${fontSize + 2}px;color:#6B7280;margin-top:2px">${esc(ticket.rma_number)}</div>` : ''}${pdfCfg.showDate ? `<div style="font-size:${fontSize - 1}px;color:#9CA3AF;margin-top:2px">${esc(fmtTS(ticket.created_date))}</div>` : ''}<div style="margin-top:6px"><span class="badge" style="background:#DBEAFE;color:#1E40AF">${esc(ticket.ticket_status)}</span><span class="badge" style="background:${pc}">${esc(ticket.priority)}</span></div></div>`

    const headerRight = pdfCfg.logoPosition === 'right'
      ? `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">${logoHtml}${qrCodeUrl ? `<div style="text-align:center"><img src="${qrCodeUrl}" width="80" height="80"/><div style="font-size:10px;color:#6B7280;margin-top:2px">Scan to view</div></div>` : ''}</div>`
      : qrCodeUrl ? `<div style="text-align:center"><img src="${qrCodeUrl}" width="80" height="80"/><div style="font-size:10px;color:#6B7280;margin-top:2px">Scan to view</div></div>` : ''

    const watermarkHtml = pdfCfg.showWatermark ? `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:80px;font-weight:bold;color:${color};opacity:0.05;pointer-events:none;z-index:-1">DRAFT</div>` : ''

    const footerContent = [
      pdfCfg.showGeneratedDate ? `Generated: ${new Date().toLocaleString()}` : '',
      pdfCfg.footerText || companyName
    ].filter(Boolean)

    const w = window.open('', '_blank')
    w.document.write(`<!DOCTYPE html><html><head><title>RMA Ticket - ${ticket.rma_number}</title>
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

      ${pdfCfg.sectionOrder.map(key => {
        if (!sec[key]) return ''
        if (key === 'ticketInfo') return `
        <div class="section">
          <div class="section-title">Ticket Information</div>
          <div class="grid">
            <div><div class="info-label">Customer</div><div class="info-value">${esc(ticket.customer_name) || '—'}</div></div>
            <div><div class="info-label">Assigned To</div><div class="info-value">${esc(ticket.assigned_technician) || 'Unassigned'}</div></div>
            <div><div class="info-label">Due Date</div><div class="info-value">${esc(fmt(ticket.due_date))}</div></div>
            <div><div class="info-label">Created</div><div class="info-value">${esc(fmtTS(ticket.created_date))}</div></div>
            <div><div class="info-label">Created By</div><div class="info-value">${esc(ticket.created_by) || '—'}</div></div>
          </div>
        </div>`
        if (key === 'generalDescription') return ticket.general_description ? `
        <div class="section">
          <div class="section-title">General RMA Description</div>
          <div class="desc-box">${esc(ticket.general_description)}</div>
        </div>` : ''
        if (key === 'products') return `
        <div class="section">
          <div class="section-title">Products (${(ticket.products || []).length})</div>
          ${productsHtml || '<p style="color:#9CA3AF">No products listed</p>'}
        </div>`
        if (key === 'accessories') return ticket.accessories_received ? `
        <div class="section">
          <div class="section-title">Accessories Received</div>
          <div class="desc-box">${esc(ticket.accessories_received)}</div>
        </div>` : ''
        if (key === 'attachments') return `
        <div class="section">
          <div class="section-title">Attachments</div>
          <ul style="padding-left:20px">${attachHtml}</ul>
        </div>`
        if (key === 'signatureLine') return `
        <div class="sig-box">
          <div><div class="sig-line">Customer Signature</div></div>
          <div><div class="sig-line">Technician Signature</div></div>
        </div>`
        return ''
      }).join('')}

      <div class="footer">
        <span>${esc(footerContent[0]) || ''}</span>
        <span>${esc(footerContent[1]) || ''}</span>
      </div>
      <script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>
      </body></html>`)
    w.document.close()
  }

  const handleExport = () => {
    if (!canDo('export')) { toast.error('No permission to export'); return }
    const csv = [
      ['RMA Number', 'Customer', 'Status', 'Priority', 'Assigned To', 'Due Date', 'Created Date'],
      ...filteredTickets.map(t => [t.rma_number, t.customer_name, t.ticket_status, t.priority, t.assigned_technician || 'Unassigned', t.due_date || 'N/A', new Date(t.created_date).toLocaleDateString()])
    ].map(r => r.join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `rma-tickets-${Date.now()}.csv`; a.click()
    toast.success('Exported!')
  }

  const resetForm = () => {
    setFormData({
      customer_name: '', priority: 'Medium', ticket_status: 'New',
      assigned_technician: userEmail || '', due_date: DEFAULT_DUE(),
      general_description: '', accessories_received: '', attachments: [],
      products: [{ ...EMPTY_PRODUCT }]
    })
    setCustomerSearch(''); setProductSearches(['']); setShowProductDropdowns([false]); setPendingFiles([])
  }

  const handleAddNew = () => {
    if (!canDo('create')) { toast.error('No permission to create tickets'); return }
    setEditingTicket(null)
    resetForm()
    setPreviewRmaNumber(generateRmaNumber(tickets))
    setShowModal(true)
  }

  const addProduct = () => {
    setFormData({ ...formData, products: [...formData.products, { ...EMPTY_PRODUCT }] })
    setProductSearches(p => [...p, '']); setShowProductDropdowns(p => [...p, false])
  }

  const removeProduct = (i) => {
    setFormData({ ...formData, products: formData.products.filter((_, idx) => idx !== i) })
    setProductSearches(p => p.filter((_, idx) => idx !== i))
    setShowProductDropdowns(p => p.filter((_, idx) => idx !== i))
  }

  const updateProduct = (i, field, value) => {
    const p = [...formData.products]
    p[i] = { ...p[i], [field]: value }
    if (field === 'product_status') p[i].status_date = new Date().toISOString()
    setFormData({ ...formData, products: p })
  }

  const handleDeleteAttachment = async (att, i) => {
    try {
      if (att.path) await storage.deleteFile(att.path)
      setFormData({ ...formData, attachments: formData.attachments.filter((_, idx) => idx !== i) })
      toast.success('Attachment removed')
    } catch { toast.error('Failed to remove attachment') }
  }

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files)
    const total = (formData.attachments?.length || 0) + pendingFiles.length + files.length
    if (total > 10) { toast.error('Maximum 10 attachments per ticket'); return }
    setPendingFiles(prev => [...prev, ...files]); e.target.value = ''
  }

  const getStatusColor = (s) => ({ New: 'bg-pink-100 text-pink-800', 'In Progress': 'bg-blue-100 text-blue-800', 'On Hold': 'bg-yellow-100 text-yellow-800', Completed: 'bg-green-100 text-green-800', Cancelled: 'bg-gray-100 text-gray-800' }[s] || 'bg-gray-100 text-gray-800')
  const getPriorityColor = (p) => ({ Low: 'bg-gray-100 text-gray-800', Medium: 'bg-blue-100 text-blue-800', High: 'bg-orange-100 text-orange-800', Critical: 'bg-red-100 text-red-800' }[p] || 'bg-gray-100 text-gray-800')
  const fmt = (d) => d ? new Date(d).toLocaleDateString() : 'N/A'
  const SLABadge = ({ dueDate, status }) => {
    if (!dueDate || ['Completed', 'Cancelled'].includes(status)) return <span className="text-gray-400 text-xs">{dueDate ? fmt(dueDate) : '—'}</span>
    const days = Math.ceil((new Date(dueDate) - Date.now()) / 86400000)
    if (days < 0) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">Overdue {Math.abs(days)}d</span>
    if (days === 0) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">Due today</span>
    if (days <= 2) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">{days}d left</span>
    if (days <= 5) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-700">{days}d left</span>
    return <span className="text-xs text-gray-500">{fmt(dueDate)}</span>
  }
  const fmtDateTime = (d) => {
    if (!d) return 'N/A'
    const dt = new Date(d)
    return dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  const fmtBytes = (b) => b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`
  const isImage = (t) => t?.startsWith('image/')

  const inp = "w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-sm bg-white placeholder-gray-400 transition-colors"
  const lbl = "block text-sm font-medium text-gray-700 mb-1.5"

  if (loading) return <PageSkeleton cols={9} />

  return (
    <div className="space-y-6">

      {/* Header */}
      <PageHeader title="RMA Tickets" subtitle="Manage return merchandise authorization" />

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-1 max-w-2xl">
          <div className="relative flex-1">
            <input ref={searchInputRef} type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by RMA number, customer, status, priority... (Press / to focus)"
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent" />
            <svg className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          </div>
          <button onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${showFilters || filterStatus || filterPriority || filterAssigned || filterCustomer ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" /></svg>
            Filters
            {(filterStatus || filterPriority || filterAssigned || filterCustomer) && (
              <span className="w-4 h-4 bg-indigo-600 text-white text-xs rounded-full flex items-center justify-center">
                {[filterStatus, filterPriority, filterAssigned, filterCustomer].filter(Boolean).length}
              </span>
            )}
          </button>
        </div>
        <div className="flex items-center gap-2">
          {canDo('export') && (
            <Button variant="secondary" onClick={handleExport}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              Export
            </Button>
          )}
          {canDo('create') && (
            <Button onClick={handleAddNew}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
              Create Ticket
            </Button>
          )}
        </div>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Status:</label>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600">
              <option value="">All</option>
              <option value="New">New</option>
              <option value="In Progress">In Progress</option>
              <option value="On Hold">On Hold</option>
              <option value="Completed">Completed</option>
              <option value="Cancelled">Cancelled</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Priority:</label>
            <select value={filterPriority} onChange={e => setFilterPriority(e.target.value)} className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600">
              <option value="">All</option>
              <option value="Low">Low</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
              <option value="Critical">Critical</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Assigned To:</label>
            <select value={filterAssigned} onChange={e => setFilterAssigned(e.target.value)} className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600">
              <option value="">All</option>
              {[...new Set(tickets.map(t => t.assigned_technician).filter(Boolean))].sort().map(email => (
                <option key={email} value={email}>{email}</option>
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
                  onChange={e => { setFilterCustomerSearch(e.target.value); setShowFilterCustomerDropdown(true); if (!e.target.value) { setFilterCustomer('') } }}
                  onFocus={() => setShowFilterCustomerDropdown(true)}
                  placeholder={filterCustomer || 'All customers...'}
                  className={`w-52 px-3 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 ${filterCustomer ? 'border-indigo-400 bg-indigo-50 pr-7' : 'border-gray-300'}`}
                />
                {filterCustomer && (
                  <button type="button" onMouseDown={e => { e.preventDefault(); setFilterCustomer(''); setFilterCustomerSearch('') }}
                    className="absolute right-2 text-gray-400 hover:text-gray-600">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                )}
              </div>
              {showFilterCustomerDropdown && (() => {
                const q = filterCustomerSearch.toLowerCase()
                const dbNames = customers.map(c => c.customer_type === 'B2B' && c.company_name ? c.company_name : c.contact_person).filter(Boolean)
                const ticketNames = tickets.map(t => t.customer_name).filter(Boolean)
                const allNames = [...new Set([...dbNames, ...ticketNames])].sort()
                const filtered = q ? allNames.filter(n => n.toLowerCase().includes(q)) : allNames
                return filtered.length > 0 ? (
                  <div className="absolute z-30 left-0 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-xl max-h-52 overflow-y-auto">
                    {filtered.map(name => (
                      <button key={name} type="button"
                        onMouseDown={e => { e.preventDefault(); setFilterCustomer(name); setFilterCustomerSearch(''); setShowFilterCustomerDropdown(false) }}
                        className={`w-full px-3 py-2 text-left text-sm hover:bg-indigo-50 ${filterCustomer === name ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-gray-700'}`}>
                        {name}
                      </button>
                    ))}
                  </div>
                ) : null
              })()}
            </div>
          </div>
          {(filterStatus || filterPriority || filterAssigned || filterCustomer) && (
            <button onClick={() => { setFilterStatus(''); setFilterPriority(''); setFilterAssigned(''); setFilterCustomer(''); setFilterCustomerSearch('') }}
              className="text-sm text-red-600 hover:underline">Clear all</button>
          )}
        </div>
      )}

      {/* Pagination top bar */}
      <div className="flex items-center justify-between text-sm text-gray-600">
        <div>Showing {filteredTickets.length === 0 ? 0 : startIndex + 1}–{endIndex} of {filteredTickets.length} tickets</div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Items per page:</label>
          <select value={itemsPerPage} onChange={(e) => { setItemsPerPage(parseInt(e.target.value)); setCurrentPage(1) }}
            className="px-3 py-1 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600">
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
            <span className="w-6 h-6 bg-indigo-600 text-white rounded-full flex items-center justify-center text-xs font-bold">{selectedTickets.length}</span>
            ticket{selectedTickets.length !== 1 ? 's' : ''} selected
          </div>
          <button onClick={() => setSelectedTickets([])} className="text-xs text-indigo-500 hover:text-indigo-700 underline">Clear</button>
          <div className="h-5 w-px bg-indigo-200 hidden sm:block" />

          {/* Change ticket status */}
          {(canDo('edit_all') || canDo('change_status')) && (
            <div className="flex items-center gap-1.5">
              <select value={bulkTicketStatus} onChange={e => setBulkTicketStatus(e.target.value)}
                className="px-2.5 py-1.5 border border-indigo-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                <option value="">Ticket Status…</option>
                <option>New</option>
                <option>In Progress</option>
                <option>On Hold</option>
                <option>Completed</option>
                <option>Cancelled</option>
              </select>
              <button onClick={handleBulkTicketStatus} disabled={!bulkTicketStatus || bulkProcessing}
                className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors">
                Apply
              </button>
            </div>
          )}

          {/* Change product status */}
          {(canDo('edit_all') || canDo('edit_assigned')) && (
            <div className="flex items-center gap-1.5">
              <select value={bulkProductStatus} onChange={e => setBulkProductStatus(e.target.value)}
                className="px-2.5 py-1.5 border border-indigo-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                <option value="">Product Status…</option>
                <option>Received</option>
                <option>Under Repair</option>
                <option>Repaired</option>
                <option>Can't Repair</option>
                <option>Replacement</option>
                <option>Credit Note</option>
              </select>
              <button onClick={handleBulkProductStatus} disabled={!bulkProductStatus || bulkProcessing}
                className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors">
                Apply
              </button>
            </div>
          )}

          {/* Delete */}
          {canDo('delete') && (
            <>
              <div className="h-5 w-px bg-indigo-200 hidden sm:block" />
              <button onClick={handleBulkDelete} disabled={bulkProcessing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 disabled:opacity-40 transition-colors">
                {bulkProcessing
                  ? <div className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                  : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                }
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
                <input type="checkbox"
                  checked={paginatedTickets.length > 0 && selectedTickets.length === paginatedTickets.length}
                  onChange={toggleSelectAll}
                  className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer" />
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-400 uppercase w-10">#</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"><SortableHeader label="RMA Number" sortKey="rma_number" sortConfig={sortConfig} onSort={handleSort} /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"><SortableHeader label="Customer" sortKey="customer_name" sortConfig={sortConfig} onSort={handleSort} /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"><SortableHeader label="Status" sortKey="ticket_status" sortConfig={sortConfig} onSort={handleSort} /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"><SortableHeader label="Priority" sortKey="priority" sortConfig={sortConfig} onSort={handleSort} /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"><SortableHeader label="Assigned To" sortKey="assigned_technician" sortConfig={sortConfig} onSort={handleSort} /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"><SortableHeader label="Created Date" sortKey="created_date" sortConfig={sortConfig} onSort={handleSort} /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {paginatedTickets.map((t, idx) => (
                  <tr key={t.id} className={`hover:bg-gray-50 transition-colors ${selectedTickets.includes(t.id) ? 'bg-indigo-50/60' : ''}`}>
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selectedTickets.includes(t.id)} onChange={() => toggleSelectTicket(t.id)}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer" />
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-400 tabular-nums">{startIndex + idx + 1}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => handleViewDetails(t)} className="font-mono text-sm font-medium text-indigo-600 hover:text-indigo-800">{t.rma_number}</button>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">{t.customer_name}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(t.ticket_status)}`}>{t.ticket_status}</span></td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 text-xs font-medium rounded-full ${getPriorityColor(t.priority)}`}>{t.priority}</span></td>
                    <td className="px-4 py-3 text-sm text-gray-600">{t.assigned_technician || 'Unassigned'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{fmt(t.created_date)}</td>
                    <td className="px-4 py-3 relative action-menu">
                      <button onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === t.id ? null : t.id) }}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                      </button>
                      {openMenuId === t.id && (
                        <div className="absolute right-0 top-9 z-30 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                          <button onClick={() => { handleViewDetails(t); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5">
                            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                            View
                          </button>
                          {(canDo('edit_all') || canDo('edit_assigned')) && (
                            <button onClick={() => { handleEdit(t); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5">
                              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                              Edit
                            </button>
                          )}
                          <button onClick={() => { handleExportPDF(t); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5">
                            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                            Export PDF
                          </button>
                          {canDo('delete') && (
                            <button onClick={() => { handleDelete(t.id); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2.5">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                              Delete
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {paginatedTickets.length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-20 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center">
                        <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                        </svg>
                      </div>
                      <div>
                        <p className="font-semibold text-gray-700">No tickets found</p>
                        <p className="text-sm text-gray-400 mt-0.5">
                          {tickets.length > 0 ? 'Try adjusting your filters or search term' : 'Create your first RMA ticket to get started'}
                        </p>
                      </div>
                      {canDo('create') && tickets.length === 0 && (
                        <button onClick={handleAddNew} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                          Create First Ticket
                        </button>
                      )}
                    </div>
                  </td></tr>
                )}
              </tbody>
            </table>
      </div>

      {/* Pagination footer */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-4 border-t border-gray-200">
          <div className="flex items-center gap-2">
            <button onClick={() => handlePageChange(currentPage - 1)} disabled={currentPage === 1}
              className="px-3 py-2 border border-gray-300 rounded text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">Previous</button>
            <div className="flex items-center gap-1">{renderPageNumbers()}</div>
            <button onClick={() => handlePageChange(currentPage + 1)} disabled={currentPage === totalPages}
              className="px-3 py-2 border border-gray-300 rounded text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">Next</button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">Jump to page:</span>
            <input type="number" min="1" max={totalPages} value={jumpToPage}
              onChange={(e) => setJumpToPage(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleJumpToPage()}
              placeholder={currentPage.toString()}
              className="w-20 px-3 py-1 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600" />
            <button onClick={handleJumpToPage} className="px-3 py-1 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">Go</button>
          </div>
        </div>
      )}

      {/* ─── CREATE / EDIT MODAL ─── */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-8">

            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
              <div>
                <h2 className="text-xl font-bold text-gray-900">{editingTicket ? 'Edit RMA Ticket' : 'Create New RMA Ticket'}</h2>
                <div className="flex items-center gap-3 mt-1">
                  <p className="text-xs text-gray-400"><span className="text-red-500">*</span> Required fields</p>
                  {!editingTicket && (
                    <span className="text-xs font-mono font-medium text-indigo-600 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded">
                      {previewRmaNumber}
                    </span>
                  )}
                  {editingTicket && (
                    <span className="text-xs font-mono font-medium text-gray-500 bg-gray-100 border border-gray-200 px-2 py-0.5 rounded">
                      {editingTicket.rma_number}
                    </span>
                  )}
                </div>
              </div>
              <button onClick={() => { setShowModal(false); setEditingTicket(null); resetForm() }} className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="px-6 py-5 space-y-5 max-h-[72vh] overflow-y-auto">

                {/* Row 1: Customer + Priority */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={lbl}>Customer Name <span className="text-red-500">*</span></label>
                    <div className="relative customer-dropdown">
                      <input
                        type="text"
                        value={customerSearch}
                        onChange={(e) => { setCustomerSearch(e.target.value); setFormData({ ...formData, customer_name: e.target.value }); setShowCustomerDropdown(true) }}
                        onFocus={() => setShowCustomerDropdown(true)}
                        placeholder="Search customer..."
                        className={inp}
                        required
                      />
                      {showCustomerDropdown && filteredCustomersList.length > 0 && (
                        <div className="absolute z-30 w-full bg-white border border-gray-200 rounded-lg shadow-xl mt-1 max-h-64 overflow-y-auto">
                          {filteredCustomersList.map(c => {
                            const displayName = c.customer_type === 'B2B' && c.company_name ? c.company_name : c.contact_person
                            return (
                              <button key={c.id} type="button"
                                onMouseDown={(e) => { e.preventDefault(); setCustomerSearch(displayName); setFormData({ ...formData, customer_name: displayName }); setShowCustomerDropdown(false) }}
                                className="w-full px-4 py-2.5 text-left hover:bg-indigo-50 border-b border-gray-100 last:border-0"
                              >
                                <div className="text-sm font-medium text-gray-900">{displayName}</div>
                                {c.customer_type === 'B2B' && c.contact_person && c.company_name && (
                                  <div className="text-xs text-gray-500">{c.contact_person} · <span className="font-medium text-blue-600">B2B</span></div>
                                )}
                                {c.customer_type === 'B2C' && (
                                  <div className="text-xs text-gray-500"><span className="font-medium text-emerald-600">B2C</span>{c.mobile ? ` · ${c.mobile}` : ''}</div>
                                )}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                  <div>
                    <label className={lbl}>Priority <span className="text-red-500">*</span></label>
                    <select value={formData.priority} onChange={(e) => setFormData({ ...formData, priority: e.target.value })} className={inp}>
                      <option value="Low">Low</option>
                      <option value="Medium">Medium</option>
                      <option value="High">High</option>
                      <option value="Critical">Critical</option>
                    </select>
                  </div>
                </div>

                {/* Row 2: Status + Assigned To + Due Date */}
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className={lbl}>Ticket Status</label>
                    <select value={formData.ticket_status} onChange={(e) => setFormData({ ...formData, ticket_status: e.target.value })} className={inp}>
                      <option value="New">New</option>
                      <option value="In Progress">In Progress</option>
                      <option value="On Hold">On Hold</option>
                      <option value="Completed">Completed</option>
                      <option value="Cancelled">Cancelled</option>
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Assigned To</label>
                    {(userRole === 'admin' || userRole === 'super_admin') ? (
                      <select value={formData.assigned_technician}
                        onChange={(e) => setFormData({ ...formData, assigned_technician: e.target.value })}
                        className={inp}>
                        {users.map(u => (
                          <option key={u.user_email} value={u.user_email}>{u.user_email}</option>
                        ))}
                      </select>
                    ) : (
                      <div className={`${inp} bg-gray-50 text-gray-600 cursor-not-allowed`}>
                        {formData.assigned_technician || userEmail || '—'}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className={lbl}>Due Date <span className="text-xs text-gray-400 font-normal ml-1">auto +7 days</span></label>
                    <input type="date" value={formData.due_date}
                      onChange={(e) => setFormData({ ...formData, due_date: e.target.value })} className={inp} />
                  </div>
                </div>

                {/* Products */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-semibold text-gray-900">Products</h3>
                    <button type="button" onClick={addProduct} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">+ Add Product</button>
                  </div>
                  {formData.products.map((product, idx) => (
                    <div key={idx} className="border border-gray-200 rounded-xl p-4 mb-4 bg-gray-50">
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="font-medium text-gray-800 text-sm">Product {idx + 1}</h4>
                        {formData.products.length > 1 && (
                          <button type="button" onClick={() => removeProduct(idx)} className="text-red-500 hover:text-red-700 text-xs font-medium">Remove</button>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {/* Product name combobox */}
                        <div>
                          <label className={lbl}>Product Name <span className="text-red-500">*</span></label>
                          <div className="relative product-dropdown">
                            <input type="text"
                              value={productSearches[idx] || ''}
                              onChange={(e) => {
                                const s = [...productSearches]; s[idx] = e.target.value; setProductSearches(s)
                                updateProduct(idx, 'product_name', e.target.value)
                                const d = [...showProductDropdowns]; d[idx] = true; setShowProductDropdowns(d)
                              }}
                              onFocus={() => { const d = [...showProductDropdowns]; d[idx] = true; setShowProductDropdowns(d) }}
                              placeholder="Search or type product..."
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent text-sm bg-white"
                              required
                            />
                            {showProductDropdowns[idx] && filteredProductsList(productSearches[idx]).length > 0 && (
                              <div className="absolute z-30 w-full bg-white border border-gray-200 rounded-lg shadow-xl mt-1 max-h-40 overflow-y-auto">
                                {filteredProductsList(productSearches[idx]).map(p => (
                                  <button key={p.id} type="button"
                                    onMouseDown={(e) => {
                                      e.preventDefault()
                                      const s = [...productSearches]; s[idx] = p.product_name; setProductSearches(s)
                                      updateProduct(idx, 'product_name', p.product_name)
                                      const d = [...showProductDropdowns]; d[idx] = false; setShowProductDropdowns(d)
                                    }}
                                    className="w-full px-3 py-2 text-left hover:bg-indigo-50 border-b border-gray-100 last:border-0"
                                  >
                                    <div className="text-sm font-medium text-gray-900">{p.product_name}</div>
                                    <div className="text-xs text-gray-500">{p.sku}{p.brand?.brand_name ? ` · ${p.brand.brand_name}` : ''}</div>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        <div>
                          <label className={lbl}>Serial Number <span className="text-red-500">*</span></label>
                          <input type="text" value={product.serial_number} onChange={(e) => updateProduct(idx, 'serial_number', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 text-sm bg-white" required />
                        </div>
                        <div>
                          <label className={lbl}>Product Status</label>
                          <select value={product.product_status} onChange={(e) => updateProduct(idx, 'product_status', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 text-sm bg-white">
                            <option>Received</option>
                            <option>Under Repair</option>
                            <option>Repaired</option>
                            <option>Can't Repair</option>
                            <option>Replacement</option>
                            <option>Credit Note</option>
                          </select>
                        </div>
                        <div>
                          <label className={lbl}>Warranty Status</label>
                          <select value={product.warranty_status} onChange={(e) => updateProduct(idx, 'warranty_status', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 text-sm bg-white">
                            <option>In Warranty</option>
                            <option>Out of Warranty</option>
                            <option>Extended Warranty</option>
                          </select>
                        </div>
                      </div>
                      <div className="mt-3">
                        <label className={lbl}>Issue Description <span className="text-red-500">*</span></label>
                        <textarea value={product.issue_description} onChange={(e) => updateProduct(idx, 'issue_description', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 text-sm bg-white" rows={3} required />
                      </div>
                    </div>
                  ))}
                </div>

                {/* General RMA Description */}
                <div>
                  <label className={lbl}>General RMA Description</label>
                  <textarea value={formData.general_description}
                    onChange={(e) => setFormData({ ...formData, general_description: e.target.value })}
                    placeholder="General description for the RMA ticket (optional)..."
                    className={inp} rows={3} />
                </div>

                {/* Accessories Received */}
                <div>
                  <label className={lbl}>Accessories Received</label>
                  <textarea value={formData.accessories_received}
                    onChange={(e) => setFormData({ ...formData, accessories_received: e.target.value })}
                    placeholder="List any accessories received with the device..."
                    className={inp} rows={3} />
                </div>

                {/* Attachments */}
                <div>
                  <label className={lbl}>
                    Attachments
                    <span className="text-xs text-gray-400 font-normal ml-2">({(formData.attachments?.length || 0) + pendingFiles.length}/10)</span>
                  </label>

                  {/* Uploaded attachments */}
                  {(formData.attachments || []).length > 0 && (
                    <div className="mb-3 space-y-2">
                      {formData.attachments.map((att, i) => (
                        <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
                          {isImage(att.type)
                            ? <img src={att.url} alt={att.name} className="w-10 h-10 object-cover rounded flex-shrink-0" />
                            : <div className="w-10 h-10 bg-indigo-100 rounded flex items-center justify-center flex-shrink-0">
                                <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                              </div>
                          }
                          <div className="flex-1 min-w-0">
                            <a href={att.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-indigo-600 hover:underline truncate block">{att.name}</a>
                            <p className="text-xs text-gray-400">{fmtBytes(att.size)}</p>
                          </div>
                          <button type="button" onClick={() => handleDeleteAttachment(att, i)} className="text-red-400 hover:text-red-600 p-1 flex-shrink-0">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Pending files */}
                  {pendingFiles.length > 0 && (
                    <div className="mb-3 space-y-2">
                      {pendingFiles.map((f, i) => (
                        <div key={i} className="flex items-center gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
                          <div className="w-10 h-10 bg-amber-100 rounded flex items-center justify-center flex-shrink-0">
                            <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{f.name}</p>
                            <p className="text-xs text-amber-600">{fmtBytes(f.size)} · Will upload on save</p>
                          </div>
                          <button type="button" onClick={() => setPendingFiles(p => p.filter((_, idx) => idx !== i))} className="text-red-400 hover:text-red-600 p-1 flex-shrink-0">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Drop zone */}
                  {(formData.attachments?.length || 0) + pendingFiles.length < 10 && (
                    <label className="border-2 border-dashed border-gray-300 rounded-xl p-6 text-center cursor-pointer hover:border-indigo-400 transition-colors block">
                      <svg className="w-10 h-10 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                      <p className="text-sm font-medium text-indigo-600">Click to upload or drag and drop</p>
                      <p className="text-xs text-gray-400 mt-1">Up to 10 files · Images, PDFs, documents</p>
                      <input ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" />
                    </label>
                  )}
                </div>

              </div>

              {/* Footer */}
              <div className="flex gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
                <Button variant="secondary" type="button" className="flex-1 justify-center" onClick={() => { setShowModal(false); setEditingTicket(null); resetForm() }}>
                  Cancel
                </Button>
                <Button type="submit" loading={uploading} className="flex-1 justify-center">
                  {editingTicket ? 'Update Ticket' : 'Create Ticket'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── DETAILS MODAL ─── */}
      {showDetailsModal && selectedTicket && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-8">

            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Ticket Details</h2>
                <p className="text-sm font-mono text-indigo-600 mt-0.5">{selectedTicket.rma_number}</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleExportPDF(selectedTicket)}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                  Export PDF
                </button>
                <button onClick={() => setShowDetailsModal(false)} className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>

            <div className="px-6 py-5 space-y-6 max-h-[72vh] overflow-y-auto">

              {/* Info grid */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Ticket Information</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {[
                    { label: 'Customer', value: selectedTicket.customer_name },
                    { label: 'Status', value: <span className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(selectedTicket.ticket_status)}`}>{selectedTicket.ticket_status}</span> },
                    { label: 'Priority', value: <span className={`px-2 py-1 text-xs font-medium rounded-full ${getPriorityColor(selectedTicket.priority)}`}>{selectedTicket.priority}</span> },
                    { label: 'Assigned To', value: selectedTicket.assigned_technician || 'Unassigned' },
                    { label: 'Due Date', value: fmt(selectedTicket.due_date) },
                    { label: 'Created', value: fmtDateTime(selectedTicket.created_date) },
                    { label: 'Created By', value: selectedTicket.created_by || '—' },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-xs text-gray-500 mb-1">{label}</p>
                      <div className="text-sm font-medium text-gray-900">{value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* General description */}
              {selectedTicket.general_description && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">General RMA Description</h3>
                  <div className="bg-gray-50 rounded-xl p-4 text-sm text-gray-700 whitespace-pre-wrap">{selectedTicket.general_description}</div>
                </div>
              )}

              {/* Products */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Products ({(selectedTicket.products || []).length})</h3>
                {(selectedTicket.products || []).map((p, i) => (
                  <div key={i} className="border border-gray-200 rounded-xl p-4 mb-3">
                    <h4 className="font-semibold text-gray-800 text-sm mb-3">Product {i + 1} — {p.product_name}</h4>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div><p className="text-xs text-gray-500">Serial Number</p><p className="font-mono font-medium">{p.serial_number || '—'}</p></div>
                      <div><p className="text-xs text-gray-500">Product Status</p><p className="font-medium">{p.product_status}</p></div>
                      <div><p className="text-xs text-gray-500">Warranty Status</p><p className="font-medium">{p.warranty_status}</p></div>
                      <div className="col-span-2"><p className="text-xs text-gray-500">Issue Description</p><p className="font-medium">{p.issue_description}</p></div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Accessories */}
              {selectedTicket.accessories_received && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Accessories Received</h3>
                  <div className="bg-gray-50 rounded-xl p-4 text-sm text-gray-700 whitespace-pre-wrap">{selectedTicket.accessories_received}</div>
                </div>
              )}

              {/* Attachments */}
              {selectedTicket.attachments?.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Attachments ({selectedTicket.attachments.length})</h3>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {selectedTicket.attachments.map((att, i) => (
                      <a key={i} href={att.url} target="_blank" rel="noreferrer"
                        className="flex flex-col items-center p-3 border border-gray-200 rounded-xl hover:bg-indigo-50 hover:border-indigo-300 transition-colors group">
                        {isImage(att.type)
                          ? <img src={att.url} alt={att.name} className="w-full h-24 object-cover rounded-lg mb-2" />
                          : <div className="w-full h-24 bg-gray-100 rounded-lg flex items-center justify-center mb-2">
                              <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                            </div>
                        }
                        <p className="text-xs font-medium text-gray-700 group-hover:text-indigo-600 truncate w-full text-center">{att.name}</p>
                        <p className="text-xs text-gray-400">{fmtBytes(att.size)}</p>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Comments & Communication ── */}
              <div className="border-t border-gray-200 pt-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Comments & Communication</h3>
                  <span className="text-xs text-gray-400">{ticketComments.length} comment{ticketComments.length !== 1 ? 's' : ''}</span>
                </div>

                {commentsLoading ? (
                  <div className="flex justify-center py-6">
                    <Spinner size="md" />
                  </div>
                ) : ticketComments.filter(c => !c.parent_comment_id).length === 0 ? (
                  <div className="text-center py-6 text-gray-400 text-sm">No comments yet. Start the conversation below.</div>
                ) : (
                  <div className="space-y-3 mb-4">
                    {ticketComments.filter(c => !c.parent_comment_id).map(comment => {
                      const replies = ticketComments.filter(r => r.parent_comment_id === comment.id)
                      const displayName = comment.author_name || comment.user_email || '?'
                      const initials = displayName[0].toUpperCase()
                      const ts = new Date(comment.created_date)
                      const dateStr = ts.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                      const timeStr = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
                      return (
                        <div key={comment.id}>
                          <div className={`flex gap-3 p-4 rounded-xl border ${comment.is_internal ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
                            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 ${comment.is_internal ? 'bg-amber-500' : comment.is_customer_comment ? 'bg-green-500' : 'bg-indigo-500'}`}>
                              {initials}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <span className="text-sm font-semibold text-gray-900">{displayName}</span>
                                {comment.is_internal && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200">Internal</span>}
                                {comment.is_customer_comment && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-200">Customer</span>}
                                <span className="text-xs text-gray-400">{dateStr} · {timeStr}</span>
                              </div>
                              <p className="text-sm text-gray-700 whitespace-pre-wrap">{comment.comment_text}</p>
                              {comment.attachments?.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {comment.attachments.map((att, i) => (
                                    <a key={i} href={att.url} target="_blank" rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 px-2 py-1 bg-white border border-gray-200 rounded-lg text-xs text-indigo-600 hover:text-indigo-800 hover:border-indigo-300 transition-colors">
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                                      {att.name}
                                    </a>
                                  ))}
                                </div>
                              )}
                              <button onClick={() => { setReplyingTo(replyingTo === comment.id ? null : comment.id); setNewComment(''); setCommentFiles([]) }}
                                className="mt-2 text-xs text-gray-400 hover:text-indigo-600 transition-colors flex items-center gap-1">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                                Reply{replies.length > 0 ? ` (${replies.length})` : ''}
                              </button>
                            </div>
                            {(userRole === 'admin' || userRole === 'super_admin') && (
                              <button onClick={() => handleDeleteComment(comment.id)}
                                className="text-gray-300 hover:text-red-500 flex-shrink-0 self-start p-1 transition-colors" title="Delete comment">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            )}
                          </div>

                          {replies.length > 0 && (
                            <div className="ml-8 mt-2 space-y-2">
                              {replies.map(reply => {
                                const rName = reply.author_name || reply.user_email || '?'
                                const rTs = new Date(reply.created_date)
                                return (
                                  <div key={reply.id} className={`flex gap-3 p-3 rounded-xl border ${reply.is_internal ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200'}`}>
                                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white font-semibold text-xs flex-shrink-0 ${reply.is_internal ? 'bg-amber-400' : reply.is_customer_comment ? 'bg-green-400' : 'bg-indigo-400'}`}>
                                      {rName[0].toUpperCase()}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2 flex-wrap mb-1">
                                        <span className="text-xs font-semibold text-gray-900">{rName}</span>
                                        {reply.is_internal && <span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200">Internal</span>}
                                        {reply.is_customer_comment && <span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-200">Customer</span>}
                                        <span className="text-xs text-gray-400">
                                          {rTs.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {rTs.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                      </div>
                                      <p className="text-sm text-gray-700 whitespace-pre-wrap">{reply.comment_text}</p>
                                      {reply.attachments?.length > 0 && (
                                        <div className="mt-2 flex flex-wrap gap-2">
                                          {reply.attachments.map((att, i) => (
                                            <a key={i} href={att.url} target="_blank" rel="noopener noreferrer"
                                              className="inline-flex items-center gap-1 px-2 py-1 bg-white border border-gray-200 rounded-lg text-xs text-indigo-600 hover:text-indigo-800 hover:border-indigo-300 transition-colors">
                                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                                              {att.name}
                                            </a>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                    {(userRole === 'admin' || userRole === 'super_admin') && (
                                      <button onClick={() => handleDeleteComment(reply.id)}
                                        className="text-gray-300 hover:text-red-500 flex-shrink-0 self-start p-1 transition-colors">
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                      </button>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {replyingTo === comment.id && (
                            <div className="ml-8 mt-2 bg-white border border-indigo-200 rounded-xl p-3 space-y-2">
                              <div className="flex items-center gap-1.5 mb-1">
                                <svg className="w-3 h-3 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                                <span className="text-xs text-indigo-600 font-medium">Replying to {displayName}</span>
                              </div>
                              <textarea
                                value={newComment}
                                onChange={e => setNewComment(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAddComment(comment.id) }}
                                rows={2}
                                placeholder="Write a reply... (Ctrl+Enter to submit)"
                                className="w-full text-sm text-gray-700 resize-none outline-none placeholder-gray-400"
                                autoFocus
                              />
                              {commentFiles.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {commentFiles.map((f, i) => (
                                    <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-600">
                                      {f.name}
                                      <button onClick={() => setCommentFiles(prev => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">×</button>
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-3">
                                  <button onClick={() => commentFileInputRef.current?.click()} className="text-gray-400 hover:text-indigo-600 transition-colors" title="Attach file">
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                                  </button>
                                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                                    <div onClick={() => setIsInternalComment(v => !v)}
                                      className={`relative w-8 h-4 rounded-full transition-colors ${isInternalComment ? 'bg-amber-500' : 'bg-gray-200'}`}>
                                      <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ${isInternalComment ? 'translate-x-4' : ''}`} />
                                    </div>
                                    <span className="text-xs text-gray-500">Internal</span>
                                  </label>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button onClick={() => { setReplyingTo(null); setNewComment(''); setCommentFiles([]) }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                                  <button onClick={() => handleAddComment(comment.id)}
                                    disabled={!newComment.trim() || submittingComment}
                                    className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                                    {submittingComment ? <Spinner size="sm" color="white" /> : 'Reply'}
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {!replyingTo && (
                  <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-3">
                    <textarea
                      value={newComment}
                      onChange={e => setNewComment(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAddComment() }}
                      rows={3}
                      placeholder="Write a comment... (Ctrl+Enter to submit)"
                      className="w-full text-sm text-gray-700 resize-none outline-none placeholder-gray-400"
                    />
                    {commentFiles.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {commentFiles.map((f, i) => (
                          <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-600">
                            {f.name}
                            <button onClick={() => setCommentFiles(prev => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">×</button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <button onClick={() => commentFileInputRef.current?.click()} className="text-gray-400 hover:text-indigo-600 transition-colors" title="Attach file">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                        </button>
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <div onClick={() => setIsInternalComment(v => !v)}
                            className={`relative w-9 h-5 rounded-full transition-colors ${isInternalComment ? 'bg-amber-500' : 'bg-gray-200'}`}>
                            <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${isInternalComment ? 'translate-x-4' : ''}`} />
                          </div>
                          <span className="text-xs text-gray-600">Internal only</span>
                        </label>
                      </div>
                      <button
                        onClick={() => handleAddComment()}
                        disabled={(!newComment.trim() && commentFiles.length === 0) || submittingComment}
                        className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                        {submittingComment
                          ? <Spinner size="sm" color="white" />
                          : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                        }
                        Post
                      </button>
                    </div>
                  </div>
                )}
                <input type="file" multiple ref={commentFileInputRef} className="hidden"
                  onChange={e => { setCommentFiles(prev => [...prev, ...Array.from(e.target.files)]); e.target.value = '' }} />
              </div>

            </div>

            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200">
              {(canDo('edit_all') || canDo('edit_assigned')) && (
                <Button onClick={() => { setShowDetailsModal(false); handleEdit(selectedTicket) }}>
                  Edit Ticket
                </Button>
              )}
              <Button variant="secondary" onClick={() => setShowDetailsModal(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
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
