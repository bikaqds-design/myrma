import { ROLE_DEFAULT_PERMISSIONS } from '../../lib/permissions'
import { ROLES } from '../../lib/constants'

export function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters'
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter'
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter'
  if (!/[0-9]/.test(pw)) return 'Password must contain a number'
  return null
}

// ── Single source of truth for permission shape ──────────────────────────────
// The manager default carries every section + action, so it defines the canonical
// schema. getDefaultPermissions() (all-false) and the role-template displays are
// DERIVED from ROLE_DEFAULT_PERMISSIONS so they can never drift from runtime (UM-2).
const PERMISSION_SCHEMA = ROLE_DEFAULT_PERMISSIONS[ROLES.MANAGER]

function buildUniform(value) {
  return Object.fromEntries(
    Object.entries(PERMISSION_SCHEMA).map(([section, actions]) => [
      section,
      Object.fromEntries(Object.keys(actions).map((a) => [a, value])),
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
]

export function getRoleTemplates() {
  return ROLE_META.map((m) => ({
    ...m,
    // manager/technician/viewer come straight from runtime defaults;
    // admin/super_admin have no defaults entry (they bypass) → show full access.
    permissions: ROLE_DEFAULT_PERMISSIONS[m.key] || buildUniform(true),
  }))
}
