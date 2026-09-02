/**
 * inviteUser.test.js — inviting someone with a role chosen up front.
 *
 * The properties worth pinning are the ones where being wrong is quiet or
 * dangerous rather than merely broken:
 *
 *  - the invitation carries the role the administrator picked, and the app
 *    never invents or defaults one on the way through;
 *  - the reason a refusal happened reaches the caller. functions.invoke()
 *    reports a non-2xx only as "Edge Function returned a non-2xx status code"
 *    and leaves the body unread, so every considered message the function
 *    returns was being replaced by that sentence. Caught by calling the real
 *    thing rather than reading the code;
 *  - acceptance never blocks a sign-in. It is called on every login, so a
 *    failure there must be silent, not fatal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
const rpc = vi.fn()
vi.mock('../api/client.js', () => ({
  supabase: {
    functions: { invoke: (...a) => invoke(...a) },
    rpc: (...a) => rpc(...a),
  },
}))

const { auth } = await import('../api/auth.js')

/** A FunctionsHttpError as supabase-js actually reports it: body on context. */
function httpError(status, body) {
  const err = new Error('Edge Function returned a non-2xx status code')
  err.context = { status, json: async () => body }
  return err
}

beforeEach(() => {
  invoke.mockReset()
  rpc.mockReset()
  globalThis.window = { location: { origin: 'https://app.test' } }
})

describe('sending an invitation', () => {
  it('passes the chosen role through untouched', async () => {
    invoke.mockResolvedValue({ data: { success: true }, error: null })
    await auth.adminInviteUser('new@test.com', 'sales_rep')

    const [fn, opts] = invoke.mock.calls[0]
    expect(fn).toBe('admin-invite-user')
    expect(opts.body).toMatchObject({ action: 'invite', email: 'new@test.com', role: 'sales_rep' })
  })

  /**
   * The destination is the password screen, never the dashboard. An invitation
   * link signs the person in, so sending them to '/' left them inside the app
   * having never chosen a password — they got in that day and could not log in
   * on their next visit, with nothing explaining why. Caught by accepting a
   * real invitation rather than by reading the code.
   */
  it('sends the invitee to the password screen, not into the app', async () => {
    invoke.mockResolvedValue({ data: { success: true }, error: null })
    await auth.adminInviteUser('new@test.com', 'viewer')
    expect(invoke.mock.calls[0][1].body.redirectTo).toBe('https://app.test/set-password')
  })

  it('builds that destination from the current origin, so each environment invites into itself', async () => {
    globalThis.window = { location: { origin: 'https://myrma.vercel.app' } }
    invoke.mockResolvedValue({ data: { success: true }, error: null })
    await auth.adminInviteUser('new@test.com', 'viewer')
    expect(invoke.mock.calls[0][1].body.redirectTo).toBe('https://myrma.vercel.app/set-password')
  })

  /**
   * The defect this file was written after. Without reading error.context the
   * caller sees the transport sentence and the administrator is told nothing
   * about why their invitation was refused.
   */
  it('surfaces the reason a refusal happened, not the transport error', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: httpError(409, { error: 'That address already has a pending invitation' }),
    })
    await expect(auth.adminInviteUser('taken@test.com', 'viewer')).rejects.toThrow(
      /already has a pending invitation/
    )
  })

  it('falls back to the transport message when there is no readable body', async () => {
    const err = new Error('Failed to fetch')
    invoke.mockResolvedValue({ data: null, error: err })
    await expect(auth.adminInviteUser('x@test.com', 'viewer')).rejects.toThrow(/Failed to fetch/)
  })

  it('treats an error carried in a 200 body as a failure too', async () => {
    invoke.mockResolvedValue({ data: { error: 'Forbidden: super_admin only' }, error: null })
    await expect(auth.adminInviteUser('x@test.com', 'viewer')).rejects.toThrow(/super_admin only/)
  })
})

describe('revoking an invitation', () => {
  it('names the address and asks for revoke, with no role', async () => {
    invoke.mockResolvedValue({ data: { success: true, revoked: true }, error: null })
    await auth.adminRevokeInvitation('pending@test.com')
    expect(invoke.mock.calls[0][1].body).toEqual({ action: 'revoke', email: 'pending@test.com' })
  })

  it('explains why an accepted user cannot be revoked', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: httpError(400, {
        error: 'That user has already accepted; remove them from the users list instead',
      }),
    })
    await expect(auth.adminRevokeInvitation('active@test.com')).rejects.toThrow(/already accepted/)
  })
})

describe('deleting users', () => {
  it('always sends an array, so one user and many share the same guarded path', async () => {
    invoke.mockResolvedValue({ data: { success: true, deleted: 1, failed: [] }, error: null })
    await auth.adminDeleteUsers('one@test.com')
    expect(invoke.mock.calls[0][1].body).toEqual({ emails: ['one@test.com'] })
  })

  it('passes a list through unchanged', async () => {
    invoke.mockResolvedValue({ data: { success: true, deleted: 2, failed: [] }, error: null })
    await auth.adminDeleteUsers(['a@test.com', 'b@test.com'])
    expect(invoke.mock.calls[0][1].body.emails).toEqual(['a@test.com', 'b@test.com'])
  })

  /**
   * The server refuses self-deletion even though the screen hides it. If that
   * reason did not reach the caller, the button would appear to do nothing.
   */
  it('surfaces the refusal when you try to delete yourself', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: httpError(400, { error: 'You cannot delete your own account' }),
    })
    await expect(auth.adminDeleteUsers(['me@test.com'])).rejects.toThrow(/your own account/)
  })

  /**
   * A partial failure must come back as data, not an exception: deleting four
   * of five and reporting nothing would leave the screen showing five.
   */
  it('returns partial results rather than throwing', async () => {
    invoke.mockResolvedValue({
      data: { success: false, deleted: 1, failed: [{ email: 'b@test.com', error: 'last super admin' }] },
      error: null,
    })
    const result = await auth.adminDeleteUsers(['a@test.com', 'b@test.com'])
    expect(result.deleted).toBe(1)
    expect(result.failed[0].error).toMatch(/last super admin/)
  })
})

describe('accepting an invitation at sign-in', () => {
  it('reports what the RPC did', async () => {
    rpc.mockResolvedValue({ data: 'activated', error: null })
    expect(await auth.acceptInvitationIfPending()).toBe('activated')
    expect(rpc).toHaveBeenCalledWith('rma_accept_invitation')
  })

  /**
   * This runs on every sign-in, before the role is read. If it threw, a
   * database hiccup would stop people logging in — a far worse outcome than an
   * invitee staying pending until an administrator activates them by hand.
   */
  it('never throws when the RPC errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(auth.acceptInvitationIfPending()).resolves.toBeNull()
  })

  it('never throws when the call itself rejects', async () => {
    rpc.mockRejectedValue(new Error('network down'))
    await expect(auth.acceptInvitationIfPending()).resolves.toBeNull()
  })

  it('is a no-op for someone who is already active', async () => {
    rpc.mockResolvedValue({ data: 'active', error: null })
    expect(await auth.acceptInvitationIfPending()).toBe('active')
  })
})
