/**
 * audit.test.js — Unit tests for src/api/db/audit.ts
 *
 * Covers: auditInsert() success path, retry-after-600ms path, and the
 * both-attempts-failed fallback that queues to localStorage + reports to Sentry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const insertMock = vi.fn()
vi.mock('../api/client.js', () => ({
  supabase: { from: () => ({ insert: insertMock }) },
}))

const captureExceptionMock = vi.fn()
vi.mock('../lib/sentry.js', () => ({
  captureException: captureExceptionMock,
}))

const { auditInsert, _auditEnqueue } = await import('../api/db/audit')
const { STORAGE_KEY } = await import('../lib/constants')

const entry = {
  user_email: 'tech@example.com',
  action_type: 'ticket_created',
  action_details: null,
  created_date: '2026-06-17T00:00:00.000Z',
}

beforeEach(() => {
  insertMock.mockReset()
  captureExceptionMock.mockClear()
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('auditInsert — success path', () => {
  it('writes once and does not retry when the first attempt succeeds', async () => {
    insertMock.mockResolvedValueOnce({ error: null })

    await auditInsert(entry)

    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })
})

describe('auditInsert — retry path', () => {
  it('retries once after 600ms and succeeds on the second attempt', async () => {
    vi.useFakeTimers()
    insertMock.mockResolvedValueOnce({ error: { message: 'transient' } })
    insertMock.mockResolvedValueOnce({ error: null })

    const promise = auditInsert(entry)
    await vi.advanceTimersByTimeAsync(600)
    await promise

    expect(insertMock).toHaveBeenCalledTimes(2)
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })
})

describe('auditInsert — both attempts fail', () => {
  it('reports to Sentry and queues the entry to localStorage', async () => {
    vi.useFakeTimers()
    insertMock.mockResolvedValue({ error: { message: 'persistent failure' } })

    const promise = auditInsert(entry)
    await vi.advanceTimersByTimeAsync(600)
    await promise

    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    const queued = JSON.parse(localStorage.getItem(STORAGE_KEY.AUDIT_QUEUE))
    expect(queued).toContainEqual(entry)
  })
})

describe('_auditEnqueue — queue cap', () => {
  it('caps the queue at 50 entries, dropping the oldest first', () => {
    for (let i = 0; i < 55; i++) {
      _auditEnqueue({ ...entry, action_type: `action_${i}` })
    }
    const queue = JSON.parse(localStorage.getItem(STORAGE_KEY.AUDIT_QUEUE))
    expect(queue).toHaveLength(50)
    expect(queue[0].action_type).toBe('action_5')
    expect(queue[49].action_type).toBe('action_54')
  })
})
