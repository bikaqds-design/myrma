export function StatusBadge({ status }) {
  const badges = {
    active: 'bg-green-100 text-green-800',
    suspended: 'bg-yellow-100 text-yellow-800',
    locked: 'bg-red-100 text-red-800',
    deactivated: 'bg-gray-100 text-gray-800',
    pending: 'bg-blue-100 text-blue-800',
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
    super_admin: 'bg-purple-100 text-purple-800',
    admin: 'bg-indigo-100 text-indigo-800',
    manager: 'bg-blue-100 text-blue-800',
    technician: 'bg-green-100 text-green-800',
    viewer: 'bg-gray-100 text-gray-800',
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
