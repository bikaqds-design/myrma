/**
 * constants.test.js — Unit tests for src/lib/constants.ts
 *
 * Verifies that constants are correct values (not renamed by accident),
 * derived lists are consistent with their source objects, and helper
 * functions return the right types.
 */
import { describe, it, expect } from 'vitest'
import {
  ROLES, ROLE_LIST,
  TICKET_STATUS, TICKET_STATUS_LIST, TICKET_STATUS_ACTIVE, TICKET_STATUS_RESOLVED,
  PRIORITY, PRIORITY_LIST, PRIORITY_WEIGHT,
  INVENTORY_STATUS, BATCH_STATUS,
  NOTIF_TYPE, AUTOMATION_ACTION,
  CONFIG_KEY, STORAGE_KEY,
  CUSTOMER_STATUS, PRODUCT_STATUS,
  WARRANTY_STATUS, WARRANTY_STATUS_LIST,
} from '../lib/constants'

// ── ROLES ──────────────────────────────────────────────────────────────────────

describe('ROLES', () => {
  it('defines all five roles', () => {
    expect(ROLES.SUPER_ADMIN).toBe('super_admin')
    expect(ROLES.ADMIN).toBe('admin')
    expect(ROLES.MANAGER).toBe('manager')
    expect(ROLES.TECHNICIAN).toBe('technician')
    expect(ROLES.VIEWER).toBe('viewer')
  })

  it('ROLE_LIST contains all five roles', () => {
    expect(ROLE_LIST).toHaveLength(5)
    expect(ROLE_LIST).toContain(ROLES.SUPER_ADMIN)
    expect(ROLE_LIST).toContain(ROLES.VIEWER)
  })
})

// ── TICKET_STATUS ─────────────────────────────────────────────────────────────

describe('TICKET_STATUS', () => {
  it('defines the six canonical statuses', () => {
    expect(TICKET_STATUS.OPEN).toBe('Open')
    expect(TICKET_STATUS.IN_PROGRESS).toBe('In Progress')
    expect(TICKET_STATUS.PENDING).toBe('Pending')
    expect(TICKET_STATUS.ON_HOLD).toBe('On Hold')
    expect(TICKET_STATUS.CLOSED).toBe('Closed')
    expect(TICKET_STATUS.CANCELLED).toBe('Cancelled')
  })

  it('TICKET_STATUS_LIST contains all six statuses', () => {
    expect(TICKET_STATUS_LIST).toHaveLength(6)
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

  it('Closed and Cancelled are resolved', () => {
    expect(TICKET_STATUS_RESOLVED).toContain(TICKET_STATUS.CLOSED)
    expect(TICKET_STATUS_RESOLVED).toContain(TICKET_STATUS.CANCELLED)
  })
})

// ── PRIORITY ──────────────────────────────────────────────────────────────────

describe('PRIORITY', () => {
  it('defines four priorities', () => {
    expect(PRIORITY.CRITICAL).toBe('Critical')
    expect(PRIORITY.HIGH).toBe('High')
    expect(PRIORITY.MEDIUM).toBe('Medium')
    expect(PRIORITY.LOW).toBe('Low')
  })

  it('PRIORITY_LIST has all four', () => {
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
  it('defines expected values', () => {
    expect(INVENTORY_STATUS.ACTIVE_RMA).toBe('active_rma')
    expect(INVENTORY_STATUS.COMPANY_STOCK).toBe('company_stock')
    expect(INVENTORY_STATUS.SENT_TO_MANUFACTURER).toBe('sent_to_manufacturer')
    expect(INVENTORY_STATUS.CLOSED).toBe('closed')
  })
})

describe('BATCH_STATUS', () => {
  it('defines draft/sent/resolved', () => {
    expect(BATCH_STATUS.DRAFT).toBe('draft')
    expect(BATCH_STATUS.SENT).toBe('sent')
    expect(BATCH_STATUS.RESOLVED).toBe('resolved')
  })
})

// ── STORAGE_KEY ───────────────────────────────────────────────────────────────

describe('STORAGE_KEY', () => {
  it('NOTIF_PREFS is a function that accepts an email', () => {
    expect(typeof STORAGE_KEY.NOTIF_PREFS).toBe('function')
    expect(STORAGE_KEY.NOTIF_PREFS('user@test.com')).toBe('notif_system_prefs_user@test.com')
  })

  it('APPEARANCE and AUDIT_QUEUE are strings', () => {
    expect(typeof STORAGE_KEY.APPEARANCE).toBe('string')
    expect(typeof STORAGE_KEY.AUDIT_QUEUE).toBe('string')
  })
})

// ── WARRANTY_STATUS ───────────────────────────────────────────────────────────

describe('WARRANTY_STATUS', () => {
  it('WARRANTY_STATUS_LIST matches all values', () => {
    for (const v of Object.values(WARRANTY_STATUS)) {
      expect(WARRANTY_STATUS_LIST).toContain(v)
    }
  })
})

// ── AUTOMATION_ACTION ─────────────────────────────────────────────────────────

describe('AUTOMATION_ACTION', () => {
  it('defines expected action types', () => {
    expect(AUTOMATION_ACTION.CHANGE_STATUS).toBe('change_status')
    expect(AUTOMATION_ACTION.CHANGE_PRIORITY).toBe('change_priority')
    expect(AUTOMATION_ACTION.ASSIGN_TECHNICIAN).toBe('assign_technician')
    expect(AUTOMATION_ACTION.CREATE_NOTIFICATION).toBe('create_notification')
  })
})

// ── CONFIG_KEY ────────────────────────────────────────────────────────────────

describe('CONFIG_KEY', () => {
  it('defines expected keys', () => {
    expect(CONFIG_KEY.SLA_CONFIG).toBe('sla_config')
    expect(CONFIG_KEY.AUTOMATION_RULES).toBe('automation_rules')
    expect(CONFIG_KEY.APPEARANCE).toBe('appearance_settings')
  })
})
