/**
 * Server-side paging. (Audit finding BUG-066.)
 *
 * Screens used to load a whole table and filter, sort and page it in the
 * browser. Two ceilings made that silently wrong:
 *
 *   - the code capped each read at 5 000 rows, and
 *   - the Supabase Data API caps every response at its "Max rows" setting,
 *     which is 1 000 on this project (read from the dashboard 2026-09-14).
 *
 * The second one wins and says nothing: `.limit(5000)` quietly came back with
 * 1 000 rows, so past that a list showed some of the data as if it were all of
 * it, with totals to match. The fix is to ask the database for one page at a
 * time — filtered, sorted and counted there — and never to hold "the table" in
 * the browser.
 *
 * Two helpers:
 *
 *   fetchPage     one page plus the exact total, for a list screen.
 *   fetchAllRows  every row matching a query, in chunks, for the cases that
 *                 genuinely need all of them (an "Export all" must contain
 *                 all). It is not a way to put a whole table back on screen.
 *
 * Both take a callback that builds the query for a row range, so each table
 * keeps its own filters and column list while the range arithmetic and the
 * cap handling live here once.
 */

import type { PagedResult } from './types.js'

/** The Data API's "Max rows" on this project: no response carries more. */
export const API_MAX_ROWS = 1000

/** What a PostgREST call resolves to, as far as paging needs to know. */
export interface RangeResponse {
  data: unknown[] | null
  error: { code?: string; message?: string } | null
  count?: number | null
}

/** Builds and runs the query for rows `from`..`to` inclusive (0-based). */
export type RangeQuery = (from: number, to: number) => PromiseLike<RangeResponse>

/**
 * The inclusive row range for a 1-based page, as PostgREST's `.range()` wants.
 * Page and size are clamped so a bad value from a URL cannot ask for row -25.
 */
export function pageBounds(page: number, pageSize: number): { from: number; to: number } {
  const size = Math.max(1, Math.floor(pageSize) || 1)
  const index = Math.max(1, Math.floor(page) || 1) - 1
  const from = index * size
  return { from, to: from + size - 1 }
}

/**
 * One page and the exact number of matching rows.
 *
 * `run` must request `{ count: 'exact' }` and order by a unique column last
 * (normally `id`), or rows can repeat or vanish between pages.
 *
 * A page past the end is not an error for the screen: PostgREST answers it
 * with 416 (PGRST103) and no count, which happens whenever the last row of the
 * last page is deleted or a filter narrows the list. The total is fetched
 * separately then, so the screen can step back to a page that exists.
 */
export async function fetchPage<T>(run: RangeQuery, page: number, pageSize: number): Promise<PagedResult<T>> {
  const { from, to } = pageBounds(page, pageSize)
  const size = to - from + 1
  const current = Math.max(1, Math.floor(page) || 1)

  let { data, error, count } = await run(from, to)
  if (error?.code === 'PGRST103') {
    ;({ error, count } = await run(0, 0))
    data = []
  }
  if (error) throw error

  const total = count ?? 0
  return {
    missing: false,
    data: (data ?? []) as T[],
    count: total,
    page: current,
    pageSize: size,
    totalPages: Math.ceil(total / size),
  }
}

/**
 * Every row a query matches, read in chunks.
 *
 * `run` must order by a unique column last, so consecutive chunks neither
 * overlap nor skip.
 *
 * It stops at the first EMPTY chunk, not the first short one. A short chunk is
 * what a lower server cap looks like — ask for 1 000 when "Max rows" is 500 and
 * 500 come back — and treating that as the end is exactly the silent
 * truncation this file exists to remove. The next chunk starts after the rows
 * actually received, so any cap is walked through.
 */
export async function fetchAllRows<T>(run: RangeQuery, chunkSize = API_MAX_ROWS): Promise<T[]> {
  const size = Math.max(1, Math.floor(chunkSize) || API_MAX_ROWS)
  const rows: T[] = []
  for (;;) {
    const from = rows.length
    const { data, error } = await run(from, from + size - 1)
    // Asking for the range after the last row is how the loop learns it is
    // done, and PostgREST may answer that with 416 (PGRST103) instead of an
    // empty list. Past row 0 that means "no more rows", not a failure.
    if (error?.code === 'PGRST103' && from > 0) return rows
    if (error) throw error
    const chunk = (data ?? []) as T[]
    if (chunk.length === 0) return rows
    // More than was asked for means the range was ignored; looping would
    // append the same rows forever.
    if (chunk.length > size) throw new Error('Paged read returned more rows than the requested range')
    rows.push(...chunk)
  }
}

/** Split `items` into arrays of at most `size`, for filters that go into a URL. */
export function chunksOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
