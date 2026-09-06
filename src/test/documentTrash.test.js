/**
 * documentTrash.test.js -- the 5-day countdown a trashed document shows, and
 * the purge sweep that acts on it.
 *
 * Purge runs lazily (see documentTrash.js for why: the app's cron already
 * has a known, pre-existing 401 -- this feature does not depend on it), so
 * the "days left" figure Trash shows is the only signal a user has that a
 * document is about to be gone for good. Off-by-one here is the difference
 * between "you have a day left" and "it is already too late."
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { daysUntilPurge, TRASH_RETENTION_DAYS } from '../lib/documentTrash'

describe('daysUntilPurge', () => {
  const NOW = new Date('2026-09-10T12:00:00.000Z')

  beforeEach(() => vi.useFakeTimers().setSystemTime(NOW))
  afterEach(() => vi.useRealTimers())

  it('returns the full retention window right after trashing', () => {
    expect(daysUntilPurge(NOW.toISOString())).toBe(TRASH_RETENTION_DAYS)
  })

  it('counts down as time passes', () => {
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 86_400_000).toISOString()
    expect(daysUntilPurge(twoDaysAgo)).toBe(TRASH_RETENTION_DAYS - 2)
  })

  /**
   * The boundary the purge sweep and this display must agree on. A document
   * trashed exactly `TRASH_RETENTION_DAYS` ago is due for purging
   * (`listExpiredTrash` uses `lte`), so the countdown must not still claim a
   * day is left.
   */
  it('reaches zero exactly at the retention cutoff, not one short or one long', () => {
    const exactlyAtCutoff = new Date(NOW.getTime() - TRASH_RETENTION_DAYS * 86_400_000).toISOString()
    expect(daysUntilPurge(exactlyAtCutoff)).toBe(0)
  })

  it('never goes negative for a document already past its cutoff', () => {
    const wayPast = new Date(NOW.getTime() - (TRASH_RETENTION_DAYS + 10) * 86_400_000).toISOString()
    expect(daysUntilPurge(wayPast)).toBe(0)
  })

  it('rounds a partial day up, so "1 day left" means up to 24 hours, not less', () => {
    // One hour short of the cutoff: under a day remains, which should still
    // read as "1", not "0" -- someone checking Trash should not be told
    // there is no time left when there is.
    const oneHourShortOfCutoff = new Date(
      NOW.getTime() - TRASH_RETENTION_DAYS * 86_400_000 + 3_600_000
    ).toISOString()
    expect(daysUntilPurge(oneHourShortOfCutoff)).toBe(1)
  })

  it('treats a missing deleted_at as the full window rather than throwing', () => {
    expect(daysUntilPurge(null)).toBe(TRASH_RETENTION_DAYS)
  })
})

const { remove, deleteFile, listExpiredTrash, captureException } = vi.hoisted(() => ({
  remove: vi.fn(),
  deleteFile: vi.fn(),
  listExpiredTrash: vi.fn(),
  captureException: vi.fn(),
}))

vi.mock('../api/supabaseClient', () => ({
  db: { productDocuments: { remove, listExpiredTrash } },
  storage: { deleteFile },
}))
vi.mock('../lib/sentry', () => ({ captureException }))

describe('purgeExpiredTrash', () => {
  afterEach(() => {
    remove.mockReset()
    deleteFile.mockReset()
    listExpiredTrash.mockReset()
    captureException.mockReset()
  })

  it('deletes the row before the storage file for each expired document', async () => {
    const { purgeExpiredTrash } = await import('../lib/documentTrash')
    listExpiredTrash.mockResolvedValue([{ id: 'd1', storage_path: 'p/d1.pdf' }])
    const callOrder = []
    remove.mockImplementation(async () => { callOrder.push('remove') })
    deleteFile.mockImplementation(async () => { callOrder.push('deleteFile') })

    const purged = await purgeExpiredTrash()

    expect(callOrder).toEqual(['remove', 'deleteFile'])
    expect(purged).toBe(1)
  })

  /**
   * The property this sweep exists to guarantee: one document whose storage
   * file is already gone (or fails to delete for any reason) must not stop
   * the rest of Trash from being cleaned up.
   */
  it('keeps purging the rest when one storage delete fails', async () => {
    const { purgeExpiredTrash } = await import('../lib/documentTrash')
    listExpiredTrash.mockResolvedValue([
      { id: 'd1', storage_path: 'p/d1.pdf' },
      { id: 'd2', storage_path: 'p/d2.pdf' },
    ])
    remove.mockResolvedValue(undefined)
    deleteFile.mockImplementation(async (path) => {
      if (path === 'p/d1.pdf') throw new Error('object not found')
    })

    const purged = await purgeExpiredTrash()

    expect(remove).toHaveBeenCalledTimes(2)
    expect(purged).toBe(2)
    expect(captureException).toHaveBeenCalledTimes(1)
  })

  it('reports zero and does nothing when Trash has nothing expired', async () => {
    const { purgeExpiredTrash } = await import('../lib/documentTrash')
    listExpiredTrash.mockResolvedValue([])
    const purged = await purgeExpiredTrash()
    expect(purged).toBe(0)
    expect(remove).not.toHaveBeenCalled()
  })
})
