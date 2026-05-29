import React, { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import Modal from '../../components/Modal'
import { db } from '../../api/supabaseClient'
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

export function RoleTemplatesTab({ currentUserRole, currentUserEmail }) {
  const [savedTemplates, setSavedTemplates] = useState({})
  const [editingRole, setEditingRole] = useState(null)
  const [editPerms, setEditPerms] = useState(null)
  const [saving, setSaving] = useState(false)
  const isSuperAdmin = currentUserRole === ROLES.SUPER_ADMIN

  useEffect(() => {
    loadTemplates()
  }, [])

  const loadTemplates = async () => {
    try {
      const result = await db.rmaConfig.getAll()
      if (!result.missing) {
        const row = result.data.find((r) => r.config_key === 'role_templates')
        if (row?.config_value) {
          const val =
            typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
          setSavedTemplates(val)
        }
      }
    } catch {
      /* fall back to hardcoded defaults */
    }
  }

  const getEffectivePerms = (roleKey) => {
    if (savedTemplates[roleKey]) return savedTemplates[roleKey]
    return getRoleTemplates().find((r) => r.key === roleKey)?.permissions || {}
  }

  const handleEdit = (role) => {
    setEditingRole(role)
    setEditPerms(JSON.parse(JSON.stringify(getEffectivePerms(role.key))))
  }

  const handleResetToDefault = () => {
    const defaults = getRoleTemplates().find((r) => r.key === editingRole.key)
    setEditPerms(JSON.parse(JSON.stringify(defaults.permissions)))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = { ...savedTemplates, [editingRole.key]: editPerms }
      await db.rmaConfig.set('role_templates', updated, currentUserEmail)
      setSavedTemplates(updated)
      setEditingRole(null)
      toast.success(`${editingRole.name} template saved`)
    } catch {
      toast.error('Failed to save template')
    } finally {
      setSaving(false)
    }
  }

  const roles = getRoleTemplates()

  return (
    <div className="space-y-6">
      {roles.map((role) => {
        const perms = getEffectivePerms(role.key)
        const hasCustom = !!savedTemplates[role.key]
        return (
          <div key={role.key} className="border border-gray-200 rounded-xl p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-base font-semibold text-gray-900">
                    {role.icon} {role.name}
                  </h3>
                  {hasCustom && (
                    <span className="px-2 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700 rounded-full">
                      Modified
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-500">{role.description}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <RoleBadge role={role.key} />
                {isSuperAdmin && (
                  <button
                    onClick={() => handleEdit(role)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 transition-colors"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                      />
                    </svg>
                    Edit
                  </button>
                )}
              </div>
            </div>

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
          </div>
        )
      })}

      {editingRole && (
        <Modal
          open={true}
          onClose={() => setEditingRole(null)}
          title={`Edit ${editingRole.name} Template`}
          className="max-w-4xl"
          hideHeader
        >
          <div className="flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h3 className="text-lg font-bold text-gray-900">
                  {editingRole.icon} Edit {editingRole.name} Template
                </h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  These defaults apply when a user has no custom permissions set
                </p>
              </div>
              <button
                onClick={() => setEditingRole(null)}
                className="text-gray-500 hover:text-gray-600"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {editPerms && (
                <PermissionMatrix
                  permissions={editPerms}
                  onToggle={(module, perm) => {
                    setEditPerms((p) => ({
                      ...p,
                      [module]: { ...p[module], [perm]: !p[module][perm] },
                    }))
                  }}
                />
              )}
            </div>
            <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
              <button
                onClick={handleResetToDefault}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-white transition-colors"
              >
                Reset to Default
              </button>
              <div className="flex gap-3">
                <button
                  onClick={() => setEditingRole(null)}
                  className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-white"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-5 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? 'Saving…' : 'Save Template'}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
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
