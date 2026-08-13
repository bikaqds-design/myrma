import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db, storage, supabase } from '../api/supabaseClient'
import { Button, Textarea, Input, Select, Spinner } from './ui'
import { ACTIVITY_TYPE_SCHEDULABLE } from '../lib/constants'
import { approvalRequestLabel } from '../lib/approvalLabels'
import { EMPTY_ARRAY } from '../lib/stableEmpty'

const TYPE_ICON = {
  call: '📞',
  meeting: '🤝',
  whatsapp: '💬',
  email: '✉️',
  task: '✅',
  note: '📝',
  log: '🕓',
  approval: '📋',
}

// Approval pool format: approval|docType|docId|code|total|customer
function parseApprovalTitle(title) {
  const parts = (title || '').split('|')
  return {
    docType: parts[1] ?? 'quotation',
    docId: parts[2] ?? '',
    code: parts[3] ?? '—',
    total: Number(parts[4]) || 0,
    customer: parts[5] ?? '—',
  }
}

const NOTE_MAX_LENGTH = 300

// System 'log' entries store a pipe-encoded title so the text stays
// translatable at render time (the DB never holds a localized string).
// Stage/status names (a/b below) are baked in as plain text at write time —
// see deals.ts moveStage()/leads.ts updateStatus() — not re-resolved here.
function renderLogTitle(title, t) {
  const [kind, a, b] = title.split('|')
  if (kind === 'status_changed') {
    return t('activityChatter.logStatus', { from: t(`leadStatus.${a}`), to: t(`leadStatus.${b}`) })
  }
  if (kind === 'stage_changed') return t('activityChatter.logStage', { from: a, to: b })
  if (kind === 'converted') return t('activityChatter.logConverted')
  if (kind === 'won') return t('activityChatter.logWon')
  if (kind === 'lost') return t('activityChatter.logLost', { reason: a })
  if (kind === 'reopened') return t('activityChatter.logReopened', { from: a, to: b })
  if (kind === 'assigned') {
    return t('activityChatter.logAssigned', {
      from: a || t('leadModal.unassigned'),
      to: b || t('leadModal.unassigned'),
    })
  }
  if (kind === 'field_updated') {
    return t('activityChatter.logFieldUpdated', { field: t(a), value: b || '—' })
  }
  if (kind === 'quotation_created')   return t('activityChatter.logQuotationCreated',   { code: a })
  if (kind === 'quotation_sent')      return t('activityChatter.logQuotationSent',       { code: a })
  if (kind === 'quotation_accepted')  return t('activityChatter.logQuotationAccepted',   { code: a })
  if (kind === 'quotation_declined')  return t('activityChatter.logQuotationDeclined',   { code: a })
  if (kind === 'quotation_cancelled') return t('activityChatter.logQuotationCancelled',  { code: a })
  if (kind === 'quotation_reopened')  return t('activityChatter.logQuotationReopened',   { code: a })
  if (kind === 'quotation_converted') return t('activityChatter.logQuotationConverted',  { code: a })
  return title
}

function fmtTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString()
}

function isOverdue(activity) {
  return !activity.completed_at && activity.due_date && new Date(activity.due_date) < new Date()
}

