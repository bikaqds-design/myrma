import { supabase } from '../client.js'

// In-app notifications (db.notifications) — distinct from the email notifications module (src/api/email.js).
export const notifications = {
  async create({ type, title, message, entityType, entityId, entityRef, createdBy, targetRoles = [], targetEmails = [] }) {
    try {
      const { data, error } = await supabase.from('notifications').insert([{
        type, title, message,
        entity_type: entityType || null,
        entity_id: entityId || null,
        entity_ref: entityRef || null,
        created_by: createdBy || null,
        created_date: new Date().toISOString(),
        target_roles: targetRoles,
        target_emails: targetEmails,
        read_by: []
      }]).select()
      if (error) { if (error.code === '42P01') return null; return null }
      return data?.[0]
    } catch { return null }
  },

  async listForUser(email, role) {
    try {
      // RLS policy user_read_targeted already filters by target_roles/target_emails server-side.
      // No client-side filter needed — what comes back is exactly what this user should see (H-5 fix).
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .order('created_date', { ascending: false })
        .limit(50)
      if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
      return { missing: false, data: data || [] }
    } catch { return { missing: true, data: [] } }
  },

  async markRead(id, email) {
    try {
      // Reuse mark_notifications_read RPC — single atomic UPDATE, no read-then-write (H-5 fix)
      await supabase.rpc('mark_notifications_read', { p_email: email, p_ids: [id] })
    } catch {}
  },

  async markAllRead(email, role) {
    try {
      // Fetch unread IDs only — single SELECT, filter client-side for role/email targeting
      const { data } = await supabase
        .from('notifications')
        .select('id, read_by, target_roles, target_emails')
        .order('created_date', { ascending: false })
        .limit(50)
      const ids = (data || [])
        .filter(n =>
          (n.target_roles?.includes(role) || n.target_emails?.includes(email)) &&
          !n.read_by?.includes(email)
        )
        .map(n => n.id)
      if (!ids.length) return
      // Single batched UPDATE via RPC — replaces N individual updates (H-2 fix)
      await supabase.rpc('mark_notifications_read', { p_email: email, p_ids: ids })
    } catch {}
  }
}
