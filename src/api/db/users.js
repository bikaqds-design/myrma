import { supabase } from '../client.js'
import { auditInsert } from './audit.js'

export const userRoles = {
  async getUserRole(email) {
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select('*')
        .eq('user_email', email)
        .single()
      if (error) {
        if (error.code === 'PGRST116') return null
        throw error
      }
      return data
    } catch {
      return null
    }
  },
  async listAllRoles() {
    const { data, error } = await supabase
      .from('user_roles')
      .select('*')
      .order('created_date', { ascending: false })
    if (error) throw error
    return data || []
  },
  async createRole(email, role) {
    const { data, error } = await supabase
      .from('user_roles')
      .insert([{ user_email: email, role }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async updateRole(email, role) {
    // Clear any custom permission overrides so the new role's defaults apply cleanly.
    // Stale overrides from a previous role would otherwise win at resolve time and
    // silently restrict the user (PERM-2).
    const { data, error } = await supabase
      .from('user_roles')
      .update({ role, permissions: null })
      .eq('user_email', email)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async updateUserStatus(email, status, reason, suspendedBy) {
    const updates = { status }
    if (status === 'suspended' || status === 'locked') {
      updates.suspended_reason = reason
      updates.suspended_by = suspendedBy
      updates.suspended_date = new Date().toISOString()
    } else if (status === 'active') {
      updates.suspended_reason = null
      updates.suspended_by = null
      updates.suspended_date = null
    }
    const { data, error } = await supabase
      .from('user_roles')
      .update(updates)
      .eq('user_email', email)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async updateUserPermissions(email, permissions) {
    const { data, error } = await supabase
      .from('user_roles')
      .update({ permissions })
      .eq('user_email', email)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async updateUserNotes(email, notes) {
    const { data, error } = await supabase
      .from('user_roles')
      .update({ notes })
      .eq('user_email', email)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async deleteUser(email) {
    const { error } = await supabase.from('user_roles').delete().eq('user_email', email)
    if (error) throw error
  },
  async getCustomRoles() {
    try {
      const { data, error } = await supabase
        .from('custom_roles')
        .select('*')
        .order('created_date', { ascending: false })
      if (error) throw error
      return data || []
    } catch {
      return []
    }
  },
  async createCustomRole(roleName, roleDescription, permissions, createdBy) {
    const { data, error } = await supabase
      .from('custom_roles')
      .insert([
        {
          role_name: roleName,
          role_description: roleDescription,
          permissions,
          created_by: createdBy,
        },
      ])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async deleteCustomRole(roleId) {
    const { error } = await supabase.from('custom_roles').delete().eq('id', roleId)
    if (error) throw error
  },
}

export const userActivity = {
  async list(email) {
    try {
      const { data, error } = await supabase
        .from('user_activity_log')
        .select('*')
        .eq('user_email', email)
        .order('created_date', { ascending: false })
        .limit(50)
      if (error) throw error
      return data || []
    } catch {
      return []
    }
  },
  async create(email, actionType, actionDetails) {
    // H-9: use resilient auditInsert (retry + queue) instead of bare insert
    await auditInsert({
      user_email: email,
      action_type: actionType,
      action_details: actionDetails,
      created_date: new Date().toISOString(),
    })
  },
}

export const userPreferences = {
  // Schema: user_preferences(id, user_email text PK, prefs jsonb, updated_at timestamptz)
  // Missing table → returns { missing: true } so the app falls back to localStorage.
  async get(email) {
    try {
      const { data, error } = await supabase
        .from('user_preferences')
        .select('prefs')
        .eq('user_email', email)
        .maybeSingle()
      if (error?.code === '42P01') return { missing: true }
      if (error) return { missing: false, prefs: null }
      return { missing: false, prefs: data?.prefs || null }
    } catch {
      return { missing: true }
    }
  },
  async set(email, prefs) {
    try {
      const { error } = await supabase
        .from('user_preferences')
        .upsert(
          { user_email: email, prefs, updated_at: new Date().toISOString() },
          { onConflict: 'user_email' }
        )
      if (error?.code === '42P01') return { missing: true }
      if (error) throw error
      return { missing: false }
    } catch (e) {
      if (e?.code === '42P01') return { missing: true }
      return { missing: false, error: e }
    }
  },
}
