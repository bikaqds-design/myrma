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
  SALES_REP: 'sales_rep',
} as const

export type Role = (typeof ROLES)[keyof typeof ROLES]

export const ROLE_LIST: Role[] = [
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.MANAGER,
  ROLES.TECHNICIAN,
  ROLES.VIEWER,
  ROLES.SALES_REP,
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
  COMPLETED: 'Completed',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
} as const

export type TicketStatus = (typeof TICKET_STATUS)[keyof typeof TICKET_STATUS]

export const TICKET_STATUS_LIST: TicketStatus[] = [
  TICKET_STATUS.OPEN,
  TICKET_STATUS.IN_PROGRESS,
  TICKET_STATUS.PENDING,
  TICKET_STATUS.ON_HOLD,
  TICKET_STATUS.COMPLETED,
  TICKET_STATUS.CLOSED,
  TICKET_STATUS.CANCELLED,
]

/** Statuses that are considered "resolved" — ticket is no longer actively worked on */
export const TICKET_STATUS_RESOLVED: TicketStatus[] = [
  TICKET_STATUS.COMPLETED,
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

// ── Invoice statuses (legacy RMA invoices — Invoices.jsx) ────────────────────
export const INVOICE_STATUS = {
  DRAFT: 'draft',
  SENT: 'sent',
  PAID: 'paid',
  PENDING: 'pending',
  OVERDUE: 'overdue',
  VOID: 'void',
} as const

// ── LocalStorage keys ────────────────────────────────────────────────────────
export const STORAGE_KEY = {
  APPEARANCE: 'mrma_appearance',
  AUDIT_QUEUE: 'mrma_audit_queue',
  NOTIF_PREFS: (email: string): string => `notif_system_prefs_${email}`,
} as const

// ── CRM: lead statuses ───────────────────────────────────────────────────────
export const LEAD_STATUS = {
  NEW: 'new',
  CONTACTED: 'contacted',
  QUALIFIED: 'qualified',
  NURTURING: 'nurturing',
  INACTIVE: 'inactive',
  CONVERTED: 'converted',
  DISQUALIFIED: 'disqualified',
} as const

export type LeadStatus = (typeof LEAD_STATUS)[keyof typeof LEAD_STATUS]

export const LEAD_STATUS_LIST: LeadStatus[] = [
  LEAD_STATUS.NEW,
  LEAD_STATUS.CONTACTED,
  LEAD_STATUS.QUALIFIED,
  LEAD_STATUS.NURTURING,
  LEAD_STATUS.INACTIVE,
  LEAD_STATUS.CONVERTED,
  LEAD_STATUS.DISQUALIFIED,
]

// ── CRM: lead sources ────────────────────────────────────────────────────────
export const LEAD_SOURCE = {
  WALK_IN: 'walk-in',
  PHONE: 'phone',
  REFERRAL: 'referral',
  EXHIBITION: 'exhibition',
  WEBSITE: 'website',
  WHATSAPP: 'whatsapp',
} as const

export type LeadSource = (typeof LEAD_SOURCE)[keyof typeof LEAD_SOURCE]

export const LEAD_SOURCE_LIST: LeadSource[] = [
  LEAD_SOURCE.WALK_IN,
  LEAD_SOURCE.PHONE,
  LEAD_SOURCE.REFERRAL,
  LEAD_SOURCE.EXHIBITION,
  LEAD_SOURCE.WEBSITE,
  LEAD_SOURCE.WHATSAPP,
]

// ── CRM: deal statuses ───────────────────────────────────────────────────────
export const DEAL_STATUS = {
  OPEN: 'open',
  WON: 'won',
  LOST: 'lost',
} as const

export type DealStatus = (typeof DEAL_STATUS)[keyof typeof DEAL_STATUS]

export const DEAL_STATUS_LIST: DealStatus[] = [
  DEAL_STATUS.OPEN,
  DEAL_STATUS.WON,
  DEAL_STATUS.LOST,
]

// A deal untouched (no stage change) for this many days is flagged "rotting"
// on the Pipeline Kanban card. Global constant for v1 — Odoo makes this a
// per-stage admin setting, but with two simple pipelines and no usage data
// yet on whether reps even want it tunable, a single sensible default avoids
// building a config UI for a threshold nobody has asked to change.
export const DEAL_ROTTING_THRESHOLD_DAYS = 7

// ── CRM: activity types ──────────────────────────────────────────────────────
export const ACTIVITY_TYPE = {
  CALL: 'call',
  MEETING: 'meeting',
  WHATSAPP: 'whatsapp',
  EMAIL: 'email',
  NOTE: 'note',
  TASK: 'task',
  LOG: 'log',
} as const

export type ActivityType = (typeof ACTIVITY_TYPE)[keyof typeof ACTIVITY_TYPE]

export const ACTIVITY_TYPE_LIST: ActivityType[] = [
  ACTIVITY_TYPE.CALL,
  ACTIVITY_TYPE.MEETING,
  ACTIVITY_TYPE.WHATSAPP,
  ACTIVITY_TYPE.EMAIL,
  ACTIVITY_TYPE.NOTE,
  ACTIVITY_TYPE.TASK,
  ACTIVITY_TYPE.LOG,
]

// User-schedulable activity types (excludes 'log', which is system-generated only)
export const ACTIVITY_TYPE_SCHEDULABLE: ActivityType[] = [
  ACTIVITY_TYPE.CALL,
  ACTIVITY_TYPE.MEETING,
  ACTIVITY_TYPE.WHATSAPP,
  ACTIVITY_TYPE.EMAIL,
  ACTIVITY_TYPE.TASK,
]

// ── CRM: customer lifecycle stages ───────────────────────────────────────────
export const LIFECYCLE_STAGE = {
  LEAD: 'lead',
  PROSPECT: 'prospect',
  CUSTOMER: 'customer',
  CHURNED: 'churned',
} as const

export type LifecycleStage = (typeof LIFECYCLE_STAGE)[keyof typeof LIFECYCLE_STAGE]

export const LIFECYCLE_STAGE_LIST: LifecycleStage[] = [
  LIFECYCLE_STAGE.LEAD,
  LIFECYCLE_STAGE.PROSPECT,
  LIFECYCLE_STAGE.CUSTOMER,
  LIFECYCLE_STAGE.CHURNED,
]

// ── Sales Documents: quotation statuses ─────────────────────────────────────
export const QUOTATION_STATUS = {
  DRAFT: 'draft',
  SENT: 'sent',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
} as const

export type QuotationStatus = (typeof QUOTATION_STATUS)[keyof typeof QUOTATION_STATUS]

export const QUOTATION_STATUS_LIST: QuotationStatus[] = [
  QUOTATION_STATUS.DRAFT,
  QUOTATION_STATUS.SENT,
  QUOTATION_STATUS.ACCEPTED,
  QUOTATION_STATUS.DECLINED,
  QUOTATION_STATUS.EXPIRED,
  QUOTATION_STATUS.CANCELLED,
]

/** Only these statuses allow converting a quotation to a sales order */
export const QUOTATION_CONVERTIBLE_STATUSES: QuotationStatus[] = [
  QUOTATION_STATUS.DRAFT,
  QUOTATION_STATUS.ACCEPTED,
]

// ── Sales Documents: sales order statuses ────────────────────────────────────
export const SALES_ORDER_STATUS = {
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
} as const

export type SalesOrderStatus = (typeof SALES_ORDER_STATUS)[keyof typeof SALES_ORDER_STATUS]

export const SALES_ORDER_STATUS_LIST: SalesOrderStatus[] = [
  SALES_ORDER_STATUS.DRAFT,
  SALES_ORDER_STATUS.CONFIRMED,
  SALES_ORDER_STATUS.DELIVERED,
  SALES_ORDER_STATUS.CANCELLED,
]

// ── Sales Documents: invoice document lifecycle status ───────────────────────
// Separate from payment status — governs editability and whether lines are locked.
export const INVOICE_DOC_STATUS = {
  DRAFT: 'draft',
  POSTED: 'posted',
  CANCELLED: 'cancelled',
} as const

export type InvoiceDocStatus = (typeof INVOICE_DOC_STATUS)[keyof typeof INVOICE_DOC_STATUS]

export const INVOICE_DOC_STATUS_LIST: InvoiceDocStatus[] = [
  INVOICE_DOC_STATUS.DRAFT,
  INVOICE_DOC_STATUS.POSTED,
  INVOICE_DOC_STATUS.CANCELLED,
]

// ── Sales Documents: invoice payment status ──────────────────────────────────
// Separate from doc status — derived from sum of payments vs total; never
// manually set. A posted invoice starts as 'unpaid' and progresses as payments
// are recorded against it.
export const INVOICE_PAYMENT_STATUS = {
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  PAID: 'paid',
  REVERSED: 'reversed',
} as const

export type InvoicePaymentStatus =
  (typeof INVOICE_PAYMENT_STATUS)[keyof typeof INVOICE_PAYMENT_STATUS]

export const INVOICE_PAYMENT_STATUS_LIST: InvoicePaymentStatus[] = [
  INVOICE_PAYMENT_STATUS.UNPAID,
  INVOICE_PAYMENT_STATUS.PARTIAL,
  INVOICE_PAYMENT_STATUS.PAID,
  INVOICE_PAYMENT_STATUS.REVERSED,
]

// ── Sales Documents: credit note statuses ────────────────────────────────────
export const CREDIT_NOTE_STATUS = {
  DRAFT: 'draft',
  ISSUED: 'issued',
  APPLIED: 'applied',
  VOIDED: 'voided',
} as const

export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUS)[keyof typeof CREDIT_NOTE_STATUS]

