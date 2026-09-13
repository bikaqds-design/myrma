import { describe, it, expect } from 'vitest'
import {
  CHUNK_RELOAD_KEY,
  isChunkLoadError,
  claimChunkReload,
  clearChunkReload,
} from '../lib/chunkReload'

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  }
}

describe('isChunkLoadError', () => {
  it('recognises the wording of each engine', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Reports-a1.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: https://x/assets/Reports-a1.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
  })

  it('ignores genuine module errors, which a reload cannot fix', () => {
    expect(isChunkLoadError(new ReferenceError('foo is not defined'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
})

describe('claimChunkReload (BUG-054)', () => {
  it('grants exactly one reload, then refuses — the loop the finding describes', () => {
    const storage = memoryStorage()
    expect(claimChunkReload(storage)).toBe(true)
    expect(claimChunkReload(storage)).toBe(false)
    expect(claimChunkReload(storage)).toBe(false)
  })

  it('grants a reload again once a chunk has loaded successfully', () => {
    // A long-lived tab can outlive more than one deploy; each deserves its
    // silent recovery.
    const storage = memoryStorage()
    expect(claimChunkReload(storage)).toBe(true)
    clearChunkReload(storage)
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBeNull()
    expect(claimChunkReload(storage)).toBe(true)
  })

  it('refuses when there is no storage, rather than reloading without a memory', () => {
    expect(claimChunkReload(null)).toBe(false)
  })

  it('refuses when storage throws', () => {
    const throwing = {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('SecurityError') },
      removeItem: () => { throw new Error('SecurityError') },
    }
    expect(claimChunkReload(throwing)).toBe(false)
    expect(() => clearChunkReload(throwing)).not.toThrow()
  })

  it('refuses when storage accepts a write and silently drops it', () => {
    // Older Safari private windows. Without reading the flag back, every load
    // would be granted a reload and the loop would return.
    const blackHole = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    expect(claimChunkReload(blackHole)).toBe(false)
  })
})
