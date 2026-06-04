import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
const BarcodeScannerModule = lazy(() => import('../../components/BarcodeScanner'))
const BarcodeScanner = (props) => (
  <Suspense fallback={null}><BarcodeScannerModule {...props} /></Suspense>
)
import { useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { db, storage, notifications } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { notificationEventBus } from '../../lib/events/NotificationEventBus.js'
import Modal from '../../components/Modal'
import { Button } from '../../components/ui'
import { ROLES } from '../../lib/constants'
import { captureException } from '../../lib/sentry'
import { ticketSchema, getFirstError } from '../../lib/schemas'
import {
  generateRmaNumber,
  DEFAULT_DUE,
  EMPTY_PRODUCT,
  CARRIERS,
  fmtBytes,
  isImage,
} from './_utils'

const inp =
  'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-sm bg-white placeholder-gray-400 transition-colors'
const lbl = 'block text-sm font-medium text-gray-700 mb-1.5'

export function TicketForm({
  editingTicket,
  onClose,
  onSaved,
  customers = [],
  products = [],
  users = [],
  tickets = [],
  userEmail,
  userRole,
  userPermissions,
}) {
  const queryClient = useQueryClient()

  const canDo = (action) => {
    if (userRole === ROLES.ADMIN || userRole === ROLES.SUPER_ADMIN) return true
    return userPermissions?.rma_tickets?.[action] === true
  }

  const [formData, setFormData] = useState(() => {
    if (editingTicket) {
      const prods = editingTicket.products?.length ? editingTicket.products : [{ ...EMPTY_PRODUCT }]
      return {
        customer_name: editingTicket.customer_name || '',
        customer_id: editingTicket.customer_id || '',
        customer_email: editingTicket.customer_email || '',
        priority: editingTicket.priority || 'Medium',
        ticket_status: editingTicket.ticket_status || 'Open',
        assigned_technician: editingTicket.assigned_technician || '',
        due_date: editingTicket.due_date || '',
        general_description: editingTicket.general_description || '',
        accessories_received: editingTicket.accessories_received || '',
        attachments: editingTicket.attachments || [],
        products: prods,
        carrier: editingTicket.carrier || '',
        tracking_number: editingTicket.tracking_number || '',
        shipping_label_url: editingTicket.shipping_label_url || '',
      }
    }
    return {
      customer_name: '',
      customer_id: '',
      customer_email: '',
      priority: 'Medium',
      ticket_status: 'Open',
      assigned_technician: userEmail || '',
      due_date: DEFAULT_DUE(),
      general_description: '',
      accessories_received: '',
      attachments: [],
      products: [{ ...EMPTY_PRODUCT }],
      carrier: '',
      tracking_number: '',
      shipping_label_url: '',
    }
  })

  const [uploading, setUploading] = useState(false)
  const [customerSearch, setCustomerSearch] = useState(
    editingTicket ? editingTicket.customer_name || '' : ''
  )
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false)
  const [scanningProductIdx, setScanningProductIdx] = useState(null)
  const [productSearches, setProductSearches] = useState(() => {
    if (editingTicket) {
      const prods = editingTicket.products?.length ? editingTicket.products : [{ ...EMPTY_PRODUCT }]
      return prods.map((p) => p.product_name || '')
    }
    return ['']
  })
  const [showProductDropdowns, setShowProductDropdowns] = useState(() => {
    if (editingTicket) {
      const prods = editingTicket.products?.length ? editingTicket.products : [{ ...EMPTY_PRODUCT }]
      return prods.map(() => false)
    }
    return [false]
  })
  const [pendingFiles, setPendingFiles] = useState([])
  const [previewRmaNumber] = useState(() => (editingTicket ? null : generateRmaNumber(tickets)))

  const fileInputRef = useRef(null)
  const customerDropdownRef = useRef(null)

  useEffect(() => {
    if (userEmail && !editingTicket && !formData.assigned_technician) {
      setFormData((prev) => ({ ...prev, assigned_technician: userEmail }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail])

  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.customer-dropdown')) setShowCustomerDropdown(false)
      if (!e.target.closest('.product-dropdown'))
        setShowProductDropdowns((prev) => prev.map(() => false))
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filteredCustomersList = customers.filter((c) => {
    const q = customerSearch.toLowerCase()
    return (
      !q ||
      c.contact_person?.toLowerCase().includes(q) ||
      c.company_name?.toLowerCase().includes(q) ||
      c.mobile?.includes(q)
    )
  })

  // eslint-disable-next-line react-hooks/incompatible-library
  const customerVirtualizer = useVirtualizer({
    count: filteredCustomersList.length,
    getScrollElement: () => customerDropdownRef.current,
    estimateSize: () => 56,
    overscan: 3,
  })

  const filteredProductsList = (search) => {
    if (!search) return products.slice(0, 8)
    const q = search.toLowerCase()
    return products
      .filter((p) => p.product_name?.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q))
      .slice(0, 6)
  }

  const addProduct = () => {
    setFormData({ ...formData, products: [...formData.products, { ...EMPTY_PRODUCT }] })
    setProductSearches((p) => [...p, ''])
    setShowProductDropdowns((p) => [...p, false])
  }

  const removeProduct = (i) => {
    setFormData({ ...formData, products: formData.products.filter((_, idx) => idx !== i) })
    setProductSearches((p) => p.filter((_, idx) => idx !== i))
    setShowProductDropdowns((p) => p.filter((_, idx) => idx !== i))
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
    } catch (err) {
      captureException(err, { page: 'RMATickets', context: 'removeAttachment' })
      toast.error('Failed to remove attachment')
    }
  }

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files)
    const total = (formData.attachments?.length || 0) + pendingFiles.length + files.length
    if (total > 10) {
      toast.error('Maximum 10 attachments per ticket')
      return
    }
    setPendingFiles((prev) => [...prev, ...files])
    e.target.value = ''
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (editingTicket && !canDo('edit_all') && !canDo('edit_assigned')) {
      toast.error('You do not have permission to edit tickets')
      return
    }
    if (!editingTicket && !canDo('create')) {
      toast.error('You do not have permission to create tickets')
      return
    }

    const validation = ticketSchema.safeParse(formData)
    if (!validation.success) {
      toast.error(getFirstError(validation))
      return
    }

    setUploading(true)
    try {
      const rmaNumber = editingTicket ? editingTicket.rma_number : generateRmaNumber(tickets)

      const newAttachments = []
      for (const file of pendingFiles) {
        try {
          const uploaded = await storage.uploadFile(file, rmaNumber)
          newAttachments.push(uploaded)
        } catch (err) {
          captureException(err, { page: 'RMATickets', context: 'uploadAttachment' })
          toast.error(`Failed to upload ${file.name}`)
        }
      }

      const allAttachments = [...(formData.attachments || []), ...newAttachments]

      // Auto-set due date from SLA policy when creating a new ticket
      let computedDueDate = formData.due_date || null
      if (!editingTicket) {
        try {
          const sla = await db.slaConfig.get()
          const slaDue = db.slaConfig.computeDueDate(formData.priority, sla)
          if (slaDue) computedDueDate = slaDue
        } catch {}
      }

      // Resolve customer email: formData first, then fall back to customers prop lookup
      // (covers existing tickets that have customer_id but customer_email was never stored)
      const resolvedCustomerEmail =
        formData.customer_email ||
        customers.find((c) => c.id === formData.customer_id)?.email ||
        editingTicket?.customer_email ||
        null

      const ticketData = {
        customer_name: formData.customer_name,
        customer_id: formData.customer_id || null,
        customer_email: resolvedCustomerEmail,
        priority: formData.priority,
        ticket_status: formData.ticket_status,
        assigned_technician: formData.assigned_technician,
        due_date: computedDueDate,
        general_description: formData.general_description || null,
        accessories_received: formData.accessories_received || null,
        attachments: allAttachments.length > 0 ? allAttachments : null,
        products: formData.products.map((p) => ({
          ...p,
          status_date: p.status_date || new Date().toISOString(),
        })),
        // Shipping
        carrier: formData.carrier || null,
        tracking_number: formData.tracking_number || null,
        shipping_label_url: formData.shipping_label_url || null,
        rma_number: rmaNumber,
        updated_by: userEmail,
        updated_date: new Date().toISOString(),
      }

      if (editingTicket) {
        await db.rmaTickets.update(editingTicket.id, ticketData)
        db.userActivity
          .create(
            userEmail,
            'ticket_updated',
            `Updated ticket ${editingTicket.rma_number || editingTicket.id}`
          )
          .catch(() => {})
        const techEmails =
          ticketData.assigned_technician && ticketData.assigned_technician !== userEmail
            ? [ticketData.assigned_technician]
            : []
        db.notifications
          .create({
            type: 'ticket_updated',
            title: 'Ticket Updated',
            message: `Ticket ${editingTicket.rma_number} for ${ticketData.customer_name} was updated by ${userEmail}`,
            entityType: 'ticket',
            entityId: editingTicket.id,
            entityRef: editingTicket.rma_number,
            createdBy: userEmail,
            targetRoles: ['admin', 'super_admin'],
            targetEmails: techEmails,
          })
          .catch(() => {})
        // Specific: technician assignment changed
        if (
          ticketData.assigned_technician &&
          ticketData.assigned_technician !== editingTicket.assigned_technician
        ) {
          db.notifications
            .create({
              type: 'ticket_assigned',
              title: 'Ticket Assigned',
              message: `Ticket ${editingTicket.rma_number} was assigned to ${ticketData.assigned_technician}`,
              entityType: 'ticket',
              entityId: editingTicket.id,
              entityRef: editingTicket.rma_number,
              createdBy: userEmail,
              targetRoles: ['admin', 'super_admin'],
              targetEmails: [ticketData.assigned_technician],
            })
            .catch(() => {})
        }
        // Specific: status changed
        if (ticketData.ticket_status !== editingTicket.ticket_status) {
          const assigneeEmails =
            editingTicket.assigned_technician && editingTicket.assigned_technician !== userEmail
              ? [editingTicket.assigned_technician]
              : []
          db.notifications
            .create({
              type: 'ticket_status_changed',
              title: 'Ticket Status Changed',
              message: `Ticket ${editingTicket.rma_number} moved from "${editingTicket.ticket_status}" to "${ticketData.ticket_status}"`,
              entityType: 'ticket',
              entityId: editingTicket.id,
              entityRef: editingTicket.rma_number,
              createdBy: userEmail,
              targetRoles: ['admin', 'super_admin'],
              targetEmails: assigneeEmails,
            })
            .catch(() => {})
        }
        toast.success('Ticket updated successfully!')
        // Fire automation rules + webhook on update
        db.automationRules
          .evaluate('ticket_updated', { ...editingTicket, ...ticketData })
          .catch(() => {})
        db.webhooks
          .dispatch('ticket_updated', {
            id: editingTicket.id,
            rma_number: editingTicket.rma_number,
            ...ticketData,
          })
          .catch(() => {})
        if (ticketData.ticket_status !== editingTicket.ticket_status) {
          db.automationRules
            .evaluate('ticket_status_changed', { ...editingTicket, ...ticketData })
            .catch(() => {})
          db.webhooks
            .dispatch('ticket_status_changed', {
              id: editingTicket.id,
              rma_number: editingTicket.rma_number,
              old_status: editingTicket.ticket_status,
              new_status: ticketData.ticket_status,
            })
            .catch(() => {})
        }
        if (ticketData.assigned_technician !== editingTicket.assigned_technician) {
          db.automationRules
            .evaluate('ticket_assigned', { ...editingTicket, ...ticketData })
            .catch(() => {})
          db.webhooks
            .dispatch('ticket_assigned', {
              id: editingTicket.id,
              rma_number: editingTicket.rma_number,
              technician: ticketData.assigned_technician,
            })
            .catch(() => {})
        }

        // ── WhatsApp + email notification events ─────────────────────────
        {
          const updatedPayload = { ...editingTicket, ...ticketData, id: editingTicket.id }
          const ts = new Date().toISOString()
          const statusChanged = ticketData.ticket_status !== editingTicket.ticket_status
          const assigneeChanged = ticketData.assigned_technician !== editingTicket.assigned_technician
          const priorityChanged = ticketData.priority !== editingTicket.priority
          const isClosed = ['Closed', 'Completed', 'Cancelled'].includes(ticketData.ticket_status)

          if (assigneeChanged) {
            notificationEventBus.emitAsync({ type: 'ticket.assigned', timestamp: ts, ticketId: editingTicket.id, ticket: updatedPayload, triggeredBy: userEmail })
            if (ticketData.assigned_technician) {
              notifications.sendEmail(ticketData.assigned_technician, 'ticket_assigned', {
                recipient_name: ticketData.assigned_technician,
                rma_number: editingTicket.rma_number,
                customer_name: ticketData.customer_name,
                priority: ticketData.priority,
                due_date: ticketData.due_date || 'N/A',
              }).catch((err) => console.error('[email] ticket_assigned:', err.message))
            }
          }
          if (statusChanged && isClosed) {
            notificationEventBus.emitAsync({ type: 'ticket.closed', timestamp: ts, ticketId: editingTicket.id, ticket: updatedPayload, triggeredBy: userEmail })
          } else if (statusChanged) {
            notificationEventBus.emitAsync({ type: 'ticket.updated', timestamp: ts, ticketId: editingTicket.id, ticket: updatedPayload, triggeredBy: userEmail })
          }
          // Email customer on any status change
          if (statusChanged) {
            if (!resolvedCustomerEmail) {
              console.warn('[email] status change skipped — no customer email on ticket', editingTicket.id)
            } else {
              notifications.sendEmail(resolvedCustomerEmail, 'status_changed', {
                recipient_name: ticketData.customer_name,
                customer_name: ticketData.customer_name,
                rma_number: editingTicket.rma_number,
                old_status: editingTicket.ticket_status,
                new_status: ticketData.ticket_status,
                priority: ticketData.priority,
                status: ticketData.ticket_status,
                updated_by: userEmail,
                update_time: new Date().toLocaleString(),
              }).catch((err) => {
                console.error('[email] status change failed:', err.message)
                toast.error(`Email notification failed: ${err.message}`, { duration: 6000 })
              })
            }
          }
          // Email customer on priority change
          if (priorityChanged && resolvedCustomerEmail) {
            notifications.sendEmail(resolvedCustomerEmail, 'priority_changed', {
              recipient_name: ticketData.customer_name,
              customer_name: ticketData.customer_name,
              rma_number: editingTicket.rma_number,
              old_priority: editingTicket.priority,
              new_priority: ticketData.priority,
            }).catch((err) => console.error('[email] priority_changed:', err.message))
          }
        }
      } else {
        const newTicket = await db.rmaTickets.create({
          ...ticketData,
          created_by: userEmail,
          created_date: new Date().toISOString(),
        })
        if (newTicket?.id) {
          db.inventory
            .createUnitsFromTicket(
              newTicket.id,
              newTicket.rma_number || rmaNumber,
              ticketData.products
            )
            .catch((err) => {
              captureException(err, { page: 'RMATickets', context: 'createInventoryUnit' })
            })
          const techEmails =
            ticketData.assigned_technician && ticketData.assigned_technician !== userEmail
              ? [ticketData.assigned_technician]
              : []
          db.notifications
            .create({
              type: 'ticket_created',
              title: 'New RMA Ticket',
              message: `Ticket ${rmaNumber} created for ${ticketData.customer_name}`,
              entityType: 'ticket',
              entityId: newTicket.id,
              entityRef: rmaNumber,
              createdBy: userEmail,
              targetRoles: ['admin', 'super_admin'],
              targetEmails: techEmails,
            })
            .catch(() => {})
          // Fire automation rules + webhook on create
          db.automationRules.evaluate('ticket_created', newTicket).catch(() => {})
          db.webhooks
            .dispatch('ticket_created', {
              id: newTicket.id,
              rma_number: rmaNumber,
              customer_name: ticketData.customer_name,
              priority: ticketData.priority,
              status: ticketData.ticket_status,
            })
            .catch(() => {})
          // WhatsApp notification — spread the saved DB row so all fields
          // (incl. created_date) are present; ticketData alone lacks created_date
          // which left {{created_date}} empty → Meta #131008 "required parameter missing".
          notificationEventBus.emitAsync({
            type: 'ticket.created',
            timestamp: new Date().toISOString(),
            ticketId: newTicket.id,
            ticket: {
              ...ticketData,
              ...newTicket,
              id: newTicket.id,
              rma_number: newTicket.rma_number || rmaNumber,
              created_date: newTicket.created_date || new Date().toISOString(),
            },
            triggeredBy: userEmail,
          })
          // Email assigned technician (if different from the creator)
          if (ticketData.assigned_technician && ticketData.assigned_technician !== userEmail) {
            notifications.sendEmail(ticketData.assigned_technician, 'ticket_assigned', {
              recipient_name: ticketData.assigned_technician,
              rma_number: newTicket.rma_number || rmaNumber,
              customer_name: ticketData.customer_name,
              priority: ticketData.priority,
              due_date: ticketData.due_date || 'N/A',
            }).catch((err) => console.error('[email] ticket_assigned (create):', err.message))
          }
          // Email notification to customer
          if (resolvedCustomerEmail) {
            const productDetails = (ticketData.products || [])
              .filter((p) => p.product_name)
              .map((p) => `${p.product_name}${p.serial_number ? ` (SN: ${p.serial_number})` : ''}`)
              .join('\n') || 'N/A'
            notifications.sendEmail(resolvedCustomerEmail, 'ticket_created', {
              recipient_name: ticketData.customer_name,
              customer_name: ticketData.customer_name,
              rma_number: newTicket.rma_number || rmaNumber,
              priority: ticketData.priority,
              status: ticketData.ticket_status,
              issue_description: ticketData.general_description || '',
              product_details: productDetails,
            }).catch((err) => console.error('[email] ticket created:', err.message))
          }
        }
        db.userActivity
          .create(
            userEmail,
            'ticket_created',
            `Created ticket ${rmaNumber} for ${ticketData.customer_name}`
          )
          .catch(() => {})
        toast.success('Ticket created successfully!')
      }

      queryClient.invalidateQueries({ queryKey: ['rma-tickets'] })
      queryClient.invalidateQueries({ queryKey: ['rma-tickets-count'] })
      onSaved({ ...ticketData, id: editingTicket?.id })
    } catch (error) {
      captureException(error, { page: 'RMATickets', context: 'saveTicket' })
      toast.error(`Failed to save ticket: ${error.message}`)
    } finally {
      setUploading(false)
    }
  }

  return (
    <>
    <Modal
      open={true}
      onClose={onClose}
      title={editingTicket ? 'Edit RMA Ticket' : 'Create New RMA Ticket'}
      className="max-w-4xl"
      noPadding
      hideHeader
      scrollable={false}
    >
      <div className="w-full">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <div>
            <h2 className="text-xl font-bold text-gray-900">
              {editingTicket ? 'Edit RMA Ticket' : 'Create New RMA Ticket'}
            </h2>
            <div className="flex items-center gap-3 mt-1">
              <p className="text-xs text-gray-500">
                <span className="text-red-500">*</span> Required fields
              </p>
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
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="px-6 py-5 space-y-5 max-h-[72vh] overflow-y-auto">
            {/* Row 1: Customer + Priority */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={lbl}>
                  Customer Name <span className="text-red-500">*</span>
                </label>
                <div className="relative customer-dropdown">
                  <input
                    type="text"
                    value={customerSearch}
                    onChange={(e) => {
                      setCustomerSearch(e.target.value)
                      setFormData({ ...formData, customer_name: e.target.value })
                      setShowCustomerDropdown(true)
                    }}
                    onFocus={() => setShowCustomerDropdown(true)}
                    placeholder="Search customer..."
                    className={inp}
                    required
                  />
                  {showCustomerDropdown && filteredCustomersList.length > 0 && (
                    /* P-2: virtualised list — only visible rows rendered in DOM */
                    <div
                      ref={customerDropdownRef}
                      className="absolute z-30 w-full bg-white border border-gray-200 rounded-lg shadow-xl mt-1 overflow-y-auto max-h-64"
                    >
                      <div
                        style={{
                          height: customerVirtualizer.getTotalSize(),
                          position: 'relative',
                        }}
                      >
                        {customerVirtualizer.getVirtualItems().map((vItem) => {
                          const c = filteredCustomersList[vItem.index]
                          const displayName =
                            c.customer_type === 'B2B' && c.company_name
                              ? c.company_name
                              : c.contact_person
                          return (
                            <div
                              key={c.id}
                              style={{
                                position: 'absolute',
                                top: vItem.start,
                                left: 0,
                                right: 0,
                                height: vItem.size,
                              }}
                            >
                              <button
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault()
                                  setCustomerSearch(displayName)
                                  setFormData({ ...formData, customer_name: displayName, customer_id: c.id, customer_email: c.email || '' })
                                  setShowCustomerDropdown(false)
                                }}
                                className="w-full h-full px-4 text-left hover:bg-indigo-50 border-b border-gray-100 flex flex-col justify-center"
                              >
                                <div className="text-sm font-medium text-gray-900">
                                  {displayName}
                                </div>
                                {c.customer_type === 'B2B' &&
                                  c.contact_person &&
                                  c.company_name && (
                                    <div className="text-xs text-gray-500">
                                      {c.contact_person} ·{' '}
                                      <span className="font-medium text-blue-600">B2B</span>
                                    </div>
                                  )}
                                {c.customer_type === 'B2C' && (
                                  <div className="text-xs text-gray-500">
                                    <span className="font-medium text-emerald-600">B2C</span>
                                    {c.mobile ? ` · ${c.mobile}` : ''}
                                  </div>
                                )}
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div>
                <label className={lbl}>
                  Priority <span className="text-red-500">*</span>
                </label>
                <select
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                  className={inp}
                >
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
                <select
                  value={formData.ticket_status}
                  onChange={(e) => setFormData({ ...formData, ticket_status: e.target.value })}
                  className={inp}
                >
                  <option value="Open">Open</option>
                  <option value="In Progress">In Progress</option>
                  <option value="Pending">Pending</option>
                  <option value="On Hold">On Hold</option>
                  <option value="Completed">Completed</option>
                  <option value="Closed">Closed</option>
                  <option value="Cancelled">Cancelled</option>
                </select>
              </div>
              <div>
                <label className={lbl}>Assigned To</label>
                {userRole === ROLES.ADMIN || userRole === ROLES.SUPER_ADMIN ? (
                  <select
                    value={formData.assigned_technician}
                    onChange={(e) =>
                      setFormData({ ...formData, assigned_technician: e.target.value })
                    }
                    className={inp}
                  >
                    {users.map((u) => (
                      <option key={u.user_email} value={u.user_email}>
                        {u.user_email}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className={`${inp} bg-gray-50 text-gray-600 cursor-not-allowed`}>
                    {formData.assigned_technician || userEmail || '—'}
                  </div>
                )}
              </div>
              <div>
                <label className={lbl}>
                  Due Date{' '}
                  <span className="text-xs text-gray-500 font-normal ml-1">auto +7 days</span>
                </label>
                <input
                  type="date"
                  value={formData.due_date}
                  onChange={(e) => setFormData({ ...formData, due_date: e.target.value })}
                  className={inp}
                />
              </div>
            </div>

            {/* Products */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold text-gray-900">Products</h3>
                <button
                  type="button"
                  onClick={addProduct}
                  className="text-sm text-indigo-600 hover:text-indigo-800 font-medium"
                >
                  + Add Product
                </button>
              </div>
              {formData.products.map((product, idx) => (
                <div
                  key={idx}
                  className="border border-gray-200 rounded-xl p-4 mb-4 bg-gray-50"
                >
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-medium text-gray-800 text-sm">Product {idx + 1}</h4>
                    {formData.products.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeProduct(idx)}
                        className="text-red-500 hover:text-red-700 text-xs font-medium"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {/* Product name combobox */}
                    <div>
                      <label className={lbl}>
                        Product Name <span className="text-red-500">*</span>
                      </label>
                      <div className="relative product-dropdown">
                        <input
                          type="text"
                          value={productSearches[idx] || ''}
                          onChange={(e) => {
                            const s = [...productSearches]
                            s[idx] = e.target.value
                            setProductSearches(s)
                            updateProduct(idx, 'product_name', e.target.value)
                            const d = [...showProductDropdowns]
                            d[idx] = true
                            setShowProductDropdowns(d)
                          }}
                          onFocus={() => {
                            const d = [...showProductDropdowns]
                            d[idx] = true
                            setShowProductDropdowns(d)
                          }}
                          placeholder="Search or type product..."
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent text-sm bg-white"
                          required
                        />
                        {showProductDropdowns[idx] &&
                          filteredProductsList(productSearches[idx]).length > 0 && (
                            <div className="absolute z-30 w-full bg-white border border-gray-200 rounded-lg shadow-xl mt-1 max-h-40 overflow-y-auto">
                              {filteredProductsList(productSearches[idx]).map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  onMouseDown={(e) => {
                                    e.preventDefault()
                                    const s = [...productSearches]
                                    s[idx] = p.product_name
                                    setProductSearches(s)
                                    updateProduct(idx, 'product_name', p.product_name)
                                    const d = [...showProductDropdowns]
                                    d[idx] = false
                                    setShowProductDropdowns(d)
                                  }}
                                  className="w-full px-3 py-2 text-left hover:bg-indigo-50 border-b border-gray-100 last:border-0"
                                >
                                  <div className="text-sm font-medium text-gray-900">
                                    {p.product_name}
                                  </div>
                                  <div className="text-xs text-gray-500">
                                    {p.sku}
                                    {p.brand?.brand_name ? ` · ${p.brand.brand_name}` : ''}
                                  </div>
                                </button>
                              ))}
                            </div>
                          )}
                      </div>
                    </div>
                    <div>
                      <label className={lbl}>
                        Serial Number <span className="text-red-500">*</span>
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          value={product.serial_number}
                          onChange={(e) => updateProduct(idx, 'serial_number', e.target.value)}
                          className="w-full pl-3 pr-9 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 text-sm bg-white"
                          required
                        />
                        <button type="button" onClick={() => setScanningProductIdx(idx)}
                          title="Scan barcode / USB scanner"
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-indigo-600 transition-colors">
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <rect x="2"  y="3" width="2" height="18" rx="0.5" />
                            <rect x="6"  y="3" width="1" height="18" rx="0.5" />
                            <rect x="9"  y="3" width="2" height="18" rx="0.5" />
                            <rect x="13" y="3" width="1" height="18" rx="0.5" />
                            <rect x="16" y="3" width="3" height="18" rx="0.5" />
                            <rect x="21" y="3" width="1" height="18" rx="0.5" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className={lbl}>Product Status</label>
                      <select
                        value={product.product_status}
                        onChange={(e) => updateProduct(idx, 'product_status', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 text-sm bg-white"
                      >
                        <option>Received</option>
                        <option>Under Repair</option>
                        <option>Repaired</option>
                        <option>Can&apos;t Repair</option>
                        <option>Replacement</option>
                        <option>Credit Note</option>
                      </select>
                    </div>
                    <div>
                      <label className={lbl}>Warranty Status</label>
                      <select
                        value={product.warranty_status}
                        onChange={(e) => updateProduct(idx, 'warranty_status', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 text-sm bg-white"
                      >
                        <option>In Warranty</option>
                        <option>Out of Warranty</option>
                        <option>Extended Warranty</option>
                      </select>
                    </div>
                  </div>
                  <div className="mt-3">
                    <label className={lbl}>
                      Issue Description <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={product.issue_description}
                      onChange={(e) => updateProduct(idx, 'issue_description', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 text-sm bg-white"
                      rows={3}
                      required
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* General RMA Description */}
            <div>
              <label className={lbl}>General RMA Description</label>
              <textarea
                value={formData.general_description}
                onChange={(e) =>
                  setFormData({ ...formData, general_description: e.target.value })
                }
                placeholder="General description for the RMA ticket (optional)..."
                className={inp}
                rows={3}
              />
            </div>

            {/* Accessories Received */}
            <div>
              <label className={lbl}>Accessories Received</label>
              <textarea
                value={formData.accessories_received}
                onChange={(e) =>
                  setFormData({ ...formData, accessories_received: e.target.value })
                }
                placeholder="List any accessories received with the device..."
                className={inp}
                rows={3}
              />
            </div>

            {/* Shipping Information */}
            <div className="border border-gray-200 rounded-xl p-4 space-y-3 bg-gray-50/50">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Shipping Information
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>Carrier</label>
                  <select
                    value={formData.carrier}
                    onChange={(e) => setFormData((f) => ({ ...f, carrier: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 text-sm bg-white"
                  >
                    {CARRIERS.map((c) => (
                      <option key={c} value={c}>
                        {c || '— Select carrier —'}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={lbl}>Tracking Number</label>
                  <input
                    type="text"
                    value={formData.tracking_number}
                    onChange={(e) =>
                      setFormData((f) => ({ ...f, tracking_number: e.target.value }))
                    }
                    className={inp}
                    placeholder="e.g. 1Z999AA10123456784"
                  />
                </div>
              </div>
              <div>
                <label className={lbl}>
                  Shipping Label URL{' '}
                  <span className="text-gray-500 font-normal">(optional)</span>
                </label>
                <input
                  type="url"
                  value={formData.shipping_label_url}
                  onChange={(e) =>
                    setFormData((f) => ({ ...f, shipping_label_url: e.target.value }))
                  }
                  className={inp}
                  placeholder="https://..."
                />
              </div>
              {formData.tracking_number && formData.carrier && (
                <a
                  href={`https://www.google.com/search?q=${encodeURIComponent(formData.carrier + ' tracking ' + formData.tracking_number)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
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
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                  Track shipment
                </a>
              )}
            </div>

            {/* Attachments */}
            <div>
              <label className={lbl}>
                Attachments
                <span className="text-xs text-gray-500 font-normal ml-2">
                  ({(formData.attachments?.length || 0) + pendingFiles.length}/10)
                </span>
              </label>

              {/* Uploaded attachments */}
              {(formData.attachments || []).length > 0 && (
                <div className="mb-3 space-y-2">
                  {formData.attachments.map((att, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200"
                    >
                      {isImage(att.type) ? (
                        <img
                          src={att.url}
                          alt={att.name}
                          className="w-10 h-10 object-cover rounded flex-shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 bg-indigo-100 rounded flex items-center justify-center flex-shrink-0">
                          <svg
                            className="w-5 h-5 text-indigo-600"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                            />
                          </svg>
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <a
                          href={att.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm font-medium text-indigo-600 hover:underline truncate block"
                        >
                          {att.name}
                        </a>
                        <p className="text-xs text-gray-500">{fmtBytes(att.size)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteAttachment(att, i)}
                        aria-label="Delete attachment"
                        className="text-red-400 hover:text-red-600 p-1 flex-shrink-0"
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
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Pending files */}
              {pendingFiles.length > 0 && (
                <div className="mb-3 space-y-2">
                  {pendingFiles.map((f, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200"
                    >
                      <div className="w-10 h-10 bg-amber-100 rounded flex items-center justify-center flex-shrink-0">
                        <svg
                          className="w-5 h-5 text-amber-600"
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
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{f.name}</p>
                        <p className="text-xs text-amber-600">
                          {fmtBytes(f.size)} · Will upload on save
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPendingFiles((p) => p.filter((_, idx) => idx !== i))}
                        aria-label="Remove file"
                        className="text-red-400 hover:text-red-600 p-1 flex-shrink-0"
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
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Drop zone */}
              {(formData.attachments?.length || 0) + pendingFiles.length < 10 && (
                <label className="border-2 border-dashed border-gray-300 rounded-xl p-6 text-center cursor-pointer hover:border-indigo-400 transition-colors block">
                  <svg
                    className="w-10 h-10 text-gray-500 mx-auto mb-2"
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
                  <p className="text-sm font-medium text-indigo-600">
                    Click to upload or drag and drop
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Up to 10 files · Images, PDFs, documents
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                    accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
                  />
                </label>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
            <Button
              variant="secondary"
              type="button"
              className="flex-1 justify-center"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" loading={uploading} className="flex-1 justify-center">
              {editingTicket ? 'Update Ticket' : 'Create Ticket'}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
    {scanningProductIdx !== null && (
      <BarcodeScanner
        onScan={(value) => {
          updateProduct(scanningProductIdx, 'serial_number', value)
          setScanningProductIdx(null)
        }}
        onClose={() => setScanningProductIdx(null)}
      />
    )}
    </>
  )
}
