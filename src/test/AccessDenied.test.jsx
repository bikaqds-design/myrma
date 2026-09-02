/**
 * AccessDenied.test.jsx — Unit tests for src/components/AccessDenied.jsx
 *
 * This screen is the only thing a suspended, locked, deactivated, pending,
 * expired or unprovisioned user ever sees, so "it renders at all" is the point
 * of the test. Before 20260786 those users got a full app shell in which every
 * query failed and nothing said why.
 *
 * i18n is stubbed to echo the key, which makes the assertions state exactly
 * which message each reason resolves to — and catches a reason that falls
 * through to the wrong branch, which a rendered English string would hide.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
}))

const { default: AccessDenied } = await import('../components/AccessDenied')
const { ACCESS_DENIED } = await import('../lib/permissions')

afterEach(cleanup)

describe('AccessDenied', () => {
  it.each([
    [ACCESS_DENIED.NO_ROLE, 'accessDenied.no_role.title'],
    [ACCESS_DENIED.SUSPENDED, 'accessDenied.suspended.title'],
    [ACCESS_DENIED.LOCKED, 'accessDenied.locked.title'],
    [ACCESS_DENIED.DEACTIVATED, 'accessDenied.deactivated.title'],
    [ACCESS_DENIED.PENDING, 'accessDenied.pending.title'],
    [ACCESS_DENIED.EXPIRED, 'accessDenied.expired.title'],
  ])('renders the %s message', (reason, expectedKey) => {
    render(<AccessDenied reason={reason} email="a@b.co" row={null} onSignOut={() => {}} />)
    expect(screen.getByRole('heading')).toHaveTextContent(expectedKey)
  })

  // accessDenialReason() returns the raw status for a value this build does not
  // know, so the component must have somewhere to put it rather than rendering
  // a missing translation key as the whole message.
  it('falls back to the generic message for an unrecognised reason', () => {
    render(<AccessDenied reason="archived" email="a@b.co" row={null} onSignOut={() => {}} />)
    expect(screen.getByRole('heading')).toHaveTextContent('accessDenied.unknown.title')
  })

  it('shows the administrator reason when one was recorded', () => {
    const row = { suspended_reason: 'Equipment not returned' }
    render(<AccessDenied reason={ACCESS_DENIED.SUSPENDED} email="a@b.co" row={row} onSignOut={() => {}} />)
    expect(screen.getByText('Equipment not returned')).toBeInTheDocument()
  })

  it('omits the reason block when none was recorded', () => {
    render(<AccessDenied reason={ACCESS_DENIED.LOCKED} email="a@b.co" row={{}} onSignOut={() => {}} />)
    expect(screen.queryByText('accessDenied.reasonLabel')).not.toBeInTheDocument()
  })

  // The expiry date only makes sense on the expiry screen; a suspended account
  // that also happens to carry a past date should not be told about the date.
  it('shows the expiry date only for the expired reason', () => {
    const row = { access_expires_at: '2026-01-01T00:00:00Z' }
    render(<AccessDenied reason={ACCESS_DENIED.EXPIRED} email="a@b.co" row={row} onSignOut={() => {}} />)
    expect(screen.getByText('accessDenied.expiredOnLabel')).toBeInTheDocument()
    cleanup()
    render(<AccessDenied reason={ACCESS_DENIED.SUSPENDED} email="a@b.co" row={row} onSignOut={() => {}} />)
    expect(screen.queryByText('accessDenied.expiredOnLabel')).not.toBeInTheDocument()
  })

  it('shows the signed-in address so the user can tell which account it is', () => {
    render(<AccessDenied reason={ACCESS_DENIED.NO_ROLE} email="tech@qds.eg" row={null} onSignOut={() => {}} />)
    expect(screen.getByText('tech@qds.eg')).toBeInTheDocument()
  })

  // Sign out is the only way off this screen. If it stops working the user is
  // stuck with no route back to the login form.
  it('calls onSignOut when the button is clicked', () => {
    const onSignOut = vi.fn()
    render(<AccessDenied reason={ACCESS_DENIED.SUSPENDED} email="a@b.co" row={null} onSignOut={onSignOut} />)
    screen.getByRole('button').click()
    expect(onSignOut).toHaveBeenCalledOnce()
  })
})

// LOOKUP_FAILED is set by finishLogin when the role query itself throws, not by
// accessDenialReason, so it has no SQL counterpart — but it still needs a
// message rather than falling through to the generic one.
describe('AccessDenied — lookup failure', () => {
  it('renders its own message for a failed role lookup', async () => {
    const { default: Comp } = await import('../components/AccessDenied')
    const { ACCESS_DENIED: AD } = await import('../lib/permissions')
    render(<Comp reason={AD.LOOKUP_FAILED} email="a@b.co" row={null} onSignOut={() => {}} />)
    expect(screen.getByRole('heading')).toHaveTextContent('accessDenied.lookup_failed.title')
  })
})
