/**
 * permissions.ts — role-based permission defaults + helper
 *
 * `super_admin` and `admin` bypass all permission checks in the app.
 * For all other roles (`manager`, `technician`, `viewer`) the DB row from
 * `user_roles.permissions` is used when present; these defaults apply as
 * fallback when the column is null / the row is missing.
 */
import { ROLES, type Role } from './constants.js'

/** A flat map of action → boolean for one feature section */
type SectionPermissions = Record<string, boolean>

/** The full permissions object stored in user_roles.permissions */
export type UserPermissions = Record<string, SectionPermissions>

/**
 * No `settings` section here, deliberately.
 *
 * There used to be one — view_settings, edit_company_info, edit_branding,
 * manage_email_templates, manage_statuses, manage_priorities, manage_categories,
 * view_audit_logs — surfaced as eight switches in the role editor. Not one was
 * read anywhere in the app, and the architecture meant none of them could
 * matter even if they had been: `/control-panel` is gated in App.jsx on
 * `role === ADMIN || SUPER_ADMIN`, and canDo() below returns true
 * unconditionally for exactly those two roles. So the roles the toggles applied
 * to could never reach the pages, and the roles that could reach them ignored
 * the toggles. An admin could switch "manage_branding" off, see it go off, and
 * change nothing.
 *
 * They were removed rather than wired up, because wiring them was the more
 * dangerous option: MANAGER defaulted to `view_settings: true`, so making the
 * route honour the permission would have handed every manager the Control Panel
 * the moment it shipped.
 *
 * If delegated settings access is wanted later it is a feature, not a
 * reinstatement: the route guard has to move from role to permission, each
 * Control Panel section needs its own check, and the defaults need setting
 * deliberately rather than inheriting the `true` that was sitting there.
 *
 * Note `user_management` is a different case and stays: create_users and
 * manage_permissions are genuinely read, even though six of its eight keys are
 * not.
 */