export const CREDIT_NOTE_STATUS_LIST: CreditNoteStatus[] = [
  CREDIT_NOTE_STATUS.DRAFT,
  CREDIT_NOTE_STATUS.ISSUED,
  CREDIT_NOTE_STATUS.APPLIED,
  CREDIT_NOTE_STATUS.VOIDED,
]

// ── Sales Documents: credit note types ──────────────────────────────────────
// The type drives whether inventory is restocked. rma_return = restock eligible;
// rebate / discount / correction = financial-only, no stock movement.
export const CREDIT_NOTE_TYPE = {
  RMA_RETURN: 'rma_return',
  REBATE: 'rebate',
  DISCOUNT: 'discount',
  CORRECTION: 'correction',
} as const

export type CreditNoteType = (typeof CREDIT_NOTE_TYPE)[keyof typeof CREDIT_NOTE_TYPE]

export const CREDIT_NOTE_TYPE_LIST: CreditNoteType[] = [
  CREDIT_NOTE_TYPE.RMA_RETURN,
  CREDIT_NOTE_TYPE.REBATE,
  CREDIT_NOTE_TYPE.DISCOUNT,
  CREDIT_NOTE_TYPE.CORRECTION,
]

/** Credit note types that trigger inventory restock on issue */
export const CREDIT_NOTE_INVENTORY_TYPES: CreditNoteType[] = [CREDIT_NOTE_TYPE.RMA_RETURN]

