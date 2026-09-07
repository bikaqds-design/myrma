import { addDaysLocalISO } from '../../lib/dates'
// Pure helper functions and constants shared across the RMATickets module.
// (No React components here — kept in _shared.jsx to satisfy react-refresh rules.)

/**
 * A PROVISIONAL RMA number, used only for the preview in the form header and
 * as the folder name attachments are uploaded under before the row exists.
 *
 * It is no longer the identifier. Since migration 20260832 the database assigns
 * `rma_number` on insert and ignores whatever the client sends (BUG-035) —
 * this max-of-what-the-browser-holds approach gave two concurrent users the
 * same number, and the second save failed on the unique index after the whole
 * form had been filled in. It also counted from a list capped at 5,000 rows.
 *
 * Anything the user or a customer actually sees must come from the saved row.
 */
export const generateRmaNumber = (existingTickets = []) => {
  const now = new Date()
  const dd = String(now.getDate()).padStart(2, '0')
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const yyyy = now.getFullYear()
  const dateStr = `${dd}${mm}${yyyy}`
  const prefix = `RMA-${dateStr}-`

  const todaySerials = existingTickets
    .map((t) => t.rma_number)
    .filter((n) => n?.startsWith(prefix))
    .map((n) => parseInt(n.replace(prefix, ''), 10))
    .filter((n) => !isNaN(n))

  const nextSerial = todaySerials.length > 0 ? Math.max(...todaySerials) + 1 : 1
  return `${prefix}${String(nextSerial).padStart(4, '0')}`
}

// Local calendar, not UTC. Was `d.setDate(d.getDate() + 7)` followed by
// `toISOString().split('T')[0]` — local arithmetic formatted as UTC, so at
// 01:00 Cairo "seven days from today" came out as six (BUG-038).
export const DEFAULT_DUE = () => addDaysLocalISO(7)

export const EMPTY_PRODUCT = {
  // Set when the product is picked from the catalog dropdown; null for a typed
  // name. Carried onto the inventory_unit so the Warehouse Dashboard can group
  // the RMA by product — see src/lib/rmaUnitCreate.ts.
  product_id: null,
  product_name: '',
  serial_number: '',
  product_status: 'Received',
  warranty_status: 'In Warranty',
  issue_description: '',
}

export const CARRIERS = ['', 'FedEx', 'UPS', 'DHL', 'USPS', 'Australia Post', 'Royal Mail', 'Other']

export const getStatusColor = (s) =>
  ({
    Open:         'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-400',
    'In Progress':'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-800 dark:text-indigo-300',
    Pending:      'bg-orange-100 dark:bg-orange-900/20 text-orange-800 dark:text-orange-300',
    'On Hold':    'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-400',
    Completed:    'bg-teal-100 dark:bg-teal-900/20 text-teal-800 dark:text-teal-400',
    Closed:       'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400',
    Cancelled:    'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-300',
    New:          'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-400',
  })[s] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]'

export const getPriorityColor = (p) =>
  ({
    Low:      'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]',
    Medium:   'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-400',
    High:     'bg-orange-100 dark:bg-orange-900/20 text-orange-800 dark:text-orange-300',
    Critical: 'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-300',
  })[p] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]'

export const formatDate = (d) => (d ? new Date(d).toLocaleDateString() : 'N/A')

export const fmtDateTime = (d) => {
  if (!d) return 'N/A'
  const dt = new Date(d)
  return (
    dt.toLocaleDateString() +
    ' ' +
    dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  )
}

export const fmtBytes = (b) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`)

export const isImage = (t) => t?.startsWith('image/')
