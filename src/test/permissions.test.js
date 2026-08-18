/**
 * permissions.test.js — Unit tests for src/lib/permissions.ts
 *
 * Covers: canDo() helper, ROLE_DEFAULT_PERMISSIONS structure
 */
import { describe, it, expect, test } from 'vitest'
import {
  canDo,
  resolvePermissions,
  ownershipScope,
  NO_OWNER_MATCH,
  ROLE_DEFAULT_PERMISSIONS,
} from '../lib/permissions'
import { ROLES } from '../lib/constants'

// ── canDo — admin bypass ──────────────────────────────────────────────────────

describe('canDo — super_admin / admin bypass', () => {
  it('super_admin can do anything regardless of permissions', () => {
    expect(canDo(ROLES.SUPER_ADMIN, {}, 'rma_tickets', 'delete')).toBe(true)
    expect(canDo(ROLES.SUPER_ADMIN, null, 'user_management', 'create_users')).toBe(true)
    expect(canDo(ROLES.SUPER_ADMIN, undefined, 'products', 'import')).toBe(true)
  })

  it('admin can do anything regardless of permissions', () => {
    expect(canDo(ROLES.ADMIN, {}, 'rma_tickets', 'delete')).toBe(true)
    expect(canDo(ROLES.ADMIN, null, 'user_management', 'create_users')).toBe(true)
  })
})

// ── canDo — permission object lookup ─────────────────────────────────────────

describe('canDo — permission object lookup', () => {
  const perms = {
    rma_tickets: { view_all: true, delete: false },
    products: { view: true, create: false },
  }

  it('returns true when permission is explicitly true', () => {
    expect(canDo(ROLES.MANAGER, perms, 'rma_tickets', 'view_all')).toBe(true)
    expect(canDo(ROLES.MANAGER, perms, 'products', 'view')).toBe(true)
  })

  it('returns false when permission is explicitly false', () => {
    expect(canDo(ROLES.MANAGER, perms, 'rma_tickets', 'delete')).toBe(false)
    expect(canDo(ROLES.MANAGER, perms, 'products', 'create')).toBe(false)
  })

  it('returns false for unknown section', () => {
    expect(canDo(ROLES.TECHNICIAN, perms, 'no_such_module', 'delete')).toBe(false)
  })

  it('returns false for unknown action within known section', () => {
    expect(canDo(ROLES.VIEWER, perms, 'products', 'import')).toBe(false)
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
  ])('returns false when permissions is %s', (_label, perms) => {
    expect(canDo(ROLES.MANAGER, perms, 'rma_tickets', 'view_all')).toBe(false)
  })
})

// ── resolvePermissions — PERM-1 empty/partial-object trap ────────────────────

describe('resolvePermissions — the manager-can\'t-create regression guard', () => {
  it('falls back to role defaults when stored is null', () => {
    const resolved = resolvePermissions(ROLES.MANAGER, null)
    expect(canDo(ROLES.MANAGER, resolved, 'products', 'create')).toBe(true)
    expect(canDo(ROLES.MANAGER, resolved, 'rma_tickets', 'create')).toBe(true)
    expect(canDo(ROLES.MANAGER, resolved, 'customers', 'create')).toBe(true)
  })

  it('falls back to role defaults when stored is an empty object (the truthy trap)', () => {
    const resolved = resolvePermissions(ROLES.MANAGER, {})
    expect(canDo(ROLES.MANAGER, resolved, 'products', 'create')).toBe(true)
    expect(canDo(ROLES.MANAGER, resolved, 'rma_tickets', 'create')).toBe(true)
  })

  it('fills missing sections from role defaults when stored is partial', () => {
    // stored only overrides products; rma_tickets/customers must still come from defaults
    const resolved = resolvePermissions(ROLES.MANAGER, { products: { create: false } })
    expect(canDo(ROLES.MANAGER, resolved, 'products', 'create')).toBe(false) // explicit override preserved
    expect(canDo(ROLES.MANAGER, resolved, 'products', 'view')).toBe(true) // gap filled from default
    expect(canDo(ROLES.MANAGER, resolved, 'rma_tickets', 'create')).toBe(true) // missing section filled
  })

  it('preserves explicit per-action overrides (including false) over defaults', () => {
    const resolved = resolvePermissions(ROLES.MANAGER, {
      rma_tickets: { delete: true },
    })
    expect(canDo(ROLES.MANAGER, resolved, 'rma_tickets', 'delete')).toBe(true) // override grants
    expect(canDo(ROLES.MANAGER, resolved, 'rma_tickets', 'create')).toBe(true) // default kept
  })

  it('returns defaults for technician/viewer too', () => {
    expect(canDo(ROLES.TECHNICIAN, resolvePermissions(ROLES.TECHNICIAN, {}), 'rma_tickets', 'create')).toBe(false)
    expect(canDo(ROLES.VIEWER, resolvePermissions(ROLES.VIEWER, {}), 'products', 'view')).toBe(true)
  })

  it('uses stored as-is for a role with no built-in defaults (custom role)', () => {
    const stored = { products: { view: true } }
    const resolved = resolvePermissions('support_agent', stored)
    expect(canDo('support_agent', resolved, 'products', 'view')).toBe(true)
    expect(canDo('support_agent', resolved, 'products', 'create')).toBe(false)
  })
})