// ── Purchasing: Purchase Order statuses ─────────────────────────────────────
// Non-financial document — never touches inventory. completed/partially_completed
// are set server-side by receive_vendor_invoice when a linked Vendor Invoice is
// received (20260758_receive_vi_po_completion.sql), not by direct client update.
export const PO_STATUS = {
  DRAFT: 'draft',
  SENT: 'sent',
  PENDING_CONFIRMATION: 'pending_confirmation',
  CONFIRMED: 'confirmed',
  PARTIALLY_COMPLETED: 'partially_completed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
} as const

export type PoStatus = (typeof PO_STATUS)[keyof typeof PO_STATUS]

export const PO_STATUS_FLOW: PoStatus[] = [
  PO_STATUS.DRAFT,
  PO_STATUS.SENT,
  PO_STATUS.PENDING_CONFIRMATION,
  PO_STATUS.CONFIRMED,
  PO_STATUS.PARTIALLY_COMPLETED,
  PO_STATUS.COMPLETED,
]

// ── Purchasing: Vendor Invoice statuses ─────────────────────────────────────
// The financial document — approval gates receipt, receipt triggers inventory
// + the vendor-payable balance.
export const VI_STATUS = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  PARTIALLY_RECEIVED: 'partially_received',
  RECEIVED: 'received',
  CANCELLED: 'cancelled',
} as const

export type ViStatus = (typeof VI_STATUS)[keyof typeof VI_STATUS]

