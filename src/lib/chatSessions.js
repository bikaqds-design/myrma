/**
 * Recent Knowledge Center conversations.
 *
 * ── Why the browser and not the database ────────────────────────────────────
 *
 * Kept in localStorage, deliberately. Storing conversations server-side would
 * mean a table, its policies, a row written on every message and a query on
 * every page load — real load, for a convenience. Here it costs nothing: no
 * request, no row, no migration.
 *
 * The trade is honest and worth stating: history lives in ONE browser. Clear
 * the browser data or move to another machine and it is gone. That is the right
 * bargain for "let me get back to what I asked this morning" and the wrong one
 * for a permanent record — if this ever needs to be shared between people or
 * survive a reinstall, it belongs in the database and this module should be
 * replaced rather than extended.
 *
 * ── Why five ────────────────────────────────────────────────────────────────
 *
 * Enough to cover a working day of dipping in and out; few enough that the list
 * stays scannable and the stored payload stays small. localStorage is a shared,
 * synchronous, size-limited space — putting an unbounded conversation log in it
 * eventually breaks something unrelated.
 */

const KEY = 'myrma.kb.sessions.v1'
export const MAX_SESSIONS = 5

/** Longest message we keep. A pasted wall of text is not worth the quota. */
const MAX_CONTENT = 4000

/**
 * Every read and write is guarded.
 *
 * localStorage throws rather than returning null in a private window, when the
 * quota is full, and when site data is blocked. An unguarded read would take
 * the whole page down over a convenience feature.
 */
function read() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function write(sessions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions))
    return true
  } catch {
    // Most likely the quota. Dropping the oldest and retrying once is worth it;
    // failing silently after that is better than an error over saved history.
    try {
      localStorage.setItem(KEY, JSON.stringify(sessions.slice(0, 2)))
    } catch {
      /* give up quietly */
    }
    return false
  }
}

export function listSessions() {
  return read()
}

/** The first question asked, which is what a person recognises a session by. */
export function sessionTitle(messages) {
  const firstUser = messages.find((m) => m.role === 'user')
  const text = (firstUser?.content ?? '').trim()
  if (!text) return ''
  return text.length > 70 ? `${text.slice(0, 70)}…` : text
}

/**
 * Save or update a conversation.
 *
 * Updates in place while a conversation continues, so asking five follow-ups
 * produces one entry rather than five near-identical ones — which is what makes
 * a five-item list useful rather than a list of one conversation.
 */
export function saveSession(id, messages, at) {
  if (!Array.isArray(messages) || messages.length === 0) return listSessions()

  const trimmed = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: String(m.content ?? '').slice(0, MAX_CONTENT),
      sources: Array.isArray(m.sources) ? m.sources : undefined,
    }))

  // A question with no answer yet is not worth an entry; it would appear in the
  // list the instant someone pressed Ask and before anything came back.
  if (!trimmed.some((m) => m.role === 'assistant' && m.content)) return listSessions()

  const sessions = read().filter((s) => s.id !== id)
  sessions.unshift({
    id,
    title: sessionTitle(trimmed),
    messages: trimmed,
    // Passed in rather than read from the clock here, so the caller owns time
    // and this stays a pure function of its inputs.
    at: at ?? null,
  })

  const capped = sessions.slice(0, MAX_SESSIONS)
  write(capped)
  return capped
}

export function deleteSession(id) {
  const remaining = read().filter((s) => s.id !== id)
  write(remaining)
  return remaining
}

export function clearSessions() {
  write([])
  return []
}
