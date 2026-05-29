import React, { useState } from 'react'
import Modal from '../../components/Modal'
import { ROLES } from '../../lib/constants'
import { ROLE_DEFAULT_PERMISSIONS } from '../../lib/permissions'
import { RoleBadge } from './_shared'
import { getDefaultPermissions, getRoleTemplates } from './_utils'

// Merges stored permissions on top of the full defaults so all keys are always present
function mergeWithDefaults(permissions) {
  const defaults = getDefaultPermissions()
  return Object.fromEntries(
    Object.entries(defaults).map(([section, actions]) => [
      section,
      { ...actions, ...(permissions?.[section] || {}) },
    ])
  )
}

// Read-only reference of the built-in role defaults that the app actually enforces
// at runtime (ROLE_DEFAULT_PERMISSIONS). admin / super_admin bypass all checks, so
// they're shown as full access. Per-user overrides live on the Users tab → Edit Permissions.
export function RoleTemplatesTab() {
  const roles = getRoleTemplates()

  // Source of truth = runtime defaults. admin/super_admin aren't in ROLE_DEFAULT_PERMISSIONS
  // (they bypass canDo entirely) → fall back to the template's full-access map for display.
  const getDisplayPerms = (roleKey) =>
    ROLE_DEFAULT_PERMISSIONS[roleKey] ||
    getRoleTemplates().find((r) => r.key === roleKey)?.permissions ||
    {}

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
        <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div className="text-sm text-blue-800">
          <p className="font-medium">These are the built-in role defaults the app enforces.</p>
          <p className="mt-0.5 text-blue-700">
            They're shown for reference and can't be edited here. To grant or restrict permissions
            for an individual user, use <strong>Edit Permissions</strong> on the Users tab.
            Admins and super admins always have full access.
          </p>
        </div>
      </div>

      {roles.map((role) => {
        const perms = getDisplayPerms(role.key)
        const bypasses = role.key === ROLES.ADMIN || role.key === ROLES.SUPER_ADMIN
        return (
          <div key={role.key} className="border border-gray-200 rounded-xl p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900 mb-1">
                  {role.icon} {role.name}
                </h3>
                <p className="text-sm text-gray-500">{role.description}</p>
              </div>
              <RoleBadge role={role.key} />
            </div>

            {bypasses ? (
              <p className="text-sm text-gray-600 italic">Full access — bypasses all permission checks.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {Object.entries(perms).map(([module, modulePerms]) => {
                  const enabled = Object.entries(modulePerms)
                    .filter(([, v]) => v)
                    .map(([k]) => k)
                  return (
                    <div key={module} className="bg-gray-50 rounded-lg p-3">
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        {module.replace(/_/g, ' ')}
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        {enabled.length === 0 ? (
                          <span className="text-xs text-gray-500 italic">No access</span>
                        ) : (
                          enabled.map((p) => (
                            <span
                              key={p}
                              className="px-1.5 py-0.5 bg-green-100 text-green-800 text-xs rounded font-medium"
                            >
                              {p.replace(/_/g, ' ')}
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function CustomRolesTab({ customRoles, onCreateRole, onDeleteRole }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center mb-4">
        <p className="text-gray-600">{customRoles.length} custom roles created</p>
        <button
          onClick={onCreateRole}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          Create Custom Role
        </button>
      </div>

      {customRoles.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          No custom roles created yet. Create your first custom role!
        </div>
      ) : (
        <div className="space-y-4">
          {customRoles.map((role) => (
            <div key={role.id} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900">{role.role_name}</h3>
                  <p className="text-sm text-gray-600 mt-1">{role.role_description}</p>
                  <p className="text-xs text-gray-500 mt-2">Created by {role.created_by}</p>
                </div>
                <button
                  onClick={() => onDeleteRole(role.id)}
                  className="text-red-600 hover:text-red-800"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function CreateRoleModal({
  roleName,
  roleDescription,
  permissions,
  onRoleNameChange,
  onRoleDescriptionChange,
  onPermissionsChange,
  onSubmit,
  onClose,
}) {
  const togglePermission = (module, perm) => {
    const updated = { ...permissions }
    updated[module][perm] = !updated[module][perm]
    onPermissionsChange(updated)
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Create Custom Role"
      className="max-w-4xl"
      hideHeader
    >
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Create Custom Role</h2>
      <form onSubmit={onSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Role Name</label>
          <input
            type="text"
            value={roleName}
            onChange={(e) => onRoleNameChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
            placeholder="e.g., Support Agent"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
          <textarea
            value={roleDescription}
            onChange={(e) => onRoleDescriptionChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
            rows="2"
            placeholder="Brief description of this role"
          />
        </div>

        <div>
          <h3 className="font-semibold text-gray-900 mb-3">Permissions</h3>
          <PermissionMatrix permissions={permissions} onToggle={togglePermission} />
        </div>

        <div className="flex gap-3 pt-4 border-t">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            Create Role
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function PermissionsModal({ user, onSave, onClose }) {
  const [saving, setSaving] = useState(false)

  // Seed: use stored custom permissions if present, otherwise role template defaults.
  // mergeWithDefaults ensures all sections/keys exist even for partial stored objects.
  const [perms, setPerms] = useState(() => {
    const stored = user.permissions
    const hasStored = stored && typeof stored === 'object' && Object.keys(stored).length > 0
    const base = hasStored ? stored : (ROLE_DEFAULT_PERMISSIONS[user.role] || getDefaultPermissions())
    return mergeWithDefaults(base)
  })

  const hasCustomPerms =
    user.permissions && typeof user.permissions === 'object' && Object.keys(user.permissions).length > 0

  const togglePermission = (module, perm) => {
    setPerms((p) => ({
      ...p,
      [module]: { ...(p[module] || {}), [perm]: !p[module]?.[perm] },
    }))
  }

  const resetToRoleDefaults = () => {
    const roleDefaults = ROLE_DEFAULT_PERMISSIONS[user.role]
    setPerms(mergeWithDefaults(roleDefaults || getDefaultPermissions()))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(perms)
    } catch {
      // parent handles error toast
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={true} onClose={onClose} title={`Edit Permissions: ${user.user_email}`} className="max-w-4xl" hideHeader>
      <div className="flex flex-col max-h-[85vh]">
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Edit Permissions</h2>
            <p className="text-sm text-gray-500 mt-0.5">{user.user_email}</p>
            <div className="flex items-center gap-2 mt-2">
              <RoleBadge role={user.role} />
              {hasCustomPerms ? (
                <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full">
                  Custom overrides active
                </span>
              ) : (
                <span className="text-xs text-gray-400">Showing role defaults</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 mt-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <PermissionMatrix permissions={perms} onToggle={togglePermission} />
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
          <button
            onClick={resetToRoleDefaults}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-white transition-colors"
          >
            Reset to Role Defaults
          </button>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save Permissions'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function PermissionMatrix({ permissions, onToggle }) {
  const modules = [
    { key: 'products', label: 'Products' },
    { key: 'customers', label: 'Customers' },
    { key: 'rma_tickets', label: 'RMA Tickets' },
    { key: 'inventory', label: 'Inventory' },
    { key: 'invoices', label: 'Invoices' },
    { key: 'parts', label: 'Parts Inventory' },
    { key: 'time_tracking', label: 'Time Tracking' },
    { key: 'calendar', label: 'Calendar' },
    { key: 'reports', label: 'Reports' },
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'user_management', label: 'User Management' },
    { key: 'settings', label: 'Settings' },
  ]

  return (
    <div className="space-y-3">
      {modules.map((module) => {
        const modulePerms = permissions[module.key] || {}
        const entries = Object.entries(modulePerms)
        const enabledCount = entries.filter(([, v]) => v).length
        return (
          <div key={module.key} className="border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-medium text-gray-900">{module.label}</h4>
              <span className="text-xs text-gray-400">
                {enabledCount}/{entries.length} enabled
              </span>
            </div>
            {entries.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No permissions defined</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                {entries.map(([perm, enabled]) => (
                  <label key={perm} className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!!enabled}
                      onChange={() => onToggle(module.key, perm)}
                      className="w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500"
                    />
                    <span className="text-sm text-gray-700 capitalize">
                      {perm.replace(/_/g, ' ')}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
