import { supabase } from './client.js'

// Helper: invoke the admin-reset-password Edge Function (handles set + create-if-missing).
// The Edge Function validates the caller's JWT and confirms super_admin role server-side.
async function invokeAdminUserOp(targetEmail, newPassword) {
  const { data, error } = await supabase.functions.invoke('admin-reset-password', {
    body: { targetEmail, newPassword },
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
  // Create a Supabase Auth account for a new user (super_admin only).
  // Runs server-side via the same Edge Function (treats missing user as create).
  async adminCreateUser(email, password) {
    return invokeAdminUserOp(email, password)
  },
  async updateProfile(metadata) {
    const { data, error } = await supabase.auth.updateUser({ data: metadata })
    if (error) throw error
    return data
  },
  async signOutAll() {
    const { error } = await supabase.auth.signOut({ scope: 'global' })
    if (error) throw error
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
