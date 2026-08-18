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
    leads: { view_all: true, view: true, create: true, edit: true, delete: false },
    deals: { view_all: true, view: true, create: true, edit: true, delete: false },
    activities: { view_all: true, view: true, create: true, edit: true, delete: false },
    contacts: { view: true, create: true, edit: true, delete: false },
    pipelines: { view: true, manage: false },
    // ── Money modules ───────────────────────────────────────────────────────
    // These three had no permission of their own: Sales, Accounting and
    // Purchasing were all gated on `deals.view`, so a single CRM toggle decided
    // who could raise a purchase order or reverse a payment.
    sales: {
      view_all: true,
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
  /**
   * accountant — owns cash, owns nothing that creates it.
   *
   * Records and reverses customer and vendor payments, and can see the
   * documents behind them, but cannot raise an invoice, post one, or approve a
   * purchase order. That split is the point: standard AR/AP segregation of
   * duties says no single person should be able to authorise, execute and
   * record a payment, because that is the combination that lets money move
   * unnoticed.
   *
   * So: sales and purchasing are read-only here. A manager raises the invoice,
   * an admin approves the spend, the accountant settles and reconciles it.
   */
  [ROLES.ACCOUNTANT]: {
    accounting: { view: true, record_payment: true, reverse_payment: true, export: true },
    // Read-only on both document sides — needed to reconcile, not to originate.
    sales: {
      view: true, view_all: true, create: false, edit: false, delete: false,
      post: false, cancel: false, export: true,
    },
    purchasing: {
      view: true, create: false, edit: false, approve: false, receive: false,
      cancel: false, manage_vendors: false, export: true,
    },
    // Chasing collections needs the customer record and its history.
    customers: {
      view: true, create: false, edit: false, delete: false,
      export: true, import: false, view_history: true,
    },
    products: { view: true, create: false, edit: false, delete: false, export: true, import: false },
    reports: { view: true, export: true },
    dashboard: {
      view_dashboard: true, view_analytics: true, view_reports: true,
      export_reports: true, customize_dashboard: false,
    },
    // Deliberately absent: deals, leads, activities, pipelines, contacts,
    // rma_tickets, inventory, parts, time_tracking, calendar, user_management.
    // An accountant has no reason to work the sales pipeline or the repair
    // bench, and least privilege means the module is not there at all rather
    // than present and switched off.
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
    leads: { view_all: false, view: true, create: true, edit: true, delete: false },
    deals: { view_all: false, view: true, create: true, edit: true, delete: false },
    activities: { view_all: false, view: true, create: true, edit: true, delete: false },
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
      view_all: false,
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
/**
 * roleDefaults — the permission map a role starts from.
 *
 * Built-ins come from ROLE_DEFAULT_PERMISSIONS; a custom role's defaults are
 * the map stored on its custom_roles row. Needed in three places — session
 * load, preview-as-user, and the permission editor — and the editor is the one
 * that bites: falling back to an all-false template there shows the wrong
 * state, hides the cross-tier warning, and writes an all-false override the
 * moment someone saves, stripping a user's access while they still hold the
 * role. Two of the three had already been written separately before this was
 * pulled out.
 */
export function roleDefaults(
  role: string,
  customRoles?: Array<{ role_name: string; permissions?: UserPermissions }> | null
): UserPermissions | null {
  const builtIn = ROLE_DEFAULT_PERMISSIONS[role as Role]
  if (builtIn) return builtIn
  return (customRoles || []).find((r) => r.role_name === role)?.permissions ?? null
}

export function resolvePermissions(
  role: string,
  stored: UserPermissions | null | undefined,
  customRoleDefaults?: UserPermissions | null
): UserPermissions | null {
  // A custom role has no entry in ROLE_DEFAULT_PERMISSIONS; its defaults are
  // the permission map stored on the custom_roles row. Without this a user on a
  // custom role resolves to null and canDo() denies everything, so the role
  // would be assignable and useless — the failure this change exists to fix,
  // moved one layer down.
  //
  // It only ever narrows: RLS resolves a custom role to its base_role, so the
  // server ceiling is the base role's regardless of what this map claims.
  const defaults =
    ROLE_DEFAULT_PERMISSIONS[role as Role] ?? customRoleDefaults ?? null
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

/**
 * ownershipScope — the email a role is restricted to, or null for "sees all".
 *
 * A sales rep must only see their own work: their quotations, their sales
 * orders, their invoices, their deals. Row-level security in Postgres is the
 * boundary that actually enforces that — this is the app agreeing with it, so
 * the UI does not build filters, counts and dropdowns out of rows the server
 * would refuse to serve anyway.
 *
 * Returning an email rather than a boolean keeps the call sites honest: a page
 * either filters by a specific person or it does not filter at all, and there
 * is no third state where a missing email quietly means "everything".
 *
 *     const scope = ownershipScope(role, permissions, 'sales', email)
 *     const mine = scope ? docs.filter((d) => d.assigned_rep === scope) : docs
 *
 * Note this is NOT a security boundary. Anything it hides is still reachable by
 * a direct API call; RLS is what stops that. Treat this as making the interface
 * truthful, not as protection.
 */
export const NO_OWNER_MATCH = ' no-owner'

export function ownershipScope(
  role: string,
  permissions: UserPermissions | null | undefined,
  section: string,
  userEmail: string | null | undefined
): string | null {
  if (role === ROLES.SUPER_ADMIN || role === ROLES.ADMIN) return null
  if (canDo(role, permissions, section, 'view_all')) return null
  // Restricted, but we do not know who they are. Returning null here would mean
  // "no filter" and hand them everything — the one failure this function must
  // not have. NO_OWNER_MATCH can never equal a stored email, so the page shows
  // nothing, which is the safe direction to be wrong in.
  return userEmail || NO_OWNER_MATCH
}

