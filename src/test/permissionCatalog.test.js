/**
 * The editor showed eleven modules for months while the runtime enforced
 * nineteen. Eight CRM permissions were stored, honoured, and invisible.
 *
 * These tests exist so that cannot happen again: the catalog is checked against
 * ROLE_DEFAULT_PERMISSIONS rather than against a list someone has to remember
 * to update.
 */
import { describe, it, expect } from 'vitest'
import {
  permissionSchema,
  permissionGroups,
  MODULE_GROUPS,
  MODULE_LABEL_KEYS,
  SENSITIVE_ACTIONS,
} from '../lib/permissionCatalog'
import { ROLE_DEFAULT_PERMISSIONS, canDo } from '../lib/permissions'
import { ROLES } from '../lib/constants'

const allModules = () => Object.keys(permissionSchema())

describe('permissionSchema', () => {
  it('unions every module across every role, not just the broadest one', () => {
    for (const role of Object.keys(ROLE_DEFAULT_PERMISSIONS)) {
      for (const section of Object.keys(ROLE_DEFAULT_PERMISSIONS[role])) {
        expect(allModules()).toContain(section)
      }
    }
  })

  it('includes the CRM modules the old hardcoded editor omitted', () => {
    for (const m of ['deals', 'leads', 'activities', 'contacts', 'pipelines',
                     'sales', 'accounting', 'purchasing']) {
      expect(allModules()).toContain(m)
    }
  })

  it('no longer includes the retired invoices module', () => {
    expect(allModules()).not.toContain('invoices')
  })

  it('unions actions across roles, so a partial role cannot hide one', () => {
    // accountant has accounting.record_payment; no other role adds anything
    // accounting-specific that manager lacks — the union must hold both.
    expect(permissionSchema().accounting).toEqual(
      expect.arrayContaining(['view', 'record_payment', 'reverse_payment', 'export'])
    )
  })
})

describe('permissionGroups', () => {
  it('renders every module in the schema — nothing is silently dropped', () => {
    const rendered = permissionGroups().flatMap((g) => g.modules.map((m) => m.key))
    expect([...rendered].sort()).toEqual(allModules().sort())
  })

  it('puts an unrecognised module in Other rather than discarding it', () => {
    // Every module currently has a home, so Other should be absent. If this
    // fails, a module was added to permissions.ts without a group — which is
    // fine functionally, and this test is the reminder to place it.
    const other = permissionGroups().find((g) => g.id === 'other')
    const unplaced = other ? other.modules.map((m) => m.key) : []
    expect(unplaced).toEqual([])
  })

  it('lists no module in two groups', () => {
    const all = MODULE_GROUPS.flatMap((g) => g.modules)
    expect(new Set(all).size).toBe(all.length)
  })

  it('has a label key for every module it groups', () => {
    for (const key of MODULE_GROUPS.flatMap((g) => g.modules)) {
      expect(MODULE_LABEL_KEYS).toHaveProperty(key)
    }
  })
})

describe('sensitive actions', () => {
  it('marks the ones that move money or widen access', () => {
    for (const a of ['post', 'cancel', 'approve', 'record_payment',
                     'reverse_payment', 'delete', 'manage_permissions', 'view_all']) {
      expect(SENSITIVE_ACTIONS.has(a)).toBe(true)
    }
  })

  it('does not mark plain reads', () => {
    for (const a of ['view', 'export', 'view_history']) {
      expect(SENSITIVE_ACTIONS.has(a)).toBe(false)
    }
  })
})

// ── The accountant role ──────────────────────────────────────────────────────
// Segregation of duties: no one person authorises, executes and records a
// payment. The accountant records and reverses; raising and approving sit
// elsewhere. These assertions are the control, so a future edit that quietly
// hands the accountant invoicing rights fails here.

