/**
 * purgeCaches.test.js — BUG-024.
 *
 * The service worker cached every authenticated Supabase GET under
 * 'supabase-api' and nothing ever deleted it, so signing out removed the
 * session and left the data readable on a shared machine. Removing the caching
 * rule stops new caching; this purge is what clears what is already on disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { purgeApiCaches } from '../lib/purgeCaches'

const original = globalThis.caches

function mockCaches(names, { deleteImpl } = {}) {
  globalThis.caches = {
    keys: vi.fn(async () => names),
    delete: deleteImpl ?? vi.fn(async () => true),
  }
  return globalThis.caches
}

beforeEach(() => {
  vi.restoreAllMocks()
})
afterEach(() => {
  globalThis.caches = original
})

describe('purgeApiCaches', () => {
  it('deletes the API response cache', async () => {
    const c = mockCaches(['supabase-api'])
    await expect(purgeApiCaches()).resolves.toEqual(['supabase-api'])
    expect(c.delete).toHaveBeenCalledWith('supabase-api')
  })

  it('leaves the static asset precache alone', async () => {
    const c = mockCaches(['workbox-precache-v2-https://app/', 'supabase-api'])
    const deleted = await purgeApiCaches()
    expect(deleted).toEqual(['supabase-api'])
    expect(c.delete).not.toHaveBeenCalledWith('workbox-precache-v2-https://app/')
  })

  it('deletes every matching cache, not just the first', async () => {
    const c = mockCaches(['supabase-api', 'supabase-api-v2', 'workbox-runtime-x'])
    const deleted = await purgeApiCaches()
    expect(deleted).toHaveLength(3)
    expect(c.delete).toHaveBeenCalledTimes(3)
  })

  it('returns an empty list when there is nothing to purge', async () => {
    mockCaches([])
    await expect(purgeApiCaches()).resolves.toEqual([])
  })

  it('does not throw when Cache Storage is unavailable — sign-out must not break', async () => {
    globalThis.caches = undefined
    await expect(purgeApiCaches()).resolves.toEqual([])
  })

  it('does not throw when keys() rejects', async () => {
    globalThis.caches = { keys: vi.fn(async () => { throw new Error('blocked') }) }
    await expect(purgeApiCaches()).resolves.toEqual([])
  })

  it('keeps going when one delete fails', async () => {
    let call = 0
    mockCaches(['supabase-api', 'workbox-runtime-x'], {
      deleteImpl: vi.fn(async () => {
        call += 1
        if (call === 1) throw new Error('locked')
        return true
      }),
    })
    await expect(purgeApiCaches()).resolves.toEqual(['workbox-runtime-x'])
  })
})
