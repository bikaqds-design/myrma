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
    settings: {
      view_settings: true,
      edit_company_info: false,
      edit_branding: false,
      manage_email_templates: false,
      manage_statuses: false,
      manage_priorities: false,
      manage_categories: false,
      view_audit_logs: false,
    },
    invoices: { view: true, create: true, edit: true, delete: false },
    time_tracking: { log: true, view_all: true, delete: false },
    parts: { view: true, create: true, edit: true, delete: false },
    calendar: { view: true },
    reports: { view: true, export: true },
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
    settings: {
      view_settings: false,
      edit_company_info: false,
      edit_branding: false,
      manage_email_templates: false,
      manage_statuses: false,
      manage_priorities: false,
      manage_categories: false,
      view_audit_logs: false,
    },
    invoices: { view: true, create: false, edit: false, delete: false },
    time_tracking: { log: true, view_all: false, delete: false },
    parts: { view: true, create: false, edit: false, delete: false },
    calendar: { view: true },
    reports: { view: false, export: false },
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
    settings: {
      view_settings: false,
      edit_company_info: false,
      edit_branding: false,
      manage_email_templates: false,
      manage_statuses: false,
      manage_priorities: false,
      manage_categories: false,
      view_audit_logs: false,
    },
    invoices: { view: true, create: false, edit: false, delete: false },
    time_tracking: { log: false, view_all: false, delete: false },
    parts: { view: true, create: false, edit: false, delete: false },
    calendar: { view: true },
    reports: { view: false, export: false },
  },
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
