// Pure helper functions and constants shared across the RMATickets module.
// (No React components here — kept in _shared.jsx to satisfy react-refresh rules.)

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

export const DEFAULT_DUE = () => {
  const d = new Date()
  d.setDate(d.getDate() + 7)
  return d.toISOString().split('T')[0]
}

export const EMPTY_PRODUCT = {
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
    'In Progress':'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-800 dark:text-indigo-400',
    Pending:      'bg-orange-100 dark:bg-orange-900/20 text-orange-800 dark:text-orange-400',
    'On Hold':    'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-400',
    Completed:    'bg-teal-100 dark:bg-teal-900/20 text-teal-800 dark:text-teal-400',
    Closed:       'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400',
    Cancelled:    'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-400',
    New:          'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-400',
  })[s] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]'

export const getPriorityColor = (p) =>
  ({
    Low:      'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]',
    Medium:   'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-400',
    High:     'bg-orange-100 dark:bg-orange-900/20 text-orange-800 dark:text-orange-400',
    Critical: 'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-400',
  })[p] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-800 dark:text-[#9aa4b2]'

export const fmt = (d) => (d ? new Date(d).toLocaleDateString() : 'N/A')

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
