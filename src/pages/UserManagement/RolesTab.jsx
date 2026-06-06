import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../components/Modal'
import { ROLES } from '../../lib/constants'
import { ROLE_DEFAULT_PERMISSIONS } from '../../lib/permissions'
import { RoleBadge } from './_shared'
import { getDefaultPermissions, getRoleTemplates } from './_utils'

// Permissions that the DB (RLS) cannot enforce for a given role — granting them shows
// the UI button but the server will reject the write. Used to surface a warning.
const RLS_CEILING = {
  [ROLES.VIEWER]: {
    products: ['create', 'edit_all', 'delete', 'import'],
    customers: ['create', 'edit', 'delete', 'import'],
    rma_tickets: ['create', 'edit_all', 'edit_assigned', 'delete', 'bulk_actions'],
    inventory: ['create', 'edit', 'delete', 'transfer'],
    invoices: ['create', 'edit', 'delete'],
    parts: ['create', 'edit', 'delete', 'adjust'],
    reports: ['export'],
    calendar: ['create', 'edit', 'delete'],
    time_tracking: ['create', 'edit', 'delete'],
    user_management: ['view', 'create', 'edit', 'delete', 'manage_permissions'],
  },
  [ROLES.TECHNICIAN]: {
    products: ['create', 'edit_all', 'delete', 'import'],
    customers: ['create', 'edit', 'delete', 'import'],
    invoices: ['create', 'edit', 'delete'],
    user_management: ['view', 'create', 'edit', 'delete', 'manage_permissions'],
  },
}

function getCrossTierPermissions(role, perms) {
  const ceiling = RLS_CEILING[role]
  if (!ceiling) return []
  const violations = []
  for (const [section, actions] of Object.entries(ceiling)) {
    for (const action of actions) {
      if (perms?.[section]?.[action] === true) {
        violations.push(`${section}.${action}`)
      }
    }
  }
  return violations
}

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
  const { t } = useTranslation()
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
          <p className="font-medium">{t('userManagement.roleReferenceTitle')}</p>
          <p className="mt-0.5 text-blue-700">
            {t('userManagement.roleReferenceDesc')}
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
              <p className="text-sm text-gray-600 italic">{t('userManagement.fullAccess')}</p>
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
                          <span className="text-xs text-gray-500 italic">{t('userManagement.noAccess')}</span>
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
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center mb-4">
        <p className="text-gray-600">{customRoles.length} {t('userManagement.customRolesCount')}</p>
        <button
          onClick={onCreateRole}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          {t('userManagement.createCustomRole')}
        </button>
      </div>

      {customRoles.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          {t('userManagement.noCustomRoles')}
        </div>
      ) : (
        <div className="space-y-4">
          {customRoles.map((role) => (
            <div key={role.id} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900">{role.role_name}</h3>
                  <p className="text-sm text-gray-600 mt-1">{role.role_description}</p>
                  <p className="text-xs text-gray-500 mt-2">{t('userManagement.customCreatedBy', { by: role.created_by })}</p>
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
  const { t } = useTranslation()
  const togglePermission = (module, perm) => {
    const updated = { ...permissions }
    updated[module][perm] = !updated[module][perm]
    onPermissionsChange(updated)
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={t('userManagement.createCustomRole')}
      className="max-w-4xl"
      hideHeader
    >
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">{t('userManagement.createCustomRole')}</h2>
      <form onSubmit={onSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('userManagement.roleNameLabel')}</label>
          <input
            type="text"
            value={roleName}
            onChange={(e) => onRoleNameChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
            placeholder={t('userManagement.roleNamePlaceholder')}
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('userManagement.descriptionLabel')}</label>
          <textarea
            value={roleDescription}
            onChange={(e) => onRoleDescriptionChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
            rows="2"
            placeholder={t('userManagement.roleDescPlaceholder')}
          />
        </div>

        <div>
          <h3 className="font-semibold text-gray-900 mb-3">{t('userManagement.permissionsHeading')}</h3>
          <PermissionMatrix permissions={permissions} onToggle={togglePermission} />
        </div>

        <div className="flex gap-3 pt-4 border-t">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            {t('userManagement.createRoleBtn')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function PermissionsModal({ user, onSave, onClose }) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)

  // Seed: use stored custom permissions if present, otherwise role template defaults.
  // mergeWithDefaults ensures all sections/keys exist even for partial stored objects.
  const [perms, setPerms] = useState(() => {
    const stored = user.permissions
    const hasStored = stored && typeof stored === 'object' && Object.keys(stored).length > 0
    const base = hasStored ? stored : (ROLE_DEFAULT_PERMISSIONS[user.role] || getDefaultPermissions())
    return mergeWithDefaults(base)
  })

  const crossTierViolations = getCrossTierPermissions(user.role, perms)

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
    <Modal open={true} onClose={onClose} title={t('userManagement.editPermissionsTitle', { email: user.user_email })} className="max-w-4xl" hideHeader>
      <div className="flex flex-col max-h-[85vh]">
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-xl font-bold text-gray-900">{t('userManagement.permissionsModal')}</h2>
            <p className="text-sm text-gray-500 mt-0.5">{user.user_email}</p>
            <div className="flex items-center gap-2 mt-2">
              <RoleBadge role={user.role} />
              {hasCustomPerms ? (
                <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full">
                  {t('userManagement.customOverridesActive')}
                </span>
              ) : (
                <span className="text-xs text-gray-400">{t('userManagement.showingRoleDefaults')}</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 mt-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {crossTierViolations.length > 0 && (
          <div className="mx-6 mt-3 mb-1 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
            <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <span>
              <strong>{t('userManagement.crossTierWarning')}</strong> — {t('userManagement.crossTierWarningDetail', { role: user.role })}{' '}
              <span className="font-mono">{crossTierViolations.join(', ')}</span>
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <PermissionMatrix permissions={perms} onToggle={togglePermission} />
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
          <button
            onClick={resetToRoleDefaults}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-white transition-colors"
          >
            {t('userManagement.resetToRoleDefaults')}
          </button>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-white transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {saving ? t('common.saving') : t('userManagement.savePermissions')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function PermissionMatrix({ permissions, onToggle }) {
  const { t } = useTranslation()
  const modules = [
    { key: 'products', label: t('nav.products') },
    { key: 'customers', label: t('nav.customers') },
    { key: 'rma_tickets', label: t('nav.rmaTickets') },
    { key: 'inventory', label: t('nav.inventory') },
    { key: 'invoices', label: t('nav.invoices') },
    { key: 'parts', label: t('nav.parts') },
    { key: 'time_tracking', label: t('userManagement.moduleTimeTracking') },
    { key: 'calendar', label: t('nav.calendar') },
    { key: 'reports', label: t('nav.reports') },
    { key: 'dashboard', label: t('nav.dashboard') },
    { key: 'user_management', label: t('userManagement.moduleUserManagement') },
    { key: 'settings', label: t('userManagement.moduleSettings') },
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
                {t('userManagement.enabledCount', { count: enabledCount, total: entries.length })}
              </span>
            </div>
            {entries.length === 0 ? (
              <p className="text-sm text-gray-400 italic">{t('userManagement.noPermsDefined')}</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
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
