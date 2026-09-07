/**
 * announcementsWindow.test.js — BUG-046.
 *
 * listActive() filtered on `starts_at` / `ends_at`. The table has `start_date`
 * / `end_date`, so both reads were always undefined and the scheduling window
 * was never enforced — an expired announcement still showed, and one dated to
 * start next week showed immediately. The admin screen wrote the same wrong
 * names, so every create failed outright, which is why the table held zero rows
 * and nobody noticed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const orderMock = vi.fn()
vi.mock('../api/client.js', () => ({
  supabase: { from: () => ({ select: () => ({ order: orderMock }) }) },
}))

const { announcements } = await import('../api/db/system')

const DAY = 86_400_000
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString()
const rows = (data) => orderMock.mockResolvedValueOnce({ data, error: null })

beforeEach(() => orderMock.mockReset())

describe('announcements.listActive — the scheduling window', () => {
  it('shows an announcement inside its window', async () => {
    rows([{ id: '1', is_active: true, start_date: iso(-DAY), end_date: iso(DAY) }])
    expect(await announcements.listActive()).toHaveLength(1)
  })

  it('hides one whose end_date has passed', async () => {
    rows([{ id: '1', is_active: true, start_date: iso(-2 * DAY), end_date: iso(-DAY) }])
    expect(await announcements.listActive()).toHaveLength(0)
  })

  it('hides one that has not started yet', async () => {
    rows([{ id: '1', is_active: true, start_date: iso(DAY), end_date: iso(2 * DAY) }])
    expect(await announcements.listActive()).toHaveLength(0)
  })

  it('shows one with no dates at all — missing column means always on', async () => {
    rows([{ id: '1', is_active: true }])
    expect(await announcements.listActive()).toHaveLength(1)
  })

  it('respects is_active regardless of the window', async () => {
    rows([{ id: '1', is_active: false, start_date: iso(-DAY), end_date: iso(DAY) }])
    expect(await announcements.listActive()).toHaveLength(0)
  })

  it('ignores the old starts_at / ends_at names entirely', async () => {
    // A row carrying only the old names has no window, so it stays visible —
    // but it must not be read as a window either.
    rows([{ id: '1', is_active: true, starts_at: iso(DAY), ends_at: iso(2 * DAY) }])
    const out = await announcements.listActive()
    expect(out).toHaveLength(1)
  })

  it('tolerates an unparseable date rather than hiding everything', async () => {
    rows([{ id: '1', is_active: true, start_date: 'not-a-date', end_date: null }])
    expect(await announcements.listActive()).toHaveLength(1)
  })

  it('returns an empty list when the query errors', async () => {
    orderMock.mockResolvedValueOnce({ data: null, error: { message: 'nope' } })
    expect(await announcements.listActive()).toEqual([])
  })
})
