import { describe, it, expect } from 'vitest'
import { TICKET_DEFAULTS, normaliseTicketDefaults } from '../lib/ticketDefaults'

describe('normaliseTicketDefaults (BUG-027)', () => {
  it('keeps a valid stored configuration', () => {
    expect(normaliseTicketDefaults({
      default_priority: 'High',
      default_status: 'In Progress',
      auto_due_days: 3,
    })).toEqual({ default_priority: 'High', default_status: 'In Progress', auto_due_days: 3 })
  })

  it("falls back for a status this build no longer has — 'New' is the live case", () => {
    // A blank <select> silently saves whichever option the next edit lands on,
    // so an unknown value must become a known-good one rather than nothing.
    const result = normaliseTicketDefaults({ default_status: 'New' })
    expect(result.default_status).toBe(TICKET_DEFAULTS.default_status)
  })

  it('falls back for an unknown priority', () => {
    expect(normaliseTicketDefaults({ default_priority: 'Urgent' }).default_priority)
      .toBe(TICKET_DEFAULTS.default_priority)
  })

  it('clamps a due-date window that would land before the ticket exists', () => {
    expect(normaliseTicketDefaults({ auto_due_days: 0 }).auto_due_days).toBe(1)
    expect(normaliseTicketDefaults({ auto_due_days: -30 }).auto_due_days).toBe(1)
  })

  it('clamps an absurdly distant due date to a year', () => {
    expect(normaliseTicketDefaults({ auto_due_days: 99999 }).auto_due_days).toBe(365)
  })

  it('replaces a non-numeric due-date window rather than producing NaN dates', () => {
    expect(normaliseTicketDefaults({ auto_due_days: 'soon' }).auto_due_days)
      .toBe(TICKET_DEFAULTS.auto_due_days)
    expect(normaliseTicketDefaults({ auto_due_days: null }).auto_due_days)
      .toBe(TICKET_DEFAULTS.auto_due_days)
  })

  it('truncates a fractional day count', () => {
    expect(normaliseTicketDefaults({ auto_due_days: 4.9 }).auto_due_days).toBe(4)
  })

  it('returns the built-in defaults for a missing or malformed row', () => {
    expect(normaliseTicketDefaults(undefined)).toEqual(TICKET_DEFAULTS)
    expect(normaliseTicketDefaults(null)).toEqual(TICKET_DEFAULTS)
    expect(normaliseTicketDefaults('nonsense')).toEqual(TICKET_DEFAULTS)
    expect(normaliseTicketDefaults({})).toEqual(TICKET_DEFAULTS)
  })
})
