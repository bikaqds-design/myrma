import React, { useState } from 'react'
import { auth } from '../api/supabaseClient'
import { captureException } from '../lib/sentry'
import { resetPasswordSchema, getFirstError } from '../lib/schemas'
import { Input, Button } from '../components/ui'

/**
 * Set a password from an emailed link.
 *
 * Serves two arrivals that need the same thing and differ only in wording:
 *
 *   'reset'  — someone asked to reset a password they already have.
 *   'invite' — someone accepting an invitation, who has never had one. Without
 *              this screen the invitation link drops them straight into the app
 *              with no password set, and their NEXT visit fails to log in with
 *              nothing to explain why.
 *
 * Both call updatePasswordViaRecovery, which sends no current password.
 * Verified against the live project that this is accepted from an invite
 * session even with require-current-password on.
 */
export default function ResetPassword({ onDone, mode = 'reset' }) {
  const isInvite = mode === 'invite'
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  const EyeIcon = ({ visible }) =>
    visible ? (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
        />
      </svg>
    ) : (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
        />
      </svg>
    )

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    const validation = resetPasswordSchema.safeParse({
      newPassword: password,
      confirmPassword: confirm,
    })
    if (!validation.success) {
      setError(getFirstError(validation))
      return
    }

    setLoading(true)
    try {
      // Recovery sessions are exempt from the project's require-current-password
      // setting, so this path deliberately sends no current password.
      await auth.updatePasswordViaRecovery(password)
      setSuccess(true)
      setTimeout(onDone, 2000)
    } catch (err) {
      captureException(err, { page: 'ResetPassword', context: 'updatePassword' })
      setError(err.message || 'Failed to update password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-indigo-600 rounded-xl flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-10 h-10 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-gray-900">myCRM</h1>
          <p className="text-gray-600 mt-2">
            {isInvite ? 'Choose a password' : 'Set a new password'}
          </p>
          <p className="text-xs text-gray-500 mt-3">
            {isInvite
              ? "Welcome — your invitation has been accepted. Choose a password now so you can sign in again next time."
              : "You're here because someone requested a password reset for your account. If that wasn't you, you can safely close this page — your current password will remain unchanged until you submit a new one."}
          </p>
        </div>

        {success ? (
          <div className="text-center space-y-4">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
              <svg
                className="w-8 h-8 text-green-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <p className="text-gray-800 font-medium">Password updated!</p>
            <p className="text-sm text-gray-500">
              {isInvite ? 'Taking you into the app...' : 'Redirecting you to login...'}
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">New Password</label>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="py-3 px-4 pr-12 focus:ring-indigo-600"
                  placeholder="••••••••"
                  required
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
                  tabIndex={-1}
                >
                  <EyeIcon visible={showPassword} />
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Confirm Password
              </label>
              <div className="relative">
                <Input
                  type={showConfirm ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="py-3 px-4 pr-12 focus:ring-indigo-600"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  aria-label={showConfirm ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
                  tabIndex={-1}
                >
                  <EyeIcon visible={showConfirm} />
                </button>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>
            )}

            <Button type="submit" loading={loading} className="w-full py-3">
              Update Password
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
