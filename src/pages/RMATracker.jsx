import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { db, storage, branding as brandingAPI } from '../api/supabaseClient'
import { safeStorage } from '../lib/safeStorage'

// ── Client-side brute-force protection ──────────────────────────────────────
// Tracks "not found" attempts in localStorage. After MAX_FAILS failures within
// WINDOW_MS the tracker is locked for LOCKOUT_MS. This is a UX-layer defence;
// real rate-limiting requires a server-side edge function.
const RL_KEY = 'tracker_rl'
const MAX_FAILS = 10
const WINDOW_MS = 5 * 60 * 1000 // 5-minute sliding window
const LOCKOUT_MS = 15 * 60 * 1000 // 15-minute lockout

function getRLState() {
  return safeStorage.get(RL_KEY, {})
}
function saveRLState(s) {
  safeStorage.set(RL_KEY, s)
}
/** Returns { locked: true, secsLeft } or { locked: false } */
function checkRateLimit() {
  const s = getRLState()
  if (s.lockedUntil && Date.now() < s.lockedUntil) {
    return { locked: true, secsLeft: Math.ceil((s.lockedUntil - Date.now()) / 1000) }
  }
  return { locked: false }
}
/** Call when a "not found" response is received. Returns updated RL state. */
function recordFailure() {
  const now = Date.now()
  let s = getRLState()
  // Reset window if it has expired
  if (!s.windowStart || now - s.windowStart > WINDOW_MS) {
    s = { windowStart: now, count: 0 }
  }
  s.count = (s.count || 0) + 1
  if (s.count >= MAX_FAILS) s.lockedUntil = now + LOCKOUT_MS
  saveRLState(s)
  return s
}
/** Clears the lockout (call on successful lookup). */
function clearFailures() {
  safeStorage.remove(RL_KEY)
}

const PRODUCT_STATUS_COLORS = {
  Received:      'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  'Under Repair':'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400',
  Repaired:      'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  "Can't Repair":'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
  Replacement:   'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300',
  'Credit Note': 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300',
}

// All 7 ticket statuses shown in the progress bar in order.
const PROGRESS_STEPS = ['Open', 'In Progress', 'Pending', 'On Hold', 'Completed', 'Closed', 'Cancelled']

const STATUS_COLORS = {
  Open: 'bg-blue-500',
  'In Progress': 'bg-indigo-500',
  Pending: 'bg-orange-500',
  'On Hold': 'bg-yellow-500',
  Completed: 'bg-teal-500',
  Closed: 'bg-green-500',
  Cancelled: 'bg-red-500',
  New: 'bg-blue-500',
}

const STATUS_STEP_COLORS = {
  Open:         { active: 'border-blue-500 bg-blue-500',    done: 'border-green-500 bg-green-500', text: 'text-blue-600' },
  'In Progress':{ active: 'border-indigo-500 bg-indigo-500',done: 'border-green-500 bg-green-500', text: 'text-indigo-600' },
  Pending:      { active: 'border-orange-500 bg-orange-500',done: 'border-green-500 bg-green-500', text: 'text-orange-600' },
  'On Hold':    { active: 'border-yellow-500 bg-yellow-500',done: 'border-green-500 bg-green-500', text: 'text-yellow-600' },
  Completed:    { active: 'border-teal-500 bg-teal-500',    done: 'border-green-500 bg-green-500', text: 'text-teal-600' },
  Closed:       { active: 'border-green-600 bg-green-600',  done: 'border-green-500 bg-green-500', text: 'text-green-700' },
  Cancelled:    { active: 'border-red-500 bg-red-500',      done: 'border-red-500 bg-red-500',     text: 'text-red-600' },
}