describe('accountant role', () => {
  const perms = ROLE_DEFAULT_PERMISSIONS[ROLES.ACCOUNTANT]

  it('exists with defaults', () => {
    expect(perms).toBeTruthy()
  })

  it('owns the cash: records and reverses payments on both sides', () => {
    expect(perms.accounting.record_payment).toBe(true)
    expect(perms.accounting.reverse_payment).toBe(true)
  })

  it('can read both document sides in full, to reconcile', () => {
    expect(perms.sales.view).toBe(true)
    expect(perms.sales.view_all).toBe(true)
    expect(perms.purchasing.view).toBe(true)
  })

  it('cannot originate or finalise a sales document', () => {
    for (const a of ['create', 'edit', 'delete', 'post', 'cancel']) {
      expect(perms.sales[a]).toBe(false)
    }
  })

  it('cannot raise, approve or receive a purchase', () => {
    for (const a of ['create', 'edit', 'approve', 'receive', 'cancel', 'manage_vendors']) {
      expect(perms.purchasing[a]).toBe(false)
    }
  })

  it('has no pipeline or workshop access at all', () => {
    for (const m of ['deals', 'leads', 'activities', 'pipelines', 'contacts',
                     'rma_tickets', 'inventory', 'user_management']) {
      expect(perms).not.toHaveProperty(m)
    }
  })

  it('can chase collections: customer record and history, read-only', () => {
    expect(perms.customers.view).toBe(true)
    expect(perms.customers.view_history).toBe(true)
    expect(perms.customers.edit).toBe(false)
  })
})

// ── The cross-tier warning ───────────────────────────────────────────────────
// The editor renders all 18 modules for every user, so an admin can grant any
// role anything. This warning is what tells them the server will refuse. It was
// blind to sales, accounting and purchasing entirely — a viewer could be given
// accounting.record_payment, it saved cleanly, and nothing said a word.
//
// getCrossTierPermissions is not exported, so these assert the rules it encodes
// via the role defaults, which is what the warning is checked against.

describe('server-side ceilings the editor must warn about', () => {
  // Roles that no role default gives these to, and the database refuses.
  const CANNOT = [
    [ROLES.VIEWER, 'accounting', 'record_payment'],
    [ROLES.TECHNICIAN, 'accounting', 'record_payment'],
    [ROLES.SALES_REP, 'accounting', 'record_payment'],
    [ROLES.SALES_REP, 'accounting', 'reverse_payment'],
    [ROLES.SALES_REP, 'sales', 'post'],
    [ROLES.SALES_REP, 'sales', 'cancel'],
    [ROLES.SALES_REP, 'purchasing', 'create'],
    [ROLES.ACCOUNTANT, 'sales', 'create'],
    [ROLES.ACCOUNTANT, 'sales', 'edit'],
    [ROLES.ACCOUNTANT, 'sales', 'post'],
    [ROLES.ACCOUNTANT, 'purchasing', 'create'],
    [ROLES.ACCOUNTANT, 'purchasing', 'approve'],
  ]

  it.each(CANNOT)('%s must not hold %s.%s by default', (role, section, action) => {
    expect(canDo(role, ROLE_DEFAULT_PERMISSIONS[role], section, action)).toBe(false)
  })

  // The converse: the roles the database does permit must actually have it, or
  // the ceiling would warn about a legitimate grant.
  it('manager holds every money action except approve', () => {
    const m = ROLE_DEFAULT_PERMISSIONS[ROLES.MANAGER]
    for (const [s, a] of [['sales','create'],['sales','edit'],['sales','post'],
                          ['sales','cancel'],['accounting','record_payment'],
                          ['accounting','reverse_payment'],['purchasing','create'],
                          ['purchasing','receive']]) {
      expect(canDo(ROLES.MANAGER, m, s, a), `${s}.${a}`).toBe(true)
    }
    expect(canDo(ROLES.MANAGER, m, 'purchasing', 'approve')).toBe(false)
  })

  it('accountant holds the cash actions the database allows it', () => {
    const a = ROLE_DEFAULT_PERMISSIONS[ROLES.ACCOUNTANT]
    expect(canDo(ROLES.ACCOUNTANT, a, 'accounting', 'record_payment')).toBe(true)
    expect(canDo(ROLES.ACCOUNTANT, a, 'accounting', 'reverse_payment')).toBe(true)
  })

  it('sales_rep holds the sales writes the database allows it', () => {
    const r = ROLE_DEFAULT_PERMISSIONS[ROLES.SALES_REP]
    expect(canDo(ROLES.SALES_REP, r, 'sales', 'create')).toBe(true)
    expect(canDo(ROLES.SALES_REP, r, 'sales', 'edit')).toBe(true)
  })

  it('every module the warning references still exists in the schema', () => {
    const schema = permissionSchema()
    for (const [, section, action] of CANNOT) {
      expect(schema, section).toHaveProperty(section)
      expect(schema[section], `${section}.${action}`).toContain(action)
    }
  })
})
