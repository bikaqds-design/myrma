import { supabase } from '../client.js'
import { STORAGE_KEY } from '../../lib/constants.js'

// ─── Audit log helpers (H-9) ─────────────────────────────────────────────────
// Resilient fire-and-log: retry once, then queue to localStorage.
// Queued entries are flushed on next successful write or app start.
const AUDIT_QUEUE_KEY = STORAGE_KEY.AUDIT_QUEUE
const AUDIT_QUEUE_MAX = 50

export function _auditEnqueue(entry) {
  try {
    const q = JSON.parse(localStorage.getItem(AUDIT_QUEUE_KEY) || '[]')
    q.push(entry)
    if (q.length > AUDIT_QUEUE_MAX) q.splice(0, q.length - AUDIT_QUEUE_MAX)
    localStorage.setItem(AUDIT_QUEUE_KEY, JSON.stringify(q))
  } catch {}
}

export async function auditFlushQueue() {
  try {
    const q = JSON.parse(localStorage.getItem(AUDIT_QUEUE_KEY) || '[]')
    if (!q.length) return
    const { error } = await supabase.from('user_activity_log').insert(q)
    if (!error) localStorage.removeItem(AUDIT_QUEUE_KEY)
  } catch {}
}

export async function auditInsert(entry) {
  const doInsert = () => supabase.from('user_activity_log').insert([entry])
  const { error } = await doInsert()
  if (!error) { auditFlushQueue().catch(() => {}); return }
  // First attempt failed — retry once after 600ms
  await new Promise(r => setTimeout(r, 600))
  const { error: retryErr } = await doInsert()
  if (!retryErr) { auditFlushQueue().catch(() => {}); return }
  // Both failed — queue for next session and surface to console
  console.error('[auditLog] Failed to write audit event (queued):', entry.action_type, retryErr?.message)
  _auditEnqueue(entry)
}
