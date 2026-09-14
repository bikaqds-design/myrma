/**
 * paging.test.js — BUG-066.
 *
 * Lists loaded whole tables, and the Data API returns at most 1 000 rows per
 * request, so past that screens silently showed part of the data as if it were
 * all of it. These pin the two helpers every paged screen builds on, on the
 * points where being wrong is quiet:
 *
 *  - the row range for a page (an off-by-one repeats or drops a row per page);
 *  - a page past the end is answered with a total, not an error;
 *  - reading "all rows" walks past any server cap instead of stopping at the
 *    first short chunk — stopping there is the original bug again.
 */
import { describe, it, expect, vi } from 'vitest'
import { pageBounds, fetchPage, fetchAllRows, chunksOf } from '../api/db/_paging'

/** A fake table of `total` rows behind a server that caps responses at `cap`. */
function fakeTable(total, cap = 1000) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i + 1 }))
  const run = vi.fn(async (from, to) => {
    if (from > 0 && from >= total) return { data: null, error: { code: 'PGRST103' }, count: null }
    const end = Math.min(to, from + cap - 1)
    return { data: rows.slice(from, end + 1), error: null, count: total }
  })
  return { rows, run }
}

describe('pageBounds', () => {
  it('maps 1-based pages to inclusive row ranges', () => {
    expect(pageBounds(1, 25)).toEqual({ from: 0, to: 24 })
    expect(pageBounds(2, 25)).toEqual({ from: 25, to: 49 })
    expect(pageBounds(4, 100)).toEqual({ from: 300, to: 399 })
  })

  it('clamps nonsense from a URL instead of asking for negative rows', () => {
    expect(pageBounds(0, 25)).toEqual({ from: 0, to: 24 })
    expect(pageBounds(-3, 25)).toEqual({ from: 0, to: 24 })
    expect(pageBounds(Number.NaN, 0)).toEqual({ from: 0, to: 0 })
  })
})

describe('fetchPage', () => {
  it('returns the page rows and the exact total', async () => {
    const { run } = fakeTable(888)
    const page = await fetchPage(run, 9, 100)
    expect(run).toHaveBeenCalledWith(800, 899)
    expect(page.data).toHaveLength(88)
    expect(page.data[0].id).toBe(801)
    expect(page).toMatchObject({ count: 888, page: 9, pageSize: 100, totalPages: 9 })
  })

  it('answers a page past the end with no rows and the real total', async () => {
    const { run } = fakeTable(30)
    const page = await fetchPage(run, 5, 25)
    expect(page.data).toEqual([])
    expect(page.count).toBe(30)
    expect(page.totalPages).toBe(2)
  })

  it('throws any other error rather than showing an empty list', async () => {
    const run = async () => ({ data: null, error: { code: '42501', message: 'denied' }, count: null })
    await expect(fetchPage(run, 1, 25)).rejects.toMatchObject({ code: '42501' })
  })
})

describe('fetchAllRows', () => {
  it('reads a table larger than the server cap in full', async () => {
    const { run } = fakeTable(2345)
    const all = await fetchAllRows(run)
    expect(all).toHaveLength(2345)
    expect(all.at(-1).id).toBe(2345)
  })

  it('walks past a cap LOWER than the chunk size instead of stopping short', async () => {
    // Ask for 1 000 at a time from a server that returns 400: each chunk comes
    // back short. Treating short as "the end" would return 400 rows.
    const { run } = fakeTable(1250, 400)
    const all = await fetchAllRows(run, 1000)
    expect(all).toHaveLength(1250)
    expect(new Set(all.map((r) => r.id)).size).toBe(1250)
  })

  it('returns nothing for an empty table', async () => {
    const { run } = fakeTable(0)
    expect(await fetchAllRows(run)).toEqual([])
  })

  it('throws on an error part-way through rather than returning a partial list', async () => {
    let calls = 0
    const run = async (from) => {
      calls += 1
      if (calls === 2) return { data: null, error: { code: '57014', message: 'timeout' } }
      return { data: [{ id: from + 1 }], error: null }
    }
    await expect(fetchAllRows(run, 1)).rejects.toMatchObject({ code: '57014' })
  })

  it('refuses a response larger than the range it asked for', async () => {
    const run = async () => ({ data: [{ id: 1 }, { id: 2 }, { id: 3 }], error: null })
    await expect(fetchAllRows(run, 2)).rejects.toThrow(/more rows than the requested range/)
  })
})

describe('chunksOf', () => {
  it('splits without losing or repeating items', () => {
    expect(chunksOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunksOf([], 3)).toEqual([])
  })
})
