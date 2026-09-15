import { supabase } from '../client.js'
import { assertUpdated, assertAffected } from './_assertUpdated.js'
import type { PrefsResult, SetPrefsResult } from './types.js'
import { fetchAllRows } from './_paging.js'
import { auditInsert } from './audit.js'
import { captureException } from '../../lib/sentry.js'

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
  /** When access ends. NULL means never. Enforced in RLS by 20260786. */
  access_expires_at: string | null
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
    const { data, error } = await supabase
      .from('user_roles')
      .select('*')
      .eq('user_email', email)
      .single()
    if (error) {
      if (error.code === 'PGRST116') return null // no row found
      throw error
    }
    return data
  },
  /**
   * Who exists and what role they hold — for assignee dropdowns.
   *
   * Use this anywhere a page needs a list of colleagues. listAllRoles() reads
   * the whole user_roles row, which carries permission maps, administrator
   * notes, suspension reasons and a legacy password_hash column; since 20260790
   * only an administrator can read those, and a non-admin calling
   * listAllRoles() gets back just their own row.
   *
   * The RPC is SECURITY DEFINER and returns three columns, so the narrow policy
   * on the table and the needs of the dropdowns stop being in conflict.
   */
  async directory(): Promise<{ user_email: string; role: string; status: string | null }[]> {
    const { data, error } = await supabase.rpc('rma_staff_directory')
    if (error) throw error
    return data || []
  },
  /** Admin surface: the complete row. Non-admins see only themselves. */
  async listAllRoles(): Promise<UserRoleRow[]> {
    // Every row — User Management lists them all. (BUG-066.)
    return fetchAllRows<UserRoleRow>((from, to) =>
      supabase
        .from('user_roles')
        .select('*')
        .order('created_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    )
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
    return assertUpdated(data, 'User')
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
    assertAffected(data, 'User')

    // Suspension has to end the sessions too, or it is only half a suspension.
    // (Audit finding BUG-049.) Writing the status left every device the user
    // was signed in on holding a valid refresh token: RLS stops them wherever a
    // policy consults rma_user_role(), but Edge Functions do their own checks,
    // so a suspended account kept working in the places that matter most.
    //
    // Best-effort on purpose. The status change has already committed and is
    // the part that must not be rolled back; if the revoke fails, the account
    // is still suspended and still restricted by RLS. Reporting the failure as
    // if the suspension failed would be worse than reporting it to Sentry,
    // because it would invite an admin to retry an action that already worked.
    if (status === 'suspended' || status === 'locked') {
      const { error: revokeError } = await supabase.rpc('rma_revoke_user_sessions_by_email', {
        p_email: email,
      })
      if (revokeError) {
        captureException(revokeError, { context: 'users/updateUserStatus/revokeSessions', email, status })
      }
    }

    return data?.[0]
  },
  /**
   * Set or clear the instant a user's access ends. Pass null to remove it.
   *
   * The User Management "Set Expiration" action called this method for as long
   * as it existed, but it was never written and `access_expires_at` was never
   * added — the action threw a TypeError every time. Column and enforcement
   * both arrived in 20260786; RLS honours it through rma_access_is_current(),
   * so nothing else has to check the date.
   */
  async setUserExpiration(email: string, expiresAt: string | null): Promise<UserRoleRow | undefined> {
    const { data, error } = await supabase
      .from('user_roles')
      .update({ access_expires_at: expiresAt })
      .eq('user_email', email)
      .select()
    if (error) throw error
    return assertUpdated(data, 'User')
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
    return assertUpdated(data, 'User')
  },
  async updateUserNotes(email: string, notes: string | null): Promise<UserRoleRow | undefined> {
    const { data, error } = await supabase
      .from('user_roles')
      .update({ notes })
      .eq('user_email', email)
      .select()
    if (error) throw error
    return assertUpdated(data, 'User')
  },
  async deleteUser(email: string): Promise<void> {
    const { data, error } = await supabase.from('user_roles').delete().eq('user_email', email).select('id')
    if (error) throw error
    assertAffected(data, 'User')
  },
  async getCustomRoles(): Promise<unknown[]> {
    try {
      return await fetchAllRows<unknown>((from, to) =>
        supabase
          .from('custom_roles')
          .select('*')
          .order('created_date', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to)
      )
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return [] // optional table not yet migrated
      throw error
    }
  },
  /**
   * baseRole is what row-level security treats holders of this role as. RLS
   * matches a fixed list of role names, so a custom name resolves to nothing on
   * its own; rma_user_role() maps it to base_role (migration 20260782). The
   * permission map only narrows what that base already allows.
   */
  async createCustomRole(
    roleName: string,
    roleDescription: string,
    permissions: Record<string, Record<string, boolean>>,
    createdBy: string,
    baseRole = 'viewer'
  ): Promise<unknown> {
    const { data, error } = await supabase
      .from('custom_roles')
      .insert([{ role_name: roleName, role_description: roleDescription, permissions, created_by: createdBy, base_role: baseRole }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  /**
   * A custom role had no way to be corrected: create and delete only. Combined
   * with the trigger that refuses to delete a role somebody still holds
   * (20260782), a role created with the wrong base_role was stuck — unfixable
   * and unremovable until every holder was reassigned.
   */
  async updateCustomRole(
    roleId: string,
    fields: {
      role_description?: string
      permissions?: Record<string, Record<string, boolean>>
      base_role?: string
    }
  ): Promise<unknown> {
    const { data, error } = await supabase
      .from('custom_roles')
      .update(fields)
      .eq('id', roleId)
      .select()
    if (error) throw error
    return assertUpdated(data, 'Role')
  },
  async deleteCustomRole(roleId: string): Promise<void> {
    const { data, error } = await supabase.from('custom_roles').delete().eq('id', roleId).select('id')
    if (error) throw error
    assertAffected(data, 'Role')
  },
}

// ── User Activity ─────────────────────────────────────────────────────────────

export const userActivity = {
  async list(email: string): Promise<UserActivityRow[]> {
    const { data, error } = await supabase
      .from('user_activity_log')
      .select('*')
      .eq('user_email', email)
      .order('created_date', { ascending: false })
      .limit(50)
    if (error) {
      if (error.code === '42P01') return [] // optional table not yet migrated
      throw error
    }
    return data || []
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
  async get(email: string): Promise<PrefsResult> {
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
  ): Promise<SetPrefsResult> {
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
