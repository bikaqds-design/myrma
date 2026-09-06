import { supabase } from '../client.js'
import { captureException } from '../../lib/sentry.js'
import type { TableResult } from './types.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface NotificationRow {
  id: string
  type: string
  title: string
  message: string
  entity_type: string | null
  entity_id: string | null
  entity_ref: string | null
  created_by: string | null
  created_date: string
  target_roles: string[]
  target_emails: string[]
  read_by: string[]
}

interface CreateNotificationParams {
  type: string
  title: string
  message: string
  entityType?: string | null
  entityId?: string | null
  entityRef?: string | null
  createdBy?: string | null
  targetRoles?: string[]
  targetEmails?: string[]
}

// In-app notifications (db.notifications) — distinct from the email notifications module (src/api/email.js).
export const notifications = {
  async create({
    type,
    title,
    message,
    entityType,
    entityId,
    entityRef,
    createdBy,
    targetRoles = [],
    targetEmails = [],
  }: CreateNotificationParams): Promise<void> {
    try {
      const { error } = await supabase
        .from('notifications')
        .insert([
          {
            type,
            title,
            message,
            entity_type: entityType || null,
            entity_id: entityId || null,
            entity_ref: entityRef || null,
            created_by: createdBy || null,
            created_date: new Date().toISOString(),
            target_roles: targetRoles,
            target_emails: targetEmails,
            read_by: [],
          },
        ])
      // Deliberately NO .select() here (BUG-079). PostgREST compiles .select()
      // into INSERT ... RETURNING, and RETURNING is evaluated against the
      // *SELECT* policy — `user_read_targeted`, which only exposes a
      // notification aimed at your own role or address. So a technician
      // creating an alert for ['admin','super_admin'] had the RETURNING clause
      // refused with 42501, which aborts the whole statement: the row was never
      // written and this function silently returned null. Bulk customer and
      // product alerts, and ticket status changes, therefore produced no
      // notification at all whenever a non-admin performed them.
      //
      // Widening user_read_targeted would be the wrong fix — not being able to
      // read other roles' notifications is correct. No caller uses the returned
      // row (every call site is `db.notifications.create({...}).catch(...)`),
      // so dropping the read-back costs nothing.
      if (error && error.code !== '42P01') {
        captureException(error, { context: 'notifications.create', type })
      }
    } catch {
      /* notifications are best-effort and must never break the calling flow */
    }
  },

  async listForUser(
    _email: string,
    _role: string
  ): Promise<TableResult<NotificationRow[]>> {
    try {
      // RLS policy user_read_targeted already filters by target_roles/target_emails server-side.
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .order('created_date', { ascending: false })
        .limit(50)
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },

  async markRead(id: string, email: string): Promise<void> {
    try {
      await supabase.rpc('mark_notifications_read', { p_email: email, p_ids: [id] })
    } catch {}
  },

  async markAllRead(email: string, role: string): Promise<void> {
    try {
      const { data } = await supabase
        .from('notifications')
        .select('id, read_by, target_roles, target_emails')
        .order('created_date', { ascending: false })
        .limit(50)
      const ids = (data || [])
        .filter(
          (n) =>
            (n.target_roles?.includes(role) || n.target_emails?.includes(email)) &&
            !n.read_by?.includes(email)
        )
        .map((n) => n.id as string)
      if (!ids.length) return
      // Single batched UPDATE via RPC — replaces N individual updates (H-2 fix)
      await supabase.rpc('mark_notifications_read', { p_email: email, p_ids: ids })
    } catch {}
  },
}