export const ROLE_DEFAULT_PERMISSIONS: Partial<Record<Role, UserPermissions>> = {
  [ROLES.MANAGER]: {
    products: { view: true, create: true, edit: true, delete: false, export: true, import: false },
    customers: {
      view: true,
      create: true,
      edit: true,
      delete: false,
      export: true,
      import: false,
      view_history: true,
    },
    rma_tickets: {
      view_all: true,
      view_assigned: true,
      create: true,
      edit_all: true,
      edit_assigned: true,
      delete: false,
      assign: true,
      change_status: true,
      change_priority: true,
      add_comments: true,
      delete_comments: false,
      view_activity: true,
      attach_files: true,
      delete_files: false,
      print_labels: true,
      export: true,
    },
    inventory: {
      view: true,
      resolve_units: true,
      manage_batches: true,
      delete: false,
      export: true,
      manage_warehouses: false,
      transfer: false,
    },
    dashboard: {
      view_dashboard: true,
      view_analytics: true,
      view_reports: true,
      export_reports: true,
      customize_dashboard: false,
    },
    user_management: {
      view_users: true,
      create_users: false,
      edit_users: false,
      delete_users: false,
      assign_roles: false,
      manage_permissions: false,
      create_roles: false,
      delete_roles: false,
    },
    time_tracking: { log: true, view_all: true, delete: false },
    parts: { view: true, create: true, edit: true, delete: false, adjust_stock: true },
    calendar: { view: true },
    reports: { view: true, export: true },
    // RLS: manager_or_above() sees/edits all leads/deals/activities/contacts
    // (matching contacts_update + leads/deals/activities's composite policies).
    // pipelines write is admin-only at the RLS layer (Step 3 migration) — manager
    // is read-only here, same as every other manager section never getting delete.
    leads: { view: true, create: true, edit: true, delete: false },
    deals: { view: true, create: true, edit: true, delete: false },
    activities: { view: true, create: true, edit: true, delete: false },
    contacts: { view: true, create: true, edit: true, delete: false },
    pipelines: { view: true, manage: false },
    // ── Money modules ───────────────────────────────────────────────────────
    // These three had no permission of their own: Sales, Accounting and
    // Purchasing were all gated on `deals.view`, so a single CRM toggle decided
    // who could raise a purchase order or reverse a payment.
    sales: {
      view: true, create: true, edit: true, delete: false,
      post: true, cancel: true, export: true,
    },
    accounting: { view: true, record_payment: true, reverse_payment: true, export: true },
    // No `approve`: a manager can raise and receive a purchase order but not
    // approve their own spend. admin/super_admin bypass canDo, so approval
    // lands with them.
    purchasing: {
      view: true, create: true, edit: true, approve: false, receive: true,
      cancel: true, manage_vendors: true, export: true,
    },
  },
  [ROLES.TECHNICIAN]: {
    products: {
      view: true,
      create: false,
      edit: false,
      delete: false,
      export: false,
      import: false,
    },
    customers: {
      view: true,
      create: false,
      edit: false,
      delete: false,
      export: false,
      import: false,
      view_history: true,
    },
    rma_tickets: {
      view_all: true,
      view_assigned: true,
      create: false,
      edit_all: false,
      edit_assigned: true,
      delete: false,
      assign: false,
      change_status: true,
      change_priority: false,
      add_comments: true,
      delete_comments: false,
      view_activity: true,
      attach_files: true,
      delete_files: false,
      print_labels: true,
      export: false,
    },
    inventory: {
      view: true,
      resolve_units: true,
      manage_batches: false,
      delete: false,
      export: false,
      manage_warehouses: false,
      transfer: false,
    },
    dashboard: {
      view_dashboard: true,
      view_analytics: false,
      view_reports: false,
      export_reports: false,
      customize_dashboard: false,
    },
    user_management: {
      view_users: false,
      create_users: false,
      edit_users: false,
      delete_users: false,
      assign_roles: false,
      manage_permissions: false,
      create_roles: false,
      delete_roles: false,
    },
    time_tracking: { log: true, view_all: false, delete: false },
    parts: { view: true, create: false, edit: false, delete: false, adjust_stock: true },
    calendar: { view: true },
    reports: { view: false, export: false },
    sales: { view: false, create: false, edit: false, delete: false, post: false, cancel: false, export: false },
    accounting: { view: false, record_payment: false, reverse_payment: false, export: false },
    purchasing: {
      view: false, create: false, edit: false, approve: false, receive: false,
      cancel: false, manage_vendors: false, export: false,
    },
  },
  [ROLES.VIEWER]: {
    products: {
      view: true,
      create: false,
      edit: false,
      delete: false,
      export: false,
      import: false,
    },
    customers: {
      view: true,
      create: false,
      edit: false,
      delete: false,
      export: false,
      import: false,
      view_history: true,
    },
    rma_tickets: {
      view_all: true,
      view_assigned: false,
      create: false,
      edit_all: false,
      edit_assigned: false,
      delete: false,
      assign: false,
      change_status: false,
      change_priority: false,
      add_comments: false,
      delete_comments: false,
      view_activity: true,
      attach_files: false,
      delete_files: false,
      print_labels: false,
      export: false,
    },
    inventory: {
      view: true,
      resolve_units: false,
      manage_batches: false,
      delete: false,
      export: true,
      manage_warehouses: false,
      transfer: false,
    },
    dashboard: {
      view_dashboard: true,
      view_analytics: false,
      view_reports: false,
      export_reports: false,
      customize_dashboard: false,
    },
    user_management: {
      view_users: false,
      create_users: false,
      edit_users: false,
      delete_users: false,
      assign_roles: false,
      manage_permissions: false,
      create_roles: false,
      delete_roles: false,
    },
    time_tracking: { log: false, view_all: false, delete: false },
    parts: { view: true, create: false, edit: false, delete: false },
    calendar: { view: true },
    reports: { view: false, export: false },
    sales: { view: false, create: false, edit: false, delete: false, post: false, cancel: false, export: false },
    accounting: { view: false, record_payment: false, reverse_payment: false, export: false },
    purchasing: {
      view: false, create: false, edit: false, approve: false, receive: false,
      cancel: false, manage_vendors: false, export: false,
    },
  },
  // sales_rep: CRM-focused role, RLS-scoped to "own" rows on leads/deals/
  // activities (see 20260621/22/23_crm_*.sql), read-only on customers except
  // their own assigned accounts (sales_rep_update_assigned policy), and no
  // access to RMA-internal sections (rma_tickets/inventory/parts) — those
  // sections are omitted entirely rather than set to false everywhere,
  // since canDo() already returns false for a missing section.
  [ROLES.SALES_REP]: {
    // Gap found during nav-visibility audit: the original matrix called for
    // "products.* -> read only" but this was missing from the initial Sprint 1
    // implementation. Without it, a sales_rep can't even reference the product
    // catalog when building a deal's product_lines.
    products: { view: true, create: false, edit: false, delete: false, export: false, import: false },
    leads: { view: true, create: true, edit: true, delete: false },
    deals: { view: true, create: true, edit: true, delete: false },
    activities: { view: true, create: true, edit: true, delete: false },
    // contacts RLS is manager_insert/manager_update only — sales_rep is
    // read-only here, matching the actual DB grant (Step 2 migration).
    contacts: { view: true, create: false, edit: false, delete: false },
    // pipelines write is admin-only at the RLS layer (Step 3 migration).
    pipelines: { view: true, manage: false },
    customers: {
      view: true,
      create: false,
      edit: true,
      delete: false,
      export: false,
      import: false,
      view_history: true,
    },
    // invoices INSERT requires manager_or_above() at the RLS layer (existing,
    // unchanged by this CRM migration set) — create stays false here so the
    // UI never offers an action that would fail at the RLS layer. Revisit if
    // sales_rep invoice creation is wanted later (needs its own RLS change).
    // Can raise and edit a quotation, but posting and cancelling an invoice are
    // manager actions — a rep should not be able to finalise revenue.
    sales: {
      view: true, create: true, edit: true, delete: false,
      post: false, cancel: false, export: true,
    },
    // Deliberately absent: accounting and purchasing. A sales_rep can reach
    // both today only because they borrow deals.view, which was never an
    // intentional grant. Removing it is the point of this change.
  },
}

