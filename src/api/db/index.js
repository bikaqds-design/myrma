// Assembles the full `db` object from domain modules.
// Import `db` from here (or from supabaseClient.js which re-exports it).
export { auditFlushQueue } from './audit.js'

import { userRoles, userActivity, userPreferences } from './users.js'
import { brands, categories, subcategories, products } from './catalog.js'
import { customers, customerNotes } from './customers.js'
import { rmaTickets, ticketActivity, ticketComments, rmaTracker, serialHistory } from './tickets.js'
import { announcements, rmaConfig, customFields, webhooks, auditLog, slaConfig, automationRules } from './system.js'
import { inventory, warehouses, parts, ticketParts, timeEntries, invoices } from './inventory.js'
import { notifications } from './notifications.js'

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
}