export const VI_STATUS_FLOW: ViStatus[] = [
  VI_STATUS.DRAFT,
  VI_STATUS.PENDING_APPROVAL,
  VI_STATUS.APPROVED,
  VI_STATUS.PARTIALLY_RECEIVED,
  VI_STATUS.RECEIVED,
]

// ── Warehouse Module R1: system RMA/transit/virtual locations ──────────────
// Fixed codes seeded + protected by 20260764_warehouse_system_locations.sql.
// RMA ticket product-status changes auto-move units between these via
// move_rma_units (see src/lib/rmaStageMoves.ts).
export const SYSTEM_WAREHOUSE_CODES = {
  RMA_RECEIVED: 'RMA-RECEIVED',
  RMA_REPAIR: 'RMA-REPAIR',
  RMA_REPAIRED: 'RMA-REPAIRED',
  RMA_CANTREPAIR: 'RMA-CANTREPAIR',
  RMA_STOCK: 'RMA-STOCK',
  REPLACEMENT: 'REPLACEMENT',
  CREDIT_NOTE: 'CREDIT-NOTE',
  SCRAP: 'SCRAP',
} as const

export type SystemWarehouseCode = (typeof SYSTEM_WAREHOUSE_CODES)[keyof typeof SYSTEM_WAREHOUSE_CODES]

/** The 5 RMA-stage locations, in workflow order (excludes Replacement/Credit Note/Scrap) */
export const RMA_STAGE_CODES: SystemWarehouseCode[] = [
  SYSTEM_WAREHOUSE_CODES.RMA_RECEIVED,
  SYSTEM_WAREHOUSE_CODES.RMA_REPAIR,
  SYSTEM_WAREHOUSE_CODES.RMA_REPAIRED,
  SYSTEM_WAREHOUSE_CODES.RMA_CANTREPAIR,
  SYSTEM_WAREHOUSE_CODES.RMA_STOCK,
]

/**
 * Ticket product_status (free text, from rma_tickets.products[].product_status)
 * -> the system location a unit auto-moves to. Unmapped/empty text falls back
 * to RMA_RECEIVED (a unit with no recognized stage is treated as just-received).
 * Replacement AND Credit Note both land in RMA_STOCK — the ticket status is
 * intent only; the real onward move is driven by the actual CN-issue/
 * replacement-shipment event (R2), not the ticket status itself.
 */
export const RMA_STAGE_LOCATION: Record<string, SystemWarehouseCode> = {
  Received: SYSTEM_WAREHOUSE_CODES.RMA_RECEIVED,
  'Under Repair': SYSTEM_WAREHOUSE_CODES.RMA_REPAIR,
  Repaired: SYSTEM_WAREHOUSE_CODES.RMA_REPAIRED,
  "Can't Repair": SYSTEM_WAREHOUSE_CODES.RMA_CANTREPAIR,
  Replacement: SYSTEM_WAREHOUSE_CODES.RMA_STOCK,
  'Credit Note': SYSTEM_WAREHOUSE_CODES.RMA_STOCK,
}

// ── Warehouse types: capability flags (Warehouse Module R1) ─────────────────
// Display/UI-only filtering (destination pickers etc.) — the existing RPCs
// enforce no server-side capability guard yet (see plan risk R7). A NULL
// warehouse_type (every warehouse created before this model) is treated as
// full-capability so legacy warehouses never become more restrictive than
// they already were.
export const WAREHOUSE_TYPE_CAPABILITIES = {
  main: { sellable: true, receivable: true, transferable: true },
  branch: { sellable: true, receivable: true, transferable: true },
  service_center: { sellable: false, receivable: true, transferable: true },
  rma: { sellable: false, receivable: false, transferable: true },
  transit: { sellable: false, receivable: false, transferable: true },
  virtual: { sellable: false, receivable: false, transferable: false },
} as const

export type WarehouseType = keyof typeof WAREHOUSE_TYPE_CAPABILITIES

export interface WarehouseCapabilities {
  sellable: boolean
  receivable: boolean
  transferable: boolean
}

export function warehouseCapabilities(type: string | null | undefined): WarehouseCapabilities {
  if (!type || !(type in WAREHOUSE_TYPE_CAPABILITIES)) {
    return { sellable: true, receivable: true, transferable: true }
  }
  return WAREHOUSE_TYPE_CAPABILITIES[type as WarehouseType]
}
