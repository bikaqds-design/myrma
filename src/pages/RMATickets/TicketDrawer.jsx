import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db, storage, notifications } from '../../api/supabaseClient'
import { ProductSearchInput } from './_shared'
import ActivityTimeline from './ActivityTimeline'
import toast from 'react-hot-toast'
import Modal from '../../components/Modal'
import { Button, Spinner } from '../../components/ui'
import { ROLES, TICKET_STATUS, TICKET_STATUS_RESOLVED } from '../../lib/constants'
import { captureException } from '../../lib/sentry'
import { CreateStandaloneCreditNoteModal } from '../SalesDocuments/_modals'
import {
  getStatusColor,
  getPriorityColor,
  formatDate,
  fmtDateTime,
  fmtBytes,
  isImage,
} from './_utils'

export function TicketDrawer({
  ticket,
  onClose,
  onEdit,
  onExportPDF,
  onNavigateToTicket,
  userEmail,
  userRole,
  userPermissions,
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const products = queryClient.getQueryData(['products']) || []

  const canDo = (action) => {
    if (userRole === ROLES.ADMIN || userRole === ROLES.SUPER_ADMIN) return true
    return userPermissions?.rma_tickets?.[action] === true
  }

  // Comment state
  const [ticketComments, setTicketComments] = useState([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [isInternalComment, setIsInternalComment] = useState(false)
  const [submittingComment, setSubmittingComment] = useState(false)
  const [replyingTo, setReplyingTo] = useState(null)
  const [commentFiles, setCommentFiles] = useState([])
  const commentFileInputRef = useRef(null)

  // Time-tracking state
  const [timeEntries, setTimeEntries] = useState([])
  const [timeEntriesMissing, setTimeEntriesMissing] = useState(false)
  const [timerRunning, setTimerRunning] = useState(false)
  const [timerStart, setTimerStart] = useState(null)
  const [timerNotes, setTimerNotes] = useState('')
  const [manualHours, setManualHours] = useState('')
  const [manualMins, setManualMins] = useState('')
  const [manualNotes, setManualNotes] = useState('')
  const [addingManual, setAddingManual] = useState(false)

  // Serial history state
  const [serialHistory, setSerialHistory] = useState([])
  const [serialHistorySerial, setSerialHistorySerial] = useState('')

  // Parts state
  const [ticketParts, setTicketParts] = useState([])
  const [ticketPartsMissing, setTicketPartsMissing] = useState(false)

  // Activity log state
  const [activityLog, setActivityLog] = useState([])

  // Resolution state
  const [resolution, setResolution] = useState(null)
  const [resolutionLoading, setResolutionLoading] = useState(false)
  const [resolutionEditing, setResolutionEditing] = useState(false)
  const [resolutionSaving, setResolutionSaving] = useState(false)
  const EMPTY_RES = { type: 'replacement', replacement_product_name: '', replacement_serial: '', amount: '', currency: 'USD', reason: '', reference_number: '' }
  const [resForm, setResForm] = useState(EMPTY_RES)

  // Credit note (RMA return) state
  const [showIssueCNModal, setShowIssueCNModal] = useState(false)
  const [issuingCN, setIssuingCN] = useState(false)
  const { data: cnCustomers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: () => db.customers.list(),
    enabled: showIssueCNModal,
    staleTime: 60_000,
  })

  const handleIssueCNFromTicket = async (cn) => {
    setIssuingCN(true)
    try {
      const cnCode = await db.creditNotes.issue(cn.id, userEmail)
      await db.rmaTickets.update(ticket.id, { ticket_status: TICKET_STATUS.CLOSED })
      logActivity('credit_note_created', `${cnCode} issued — ${cn.reason}`)
      queryClient.invalidateQueries({ queryKey: ['rma-tickets'] })
      queryClient.invalidateQueries({ queryKey: ['rma-tickets-count'] })
      queryClient.invalidateQueries({ queryKey: ['sales-documents'] })
      toast.success(t('salesDocuments.cnFromTicketToast', { code: cnCode }))
      setShowIssueCNModal(false)
    } catch (err) {
      captureException(err, { page: 'RMATickets', context: 'issueCNFromTicket' })
      toast.error(t('ticketDrawer.issueCreditNoteFailed'))
    } finally {
      setIssuingCN(false)
    }
  }

  // Load all detail data whenever the ticket changes
  useEffect(() => {
    if (!ticket) return

    // Reset state
    setTicketComments([])
    setNewComment('')
    setTimerRunning(false)
    setTimerStart(null)
    setSerialHistory([])
    setSerialHistorySerial('')
    setReplyingTo(null)
    setCommentFiles([])
    setResolution(null)
    setResolutionEditing(false)
    setActivityLog([])

    // Load comments
    setCommentsLoading(true)
    db.ticketComments
      .list(ticket.id)
      .then((res) => {
        if (!res.missing) setTicketComments(res.data)
      })
      .catch(() => {})
      .finally(() => setCommentsLoading(false))

    // Load time entries
    db.timeEntries
      .list(ticket.id)
      .then((res) => {
        if (res.missing) {
          setTimeEntriesMissing(true)
          setTimeEntries([])
        } else {
          setTimeEntriesMissing(false)
          setTimeEntries(res.data)
        }
      })
      .catch(() => {})

    // Load parts used on this ticket
    db.ticketParts
      .list(ticket.id)
      .then((res) => {
        if (res.missing) {
          setTicketPartsMissing(true)
          setTicketParts([])
        } else {
          setTicketPartsMissing(false)
          setTicketParts(res.data)
        }
      })
      .catch(() => {})

    // Load resolution
    setResolutionLoading(true)
    db.ticketResolutions.get(ticket.id)
      .then((res) => { setResolution(res) })
      .catch(() => {})
      .finally(() => setResolutionLoading(false))
  }, [ticket?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reload activity log whenever the ticket is saved (updated_date changes) so
  // status/priority/product changes logged by the form appear without reopening.
  useEffect(() => {
    if (!ticket?.id) return
    db.ticketActivity
      .list(ticket.id)
      .then((rows) => setActivityLog(rows))
      .catch(() => {})
  }, [ticket?.id, ticket?.updated_date])

  const logActivity = (actionType, details) => {
    db.ticketActivity
      .log(ticket.id, actionType, details, userEmail)
      .then((entry) => { if (entry) setActivityLog((prev) => [entry, ...prev]) })
  }

  const handleSaveResolution = async () => {
    if (!resForm.type) return
    setResolutionSaving(true)
    try {
      const payload = {
        type: resForm.type,
        replacement_product_name: resForm.replacement_product_name?.trim() || null,
        replacement_serial: resForm.replacement_serial?.trim() || null,
        amount: resForm.amount !== '' ? parseFloat(resForm.amount) : null,
        currency: resForm.currency || 'USD',
        reason: resForm.reason?.trim() || null,
        reference_number: resForm.reference_number?.trim() || null,
        created_by: userEmail,
      }
      const saved = await db.ticketResolutions.upsert(ticket.id, payload)
      setResolution(saved)
      setResolutionEditing(false)
      toast.success(t('ticketDrawer.resolutionSaved'))
      logActivity('resolution_saved', `Resolution: ${resForm.type}`)
      db.auditLog.log(userEmail, 'ticket_resolution_saved', `${ticket.rma_number}: ${resForm.type}`).catch(() => {})
    } catch (err) {
      toast.error(t('ticketDrawer.failedSaveResolution', { error: err.message }))
    } finally {
      setResolutionSaving(false)
    }
  }

  const handleDeleteResolution = async () => {
    if (!resolution) return
    try {
      await db.ticketResolutions.remove(resolution.id)
      setResolution(null)
      setResolutionEditing(false)
      toast.success(t('ticketDrawer.resolutionRemoved'))
      logActivity('resolution_deleted', `Resolution removed (was: ${resolution.type})`)
    } catch {
      toast.error(t('ticketDrawer.failedRemoveResolution'))
    }
  }

  const handleAddComment = async (parentCommentId = null) => {
    if (!newComment.trim() && commentFiles.length === 0) return
    if (!ticket) return
    setSubmittingComment(true)
    try {
      const attachments = []
      for (const file of commentFiles) {
        const result = await storage.uploadCommentAttachment(file, ticket.id)
        if (result) attachments.push(result)
      }
      const comment = await db.ticketComments.create({
        ticketId: ticket.id,
        commentText: newComment.trim(),
        authorEmail: userEmail,
        authorName: userEmail,
        isInternal: isInternalComment,
        parentCommentId,
        attachments,
      })
      if (comment) {
        setTicketComments((prev) => [...prev, comment])
        const targetEmails = []
        if (ticket?.assigned_technician && ticket.assigned_technician !== userEmail)
          targetEmails.push(ticket.assigned_technician)
        if (
          ticket?.created_by &&
          ticket.created_by !== userEmail &&
          !targetEmails.includes(ticket.created_by)
        )
          targetEmails.push(ticket.created_by)
        db.notifications
          .create({
            type: 'comment_added',
            title: 'New Comment',
            message: `${userEmail} commented on ticket ${ticket.rma_number}`,
            entityType: 'ticket',
            entityId: ticket.id,
            entityRef: ticket.rma_number,
            createdBy: userEmail,
            targetRoles: ['admin', 'super_admin'],
            targetEmails,
          })
          .catch(() => {})
        // Email customer for public comments only
        if (!isInternalComment && ticket.customer_email) {
          notifications.sendEmail(ticket.customer_email, 'comment_added', {
            recipient_name: ticket.customer_name,
            rma_number: ticket.rma_number,
            comment_author: userEmail,
            comment_text: newComment.trim(),
          }).catch((err) => console.error('[email] comment_added:', err.message))
        }
      }
      setNewComment('')
      db.auditLog
        .log(userEmail, 'ticket_comment_added', `Added comment on ticket ${ticket?.rma_number}`)
        .catch(() => {})
      setCommentFiles([])
      setReplyingTo(null)
    } catch (err) {
      captureException(err, { page: 'RMATickets', context: 'postComment' })
      toast.error(t('ticketDrawer.failedPostComment', { error: err?.message || err?.code || 'unknown error' }))
    } finally {
      setSubmittingComment(false)
    }
  }

  const handleDeleteComment = async (commentId) => {
    try {
      await db.ticketComments.delete(commentId)
      setTicketComments((prev) => prev.filter((c) => c.id !== commentId))
      logActivity('comment_deleted', 'Deleted a comment')
      db.auditLog
        .log(userEmail, 'ticket_comment_deleted', `Deleted comment ${commentId}`)
        .catch(() => {})
    } catch (err) {
      captureException(err, { page: 'RMATickets', context: 'deleteComment' })
      toast.error(t('ticketDrawer.failedDeleteComment'))
    }
  }

  if (!ticket) return null

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Ticket Details"
      className="max-w-4xl"
      noPadding
      hideHeader
      scrollable={false}
    >
      <div className="w-full">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200 dark:border-[#212a38]">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-[#e8ebf0]">{t('ticketDrawer.title')}</h2>
            <p className="text-sm font-mono text-indigo-600 mt-0.5">{ticket.rma_number}</p>
          </div>
          <div className="flex items-center gap-2">
            {ticket.customer_id && !TICKET_STATUS_RESOLVED.includes(ticket.ticket_status) && (
              <button
                onClick={() => setShowIssueCNModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-rose-600 text-white rounded-lg hover:bg-rose-700 text-sm font-medium"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5-1a1 1 0 11-2 0 1 1 0 012 0zm6 6a1 1 0 11-2 0 1 1 0 012 0zM3 9V5a2 2 0 012-2h4l10 10-6 6L3 9z" />
                </svg>
                {t('salesDocuments.issueCreditNoteAction')}
              </button>
            )}
            <button
              onClick={() => onExportPDF(ticket)}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              {t('ticketDrawer.exportPDF')}
            </button>
            <button
              onClick={onClose}
              aria-label="Close ticket details"
              className="w-8 h-8 flex items-center justify-center rounded-full text-gray-500 dark:text-[#9aa4b2] hover:bg-gray-100 dark:bg-[#1a2230]"
            >
              <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-6 max-h-[72vh] overflow-y-auto">
          {/* Info grid */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-3">
              {t('ticketDrawer.ticketInfo')}
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {[
                { label: t('ticketDrawer.customer'), value: ticket.customer_name },
                {
                  label: t('ticketDrawer.status'),
                  value: (
                    <span
                      className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(ticket.ticket_status)}`}
                    >
                      {ticket.ticket_status}
                    </span>
                  ),
                },
                {
                  label: t('ticketDrawer.priority'),
                  value: (
                    <span
                      className={`px-2 py-1 text-xs font-medium rounded-full ${getPriorityColor(ticket.priority)}`}
                    >
                      {ticket.priority}
                    </span>
                  ),
                },
                {
                  label: t('ticketDrawer.assignedTo'),
                  value: ticket.assigned_technician || t('ticketDrawer.unassigned'),
                },
                { label: t('ticketDrawer.dueDate'), value: formatDate(ticket.due_date) },
                { label: t('ticketDrawer.created'), value: fmtDateTime(ticket.created_date) },
                { label: t('ticketDrawer.createdBy'), value: ticket.created_by || '—' },
              ].map(({ label, value }) => (
                <div key={label}>
                  <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mb-1">{label}</p>
                  <div className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0]">{value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* General description */}
          {ticket.general_description && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-3">
                {t('ticketDrawer.generalDescription')}
              </h3>
              <div className="bg-gray-50 dark:bg-[#0f1520] rounded-xl p-4 text-sm text-gray-700 dark:text-[#e8ebf0] whitespace-pre-wrap">
                {ticket.general_description}
              </div>
            </div>
          )}

          {/* Products */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-3">
              {t('ticketDrawer.products')} ({(ticket.products || []).length})
            </h3>
            {(ticket.products || []).map((p, i) => (
              <div key={i} className="border border-gray-200 dark:border-[#212a38] rounded-xl p-4 mb-3">
                <h4 className="font-semibold text-gray-800 text-sm mb-3">
                  {t('ticketDrawer.product')} {i + 1} — {p.product_name}
                </h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t('ticketDrawer.serialNumber')}</p>
                    <div className="flex items-center gap-2">
                      <p className="font-mono font-medium">{p.serial_number || '—'}</p>
                      {p.serial_number && (
                        <button
                          onClick={async () => {
                            const h = await db.serialHistory.getBySerial(p.serial_number)
                            setSerialHistory(h)
                            setSerialHistorySerial(p.serial_number)
                          }}
                          className="text-xs text-indigo-500 hover:text-indigo-700 underline"
                        >
                          {t('ticketDrawer.history')}
                        </button>
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t('ticketDrawer.productStatus')}</p>
                    <p className="font-medium">{p.product_status}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t('ticketDrawer.warranty')}</p>
                    <p className="font-medium">{p.warranty_status}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t('ticketDrawer.issueDescription')}</p>
                    <p className="font-medium">{p.issue_description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Serial History Panel */}
          {serialHistory.length > 0 && (
            <div className="border border-indigo-200 rounded-xl p-4 bg-indigo-50/50">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-indigo-700 uppercase tracking-wider">
                  {t('ticketDrawer.serialHistory')} — {serialHistorySerial}
                </h3>
                <button
                  onClick={() => {
                    setSerialHistory([])
                    setSerialHistorySerial('')
                  }}
                  className="text-xs text-indigo-500 hover:text-indigo-700"
                >
                  ✕ Close
                </button>
              </div>
              <div className="space-y-2">
                {serialHistory.map((sh) => (
                  <div
                    key={sh.id}
                    className={`flex items-center justify-between p-2 bg-white dark:bg-[#121823] rounded-lg border text-xs ${sh.id === ticket.id ? 'border-indigo-300' : 'border-gray-200 dark:border-[#212a38]'}`}
                  >
                    <span className="font-mono font-medium text-indigo-700">{sh.rma_number}</span>
                    <span className="text-gray-600 dark:text-[#9aa4b2]">{sh.customer_name}</span>
                    <span
                      className={`px-2 py-0.5 rounded-full font-medium ${getStatusColor(sh.ticket_status)}`}
                    >
                      {sh.ticket_status}
                    </span>
                    <span className="text-gray-500 dark:text-[#9aa4b2]">
                      {sh.created_date ? new Date(sh.created_date).toLocaleDateString() : '—'}
                    </span>
                    {sh.id !== ticket.id && (
                      <button
                        onClick={() => onNavigateToTicket(sh)}
                        className="text-indigo-500 hover:text-indigo-700 underline"
                      >
                        {t('ticketDrawer.open')}
                      </button>
                    )}
                    {sh.id === ticket.id && (
                      <span className="text-indigo-500 italic">{t('ticketDrawer.current')}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Time Tracking ── */}
          {!timeEntriesMissing && (
            <div className="border-t border-gray-200 dark:border-[#212a38] pt-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                  {t('ticketDrawer.timeTracking')}
                </h3>
                <span className="text-xs text-indigo-600 font-medium">
                  {t('ticketDrawer.total')}:{' '}
                  {Math.floor(
                    timeEntries.reduce((sum, e) => sum + (e.duration_min || 0), 0) / 60
                  )}
                  h {timeEntries.reduce((sum, e) => sum + (e.duration_min || 0), 0) % 60}m
                </span>
              </div>
              <div className="space-y-3">
                {/* Timer controls */}
                <div className="flex items-center gap-3 flex-wrap">
                  {!timerRunning ? (
                    <button
                      onClick={() => {
                        setTimerRunning(true)
                        setTimerStart(Date.now())
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 transition-colors"
                    >
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                      {t('ticketDrawer.startTimer')}
                    </button>
                  ) : (
                    <button
                      onClick={async () => {
                        const mins = Math.max(1, Math.round((Date.now() - timerStart) / 60000))
                        setTimerRunning(false)
                        try {
                          const entry = await db.timeEntries.create({
                            ticket_id: ticket.id,
                            user_email: userEmail,
                            started_at: new Date(timerStart).toISOString(),
                            ended_at: new Date().toISOString(),
                            duration_min: mins,
                            notes: timerNotes || null,
                          })
                          setTimeEntries((prev) => [...prev, entry])
                          setTimerNotes('')
                          toast.success(t('ticketDrawer.timeLogged', { hours: Math.floor(mins / 60), minutes: mins % 60 }))
                          logActivity('time_entry_added', `Logged ${Math.floor(mins / 60)}h ${mins % 60}m${timerNotes ? ` — ${timerNotes}` : ''}`)
                        } catch (err) {
                          captureException(err, { page: 'RMATickets', context: 'saveTimeEntry' })
                          toast.error(t('ticketDrawer.failedSaveTime'))
                        }
                        setTimerStart(null)
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 transition-colors"
                    >
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                        <rect x="6" y="6" width="12" height="12" />
                      </svg>
                      {t('ticketDrawer.stopSave')}
                    </button>
                  )}
                  {timerRunning && (
                    <input
                      value={timerNotes}
                      onChange={(e) => setTimerNotes(e.target.value)}
                      placeholder={t('ticketDrawer.timerNotes')}
                      className="flex-1 min-w-0 px-2 py-1.5 border border-gray-200 dark:border-[#212a38] rounded-lg text-xs focus:ring-1 focus:ring-indigo-400 outline-none"
                    />
                  )}
                  {!timerRunning && (
                    <button
                      onClick={() => setAddingManual((v) => !v)}
                      className="text-xs text-indigo-500 hover:text-indigo-700 underline transition-colors"
                    >
                      {addingManual ? t('ticketDrawer.cancelEntry') : t('ticketDrawer.manualEntry')}
                    </button>
                  )}
                </div>
                {/* Manual entry form */}
                {addingManual && !timerRunning && (
                  <div className="bg-gray-50 dark:bg-[#0f1520] border border-gray-200 dark:border-[#212a38] rounded-xl p-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="number"
                        min="0"
                        max="99"
                        value={manualHours}
                        onChange={(e) => setManualHours(e.target.value)}
                        placeholder="0"
                        className="w-16 px-2 py-1.5 border border-gray-200 dark:border-[#212a38] rounded-lg text-xs text-center focus:ring-1 focus:ring-indigo-400 outline-none"
                      />
                      <span className="text-xs text-gray-500 dark:text-[#9aa4b2] font-medium">h</span>
                      <input
                        type="number"
                        min="0"
                        max="59"
                        value={manualMins}
                        onChange={(e) => setManualMins(e.target.value)}
                        placeholder="0"
                        className="w-16 px-2 py-1.5 border border-gray-200 dark:border-[#212a38] rounded-lg text-xs text-center focus:ring-1 focus:ring-indigo-400 outline-none"
                      />
                      <span className="text-xs text-gray-500 dark:text-[#9aa4b2] font-medium">m</span>
                      <input
                        value={manualNotes}
                        onChange={(e) => setManualNotes(e.target.value)}
                        placeholder={t('ticketDrawer.notesOptional')}
                        className="flex-1 min-w-0 px-2 py-1.5 border border-gray-200 dark:border-[#212a38] rounded-lg text-xs focus:ring-1 focus:ring-indigo-400 outline-none"
                      />
                      <button
                        onClick={async () => {
                          const mins =
                            parseInt(manualHours || 0) * 60 + parseInt(manualMins || 0)
                          if (!mins) {
                            toast.error(t('ticketDrawer.enterHoursOrMinutes'))
                            return
                          }
                          try {
                            const now = new Date().toISOString()
                            const entry = await db.timeEntries.create({
                              ticket_id: ticket.id,
                              user_email: userEmail,
                              started_at: now,
                              ended_at: now,
                              duration_min: mins,
                              notes: manualNotes || null,
                            })
                            setTimeEntries((prev) => [...prev, entry])
                            setManualHours('')
                            setManualMins('')
                            setManualNotes('')
                            setAddingManual(false)
                            toast.success(t('ticketDrawer.timeLogged', { hours: Math.floor(mins / 60), minutes: mins % 60 }))
                            logActivity('time_entry_added', `Logged ${Math.floor(mins / 60)}h ${mins % 60}m${manualNotes ? ` — ${manualNotes}` : ''}`)
                          } catch (err) {
                            captureException(err, {
                              page: 'RMATickets',
                              context: 'logTimeManual',
                            })
                            toast.error(t('ticketDrawer.failedLogTime'))
                          }
                        }}
                        className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 transition-colors"
                      >
                        {t('ticketDrawer.logBtn')}
                      </button>
                    </div>
                  </div>
                )}
                {/* Time log list */}
                {timeEntries.length > 0 ? (
                  <div className="space-y-1.5 max-h-44 overflow-y-auto">
                    {[...timeEntries].reverse().map((entry) => (
                      <div
                        key={entry.id}
                        className="flex items-center gap-2 p-2 bg-gray-50 dark:bg-[#0f1520] rounded-lg text-xs group"
                      >
                        <span className="text-gray-500 dark:text-[#9aa4b2] shrink-0">{entry.user_email}</span>
                        <span className="font-semibold text-gray-800 shrink-0">
                          {Math.floor((entry.duration_min || 0) / 60)}h{' '}
                          {(entry.duration_min || 0) % 60}m
                        </span>
                        {entry.notes && (
                          <span className="text-gray-500 dark:text-[#9aa4b2] flex-1 truncate">{entry.notes}</span>
                        )}
                        {!entry.notes && <span className="flex-1" />}
                        <span className="text-gray-500 dark:text-[#9aa4b2] shrink-0">
                          {entry.created_date
                            ? new Date(entry.created_date).toLocaleDateString()
                            : '—'}
                        </span>
                        {(userRole === ROLES.ADMIN ||
                          userRole === ROLES.SUPER_ADMIN ||
                          entry.user_email === userEmail) && (
                          <button
                            onClick={async () => {
                              try {
                                await db.timeEntries.delete(entry.id)
                                setTimeEntries((prev) => prev.filter((e) => e.id !== entry.id))
                                toast.success(t('ticketDrawer.timeEntryDeleted'))
                                logActivity('time_entry_deleted', `Deleted time entry: ${Math.floor((entry.duration_min || 0) / 60)}h ${(entry.duration_min || 0) % 60}m`)
                              } catch (err) {
                                captureException(err, {
                                  page: 'RMATickets',
                                  context: 'deleteTimeEntry',
                                })
                                toast.error(t('ticketDrawer.failedDeleteEntry'))
                              }
                            }}
                            className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all shrink-0"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500 dark:text-[#9aa4b2] italic">{t('ticketDrawer.noTimeEntries')}</p>
                )}
              </div>
            </div>
          )}

          {/* ── Parts Used ── */}
          {!ticketPartsMissing && (
            <div className="border-t border-gray-200 dark:border-[#212a38] pt-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                  {t('ticketDrawer.partsUsed')} ({ticketParts.length})
                </h3>
                {ticketParts.length > 0 && (
                  <span className="text-xs text-indigo-600 font-medium">
                    Cost: $
                    {ticketParts
                      .reduce((sum, p) => sum + p.quantity * p.unit_cost, 0)
                      .toFixed(2)}
                  </span>
                )}
              </div>
              {ticketParts.length > 0 ? (
                <div className="space-y-2">
                  {ticketParts.map((tp) => (
                    <div
                      key={tp.id}
                      className="flex items-center gap-3 p-2 bg-gray-50 dark:bg-[#0f1520] rounded-lg text-xs"
                    >
                      <span className="font-medium text-gray-800 flex-1">
                        {tp.parts?.part_name || '—'}
                      </span>
                      {tp.parts?.part_number && (
                        <span className="text-gray-500 dark:text-[#9aa4b2] font-mono">{tp.parts.part_number}</span>
                      )}
                      <span className="text-gray-500 dark:text-[#9aa4b2]">×{tp.quantity}</span>
                      <span className="font-semibold text-gray-700 dark:text-[#e8ebf0]">
                        ${(tp.quantity * tp.unit_cost).toFixed(2)}
                      </span>
                      {tp.notes && (
                        <span className="text-gray-500 dark:text-[#9aa4b2] truncate max-w-[8rem]">{tp.notes}</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-500 dark:text-[#9aa4b2] italic">{t('ticketDrawer.noParts')}</p>
              )}
            </div>
          )}

          {/* ── Resolution ── */}
          <div className="border-t border-gray-200 dark:border-[#212a38] pt-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">{t('ticketDrawer.resolution')}</h3>
              {canDo('edit_all') && !resolutionEditing && (
                <button
                  onClick={() => {
                    setResForm(resolution ? {
                      type: resolution.type,
                      replacement_product_name: resolution.replacement_product_name || '',
                      replacement_serial: resolution.replacement_serial || '',
                      amount: resolution.amount != null ? String(resolution.amount) : '',
                      currency: resolution.currency || 'USD',
                      reason: resolution.reason || '',
                      reference_number: resolution.reference_number || '',
                    } : EMPTY_RES)
                    setResolutionEditing(true)
                  }}
                  className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline"
                >
                  {resolution ? t('ticketDrawer.editResolution') : t('ticketDrawer.addResolution')}
                </button>
              )}
            </div>

            {resolutionLoading && <p className="text-xs text-gray-400 dark:text-[#4a5568] italic">Loading…</p>}

            {/* View mode */}
            {!resolutionLoading && resolution && !resolutionEditing && (
              <div className="bg-gray-50 dark:bg-[#0f1520] rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                    resolution.type === 'replacement' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' :
                    resolution.type === 'exchange'    ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' :
                    resolution.type === 'credit_note' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' :
                                                        'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                  }`}>
                    {resolution.type.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
                  </span>
                  {canDo('edit_all') && (
                    <button onClick={handleDeleteResolution} className="ml-auto text-xs text-red-500 hover:underline">{t('ticketDrawer.deleteResolution')}</button>
                  )}
                </div>
                {(resolution.replacement_product_name || resolution.replacement_serial) && (
                  <div className="text-xs text-gray-700 dark:text-[#e8ebf0] space-y-0.5">
                    {resolution.replacement_product_name && <p><span className="text-gray-500 dark:text-[#9aa4b2]">Product: </span>{resolution.replacement_product_name}</p>}
                    {resolution.replacement_serial && <p><span className="text-gray-500 dark:text-[#9aa4b2]">Serial: </span><span className="font-mono">{resolution.replacement_serial}</span></p>}
                  </div>
                )}
                {resolution.amount != null && (
                  <p className="text-xs text-gray-700 dark:text-[#e8ebf0]">
                    <span className="text-gray-500 dark:text-[#9aa4b2]">Amount: </span>
                    <span className="font-semibold">{resolution.currency} {Number(resolution.amount).toFixed(2)}</span>
                  </p>
                )}
                {resolution.reason && <p className="text-xs text-gray-600 dark:text-[#9aa4b2] italic">"{resolution.reason}"</p>}
                {resolution.reference_number && (
                  <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">Ref: <span className="font-mono">{resolution.reference_number}</span></p>
                )}
                <p className="text-[10px] text-gray-400 dark:text-[#4a5568]">By {resolution.created_by} · {new Date(resolution.created_at).toLocaleDateString()}</p>
              </div>
            )}

            {/* Empty state */}
            {!resolutionLoading && !resolution && !resolutionEditing && (
              <p className="text-xs text-gray-400 dark:text-[#4a5568] italic">{t('ticketDrawer.noResolution')}</p>
            )}

            {/* Edit / Add form */}
            {resolutionEditing && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('ticketDrawer.resolutionType')}</label>
                  <select
                    value={resForm.type}
                    onChange={(e) => setResForm(f => ({ ...f, type: e.target.value }))}
                    className="w-full px-3 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0]"
                  >
                    <option value="replacement">Replacement</option>
                    <option value="exchange">Exchange</option>
                    <option value="credit_note">Credit Note</option>
                    <option value="refund">Refund</option>
                  </select>
                </div>

                {(resForm.type === 'replacement' || resForm.type === 'exchange') && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('ticketDrawer.replacementProduct')}</label>
                      <ProductSearchInput
                        value={resForm.replacement_product_name}
                        onChange={(v) => setResForm(f => ({ ...f, replacement_product_name: v }))}
                        products={products}
                        placeholder="Search or type product name…"
                        inputClassName="w-full px-3 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] placeholder-gray-400 dark:placeholder-[#4a5568] outline-none focus:border-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('ticketDrawer.serialNumber')}</label>
                      <input
                        value={resForm.replacement_serial}
                        onChange={(e) => setResForm(f => ({ ...f, replacement_serial: e.target.value }))}
                        placeholder="Replacement unit serial"
                        className="w-full px-3 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0] placeholder-gray-400 dark:placeholder-[#4a5568] font-mono"
                      />
                    </div>
                  </>
                )}

                {(resForm.type === 'credit_note' || resForm.type === 'refund') && (
                  <>
                    <div className="flex gap-2">
                      <div className="w-24">
                        <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('ticketDrawer.currency')}</label>
                        <select
                          value={resForm.currency}
                          onChange={(e) => setResForm(f => ({ ...f, currency: e.target.value }))}
                          className="w-full px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0]"
                        >
                          {['USD','EUR','GBP','AED','SAR','EGP'].map(c => <option key={c}>{c}</option>)}
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('ticketDrawer.amount')}</label>
                        <input
                          type="number" min="0" step="0.01"
                          value={resForm.amount}
                          onChange={(e) => setResForm(f => ({ ...f, amount: e.target.value }))}
                          placeholder="0.00"
                          className="w-full px-3 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0]"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('ticketDrawer.referenceNumber')}</label>
                      <input
                        value={resForm.reference_number}
                        onChange={(e) => setResForm(f => ({ ...f, reference_number: e.target.value }))}
                        placeholder="Invoice / credit note number"
                        className="w-full px-3 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0] placeholder-gray-400 dark:placeholder-[#4a5568]"
                      />
                    </div>
                  </>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-[#9aa4b2] mb-1">{t('ticketDrawer.reason')}</label>
                  <textarea
                    rows={2}
                    value={resForm.reason}
                    onChange={(e) => setResForm(f => ({ ...f, reason: e.target.value }))}
                    placeholder="Optional notes"
                    className="w-full px-3 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0] placeholder-gray-400 dark:placeholder-[#4a5568] resize-none"
                  />
                </div>

                <div className="flex gap-2">
                  <Button onClick={handleSaveResolution} loading={resolutionSaving} className="flex-1 justify-center text-sm py-1.5">
                    {t('ticketDrawer.saveResolution')}
                  </Button>
                  <Button variant="secondary" onClick={() => setResolutionEditing(false)} className="text-sm py-1.5">
                    {t('ticketDrawer.cancelResolution')}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Accessories */}
          {ticket.accessories_received && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-3">
                {t('ticketDrawer.accessories')}
              </h3>
              <div className="bg-gray-50 dark:bg-[#0f1520] rounded-xl p-4 text-sm text-gray-700 dark:text-[#e8ebf0] whitespace-pre-wrap">
                {ticket.accessories_received}
              </div>
            </div>
          )}

          {/* Attachments */}
          {ticket.attachments?.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-3">
                {t('ticketDrawer.attachments')} ({ticket.attachments.length})
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {ticket.attachments.map((att, i) => (
                  <a
                    key={i}
                    href={att.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex flex-col items-center p-3 border border-gray-200 dark:border-[#212a38] rounded-xl hover:bg-indigo-50 dark:hover:bg-[#1a2230] hover:border-indigo-300 transition-colors group"
                  >
                    {isImage(att.type) ? (
                      <img
                        src={att.url}
                        alt={att.name}
                        className="w-full h-24 object-cover rounded-lg mb-2"
                      />
                    ) : (
                      <div className="w-full h-24 bg-gray-100 dark:bg-[#1a2230] rounded-lg flex items-center justify-center mb-2">
                        <svg
                          className="w-10 h-10 text-gray-500 dark:text-[#9aa4b2]"
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
                    <p className="text-xs font-medium text-gray-700 dark:text-[#e8ebf0] group-hover:text-indigo-600 truncate w-full text-center">
                      {att.name}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">{fmtBytes(att.size)}</p>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* ── Activity Timeline ── */}
          <ActivityTimeline
            ticketComments={ticketComments}
            timeEntries={timeEntries}
            activityLog={activityLog}
          />

          {/* ── Comments & Communication ── */}
          <div className="border-t border-gray-200 dark:border-[#212a38] pt-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                {t('ticketDrawer.comments')}
              </h3>
              <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">
                {ticketComments.length} comment{ticketComments.length !== 1 ? 's' : ''}
              </span>
            </div>

            {commentsLoading ? (
              <div className="flex justify-center py-6">
                <Spinner size="md" />
              </div>
            ) : ticketComments.filter((c) => !c.parent_comment_id).length === 0 ? (
              <div className="text-center py-6 text-gray-500 dark:text-[#9aa4b2] text-sm">
                {t('ticketDrawer.noComments')}
              </div>
            ) : (
              <div className="space-y-3 mb-4">
                {ticketComments
                  .filter((c) => !c.parent_comment_id)
                  .map((comment) => {
                    const replies = ticketComments.filter(
                      (r) => r.parent_comment_id === comment.id
                    )
                    const displayName = comment.author_name || comment.user_email || '?'
                    const initials = displayName[0].toUpperCase()
                    const ts = new Date(comment.created_date)
                    const dateStr = ts.toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })
                    const timeStr = ts.toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                    return (
                      <div key={comment.id}>
                        <div
                          className={`flex gap-3 p-4 rounded-xl border ${comment.is_internal ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 dark:bg-[#0f1520] border-gray-200 dark:border-[#212a38]'}`}
                        >
                          <div
                            className={`w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 ${comment.is_internal ? 'bg-amber-500' : comment.is_customer_comment ? 'bg-green-500' : 'bg-indigo-500'}`}
                          >
                            {initials}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                              <span className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">
                                {displayName}
                              </span>
                              {comment.is_internal && (
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200">
                                  {t('ticketDrawer.internalBadge')}
                                </span>
                              )}
                              {comment.is_customer_comment && (
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-200">
                                  {t('ticketDrawer.customerBadge')}
                                </span>
                              )}
                              <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">
                                {dateStr} · {timeStr}
                              </span>
                            </div>
                            <p className="text-sm text-gray-700 dark:text-[#e8ebf0] whitespace-pre-wrap">
                              {comment.comment_text}
                            </p>
                            {comment.attachments?.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {comment.attachments.map((att, i) => (
                                  <a
                                    key={i}
                                    href={att.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 px-2 py-1 bg-white dark:bg-[#121823] border border-gray-200 dark:border-[#212a38] rounded-lg text-xs text-indigo-600 hover:text-indigo-800 hover:border-indigo-300 transition-colors"
                                  >
                                    <svg
                                      className="w-3 h-3"
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
                                    {att.name}
                                  </a>
                                ))}
                              </div>
                            )}
                            <button
                              onClick={() => {
                                setReplyingTo(replyingTo === comment.id ? null : comment.id)
                                setNewComment('')
                                setCommentFiles([])
                              }}
                              className="mt-2 text-xs text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 transition-colors flex items-center gap-1"
                            >
                              <svg
                                className="w-3 h-3"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
                                />
                              </svg>
                              {t('ticketDrawer.replyBtn')}{replies.length > 0 ? ` (${replies.length})` : ''}
                            </button>
                          </div>
                          {(userRole === ROLES.ADMIN || userRole === ROLES.SUPER_ADMIN) && (
                            <button
                              onClick={() => handleDeleteComment(comment.id)}
                              className="text-gray-300 hover:text-red-500 flex-shrink-0 self-start p-1 transition-colors"
                              title="Delete comment"
                              aria-label="Delete comment"
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
                          )}
                        </div>

                        {replies.length > 0 && (
                          <div className="ml-8 mt-2 space-y-2">
                            {replies.map((reply) => {
                              const rName = reply.author_name || reply.user_email || '?'
                              const rTs = new Date(reply.created_date)
                              return (
                                <div
                                  key={reply.id}
                                  className={`flex gap-3 p-3 rounded-xl border ${reply.is_internal ? 'bg-amber-50 border-amber-200' : 'bg-white dark:bg-[#121823] border-gray-200 dark:border-[#212a38]'}`}
                                >
                                  <div
                                    className={`w-7 h-7 rounded-full flex items-center justify-center text-white font-semibold text-xs flex-shrink-0 ${reply.is_internal ? 'bg-amber-400' : reply.is_customer_comment ? 'bg-green-400' : 'bg-indigo-400'}`}
                                  >
                                    {rName[0].toUpperCase()}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap mb-1">
                                      <span className="text-xs font-semibold text-gray-900 dark:text-[#e8ebf0]">
                                        {rName}
                                      </span>
                                      {reply.is_internal && (
                                        <span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200">
                                          {t('ticketDrawer.internalBadge')}
                                        </span>
                                      )}
                                      {reply.is_customer_comment && (
                                        <span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-200">
                                          Customer
                                        </span>
                                      )}
                                      <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">
                                        {rTs.toLocaleDateString('en-US', {
                                          month: 'short',
                                          day: 'numeric',
                                        })}{' '}
                                        ·{' '}
                                        {rTs.toLocaleTimeString('en-US', {
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </span>
                                    </div>
                                    <p className="text-sm text-gray-700 dark:text-[#e8ebf0] whitespace-pre-wrap">
                                      {reply.comment_text}
                                    </p>
                                    {reply.attachments?.length > 0 && (
                                      <div className="mt-2 flex flex-wrap gap-2">
                                        {reply.attachments.map((att, i) => (
                                          <a
                                            key={i}
                                            href={att.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 px-2 py-1 bg-white dark:bg-[#121823] border border-gray-200 dark:border-[#212a38] rounded-lg text-xs text-indigo-600 hover:text-indigo-800 hover:border-indigo-300 transition-colors"
                                          >
                                            <svg
                                              className="w-3 h-3"
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
                                            {att.name}
                                          </a>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                  {(userRole === ROLES.ADMIN ||
                                    userRole === ROLES.SUPER_ADMIN) && (
                                    <button
                                      onClick={() => handleDeleteComment(reply.id)}
                                      className="text-gray-300 hover:text-red-500 flex-shrink-0 self-start p-1 transition-colors"
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
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}

                        {replyingTo === comment.id && (
                          <div className="ml-8 mt-2 bg-white dark:bg-[#121823] border border-indigo-200 rounded-xl p-3 space-y-2">
                            <div className="flex items-center gap-1.5 mb-1">
                              <svg
                                className="w-3 h-3 text-indigo-500"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
                                />
                              </svg>
                              <span className="text-xs text-indigo-600 font-medium">
                                {t('ticketDrawer.replyingTo')} {displayName}
                              </span>
                            </div>
                            <textarea
                              value={newComment}
                              onChange={(e) => setNewComment(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
                                  handleAddComment(comment.id)
                              }}
                              rows={2}
                              placeholder="Write a reply... (Ctrl+Enter to submit)"
                              className="w-full text-sm text-gray-700 dark:text-[#e8ebf0] resize-none outline-none placeholder-gray-400"
                              autoFocus
                            />
                            {commentFiles.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {commentFiles.map((f, i) => (
                                  <span
                                    key={i}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 dark:bg-[#1a2230] rounded text-xs text-gray-600 dark:text-[#9aa4b2]"
                                  >
                                    {f.name}
                                    <button
                                      onClick={() =>
                                        setCommentFiles((prev) =>
                                          prev.filter((_, j) => j !== i)
                                        )
                                      }
                                      className="text-gray-500 dark:text-[#9aa4b2] hover:text-red-500"
                                    >
                                      ×
                                    </button>
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-3">
                                <button
                                  onClick={() => commentFileInputRef.current?.click()}
                                  className="text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 transition-colors"
                                  title="Attach file"
                                  aria-label="Attach file"
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
                                      d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                                    />
                                  </svg>
                                </button>
                                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                                  <div
                                    onClick={() => setIsInternalComment((v) => !v)}
                                    className={`relative w-8 h-4 rounded-full transition-colors ${isInternalComment ? 'bg-amber-500' : 'bg-gray-200'}`}
                                  >
                                    <div
                                      className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white dark:bg-[#121823] rounded-full shadow transition-transform ${isInternalComment ? 'translate-x-4' : ''}`}
                                    />
                                  </div>
                                  <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">Internal</span>
                                </label>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => {
                                    setReplyingTo(null)
                                    setNewComment('')
                                    setCommentFiles([])
                                  }}
                                  className="text-xs text-gray-500 dark:text-[#9aa4b2] hover:text-gray-600 dark:text-[#9aa4b2]"
                                >
                                  {t('ticketDrawer.cancelReply')}
                                </button>
                                <button
                                  onClick={() => handleAddComment(comment.id)}
                                  disabled={!newComment.trim() || submittingComment}
                                  className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                                >
                                  {submittingComment ? (
                                    <Spinner size="sm" color="white" />
                                  ) : (
                                    t('ticketDrawer.replyBtn')
                                  )}
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
              <div className="bg-white dark:bg-[#121823] border border-gray-200 dark:border-[#212a38] rounded-xl p-3 space-y-3">
                <textarea
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAddComment()
                  }}
                  rows={3}
                  placeholder="Write a comment... (Ctrl+Enter to submit)"
                  className="w-full text-sm text-gray-700 dark:text-[#e8ebf0] resize-none outline-none placeholder-gray-400"
                />
                {commentFiles.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {commentFiles.map((f, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 dark:bg-[#1a2230] rounded text-xs text-gray-600 dark:text-[#9aa4b2]"
                      >
                        {f.name}
                        <button
                          onClick={() =>
                            setCommentFiles((prev) => prev.filter((_, j) => j !== i))
                          }
                          className="text-gray-500 dark:text-[#9aa4b2] hover:text-red-500"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => commentFileInputRef.current?.click()}
                      className="text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 transition-colors"
                      title="Attach file"
                      aria-label="Attach file"
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
                          d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                        />
                      </svg>
                    </button>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <div
                        onClick={() => setIsInternalComment((v) => !v)}
                        className={`relative w-9 h-5 rounded-full transition-colors ${isInternalComment ? 'bg-amber-500' : 'bg-gray-200'}`}
                      >
                        <div
                          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white dark:bg-[#121823] rounded-full shadow transition-transform ${isInternalComment ? 'translate-x-4' : ''}`}
                        />
                      </div>
                      <span className="text-xs text-gray-600 dark:text-[#9aa4b2]">{t('ticketDrawer.internalOnly')}</span>
                    </label>
                  </div>
                  <button
                    onClick={() => handleAddComment()}
                    disabled={
                      (!newComment.trim() && commentFiles.length === 0) || submittingComment
                    }
                    className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {submittingComment ? (
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
                          d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                        />
                      </svg>
                    )}
                    {t('ticketDrawer.postComment')}
                  </button>
                </div>
              </div>
            )}
            <input
              type="file"
              multiple
              ref={commentFileInputRef}
              className="hidden"
              onChange={(e) => {
                setCommentFiles((prev) => [...prev, ...Array.from(e.target.files)])
                e.target.value = ''
              }}
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-[#212a38]">
          {(canDo('edit_all') || canDo('edit_assigned')) && (
            <Button
              onClick={() => {
                onClose()
                onEdit(ticket)
              }}
            >
              {t('ticketDrawer.editTicket')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>

      {showIssueCNModal && (
        <CreateStandaloneCreditNoteModal
          customers={cnCustomers}
          products={products}
          currentUserEmail={userEmail}
          initialCustomerId={ticket.customer_id}
          initialType="rma_return"
          initialTicketId={ticket.id}
          lockCustomer
          onClose={() => { if (!issuingCN) setShowIssueCNModal(false) }}
          onCreated={handleIssueCNFromTicket}
        />
      )}
    </Modal>
  )
}
