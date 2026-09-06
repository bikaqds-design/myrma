/**
 * audit.test.js — Unit tests for src/api/db/audit.ts
 *
 * Covers: auditInsert() success path, retry-after-600ms path, and the
 * both-attempts-failed fallback that queues to localStorage + reports to Sentry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const insertMock = vi.fn()
const getUserMock = vi.fn()
vi.mock('../api/client.js', () => ({
  supabase: {
    from: () => ({ insert: insertMock }),
    auth: { getUser: getUserMock },
  },
}))

const captureExceptionMock = vi.fn()
vi.mock('../lib/sentry.js', () => ({
  captureException: captureExceptionMock,
}))

const { auditInsert, _auditEnqueue, auditFlushQueue } = await import('../api/db/audit')
const { STORAGE_KEY } = await import('../lib/constants')

const entry = {
  user_email: 'tech@example.com',
  action_type: 'ticket_created',
  action_details: null,
  created_date: '2026-06-17T00:00:00.000Z',
}

beforeEach(() => {
  insertMock.mockReset()
  getUserMock.mockReset()
  getUserMock.mockResolvedValue({ data: { user: { email: 'tech@example.com' } } })
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

describe('auditFlushQueue — attribution safety (BUG-019)', () => {
  // The queue is per-browser, not per-user, and the database stamps
  // user_email from the JWT (migration 20260821). Replaying another user's
  // entry would therefore file it under whoever is signed in now.

  it("flushes the current user's own queued entries", async () => {
    _auditEnqueue(entry)
    insertMock.mockResolvedValueOnce({ error: null })

    await auditFlushQueue()

    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(insertMock).toHaveBeenCalledWith([entry])
    expect(localStorage.getItem(STORAGE_KEY.AUDIT_QUEUE)).toBeNull()
  })

  it('drops entries belonging to a different user instead of misattributing them', async () => {
    _auditEnqueue({ ...entry, user_email: 'someone.else@example.com' })

    await auditFlushQueue()

    expect(insertMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEY.AUDIT_QUEUE)).toBeNull()
  })

  it('flushes only the mine half of a mixed queue', async () => {
    _auditEnqueue({ ...entry, user_email: 'someone.else@example.com' })
    _auditEnqueue(entry)
    insertMock.mockResolvedValueOnce({ error: null })

    await auditFlushQueue()

    expect(insertMock).toHaveBeenCalledWith([entry])
  })

  it('matches the signed-in address case-insensitively', async () => {
    getUserMock.mockResolvedValue({ data: { user: { email: 'TECH@Example.com' } } })
    _auditEnqueue(entry)
    insertMock.mockResolvedValueOnce({ error: null })

    await auditFlushQueue()

    expect(insertMock).toHaveBeenCalledWith([entry])
  })

  it('keeps the queue when there is no session, rather than dropping it', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } })
    _auditEnqueue(entry)

    await auditFlushQueue()

    expect(insertMock).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY.AUDIT_QUEUE))).toContainEqual(entry)
  })

  it('keeps the queue when the insert fails, so nothing is lost', async () => {
    _auditEnqueue(entry)
    insertMock.mockResolvedValueOnce({ error: { message: 'offline' } })

    await auditFlushQueue()

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY.AUDIT_QUEUE))).toContainEqual(entry)
  })
})
