import { supabase } from '../client.js'
import { STORAGE_KEY } from '../../lib/constants.js'
import { captureException } from '../../lib/sentry.js'
import { safeStorage } from '../../lib/safeStorage.js'

// ─── Audit log helpers (H-9) ─────────────────────────────────────────────────
// Resilient fire-and-log: retry once, then queue to localStorage.
// Queued entries are flushed on next successful write or app start.
const AUDIT_QUEUE_KEY = STORAGE_KEY.AUDIT_QUEUE
const AUDIT_QUEUE_MAX = 50

export function _auditEnqueue(entry) {
  const q = safeStorage.get(AUDIT_QUEUE_KEY, [])
  q.push(entry)
  if (q.length > AUDIT_QUEUE_MAX) q.splice(0, q.length - AUDIT_QUEUE_MAX)
  safeStorage.set(AUDIT_QUEUE_KEY, q)
}

export async function auditFlushQueue() {
  try {
    const q = safeStorage.get(AUDIT_QUEUE_KEY, [])
    if (!q.length) return
    const { error } = await supabase.from('user_activity_log').insert(q)
    if (!error) safeStorage.remove(AUDIT_QUEUE_KEY)
  } catch {}
}

export async function auditInsert(entry) {
  const doInsert = () => supabase.from('user_activity_log').insert([entry])
  const { error } = await doInsert()
  if (!error) {
    auditFlushQueue().catch(() => {})
    return
  }
  // First attempt failed — retry once after 600ms
  await new Promise((r) => setTimeout(r, 600))
  const { error: retryErr } = await doInsert()
  if (!retryErr) {
    auditFlushQueue().catch(() => {})
    return
  }
  // Both failed — queue for next session
  captureException(new Error(`auditLog write failed: ${retryErr?.message}`), {
    action_type: entry.action_type,
  })
  _auditEnqueue(entry)
}
