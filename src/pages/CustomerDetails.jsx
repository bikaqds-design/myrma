import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db, storage, branding as brandingAPI } from '../api/supabaseClient'
import QRCode from 'qrcode'
import toast from 'react-hot-toast'
import ConfirmDialog from '../components/ConfirmDialog'
import { CardSkeleton } from '../components/Skeleton'
import AttachmentsField from '../components/AttachmentsField'
import { Button, Spinner, Ltr } from '../components/ui'
import { useURLTab } from '../hooks/useURLTab'
import { ROLES, TICKET_STATUS } from '../lib/constants'
import { captureException } from '../lib/sentry'
import { EMPTY_ARRAY } from '../lib/stableEmpty'

export default function CustomerDetails({
  customerId,
  currentUserRole,
  currentUserEmail,
  currentUserPermissions,
  onBack,
  onNavigateToTicket,
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: customerPageData, isLoading: loading } = useQuery({
    queryKey: ['customer-details', customerId],
    queryFn: async () => {
      // Fetch customer + notes in parallel first, then tickets using both
      // customer_id FK and customer_name string so legacy tickets are found too.
      const [customerData, notesData] = await Promise.all([
        db.customers.get(customerId),
        db.customerNotes.list(customerId),
      ])
      const displayNames = [
        customerData?.company_name,
        customerData?.contact_person,
      ].filter(Boolean)
      const ticketsData = await db.customers.getRelatedTickets(customerId, displayNames)
      return { customerData, ticketsData, notesData }
    },
    enabled: !!customerId,
  })

  const { data: contacts = EMPTY_ARRAY } = useQuery({
    queryKey: ['contacts', customerId],
    queryFn: () => db.contacts.list(customerId),
    staleTime: 60_000,
    enabled: !!customerId,
  })

  const { data: customerDeals = EMPTY_ARRAY } = useQuery({
    queryKey: ['customer-deals', customerId],
    queryFn: () => db.deals.listForCustomer(customerId),
    staleTime: 60_000,
    enabled: !!customerId,
  })

  const customer = customerPageData?.customerData ?? null
  const tickets = customerPageData?.ticketsData ?? []
  const [notes, setNotes] = useState([])
  const [activeTab, setActiveTab] = useURLTab('tab', 'profile')
  const [isEditing, setIsEditing] = useState(false)
  const [editForm, setEditForm] = useState({})

  const { data: ledger = EMPTY_ARRAY } = useQuery({
    queryKey: ['customer-ledger', customerId],
    queryFn: () => db.customerLedger.list(customerId),
    staleTime: 30_000,
    enabled: !!customerId && activeTab === 'billing',
  })
  const [pendingFiles, setPendingFiles] = useState([])
  const [newNote, setNewNote] = useState('')
  const [editingNote, setEditingNote] = useState(null)
  const [editNoteText, setEditNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [drawerTicket, setDrawerTicket] = useState(null)   // ticket shown in the RMA detail drawer
  const [drawerComments, setDrawerComments] = useState([])
  const [drawerCommentsLoading, setDrawerCommentsLoading] = useState(false)

  const EMPTY_CONTACT_FORM = { full_name: '', title: '', phone: '', email: '', is_primary: false, notes: '' }
  const [contactForm, setContactForm] = useState(EMPTY_CONTACT_FORM)
  const [editingContact, setEditingContact] = useState(null)
  const [showContactForm, setShowContactForm] = useState(false)
  const [savingContact, setSavingContact] = useState(false)

  const openTicketDrawer = async (ticket) => {
    setDrawerTicket(ticket)
    setDrawerComments([])
    setDrawerCommentsLoading(true)
    try {
      const result = await db.ticketComments.list(ticket.id)
      const comments = result?.data ?? result ?? []
      setDrawerComments(Array.isArray(comments) ? comments : [])
    } catch {
      setDrawerComments([])
    } finally {
      setDrawerCommentsLoading(false)
    }
  }

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

  // Sync notes and editForm when query data loads
  useEffect(() => {
    if (!customerPageData) return
    setNotes(customerPageData.notesData || [])
    setEditForm(customerPageData.customerData || {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId])

  const handleSaveEdit = async () => {
    if (!editForm.contact_person?.trim() || !editForm.mobile?.trim()) {
      toast.error(t('customerDetails.errorContactRequired'))
      return
    }
    if (editForm.customer_type === 'B2B' && !editForm.company_name?.trim()) {
      toast.error(t('customerDetails.errorCompanyRequired'))
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
          toast.error(t('customers.failedUploadFile', { name: file.name, error: err.message }))
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
        credit_limit: editForm.credit_limit === '' || editForm.credit_limit == null ? null : Number(editForm.credit_limit),
        notes: editForm.notes || null,
        attachments: allAttachments,
        updated_by: currentUserEmail,
        updated_date: new Date().toISOString(),
      })
      setEditForm(updated)
      setPendingFiles([])
      setIsEditing(false)
      queryClient.invalidateQueries({ queryKey: ['customer-details', customerId] })
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      toast.success(t('customerDetails.successUpdated'))
      db.auditLog
        .log(
          currentUserEmail,
          'customer_updated',
          `Updated customer ${editForm.contact_person}${editForm.company_name ? ` (${editForm.company_name})` : ''}`
        )
        .catch((err) => captureException(err))
    } catch (error) {
      toast.error(t('customerDetails.failedUpdate', { error: error.message }))
    }
  }

  const handleDelete = () => {
    openConfirm(
      t('customerDetails.deleteCustomerTitle'),
      t('customerDetails.deleteCustomerMsg', { name: customer.contact_person }),
      async () => {
        closeConfirm()
        try {
          await db.customers.delete(customerId)
          toast.success(t('customerDetails.successDeleted'))
          db.auditLog
            .log(
              currentUserEmail,
              'customer_deleted',
              `Deleted customer ${customer.contact_person}${customer.company_name ? ` (${customer.company_name})` : ''}`
            )
            .catch((err) => captureException(err))
          onBack()
        } catch {
          toast.error(t('customerDetails.errorDelete'))
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
      toast.success(t('customerDetails.noteAdded'))
      db.auditLog
        .log(
          currentUserEmail,
          'customer_note_added',
          `Added note on customer ${customer?.contact_person}`
        )
        .catch((err) => captureException(err))
    } catch {
      toast.error(t('customerDetails.errorAddNote'))
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
      toast.success(t('customerDetails.noteUpdated'))
      db.auditLog
        .log(
          currentUserEmail,
          'customer_note_updated',
          `Updated note ${noteId} on customer ${customer?.contact_person}`
        )
        .catch((err) => captureException(err))
    } catch {
      toast.error(t('customerDetails.errorUpdateNote'))
    }
  }

  const handleDeleteNote = (noteId) => {
    openConfirm(t('customerDetails.deleteNoteTitle'), t('customerDetails.deleteNoteMsg'), async () => {
      closeConfirm()
      try {
        await db.customerNotes.delete(noteId)
        setNotes((prev) => prev.filter((n) => n.id !== noteId))
        toast.success(t('customerDetails.noteDeleted'))
        db.auditLog
          .log(
            currentUserEmail,
            'customer_note_deleted',
            `Deleted note ${noteId} on customer ${customer?.contact_person}`
          )
          .catch((err) => captureException(err))
      } catch {
        toast.error(t('customerDetails.errorDeleteNote'))
      }
    })
  }

  const handleSaveContact = async () => {
    if (!contactForm.full_name.trim()) {
      toast.error(t('customerDetails.contactNameRequired'))
      return
    }
    setSavingContact(true)
    try {
      if (editingContact) {
        await db.contacts.update(editingContact, contactForm)
      } else {
        await db.contacts.create({ ...contactForm, customer_id: customerId, created_by: currentUserEmail })
      }
      queryClient.invalidateQueries({ queryKey: ['contacts', customerId] })
      setContactForm(EMPTY_CONTACT_FORM)
      setEditingContact(null)
      setShowContactForm(false)
      toast.success(editingContact ? t('customerDetails.contactUpdated') : t('customerDetails.contactAdded'))
    } catch (err) {
      toast.error(t('customerDetails.errorSaveContact', { error: err.message }))
    } finally {
      setSavingContact(false)
    }
  }

  const handleDeleteContact = (contactId) => {
    openConfirm(t('customerDetails.deleteContactTitle'), t('customerDetails.deleteContactMsg'), async () => {
      closeConfirm()
      try {
        await db.contacts.delete(contactId)
        queryClient.invalidateQueries({ queryKey: ['contacts', customerId] })
        toast.success(t('customerDetails.contactDeleted'))
      } catch {
        toast.error(t('customerDetails.errorDeleteContact'))
      }
    })
  }

  const getStatusBadge = (status) => {
    const style = status === 'Active' ? 'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400' : 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]'
    return (
      <span className={`px-3 py-1 text-sm rounded-full font-medium ${style}`}>
        {status || 'Unknown'}
      </span>
    )
  }

  const getTypeBadge = (type) => {
    const style = type === 'B2B' ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-400' : 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-400'
    return (
      <span className={`px-2 py-1 text-xs rounded-full font-medium ${style}`}>
        {type === 'B2B' ? '🏢 B2B' : '👤 B2C'}
      </span>
    )
  }

  const getTicketStatusBadge = (status) => {
    const styles = {
      New: 'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-400',
      'In Progress': 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-400',
      'On Hold': 'bg-orange-100 dark:bg-orange-900/20 text-orange-800 dark:text-orange-300',
      Completed: 'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400',
      Cancelled: 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]',
    }
    return (
      <span
        className={`px-2 py-1 text-xs rounded-full font-medium ${styles[status] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]'}`}
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
        <p className="text-gray-500">{t('customerDetails.notFound')}</p>
        <Button className="mt-4" onClick={onBack}>
          {t('common.back')}
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
            {t('customerDetails.backToCustomers')}
          </button>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-lg">
              {displayName?.[0]?.toUpperCase() || '?'}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{displayName}</h1>
              {customer.customer_type === 'B2B' && customer.contact_person && (
                <p className="text-sm text-gray-500">{t('customerDetails.contactLabel')} {customer.contact_person}</p>
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
              {t('common.cancel')}
            </Button>
            <Button variant="success" onClick={handleSaveEdit}>
              {t('customerDetails.saveChanges')}
            </Button>
          </div>
        )}
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: t('customerDetails.totalRMAs'),
            value: tickets.length,
            icon: '🎫',
            color: 'bg-blue-50 text-blue-700',
          },
          {
            label: t('customerDetails.openTickets'),
            value: tickets.filter(
              (t) =>
                t.ticket_status === TICKET_STATUS.OPEN ||
                t.ticket_status === TICKET_STATUS.IN_PROGRESS ||
                t.ticket_status === TICKET_STATUS.ON_HOLD
            ).length,
            icon: '🔓',
            color: 'bg-yellow-50 text-yellow-700',
          },
          {
            label: t('common.notes'),
            value: notes.length,
            icon: '📝',
            color: 'bg-purple-50 text-purple-700',
          },
          {
            label: t('customerDetails.customerSince'),
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
          <nav className="flex gap-4 sm:gap-6 px-6">
            {[
              { key: 'profile',  label: t('customerDetails.tabProfile'), icon: '👤' },
              { key: 'contacts', label: t('customerDetails.tabContacts', { count: contacts.length }), icon: '👥' },
              { key: 'deals',    label: t('customerDetails.tabDeals', { count: customerDeals.length }), icon: '💼' },
              { key: 'billing',  label: t('customerDetails.tabBilling'), icon: '💳' },
              { key: 'rma',      label: t('customerDetails.tabRMAHistory', { count: tickets.length }), icon: '🎫' },
              { key: 'notes',    label: t('customerDetails.tabNotes', { count: notes.length }), icon: '📝' },
              { key: 'activity', label: t('customerDetails.tabActivity'), icon: '📋' },
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
                      {t('customerDetails.sectionTypeStatus')}
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className={labelClass}>
                          {t('customerModal.customerType')} <span className="text-red-500">*</span>
                        </label>
                        <select aria-label={t('customerModal.customerType')}
                          value={editForm.customer_type || 'B2B'}
                          onChange={(e) =>
                            setEditForm({ ...editForm, customer_type: e.target.value })
                          }
                          className={inputClass}
                        >
                          <option value="B2B">{t('customerDetails.typeB2BBusiness')}</option>
                          <option value="B2C">{t('customerModal.typeB2C')}</option>
                        </select>
                      </div>
                      <div>
                        <label className={labelClass}>
                          {t('common.status')} <span className="text-red-500">*</span>
                        </label>
                        <select aria-label={t('common.status')}
                          value={editForm.customer_status || 'Active'}
                          onChange={(e) =>
                            setEditForm({ ...editForm, customer_status: e.target.value })
                          }
                          className={inputClass}
                        >
                          <option value="Active">{t('customerModal.statusActive')}</option>
                          <option value="Inactive">{t('customerModal.statusInactive')}</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* B2B fields */}
                  {editForm.customer_type === 'B2B' && (
                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
                        {t('customerDetails.sectionCompany')}
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className={labelClass}>
                            {t('customerModal.companyName')} <span className="text-red-500">*</span>
                          </label>
                          <input aria-label={t('customerModal.companyName')}
                            type="text"
                            value={editForm.company_name || ''}
                            onChange={(e) =>
                              setEditForm({ ...editForm, company_name: e.target.value })
                            }
                            className={inputClass}
                          />
                        </div>
                        <div>
                          <label className={labelClass}>{t('customerModal.crNumber')}</label>
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
                          <label className={labelClass}>{t('customerModal.taxId')}</label>
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
                      {t('customerDetails.sectionContact')}
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className={labelClass}>
                          {t('customerModal.contactPerson')} <span className="text-red-500">*</span>
                        </label>
                        <input aria-label={t('customerModal.contactPerson')}
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
                          {t('customerModal.mobile')} <span className="text-red-500">*</span>
                        </label>
                        <input aria-label={t('customerModal.mobile')}
                          type="tel"
                          value={editForm.mobile || ''}
                          onChange={(e) => setEditForm({ ...editForm, mobile: e.target.value })}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>{t('customerModal.landline')}</label>
                        <input
                          type="tel"
                          value={editForm.landline || ''}
                          onChange={(e) => setEditForm({ ...editForm, landline: e.target.value })}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>{t('common.email')}</label>
                        <input
                          type="email"
                          value={editForm.email || ''}
                          onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>{t('customerModal.accountManager')}</label>
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
                      {t('common.address')}
                    </h3>
                    <textarea
                      value={editForm.address || ''}
                      onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                      rows={3}
                      placeholder={t('customerDetails.addressPlaceholder')}
                      className={inputClass}
                    />
                  </div>

                  {/* Billing */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
                      {t('customerDetails.sectionBilling')}
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className={labelClass}>{t('customerDetails.creditLimit')}</label>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={editForm.credit_limit ?? ''}
                          onChange={(e) => setEditForm({ ...editForm, credit_limit: e.target.value })}
                          placeholder={t('customerDetails.creditLimitPlaceholder')}
                          className={inputClass}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Notes */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
                      {t('customerDetails.internalNotes')}
                    </h3>
                    <textarea
                      value={editForm.notes || ''}
                      onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                      rows={3}
                      placeholder={t('customerDetails.internalNotesPlaceholder')}
                      className={inputClass}
                    />
                  </div>

                  {/* Attachments */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
                      {t('customerModal.attachments')}
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
                        {t('customerDetails.sectionContact')}
                      </h3>
                      <div className="space-y-3">
                        <DetailRow
                          icon="👤"
                          label={t('customerModal.contactPerson')}
                          value={customer.contact_person}
                        />
                        <DetailRow icon="📱" label={t('customerModal.mobile')} value={customer.mobile} />
                        <DetailRow icon="📞" label={t('customerModal.landline')} value={customer.landline} />
                        <DetailRow
                          icon="✉️"
                          label={t('common.email')}
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
                          label={t('customerModal.accountManager')}
                          value={customer.account_manager}
                        />
                      </div>
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                        {t('customerDetails.sectionSystemInfo')}
                      </h3>
                      <div className="space-y-3">
                        <DetailRow
                          icon="🔢"
                          label={t('customerDetails.customerCode')}
                          value={
                            customer.customer_code ? (
                              <span className="font-mono text-sm">{customer.customer_code}</span>
                            ) : null
                          }
                        />
                        <DetailRow
                          icon="📅"
                          label={t('customerDetails.customerSince')}
                          value={formatDate(customer.created_date)}
                        />
                        <DetailRow
                          icon="🔄"
                          label={t('customerDetails.lastUpdated')}
                          value={formatDateTime(customer.updated_date)}
                        />
                        <DetailRow icon="👤" label={t('customerDetails.createdBy')} value={customer.created_by} />
                      </div>
                    </div>
                  </div>

                  {/* Right Column */}
                  <div className="space-y-6">
                    {customer.customer_type === 'B2B' && (
                      <div>
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                          {t('customerDetails.sectionCompany')}
                        </h3>
                        <div className="space-y-3">
                          <DetailRow icon="🏢" label={t('customerModal.companyName')} value={customer.company_name} />
                          <DetailRow icon="📄" label={t('customerModal.crNumber')} value={customer.cr_number} />
                          <DetailRow icon="🧾" label={t('customerModal.taxId')} value={customer.tax_id} />
                        </div>
                      </div>
                    )}

                    <div>
                      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                        {t('common.address')}
                      </h3>
                      {customer.address ? (
                        <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-700 whitespace-pre-wrap">
                          {customer.address}
                        </div>
                      ) : (
                        <p className="text-gray-500 text-sm">{t('customerDetails.noAddress')}</p>
                      )}
                    </div>

                    {customer.credit_limit != null && (
                      <div>
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                          {t('customerDetails.sectionBilling')}
                        </h3>
                        <div className="space-y-3">
                          <DetailRow
                            icon="💳"
                            label={t('customerDetails.creditLimit')}
                            value={Number(customer.credit_limit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          />
                        </div>
                      </div>
                    )}

                    {customer.notes && (
                      <div>
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                          {t('customerDetails.internalNotes')}
                        </h3>
                        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-gray-700 whitespace-pre-wrap">
                          {customer.notes}
                        </div>
                      </div>
                    )}

                    {(customer.attachments || []).length > 0 && (
                      <div>
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
                          {t('customerModal.attachments')}
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
                  <p className="font-medium">{t('customerDetails.noTickets')}</p>
                  <p className="text-sm">{t('customerDetails.noTicketsHint')}</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-y border-gray-200">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('customerDetails.colRmaNumber')}</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('common.status')}</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('common.priority')}</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('customerDetails.colIssue')}</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('customerDetails.colCreated')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {tickets.map((ticket) => (
                        <tr
                          key={ticket.id}
                          className="hover:bg-indigo-50 cursor-pointer transition-colors"
                          onClick={() => openTicketDrawer(ticket)}
                        >
                          <td className="px-4 py-3">
                            <span className="font-mono text-sm font-semibold text-indigo-600 hover:underline">
                              {ticket.rma_number || ticket.id?.slice(0, 8)}
                            </span>
                          </td>
                          <td className="px-4 py-3">{getTicketStatusBadge(ticket.ticket_status)}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-1 text-xs rounded-full font-medium ${
                              ticket.priority === 'Critical' ? 'bg-red-200 text-red-900'
                              : ticket.priority === 'High' ? 'bg-red-100 text-red-800'
                              : ticket.priority === 'Medium' ? 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-400'
                              : 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]'
                            }`}>
                              {ticket.priority || 'Low'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate" title={ticket.general_description || ''}>
                            {ticket.general_description || '—'}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">{formatDate(ticket.created_date)}</td>
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
                <h3 className="font-medium text-gray-900">{t('customerDetails.addNote')}</h3>
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={t('customerDetails.notePlaceholder')}
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
                    {t('customerDetails.addNoteBtn')}
                  </button>
                </div>
              </div>

              {notes.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <div className="text-3xl mb-2">📝</div>
                  <p>{t('customerDetails.noNotes')}</p>
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
                              {t('common.cancel')}
                            </button>
                            <button
                              onClick={() => handleUpdateNote(note.id)}
                              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm transition-colors"
                            >
                              {t('common.save')}
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
                              {note.updated_date !== note.created_date && ` ${t('customerDetails.edited')}`}
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => {
                                  setEditingNote(note.id)
                                  setEditNoteText(note.note)
                                }}
                                className="text-indigo-600 hover:text-indigo-900 text-xs font-medium"
                              >
                                {t('common.edit')}
                              </button>
                              <button
                                onClick={() => handleDeleteNote(note.id)}
                                className="text-red-600 hover:text-red-900 text-xs font-medium"
                              >
                                {t('common.delete')}
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

          {/* ==================== CONTACTS TAB ==================== */}
          {activeTab === 'contacts' && (
            <div className="space-y-4">
              {/* Toolbar */}
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">{t('customerDetails.contactsHint')}</p>
                {canDo('edit') && !showContactForm && (
                  <button
                    onClick={() => { setContactForm(EMPTY_CONTACT_FORM); setEditingContact(null); setShowContactForm(true) }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    {t('customerDetails.addContact')}
                  </button>
                )}
              </div>

              {/* Add / Edit form */}
              {showContactForm && (
                <div className="bg-gray-50 dark:bg-[#0f1520] border border-gray-200 dark:border-[#212a38] rounded-xl p-5 space-y-4">
                  <h3 className="font-semibold text-gray-900 dark:text-[#e8ebf0]">
                    {editingContact ? t('customerDetails.editContact') : t('customerDetails.addContact')}
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('customerDetails.colContactName')} *</label>
                      <input type="text" value={contactForm.full_name}
                        onChange={(e) => setContactForm({ ...contactForm, full_name: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-[#212a38] rounded-lg bg-white dark:bg-[#121823] text-gray-900 dark:text-[#e8ebf0] focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('customerDetails.colTitle')}</label>
                      <input type="text" value={contactForm.title || ''}
                        onChange={(e) => setContactForm({ ...contactForm, title: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-[#212a38] rounded-lg bg-white dark:bg-[#121823] text-gray-900 dark:text-[#e8ebf0] focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('common.phone')}</label>
                      <input type="tel" value={contactForm.phone || ''}
                        onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-[#212a38] rounded-lg bg-white dark:bg-[#121823] text-gray-900 dark:text-[#e8ebf0] focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('common.email')}</label>
                      <input type="email" value={contactForm.email || ''}
                        onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-[#212a38] rounded-lg bg-white dark:bg-[#121823] text-gray-900 dark:text-[#e8ebf0] focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('common.notes')}</label>
                    <textarea rows={2} value={contactForm.notes || ''}
                      onChange={(e) => setContactForm({ ...contactForm, notes: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-[#212a38] rounded-lg bg-white dark:bg-[#121823] text-gray-900 dark:text-[#e8ebf0] focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none" />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={contactForm.is_primary}
                      onChange={(e) => setContactForm({ ...contactForm, is_primary: e.target.checked })}
                      className="w-4 h-4 rounded text-indigo-600 border-gray-300 focus:ring-indigo-500" />
                    <span className="text-sm font-medium text-gray-700 dark:text-[#9aa4b2]">{t('customerDetails.setPrimary')}</span>
                  </label>
                  <div className="flex gap-2 justify-end pt-1">
                    <button onClick={() => { setShowContactForm(false); setEditingContact(null); setContactForm(EMPTY_CONTACT_FORM) }}
                      className="px-4 py-2 text-sm border border-gray-300 dark:border-[#212a38] text-gray-700 dark:text-[#9aa4b2] rounded-lg hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors">
                      {t('common.cancel')}
                    </button>
                    <button onClick={handleSaveContact} disabled={savingContact}
                      className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2 transition-colors">
                      {savingContact && <Spinner size="sm" color="white" />}
                      {t('common.save')}
                    </button>
                  </div>
                </div>
              )}

              {/* Contacts table */}
              {contacts.length === 0 && !showContactForm ? (
                <div className="text-center py-12 text-gray-500">
                  <svg className="mx-auto w-10 h-10 mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <p className="font-medium">{t('customerDetails.noContacts')}</p>
                  <p className="text-sm mt-1">{t('customerDetails.noContactsHint')}</p>
                </div>
              ) : contacts.length > 0 && (
                <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-[#212a38]">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-gray-200 dark:border-[#212a38]">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colContactName')}</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colTitle')}</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('common.phone')}</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('common.email')}</th>
                        {canDo('edit') && <th className="px-4 py-3" />}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-[#1a2230]">
                      {contacts.map((c) => (
                        <tr key={c.id} className="bg-white dark:bg-[#121823] hover:bg-gray-50 dark:hover:bg-[#0f1520] transition-colors">
                          <td className="px-4 py-3 font-medium text-gray-900 dark:text-[#e8ebf0]">
                            <div className="flex items-center gap-2">
                              {c.full_name}
                              {c.is_primary && (
                                <span className="px-1.5 py-0.5 text-xs font-semibold rounded bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-[#a5b4fc]">
                                  {t('customerDetails.primaryBadge')}
                                </span>
                              )}
                            </div>
                            {c.notes && <p className="text-xs text-gray-400 dark:text-[#a4acb7] mt-0.5 truncate max-w-[180px]">{c.notes}</p>}
                          </td>
                          <td className="px-4 py-3 text-gray-600 dark:text-[#9aa4b2]">{c.title || '—'}</td>
                          <td className="px-4 py-3 text-gray-600 dark:text-[#9aa4b2]">{c.phone ? <Ltr>{c.phone}</Ltr> : '—'}</td>
                          <td className="px-4 py-3 text-gray-600 dark:text-[#9aa4b2]">{c.email || '—'}</td>
                          {canDo('edit') && (
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2 justify-end">
                                <button onClick={() => { setContactForm({ full_name: c.full_name, title: c.title || '', phone: c.phone || '', email: c.email || '', is_primary: c.is_primary, notes: c.notes || '' }); setEditingContact(c.id); setShowContactForm(true) }}
                                  className="text-xs text-indigo-600 dark:text-[#a5b4fc] hover:underline font-medium">
                                  {t('common.edit')}
                                </button>
                                <button onClick={() => handleDeleteContact(c.id)}
                                  className="text-xs text-red-500 hover:underline font-medium">
                                  {t('common.delete')}
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ==================== DEALS TAB ==================== */}
          {activeTab === 'deals' && (
            <div>
              {customerDeals.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <svg className="mx-auto w-10 h-10 mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="font-medium">{t('customerDetails.noDeals')}</p>
                  <p className="text-sm mt-1">{t('customerDetails.noDealsHint')}</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-[#212a38]">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-gray-200 dark:border-[#212a38]">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colDealTitle')}</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colDealStage')}</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colDealValue')}</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colDealRep')}</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('common.status')}</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colDealDate')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-[#1a2230]">
                      {customerDeals.map((deal) => {
                        const statusColor = deal.status === 'won' ? 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                          : deal.status === 'lost' ? 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'
                          : 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-[#a5b4fc]'
                        return (
                          <tr key={deal.id}
                            className="bg-white dark:bg-[#121823] hover:bg-indigo-50 dark:hover:bg-[#0f1520] cursor-pointer transition-colors"
                            onClick={() => navigate(`/pipeline/${deal.id}`)}>
                            <td className="px-4 py-3">
                              <div className="font-medium text-gray-900 dark:text-[#e8ebf0]">{deal.title}</div>
                              {deal.deal_code && <div className="text-xs font-mono text-gray-400 dark:text-[#a4acb7]">{deal.deal_code}</div>}
                            </td>
                            <td className="px-4 py-3 text-gray-600 dark:text-[#9aa4b2]">{deal.stage || '—'}</td>
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-[#e8ebf0]">
                              {deal.value != null ? `$${Number(deal.value).toLocaleString()}` : '—'}
                            </td>
                            <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] truncate max-w-[140px]">{deal.assigned_rep || '—'}</td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${statusColor}`}>
                                {t(`pipeline.${deal.status}`)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2]">{formatDate(deal.created_at)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ==================== BILLING TAB ==================== */}
          {activeTab === 'billing' && (
            <div className="space-y-4">
              {(() => {
                const balance = ledger.reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
                const overLimit = customer?.credit_limit != null && balance > Number(customer.credit_limit)
                return (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="bg-gray-50 dark:bg-[#0f1520] rounded-xl border border-gray-200 dark:border-[#212a38] p-4">
                      <div className="text-xs uppercase text-gray-500 dark:text-[#9aa4b2] mb-1">{t('customerDetails.outstandingBalance')}</div>
                      <div className="text-xl font-bold text-gray-900 dark:text-[#e8ebf0]">
                        {balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                    {customer?.credit_limit != null && (
                      <div className={`rounded-xl border p-4 ${overLimit ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-gray-50 dark:bg-[#0f1520] border-gray-200 dark:border-[#212a38]'}`}>
                        <div className={`text-xs uppercase mb-1 ${overLimit ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-[#9aa4b2]'}`}>{t('customerDetails.creditLimit')}</div>
                        <div className={`text-xl font-bold ${overLimit ? 'text-red-700 dark:text-red-400' : 'text-gray-900 dark:text-[#e8ebf0]'}`}>
                          {Number(customer.credit_limit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        {overLimit && (
                          <div className="text-xs text-red-600 dark:text-red-400 mt-1">{t('customerDetails.overCreditLimit')}</div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })()}

              {ledger.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <svg className="mx-auto w-10 h-10 mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
                  </svg>
                  <p className="font-medium">{t('customerDetails.noLedgerEntries')}</p>
                  <p className="text-sm mt-1">{t('customerDetails.noLedgerEntriesHint')}</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-[#212a38]">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-gray-200 dark:border-[#212a38]">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colLedgerDate')}</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colLedgerType')}</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colLedgerCode')}</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colLedgerAmount')}</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colLedgerBalance')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-[#1a2230]">
                      {(() => {
                        let running = 0
                        return ledger.map((entry) => {
                          running += Number(entry.amount) || 0
                          const TYPE_LABEL_KEY = {
                            invoice: 'customerDetails.ledgerTypeInvoice',
                            credit_note: 'customerDetails.ledgerTypeCreditNote',
                            payment: 'customerDetails.ledgerTypePayment',
                          }
                          return (
                            <tr key={entry.id} className="bg-white dark:bg-[#121823]">
                              <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2]">{formatDate(entry.entry_date)}</td>
                              <td className="px-4 py-3 text-gray-600 dark:text-[#9aa4b2]">{t(TYPE_LABEL_KEY[entry.entry_type] ?? entry.entry_type)}</td>
                              <td className="px-4 py-3 font-mono text-xs text-gray-900 dark:text-[#e8ebf0]">{entry.entry_code || '—'}</td>
                              <td className={`px-4 py-3 text-right font-medium ${entry.amount >= 0 ? 'text-gray-900 dark:text-[#e8ebf0]' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                {entry.amount >= 0 ? '+' : ''}{Number(entry.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                              <td className="px-4 py-3 text-right text-gray-500 dark:text-[#9aa4b2]">
                                {running.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            </tr>
                          )
                        })
                      })()}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ==================== ACTIVITY LOG TAB ==================== */}
          {activeTab === 'activity' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500 mb-4">
                {t('customerDetails.activityTimeline')}
              </p>
              {[
                ...tickets.map((tk) => ({
                  type: 'ticket',
                  date: tk.created_date,
                  icon: '🎫',
                  color: 'bg-blue-100',
                  title: t('customerDetails.activityRmaCreated'),
                  detail: `${tk.rma_number || tk.id?.slice(0, 8)} — ${tk.issue_description || tk.title || '—'}`,
                  action: () => onNavigateToTicket(tk.id),
                })),
                ...notes.map((n) => ({
                  type: 'note',
                  date: n.created_date,
                  icon: '📝',
                  color: 'bg-yellow-100',
                  title: t('customerDetails.activityNoteAdded'),
                  detail: n.note.length > 80 ? n.note.slice(0, 80) + '...' : n.note,
                  by: n.created_by,
                })),
                {
                  type: 'created',
                  date: customer.created_date,
                  icon: '✅',
                  color: 'bg-green-100',
                  title: t('customerDetails.activityCustomerCreated'),
                  detail: t('customerDetails.activityAddedBy', { by: customer.created_by || '—' }),
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
                          {t('customerDetails.viewTicket')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              {tickets.length === 0 && notes.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <div className="text-3xl mb-2">📋</div>
                  <p>{t('customerDetails.noActivity')}</p>
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

      {/* ── RMA Ticket Detail Drawer ── */}
      {drawerTicket && (
        <TicketDetailDrawer
          ticket={drawerTicket}
          comments={drawerComments}
          commentsLoading={drawerCommentsLoading}
          formatDate={formatDate}
          formatDateTime={formatDateTime}
          getTicketStatusBadge={getTicketStatusBadge}
          onClose={() => setDrawerTicket(null)}
        />
      )}
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

// ── Ticket Detail Drawer (read-only, opens from RMA History tab) ─────────────
async function exportTicketPDF(ticket, t) {
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
        const val = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
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
      ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
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
  if (!w) {
    toast.error(t('common.popupBlocked'))
    return
  }
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
}

function TicketDetailDrawer({ ticket, comments, commentsLoading, formatDate, formatDateTime, getTicketStatusBadge, onClose }) {
  const { t } = useTranslation()
  const products = ticket.products || []

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-lg bg-white dark:bg-[#121823] shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-[#212a38] flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-mono text-base font-bold text-indigo-600 dark:text-[#a5b4fc] truncate">
              {ticket.rma_number}
            </span>
            {getTicketStatusBadge(ticket.ticket_status)}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 ml-3">
            <button
              onClick={() => exportTicketPDF(ticket, t)}
              title="Export PDF"
              aria-label="Export PDF"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-[#9aa4b2] bg-gray-100 dark:bg-[#1a2230] hover:bg-gray-200 dark:hover:bg-[#212a38] rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              PDF
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-[#1a2230] transition-colors"
            >
              <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Key details grid */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide mb-1">{t('customerDetails.drawerPriority')}</p>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                ticket.priority === 'Critical' ? 'bg-red-200 text-red-900'
                : ticket.priority === 'High' ? 'bg-red-100 text-red-800'
                : ticket.priority === 'Medium' ? 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-400'
                : 'bg-gray-100 text-gray-700'
              }`}>{ticket.priority || 'Low'}</span>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide mb-1">{t('customerDetails.drawerAssignedTo')}</p>
              <p className="font-medium text-gray-800 dark:text-[#e8ebf0] truncate">{ticket.assigned_technician || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide mb-1">{t('customerDetails.drawerCreated')}</p>
              <p className="font-medium text-gray-800 dark:text-[#e8ebf0]">{formatDate(ticket.created_date)}</p>
            </div>
            {ticket.due_date && (
              <div>
                <p className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide mb-1">{t('customerDetails.drawerDueDate')}</p>
                <p className="font-medium text-gray-800 dark:text-[#e8ebf0]">{formatDate(ticket.due_date)}</p>
              </div>
            )}
          </div>

          {/* Description */}
          {ticket.general_description && (
            <div>
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide mb-2">{t('customerDetails.drawerIssueDesc')}</p>
              <p className="text-sm text-gray-700 dark:text-[#e8ebf0] bg-gray-50 dark:bg-[#0f1520] rounded-lg p-3 leading-relaxed whitespace-pre-wrap">
                {ticket.general_description}
              </p>
            </div>
          )}

          {/* Products */}
          {products.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide mb-3">
                {t('customerDetails.drawerItems', { count: products.length })}
              </p>
              <div className="space-y-2">
                {products.map((p, i) => (
                  <div key={i} className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-[#0f1520] rounded-lg border border-gray-100 dark:border-[#212a38]">
                    <div className="w-8 h-8 bg-indigo-100 dark:bg-[#1a2230] rounded-lg flex items-center justify-center flex-shrink-0">
                      <svg className="w-4 h-4 text-indigo-600 dark:text-[#a5b4fc]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0]">{p.product_name || `Item ${i + 1}`}</p>
                      {p.serial_number && <p className="text-xs text-gray-500 dark:text-[#9aa4b2] font-mono mt-0.5">S/N: {p.serial_number}</p>}
                      {p.issue_description && <p className="text-xs text-gray-600 dark:text-[#9aa4b2] mt-1">{p.issue_description}</p>}
                      {p.product_status && (
                        <span className="inline-block mt-1 px-2 py-0.5 text-xs rounded-full font-medium bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400">
                          {p.product_status}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Comments */}
          <div>
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide mb-3">
              {t('customerDetails.drawerComments')}{!commentsLoading && ` (${comments.length})`}
            </p>
            {commentsLoading ? (
              <div className="flex justify-center py-6">
                <div className="animate-spin w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full" />
              </div>
            ) : comments.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-[#a4acb7] text-center py-4">{t('customerDetails.drawerNoComments')}</p>
            ) : (
              <div className="space-y-3">
                {comments.map((c) => {
                  const isTeam = !c.is_customer_comment
                  const name = c.author_name || c.user_email || (isTeam ? 'Team' : 'Customer')
                  return (
                    <div key={c.id} className={`flex gap-3 p-3 rounded-xl border text-sm ${isTeam ? 'bg-indigo-50 dark:bg-[#1a2230] border-indigo-100 dark:border-[#212a38]' : 'bg-gray-50 dark:bg-[#0f1520] border-gray-100 dark:border-[#212a38]'}`}>
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-semibold text-xs flex-shrink-0 ${isTeam ? 'bg-indigo-500' : 'bg-gray-400'}`}>
                        {name[0]?.toUpperCase() || '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-semibold text-gray-900 dark:text-[#e8ebf0] text-xs">{name}</span>
                          {isTeam && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-indigo-100 text-indigo-700 rounded-full">{t('customerDetails.staffBadge')}</span>}
                          <span className="text-xs text-gray-400 dark:text-[#a4acb7] ml-auto">{formatDateTime(c.created_date)}</span>
                        </div>
                        <p className="text-gray-700 dark:text-[#e8ebf0] whitespace-pre-wrap leading-relaxed">{c.comment_text}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