// ── ROLE_DEFAULT_PERMISSIONS structure ───────────────────────────────────────

describe('ROLE_DEFAULT_PERMISSIONS', () => {
  const requiredRoles = [ROLES.MANAGER, ROLES.TECHNICIAN, ROLES.VIEWER]
  const requiredSections = ['products', 'rma_tickets', 'inventory', 'dashboard', 'user_management']

  it('defines all three non-admin roles', () => {
    for (const role of requiredRoles) {
      expect(ROLE_DEFAULT_PERMISSIONS[role]).toBeDefined()
    }
  })

  it('does not define super_admin or admin (they bypass all checks)', () => {
    expect(ROLE_DEFAULT_PERMISSIONS[ROLES.SUPER_ADMIN]).toBeUndefined()
    expect(ROLE_DEFAULT_PERMISSIONS[ROLES.ADMIN]).toBeUndefined()
  })

  it('each role has all required sections', () => {
    for (const role of requiredRoles) {
      for (const section of requiredSections) {
        expect(
          ROLE_DEFAULT_PERMISSIONS[role][section],
          `${role} missing section ${section}`
        ).toBeDefined()
      }
    }
  })

  it('manager can view rma_tickets', () => {
    expect(ROLE_DEFAULT_PERMISSIONS[ROLES.MANAGER].rma_tickets.view_all).toBe(true)
  })

  it('manager cannot delete rma_tickets', () => {
    expect(ROLE_DEFAULT_PERMISSIONS[ROLES.MANAGER].rma_tickets.delete).toBe(false)
  })

  it('viewer cannot change rma ticket status', () => {
    expect(ROLE_DEFAULT_PERMISSIONS[ROLES.VIEWER].rma_tickets.change_status).toBe(false)
  })

  it('technician can change rma ticket status', () => {
    expect(ROLE_DEFAULT_PERMISSIONS[ROLES.TECHNICIAN].rma_tickets.change_status).toBe(true)
  })

  it('viewer cannot create users', () => {
    expect(ROLE_DEFAULT_PERMISSIONS[ROLES.VIEWER].user_management.create_users).toBe(false)
  })
})

// ── canDo with ROLE_DEFAULT_PERMISSIONS ──────────────────────────────────────

describe('canDo with default permissions', () => {
  test.each([
    [ROLES.MANAGER, 'rma_tickets', 'create', true],
    [ROLES.TECHNICIAN, 'rma_tickets', 'create', false],
    [ROLES.VIEWER, 'rma_tickets', 'create', false],
    [ROLES.MANAGER, 'products', 'export', true],
    [ROLES.VIEWER, 'products', 'export', false],
  ])('%s canDo %s.%s → %s', (role, section, action, expected) => {
    expect(canDo(role, ROLE_DEFAULT_PERMISSIONS[role], section, action)).toBe(expected)
  })
})

// ── sales_rep CRM permissions ─────────────────────────────────────────────────

