/**
 * userDirectory.test.js — searching, filtering, paging and selecting users.
 *
 * The properties worth pinning are the ones where being wrong is quiet or
 * destructive rather than merely untidy:
 *
 *  - a selection must never outlive the rows it was made on. Select twelve
 *    people, filter to one, press Delete, and eleven invisible rows going with
 *    it is the worst outcome this screen can produce;
 *  - a page number must be clamped when filtering shortens the list, or the
 *    table looks empty while plainly having rows;
 *  - a missing status counts as active, because that is how the table draws it.
 */
import { describe, it, expect } from 'vitest'
import {
  filterUsers,
  paginate,
  pruneSelection,
  deletableSelection,
} from '../pages/UserManagement/_directory.js'

const USERS = [
  { user_email: 'nour.ali@test.com', role: 'technician', status: 'active' },
  { user_email: 'dina.adel@test.com', role: 'admin', status: 'active' },
  { user_email: 'omar.khalil@test.com', role: 'sales_rep', status: 'suspended' },
  { user_email: 'sara.mostafa@test.com', role: 'sales_rep', status: 'active' },
  // No status at all — an older row from before the column had a default.
  { user_email: 'legacy@qdsegypt.com', role: 'viewer' },
  { user_email: 'invited@qdsegypt.com', role: 'viewer', status: 'pending' },
  { user_email: 'noted@test.com', role: 'manager', status: 'active', notes: 'warehouse lead' },
]

describe('searching', () => {
  it('matches a fragment of the email, which is how people actually search', () => {
    expect(filterUsers(USERS, { search: 'nour' }).map((u) => u.user_email)).toEqual([
      'nour.ali@test.com',
    ])
  })

  it('matches a domain fragment', () => {
    expect(filterUsers(USERS, { search: '@qdsegypt' })).toHaveLength(2)
  })

  it('ignores case and surrounding spaces', () => {
    expect(filterUsers(USERS, { search: '  DINA  ' })).toHaveLength(1)
  })

  it('searches the notes as well as the address', () => {
    expect(filterUsers(USERS, { search: 'warehouse' }).map((u) => u.user_email)).toEqual([
      'noted@test.com',
    ])
  })

  it('returns everyone for an empty search', () => {
    expect(filterUsers(USERS, { search: '   ' })).toHaveLength(USERS.length)
  })

  it('returns nothing rather than everything when there is no match', () => {
    expect(filterUsers(USERS, { search: 'zzzz' })).toEqual([])
  })
})

describe('filtering', () => {
  it('narrows by role', () => {
    expect(filterUsers(USERS, { role: 'sales_rep' })).toHaveLength(2)
  })

  it('narrows by status', () => {
    expect(filterUsers(USERS, { status: 'suspended' })).toHaveLength(1)
  })

  /**
   * A row with no status is drawn as Active. If the filter disagreed, filtering
   * by Active would hide rows the table calls active.
   */
  it('treats a missing status as active', () => {
    const active = filterUsers(USERS, { status: 'active' }).map((u) => u.user_email)
    expect(active).toContain('legacy@qdsegypt.com')
  })

  it('finds pending invitations, so they can be chased', () => {
    expect(filterUsers(USERS, { status: 'pending' }).map((u) => u.user_email)).toEqual([
      'invited@qdsegypt.com',
    ])
  })

  it('applies search and filters together, not either/or', () => {
    const out = filterUsers(USERS, { search: '@test.com', role: 'sales_rep', status: 'active' })
    expect(out.map((u) => u.user_email)).toEqual(['sara.mostafa@test.com'])
  })
})

describe('paging', () => {
  const rows = Array.from({ length: 23 }, (_, i) => ({ user_email: `u${i}@test.com` }))

  it('returns one page and the totals needed for "showing x-y of z"', () => {
    const p = paginate(rows, 1, 10)
    expect(p.rows).toHaveLength(10)
    expect([p.from, p.to, p.total, p.pageCount]).toEqual([1, 10, 23, 3])
  })

  it('gives the remainder on the last page', () => {
    const p = paginate(rows, 3, 10)
    expect(p.rows).toHaveLength(3)
    expect([p.from, p.to]).toEqual([21, 23])
  })

  /**
   * Filtering while on a later page leaves the page number past the end. An
   * unclamped slice shows an empty table over a list that plainly has rows.
   */
  it('clamps a page number that is past the end', () => {
    const p = paginate(rows.slice(0, 5), 9, 10)
    expect(p.page).toBe(1)
    expect(p.rows).toHaveLength(5)
  })

  it('clamps a page number below one', () => {
    expect(paginate(rows, 0, 10).page).toBe(1)
    expect(paginate(rows, -4, 10).page).toBe(1)
  })

  it('copes with an empty list without claiming a row', () => {
    const p = paginate([], 1, 10)
    expect([p.rows.length, p.from, p.to, p.total, p.pageCount]).toEqual([0, 0, 0, 0, 1])
  })
})

describe('selection', () => {
  /**
   * The destructive case. A selection that survives filtering means Delete acts
   * on rows nobody can see.
   */
  it('drops selected users that are no longer visible', () => {
    const selected = new Set(['nour.ali@test.com', 'dina.adel@test.com', 'omar.khalil@test.com'])
    const visible = filterUsers(USERS, { role: 'admin' })
    expect([...pruneSelection(selected, visible)]).toEqual(['dina.adel@test.com'])
  })

  it('keeps everything when everything is still visible', () => {
    const selected = new Set(['nour.ali@test.com', 'dina.adel@test.com'])
    expect(pruneSelection(selected, USERS).size).toBe(2)
  })

  it('empties the selection when nothing matches', () => {
    const selected = new Set(['nour.ali@test.com'])
    expect(pruneSelection(selected, []).size).toBe(0)
  })

  it('never offers your own account for deletion', () => {
    const selected = new Set(['nour.ali@test.com', 'boss@qdsegypt.com'])
    expect(deletableSelection(selected, 'boss@qdsegypt.com')).toEqual(['nour.ali@test.com'])
  })

  it('matches your own account regardless of case', () => {
    const selected = new Set(['BOSS@qdsegypt.com'])
    expect(deletableSelection(selected, 'boss@qdsegypt.com')).toEqual([])
  })
})
