/**
 * assertUpdated.test.js — BUG-008.
 *
 * PostgREST reports an RLS-filtered UPDATE as `200 []`: no error, no rows.
 * These pin the guard that turns that silence into a failure, so callers stop
 * running side effects (activity entries, notifications, customer emails) for
 * a write that never happened.
 */
import { describe, it, expect } from 'vitest'
import { assertUpdated, assertAffected, NotUpdatedError } from '../api/db/_assertUpdated'

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
