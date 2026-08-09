// Shared presentation helpers for the Purchase Module.
//
// These lived inline in index.jsx until VendorDetails needed the same status
// labels and document-type badges. Rather than keep a second copy in sync by
// hand — the habit that left the warehouse-destination filter written four
// times and wrong in all four — they live here and both pages import them.

export const DOC_TYPE_LABEL_KEY = {
  purchase_order: 'purchasing.docType_purchase_order',
  vendor_invoice: 'purchasing.docType_vendor_invoice',
}

export const DOC_TYPE_BADGE = {
  purchase_order: 'bg-teal-100 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400',
  vendor_invoice: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
}

export const STATUS_PILL = {
  draft: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  sent: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  pending_confirmation: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  pending_approval: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  confirmed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  approved: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  partially_received: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  partially_completed: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  received: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  completed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  paid: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  partial: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  unpaid: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  reversed: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  expired: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  cancelled: 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#4a5568]',
}

export function statusPillCls(status) {
  return STATUS_PILL[status] ?? STATUS_PILL.draft
}

/**
 * Translate a document status, falling back to the raw value when no key exists
 * so an unmapped status shows something readable rather than a bare i18n key.
 */
export function statusLabel(status, t) {
  const key = `purchasing.st_${status}`
  const label = t(key)
  return label === key ? status : label
}

export function docTypeLabel(docType, t) {
  return DOC_TYPE_LABEL_KEY[docType] ? t(DOC_TYPE_LABEL_KEY[docType]) : docType
}