describe('ROLE_DEFAULT_PERMISSIONS — sales_rep', () => {
  it('is defined', () => {
    expect(ROLE_DEFAULT_PERMISSIONS[ROLES.SALES_REP]).toBeDefined()
  })

  it('has no access to RMA-internal sections (omitted entirely, not set to false)', () => {
    const salesRep = ROLE_DEFAULT_PERMISSIONS[ROLES.SALES_REP]
    expect(salesRep.rma_tickets).toBeUndefined()
    expect(salesRep.inventory).toBeUndefined()
    expect(salesRep.parts).toBeUndefined()
    expect(salesRep.user_management).toBeUndefined()
    expect(salesRep.settings).toBeUndefined()
  })

  test.each([
    ['products', 'view', true],
    ['products', 'create', false],
    ['leads', 'view', true],
    ['leads', 'create', true],
    ['leads', 'edit', true],
    ['leads', 'delete', false],
    ['deals', 'create', true],
    ['deals', 'delete', false],
    ['activities', 'create', true],
    ['contacts', 'view', true],
    ['contacts', 'create', false],
    ['pipelines', 'view', true],
    ['customers', 'view', true],
    ['customers', 'create', false],
    ['customers', 'edit', true],
    ['customers', 'delete', false],
    // `invoices` used to sit here. It was the pre-CRM table that holds 0 rows,
    // retired when sales/accounting/purchasing got real modules.
    ['sales', 'view', true],
    ['sales', 'create', true],
    ['sales', 'edit', true],
    // a rep raises the quotation; finalising revenue is a manager action
    ['sales', 'post', false],
    ['sales', 'cancel', false],
    // reachable today only by borrowing deals.view — deliberately gone
    ['accounting', 'view', false],
    ['purchasing', 'view', false],
  ])('sales_rep canDo %s.%s → %s', (section, action, expected) => {
    expect(canDo(ROLES.SALES_REP, ROLE_DEFAULT_PERMISSIONS[ROLES.SALES_REP], section, action)).toBe(
      expected
    )
  })
})

describe('ROLE_DEFAULT_PERMISSIONS — manager CRM access', () => {
  test.each([
    ['leads', 'view', true],
    ['leads', 'create', true],
    ['deals', 'edit', true],
    ['activities', 'create', true],
    ['contacts', 'create', true],
    ['contacts', 'delete', false],
    ['pipelines', 'view', true],
    ['pipelines', 'edit', false],
  ])('manager canDo %s.%s → %s', (section, action, expected) => {
    expect(canDo(ROLES.MANAGER, ROLE_DEFAULT_PERMISSIONS[ROLES.MANAGER], section, action)).toBe(
      expected
    )
  })
})

// ── The money modules ────────────────────────────────────────────────────────
// Sales, Accounting and Purchasing were all gated on `deals.view` until this
// matrix existed: one CRM toggle decided who could raise a purchase order or
// reverse a payment. These lock in who got what.

