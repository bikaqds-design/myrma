import { ROLE_DEFAULT_PERMISSIONS } from '../../lib/permissions'
import { ROLES } from '../../lib/constants'
import { permissionSchema } from '../../lib/permissionCatalog'

export function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters'
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter'
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter'
  if (!/[0-9]/.test(pw)) return 'Password must contain a number'
  return null
}

// ── Single source of truth for permission shape ──────────────────────────────
// This used to read ROLE_DEFAULT_PERMISSIONS[MANAGER] on the grounds that the
// manager default carries every section and action. That was true, and it was
// still the wrong source: it holds only while manager remains a superset of
// every other role, which nothing enforces. A future role with a module manager
// lacks would silently drop out of the blank template and out of the role
// reference display.
//
// permissionSchema() unions across every role, which is what "the canonical
// schema" actually means, and is the same source the permission editor renders
// from — so the editor, the blank template and the role reference cannot
// disagree about which permissions exist.
function buildUniform(value) {
  return Object.fromEntries(
    Object.entries(permissionSchema()).map(([section, actions]) => [
      section,
      Object.fromEntries(actions.map((a) => [a, value])),
    ])
  )
}

// All-false blank, used to seed a brand-new custom role. Derived from the schema
// so it always matches the sections/actions the runtime knows about.
export function getDefaultPermissions() {
  return buildUniform(false)
}

// Role metadata for the read-only "Role Reference" tab. Permissions are derived
// from ROLE_DEFAULT_PERMISSIONS (the runtime truth); admin / super_admin bypass
// all checks so they're represented as full access.
const ROLE_META = [
  {
    key: ROLES.SUPER_ADMIN,
    name: 'Super Admin',
    icon: '👑',
    description: 'Full system access including user management and system settings',
  },
  {
    key: ROLES.ADMIN,
    name: 'Admin',
    icon: '👑',
    description: 'Management access (bypasses all permission checks)',
  },
  {
    key: ROLES.MANAGER,
    name: 'Manager',
    icon: '👔',
    description: 'Team lead with full operational access but limited system settings',
  },
  {
    key: ROLES.TECHNICIAN,
    name: 'Technician',
    icon: '🔧',
    description: 'Field worker with limited editing rights',
  },
  {
    key: ROLES.VIEWER,
    name: 'Viewer',
    icon: '👁️',
    description: 'Read-only access to all data',
  },
  {
    key: ROLES.SALES_REP,
    name: 'Sales Rep',
    icon: '🤝',
    description: 'CRM-focused: leads, deals, and activities scoped to their own records; no RMA-internal access',
  },
  {
    key: ROLES.ACCOUNTANT,
    name: 'Accountant',
    icon: '🧾',
    description:
      'Owns cashflow: records and reverses customer and vendor payments, and reads the documents behind them. Cannot raise or post an invoice, or approve a purchase order — the standard split that stops one person authorising, executing and recording a payment.',
  },
]

export function getRoleTemplates() {
  return ROLE_META.map((m) => ({
    ...m,
    // manager/technician/viewer come straight from runtime defaults;
    // admin/super_admin have no defaults entry (they bypass) → show full access.
    permissions: ROLE_DEFAULT_PERMISSIONS[m.key] || buildUniform(true),
  }))
}
