import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'

vi.mock('../lib/sentry.js', () => ({ captureException: vi.fn() }))

import ErrorBoundary from '../components/ErrorBoundary'

function Thrower({ error }) {
  throw error
}

function renderCrash(error) {
  return render(
    <ErrorBoundary>
      <Thrower error={error} />
    </ErrorBoundary>
  )
}

describe('ErrorBoundary message (BUG-055)', () => {
  beforeEach(() => {
    // React logs every caught render error; the noise is expected here.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('keeps database vocabulary off the production crash screen', () => {
    vi.stubEnv('DEV', false)
    renderCrash(new Error('duplicate key value violates unique constraint "customers_email_key"'))
    expect(screen.queryByText(/customers_email_key/)).toBeNull()
    expect(screen.queryByText(/violates unique constraint/)).toBeNull()
  })

  it('never prints an unresolved translation key in place of a message', () => {
    // toUserMessage looks up errors.* without a default. If i18n is what broke,
    // it returns the key itself; the screen must fall back to plain English.
    vi.stubEnv('DEV', false)
    renderCrash(new Error('permission denied for relation payments'))
    expect(screen.queryByText(/^errors\./)).toBeNull()
  })

  it('still shows an ordinary, schema-free message in production', () => {
    vi.stubEnv('DEV', false)
    renderCrash(new Error('Report could not be generated'))
    expect(screen.getByText('Report could not be generated')).toBeTruthy()
  })

  it('shows the raw message in development, where it is for the developer', () => {
    vi.stubEnv('DEV', true)
    renderCrash(new Error('duplicate key value violates unique constraint "customers_email_key"'))
    // Development renders it twice — in the message box and again inside the
    // dev-only stack — so assert presence rather than a single element.
    expect(screen.getAllByText(/customers_email_key/).length).toBeGreaterThan(0)
  })
})
