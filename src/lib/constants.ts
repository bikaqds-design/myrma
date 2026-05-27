// ─── Application-wide constants ───────────────────────────────────────────────
// Single source of truth for every magic string used in business logic.
// Import from here instead of hard-coding strings inline.
//
// Usage:
//   import { ROLES, TICKET_STATUS, PRIORITY } from '../lib/constants'
//   if (role === ROLES.SUPER_ADMIN) { ... }
//   <option value={TICKET_STATUS.OPEN}>{TICKET_STATUS.OPEN}</option>

// ── User roles ──────────────────────────────────────────────────────────────
export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  MANAGER: 'manager',
  TECHNICIAN: 'technician',
  VIEWER: 'viewer',
} as const

export type Role = (typeof ROLES)[keyof typeof ROLES]

export const ROLE_LIST: Role[] = [
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.MANAGER,
  ROLES.TECHNICIAN,
  ROLES.VIEWER,
]

// ── User account statuses ────────────────────────────────────────────────────
export const USER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  LOCKED: 'locked',
} as const

// ── Ticket statuses ──────────────────────────────────────────────────────────
export const TICKET_STATUS = {
  OPEN: 'Open',
  IN_PROGRESS: 'In Progress',
  PENDING: 'Pending',
  ON_HOLD: 'On Hold',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
} as const

export type TicketStatus = (typeof TICKET_STATUS)[keyof typeof TICKET_STATUS]

export const TICKET_STATUS_LIST: TicketStatus[] = [
  TICKET_STATUS.OPEN,
  TICKET_STATUS.IN_PROGRESS,
  TICKET_STATUS.PENDING,
  TICKET_STATUS.ON_HOLD,
  TICKET_STATUS.CLOSED,
  TICKET_STATUS.CANCELLED,
]

/** Statuses that are considered "resolved" — ticket is no longer active */
export const TICKET_STATUS_RESOLVED: TicketStatus[] = [
  TICKET_STATUS.CLOSED,
  TICKET_STATUS.CANCELLED,
]

/** Statuses that are considered "open/active" for SLA + overdue calculations */
export const TICKET_STATUS_ACTIVE: TicketStatus[] = [
  TICKET_STATUS.OPEN,
  TICKET_STATUS.IN_PROGRESS,
  TICKET_STATUS.PENDING,
  TICKET_STATUS.ON_HOLD,
]

// ── Ticket priorities ────────────────────────────────────────────────────────
export const PRIORITY = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
} as const

export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY]

export const PRIORITY_LIST: Priority[] = [
  PRIORITY.CRITICAL,
  PRIORITY.HIGH,
  PRIORITY.MEDIUM,
  PRIORITY.LOW,
]

/** Sort weight for priority (lower = more urgent) */
export const PRIORITY_WEIGHT: Record<Priority, number> = {
  [PRIORITY.CRITICAL]: 0,
  [PRIORITY.HIGH]: 1,
  [PRIORITY.MEDIUM]: 2,
  [PRIORITY.LOW]: 3,
}

// ── Inventory unit statuses ──────────────────────────────────────────────────
export const INVENTORY_STATUS = {
  ACTIVE_RMA: 'active_rma',
  COMPANY_STOCK: 'company_stock',
  SENT_TO_MANUFACTURER: 'sent_to_manufacturer',
  CLOSED: 'closed',
} as const

// ── Manufacturer batch statuses ──────────────────────────────────────────────
export const BATCH_STATUS = {
  DRAFT: 'draft',
  SENT: 'sent',
  RESOLVED: 'resolved',
} as const

// ── In-app notification types ────────────────────────────────────────────────
export const NOTIF_TYPE = {
  INFO: 'info',
  WARNING: 'warning',
  SUCCESS: 'success',
  ERROR: 'error',
  ANNOUNCEMENT: 'announcement',
  CUSTOM_ALERT: 'custom_alert',
} as const

// ── Announcement / banner types (mirrors NOTIF_TYPE for display) ─────────────
export const BANNER_TYPE = {
  INFO: 'info',
  WARNING: 'warning',
  SUCCESS: 'success',
  ERROR: 'error',
} as const

// ── Automation rule triggers ─────────────────────────────────────────────────
export const AUTOMATION_TRIGGER = {
  TICKET_CREATED: 'ticket_created',
  TICKET_UPDATED: 'ticket_updated',
  TICKET_CLOSED: 'ticket_closed',
} as const

// ── Automation rule action types ─────────────────────────────────────────────
export const AUTOMATION_ACTION = {
  CHANGE_STATUS: 'change_status',
  CHANGE_PRIORITY: 'change_priority',
  ASSIGN_TECHNICIAN: 'assign_technician',
  CREATE_NOTIFICATION: 'create_notification',
} as const

// ── Automation condition operators ───────────────────────────────────────────
export const CONDITION_OP = {
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  CONTAINS: 'contains',
  STARTS_WITH: 'starts_with',
} as const

// ── rma_config keys ──────────────────────────────────────────────────────────
export const CONFIG_KEY = {
  SLA_CONFIG: 'sla_config',
  AUTOMATION_RULES: 'automation_rules',
  APPEARANCE: 'appearance_settings',
} as const

// ── Warranty statuses ────────────────────────────────────────────────────────
export const WARRANTY_STATUS = {
  IN_WARRANTY: 'In Warranty',
  OUT_OF_WARRANTY: 'Out of Warranty',
  UNKNOWN: 'Unknown',
} as const

export const WARRANTY_STATUS_LIST = [
  WARRANTY_STATUS.IN_WARRANTY,
  WARRANTY_STATUS.OUT_OF_WARRANTY,
  WARRANTY_STATUS.UNKNOWN,
] as const

// ── Resolution types (inventory) ─────────────────────────────────────────────
export const RESOLUTION_TYPE = {
  RETURN_TO_CUSTOMER: 'return_to_customer',
  COMPANY_STOCK: 'company_stock',
} as const

// ── Customer statuses ────────────────────────────────────────────────────────
export const CUSTOMER_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  VIP: 'vip',
} as const

// ── Product statuses ─────────────────────────────────────────────────────────
export const PRODUCT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  DISCONTINUED: 'discontinued',
} as const

// ── LocalStorage keys ────────────────────────────────────────────────────────
export const STORAGE_KEY = {
  APPEARANCE: 'mrma_appearance',
  AUDIT_QUEUE: 'mrma_audit_queue',
  NOTIF_PREFS: (email: string): string => `notif_system_prefs_${email}`,
} as const
