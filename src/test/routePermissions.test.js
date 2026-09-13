import { describe, it, expect } from 'vitest'
import { ROUTE_PERMISSIONS, requiredPermissionsFor, deniedModuleFor } from '../lib/routePermissions'

const leadsOnly = { leads: { view: true } }
const dealsOnly = { deals: { view: true } }

describe('deniedModuleFor (BUG-072)', () => {
  it('lets a role with leads.view but not deals.view reach Activities — the finding itself', () => {
    expect(deniedModuleFor('technician', leadsOnly, '/activities')).toBeNull()
  })

  it('still lets deals.view reach Activities', () => {
    expect(deniedModuleFor('technician', dealsOnly, '/activities')).toBeNull()
  })

  it('refuses Activities with neither, naming the first alternative as before', () => {
    expect(deniedModuleFor('technician', {}, '/activities')).toBe('deals')
  })

  it('does not widen any other route: leads.view alone still cannot open the Pipeline', () => {
    expect(deniedModuleFor('technician', leadsOnly, '/pipeline')).toBe('deals')
    expect(deniedModuleFor('technician', leadsOnly, '/pipeline/abc-123')).toBe('deals')
  })

  it('always admits admins', () => {
    expect(deniedModuleFor('admin', {}, '/accounting')).toBeNull()
    expect(deniedModuleFor('super_admin', null, '/purchasing')).toBeNull()
  })

  it('leaves unguarded routes open', () => {
    expect(deniedModuleFor('viewer', {}, '/account')).toBeNull()
    expect(deniedModuleFor('viewer', {}, '/')).toBeNull()
  })
})

describe('requiredPermissionsFor', () => {
  it('matches whole path segments only', () => {
    expect(requiredPermissionsFor('/products/42')).toEqual([['products', 'view']])
    expect(requiredPermissionsFor('/products-archive')).toBeNull()
  })

  it('keeps every route except Activities on exactly the single permission it had', () => {
    // The table as it stood before BUG-072. Only Activities may differ.
    const before = {
      '/products': ['products', 'view'],
      '/customers': ['customers', 'view'],
      '/leads': ['leads', 'view'],
      '/pipeline': ['deals', 'view'],
      '/sales': ['sales', 'view'],
      '/accounting': ['accounting', 'view'],
      '/purchasing': ['purchasing', 'view'],
      '/rma-tickets': ['rma_tickets', 'view_all'],
      '/inventory': ['inventory', 'view'],
      '/calendar': ['calendar', 'view'],
      '/reports': ['reports', 'view'],
      '/knowledge-center': ['products', 'view'],
    }
    for (const [prefix, alternatives] of ROUTE_PERMISSIONS) {
      if (prefix === '/activities') continue
      expect([prefix, alternatives]).toEqual([prefix, [before[prefix]]])
    }
    expect(ROUTE_PERMISSIONS.map(([p]) => p).sort()).toEqual([...Object.keys(before), '/activities'].sort())
  })
})
