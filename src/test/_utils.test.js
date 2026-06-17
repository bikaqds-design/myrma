/**
 * _utils.test.js — Unit tests for src/pages/RMATickets/_utils.js
 *
 * Covers: generateRmaNumber() collision/padding logic,
 * getStatusColor()/getPriorityColor() fallback behavior.
 */
import { describe, it, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { generateRmaNumber, getStatusColor, getPriorityColor } from '../pages/RMATickets/_utils'

// ── generateRmaNumber ─────────────────────────────────────────────────────────

describe('generateRmaNumber', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-17T12:00:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts at serial 0001 with no existing tickets', () => {
    expect(generateRmaNumber([])).toBe('RMA-17062026-0001')
  })

  it('defaults to no existing tickets when called with no argument', () => {
    expect(generateRmaNumber()).toBe('RMA-17062026-0001')
  })

  it('increments past the highest existing serial for today', () => {
    const existing = [{ rma_number: 'RMA-17062026-0001' }, { rma_number: 'RMA-17062026-0002' }]
    expect(generateRmaNumber(existing)).toBe('RMA-17062026-0003')
  })

  it('uses max+1 rather than count+1 when serials have gaps', () => {
    const existing = [{ rma_number: 'RMA-17062026-0001' }, { rma_number: 'RMA-17062026-0009' }]
    expect(generateRmaNumber(existing)).toBe('RMA-17062026-0010')
  })

  it('zero-pads the serial to 4 digits', () => {
    const existing = [{ rma_number: 'RMA-17062026-0099' }]
    expect(generateRmaNumber(existing)).toBe('RMA-17062026-0100')
  })

  it('ignores tickets from a different day', () => {
    const existing = [{ rma_number: 'RMA-16062026-0050' }]
    expect(generateRmaNumber(existing)).toBe('RMA-17062026-0001')
  })

  it('ignores tickets with no rma_number', () => {
    const existing = [{ rma_number: null }, {}]
    expect(generateRmaNumber(existing)).toBe('RMA-17062026-0001')
  })
})

// ── getStatusColor ─────────────────────────────────────────────────────────────

describe('getStatusColor', () => {
  test.each([
    'Open',
    'In Progress',
    'Pending',
    'On Hold',
    'Completed',
    'Closed',
    'Cancelled',
  ])('returns a non-fallback class string for known status %s', (status) => {
    expect(getStatusColor(status)).not.toContain('bg-gray-100')
  })

  it('falls back to gray for an unknown status', () => {
    expect(getStatusColor('NotARealStatus')).toContain('bg-gray-100')
  })

  it('falls back to gray for undefined', () => {
    expect(getStatusColor(undefined)).toContain('bg-gray-100')
  })
})

// ── getPriorityColor ────────────────────────────────────────────────────────────

describe('getPriorityColor', () => {
  test.each(['Low', 'Medium', 'High', 'Critical'])(
    'returns a class string for known priority %s',
    (priority) => {
      expect(getPriorityColor(priority)).toBeTruthy()
    }
  )

  it('falls back to gray for an unknown priority', () => {
    expect(getPriorityColor('NotARealPriority')).toContain('bg-gray-100')
  })

  it('falls back to gray for undefined', () => {
    expect(getPriorityColor(undefined)).toContain('bg-gray-100')
  })
})
