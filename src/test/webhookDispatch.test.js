/**
 * webhookDispatch.test.js — BUG-009.
 *
 * Outbound webhooks were dispatched with `fetch(h.url)` from the browser, which
 * the Content-Security-Policy blocks, and the error was swallowed — so the
 * feature never worked in production and nothing said so. These pin the new
 * contract: delivery goes through the dispatch-webhook Edge Function, the
 * caller is never broken by a failure, and the signing secret is never read
 * client-side.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
const selectMock = vi.fn()
const orderMock = vi.fn()

vi.mock('../api/client.js', () => ({
  supabase: {
    functions: { invoke: invokeMock },
    from: () => ({ select: selectMock }),
  },
}))

const captureExceptionMock = vi.fn()
vi.mock('../lib/sentry.js', () => ({ captureException: captureExceptionMock }))

const { webhooks } = await import('../api/db/system')

beforeEach(() => {
  invokeMock.mockReset()
  selectMock.mockReset()
  orderMock.mockReset()
  captureExceptionMock.mockClear()
  selectMock.mockReturnValue({ order: orderMock })
})

describe('webhooks.dispatch', () => {
  it('delivers through the Edge Function, not a direct fetch', async () => {
    invokeMock.mockResolvedValueOnce({ data: { delivered: 1, results: [] }, error: null })

    await webhooks.dispatch('ticket_created', { id: 't1' })

    expect(invokeMock).toHaveBeenCalledWith('dispatch-webhook', {
      body: { event: 'ticket_created', payload: { id: 't1' } },
    })
  })

  it('never throws at the caller — a webhook must not fail a ticket save', async () => {
    invokeMock.mockRejectedValueOnce(new Error('network down'))
    await expect(webhooks.dispatch('ticket_updated', {})).resolves.toBeUndefined()
  })

  it('reports a returned error to Sentry instead of swallowing it', async () => {
    invokeMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })

    await webhooks.dispatch('ticket_assigned', {})

    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    expect(captureExceptionMock.mock.calls[0][1]).toMatchObject({
      context: 'webhooks.dispatch',
      eventType: 'ticket_assigned',
    })
  })
})

describe('webhooks.test', () => {
  it('returns the per-webhook result so the UI can say what happened', async () => {
    invokeMock.mockResolvedValueOnce({
      data: { delivered: 1, results: [{ id: 'w1', name: 'Slack', ok: true, status: 200, error: null }] },
      error: null,
    })

    await expect(webhooks.test('w1')).resolves.toEqual({
      id: 'w1',
      name: 'Slack',
      ok: true,
      status: 200,
      error: null,
    })
  })

  it('surfaces a failed delivery rather than reporting success', async () => {
    invokeMock.mockResolvedValueOnce({
      data: { delivered: 0, results: [{ id: 'w1', name: 'Slack', ok: false, status: 500, error: 'HTTP 500' }] },
      error: null,
    })

    const result = await webhooks.test('w1')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('HTTP 500')
  })

  it('does not pretend success when the function returns no result', async () => {
    invokeMock.mockResolvedValueOnce({ data: { delivered: 0, results: [] }, error: null })
    const result = await webhooks.test('w1')
    expect(result.ok).toBe(false)
  })

  it('throws when the function itself fails, so the button can report it', async () => {
    invokeMock.mockResolvedValueOnce({ data: null, error: { message: 'Forbidden' } })
    await expect(webhooks.test('w1')).rejects.toBeTruthy()
  })
})

describe('webhooks.list', () => {
  it('never selects secret_key — the column is not readable by any client role', async () => {
    orderMock.mockResolvedValueOnce({ data: [], error: null })

    await webhooks.list()

    const columns = selectMock.mock.calls[0][0]
    expect(columns).not.toContain('secret_key')
    expect(columns).not.toBe('*')
    expect(columns).toContain('has_secret')
  })
})
