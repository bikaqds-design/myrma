/**
 * permissions.test.js — Unit tests for src/lib/permissions.ts
 *
 * Covers: canDo() helper, ROLE_DEFAULT_PERMISSIONS structure
 */
import { describe, it, expect } from 'vitest'
import { canDo, resolvePermissions, ROLE_DEFAULT_PERMISSIONS } from '../lib/permissions'
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
    expect(canDo(ROLES.TECHNICIAN, perms, 'invoices', 'delete')).toBe(false)
  })

  it('returns false for unknown action within known section', () => {
    expect(canDo(ROLES.VIEWER, perms, 'products', 'import')).toBe(false)
  })

  it('returns false when permissions is null', () => {
    expect(canDo(ROLES.MANAGER, null, 'rma_tickets', 'view_all')).toBe(false)
  })

  it('returns false when permissions is undefined', () => {
    expect(canDo(ROLES.MANAGER, undefined, 'rma_tickets', 'view_all')).toBe(false)
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
  const managerPerms = ROLE_DEFAULT_PERMISSIONS[ROLES.MANAGER]
  const techPerms = ROLE_DEFAULT_PERMISSIONS[ROLES.TECHNICIAN]
  const viewerPerms = ROLE_DEFAULT_PERMISSIONS[ROLES.VIEWER]

  it('manager can create tickets', () => {
    expect(canDo(ROLES.MANAGER, managerPerms, 'rma_tickets', 'create')).toBe(true)
  })

  it('technician cannot create tickets', () => {
    expect(canDo(ROLES.TECHNICIAN, techPerms, 'rma_tickets', 'create')).toBe(false)
  })

  it('viewer cannot create tickets', () => {
    expect(canDo(ROLES.VIEWER, viewerPerms, 'rma_tickets', 'create')).toBe(false)
  })

  it('manager can export products', () => {
    expect(canDo(ROLES.MANAGER, managerPerms, 'products', 'export')).toBe(true)
  })

  it('viewer cannot export products', () => {
    expect(canDo(ROLES.VIEWER, viewerPerms, 'products', 'export')).toBe(false)
  })
})
