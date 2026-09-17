import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../components/Modal'
import { ROLES } from '../../lib/constants'
import { ROLE_DEFAULT_PERMISSIONS, roleDefaults, resolvePermissions } from '../../lib/permissions'
import { RoleBadge } from './_shared'
import { getDefaultPermissions, getRoleTemplates } from './_utils'
import {
  permissionGroups,
  MODULE_LABEL_KEYS,
  SENSITIVE_ACTIONS,
} from '../../lib/permissionCatalog'
import { SearchInput } from '../../components/SearchInput'

// ── What the database will actually honour ───────────────────────────────────
//
// Granting a permission the server refuses produces a button that appears and
// then fails. This warns at the point of granting.
//
// One table now, keyed by module.action, listing the roles the DATABASE
// permits. There were two: this plus a per-role LEGACY_CEILING carrying the
// older RMA-side entries in a different shape. Unifying them meant reading the
// actual policies rather than trusting the old list, which turned up a claim
// that was simply wrong — it said a viewer could not create a time entry, while
// `user_insert_own` allows `user_email = me AND rma_is_staff()`, and a viewer
// is staff. A viewer logging their own time is permitted and was being warned
// about.
//
// Every entry below is transcribed from a policy in supabase/migrations, named
// in the comment beside it. Anything not listed is not server-gated and is not
// warned about: `reports.export` and the calendar actions were in the old list
// with no RLS behind them, so they are gone rather than silently kept.

const ALL_STAFF = [
  ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER,
  ROLES.TECHNICIAN, ROLES.VIEWER, ROLES.SALES_REP, ROLES.ACCOUNTANT,
]
const STAFF_NOT_VIEWER = ALL_STAFF.filter((r) => r !== ROLES.VIEWER)
const MGR_PLUS   = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER]
const ADMIN_ONLY = [ROLES.SUPER_ADMIN, ROLES.ADMIN]

const SERVER_ALLOWS = {
  // ── products / customers: staff_read, manager_insert, manager_update,
  //    admin_delete (20260526 section 4)
  'products.create':   MGR_PLUS,
  'products.edit_all': MGR_PLUS,
  'products.import':   MGR_PLUS,
  'products.delete':   ADMIN_ONLY,
  'customers.create':  MGR_PLUS,
  'customers.import':  MGR_PLUS,
  'customers.delete':  ADMIN_ONLY,
  // customers.edit also has sales_rep_update_assigned for their own rows, so a
  // rep is not warned — the grant is partially honoured rather than refused.
  'customers.edit':    [...MGR_PLUS, ROLES.SALES_REP],

  // ── rma_tickets (20260526 section 5). staff_update additionally allows a
  //    technician on tickets assigned to them, hence edit_assigned.
  'rma_tickets.create':        MGR_PLUS,
  'rma_tickets.edit_all':      MGR_PLUS,
  'rma_tickets.edit_assigned': [...MGR_PLUS, ROLES.TECHNICIAN],
  'rma_tickets.bulk_actions':  MGR_PLUS,
  'rma_tickets.delete':        ADMIN_ONLY,

  // ── inventory_units / manufacturer_batches / parts / ticket_parts
  //    (20260526 section 7): write is staff except viewer, delete is admin.
  'inventory.create':       STAFF_NOT_VIEWER,
  'inventory.edit':         STAFF_NOT_VIEWER,
  'inventory.transfer':     STAFF_NOT_VIEWER,
  'inventory.delete':       ADMIN_ONLY,
  'parts.create':           STAFF_NOT_VIEWER,
  'parts.edit':             STAFF_NOT_VIEWER,
  'parts.adjust_stock':     STAFF_NOT_VIEWER,
  'parts.delete':           ADMIN_ONLY,

  // ── time_entries (20260526 section 8). Logging your own is open to all
  //    staff; seeing everyone's is manager and above.
  'time_tracking.view_all': MGR_PLUS,

  // ── user_roles and the other admin tables carry a single admin_all policy.
  'user_management.view':               ADMIN_ONLY,
  'user_management.create':             ADMIN_ONLY,
  'user_management.edit':               ADMIN_ONLY,
  'user_management.delete':             ADMIN_ONLY,
  'user_management.manage_permissions': ADMIN_ONLY,

  // ── sales documents: sales_insert_* / sales_update_* (20260781),
  //    admin_delete_* , and post/cancel gated inside post_invoice/void_invoice
  'sales.create': [...MGR_PLUS, ROLES.SALES_REP],
  'sales.edit':   [...MGR_PLUS, ROLES.SALES_REP],
  'sales.delete': ADMIN_ONLY,
  'sales.post':   MGR_PLUS,
  'sales.cancel': MGR_PLUS,

  // ── rma_can_handle_cash() = manager_or_above OR accountant (20260780)
  'accounting.record_payment':  [...MGR_PLUS, ROLES.ACCOUNTANT],
  'accounting.reverse_payment': [...MGR_PLUS, ROLES.ACCOUNTANT],

  // ── manager_write_purchase_orders / manager_write_vendor_invoices
  'purchasing.create':         MGR_PLUS,
  'purchasing.edit':           MGR_PLUS,
  'purchasing.receive':        MGR_PLUS,
  'purchasing.cancel':         MGR_PLUS,
  'purchasing.manage_vendors': MGR_PLUS,
  'purchasing.approve':        ADMIN_ONLY,

  // ── pipelines write is admin-only at the RLS layer
  'pipelines.manage': ADMIN_ONLY,
}

