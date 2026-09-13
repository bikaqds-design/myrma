import { describe, it, expect } from 'vitest'
import {
  isAssignedTo,
  canEditTicket,
  canChangeTicketStatus,
  partitionTickets,
} from '../lib/ticketPermissions'

/** A section-bound canDo, as the RMA screens build it, from a flag object. */
const flags = (granted) => (action) => Boolean(granted[action])

// Presets as they stand in src/lib/permissions.ts.
const manager = flags({ edit_all: true, edit_assigned: true, change_status: true })
const technician = flags({ edit_all: false, edit_assigned: true, change_status: true })
const viewer = flags({})

const mine = { id: 'a', assigned_technician: 'tech@qds.test' }
const theirs = { id: 'b', assigned_technician: 'other@qds.test' }
const unassigned = { id: 'c', assigned_technician: null }

describe('canEditTicket (BUG-071)', () => {
  it('lets edit_all edit any ticket, assigned or not', () => {
    expect(canEditTicket(manager, theirs, 'manager@qds.test')).toBe(true)
    expect(canEditTicket(manager, unassigned, 'manager@qds.test')).toBe(true)
  })

  it('lets edit_assigned edit only the tickets assigned to that person', () => {
    expect(canEditTicket(technician, mine, 'tech@qds.test')).toBe(true)
    expect(canEditTicket(technician, theirs, 'tech@qds.test')).toBe(false)
    expect(canEditTicket(technician, unassigned, 'tech@qds.test')).toBe(false)
  })

  it('gives a viewer nothing', () => {
    expect(canEditTicket(viewer, mine, 'tech@qds.test')).toBe(false)
  })
})

describe('canChangeTicketStatus', () => {
  it('scopes change_status to assigned tickets unless edit_all is held — the bulk-action gap', () => {
    const statusOnly = flags({ change_status: true })
    expect(canChangeTicketStatus(statusOnly, mine, 'tech@qds.test')).toBe(true)
    expect(canChangeTicketStatus(statusOnly, theirs, 'tech@qds.test')).toBe(false)
  })

  it('lets edit_all change any status', () => {
    expect(canChangeTicketStatus(manager, theirs, 'manager@qds.test')).toBe(true)
  })

  it('treats edit_assigned as covering the status of your own tickets, as the inline pill already did', () => {
    const assignedOnly = flags({ edit_assigned: true })
    expect(canChangeTicketStatus(assignedOnly, mine, 'tech@qds.test')).toBe(true)
  })

  it('gives a viewer nothing', () => {
    expect(canChangeTicketStatus(viewer, mine, 'tech@qds.test')).toBe(false)
  })
})

describe('isAssignedTo', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(isAssignedTo({ assigned_technician: ' Tech@QDS.test ' }, 'tech@qds.test')).toBe(true)
  })

  it('never matches an empty assignee to an empty identity', () => {
    // Otherwise a session with no email would "own" every unassigned ticket.
    expect(isAssignedTo({ assigned_technician: '' }, '')).toBe(false)
    expect(isAssignedTo({ assigned_technician: null }, undefined)).toBe(false)
    expect(isAssignedTo(null, 'tech@qds.test')).toBe(false)
  })
})

describe('partitionTickets', () => {
  it('splits a selection by permission, keeping order and dropping missing rows', () => {
    const { permitted, skipped } = partitionTickets(
      [mine, theirs, undefined, unassigned],
      (t) => canEditTicket(technician, t, 'tech@qds.test')
    )
    expect(permitted.map((t) => t.id)).toEqual(['a'])
    expect(skipped.map((t) => t.id)).toEqual(['b', 'c'])
  })
})
