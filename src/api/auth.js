import { supabase } from './client.js'
import { purgeApiCaches } from '../lib/purgeCaches'

// Helper: invoke the admin-reset-password Edge Function (handles set + create-if-missing).
// The Edge Function validates the caller's JWT and confirms super_admin role server-side.
/**
 * Call admin-invite-user and surface the reason it refused.
 *
 * functions.invoke() reports a non-2xx only as "Edge Function returned a
 * non-2xx status code" and leaves the body unread, so every considered message
 * the function returns — "that address already has a pending invitation", "that
 * user has already accepted" — was being replaced by that sentence. The body is
 * on error.context; reading it is the difference between telling someone what
 * happened and telling them nothing.
 */
async function invokeInvite(body) {
  const { data, error } = await supabase.functions.invoke('admin-invite-user', { body })
  if (error) {
    let detail = ''
    try {
      const parsed = await error.context?.json?.()
      detail = parsed?.error ?? ''
    } catch {
      /* no readable body — fall through to the generic message */
    }
    throw new Error(detail || error.message || 'The invitation could not be processed')
  }
  if (data?.error) throw new Error(data.error)
  return data
}

async function invokeAdminUserOp(targetEmail, newPassword, role) {
  const { data, error } = await supabase.functions.invoke('admin-reset-password', {
    // `role` is sent only when creating someone. The function writes the
    // user_roles row itself when it is present, so the account and its role are
    // made together instead of in two requests that can half-succeed — see
    // BUG-018. An older deployment of the function ignores the field, which is
    // what makes it safe to ship this before the function.
    body: role ? { targetEmail, newPassword, role } : { targetEmail, newPassword },
  })
  if (error) throw new Error(error.message || 'Admin user operation failed')
  if (data?.error) throw new Error(data.error)
  return data
}

