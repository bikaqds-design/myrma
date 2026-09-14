/**
 * assertUpdated.test.js — BUG-008.
 *
 * PostgREST reports an RLS-filtered UPDATE as `200 []`: no error, no rows.
 * These pin the guard that turns that silence into a failure, so callers stop
 * running side effects (activity entries, notifications, customer emails) for
 * a write that never happened.
 */
import { describe, it, expect } from 'vitest'
import {
  assertUpdated,
  assertAffected,
  assertAllAffected,
  NotUpdatedError,
  NotAllUpdatedError,
} from '../api/db/_assertUpdated'

describe('assertUpdated', () => {
  it('returns the row when the write affected one', () => {
    const row = { id: 'a1', ticket_status: 'Completed' }
    expect(assertUpdated([row], 'Ticket')).toBe(row)
  })

  it('throws on an empty array — the RLS-filtered no-op', () => {
    expect(() => assertUpdated([], 'Ticket')).toThrow(NotUpdatedError)
  })

  it('throws on null and on undefined', () => {
    expect(() => assertUpdated(null, 'Ticket')).toThrow(NotUpdatedError)
    expect(() => assertUpdated(undefined, 'Ticket')).toThrow(NotUpdatedError)
  })

  it('names the entity in the message so the toast is meaningful', () => {
    expect(() => assertUpdated([], 'Purchase order')).toThrow(/Purchase order was not updated/)
  })

  it('carries a stable code for callers that branch on it', () => {
    try {
      assertUpdated([], 'Ticket')
    } catch (e) {
      expect(e.code).toBe('RMA_NOT_UPDATED')
      expect(e.name).toBe('NotUpdatedError')
    }
  })

  it('returns the first row when several come back', () => {
    expect(assertUpdated([{ id: 1 }, { id: 2 }], 'Lead')).toEqual({ id: 1 })
  })
})

describe('assertAffected', () => {
  it('passes when at least one row was touched', () => {
    expect(() => assertAffected([{ id: 'a1' }], 'Purchase order')).not.toThrow()
  })

  it('throws when nothing was touched', () => {
    expect(() => assertAffected([], 'Purchase order')).toThrow(NotUpdatedError)
    expect(() => assertAffected(null, 'Vendor invoice')).toThrow(NotUpdatedError)
  })
})

// BUG-074: a bulk write over a list of ids silently skips the rows RLS filters
// out. "10 updated" when 3 were not is the bulk form of BUG-008.
describe('assertAllAffected', () => {
  it('passes when every selected row came back', () => {
    expect(() => assertAllAffected([{ id: 'a' }, { id: 'b' }], ['a', 'b'], 'deal')).not.toThrow()
  })

  it('names how many of the selection did not change', () => {
    let caught
    try {
      assertAllAffected([{ id: 'a' }], ['a', 'b', 'c'], 'deal')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(NotAllUpdatedError)
    expect(caught.code).toBe('RMA_NOT_ALL_UPDATED')
    expect(caught.total).toBe(3)
    expect(caught.unchangedIds).toEqual(['b', 'c'])
    expect(caught.message).toMatch(/2 of the 3 selected deal records were not changed/)
    expect(caught.message).toMatch(/other 1 were/)
  })

  it('says none changed when nothing came back', () => {
    expect(() => assertAllAffected([], ['a', 'b'], 'lead')).toThrow(/None of the 2 selected lead records/)
    expect(() => assertAllAffected(null, ['a'], 'lead')).toThrow(NotAllUpdatedError)
  })

  it('counts a duplicated id once', () => {
    expect(() => assertAllAffected([{ id: 'a' }], ['a', 'a'], 'ticket')).not.toThrow()
  })
})
