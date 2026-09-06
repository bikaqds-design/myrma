import { supabase } from '../client.js'
import { STORAGE_KEY } from '../../lib/constants.js'
import { captureException } from '../../lib/sentry.js'
import { safeStorage } from '../../lib/safeStorage.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface AuditLogRow {
  id: string
  user_email: string
  action_type: string
  action_details: string | null
  created_date: string
}

interface AuditEntry {
  user_email: string
  action_type: string
  action_details: string | null
  created_date: string
}

// ─── Audit log helpers (H-9) ─────────────────────────────────────────────────
// Resilient fire-and-log: retry once, then queue to localStorage.
// Queued entries are flushed on next successful write or app start.
const AUDIT_QUEUE_KEY = STORAGE_KEY.AUDIT_QUEUE
const AUDIT_QUEUE_MAX = 50

export function _auditEnqueue(entry: AuditEntry): void {
  const q = safeStorage.get<AuditEntry[]>(AUDIT_QUEUE_KEY, [])
  q.push(entry)
  if (q.length > AUDIT_QUEUE_MAX) q.splice(0, q.length - AUDIT_QUEUE_MAX)
  safeStorage.set(AUDIT_QUEUE_KEY, q)
}

export async function auditFlushQueue(): Promise<void> {
  try {
    const q = safeStorage.get<AuditEntry[]>(AUDIT_QUEUE_KEY, [])
    if (!q.length) return

    // The queue lives in localStorage, which is per-browser rather than
    // per-user, so it can hold entries enqueued by whoever signed in last.
    // The database now stamps user_email from the JWT (migration 20260821,
    // BUG-019), which means replaying someone else's entry would file it under
    // the current user's name. Drop foreign entries instead of misattributing
    // them — a lost log line is better than a false one.
    const { data } = await supabase.auth.getUser()
    const me = data?.user?.email?.toLowerCase()
    if (!me) return

    const mine = q.filter((e) => e.user_email?.toLowerCase() === me)
    if (!mine.length) {
      safeStorage.remove(AUDIT_QUEUE_KEY)
      return
    }
    const { error } = await supabase.from('user_activity_log').insert(mine)
    if (!error) safeStorage.remove(AUDIT_QUEUE_KEY)
  } catch {}
}

export async function auditInsert(entry: AuditEntry): Promise<void> {
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
