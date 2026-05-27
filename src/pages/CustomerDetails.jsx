import React, { useState, useEffect } from 'react'
import { db, storage } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import ConfirmDialog from '../components/ConfirmDialog'
import { CardSkeleton } from '../components/Skeleton'
import AttachmentsField from '../components/AttachmentsField'
import { Button, Spinner } from '../components/ui'
import { useURLTab } from '../hooks/useURLTab'
import { ROLES } from '../lib/constants'
import { captureException } from '../lib/sentry'

export default function CustomerDetails({
  customerId,
  currentUserRole,
  currentUserEmail,
  currentUserPermissions,
  onBack,
  onNavigateToTicket,
}) {
  const [customer, setCustomer] = useState(null)
  const [tickets, setTickets] = useState([])
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useURLTab('tab', 'profile')
  const [isEditing, setIsEditing] = useState(false)
  const [editForm, setEditForm] = useState({})
  const [pendingFiles, setPendingFiles] = useState([])
  const [newNote, setNewNote] = useState('')
  const [editingNote, setEditingNote] = useState(null)
  const [editNoteText, setEditNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)

  const isSuperAdmin = currentUserRole === ROLES.SUPER_ADMIN
  const canDo = (action) => {
    if (isSuperAdmin) return true
    if (currentUserPermissions?.customers?.[action] === true) return true
    if (currentUserRole === ROLES.ADMIN) return true
    return false
  }

  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    message: '',
    onConfirm: null,
  })
  const openConfirm = (title, message, onConfirm) =>
    setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog((d) => ({ ...d, open: false }))

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId])

  const loadAll = async () => {
    setLoading(true)
    try {
      const [customerData, ticketsData, notesData] = await Promise.all([
        db.customers.get(customerId),
        db.customers.getRelatedTickets(customerId),
        db.customerNotes.list(customerId),
      ])
      setCustomer(customerData)
      setEditForm(customerData)
      setTickets(ticketsData)
      setNotes(notesData)
    } catch (error) {
      captureException(error)
      toast.error('Failed to load customer details')
    } finally {
      setLoading(false)
    }
  }

  const handleSaveEdit = async () => {
    if (!editForm.contact_person?.trim() || !editForm.mobile?.trim()) {
      toast.error('Contact person and mobile are required')
      return
    }
    if (editForm.customer_type === 'B2B' && !editForm.company_name?.trim()) {
      toast.error('Company name is required for B2B customers')
      return
    }

    // Upload any newly added files
    const uploadedAttachments = []
    if (pendingFiles.length > 0) {
      for (const file of pendingFiles) {
        try {
          const result = await storage.uploadCustomerAttachment(file, customerId)
          uploadedAttachments.push(result)
        } catch (err) {
          toast.error(`Failed to upload ${file.name}: ${err.message}`)
          return
        }
      }
    }
    const allAttachments = [...(editForm.attachments || []), ...uploadedAttachments]

    try {
      const updated = await db.customers.update(customerId, {
        customer_type: editForm.customer_type,
        customer_status: editForm.customer_status,
        company_name: editForm.company_name || null,
        contact_person: editForm.contact_person,
        account_manager: editForm.account_manager || null,
        mobile: editForm.mobile,
        landline: editForm.landline || null,
        email: editForm.email || null,
        address: editForm.address || null,
        cr_number: editForm.cr_number || null,
        tax_id: editForm.tax_id || null,
        notes: editForm.notes || null,
        attachments: allAttachments,
        updated_by: currentUserEmail,
        updated_date: new Date().toISOString(),
      })
      setCustomer(updated)
      setEditForm(updated)
      setPendingFiles([])
      setIsEditing(false)
      toast.success('Customer updated successfully')
      db.auditLog
        .log(
          currentUserEmail,
          'customer_updated',
          `Updated customer ${editForm.contact_person}${editForm.company_name ? ` (${editForm.company_name})` : ''}`
        )
        .catch((err) => captureException(err))
    } catch (error) {
      toast.error(`Failed to update: ${error.message}`)
    }
  }

  const handleDelete = () => {
    openConfirm(
      'Delete Customer',
      `Delete ${customer.contact_person}? This cannot be undone.`,
      async () => {
        closeConfirm()
        try {
          await db.customers.delete(customerId)
          toast.success('Customer deleted')
          db.auditLog
            .log(
              currentUserEmail,
              'customer_deleted',
              `Deleted customer ${customer.contact_person}${customer.company_name ? ` (${customer.company_name})` : ''}`
            )
            .catch((err) => captureException(err))
          onBack()
        } catch {
          toast.error('Failed to delete customer')
        }
      }
    )
  }

  const handleAddNote = async () => {
    if (!newNote.trim()) return
    setSavingNote(true)
    try {
      const created = await db.customerNotes.create({
        customer_id: customerId,
        note: newNote.trim(),
        created_by: currentUserEmail,
        created_date: new Date().toISOString(),
        updated_date: new Date().toISOString(),
      })
      setNotes((prev) => [created, ...prev])
      setNewNote('')
      toast.success('Note added')
      db.auditLog
        .log(
          currentUserEmail,
          'customer_note_added',
          `Added note on customer ${customer?.contact_person}`
        )
        .catch((err) => captureException(err))
    } catch {
      toast.error('Failed to add note')
    } finally {
      setSavingNote(false)
    }
  }

  const handleUpdateNote = async (noteId) => {
    if (!editNoteText.trim()) return
    try {
      const updated = await db.customerNotes.update(noteId, {
        note: editNoteText.trim(),
        updated_date: new Date().toISOString(),
      })
      setNotes((prev) => prev.map((n) => (n.id === noteId ? updated : n)))
      setEditingNote(null)
      setEditNoteText('')
      toast.success('Note updated')
      db.auditLog
        .log(
          currentUserEmail,
          'customer_note_updated',
          `Updated note ${noteId} on customer ${customer?.contact_person}`
        )
        .catch((err) => captureException(err))
    } catch {
      toast.error('Failed to update note')
    }
  }

  const handleDeleteNote = (noteId) => {
    openConfirm('Delete Note', 'Delete this note? This cannot be undone.', async () => {
      closeConfirm()
      try {
        await db.customerNotes.delete(noteId)
        setNotes((prev) => prev.filter((n) => n.id !== noteId))
        toast.success('Note deleted')
        db.auditLog
          .log(
            currentUserEmail,
            'customer_note_deleted',
            `Deleted note ${noteId} on customer ${customer?.contact_person}`
          )
          .catch((err) => captureException(err))
      } catch {
        toast.error('Failed to delete note')
      }
    })
  }

  const getStatusBadge = (status) => {
    const style = status === 'Active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
    return (
      <span className={`px-3 py-1 text-sm rounded-full font-medium ${style}`}>
        {status || 'Unknown'}
      </span>
    )
  }

  const getTypeBadge = (type) => {
    const style = type === 'B2B' ? 'bg-blue-100 text-blue-800' : 'bg-emerald-100 text-emerald-800'
    return (
      <span className={`px-2 py-1 text-xs rounded-full font-medium ${style}`}>
        {type === 'B2B' ? '🏢 B2B' : '👤 B2C'}
      </span>
    )
  }

  const getTicketStatusBadge = (status) => {
    const styles = {
      New: 'bg-blue-100 text-blue-800',
      'In Progress': 'bg-yellow-100 text-yellow-800',
      'On Hold': 'bg-orange-100 text-orange-800',
      Completed: 'bg-green-100 text-green-800',
      Cancelled: 'bg-gray-100 text-gray-800',
    }
    return (
      <span
        className={`px-2 py-1 text-xs rounded-full font-medium ${styles[status] || 'bg-gray-100 text-gray-800'}`}
      >
        {status || 'Unknown'}
      </span>
    )
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  const formatDateTime = (dateStr) => {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const inputClass =
    'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent'
  const labelClass = 'block text-sm font-medium text-gray-700 mb-1'

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse bg-gray-200 rounded-lg" />
        <CardSkeleton lines={5} />
        <CardSkeleton lines={4} />
      </div>
    )
  }

  if (!customer) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Customer not found.</p>
        <Button className="mt-4" onClick={onBack}>
          Go Back
        </Button>
      </div>
    )
  }

  const displayName =
    customer.customer_type === 'B2B' && customer.company_name
      ? customer.company_name
      : customer.contact_person

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
            Back to Customers
          </button>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-lg">
              {displayName?.[0]?.toUpperCase() || '?'}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{displayName}</h1>
              {customer.customer_type === 'B2B' && customer.contact_person && (
                <p className="text-sm text-gray-500">Contact: {customer.contact_person}</p>
              )}
              <div className="flex items-center gap-2 mt-1">
                {getStatusBadge(customer.customer_status)}
                {getTypeBadge(customer.customer_type)}
                {customer.customer_code && (
                  <span className="font-mono text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                    {customer.customer_code}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {canDo('edit') && !isEditing && (
          <div className="flex items-center gap-2">
            <Button
              onClick={() => {
                setIsEditing(true)
                setEditForm(customer)
                setPendingFiles([])
              }}
            >
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

        {isEditing && (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setIsEditing(false)
                setEditForm(customer)
                setPendingFiles([])
              }}
            >
              Cancel
            </Button>
            <Button variant="success" onClick={handleSaveEdit}>
              Save Changes
            </Button>
          </div>
        )}
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: 'Total RMAs',
            value: tickets.length,
            icon: '🎫',
            color: 'bg-blue-50 text-blue-700',
          },
          {
            label: 'Open Tickets',
            value: tickets.filter(
              (t) =>
                t.ticket_status === 'New' ||
                t.ticket_status === 'In Progress' ||
                t.ticket_status === 'On Hold'
            ).length,
            icon: '🔓',
            color: 'bg-yellow-50 text-yellow-700',
          },
          {
            label: 'Notes',
            value: notes.length,
            icon: '📝',
            color: 'bg-purple-50 text-purple-700',
          },
          {
            label: 'Customer Since',
            value: formatDate(customer.created_date),
            icon: '📅',
            color: 'bg-green-50 text-green-700',
          },
        ].map((stat) => (
          <div key={stat.label} className={`rounded-xl p-4 ${stat.color}`}>
            <div className="text-2xl mb-1">{stat.icon}</div>
            <div className="text-xl font-bold">{stat.value}</div>
            <div className="text-sm font-medium">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="border-b border-gray-200">
          <nav className="flex gap-6 px-6">
            {[
              { key: 'profile', label: 'Profile', icon: '👤' },
              { key: 'rma', label: `RMA History (${tickets.length})`, icon: '🎫' },
              { key: 'notes', label: `Notes (${notes.length})`, icon: '📝' },
              { key: 'activity', label: 'Activity Log', icon: '📋' },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`py-4 border-b-2 font-medium transition-colors flex items-center gap-2 ${
                  activeTab === tab.key
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <span>{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="p-6">
          {/* ==================== PROFILE TAB ==================== */}
          {activeTab === 'profile' && (
            <div className="space-y-8">
              {isEditing ? (
                <div className="space-y-6">
                  {/* Customer Type + Status */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
                      Customer Type & Status
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className={labelClass}>
                          Customer Type <span className="text-red-500">*</span>
                        </label>
                        <select
                          value={editForm.customer_type || 'B2B'}
                          onChange={(e) =>
                            setEditForm({ ...editForm, customer_type: e.target.value })
                          }
                          className={inputClass}
                        >
                          <option value="B2B">B2B — Business</option>
                          <option value="B2C">B2C — Individual</option>
                        </select>
                      </div>
                      <div>
                        <label className={labelClass}>
                          Status <span className="text-red-500">*</span>
                        </label>
                        <select
                          value={editForm.customer_status || 'Active'}
                          onChange={(e) =>
                            setEditForm({ ...editForm, customer_status: e.target.value })
                          }
                          className={inputClass}
                        >
                          <option value="Active">Active</option>
                          <option value="Inactive">Inactive</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* B2B fields */}
                  {editForm.customer_type === 'B2B' && (
                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
                        Company Information
                      </h3>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className={labelClass}>
                            Company Name <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={editForm.company_name || ''}
                            onChange={(e) =>
                              setEditForm({ ...editForm, company_name: e.target.value })
                            }
                            className={inputClass}
                          />
                        </div>
                        <div>
                          <label className={labelClass}>CR Number</label>
                          <input
                            type="text"
                            value={editForm.cr_number || ''}
                            onChange={(e) =>
                              setEditForm({ ...editForm, cr_number: e.target.value })
                            }
                            className={inputClass}
                          />
                        </div>
                        <div>
                          <label className={labelClass}>Tax ID</label>
                          <input
                            type="text"
                            value={editForm.tax_id || ''}
                            onChange={(e) => setEditForm({ ...editForm, tax_id: e.target.value })}
                            className={inputClass}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Contact */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
                      Contact Information
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className={labelClass}>
                          Contact Person <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={editForm.contact_person || ''}
                          onChange={(e) =>
                            setEditForm({ ...editForm, contact_person: e.target.value })
                          }
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>
                          Mobile <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="tel"
                          value={editForm.mobile || ''}
                          onChange={(e) => setEditForm({ ...editForm, mobile: e.target.value })}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Landline</label>
                        <input
                          type="tel"
                          value={editForm.landline || ''}
                          onChange={(e) => setEditForm({ ...editForm, landline: e.target.value })}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Email</label>
                        <input
                          type="email"
                          value={editForm.email || ''}
                          onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Account Manager</label>
                        <input
                          type="text"
                          value={editForm.account_manager || ''}
                          onChange={(e) =>
                            setEditForm({ ...editForm, account_manager: e.target.value })
                          }
                          className={inputClass}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Address */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
                      Address
                    </h3>
                    <textarea
                      value={editForm.address || ''}
                      onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                      rows={3}
                      placeholder="Full address..."
                      className={inputClass}
                    />
                  </div>

                  {/* Notes */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
                      Internal Notes
                    </h3>
                    <textarea
                      value={editForm.notes || ''}
                      onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                      rows={3}
                      placeholder="Internal notes..."
                      className={inputClass}
                    />
                  </div>

                  {/* Attachments */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
                      Attachments
                    </h3>
                    <AttachmentsField
                      savedAttachments={editForm.attachments || []}
                      onSavedChange={(val) => setEditForm({ ...editForm, attachments: val })}
                      pendingFiles={pendingFiles}
                      onPendingChange={setPendingFiles}
                    />
                  </div>
                </div>
              ) : (
                // View Mode
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  {/* Left Column */}
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                        Contact Information
                      </h3>
                      <div className="space-y-3">
                        <DetailRow
                          icon="👤"
                          label="Contact Person"
                          value={customer.contact_person}
                        />
                        <DetailRow icon="📱" label="Mobile" value={customer.mobile} />
                        <DetailRow icon="📞" label="Landline" value={customer.landline} />
                        <DetailRow
                          icon="✉️"
                          label="Email"
                          value={
                            customer.email ? (
                              <a
                                href={`mailto:${customer.email}`}
                                className="text-indigo-600 hover:underline"
                              >
                                {customer.email}
                              </a>
                            ) : null
                          }
                        />
                        <DetailRow
                          icon="👔"
                          label="Account Manager"
                          value={customer.account_manager}
                        />
                      </div>
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                        System Info
                      </h3>
                      <div className="space-y-3">
                        <DetailRow
                          icon="🔢"
                          label="Customer Code"
                          value={
                            customer.customer_code ? (
                              <span className="font-mono text-sm">{customer.customer_code}</span>
                            ) : null
                          }
                        />
                        <DetailRow
                          icon="📅"
                          label="Customer Since"
                          value={formatDate(customer.created_date)}
                        />
                        <DetailRow
                          icon="🔄"
                          label="Last Updated"
                          value={formatDateTime(customer.updated_date)}
                        />
                        <DetailRow icon="👤" label="Created By" value={customer.created_by} />
                      </div>
                    </div>
                  </div>

                  {/* Right Column */}
                  <div className="space-y-6">
                    {customer.customer_type === 'B2B' && (
                      <div>
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                          Company Information
                        </h3>
                        <div className="space-y-3">
                          <DetailRow icon="🏢" label="Company Name" value={customer.company_name} />
                          <DetailRow icon="📄" label="CR Number" value={customer.cr_number} />
                          <DetailRow icon="🧾" label="Tax ID" value={customer.tax_id} />
                        </div>
                      </div>
                    )}

                    <div>
                      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                        Address
                      </h3>
                      {customer.address ? (
                        <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-700 whitespace-pre-wrap">
                          {customer.address}
                        </div>
                      ) : (
                        <p className="text-gray-500 text-sm">No address on file</p>
                      )}
                    </div>

                    {customer.notes && (
                      <div>
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                          Internal Notes
                        </h3>
                        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-gray-700 whitespace-pre-wrap">
                          {customer.notes}
                        </div>
                      </div>
                    )}

                    {(customer.attachments || []).length > 0 && (
                      <div>
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
                          Attachments
                        </h3>
                        <div className="space-y-2">
                          {customer.attachments.map((att, i) => (
                            <a
                              key={i}
                              href={att.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-3 px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg hover:bg-indigo-50 hover:border-indigo-300 transition-colors group"
                            >
                              <svg
                                className="w-5 h-5 text-gray-500 group-hover:text-indigo-500 flex-shrink-0"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                                />
                              </svg>
                              <span className="text-sm text-gray-700 group-hover:text-indigo-700 flex-1 truncate">
                                {att.name}
                              </span>
                              {att.size && (
                                <span className="text-xs text-gray-500 flex-shrink-0">
                                  {(att.size / 1024).toFixed(0)} KB
                                </span>
                              )}
                              <svg
                                className="w-4 h-4 text-gray-300 group-hover:text-indigo-400 flex-shrink-0"
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
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ==================== RMA HISTORY TAB ==================== */}
          {activeTab === 'rma' && (
            <div>
              {tickets.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <div className="text-4xl mb-3">🎫</div>
                  <p className="font-medium">No RMA tickets found</p>
                  <p className="text-sm">This customer has no RMA history yet</p>
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
                          Status
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Priority
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Issue
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Created
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Action
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {tickets.map((ticket) => (
                        <tr key={ticket.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3">
                            <span className="font-mono text-sm font-medium text-indigo-600">
                              {ticket.rma_number || ticket.id?.slice(0, 8)}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {getTicketStatusBadge(ticket.ticket_status)}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`px-2 py-1 text-xs rounded-full font-medium ${
                                ticket.priority === 'High'
                                  ? 'bg-red-100 text-red-800'
                                  : ticket.priority === 'Medium'
                                    ? 'bg-yellow-100 text-yellow-800'
                                    : ticket.priority === 'Critical'
                                      ? 'bg-red-200 text-red-900'
                                      : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {ticket.priority || 'Low'}
                            </span>
                          </td>
                          <td
                            className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate"
                            title={ticket.general_description || ''}
                          >
                            {ticket.general_description || '—'}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">
                            {formatDate(ticket.created_date)}
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => onNavigateToTicket(ticket.id)}
                              className="text-indigo-600 hover:text-indigo-900 text-sm font-medium hover:underline"
                            >
                              View →
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ==================== NOTES TAB ==================== */}
          {activeTab === 'notes' && (
            <div className="space-y-4">
              <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                <h3 className="font-medium text-gray-900">Add a Note</h3>
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Write an internal note about this customer..."
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
                />
                <div className="flex justify-end">
                  <button
                    onClick={handleAddNote}
                    disabled={!newNote.trim() || savingNote}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    {savingNote ? (
                      <Spinner size="sm" color="white" />
                    ) : (
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
                          d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                        />
                      </svg>
                    )}
                    Add Note
                  </button>
                </div>
              </div>

              {notes.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <div className="text-3xl mb-2">📝</div>
                  <p>No notes yet. Add the first note above.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {notes.map((note) => (
                    <div key={note.id} className="bg-white border border-gray-200 rounded-lg p-4">
                      {editingNote === note.id ? (
                        <div className="space-y-3">
                          <textarea
                            value={editNoteText}
                            onChange={(e) => setEditNoteText(e.target.value)}
                            rows={3}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
                          />
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => {
                                setEditingNote(null)
                                setEditNoteText('')
                              }}
                              className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => handleUpdateNote(note.id)}
                              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm transition-colors"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <p className="text-gray-800 whitespace-pre-wrap">{note.note}</p>
                          <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
                            <div className="text-xs text-gray-500">
                              <span className="font-medium">{note.created_by || 'Unknown'}</span>
                              {' · '}
                              {formatDateTime(note.created_date)}
                              {note.updated_date !== note.created_date && ' (edited)'}
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => {
                                  setEditingNote(note.id)
                                  setEditNoteText(note.note)
                                }}
                                className="text-indigo-600 hover:text-indigo-900 text-xs font-medium"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => handleDeleteNote(note.id)}
                                className="text-red-600 hover:text-red-900 text-xs font-medium"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ==================== ACTIVITY LOG TAB ==================== */}
          {activeTab === 'activity' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500 mb-4">
                Timeline of all activity for this customer
              </p>
              {[
                ...tickets.map((t) => ({
                  type: 'ticket',
                  date: t.created_date,
                  icon: '🎫',
                  color: 'bg-blue-100',
                  title: 'RMA Ticket Created',
                  detail: `${t.rma_number || t.id?.slice(0, 8)} — ${t.issue_description || t.title || 'No description'}`,
                  action: () => onNavigateToTicket(t.id),
                })),
                ...notes.map((n) => ({
                  type: 'note',
                  date: n.created_date,
                  icon: '📝',
                  color: 'bg-yellow-100',
                  title: 'Note Added',
                  detail: n.note.length > 80 ? n.note.slice(0, 80) + '...' : n.note,
                  by: n.created_by,
                })),
                {
                  type: 'created',
                  date: customer.created_date,
                  icon: '✅',
                  color: 'bg-green-100',
                  title: 'Customer Created',
                  detail: `Added by ${customer.created_by || 'Unknown'}`,
                },
              ]
                .filter((e) => e.date)
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .map((event, idx) => (
                  <div key={idx} className="flex gap-4 items-start">
                    <div
                      className={`w-10 h-10 rounded-full ${event.color} flex items-center justify-center flex-shrink-0 text-lg`}
                    >
                      {event.icon}
                    </div>
                    <div className="flex-1 pb-4 border-b border-gray-100 last:border-0">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-gray-900">{event.title}</p>
                        <span className="text-xs text-gray-500">{formatDateTime(event.date)}</span>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">{event.detail}</p>
                      {event.action && (
                        <button
                          onClick={event.action}
                          className="text-xs text-indigo-600 hover:underline mt-1"
                        >
                          View ticket →
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              {tickets.length === 0 && notes.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <div className="text-3xl mb-2">📋</div>
                  <p>No activity yet for this customer</p>
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

function DetailRow({ icon, label, value }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-lg flex-shrink-0">{icon}</span>
      <div>
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <div className="text-sm text-gray-900">
          {value || <span className="text-gray-500">—</span>}
        </div>
      </div>
    </div>
  )
}
