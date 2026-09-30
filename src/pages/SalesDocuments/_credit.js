// Credit limits and deposits (A-06 over 20260919): what the screens check
// before the round trip. The database enforces every rule.

export const OVERRIDE_REASON_MIN = 10

/** The database refused this for the customer's credit limit. */
export function isCreditLimitError(err) {
  if (!err) return false
  if (String(err.hint || '').startsWith('credit_limit')) return true
  return /over its credit limit/.test(String(err.message || ''))
}

/** The document type approve_credit_override takes, for an approval-pool type. */
export function overrideDocType(approvalDocType) {
  if (approvalDocType === 'sales_order') return 'sales_order'
  if (approvalDocType === 'invoice') return 'invoice'
  return null
}

/** null when the reason will be accepted, else the message key. */
export function validateOverrideReason(reason) {
  return String(reason || '').trim().length >= OVERRIDE_REASON_MIN ? null : 'salesDocuments.credOverrideReasonShort'
}

/** null when the deposit amount will be accepted, else the message key. */
export function validateDepositAmount(amount) {
  const s = String(amount ?? '').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) return 'salesDocuments.depErrAmount'
  return null
}

/** What to apply by default: all of the payment, or the invoice's balance if smaller. */
export function defaultApplyAmount(unapplied, balance) {
  const u = Math.round((Number(unapplied) || 0) * 100)
  const b = Math.round((Number(balance) || 0) * 100)
  return Math.max(0, Math.min(u, b)) / 100
}