/**
 * Which granted permissions the database would refuse for this role.
 *
 * `role` must be the role RLS will see — for a custom role that is its
 * base_role, since rma_user_role() resolves it (20260782). Callers pass the
 * resolved value.
 */
function getCrossTierPermissions(role, perms) {
  const violations = []
  for (const [key, allowed] of Object.entries(SERVER_ALLOWS)) {
    const [section, action] = key.split('.')
    if (perms?.[section]?.[action] === true && !allowed.includes(role)) {
      violations.push(key)
    }
  }
  return violations.sort()
}

/**
 * Fill in every section and action the runtime knows about, so a partially
 * stored permissions object still renders a complete matrix.
 */
function mergeWithDefaults(permissions) {
  const defaults = getDefaultPermissions()
  return Object.fromEntries(
    Object.entries(defaults).map(([section, actions]) => [
      section,
      { ...actions, ...(permissions?.[section] || {}) },
    ])
  )
}

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

export function CustomRolesTab({ customRoles, onCreateRole, onEditRole, onDeleteRole }) {
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-semibold text-gray-900">{role.role_name}</h3>
                    {/* The base role decides what the database will serve anyone
                        holding this role, so it belongs on the card rather than
                        buried in a form nobody reopens. */}
                    <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                      {t('userManagement.basedOn', { role: role.base_role || 'viewer' })}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">{role.role_description}</p>
                  <p className="text-xs text-gray-500 mt-2">{t('userManagement.customCreatedBy', { by: role.created_by })}</p>
                </div>
                <button
                  onClick={() => onEditRole(role)}
                  className="text-indigo-600 hover:text-indigo-800 me-3 text-sm font-medium"
                >
                  {t('common.edit')}
                </button>
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
  editing,
  roleName,
  roleDescription,
  baseRole,
  permissions,
  onRoleNameChange,
  onRoleDescriptionChange,
  onBaseRoleChange,
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
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
        {editing ? t('userManagement.editCustomRole') : t('userManagement.createCustomRole')}
      </h2>
      <form onSubmit={onSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('userManagement.roleNameLabel')}</label>
          {/* Immutable once created. role_name is the value stored in
              user_roles.role, so renaming it would strand every holder on a
              role that no longer exists — the same reason a pipeline stage id
              cannot be edited. */}
          <input
            type="text"
            value={roleName}
            onChange={(e) => onRoleNameChange(e.target.value)}
            disabled={editing}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 disabled:bg-gray-100 disabled:text-gray-500"
            placeholder={t('userManagement.roleNamePlaceholder')}
            required
          />
          {editing && (
            <p className="mt-1 text-xs text-gray-500">{t('userManagement.roleNameLocked')}</p>
          )}
        </div>

        {/* The base role is not cosmetic. Row-level security matches on a fixed
            list of role names, so a custom name is in none of them — without an
            inherited base the database would serve this role almost nothing
            while the checkboxes below promised otherwise. RLS treats the user
            as their base role; the checkboxes can only narrow it further.
            admin and super_admin are absent on purpose: canDo() returns true
            unconditionally for those two, which would make the whole matrix
            below meaningless. */}
        <div>
          <label htmlFor="cr-base" className="block text-sm font-medium text-gray-700 mb-2">
            {t('userManagement.baseRoleLabel')}
          </label>
          <select
            id="cr-base"
            value={baseRole}
            onChange={(e) => onBaseRoleChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
            required
          >
            {[ROLES.VIEWER, ROLES.TECHNICIAN, ROLES.SALES_REP, ROLES.ACCOUNTANT, ROLES.MANAGER].map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">{t('userManagement.baseRoleHint')}</p>
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
            {editing ? t('userManagement.saveRoleBtn') : t('userManagement.createRoleBtn')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function PermissionsModal({ user, customRoles, onSave, onClose }) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)

  // Seed: use stored custom permissions if present, otherwise role template defaults.
  // mergeWithDefaults ensures all sections/keys exist even for partial stored objects.
  const [perms, setPerms] = useState(() =>
    /**
     * Show what the app actually enforces for this user.
     *
     * This used to seed from the stored override *instead of* the role
     * defaults when one existed, and mergeWithDefaults fills gaps with
     * all-false — so opening the editor on a user with a PARTIAL override
     * displayed every role-granted permission as off, and Save wrote that,
     * silently stripping their access. A viewer with one extra grant showed
     * eleven differences instead of one.
     *
     * resolvePermissions is the same function the session uses to decide what
     * canDo sees, so the editor now shows the effective permissions rather
     * than a reconstruction of them. mergeWithDefaults only fills sections the
     * runtime does not mention, so the matrix still renders complete.
     */
    mergeWithDefaults(
      resolvePermissions(user.role, user.permissions, roleDefaults(user.role, customRoles)) ||
        getDefaultPermissions()
    )
  )

  // A custom role is not in SERVER_ALLOWS — the database resolves it to its
  // base_role (rma_user_role, migration 20260782), so the ceiling has to be
  // evaluated against that base. Without this a custom role based on accountant
  // would be warned about record_payment it can perfectly well do, and one
  // based on viewer would not be warned about the same grant it cannot.
  // What this user's role grants before any per-user override — the thing the
  // ◆ markers are measured against.
  const roleBaseline = mergeWithDefaults(
    roleDefaults(user.role, customRoles) || getDefaultPermissions()
  )

  const effectiveRoleForCeiling =
    (customRoles || []).find((r) => r.role_name === user.role)?.base_role ?? user.role
  const crossTierViolations = getCrossTierPermissions(effectiveRoleForCeiling, perms)

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
          <PermissionMatrix
            permissions={perms}
            baseline={roleBaseline}
            onToggle={togglePermission}
          />
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

/**
 * PermissionMatrix — every module the runtime knows about, grouped.
 *
 * This used to render a hardcoded list of eleven modules, written when the app
 * was an RMA tool. After the CRM work it still listed `invoices` — a table with
 * zero rows, since retired — and listed none of deals, leads, activities,
 * contacts, pipelines, sales, accounting or purchasing. Those permissions were
 * stored and enforced the whole time; there was simply no way to see or change
 * eight of them.
 *
 * It now renders from permissionCatalog, which derives the module and action
 * list from ROLE_DEFAULT_PERMISSIONS at runtime. Adding a module to
 * permissions.ts makes it appear here on its own.
 */
export function PermissionMatrix({ permissions, baseline, onToggle, onToggleModule }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const groups = useMemo(() => permissionGroups(), [])
  const needle = query.trim().toLowerCase()

  const labelFor = (key) => {
    const k = MODULE_LABEL_KEYS[key]
    const translated = k ? t(k) : null
    if (translated && translated !== k) return translated
    return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }
  const actionLabel = (a) => t(`userManagement.action_${a}`, a.replace(/_/g, ' '))

  const matches = (key) =>
    !needle || key.includes(needle) || labelFor(key).toLowerCase().includes(needle)

  /**
   * Marks a toggle that has been moved away from the role's own default.
   *
   * With 101 checkboxes and three possible sources — a built-in role default, a
   * custom role's map, or a per-user override — an override was invisible once
   * the modal was open. The user list showed a "Custom" badge and then told you
   * nothing about which of the hundred differed.
   *
   * No baseline supplied means nothing is marked, which is right for the
   * create-a-role form: there is nothing to differ from yet.
   */
  const differsFromBaseline = (section, action) => {
    if (!baseline) return false
    return !!permissions?.[section]?.[action] !== !!baseline?.[section]?.[action]
  }

  const overriddenCount = groups
    .flatMap((g) => g.modules)
    .reduce(
      (n, m) => n + m.actions.filter((a) => differsFromBaseline(m.key, a)).length,
      0
    )

  const visibleGroups = groups
    .map((g) => ({ ...g, modules: g.modules.filter((m) => matches(m.key)) }))
    .filter((g) => g.modules.length > 0)

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        <SearchInput
          id="perm-search"
          value={query}
          onChange={setQuery}
          placeholder={t('userManagement.searchModules')}
          className="w-full sm:w-72"
        />
        <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">
          {t('userManagement.moduleCount', {
            count: visibleGroups.reduce((n, g) => n + g.modules.length, 0),
          })}
        </span>
        {baseline && overriddenCount > 0 && (
          <span className="text-xs font-medium text-indigo-600 dark:text-indigo-300">
            ◆ {t('userManagement.overriddenCount', { count: overriddenCount })}
          </span>
        )}
      </div>

      {visibleGroups.map((group) => (
        <div key={group.id}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-[#9aa4b2] mb-2">
            {t(group.labelKey, group.fallback)}
          </h3>
          <div className="space-y-3">
            {group.modules.map((module) => {
              const modulePerms = permissions[module.key] || {}
              const enabledCount = module.actions.filter((a) => modulePerms[a]).length
              const allOn = enabledCount === module.actions.length
              return (
                <div
                  key={module.key}
                  className="border border-gray-200 dark:border-[#212a38] rounded-lg p-4"
                >
                  <div className="flex items-center justify-between mb-3 gap-3">
                    <h4 className="font-medium text-gray-900 dark:text-[#e8ebf0]">
                      {labelFor(module.key)}
                    </h4>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">
                        {t('userManagement.enabledCount', {
                          count: enabledCount,
                          total: module.actions.length,
                        })}
                      </span>
                      {onToggleModule && (
                        <button
                          type="button"
                          onClick={() => onToggleModule(module.key, module.actions, !allOn)}
                          className="text-xs font-medium text-indigo-600 dark:text-indigo-300 hover:underline"
                        >
                          {allOn ? t('userManagement.clearAll') : t('userManagement.selectAll')}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                    {module.actions.map((perm) => (
                      <label
                        key={perm}
                        className={`flex items-center gap-2 cursor-pointer select-none ${
                          differsFromBaseline(module.key, perm)
                            ? '-mx-1 px-1 rounded bg-indigo-50 dark:bg-indigo-500/10'
                            : ''
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={!!modulePerms[perm]}
                          onChange={() => onToggle(module.key, perm)}
                          className="w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500"
                        />
                        <span className="text-sm text-gray-700 dark:text-[#e8ebf0]">
                          {actionLabel(perm)}
                          {differsFromBaseline(module.key, perm) && (
                            <span
                              title={t('userManagement.overriddenHint')}
                              aria-label={t('userManagement.overriddenHint')}
                              className="ms-1 text-indigo-600 dark:text-indigo-300 font-semibold"
                            >
                              ◆
                            </span>
                          )}
                          {SENSITIVE_ACTIONS.has(perm) && (
                            <span
                              title={t('userManagement.sensitiveAction')}
                              className="ms-1 text-amber-600 dark:text-amber-400"
                              aria-label={t('userManagement.sensitiveAction')}
                            >
                              ●
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