/**
 * resolvePermissions(role, stored) → effective permissions object
 *
 * Merges a user's stored custom permissions ON TOP of their role defaults so that:
 *   - null / undefined / `{}` (empty)          → role defaults (the common case)
 *   - a partial object (missing some sections)  → role defaults fill the gaps
 *   - explicit per-action overrides (incl. false) → preserved over the default
 *
 * This fixes the "empty/partial object is truthy" trap where
 * `stored || ROLE_DEFAULT_PERMISSIONS[role]` would let a `{}` row silently
 * strip a user (e.g. a manager) of every permission. Call this once when
 * loading the session; pass the result to canDo().
 */
export function resolvePermissions(
  role: string,
  stored: UserPermissions | null | undefined
): UserPermissions | null {
  const defaults = ROLE_DEFAULT_PERMISSIONS[role as Role] ?? null
  const hasStored =
    !!stored && typeof stored === 'object' && Object.keys(stored).length > 0

  if (!hasStored) return defaults
  if (!defaults) return stored as UserPermissions // role with no built-in defaults

  const merged: UserPermissions = {}
  for (const section of Object.keys(defaults)) {
    merged[section] = { ...defaults[section], ...(stored![section] || {}) }
  }
  // Preserve any extra sections that only exist in the stored object
  for (const section of Object.keys(stored!)) {
    if (!merged[section]) merged[section] = { ...stored![section] }
  }
  return merged
}

/**
 * canDo(role, permissions, section, action) → boolean
 *
 * Usage: canDo(currentUserRole, currentUserPermissions, 'rma_tickets', 'delete')
 *
 * super_admin and admin always return true.
 * For other roles, checks permissions[section][action].
 */
export function canDo(
  role: string,
  permissions: UserPermissions | null | undefined,
  section: string,
  action: string
): boolean {
  if (role === ROLES.SUPER_ADMIN || role === ROLES.ADMIN) return true
  return !!permissions?.[section]?.[action]
}
