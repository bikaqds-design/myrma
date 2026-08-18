import { ROLE_DEFAULT_PERMISSIONS } from './permissions'
import { ROLES } from './constants'

/**
 * permissionCatalog — how the permission editor is laid out.
 *
 * The editor used to render a hardcoded list of eleven modules. It was written
 * when the app was an RMA tool, and it stayed that way: after the CRM work it
 * still showed `invoices` (a table with 0 rows, since retired) and showed none
 * of deals, leads, activities, contacts, pipelines, sales, accounting or
 * purchasing. The permissions existed in the stored object and were being
 * enforced — you simply could not see or change eight of them.
 *
 * That is the same failure as the dashboard widget list: a snapshot standing in
 * for a live set. The fix is the same. This file holds only *presentation* —
 * grouping, order, labels. Which modules and actions exist comes from
 * ROLE_DEFAULT_PERMISSIONS at runtime, and `permissionGroups()` puts anything
 * it does not recognise into an "Other" group rather than dropping it.
 *
 * A module added to permissions.ts therefore appears in the editor
 * automatically. It will look plain until it is given a home here, but it can
 * never again be silently invisible. A test asserts the two agree.
 */

/** Display order and grouping. Keys not listed here still render, under Other. */
export const MODULE_GROUPS = [
  {
    id: 'crm',
    labelKey: 'userManagement.groupCrm',
    fallback: 'CRM',
    modules: ['leads', 'deals', 'pipelines', 'activities', 'contacts', 'customers'],
  },
  {
    id: 'money',
    labelKey: 'userManagement.groupMoney',
    fallback: 'Sales & Finance',
    modules: ['sales', 'accounting', 'purchasing'],
  },
  {
    id: 'operations',
    labelKey: 'userManagement.groupOperations',
    fallback: 'Operations',
    modules: ['rma_tickets', 'inventory', 'products', 'parts', 'time_tracking', 'calendar'],
  },
  {
    id: 'system',
    labelKey: 'userManagement.groupSystem',
    fallback: 'System',
    modules: ['dashboard', 'reports', 'user_management'],
  },
]

/** Module label keys. Falls back to a de-underscored title case. */
export const MODULE_LABEL_KEYS = {
  leads: 'nav.leads',
  deals: 'nav.pipeline',
  pipelines: 'userManagement.modulePipelines',
  activities: 'nav.activities',
  contacts: 'userManagement.moduleContacts',
  customers: 'nav.customers',
  sales: 'nav.sales',
  accounting: 'nav.accounting',
  purchasing: 'nav.purchasing',
  rma_tickets: 'nav.rmaTickets',
  inventory: 'nav.inventory',
  products: 'nav.products',
  parts: 'nav.parts',
  time_tracking: 'userManagement.moduleTimeTracking',
  calendar: 'nav.calendar',
  dashboard: 'nav.dashboard',
  reports: 'nav.reports',
  user_management: 'userManagement.moduleUserManagement',
}

/**
 * Actions whose consequences are worth pausing over. Rendered with a marker so
 * an admin ticking through a matrix can see which boxes move money, delete
 * records or widen someone's reach, rather than treating fifty checkboxes as
 * equally weighted.
 */
export const SENSITIVE_ACTIONS = new Set([
  'delete',
  'post',
  'cancel',
  'approve',
  'record_payment',
  'reverse_payment',
  'manage_permissions',
  'manage_vendors',
  'manage_warehouses',
  'manage',
  'view_all',
  'import',
  'bulk_actions',
])

/**
 * The canonical schema: every module and action the runtime knows about.
 * Manager carries the broadest set, and the money modules are unioned in from
 * the other roles so a module no single role holds in full is still complete.
 */
export function permissionSchema() {
  const schema = {}
  for (const role of Object.keys(ROLE_DEFAULT_PERMISSIONS)) {
    const perms = ROLE_DEFAULT_PERMISSIONS[role]
    for (const [section, actions] of Object.entries(perms || {})) {
      schema[section] ||= new Set()
      for (const action of Object.keys(actions)) schema[section].add(action)
    }
  }
  return Object.fromEntries(
    Object.entries(schema).map(([k, v]) => [k, [...v]])
  )
}

/**
 * Groups for rendering, built from the live schema. Anything the groups above
 * do not mention lands in "Other" — visible, editable, and obviously in need of
 * a home, which is strictly better than absent.
 */
export function permissionGroups() {
  const schema = permissionSchema()
  const placed = new Set(MODULE_GROUPS.flatMap((g) => g.modules))
  const groups = MODULE_GROUPS.map((g) => ({
    ...g,
    modules: g.modules.filter((m) => m in schema).map((m) => ({ key: m, actions: schema[m] })),
  })).filter((g) => g.modules.length > 0)

  const orphans = Object.keys(schema)
    .filter((m) => !placed.has(m))
    .sort()
    .map((m) => ({ key: m, actions: schema[m] }))

  if (orphans.length) {
    groups.push({
      id: 'other',
      labelKey: 'userManagement.groupOther',
      fallback: 'Other',
      modules: orphans,
    })
  }
  return groups
}

/** Roles that bypass every check, so the editor shows them as full access. */
export const BYPASS_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN]
