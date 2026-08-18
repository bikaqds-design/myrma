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
  LEAD_STATUS,
  LEAD_STATUS_LIST,
  LEAD_SOURCE,
  LEAD_SOURCE_LIST,
  DEAL_STATUS,
  DEAL_STATUS_LIST,
  ACTIVITY_TYPE,
  ACTIVITY_TYPE_LIST,
  LIFECYCLE_STAGE,
  LIFECYCLE_STAGE_LIST,
} from '../lib/constants'

// ── ROLES ──────────────────────────────────────────────────────────────────────

describe('ROLES', () => {
  test.each([
    ['SUPER_ADMIN', 'super_admin'],
    ['ADMIN', 'admin'],
    ['MANAGER', 'manager'],
    ['TECHNICIAN', 'technician'],
    ['VIEWER', 'viewer'],
    ['SALES_REP', 'sales_rep'],
  ])('ROLES.%s === %s', (key, value) => {
    expect(ROLES[key]).toBe(value)
  })

  // Derived, not counted. This asserted a hardcoded length of 6 and broke the
  // moment a seventh role was added — which is the right failure, but it says
  // "the number changed" rather than "you forgot to list it". Comparing the two
  // sets says the second thing, and cannot go stale.
  it('ROLE_LIST contains exactly the roles in ROLES', () => {
    expect([...ROLE_LIST].sort()).toEqual(Object.values(ROLES).sort())
  })

  it('has no duplicate entries', () => {
    expect(new Set(ROLE_LIST).size).toBe(ROLE_LIST.length)
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

// ── CRM constants ─────────────────────────────────────────────────────────────

describe('LEAD_STATUS', () => {
  test.each([
    ['NEW', 'new'],
    ['CONTACTED', 'contacted'],
    ['QUALIFIED', 'qualified'],
    ['NURTURING', 'nurturing'],
    ['INACTIVE', 'inactive'],
    ['CONVERTED', 'converted'],
    ['DISQUALIFIED', 'disqualified'],
  ])('LEAD_STATUS.%s === %s', (key, value) => {
    expect(LEAD_STATUS[key]).toBe(value)
  })

  it('LEAD_STATUS_LIST stays in sync with LEAD_STATUS', () => {
    expect(LEAD_STATUS_LIST).toHaveLength(7)
    for (const v of Object.values(LEAD_STATUS)) {
      expect(LEAD_STATUS_LIST).toContain(v)
    }
  })
})

describe('LEAD_SOURCE', () => {
  test.each([
    ['WALK_IN', 'walk-in'],
    ['PHONE', 'phone'],
    ['REFERRAL', 'referral'],
    ['EXHIBITION', 'exhibition'],
    ['WEBSITE', 'website'],
    ['WHATSAPP', 'whatsapp'],
  ])('LEAD_SOURCE.%s === %s', (key, value) => {
    expect(LEAD_SOURCE[key]).toBe(value)
  })

  it('LEAD_SOURCE_LIST stays in sync with LEAD_SOURCE', () => {
    expect(LEAD_SOURCE_LIST).toHaveLength(6)
    for (const v of Object.values(LEAD_SOURCE)) {
      expect(LEAD_SOURCE_LIST).toContain(v)
    }
  })
})

describe('DEAL_STATUS', () => {
  test.each([
    ['OPEN', 'open'],
    ['WON', 'won'],
    ['LOST', 'lost'],
  ])('DEAL_STATUS.%s === %s', (key, value) => {
    expect(DEAL_STATUS[key]).toBe(value)
  })

  it('DEAL_STATUS_LIST stays in sync with DEAL_STATUS', () => {
    expect(DEAL_STATUS_LIST).toHaveLength(3)
    for (const v of Object.values(DEAL_STATUS)) {
      expect(DEAL_STATUS_LIST).toContain(v)
    }
  })
})

describe('ACTIVITY_TYPE', () => {
  test.each([
    ['CALL', 'call'],
    ['MEETING', 'meeting'],
    ['WHATSAPP', 'whatsapp'],
    ['EMAIL', 'email'],
    ['NOTE', 'note'],
    ['TASK', 'task'],
    ['LOG', 'log'],
  ])('ACTIVITY_TYPE.%s === %s', (key, value) => {
    expect(ACTIVITY_TYPE[key]).toBe(value)
  })

  it('ACTIVITY_TYPE_LIST stays in sync with ACTIVITY_TYPE', () => {
    expect(ACTIVITY_TYPE_LIST).toHaveLength(7)
    for (const v of Object.values(ACTIVITY_TYPE)) {
      expect(ACTIVITY_TYPE_LIST).toContain(v)
    }
  })
})

describe('LIFECYCLE_STAGE', () => {
  test.each([
    ['LEAD', 'lead'],
    ['PROSPECT', 'prospect'],
    ['CUSTOMER', 'customer'],
    ['CHURNED', 'churned'],
  ])('LIFECYCLE_STAGE.%s === %s', (key, value) => {
    expect(LIFECYCLE_STAGE[key]).toBe(value)
  })

  it('LIFECYCLE_STAGE_LIST stays in sync with LIFECYCLE_STAGE', () => {
    expect(LIFECYCLE_STAGE_LIST).toHaveLength(4)
    for (const v of Object.values(LIFECYCLE_STAGE)) {
      expect(LIFECYCLE_STAGE_LIST).toContain(v)
    }
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