export function ActivityChatter({ relatedType, relatedId, currentUserEmail, salesReps, canEdit, controlledTab, onControlledTabChange, hideNoteComposer, hideHistory, currentUserRole, onApproveActivity, onRejectActivity }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileInputRef = useRef(null)
  const canApprove = ['manager', 'admin', 'super_admin'].includes(currentUserRole)

  const [internalTab, setInternalTab] = useState('note')
  const tab = controlledTab ?? internalTab
  const setTab = onControlledTabChange ?? setInternalTab
  const [noteText, setNoteText] = useState('')
  const [files, setFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [actType, setActType] = useState('call')
  const [actTitle, setActTitle] = useState('')
  const [actDue, setActDue] = useState('')
  const [actRep, setActRep] = useState('')

  const [replyingTo, setReplyingTo] = useState(null)
  const [replyText, setReplyText] = useState('')
  const [reschedulingId, setReschedulingId] = useState(null)
  const [rescheduleDue, setRescheduleDue] = useState('')

  const queryKey = ['activities', relatedType, relatedId]
  const { data: activities = EMPTY_ARRAY, isLoading } = useQuery({
    queryKey,
    queryFn: () => db.activities.list(relatedType, relatedId),
    enabled: !!relatedId,
  })

  // Realtime: refresh the feed when any user posts against this record.
  useEffect(() => {
    if (!relatedId) return
    const channel = supabase
      .channel(`activities_${relatedType}_${relatedId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activities', filter: `related_id=eq.${relatedId}` }, () => {
        queryClient.invalidateQueries({ queryKey })
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relatedType, relatedId, queryClient])

  const planned = activities
    .filter((a) => !a.parent_id && !a.completed_at && a.type !== 'note' && a.type !== 'log')
    .sort((a, b) => new Date(a.due_date || a.created_at) - new Date(b.due_date || b.created_at))
  const history = activities
    .filter((a) => !a.parent_id && (a.completed_at || a.type === 'note' || a.type === 'log'))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  const repliesOf = (parentId) =>
    activities.filter((a) => a.parent_id === parentId).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

  const handleSelectFiles = async (e) => {
    const picked = Array.from(e.target.files || [])
    if (picked.length === 0) return
    setUploading(true)
    try {
      const uploaded = []
      for (const file of picked) {
        uploaded.push(await storage.uploadActivityAttachment(file, relatedType, relatedId))
      }
      setFiles((prev) => [...prev, ...uploaded])
    } catch (error) {
      toast.error(t('activityChatter.failedComment', { error: error.message }))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeFile = (path) => setFiles((prev) => prev.filter((f) => f.path !== path))

  const handlePostNote = async () => {
    const text = noteText.trim()
    if (!text && files.length === 0) return
    setSubmitting(true)
    try {
      await db.activities.create({
        related_type: relatedType,
        related_id: relatedId,
        type: 'note',
        title: text || t('activityChatter.attachmentOnly'),
        due_date: null,
        assigned_rep: null,
        outcome_notes: null,
        created_by: currentUserEmail,
        attachments: files,
      })
      setNoteText('')
      setFiles([])
      toast.success(t('activityChatter.commentPosted'))
      queryClient.invalidateQueries({ queryKey })
    } catch (error) {
      toast.error(t('activityChatter.failedComment', { error: error.message }))
    } finally {
      setSubmitting(false)
    }
  }

  const handleScheduleActivity = async () => {
    const title = actTitle.trim()
    if (!title) {
      toast.error(t('activityChatter.activityTitleRequired'))
      return
    }
    if (!actDue) {
      toast.error(t('activityChatter.activityDueDateRequired'))
      return
    }
    setSubmitting(true)
    try {
      await db.activities.create({
        related_type: relatedType,
        related_id: relatedId,
        type: actType,
        title,
        due_date: new Date(actDue).toISOString(),
        assigned_rep: actRep || currentUserEmail,
        outcome_notes: null,
        created_by: currentUserEmail,
      })
      setActTitle('')
      setActDue('')
      setActRep('')
      toast.success(t('activityChatter.activityScheduled'))
      queryClient.invalidateQueries({ queryKey })
    } catch (error) {
      toast.error(t('activityChatter.failedComment', { error: error.message }))
    } finally {
      setSubmitting(false)
    }
  }

  const handleMarkDone = async (activity) => {
    try {
      await db.activities.complete(activity.id)
      toast.success(t('activityChatter.activityDone'))
      queryClient.invalidateQueries({ queryKey })
    } catch (error) {
      toast.error(t('activityChatter.failedComment', { error: error.message }))
    }
  }

  const handleReopen = async (activity) => {
    try {
      await db.activities.reopen(activity.id)
      toast.success(t('activityChatter.activityReopened'))
      queryClient.invalidateQueries({ queryKey })
    } catch (error) {
      toast.error(t('activityChatter.failedComment', { error: error.message }))
    }
  }

  const handleCancelActivity = async (activity) => {
    try {
      await db.activities.delete(activity.id)
      toast.success(t('activityChatter.activityCancelled'))
      queryClient.invalidateQueries({ queryKey })
    } catch (error) {
      toast.error(t('activityChatter.failedComment', { error: error.message }))
    }
  }

  const startReschedule = (activity) => {
    setReschedulingId(activity.id)
    setRescheduleDue(activity.due_date ? activity.due_date.slice(0, 16) : '')
  }

  const handleSaveReschedule = async (activity) => {
    if (!rescheduleDue) return
    try {
      await db.activities.reschedule(activity.id, new Date(rescheduleDue).toISOString())
      setReschedulingId(null)
      toast.success(t('activityChatter.activityRescheduled'))
      queryClient.invalidateQueries({ queryKey })
    } catch (error) {
      toast.error(t('activityChatter.failedComment', { error: error.message }))
    }
  }

  const handlePostReply = async (parentActivity) => {
    const text = replyText.trim()
    if (!text) return
    setSubmitting(true)
    try {
      await db.activities.create({
        related_type: relatedType,
        related_id: relatedId,
        type: 'note',
        title: text,
        due_date: null,
        assigned_rep: null,
        outcome_notes: null,
        created_by: currentUserEmail,
        parent_id: parentActivity.id,
      })
      setReplyText('')
      setReplyingTo(null)
      queryClient.invalidateQueries({ queryKey })
    } catch (error) {
      toast.error(t('activityChatter.failedComment', { error: error.message }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      {/* Composer — hidden on note tab when composer lives in the right panel */}
      {canEdit && !(hideNoteComposer && tab === 'note') && (
        <div className="border border-gray-200 dark:border-[#212a38] rounded-xl overflow-hidden mb-5">
          {!controlledTab && (
            <div className="flex border-b border-gray-200 dark:border-[#212a38]">
              <button
                onClick={() => setTab('note')}
                className={`px-4 py-2 text-sm font-medium ${tab === 'note' ? 'text-indigo-600 dark:text-[#a5b4fc] border-b-2 border-indigo-600 dark:border-[#a5b4fc]' : 'text-gray-500 dark:text-[#9aa4b2]'}`}
              >
                {t('activityChatter.logNote')}
              </button>
              <button
                onClick={() => setTab('activity')}
                className={`px-4 py-2 text-sm font-medium ${tab === 'activity' ? 'text-indigo-600 dark:text-[#a5b4fc] border-b-2 border-indigo-600 dark:border-[#a5b4fc]' : 'text-gray-500 dark:text-[#9aa4b2]'}`}
              >
                {t('activityChatter.scheduleActivity')}
              </button>
            </div>
          )}

          <div className="p-3">
            {tab === 'note' ? (
              <div className="space-y-2">
                <Textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value.slice(0, NOTE_MAX_LENGTH))}
                  rows={2}
                  maxLength={NOTE_MAX_LENGTH}
                  placeholder={t('activityChatter.commentPlaceholder')}
                />
                {files.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {files.map((f) => (
                      <span key={f.path} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-[#0f1520] rounded-lg text-xs text-gray-700 dark:text-[#e8ebf0]">
                        📎 {f.name}
                        <button onClick={() => removeFile(f.path)} className="text-gray-400 hover:text-red-500" aria-label={t('common.remove')}>
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      className="text-sm text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 flex items-center gap-1"
                    >
                      {uploading ? <Spinner size="sm" /> : '📎'} {t('activityChatter.attach')}
                    </button>
                    <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleSelectFiles} />
                    <span className="text-xs text-gray-400 dark:text-[#4a5568]">{noteText.length}/{NOTE_MAX_LENGTH}</span>
                  </div>
                  <Button size="sm" onClick={handlePostNote} loading={submitting} disabled={!noteText.trim() && files.length === 0}>
                    {t('activityChatter.postComment')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Select value={actType} onChange={(e) => setActType(e.target.value)}>
                    {ACTIVITY_TYPE_SCHEDULABLE.map((tp) => (
                      <option key={tp} value={tp}>
                        {TYPE_ICON[tp]} {t(`activityType.${tp}`)}
                      </option>
                    ))}
                  </Select>
                  <Input type="datetime-local" value={actDue} onChange={(e) => setActDue(e.target.value)} required />
                </div>
                <Input
                  value={actTitle}
                  onChange={(e) => setActTitle(e.target.value)}
                  placeholder={t('activityChatter.activityTitlePlaceholder')}
                />
                <div className="flex items-center justify-between gap-2">
                  <Select value={actRep} onChange={(e) => setActRep(e.target.value)} className="max-w-[60%]">
                    <option value="">{t('activityChatter.assignToMe')}</option>
                    {salesReps.map((r) => (
                      <option key={r.user_email} value={r.user_email}>
                        {r.user_email}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" onClick={handleScheduleActivity} loading={submitting} disabled={!actTitle.trim() || !actDue}>
                    {t('activityChatter.schedule')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
        <>
          {/* Planned activities */}
          {planned.length > 0 && (
            <div className="mb-5">
              <h4 className="text-xs font-semibold uppercase text-gray-500 dark:text-[#9aa4b2] mb-2">{t('activityChatter.planned')}</h4>
              <ul className="space-y-2">
                {planned.map((a) => (
                  <li
                    key={a.id}
                    className={`p-3 rounded-lg border ${
                      a.type === 'approval'
                        ? 'border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/60 dark:bg-indigo-900/10'
                        : isOverdue(a)
                          ? 'border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10'
                          : 'border-gray-200 dark:border-[#212a38] bg-gray-50 dark:bg-[#0f1520]'
                    }`}
                  >
                    {a.type === 'approval' ? (
                      /* ── Approval card ── */
                      <div>
                        <div className="flex items-start gap-3">
                          <span className="text-lg leading-none">📋</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">
                              {approvalRequestLabel(t, parseApprovalTitle(a.title).docType)}
                            </p>
                            {(() => { const { code, total, customer } = parseApprovalTitle(a.title); return (
                              <p className="text-xs text-gray-600 dark:text-[#9aa4b2] mt-0.5">
                                {code} · {customer} · {total.toLocaleString()}
                                {a.due_date && ` · ${t('salesDocs.validityUntil')}: ${fmtTime(a.due_date)}`}
                              </p>
                            )})()}
                            <p className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium mt-1">
                              {t('activityChatter.pendingApproval')}
                            </p>
                          </div>
                        </div>
                        {canApprove && onApproveActivity && onRejectActivity && (
                          <div className="flex gap-2 mt-2 ml-8">
                            {/* The activity is passed alongside its id because its title
                                encodes which document the approval targets — a parent may
                                hold several. Extra arg; existing callers can ignore it. */}
                            <button
                              onClick={() => onApproveActivity(a.id, a)}
                              className="px-3 py-1 text-xs font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors"
                            >
                              ✓ {t('activityChatter.approvalApprove')}
                            </button>
                            <button
                              onClick={() => onRejectActivity(a.id, a)}
                              className="px-3 py-1 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
                            >
                              ✗ {t('activityChatter.approvalReject')}
                            </button>
                          </div>
                        )}
                        <p className="text-xs text-gray-400 dark:text-[#4a5568] mt-2 ml-8">
                          {a.created_by || '—'} · {fmtTime(a.created_at)}
                        </p>
                      </div>
                    ) : (
                    <div className="flex items-start gap-3">
                      <span className="text-lg leading-none">{TYPE_ICON[a.type] || '•'}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-900 dark:text-[#e8ebf0]">{a.title}</p>
                        <p className={`text-xs mt-0.5 ${isOverdue(a) ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-500 dark:text-[#9aa4b2]'}`}>
                          {t(`activityType.${a.type}`)}
                          {a.due_date && ` · ${fmtTime(a.due_date)}`}
                          {isOverdue(a) && ` · ${t('activityChatter.overdue')}`}
                          {a.assigned_rep && ` · ${a.assigned_rep}`}
                        </p>
                      </div>
                    </div>
                    )}
                    {a.type !== 'approval' && reschedulingId === a.id && (
                      <div className="flex items-center gap-2 mt-2 ml-8">
                        <Input
                          type="datetime-local"
                          value={rescheduleDue}
                          onChange={(e) => setRescheduleDue(e.target.value)}
                          className="text-xs py-1"
                        />
                        <Button size="sm" onClick={() => handleSaveReschedule(a)} disabled={!rescheduleDue}>
                          {t('common.save')}
                        </Button>
                        <button onClick={() => setReschedulingId(null)} className="text-xs text-gray-500 dark:text-[#9aa4b2] hover:underline">
                          {t('common.cancel')}
                        </button>
                      </div>
                    )}
                    {a.type !== 'approval' && canEdit && reschedulingId !== a.id && (
                      <div className="flex items-center gap-4 mt-2 ml-8">
                        <button onClick={() => handleMarkDone(a)} className="text-xs font-medium text-indigo-600 dark:text-[#a5b4fc] hover:underline">
                          ✓ {t('activityChatter.markDone')}
                        </button>
                        <button onClick={() => startReschedule(a)} className="text-xs text-gray-500 dark:text-[#9aa4b2] hover:underline">
                          ✏ {t('common.edit')}
                        </button>
                        <button onClick={() => handleCancelActivity(a)} className="text-xs text-red-500 dark:text-red-400 hover:underline">
                          ✕ {t('activityChatter.cancelActivity')}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* History feed — hidden when hideHistory=true (Schedule Activity tab) */}
          {!hideHistory && (
            <>
              <h4 className="text-xs font-semibold uppercase text-gray-500 dark:text-[#9aa4b2] mb-2">{t('activityChatter.history')}</h4>
              {history.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('activityChatter.noComments')}</p>
              ) : (
                <ul className="space-y-3">
                  {history.map((a) => {
                    const isCompletedActivity = a.completed_at && a.type !== 'note' && a.type !== 'log'
                    const replies = repliesOf(a.id)
                    return (
                      <li key={a.id} className="flex items-start gap-3">
                        <span className="text-base leading-none mt-0.5">{TYPE_ICON[a.type] || '•'}</span>
                        <div className="flex-1 min-w-0">
                          {a.type === 'log' ? (
                            <p className="text-sm italic text-gray-500 dark:text-[#9aa4b2]">{renderLogTitle(a.title, t)}</p>
                          ) : a.type === 'approval' ? (
                            <div>
                              <p className="text-sm font-semibold text-gray-800 dark:text-[#e8ebf0]">
                                {approvalRequestLabel(t, parseApprovalTitle(a.title).docType)} · {parseApprovalTitle(a.title).code}
                              </p>
                              {a.outcome_notes && (
                                <p className={`text-xs mt-0.5 font-medium ${a.outcome_notes.startsWith('Approved') ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                  {a.outcome_notes}
                                </p>
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-gray-800 dark:text-[#e8ebf0] whitespace-pre-wrap">{a.title}</p>
                          )}
                          {a.outcome_notes && (
                            <p className="text-xs text-gray-600 dark:text-[#9aa4b2] mt-1 whitespace-pre-wrap">{a.outcome_notes}</p>
                          )}
                          {Array.isArray(a.attachments) && a.attachments.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-1">
                              {a.attachments.map((f) => (
                                <a
                                  key={f.path}
                                  href={f.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-[#0f1520] rounded-lg text-xs text-indigo-600 dark:text-[#a5b4fc] hover:underline"
                                >
                                  📎 {f.name}
                                </a>
                              ))}
                            </div>
                          )}
                          <div className="text-xs text-gray-400 dark:text-[#4a5568] mt-1 flex items-center gap-2 flex-wrap">
                            <span>
                              {a.created_by || '—'} · {fmtTime(a.created_at)}
                              {isCompletedActivity && ` · ✓ ${t('activityChatter.completed')}`}
                            </span>
                            {a.type !== 'log' && canEdit && (
                              <button
                                onClick={() => setReplyingTo(replyingTo === a.id ? null : a.id)}
                                className="text-indigo-600 dark:text-[#a5b4fc] hover:underline"
                              >
                                {t('activityChatter.reply')}
                              </button>
                            )}
                            {isCompletedActivity && canEdit && (
                              <button onClick={() => handleReopen(a)} className="text-indigo-600 dark:text-[#a5b4fc] hover:underline">
                                {t('activityChatter.reopen')}
                              </button>
                            )}
                          </div>

                          {/* Replies thread */}
                          {replies.length > 0 && (
                            <ul className="mt-2 space-y-2 border-l-2 border-gray-200 dark:border-[#212a38] pl-3">
                              {replies.map((r) => (
                                <li key={r.id}>
                                  <p className="text-sm text-gray-800 dark:text-[#e8ebf0] whitespace-pre-wrap">{r.title}</p>
                                  <div className="text-xs text-gray-400 dark:text-[#4a5568] mt-0.5">
                                    {r.created_by || '—'} · {fmtTime(r.created_at)}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}

                          {replyingTo === a.id && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input
                                value={replyText}
                                onChange={(e) => setReplyText(e.target.value.slice(0, NOTE_MAX_LENGTH))}
                                placeholder={t('activityChatter.replyPlaceholder')}
                                className="text-sm"
                              />
                              <Button size="sm" onClick={() => handlePostReply(a)} loading={submitting} disabled={!replyText.trim()}>
                                {t('activityChatter.reply')}
                              </Button>
                            </div>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
