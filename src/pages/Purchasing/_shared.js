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
  reversed: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
  expired: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  cancelled: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#a4acb7]',
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

// ── Analytics ─────────────────────────────────────────────────────────────────

/**
 * Statuses that mean the money never happened. Excluded from every analytics
 * measure: a cancelled PO or a voided vendor invoice was never committed, and
 * counting it overstates the total. Count excludes them too, so both measures
 * always describe the same population.
 */
export const DEAD_STATUSES = new Set(['cancelled', 'draft_cancelled', 'void', 'voided'])

export function isLiveDocument(doc) {
  return !DEAD_STATUSES.has(String(doc?.doc_status || '').toLowerCase())
}

/** The dimensions a purchase document can be sliced by, in both analytics views. */
export const DIMENSIONS = ['vendor', 'status', 'month', 'type']

/**
 * The bucket a document falls into along one dimension. Shared by the chart and
 * the pivot so that "group by vendor" cannot come to mean two different things.
 */
export function dimensionKey(doc, dimension, { vendorName, t }) {
  if (dimension === 'vendor') return vendorName(doc.vendor_id) || t('common.unknown')
  if (dimension === 'status') return statusLabel(doc.doc_status, t)
  if (dimension === 'type') return docTypeLabel(doc.doc_type, t)
  // month — bucket on created_at, the one date every document type has.
  const d = doc.created_at ? new Date(doc.created_at) : null
  return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : t('common.unknown')
}

/**
 * Months read as a timeline; every other dimension is a ranking. Chart bars and
 * pivot rows want the same ordering rule.
 */
export function sortDimensionKeys(keys, dimension, weightOf) {
  return dimension === 'month'
    ? [...keys].sort((a, b) => a.localeCompare(b))
    : [...keys].sort((a, b) => weightOf(b) - weightOf(a))
}

/**
 * A purchase document's total in the base currency.
 *
 * Everything that ADDS documents together has to go through this. `total` is in
 * the document's own currency, so summing it across a mix of local and imported
 * purchases produces a number that is not money in any currency — a $10,000
 * import would land in a spend total as though it were E£10,000.
 *
 * `total_base` is a generated column (20260792), so it cannot be stale. The
 * fallback multiplies by the rate only for a client running against a database
 * that predates it; a missing rate means a base-currency document, where the
 * two figures are the same number anyway.
 */
export function docTotalBase(doc) {
  if (doc?.total_base != null) return Number(doc.total_base) || 0
  return (Number(doc?.total) || 0) * (Number(doc?.exchange_rate) || 1)
}

/**
 * True when a document is not in the base currency, and so needs its currency
 * shown next to every amount. A local purchase does not: labelling every figure
 * on a screen where everything is EGP is noise that trains people to stop
 * reading the label, which is exactly when the one foreign document slips past.
 */
export function isForeignDoc(doc, baseCurrency) {
  return Boolean(doc?.currency) && doc.currency !== baseCurrency
}

/**
 * Landed charge kinds, matching the charge_type CHECK constraint on
 * vendor_invoice_charges (20260792). A value here that the constraint does not
 * allow fails on save with a database error rather than a form message, so the
 * two lists have to agree.
 */
export const CHARGE_TYPES = ['freight', 'customs', 'clearance', 'insurance', 'handling', 'other']

/**
 * True when a document claims a foreign currency but carries a rate of 1.
 *
 * That combination is not a rate anyone chose — it means the rate was never
 * recorded, and the document is being counted as though its amounts were
 * already base currency. A $3,750 order sits in every spend total as E£3,750.
 *
 * The database refuses this on anything written since 20260792, but rows that
 * already existed took the rate from a column default and were never passed
 * through the guard. Those are the ones this finds, and they cannot be found by
 * looking at a total — 3,750 looks perfectly reasonable until you notice which
 * currency it is in.
 */
export function hasMissingRate(doc, baseCurrency) {
  if (!doc?.currency || doc.currency === baseCurrency) return false
  return Number(doc.exchange_rate) === 1
}
