import React, { useState, useEffect, useRef } from 'react'
import { db, storage, notifications } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import Modal from '../../components/Modal'
import { Button, Spinner } from '../../components/ui'
import { ROLES } from '../../lib/constants'
import { captureException } from '../../lib/sentry'
import {
  getStatusColor,
  getPriorityColor,
  fmt,
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
  }, [ticket?.id]) // eslint-disable-line react-hooks/exhaustive-deps

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
      const comment = await db.ticketComments.create(
        ticket.id,
        newComment.trim(),
        userEmail,
        userEmail,
        isInternalComment,
        parentCommentId,
        attachments
      )
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
      toast.error('Failed to post comment: ' + (err?.message || err?.code || 'unknown error'))
    } finally {
      setSubmittingComment(false)
    }
  }

  const handleDeleteComment = async (commentId) => {
    try {
      await db.ticketComments.delete(commentId)
      setTicketComments((prev) => prev.filter((c) => c.id !== commentId))
      db.auditLog
        .log(userEmail, 'ticket_comment_deleted', `Deleted comment ${commentId}`)
        .catch(() => {})
    } catch (err) {
      captureException(err, { page: 'RMATickets', context: 'deleteComment' })
      toast.error('Failed to delete comment')
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
            <h2 className="text-xl font-bold text-gray-900 dark:text-[#e8ebf0]">Ticket Details</h2>
            <p className="text-sm font-mono text-indigo-600 mt-0.5">{ticket.rma_number}</p>
          </div>
          <div className="flex items-center gap-2">
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
              Export PDF
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
              Ticket Information
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {[
                { label: 'Customer', value: ticket.customer_name },
                {
                  label: 'Status',
                  value: (
                    <span
                      className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(ticket.ticket_status)}`}
                    >
                      {ticket.ticket_status}
                    </span>
                  ),
                },
                {
                  label: 'Priority',
                  value: (
                    <span
                      className={`px-2 py-1 text-xs font-medium rounded-full ${getPriorityColor(ticket.priority)}`}
                    >
                      {ticket.priority}
                    </span>
                  ),
                },
                {
                  label: 'Assigned To',
                  value: ticket.assigned_technician || 'Unassigned',
                },
                { label: 'Due Date', value: fmt(ticket.due_date) },
                { label: 'Created', value: fmtDateTime(ticket.created_date) },
                { label: 'Created By', value: ticket.created_by || '—' },
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
                General RMA Description
              </h3>
              <div className="bg-gray-50 dark:bg-[#0f1520] rounded-xl p-4 text-sm text-gray-700 dark:text-[#e8ebf0] whitespace-pre-wrap">
                {ticket.general_description}
              </div>
            </div>
          )}

          {/* Products */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-3">
              Products ({(ticket.products || []).length})
            </h3>
            {(ticket.products || []).map((p, i) => (
              <div key={i} className="border border-gray-200 dark:border-[#212a38] rounded-xl p-4 mb-3">
                <h4 className="font-semibold text-gray-800 text-sm mb-3">
                  Product {i + 1} — {p.product_name}
                </h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">Serial Number</p>
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
                          History
                        </button>
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">Product Status</p>
                    <p className="font-medium">{p.product_status}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">Warranty</p>
                    <p className="font-medium">{p.warranty_status}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">Issue Description</p>
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
                  Serial History — {serialHistorySerial}
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
                {serialHistory.map((t) => (
                  <div
                    key={t.id}
                    className={`flex items-center justify-between p-2 bg-white dark:bg-[#121823] rounded-lg border text-xs ${t.id === ticket.id ? 'border-indigo-300' : 'border-gray-200 dark:border-[#212a38]'}`}
                  >
                    <span className="font-mono font-medium text-indigo-700">{t.rma_number}</span>
                    <span className="text-gray-600 dark:text-[#9aa4b2]">{t.customer_name}</span>
                    <span
                      className={`px-2 py-0.5 rounded-full font-medium ${getStatusColor(t.ticket_status)}`}
                    >
                      {t.ticket_status}
                    </span>
                    <span className="text-gray-500 dark:text-[#9aa4b2]">
                      {t.created_date ? new Date(t.created_date).toLocaleDateString() : '—'}
                    </span>
                    {t.id !== ticket.id && (
                      <button
                        onClick={() => onNavigateToTicket(t)}
                        className="text-indigo-500 hover:text-indigo-700 underline"
                      >
                        Open
                      </button>
                    )}
                    {t.id === ticket.id && (
                      <span className="text-indigo-500 italic">Current</span>
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
                  Time Tracking
                </h3>
                <span className="text-xs text-indigo-600 font-medium">
                  Total:{' '}
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
                      Start Timer
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
                          toast.success(`Logged ${Math.floor(mins / 60)}h ${mins % 60}m`)
                        } catch (err) {
                          captureException(err, { page: 'RMATickets', context: 'saveTimeEntry' })
                          toast.error('Failed to save time entry')
                        }
                        setTimerStart(null)
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 transition-colors"
                    >
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                        <rect x="6" y="6" width="12" height="12" />
                      </svg>
                      Stop &amp; Save
                    </button>
                  )}
                  {timerRunning && (
                    <input
                      value={timerNotes}
                      onChange={(e) => setTimerNotes(e.target.value)}
                      placeholder="Timer notes (optional)"
                      className="flex-1 min-w-0 px-2 py-1.5 border border-gray-200 dark:border-[#212a38] rounded-lg text-xs focus:ring-1 focus:ring-indigo-400 outline-none"
                    />
                  )}
                  {!timerRunning && (
                    <button
                      onClick={() => setAddingManual((v) => !v)}
                      className="text-xs text-indigo-500 hover:text-indigo-700 underline transition-colors"
                    >
                      {addingManual ? 'Cancel' : '+ Manual entry'}
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
                        placeholder="Notes (optional)"
                        className="flex-1 min-w-0 px-2 py-1.5 border border-gray-200 dark:border-[#212a38] rounded-lg text-xs focus:ring-1 focus:ring-indigo-400 outline-none"
                      />
                      <button
                        onClick={async () => {
                          const mins =
                            parseInt(manualHours || 0) * 60 + parseInt(manualMins || 0)
                          if (!mins) {
                            toast.error('Enter hours or minutes')
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
                            toast.success(`Logged ${Math.floor(mins / 60)}h ${mins % 60}m`)
                          } catch (err) {
                            captureException(err, {
                              page: 'RMATickets',
                              context: 'logTimeManual',
                            })
                            toast.error('Failed to log time')
                          }
                        }}
                        className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 transition-colors"
                      >
                        Log
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
                                toast.success('Entry deleted')
                              } catch (err) {
                                captureException(err, {
                                  page: 'RMATickets',
                                  context: 'deleteTimeEntry',
                                })
                                toast.error('Failed to delete')
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
                  <p className="text-xs text-gray-500 dark:text-[#9aa4b2] italic">No time entries yet.</p>
                )}
              </div>
            </div>
          )}

          {/* ── Parts Used ── */}
          {!ticketPartsMissing && (
            <div className="border-t border-gray-200 dark:border-[#212a38] pt-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                  Parts Used ({ticketParts.length})
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
                <p className="text-xs text-gray-500 dark:text-[#9aa4b2] italic">No parts recorded on this ticket.</p>
              )}
            </div>
          )}

          {/* Accessories */}
          {ticket.accessories_received && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-3">
                Accessories Received
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
                Attachments ({ticket.attachments.length})
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

          {/* ── Comments & Communication ── */}
          <div className="border-t border-gray-200 dark:border-[#212a38] pt-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                Comments & Communication
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
                No comments yet. Start the conversation below.
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
                                  Internal
                                </span>
                              )}
                              {comment.is_customer_comment && (
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-200">
                                  Customer
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
                              Reply{replies.length > 0 ? ` (${replies.length})` : ''}
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
                                          Internal
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
                                Replying to {displayName}
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
                                  Cancel
                                </button>
                                <button
                                  onClick={() => handleAddComment(comment.id)}
                                  disabled={!newComment.trim() || submittingComment}
                                  className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                                >
                                  {submittingComment ? (
                                    <Spinner size="sm" color="white" />
                                  ) : (
                                    'Reply'
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
                      <span className="text-xs text-gray-600 dark:text-[#9aa4b2]">Internal only</span>
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
                    Post
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
              Edit Ticket
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  )
}
