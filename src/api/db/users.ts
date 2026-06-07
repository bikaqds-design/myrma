import { supabase } from '../client.js'
import { auditInsert } from './audit.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface UserRoleRow {
  id: string
  user_email: string
  role: string
  status: string | null
  permissions: Record<string, Record<string, boolean>> | null
  notes: string | null
  suspended_reason: string | null
  suspended_by: string | null
  suspended_date: string | null
  created_date: string
}

export interface UserActivityRow {
  id: string
  user_email: string
  action_type: string
  action_details: string | null
  created_date: string
}

export interface UserPreferencesRow {
  id: string
  user_email: string
  prefs: Record<string, unknown> | null
  updated_at: string
}

// ── User Roles ────────────────────────────────────────────────────────────────

export const userRoles = {
  async getUserRole(email: string): Promise<UserRoleRow | null> {
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
  async listAllRoles(): Promise<UserRoleRow[]> {
    const { data, error } = await supabase
      .from('user_roles')
      .select('*')
      .order('created_date', { ascending: false })
    if (error) throw error
    return data || []
  },
  async createRole(email: string, role: string): Promise<UserRoleRow | undefined> {
    const { data, error } = await supabase
      .from('user_roles')
      .insert([{ user_email: email, role }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async updateRole(email: string, role: string): Promise<UserRoleRow | undefined> {
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
  async updateUserStatus(
    email: string,
    status: string,
    reason?: string,
    suspendedBy?: string
  ): Promise<UserRoleRow | undefined> {
    const updates: Partial<UserRoleRow> = { status }
    if (status === 'suspended' || status === 'locked') {
      updates.suspended_reason = reason ?? null
      updates.suspended_by = suspendedBy ?? null
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
  async updateUserPermissions(
    email: string,
    permissions: Record<string, Record<string, boolean>> | null
  ): Promise<UserRoleRow | undefined> {
    const { data, error } = await supabase
      .from('user_roles')
      .update({ permissions })
      .eq('user_email', email)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async updateUserNotes(email: string, notes: string | null): Promise<UserRoleRow | undefined> {
    const { data, error } = await supabase
      .from('user_roles')
      .update({ notes })
      .eq('user_email', email)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async deleteUser(email: string): Promise<void> {
    const { error } = await supabase.from('user_roles').delete().eq('user_email', email)
    if (error) throw error
  },
  async getCustomRoles(): Promise<unknown[]> {
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
  async createCustomRole(
    roleName: string,
    roleDescription: string,
    permissions: Record<string, Record<string, boolean>>,
    createdBy: string
  ): Promise<unknown> {
    const { data, error } = await supabase
      .from('custom_roles')
      .insert([{ role_name: roleName, role_description: roleDescription, permissions, created_by: createdBy }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async deleteCustomRole(roleId: string): Promise<void> {
    const { error } = await supabase.from('custom_roles').delete().eq('id', roleId)
    if (error) throw error
  },
}

// ── User Activity ─────────────────────────────────────────────────────────────

export const userActivity = {
  async list(email: string): Promise<UserActivityRow[]> {
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
  async create(email: string, actionType: string, actionDetails: string): Promise<void> {
    // H-9: use resilient auditInsert (retry + queue) instead of bare insert
    await auditInsert({
      user_email: email,
      action_type: actionType,
      action_details: actionDetails,
      created_date: new Date().toISOString(),
    })
  },
}

// ── User Preferences ──────────────────────────────────────────────────────────

export const userPreferences = {
  // Schema: user_preferences(id, user_email text PK, prefs jsonb, updated_at timestamptz)
  // Missing table → returns { missing: true } so the app falls back to localStorage.
  async get(email: string): Promise<{ missing: boolean; prefs?: Record<string, unknown> | null }> {
    try {
      const { data, error } = await supabase
        .from('user_preferences')
        .select('prefs')
        .eq('user_email', email)
        .maybeSingle()
      if (error?.code === '42P01') return { missing: true }
      if (error) return { missing: false, prefs: null }
      return { missing: false, prefs: (data?.prefs as Record<string, unknown>) || null }
    } catch {
      return { missing: true }
    }
  },
  async set(
    email: string,
    prefs: Record<string, unknown>
  ): Promise<{ missing: boolean; error?: unknown }> {
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
      if ((e as { code?: string })?.code === '42P01') return { missing: true }
      return { missing: false, error: e }
    }
  },
}
