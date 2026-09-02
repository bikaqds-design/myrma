import React, { useRef, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { listSessions, saveSession, deleteSession } from '../lib/chatSessions'
import { askKnowledgeCenter, CHAT_NOT_CONFIGURED, CHAT_UNAVAILABLE } from '../api/kbChat'

/**
 * Asking the Knowledge Center a question.
 *
 * ── The layout ───────────────────────────────────────────────────────────────
 *
 * A conversation list on the left, the conversation on the right — the shape
 * people already know from every chat tool they use. An earlier version hid the
 * history behind a toggle that only appeared once a conversation had been
 * saved, which meant the feature was invisible to anyone who had not already
 * used it. A permanent rail is discoverable by existing; a button that appears
 * only after you no longer need to find it is not.
 *
 * On a narrow screen the rail slides over instead, because two panes in 375
 * pixels helps nobody.
 *
 * ── Why the sources are shown above the answer ───────────────────────────────
 *
 * The model can only answer from passages it was given, and it is told to say
 * when they do not contain the answer. But no instruction makes that reliable,
 * so the documents it read appear before a word of the answer arrives. Someone
 * who can see it is reading the right datasheet knows how much to trust what
 * follows; someone who sees it reading the wrong one stops reading immediately.
 */

/**
 * Collapse passages from the same document into one chip.
 *
 * Every passage number has to survive. An earlier version kept only the lowest,
 * so an answer citing [4] pointed at a chip labelled [1] and the reader had
 * nothing to check it against — worse than the repeated chips it replaced,
 * because it looked correct.
 */
function dedupeSources(sources) {
  const byDoc = new Map()
  for (const s of sources) {
    const existing = byDoc.get(s.id)
    if (!existing) byDoc.set(s.id, { ...s, nums: [s.n] })
    else existing.nums.push(s.n)
  }
  return [...byDoc.values()]
    .map((d) => ({ ...d, nums: [...d.nums].sort((a, b) => a - b) }))
    .sort((a, b) => a.nums[0] - b.nums[0])
}

/** The passage numbers a document covers, as "1–5" or "1, 3, 7". */
function formatCitations(nums) {
  if (nums.length === 1) return String(nums[0])
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)
  return contiguous ? `${nums[0]}–${nums[nums.length - 1]}` : nums.join(', ')
}

