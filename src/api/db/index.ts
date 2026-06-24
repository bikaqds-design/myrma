// Assembles the full `db` object from domain modules.
// Import `db` from here (or from supabaseClient.js which re-exports it).
export type { TableResult, PagedResult, CountedResult, PrefsResult, SetPrefsResult } from './types.js'
export { auditFlushQueue } from './audit.js'

import { userRoles, userActivity, userPreferences } from './users.js'
import { brands, categories, subcategories, products } from './catalog.js'
import { customers, customerNotes } from './customers.js'
import { rmaTickets, ticketActivity, ticketComments, rmaTracker, serialHistory, ticketResolutions } from './tickets.js'
import {
  announcements,
  rmaConfig,
  customFields,
  webhooks,
  auditLog,
  slaConfig,
  automationRules,
} from './system.js'
import { inventory, warehouses, parts, ticketParts, timeEntries, invoices } from './inventory.js'
import { notifications } from './notifications.js'
import {
  whatsappTemplates,
  notificationLogs,
  notificationSettings,
  notificationQueue,
} from './whatsappNotifications.js'
import { kbArticles } from './kb.js'
import { contacts } from './contacts.js'
import { pipelines } from './pipelines.js'
import { leads } from './leads.js'
import { deals } from './deals.js'
import { activities } from './activities.js'

export const db = {
  // Users & roles
  userRoles,
  userActivity,
  userPreferences,

  // Product catalog
  brands,
  categories,
  subcategories,
  products,

  // Customers
  customers,
  customerNotes,

  // Tickets
  rmaTickets,
  ticketActivity,
  ticketComments,
  rmaTracker,
  serialHistory,
  ticketResolutions,

  // System / config
  announcements,
  rmaConfig,
  customFields,
  webhooks,
  auditLog,
  slaConfig,
  automationRules,

  // Inventory & parts
  inventory,
  warehouses,
  parts,
  ticketParts,
  timeEntries,
  invoices,

  // In-app notifications
  notifications,

  // WhatsApp / messaging
  whatsappTemplates,
  notificationLogs,
  notificationSettings,
  notificationQueue,

  // Knowledge base
  kbArticles,

  // CRM
  contacts,
  pipelines,
  leads,
  deals,
  activities,
}

// Re-export all Row types for page components to import
export type { AuditLogRow } from './audit.js'
export type { AnnouncementRow, RmaConfigRow, CustomFieldRow, WebhookRow, SlaConfig, AutomationRule } from './system.js'
export type { UserRoleRow, UserActivityRow, UserPreferencesRow } from './users.js'
export type { NotificationRow } from './notifications.js'
export type { RMATicketRow, TicketActivityRow, TicketCommentRow, TicketProductItem, TicketResolutionRow } from './tickets.js'
export type { CustomerRow, CustomerNoteRow } from './customers.js'
export type { BrandRow, CategoryRow, SubcategoryRow, ProductRow } from './catalog.js'
export type {
  InventoryUnitRow, ManufacturerBatchRow, WarehouseRow,
  PartRow, TicketPartRow, TimeEntryRow, InvoiceRow, InventoryStatsRow,
} from './inventory.js'
export type {
  WhatsAppTemplateRow, TemplateVariable, NotificationLogRow,
  NotificationSettingRow, NotificationQueueRow,
} from './whatsappNotifications.js'
export type { KBArticleRow } from './kb.js'
export type { ContactRow } from './contacts.js'
export type { PipelineRow, PipelineStage } from './pipelines.js'
export type { LeadRow } from './leads.js'
export type { DealRow, DealProductLine } from './deals.js'
export type { ActivityRow, ActivityAttachment, ActivityCreateInput } from './activities.js'