const SCHEMA_SQL = `-- Run these in your Supabase SQL editor:
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS parent_comment_id UUID REFERENCES ticket_comments(id) ON DELETE SET NULL;
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]';
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS is_customer_comment BOOLEAN DEFAULT false;`

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  )
}
function fileSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function RMATracker() {
  const { t } = useTranslation()
  const [branding, setBranding] = useState(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [ticket, setTicket] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [comments, setComments] = useState([])
  const [schemaOk, setSchemaOk] = useState(true)
  // Rate-limit state
  const [rlLocked, setRlLocked] = useState(() => checkRateLimit().locked)
  const [rlSecsLeft, setRlSecsLeft] = useState(0)
  const lastSearchRef = useRef(0) // timestamp of last search attempt

  // New comment state
  const [authorName, setAuthorName] = useState('')
  const [authorEmail, setAuthorEmail] = useState('')
  const [messageText, setMessageText] = useState('')
  const [replyingTo, setReplyingTo] = useState(null)
  const [commentFiles, setCommentFiles] = useState([])
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef(null)

  // Countdown ticker while rate-limit lockout is active
  useEffect(() => {
    const rl = checkRateLimit()
    if (!rl.locked) {
      setRlLocked(false)
      return
    }
    setRlLocked(true)
    setRlSecsLeft(rl.secsLeft)
    const id = setInterval(() => {
      const updated = checkRateLimit()
      if (!updated.locked) {
        setRlLocked(false)
        clearInterval(id)
      } else setRlSecsLeft(updated.secsLeft)
    }, 1000)
    return () => clearInterval(id)
  }, [rlLocked])

  useEffect(() => {
    brandingAPI
      .getBranding()
      .then(setBranding)
      .catch(() => {})
    // Pre-fill RMA from URL ?rma=...
    const params = new URLSearchParams(window.location.search)
    const rma = params.get('rma') || params.get('rma_number')
    if (rma) {
      setQuery(rma)
      handleSearch(rma)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSearch = useCallback(
    async (overrideQuery) => {
      const q = (overrideQuery || query).trim()
      if (!q) return

      // Enforce rate limit
      const rl = checkRateLimit()
      if (rl.locked) {
        setRlLocked(true)
        setRlSecsLeft(rl.secsLeft)
        return
      }

      // Throttle: at least 800 ms between searches
      const now = Date.now()
      if (now - lastSearchRef.current < 800) return
      lastSearchRef.current = now

      setLoading(true)
      setNotFound(false)
      setTicket(null)
      setComments([])
      try {
        const found = await db.rmaTracker.getTicketByRmaNumber(q)
        if (!found) {
          setNotFound(true)
          const s = recordFailure()
          if (s.lockedUntil) {
            setRlLocked(true)
            setRlSecsLeft(Math.ceil((s.lockedUntil - Date.now()) / 1000))
          }
          return
        }
        clearFailures()
        setTicket(found)
        const c = await db.rmaTracker.getPublicComments(found.id)
        setComments(c)
        // Check if schema has new columns
        if (c.length > 0 && !('parent_comment_id' in c[0])) setSchemaOk(false)
      } finally {
        setLoading(false)
      }
    },
    [query]
  )

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files)
    setCommentFiles((prev) => [...prev, ...files])
    e.target.value = ''
  }

  const removeFile = (idx) => setCommentFiles((prev) => prev.filter((_, i) => i !== idx))

  const handleSubmitComment = async (e) => {
    e.preventDefault()
    if (!messageText.trim() || !authorName.trim() || !ticket) return
    setSubmitting(true)
    try {
      let attachments = []
      if (commentFiles.length > 0) {
        setUploadingFiles(true)
        attachments = await Promise.all(
          commentFiles.map((f) => storage.uploadCommentAttachment(f, ticket.id))
        )
        setUploadingFiles(false)
      }
      const comment = await db.rmaTracker.addComment(
        ticket.id,
        authorName.trim(),
        authorEmail.trim() || null,
        messageText.trim(),
        replyingTo,
        attachments
      )
      if (comment) setComments((prev) => [...prev, comment])
      setMessageText('')
      setCommentFiles([])
      setReplyingTo(null)
    } catch {
      alert('Failed to send message. Please try again.')
    } finally {
      setSubmitting(false)
      setUploadingFiles(false)
    }
  }

  // Normalize legacy 'New' → 'Open' so old tickets still show progress correctly.
  const currentStatus = ticket?.ticket_status === 'New' ? 'Open' : ticket?.ticket_status
  const isCancelled = currentStatus === 'Cancelled'
  const stepIdx = PROGRESS_STEPS.findIndex((s) => s.toLowerCase() === currentStatus?.toLowerCase())
  const products = ticket?.products || []
  const topComments = comments.filter((c) => !c.parent_comment_id)
  const getReplies = (id) => comments.filter((c) => c.parent_comment_id === id)

  const primaryColor = branding?.primary_color || '#4F46E5'
  const companyName = branding?.company_name || 'myCRM'

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-3">
          {branding?.logo_url ? (
            <img src={branding.logo_url} alt={companyName} className="h-9 object-contain" />
          ) : (
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold text-sm"
              style={{ backgroundColor: primaryColor }}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </div>
          )}
          <div>
            <div className="font-bold text-gray-900 text-lg leading-tight">{companyName}</div>
            <div className="text-xs text-gray-500">Service Request Tracker</div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-10 space-y-8">
        {/* Schema notice (dev-only — never shown to customers) */}
        {!schemaOk && import.meta.env.DEV && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
            <strong>Database migration required.</strong> Run this SQL in your Supabase editor to
            enable replies and attachments:
            <pre className="mt-2 text-xs bg-amber-100 rounded p-3 overflow-x-auto whitespace-pre">
              {SCHEMA_SQL}
            </pre>
          </div>
        )}

        {/* Search hero */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-gray-900">Track Your Service Request</h1>
          <p className="text-gray-500">
            Enter your RMA number to check the current status and communicate with our team.
          </p>
          <a href="/kb" className="inline-block text-sm text-indigo-600 hover:text-indigo-700 font-medium">
            {t('kb.needHelpLink')}
          </a>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSearch()
          }}
          className="flex gap-3 max-w-xl mx-auto"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. RMA-15052025-0001"
            className="flex-1 px-4 py-3 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent shadow-sm"
            disabled={rlLocked}
          />
          <button
            type="submit"
            disabled={loading || !query.trim() || rlLocked}
            className="px-6 py-3 rounded-xl text-white text-sm font-semibold shadow-sm disabled:opacity-50 transition-colors hover:opacity-90"
            style={{ backgroundColor: primaryColor }}
          >
            {loading ? (
              <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
            ) : (
              'Track'
            )}
          </button>
        </form>

        {/* Rate-limit lockout banner */}
        {rlLocked && (
          <div className="max-w-xl mx-auto bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 text-center space-y-1">
            <p className="font-semibold">Too many failed lookups</p>
            <p>
              Please wait{' '}
              <span className="font-mono font-bold">
                {Math.floor(rlSecsLeft / 60)}:{String(rlSecsLeft % 60).padStart(2, '0')}
              </span>{' '}
              before trying again.
            </p>
          </div>
        )}

        {/* Not found */}
        {notFound && !rlLocked && (
          <div className="text-center py-10 space-y-2">
            <div className="text-5xl">🔍</div>
            <p className="text-gray-700 font-medium">
              No ticket found for <span className="font-mono text-indigo-600">"{query}"</span>
            </p>
            <p className="text-gray-500 text-sm">
              Please double-check your RMA number and try again.
            </p>
          </div>
        )}

        {/* Ticket result */}
        {ticket && (
          <div className="space-y-6">
            {/* Status card */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-5">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider font-medium mb-1">
                    RMA Number
                  </div>
                  <div className="text-2xl font-bold text-gray-900 font-mono">
                    {ticket.rma_number}
                  </div>
                </div>
                <span
                  className={`px-4 py-1.5 rounded-full text-sm font-semibold text-white ${STATUS_COLORS[ticket.ticket_status] || 'bg-gray-400'}`}
                >
                  {ticket.ticket_status}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">
                    Received
                  </div>
                  <div className="font-medium text-gray-800">{fmtDate(ticket.created_date)}</div>
                </div>
                {ticket.due_date && (
                  <div>
                    <div className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">
                      Estimated Completion
                    </div>
                    <div className="font-medium text-gray-800">{fmtDate(ticket.due_date)}</div>
                  </div>
                )}
                {ticket.priority && (
                  <div>
                    <div className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">
                      Priority
                    </div>
                    <div className="font-medium text-gray-800">{ticket.priority}</div>
                  </div>
                )}
              </div>

              {/* Status timeline */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="text-xs text-gray-500 uppercase tracking-wide font-medium">
                    Progress
                  </div>
                  <button
                    onClick={() => handleSearch(ticket.rma_number)}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-600 transition-colors px-2 py-1 rounded-lg hover:bg-indigo-50"
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
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      />
                    </svg>
                    Refresh
                  </button>
                </div>
                {/* 7-step progress bar — scrollable on mobile so labels aren't crushed */}
                <div className="overflow-x-auto -mx-1 px-1 pb-1">
                  <div className="flex items-start gap-0 min-w-[480px]">
                    {PROGRESS_STEPS.map((step, i) => {
                      const isLast = i === PROGRESS_STEPS.length - 1
                      const active = i === stepIdx
                      // When Cancelled is active, treat all previous steps as "not done" —
                      // we don't know which statuses the ticket actually passed through.
                      const done = isCancelled ? false : i < stepIdx
                      const colors = STATUS_STEP_COLORS[step] || {
                        active: 'border-indigo-600 bg-indigo-600',
                        done: 'border-green-500 bg-green-500',
                        text: 'text-indigo-600',
                      }
                      const isCancelledStep = step === 'Cancelled'
                      return (
                        <React.Fragment key={step}>
                          <div className="flex flex-col items-center gap-1.5 flex-shrink-0 flex-1">
                            <div
                              className={`w-7 h-7 rounded-full flex items-center justify-center border-2 transition-all ${
                                active ? colors.active : done ? colors.done : 'border-gray-200 bg-white'
                              }`}
                            >
                              {done ? (
                                <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              ) : active && isCancelledStep ? (
                                <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              ) : active ? (
                                <div className="w-2 h-2 bg-white rounded-full" />
                              ) : null}
                            </div>
                            <span className={`text-[9px] sm:text-[10px] font-medium leading-tight text-center w-full px-0.5 ${
                              active ? colors.text : done ? 'text-green-600' : 'text-gray-400'
                            }`}>
                              {step}
                            </span>
                          </div>
                          {!isLast && (
                            <div className={`h-0.5 flex-1 mx-0.5 mt-3.5 flex-shrink-0 w-4 ${
                              done ? 'bg-green-400' : 'bg-gray-200'
                            }`} />
                          )}
                        </React.Fragment>
                      )
                    })}
                  </div>
                </div>
                {/* Cancelled note below the bar */}
                {isCancelled && (
                  <p className="text-xs text-red-500 mt-2 text-center">
                    This request has been cancelled — no further action will be taken.
                  </p>
                )}
              </div>
            </div>

            {/* General description */}
            {ticket.general_description && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Issue Description
                </h2>
                <p className="text-gray-700 text-sm leading-relaxed whitespace-pre-wrap">
                  {ticket.general_description}
                </p>
              </div>
            )}

            {/* Products */}
            {products.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                  Items ({products.length})
                </h2>
                <div className="space-y-3">
                  {products.map((p, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-4 p-4 bg-gray-50 rounded-xl border border-gray-100"
                    >
                      <div className="w-9 h-9 bg-indigo-100 rounded-lg flex items-center justify-center flex-shrink-0">
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
                            d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"
                          />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900 text-sm">
                          {p.product_name || `Item ${i + 1}`}
                        </div>
                        {p.serial_number && (
                          <div className="text-xs text-gray-500 mt-0.5 font-mono">
                            S/N: {p.serial_number}
                          </div>
                        )}
                        {p.issue_description && (
                          <div className="text-xs text-gray-600 mt-1">{p.issue_description}</div>
                        )}
                        <div className="flex gap-2 mt-2 flex-wrap">
                          {p.product_status && (
                            <span
                              className={`px-2 py-0.5 text-xs rounded-full font-medium ${PRODUCT_STATUS_COLORS[p.product_status] || 'bg-gray-100 text-gray-600'}`}
                            >
                              {p.product_status}
                            </span>
                          )}
                          {p.warranty_status && (
                            <span
                              className={`px-2 py-0.5 text-xs rounded-full font-medium ${p.warranty_status === 'In Warranty' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
                            >
                              {p.warranty_status}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Messages */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-5">
                Messages{' '}
                {comments.length > 0 && (
                  <span className="ms-1 text-gray-500">({comments.length})</span>
                )}
              </h2>

              {/* Thread */}
              {comments.length === 0 ? (
                <div className="text-center py-6 text-gray-500 text-sm">
                  No messages yet. Send a message below to contact our team.
                </div>
              ) : (
                <div className="space-y-4 mb-6">
                  {topComments.map((comment) => (
                    <CommentThread
                      key={comment.id}
                      comment={comment}
                      replies={getReplies(comment.id)}
                      replyingTo={replyingTo}
                      onReply={() => setReplyingTo(replyingTo === comment.id ? null : comment.id)}
                    />
                  ))}
                </div>
              )}

              {/* Compose */}
              <div className="border border-gray-200 rounded-xl p-4 space-y-3 bg-gray-50">
                <div className="text-sm font-semibold text-gray-700">
                  {replyingTo ? (
                    <div className="flex items-center justify-between">
                      <span>Replying to message</span>
                      <button
                        onClick={() => setReplyingTo(null)}
                        className="text-xs text-indigo-600 hover:underline"
                      >
                        Cancel reply
                      </button>
                    </div>
                  ) : (
                    'Send a Message'
                  )}
                </div>
                <form onSubmit={handleSubmitComment} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <input
                        value={authorName}
                        onChange={(e) => setAuthorName(e.target.value)}
                        required
                        placeholder="Your name *"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 bg-white"
                      />
                    </div>
                    <div>
                      <input
                        type="email"
                        value={authorEmail}
                        onChange={(e) => setAuthorEmail(e.target.value)}
                        placeholder="Email (optional)"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 bg-white"
                      />
                    </div>
                  </div>
                  <textarea
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    required
                    rows={3}
                    placeholder="Write your message..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 resize-none bg-white"
                  />

                  {/* File attachments */}
                  {commentFiles.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {commentFiles.map((f, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-1.5 px-2 py-1 bg-white border border-gray-200 rounded-lg text-xs text-gray-700"
                        >
                          <svg
                            className="w-3.5 h-3.5 text-gray-500"
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
                          <span className="max-w-[120px] truncate">{f.name}</span>
                          <span className="text-gray-500">({fileSize(f.size)})</span>
                          <button
                            type="button"
                            onClick={() => removeFile(i)}
                            className="text-gray-500 hover:text-red-500 ms-0.5"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-indigo-600 px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-white transition-colors"
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
                      Attach file
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={handleFileChange}
                    />
                    <button
                      type="submit"
                      disabled={submitting || !messageText.trim() || !authorName.trim()}
                      className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 transition-opacity hover:opacity-90"
                      style={{ backgroundColor: primaryColor }}
                    >
                      {submitting ? (
                        <>
                          <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                          {uploadingFiles ? 'Uploading…' : 'Sending…'}
                        </>
                      ) : (
                        <>
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
                          Send Message
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-gray-200 mt-10 py-5 text-center text-xs text-gray-500">
        Powered by <span className="font-semibold text-gray-500">myCRM</span> — Secure service
        request tracking
      </footer>
    </div>
  )
}

function CommentThread({ comment, replies, replyingTo, onReply }) {
  const isTeam = !comment.is_customer_comment
  const displayName = comment.author_name || comment.user_email || 'Team'
  const initials = displayName[0]?.toUpperCase() || '?'
  const attachments = comment.attachments || []

  return (
    <div>
      <CommentBubble
        comment={comment}
        isTeam={isTeam}
        displayName={displayName}
        initials={initials}
        attachments={attachments}
        showReplyBtn
        isReplying={replyingTo === comment.id}
        onReply={onReply}
      />
      {replies.length > 0 && (
        <div className="ms-8 mt-2 space-y-2 ps-4 border-l-2 border-gray-100">
          {replies.map((reply) => {
            const rIsTeam = !reply.is_customer_comment
            const rName = reply.author_name || reply.user_email || 'Team'
            return (
              <CommentBubble
                key={reply.id}
                comment={reply}
                isTeam={rIsTeam}
                displayName={rName}
                initials={rName[0]?.toUpperCase() || '?'}
                attachments={reply.attachments || []}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function CommentBubble({
  comment,
  isTeam,
  displayName,
  initials,
  attachments,
  showReplyBtn,
  isReplying,
  onReply,
}) {
  return (
    <div
      className={`flex gap-3 p-4 rounded-xl border ${isTeam ? 'bg-indigo-50 border-indigo-100' : 'bg-gray-50 border-gray-100'}`}
    >
      <div
        className={`w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 ${isTeam ? 'bg-indigo-500' : 'bg-gray-400'}`}
      >
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-sm font-semibold text-gray-900">{displayName}</span>
          {isTeam && (
            <span className="px-2 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700 rounded-full">
              Support Team
            </span>
          )}
          <span className="text-xs text-gray-500 ms-auto">{fmtDateTime(comment.created_date)}</span>
        </div>
        <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
          {comment.comment_text}
        </p>
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {attachments.map((att, i) => (
              <a
                key={i}
                href={att.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-2.5 py-1 bg-white border border-gray-200 rounded-lg text-xs text-indigo-600 hover:bg-indigo-50 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                  />
                </svg>
                <span className="max-w-[140px] truncate">{att.name}</span>
              </a>
            ))}
          </div>
        )}
        {showReplyBtn && (
          <button
            onClick={onReply}
            className={`mt-2 text-xs font-medium transition-colors ${isReplying ? 'text-indigo-600' : 'text-gray-500 hover:text-indigo-500'}`}
          >
            {isReplying ? '↩ Cancel reply' : '↩ Reply'}
          </button>
        )}
      </div>
    </div>
  )
}
