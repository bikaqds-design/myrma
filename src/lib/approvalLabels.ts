/**
 * Approval-pool labels.
 *
 * Approval activities encode their target as `approval|docType|docId|code|total|customer`,
 * so the doc type is always known at render time. Until now every approval row was
 * labelled with a single hardcoded string reading "Quotation Approval Request", which
 * meant Sales Orders, Invoices, Credit Notes, Purchase Orders and Vendor Invoices all
 * announced themselves as quotations in the pool (found in manual QA 2026-08-06,
 * docs/archive/WAREHOUSE_R1_TEST_CHECKLIST.md — sales-funnel run log).
 *
 * The doc-type nouns already exist as `activities.source*` (used by the Source column
 * and the filter dropdown), so they are reused here rather than duplicated — one
 * translation per doc type, shared by both surfaces.
 */

/** Doc types that can appear in the approval pool → their translated noun. */
export const APPROVAL_DOC_TYPE_LABEL_KEY: Record<string, string> = {
  quotation: 'activities.sourceQuotation',
  sales_order: 'activities.sourceSalesOrder',
  invoice: 'activities.sourceInvoice',
  credit_note: 'activities.sourceCreditNote',
  purchase_order: 'activities.sourcePurchaseOrder',
  vendor_invoice: 'activities.sourceVendorInvoice',
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string

/**
 * approvalRequestLabel: "Sales Order Approval Request" / "طلب اعتماد أمر بيع".
 *
 * Falls back to the quotation noun for an unrecognised doc type — the same default
 * parseApprovalTitle() already applies when the type segment is missing, so an old
 * or malformed row still reads as a sentence rather than showing a raw key.
 */
export function approvalRequestLabel(t: TFunc, docType: string | undefined | null): string {
  const key = APPROVAL_DOC_TYPE_LABEL_KEY[docType ?? ''] ?? APPROVAL_DOC_TYPE_LABEL_KEY.quotation
  return t('activityChatter.approvalRequest', { docType: t(key) })
}