export const auth = {
  async signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) throw error
    return data
  },
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  },
  async signOut() {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    // Remove any API responses a previous build's service worker cached, so
    // the next person on this browser cannot read them (BUG-024). Best-effort
    // by design: a purge failure must not stop someone signing out.
    await purgeApiCaches()
  },
  async getCurrentUser() {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser()
    if (error) return null
    return user
  },
  async resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/`,
    })
    if (error) throw error
  },
  // Change the password of a signed-in user.
  //
  // `currentPassword` is required once the project's "Require current password
  // when updating" setting (GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD)
  // is on. GoTrue names the field `current_password` — snake_case, unlike the rest
  // of the JS surface — and simply ignores it while the setting is off, so passing
  // it is safe either way and this can ship before the setting is flipped.
  //
  // Deliberately NOT used by the reset-link flow: see updatePasswordViaRecovery.
  async updatePassword(newPassword, currentPassword) {
    const attributes = { password: newPassword }
    if (currentPassword) attributes.current_password = currentPassword
    const { error } = await supabase.auth.updateUser(attributes)
    if (error) throw error
  },
  // Set a new password from an emailed recovery link, where by definition the user
  // cannot supply their current one.
  //
  // GoTrue exempts this case: the current-password check in its UserUpdate handler
  // is guarded by `if !session.IsRecovery()`, and the session established from a
  // recovery link carries a recovery AMR claim (it is what fires PASSWORD_RECOVERY
  // in App.jsx). So this path keeps working with the setting on.
  //
  // Kept as its own method so the reset page can never be "fixed" into sending a
  // current password it has no way to know.
  async updatePasswordViaRecovery(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) throw error
  },
  // Super-admin direct password set. Runs server-side via Edge Function with JWT validation.
  // The function creates a new auth user if one doesn't exist for the email.
  async adminSetPassword(targetEmail, newPassword) {
    return invokeAdminUserOp(targetEmail, newPassword)
  },
  /**
   * Invite someone to the system with a role chosen up front (super_admin only).
   *
   * The role is recorded as 'pending' when the invitation is sent, so what the
   * person will be able to do is settled and visible before the email goes out.
   * 'pending' grants nothing until they accept — see rma_accept_invitation.
   *
   * Unlike adminCreateUser, no password is chosen on their behalf: the invitee
   * sets their own from the emailed link, so no working credential travels
   * through a chat app.
   */
  async adminInviteUser(email, role) {
    // Land the invitee on the password screen, not the dashboard. The
    // invitation link signs them in, so a destination of '/' put them inside
    // the app having never chosen a password — they got in that day and then
    // could not log in on their next visit, with nothing explaining why.
    return invokeInvite({
      action: 'invite',
      email,
      role,
      redirectTo: `${window.location.origin}/set-password`,
    })
  },

  /**
   * Delete users for good — the role row AND the auth account (super_admin only).
   *
   * The old path removed only the role row, so the login and password survived
   * a "permanent" delete. Deleting an auth account needs the service_role key,
   * which is why it has to happen server-side.
   *
   * Takes an array so one user and many follow the same guarded path.
   */
  async adminDeleteUsers(emails) {
    const list = Array.isArray(emails) ? emails : [emails]
    const { data, error } = await supabase.functions.invoke('admin-delete-user', {
      body: { emails: list },
    })
    if (error) {
      let detail = ''
      try {
        detail = (await error.context?.json?.())?.error ?? ''
      } catch {
        /* no readable body */
      }
      throw new Error(detail || error.message || 'The users could not be deleted')
    }
    if (data?.error) throw new Error(data.error)
    return data
  },

  /** Withdraw an invitation that has not been accepted (super_admin only). */
  async adminRevokeInvitation(email) {
    return invokeInvite({ action: 'revoke', email })
  },

  /**
   * Turn an accepted invitation into a working account.
   *
   * Called after every successful sign-in, not only the first: the RPC is a
   * no-op for anyone who is not pending, and calling it unconditionally means
   * there is no state to track about whether it has run.
   *
   * Deliberately never throws. A failure here must not stop someone signing in;
   * the worst case is that an invitee stays pending and an administrator can
   * activate them by hand.
   */
  async acceptInvitationIfPending() {
    try {
      const { data, error } = await supabase.rpc('rma_accept_invitation')
      if (error) return null
      return data
    } catch {
      return null
    }
  },

  // Create a Supabase Auth account for a new user (super_admin only).
  // Runs server-side via the same Edge Function (treats missing user as create).
  /**
   * Create a staff account with its role, in one server-side operation.
   *
   * Returns the function's response, whose `roleCreated` says whether the role
   * row was written server-side. A deployment of the function that predates
   * BUG-018 ignores `role` and reports `roleCreated: false`, in which case the
   * caller must still write the role itself.
   */
  async adminCreateUser(email, password, role) {
    return invokeAdminUserOp(email, password, role)
  },
  async updateProfile(metadata) {
    const { data, error } = await supabase.auth.updateUser({ data: metadata })
    if (error) throw error
    return data
  },
  async signOutAll() {
    const { error } = await supabase.auth.signOut({ scope: 'global' })
    if (error) throw error
    await purgeApiCaches()
  },
  onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange(callback)
  },
  sessions: {
    async list() {
      const { data, error } = await supabase.functions.invoke('manage-sessions', {
        body: { action: 'list' },
      })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      return {
        sessions: data.sessions ?? [],
        currentSessionId: data.currentSessionId ?? null,
        activity: data.activity ?? [],
      }
    },
    /**
     * Sign one device out. (Audit finding BUG-049 — the action the function's
     * own header comment has always documented but never implemented.)
     *
     * Revoking deletes the session and its refresh tokens, so the device
     * cannot renew. The access token it already holds stays valid until it
     * expires, which is a property of JWT auth rather than something this call
     * can change — the UI says so rather than implying instant lockout.
     */
    async revoke(sessionId) {
      const { data, error } = await supabase.functions.invoke('manage-sessions', {
        body: { action: 'revoke', sessionId },
      })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      return { revoked: Boolean(data?.revoked), wasCurrent: Boolean(data?.wasCurrent) }
    },
  },
  mfa: {
    async listFactors() {
      return supabase.auth.mfa.listFactors()
    },
    async enroll() {
      return supabase.auth.mfa.enroll({ factorType: 'totp' })
    },
    async challengeAndVerify(factorId, code) {
      return supabase.auth.mfa.challengeAndVerify({ factorId, code })
    },
    async unenroll(factorId) {
      return supabase.auth.mfa.unenroll({ factorId })
    },
    async getLevel() {
      return supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    },
  },
}
