import React, { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db, storage, supabase } from '../../api/supabaseClient'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { Button, Spinner } from '../../components/ui'
import toast from 'react-hot-toast'
import { toUserMessage } from '../../lib/errorMessage'

const NOTE_MAX = 500

const AVATAR_COLORS = [
  'bg-indigo-500', 'bg-blue-500', 'bg-emerald-500', 'bg-purple-500',
  'bg-pink-500', 'bg-orange-500', 'bg-teal-500', 'bg-rose-500',
]

function avatarColor(email) {
  let h = 0
  for (const c of (email || '')) h = (h * 31 + c.charCodeAt(0)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

function initials(email) {
  if (!email) return '?'
  return email[0].toUpperCase()
}

function fmtTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString()
}

export function DealCommentPanel({ dealId, currentUserEmail, canEdit }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileInputRef = useRef(null)
  const scrollRef = useRef(null)

  const [noteText, setNoteText] = useState('')
  const [files, setFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [replyingTo, setReplyingTo] = useState(null)
  const [replyText, setReplyText] = useState('')
  const [replySubmitting, setReplySubmitting] = useState(false)

  const queryKey = ['activities', 'deal', dealId]

  // `= EMPTY_ARRAY`, not `= []`: `activities` is an effect dependency below.
  const { data: activities = EMPTY_ARRAY, isLoading } = useQuery({
    queryKey,
    queryFn: () => db.activities.list('deal', dealId),
    enabled: !!dealId,
  })

  useEffect(() => {
    if (!dealId) return
    const ch = supabase
      .channel(`deal_comments_panel_${dealId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activities', filter: `related_id=eq.${dealId}` }, () => {
        queryClient.invalidateQueries({ queryKey })
      })
      .subscribe()
    return () => supabase.removeChannel(ch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, queryClient])

  // Scroll to bottom when new comments arrive
  const prevCountRef = useRef(0)
  useEffect(() => {
    const comments = activities.filter((a) => !a.parent_id && a.type === 'note')
    if (comments.length > prevCountRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    prevCountRef.current = comments.length
  }, [activities])

  const comments = activities
    .filter((a) => !a.parent_id && a.type === 'note')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

  const repliesOf = (parentId) =>
    activities
      .filter((a) => a.parent_id === parentId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

  const handleSelectFiles = async (e) => {
    const picked = Array.from(e.target.files || [])
    if (!picked.length) return
    setUploading(true)
    try {
      const uploaded = []
      for (const file of picked) {
        uploaded.push(await storage.uploadActivityAttachment(file, 'deal', dealId))
      }
      setFiles((prev) => [...prev, ...uploaded])
    } catch (err) {
      toast.error(toUserMessage(err))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeFile = (path) => setFiles((prev) => prev.filter((f) => f.path !== path))

  const handlePost = async () => {
    const text = noteText.trim()
    if (!text && files.length === 0) return
    setSubmitting(true)
    try {
      await db.activities.create({
        related_type: 'deal',
        related_id: dealId,
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
      queryClient.invalidateQueries({ queryKey })
    } catch (err) {
      toast.error(toUserMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handlePostReply = async (parent) => {
    const text = replyText.trim()
    if (!text) return
    setReplySubmitting(true)
    try {
      await db.activities.create({
        related_type: 'deal',
        related_id: dealId,
        type: 'note',
        title: text,
        due_date: null,
        assigned_rep: null,
        outcome_notes: null,
        created_by: currentUserEmail,
        parent_id: parent.id,
      })
      setReplyText('')
      setReplyingTo(null)
      queryClient.invalidateQueries({ queryKey })
    } catch (err) {
      toast.error(toUserMessage(err))
    } finally {
      setReplySubmitting(false)
    }
  }

  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] flex flex-col overflow-hidden w-full" style={{ minHeight: '420px', maxHeight: '75vh' }}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#e6e9ef] dark:border-[#212a38] flex-shrink-0 flex items-center gap-2">
        <svg className="w-4 h-4 text-indigo-500 dark:text-[#a5b4fc]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        <span className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{t('pipeline.commentsPanel')}</span>
        {comments.length > 0 && (
          <span className="ml-auto text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-[#a5b4fc] px-1.5 py-0.5 rounded-full font-medium">
            {comments.length}
          </span>
        )}
      </div>

      {/* Comments feed */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-5 min-h-0">
        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : comments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
            <svg className="w-8 h-8 text-gray-300 dark:text-[#212a38]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p className="text-sm text-gray-400 dark:text-[#a4acb7]">{t('pipeline.noComments')}</p>
          </div>
        ) : (
          comments.map((a) => {
            const replies = repliesOf(a.id)
            return (
              <div key={a.id}>
                <div className="flex items-start gap-2.5">
                  {/* Avatar */}
                  <div className={`w-7 h-7 rounded-full ${avatarColor(a.created_by)} flex items-center justify-center text-white text-xs font-bold flex-shrink-0 mt-0.5`}>
                    {initials(a.created_by)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-gray-900 dark:text-[#e8ebf0] truncate max-w-[120px]">{a.created_by}</span>
                      <span className="text-[11px] text-gray-400 dark:text-[#a4acb7] whitespace-nowrap">{fmtTime(a.created_at)}</span>
                    </div>

                    {/* Comment bubble */}
                    <div className="mt-1 px-3 py-2 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl rounded-tl-sm border border-[#e6e9ef] dark:border-[#1a2230]">
                      <p className="text-sm text-gray-800 dark:text-[#e8ebf0] whitespace-pre-wrap break-words leading-relaxed">{a.title}</p>
                    </div>

                    {/* Attachments */}
                    {Array.isArray(a.attachments) && a.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {a.attachments.map((f) => (
                          <a key={f.path} href={f.url} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-lg text-xs text-indigo-600 dark:text-[#a5b4fc] hover:underline border border-[#e6e9ef] dark:border-[#212a38]">
                            📎 {f.name}
                          </a>
                        ))}
                      </div>
                    )}

                    {/* Reply button */}
                    {canEdit && (
                      <button
                        onClick={() => { setReplyingTo(replyingTo === a.id ? null : a.id); setReplyText('') }}
                        className="text-[11px] text-indigo-500 dark:text-[#a5b4fc] hover:underline mt-1 ml-1"
                      >
                        {t('activityChatter.reply')}
                      </button>
                    )}

                    {/* Replies */}
                    {replies.length > 0 && (
                      <div className="mt-2 space-y-2 border-l-2 border-[#e6e9ef] dark:border-[#212a38] pl-3">
                        {replies.map((r) => (
                          <div key={r.id} className="flex items-start gap-2">
                            <div className={`w-5 h-5 rounded-full ${avatarColor(r.created_by)} flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0 mt-0.5`}>
                              {initials(r.created_by)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline gap-1.5 flex-wrap">
                                <span className="text-[11px] font-semibold text-gray-900 dark:text-[#e8ebf0] truncate max-w-[100px]">{r.created_by}</span>
                                <span className="text-[11px] text-gray-400 dark:text-[#a4acb7]">{fmtTime(r.created_at)}</span>
                              </div>
                              <div className="mt-0.5 px-2.5 py-1.5 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl rounded-tl-sm border border-[#e6e9ef] dark:border-[#1a2230]">
                                <p className="text-xs text-gray-800 dark:text-[#e8ebf0] whitespace-pre-wrap break-words">{r.title}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Reply input */}
                    {replyingTo === a.id && (
                      <div className="flex items-center gap-2 mt-2">
                        <input
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          placeholder={t('activityChatter.replyPlaceholder')}
                          autoFocus
                          className="flex-1 text-sm px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg dark:bg-[#0f1520] dark:text-[#e8ebf0] placeholder-gray-400 dark:placeholder-[#a4acb7] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePostReply(a) }
                            if (e.key === 'Escape') { setReplyingTo(null); setReplyText('') }
                          }}
                        />
                        <Button size="sm" onClick={() => handlePostReply(a)} loading={replySubmitting} disabled={!replyText.trim()}>
                          {t('activityChatter.reply')}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Composer */}
      {canEdit && (
        <div className="flex-shrink-0 border-t border-[#e6e9ef] dark:border-[#212a38] px-4 py-3 space-y-2">
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {files.map((f) => (
                <span key={f.path} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#f8f9fb] dark:bg-[#0f1520] rounded text-xs text-gray-700 dark:text-[#e8ebf0] border border-[#e6e9ef] dark:border-[#212a38]">
                  📎 {f.name}
                  <button onClick={() => removeFile(f.path)} className="text-gray-400 hover:text-red-500 leading-none">×</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value.slice(0, NOTE_MAX))}
            placeholder={t('pipeline.commentPlaceholder')}
            rows={2}
            className="w-full px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-xl dark:bg-[#0f1520] dark:text-[#e8ebf0] placeholder-gray-400 dark:placeholder-[#a4acb7] focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
            onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) handlePost() }}
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="text-xs text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 dark:hover:text-[#a5b4fc] flex items-center gap-1 transition-colors"
              >
                {uploading ? <Spinner size="sm" /> : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                )}
                {t('activityChatter.attach')}
              </button>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleSelectFiles} />
              <span className="text-xs text-gray-400 dark:text-[#a4acb7]">{noteText.length}/{NOTE_MAX}</span>
            </div>
            <Button size="sm" onClick={handlePost} loading={submitting} disabled={!noteText.trim() && files.length === 0}>
              {t('activityChatter.postComment')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