export default function KnowledgeChat() {
  const { t } = useTranslation()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [sessions, setSessions] = useState(() => listSessions())
  const [activeId, setActiveId] = useState(null)
  const [railOpen, setRailOpen] = useState(false)
  // Identifies the conversation being written to, so follow-ups update one
  // entry instead of piling up five near-identical ones.
  const sessionIdRef = useRef(null)
  const abortRef = useRef(null)
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

  useEffect(() => () => abortRef.current?.abort(), [])

  const send = async (e) => {
    e?.preventDefault()
    const question = input.trim()
    if (!question || busy) return

    setError(null)
    setInput('')
    setBusy(true)
    setRailOpen(false)
    if (!sessionIdRef.current) {
      sessionIdRef.current =
        globalThis.crypto?.randomUUID?.() ??
        `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
      setActiveId(sessionIdRef.current)
    }

    // The question and an empty answer go in together, so the answer has
    // somewhere to stream into and the conversation never jumps.
    const asked = { role: 'user', content: question }
    setMessages((m) => [...m, asked, { role: 'assistant', content: '', sources: [] }])

    const controller = new AbortController()
    abortRef.current = controller

    const updateLast = (fn) =>
      setMessages((m) => {
        const next = [...m]
        next[next.length - 1] = fn(next[next.length - 1])
        return next
      })

    try {
      await askKnowledgeCenter({
        question,
        // Only prior turns, and only the text — the sources of an earlier
        // answer are not context for the next one.
        history: messages.map((m) => ({ role: m.role, content: m.content })),
        signal: controller.signal,
        onSources: (sources) => updateLast((last) => ({ ...last, sources })),
        onDelta: (text) => updateLast((last) => ({ ...last, content: last.content + text })),
      })
    } catch (err) {
      if (err.name === 'AbortError') {
        updateLast((last) => ({ ...last, stopped: true }))
      } else {
        setError({ code: err.code, message: err.message })
        // Remove the empty assistant turn rather than leave a blank bubble
        // under the question.
        setMessages((m) => m.slice(0, -1))
      }
    } finally {
      setBusy(false)
      abortRef.current = null
      // Saved after the turn settles rather than on every fragment: writing to
      // localStorage on each streamed token would be dozens of synchronous
      // writes per answer, on the main thread.
      setMessages((current) => {
        setSessions(saveSession(sessionIdRef.current, current, new Date().toISOString()))
        return current
      })
    }
  }

  const stop = () => abortRef.current?.abort()

  const newConversation = () => {
    abortRef.current?.abort()
    setMessages([])
    setError(null)
    sessionIdRef.current = null
    setActiveId(null)
    setRailOpen(false)
  }

  const openSession = (session) => {
    abortRef.current?.abort()
    // Reopening keeps the same id, so continuing an old conversation updates
    // that entry rather than creating a second copy of it.
    sessionIdRef.current = session.id
    setActiveId(session.id)
    setMessages(session.messages)
    setError(null)
    setRailOpen(false)
  }

  const removeSession = (id, e) => {
    e.stopPropagation()
    e.preventDefault()
    setSessions(deleteSession(id))
    if (sessionIdRef.current === id) newConversation()
  }

  const rail = (
    <div className="flex flex-col h-full">
      <div className="p-3">
        <button
          type="button"
          onClick={newConversation}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-[#e6e9ef] dark:border-[#212a38] text-sm font-medium text-gray-700 dark:text-[#e8ebf0] hover:border-indigo-400 hover:text-indigo-600"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t('knowledgeChat.newChat')}
        </button>
      </div>

      <div className="px-4 pb-1">
        <p className="text-[10px] uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]">
          {t('knowledgeChat.historyTitle')}
        </p>
      </div>

      <ul className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {sessions.length === 0 && (
          <li className="px-3 py-2 text-xs text-gray-400 dark:text-[#6c7280]">
            {t('knowledgeChat.historyEmpty')}
          </li>
        )}
        {sessions.map((session) => (
          <li key={session.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => openSession(session)}
              onKeyDown={(e) => e.key === 'Enter' && openSession(session)}
              className={`group flex items-center gap-1.5 px-3 py-2 rounded-lg cursor-pointer ${
                activeId === session.id
                  ? 'bg-indigo-50 dark:bg-indigo-900/20'
                  : 'hover:bg-gray-100 dark:hover:bg-[#1a2230]'
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm text-gray-700 dark:text-[#e8ebf0]">
                  {session.title || t('knowledgeChat.untitled')}
                </p>
                {session.at && (
                  <p className="text-[11px] text-gray-400 dark:text-[#6c7280]">
                    {new Date(session.at).toLocaleDateString()}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={(e) => removeSession(session.id, e)}
                aria-label={`${t('common.delete')} ${session.title}`}
                className="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 text-gray-400 hover:text-red-600 px-1"
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>

      {/* The one thing about this feature that could surprise someone, said
          once and quietly rather than as a banner. */}
      <p className="px-4 py-2 text-[11px] text-gray-400 dark:text-[#6c7280] border-t border-[#e6e9ef] dark:border-[#212a38]">
        {t('knowledgeChat.historyLocal')}
      </p>
    </div>
  )

  return (
    <div className="relative flex h-[calc(100vh-300px)] min-h-[460px] bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-hidden">
      {/* Permanent from `sm` up. */}
      <aside className="hidden sm:flex sm:flex-col w-60 shrink-0 border-e border-[#e6e9ef] dark:border-[#212a38] bg-gray-50 dark:bg-[#0f1520]">
        {rail}
      </aside>

      {/* On a narrow screen the same rail slides over the conversation. */}
      {railOpen && (
        <>
          <div
            className="sm:hidden absolute inset-0 bg-black/40 z-10"
            onClick={() => setRailOpen(false)}
          />
          <aside className="sm:hidden absolute inset-y-0 start-0 w-64 z-20 bg-gray-50 dark:bg-[#0f1520] border-e border-[#e6e9ef] dark:border-[#212a38]">
            {rail}
          </aside>
        </>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-[#e6e9ef] dark:border-[#212a38]">
          <button
            type="button"
            onClick={() => setRailOpen(true)}
            aria-label={t('knowledgeChat.historyTitle')}
            className="sm:hidden text-gray-500 dark:text-[#9aa4b2]"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">
              {t('knowledgeChat.title')}
            </h2>
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2] truncate">
              {t('knowledgeChat.subtitle')}
            </p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {messages.length === 0 && !error && (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <p className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0]">
                {t('knowledgeChat.emptyTitle')}
              </p>
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1 max-w-md">
                {t('knowledgeChat.emptyHint')}
              </p>
              <div className="flex flex-wrap gap-2 justify-center mt-4">
                {[
                  t('knowledgeChat.example1'),
                  t('knowledgeChat.example2'),
                  t('knowledgeChat.example3'),
                ].map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setInput(ex)}
                    className="px-3 py-1.5 text-xs rounded-full border border-[#e6e9ef] dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:border-indigo-400"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-indigo-600 text-white px-4 py-2.5 text-sm whitespace-pre-wrap">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] space-y-2">
                  {m.sources?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {dedupeSources(m.sources).map((s) => (
                        <span
                          key={s.id}
                          title={s.product || undefined}
                          className="px-2 py-0.5 text-[11px] rounded-full bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]"
                        >
                          [{formatCitations(s.nums)}] {s.title}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="rounded-2xl rounded-bl-sm bg-gray-100 dark:bg-[#1a2230] text-gray-900 dark:text-[#e8ebf0] px-4 py-2.5 text-sm whitespace-pre-wrap">
                    {m.content || (
                      <span className="text-gray-400 dark:text-[#6c7280]">
                        {t('knowledgeChat.thinking')}
                      </span>
                    )}
                    {m.stopped && (
                      <span className="block text-xs text-gray-500 mt-1">
                        {t('knowledgeChat.stopped')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          )}

          {error && (
            <div className="border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 rounded-xl p-4">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-300">
                {/* Three genuinely different situations with three different
                    fixes, none of which is "try again". */}
                {error.code === CHAT_NOT_CONFIGURED
                  ? t('knowledgeChat.errorNotConfigured')
                  : error.code === CHAT_UNAVAILABLE
                    ? t('knowledgeChat.errorUnavailable')
                    : t('knowledgeChat.errorProvider')}
              </p>
              {error.message && (
                <p className="text-xs text-amber-800 dark:text-amber-300/90 mt-1 font-mono break-words">
                  {error.message}
                </p>
              )}
            </div>
          )}

          <div ref={endRef} />
        </div>

        <form onSubmit={send} className="border-t border-[#e6e9ef] dark:border-[#212a38] p-3 flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('knowledgeChat.placeholder')}
            aria-label={t('knowledgeChat.placeholder')}
            disabled={busy}
            className="flex-1 px-4 py-2.5 border border-[#e6e9ef] dark:border-[#212a38] dark:bg-[#0f1520] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 disabled:opacity-60"
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              className="px-4 py-2.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-gray-600 dark:text-[#9aa4b2]"
            >
              {t('knowledgeChat.stop')}
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="px-5 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {t('knowledgeChat.send')}
            </button>
          )}
        </form>

        <p className="px-4 pb-3 text-[11px] text-gray-400 dark:text-[#6c7280]">
          {t('knowledgeChat.disclaimer')}
        </p>
      </div>
    </div>
  )
}