describe('ROLE_DEFAULT_PERMISSIONS — money modules', () => {
  const perms = (role) => ROLE_DEFAULT_PERMISSIONS[role]

  it.each([
    ['manager posts and cancels invoices', ROLES.MANAGER, 'sales', 'post', true],
    ['manager reaches the ledger', ROLES.MANAGER, 'accounting', 'record_payment', true],
    ['manager reverses a payment', ROLES.MANAGER, 'accounting', 'reverse_payment', true],
    ['manager raises a PO', ROLES.MANAGER, 'purchasing', 'create', true],
    ['manager receives stock', ROLES.MANAGER, 'purchasing', 'receive', true],
    // separation of duties: a manager may raise spend but not approve it
    ['manager does NOT approve spend', ROLES.MANAGER, 'purchasing', 'approve', false],

    ['sales_rep raises a quotation', ROLES.SALES_REP, 'sales', 'create', true],
    ['sales_rep does NOT post', ROLES.SALES_REP, 'sales', 'post', false],
    ['sales_rep has no ledger', ROLES.SALES_REP, 'accounting', 'view', false],
    ['sales_rep has no purchasing', ROLES.SALES_REP, 'purchasing', 'view', false],

    ['technician has no sales', ROLES.TECHNICIAN, 'sales', 'view', false],
    ['technician has no ledger', ROLES.TECHNICIAN, 'accounting', 'view', false],
    ['technician has no purchasing', ROLES.TECHNICIAN, 'purchasing', 'view', false],

    ['viewer has no sales', ROLES.VIEWER, 'sales', 'view', false],
    ['viewer has no ledger', ROLES.VIEWER, 'accounting', 'view', false],
    ['viewer has no purchasing', ROLES.VIEWER, 'purchasing', 'view', false],
  ])('%s', (_label, role, section, action, expected) => {
    expect(canDo(role, perms(role), section, action)).toBe(expected)
  })

  it('admin and super_admin bypass, so they hold the approval nobody defaults to', () => {
    for (const role of [ROLES.ADMIN, ROLES.SUPER_ADMIN]) {
      expect(canDo(role, null, 'purchasing', 'approve')).toBe(true)
      expect(canDo(role, null, 'pipelines', 'manage')).toBe(true)
    }
  })

  it('no role default grants purchasing.approve — it is admin-only by omission', () => {
    for (const role of [ROLES.MANAGER, ROLES.SALES_REP, ROLES.TECHNICIAN, ROLES.VIEWER]) {
      expect(canDo(role, perms(role), 'purchasing', 'approve')).toBe(false)
    }
  })

  it('no role default grants pipelines.manage', () => {
    for (const role of [ROLES.MANAGER, ROLES.SALES_REP, ROLES.TECHNICIAN, ROLES.VIEWER]) {
      expect(canDo(role, perms(role), 'pipelines', 'manage')).toBe(false)
    }
  })

  it('the retired invoices module is gone from every role', () => {
    for (const role of [ROLES.MANAGER, ROLES.SALES_REP, ROLES.TECHNICIAN, ROLES.VIEWER]) {
      expect(perms(role)).not.toHaveProperty('invoices')
    }
  })

  // resolvePermissions preserves unknown stored sections, so an existing
  // user_roles row still carrying `invoices` is harmless rather than a crash.
  it('a stored row carrying the retired module still resolves', () => {
    const stored = { invoices: { view: true }, sales: { post: true } }
    const merged = resolvePermissions(ROLES.SALES_REP, stored)
    expect(merged.invoices).toEqual({ view: true })
    expect(canDo(ROLES.SALES_REP, merged, 'sales', 'post')).toBe(true)
  })
})

// ── Ownership scoping ────────────────────────────────────────────────────────
// A sales rep must see only their own work. RLS is the boundary; these lock in
// the app-side rule that keeps the interface honest about it.

describe('ownershipScope', () => {
  const perms = (role) => ROLE_DEFAULT_PERMISSIONS[role]
  const REP = 'rep@example.com'

  it('restricts a sales_rep to their own email on every CRM module', () => {
    for (const section of ['deals', 'leads', 'activities', 'sales']) {
      expect(ownershipScope(ROLES.SALES_REP, perms(ROLES.SALES_REP), section, REP)).toBe(REP)
    }
  })

  it('does not restrict a manager', () => {
    for (const section of ['deals', 'leads', 'activities', 'sales']) {
      expect(ownershipScope(ROLES.MANAGER, perms(ROLES.MANAGER), section, 'mgr@example.com')).toBeNull()
    }
  })

  it('does not restrict admin or super_admin, who bypass canDo entirely', () => {
    for (const role of [ROLES.ADMIN, ROLES.SUPER_ADMIN]) {
      expect(ownershipScope(role, null, 'sales', 'boss@example.com')).toBeNull()
    }
  })

  // The dangerous case. A restricted user whose email we do not have must not
  // fall through to "sees everything" — null means no filter at every call
  // site. It returns a sentinel that cannot match a stored email, so the page
  // shows nothing instead.
  it('fails closed when a restricted user has no email', () => {
    const scope = ownershipScope(ROLES.SALES_REP, perms(ROLES.SALES_REP), 'sales', null)
    expect(scope).toBe(NO_OWNER_MATCH)
    expect(scope).not.toBeNull()
    expect(Boolean(scope)).toBe(true) // truthy, so `scope ? filter : all` filters
    expect(['rep@example.com', null, ''].some((v) => v === scope)).toBe(false)
  })

  it('an explicit view_all override lifts the restriction for that module only', () => {
    const merged = resolvePermissions(ROLES.SALES_REP, { sales: { view_all: true } })
    expect(ownershipScope(ROLES.SALES_REP, merged, 'sales', REP)).toBeNull()
    expect(ownershipScope(ROLES.SALES_REP, merged, 'deals', REP)).toBe(REP)
  })
})
