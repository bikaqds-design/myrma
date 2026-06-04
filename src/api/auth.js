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
  async updatePassword(newPassword) {
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
