// Single list of assignable roles, used by both the Add-User modal and the
// per-user "Change Role" dropdown so they never drift (UM-7). `superAdminOnly`
// roles are only offered when the acting user is a super admin.
// eslint-disable-next-line react-refresh/only-export-components
export const ASSIGNABLE_ROLES = [
  { value: 'super_admin', label: '👑 Super Admin', superAdminOnly: true },
  { value: 'admin', label: '👑 Admin' },
  { value: 'manager', label: '👔 Manager' },
  { value: 'technician', label: '🔧 Technician' },
  { value: 'viewer', label: '👁️ Viewer' },
]

export function StatusBadge({ status }) {
  const badges = {
    active: 'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400',
    suspended: 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-400',
    locked: 'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-400',
    deactivated: 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]',
    pending: 'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-400',
  }

  const labels = {
    active: '🟢 Active',
    suspended: '⏸️ Suspended',
    locked: '🔒 Locked',
    deactivated: '❌ Deactivated',
    pending: '⏳ Pending',
  }

  return (
    <span
      className={'px-3 py-1 text-xs font-medium rounded-full ' + (badges[status] || badges.active)}
    >
      {labels[status] || status}
    </span>
  )
}

export function RoleBadge({ role }) {
  const badges = {
    super_admin: 'bg-purple-100 dark:bg-purple-900/20 text-purple-800 dark:text-purple-400',
    admin: 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-800 dark:text-indigo-400',
    manager: 'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-400',
    technician: 'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400',
    viewer: 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]',
  }

  const labels = {
    super_admin: '👑 Super Admin',
    admin: '👑 Admin',
    manager: '👔 Manager',
    technician: '🔧 Technician',
    viewer: '👁️ Viewer',
  }

  return (
    <span className={'px-3 py-1 text-xs font-medium rounded-full ' + badges[role]}>
      {labels[role] || role}
    </span>
  )
}
