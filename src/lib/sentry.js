/**
 * sentry.js — Sentry error-reporting helpers (Sentry)
 *
 * Usage:
 *   1. Call initSentry() once at app startup (main.jsx)
 *   2. Call captureException(err, context) in catch blocks you want tracked
 *   3. ErrorBoundary calls captureException automatically for render errors
 *
 * Set VITE_SENTRY_DSN in .env to enable. Leave blank to disable silently.
 */
import * as Sentry from '@sentry/react'

let initialised = false

export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn || initialised) return

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE, // 'production' | 'development'
    release: import.meta.env.VITE_APP_VERSION ?? undefined,
    enabled: import.meta.env.PROD, // never sends events in dev builds
    tracesSampleRate: 0.1, // 10 % of transactions traced
    integrations: [Sentry.browserTracingIntegration()],
  })

  initialised = true
}

/**
 * Report a caught exception to Sentry.
 * In development it just console.errors — no network traffic.
 *
 * @param {unknown} error
 * @param {Record<string,unknown>} [context]
 */
export function captureException(error, context) {
  if (import.meta.env.DEV) {
    console.error('[Sentry]', error, context ?? '')
    return
  }
  try {
    Sentry.captureException(error, context ? { extra: context } : undefined)
  } catch {
    // never throw from an error reporter
  }
}
