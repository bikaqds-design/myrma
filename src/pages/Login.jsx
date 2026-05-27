import React, { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { auth } from '../api/supabaseClient'
import { useAppearance } from '../contexts/AppearanceContext'
import { loginSchema, forgotPasswordSchema } from '../lib/schemas'

export default function Login({ onLogin }) {
  const { loginBg } = useAppearance()
  const [showPassword, setShowPassword] = useState(false)
  const [serverError, setServerError] = useState('')
  const [forgotMode, setForgotMode] = useState(false)
  const [forgotSent, setForgotSent] = useState(false)

  // ── Login form ──────────────────────────────────────────────────────────────
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(loginSchema) })

  const onLoginSubmit = async ({ email, password }) => {
    setServerError('')
    try {
      await onLogin(email, password)
    } catch (err) {
      setServerError(err.message || 'Login failed')
    }
  }

  // ── Forgot-password form ────────────────────────────────────────────────────
  const {
    register: forgotRegister,
    handleSubmit: forgotHandleSubmit,
    formState: { errors: forgotErrors, isSubmitting: forgotSubmitting },
    reset: forgotReset,
  } = useForm({ resolver: zodResolver(forgotPasswordSchema) })

  const onForgotSubmit = async ({ email }) => {
    try {
      await auth.resetPassword(email)
      setForgotSent(true)
    } catch (err) {
      // Surface server-side error inside the form via a thrown error to rhf
      throw new Error(err.message || 'Failed to send reset email', { cause: err })
    }
  }

  const backToLogin = () => {
    setForgotMode(false)
    setForgotSent(false)
    forgotReset()
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: loginBg || '#eef2ff' }}
    >
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
          <h1 className="text-3xl font-bold text-gray-900">myRMA</h1>
          <p className="text-gray-600 mt-2">
            {forgotMode ? 'Reset your password' : 'RMA Management System'}
          </p>
        </div>

        {!forgotMode ? (
          /* ── Login ─────────────────────────────────────────────────────── */
          <form onSubmit={handleSubmit(onLoginSubmit)} className="space-y-6" noValidate>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
              <input
                type="email"
                {...register('email')}
                className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent ${
                  errors.email ? 'border-red-400 bg-red-50' : 'border-gray-300'
                }`}
                placeholder="admin@example.com"
                autoComplete="email"
              />
              {errors.email && <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>}
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">Password</label>
                <button
                  type="button"
                  onClick={() => {
                    setForgotMode(true)
                  }}
                  className="text-sm text-indigo-600 hover:text-indigo-800 font-medium"
                >
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  {...register('password')}
                  className={`w-full px-4 py-3 pr-12 border rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent ${
                    errors.password ? 'border-red-400 bg-red-50' : 'border-gray-300'
                  }`}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
                  tabIndex={-1}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? (
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
                  )}
                </button>
              </div>
              {errors.password && (
                <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
              )}
            </div>

            {serverError && (
              <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm" role="alert">
                {serverError}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full bg-indigo-600 text-white py-3 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        ) : (
          /* ── Forgot password ────────────────────────────────────────────── */
          <div className="space-y-6">
            {!forgotSent ? (
              <form onSubmit={forgotHandleSubmit(onForgotSubmit)} className="space-y-6" noValidate>
                <p className="text-sm text-gray-600">
                  Enter your email address and we'll send you a link to reset your password.
                </p>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
                  <input
                    type="email"
                    {...forgotRegister('email')}
                    className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent ${
                      forgotErrors.email ? 'border-red-400 bg-red-50' : 'border-gray-300'
                    }`}
                    placeholder="your@email.com"
                    autoFocus
                    autoComplete="email"
                  />
                  {forgotErrors.email && (
                    <p className="mt-1 text-sm text-red-600">{forgotErrors.email.message}</p>
                  )}
                </div>

                {/* rhf surfaces thrown errors from onForgotSubmit via formState.errors.root */}
                {forgotErrors.root && (
                  <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm" role="alert">
                    {forgotErrors.root.message}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={forgotSubmitting}
                  className="w-full bg-indigo-600 text-white py-3 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {forgotSubmitting ? 'Sending…' : 'Send Reset Link'}
                </button>

                <button
                  type="button"
                  onClick={backToLogin}
                  className="w-full text-sm text-gray-500 hover:text-gray-700 text-center"
                >
                  ← Back to login
                </button>
              </form>
            ) : (
              <div className="space-y-6 text-center">
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
                <div>
                  <p className="text-gray-800 font-medium">Check your inbox</p>
                  <p className="text-sm text-gray-500 mt-1">
                    A password reset link has been sent to your email address.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={backToLogin}
                  className="w-full text-sm text-indigo-600 hover:text-indigo-800 font-medium"
                >
                  ← Back to login
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
