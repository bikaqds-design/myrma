/**
 * constants.test.js — Unit tests for src/lib/constants.ts
 *
 * Verifies that constants are correct values (not renamed by accident),
 * derived lists are consistent with their source objects, and helper
 * functions return the right types.
 */
import { describe, it, expect, test } from 'vitest'
import {
  ROLES,
  ROLE_LIST,
  TICKET_STATUS,
  TICKET_STATUS_LIST,
  TICKET_STATUS_ACTIVE,
  TICKET_STATUS_RESOLVED,
  PRIORITY,
  PRIORITY_LIST,
  PRIORITY_WEIGHT,
  INVENTORY_STATUS,
  BATCH_STATUS,
  AUTOMATION_ACTION,
  CONFIG_KEY,
  STORAGE_KEY,
  WARRANTY_STATUS,
  WARRANTY_STATUS_LIST,
} from '../lib/constants'

// ── ROLES ──────────────────────────────────────────────────────────────────────

describe('ROLES', () => {
  test.each([
    ['SUPER_ADMIN', 'super_admin'],
    ['ADMIN', 'admin'],
    ['MANAGER', 'manager'],
    ['TECHNICIAN', 'technician'],
    ['VIEWER', 'viewer'],
  ])('ROLES.%s === %s', (key, value) => {
    expect(ROLES[key]).toBe(value)
  })

  it('ROLE_LIST stays in sync with ROLES', () => {
    expect(ROLE_LIST).toHaveLength(5)
    expect(ROLE_LIST).toContain(ROLES.SUPER_ADMIN)
    expect(ROLE_LIST).toContain(ROLES.VIEWER)
  })
})

// ── TICKET_STATUS ─────────────────────────────────────────────────────────────

describe('TICKET_STATUS', () => {
  test.each([
    ['OPEN', 'Open'],
    ['IN_PROGRESS', 'In Progress'],
    ['PENDING', 'Pending'],
    ['ON_HOLD', 'On Hold'],
    ['COMPLETED', 'Completed'],
    ['CLOSED', 'Closed'],
    ['CANCELLED', 'Cancelled'],
  ])('TICKET_STATUS.%s === %s', (key, value) => {
    expect(TICKET_STATUS[key]).toBe(value)
  })

  it('TICKET_STATUS_LIST stays in sync with TICKET_STATUS', () => {
    expect(TICKET_STATUS_LIST).toHaveLength(7)
    for (const v of Object.values(TICKET_STATUS)) {
      expect(TICKET_STATUS_LIST).toContain(v)
    }
  })

  it('TICKET_STATUS_ACTIVE + TICKET_STATUS_RESOLVED = full set', () => {
    const all = [...TICKET_STATUS_ACTIVE, ...TICKET_STATUS_RESOLVED]
    for (const v of Object.values(TICKET_STATUS)) {
      expect(all).toContain(v)
    }
  })

  it('Closed, Cancelled, and Completed are resolved', () => {
    expect(TICKET_STATUS_RESOLVED).toContain(TICKET_STATUS.COMPLETED)
    expect(TICKET_STATUS_RESOLVED).toContain(TICKET_STATUS.CLOSED)
    expect(TICKET_STATUS_RESOLVED).toContain(TICKET_STATUS.CANCELLED)
  })
})

// ── PRIORITY ──────────────────────────────────────────────────────────────────

describe('PRIORITY', () => {
  test.each([
    ['CRITICAL', 'Critical'],
    ['HIGH', 'High'],
    ['MEDIUM', 'Medium'],
    ['LOW', 'Low'],
  ])('PRIORITY.%s === %s', (key, value) => {
    expect(PRIORITY[key]).toBe(value)
  })

  it('PRIORITY_LIST stays in sync with PRIORITY', () => {
    expect(PRIORITY_LIST).toHaveLength(4)
    for (const v of Object.values(PRIORITY)) {
      expect(PRIORITY_LIST).toContain(v)
    }
  })

  it('PRIORITY_WEIGHT assigns 0 to Critical (most urgent)', () => {
    expect(PRIORITY_WEIGHT[PRIORITY.CRITICAL]).toBe(0)
  })

  it('PRIORITY_WEIGHT assigns higher numbers to less urgent', () => {
    expect(PRIORITY_WEIGHT[PRIORITY.CRITICAL]).toBeLessThan(PRIORITY_WEIGHT[PRIORITY.HIGH])
    expect(PRIORITY_WEIGHT[PRIORITY.HIGH]).toBeLessThan(PRIORITY_WEIGHT[PRIORITY.MEDIUM])
    expect(PRIORITY_WEIGHT[PRIORITY.MEDIUM]).toBeLessThan(PRIORITY_WEIGHT[PRIORITY.LOW])
  })
})

// ── INVENTORY_STATUS / BATCH_STATUS ──────────────────────────────────────────

describe('INVENTORY_STATUS', () => {
  test.each([
    ['ACTIVE_RMA', 'active_rma'],
    ['COMPANY_STOCK', 'company_stock'],
    ['SENT_TO_MANUFACTURER', 'sent_to_manufacturer'],
    ['CLOSED', 'closed'],
  ])('INVENTORY_STATUS.%s === %s', (key, value) => {
    expect(INVENTORY_STATUS[key]).toBe(value)
  })
})

describe('BATCH_STATUS', () => {
  test.each([
    ['DRAFT', 'draft'],
    ['SENT', 'sent'],
    ['RESOLVED', 'resolved'],
  ])('BATCH_STATUS.%s === %s', (key, value) => {
    expect(BATCH_STATUS[key]).toBe(value)
  })
})

// ── STORAGE_KEY ───────────────────────────────────────────────────────────────

describe('STORAGE_KEY', () => {
  it('NOTIF_PREFS is a function that accepts an email', () => {
    expect(STORAGE_KEY.NOTIF_PREFS('user@test.com')).toBe('notif_system_prefs_user@test.com')
  })

  it('APPEARANCE and AUDIT_QUEUE have expected storage key values', () => {
    expect(STORAGE_KEY.APPEARANCE).toBe('mrma_appearance')
    expect(STORAGE_KEY.AUDIT_QUEUE).toBe('mrma_audit_queue')
  })
})

// ── WARRANTY_STATUS ───────────────────────────────────────────────────────────

describe('WARRANTY_STATUS', () => {
  it('WARRANTY_STATUS_LIST stays in sync with WARRANTY_STATUS', () => {
    for (const v of Object.values(WARRANTY_STATUS)) {
      expect(WARRANTY_STATUS_LIST).toContain(v)
    }
  })
})

// ── AUTOMATION_ACTION ─────────────────────────────────────────────────────────

describe('AUTOMATION_ACTION', () => {
  test.each([
    ['CHANGE_STATUS', 'change_status'],
    ['CHANGE_PRIORITY', 'change_priority'],
    ['ASSIGN_TECHNICIAN', 'assign_technician'],
    ['CREATE_NOTIFICATION', 'create_notification'],
  ])('AUTOMATION_ACTION.%s === %s', (key, value) => {
    expect(AUTOMATION_ACTION[key]).toBe(value)
  })
})

// ── CONFIG_KEY ────────────────────────────────────────────────────────────────

describe('CONFIG_KEY', () => {
  test.each([
    ['SLA_CONFIG', 'sla_config'],
    ['AUTOMATION_RULES', 'automation_rules'],
    ['APPEARANCE', 'appearance_settings'],
  ])('CONFIG_KEY.%s === %s', (key, value) => {
    expect(CONFIG_KEY[key]).toBe(value)
  })
})
