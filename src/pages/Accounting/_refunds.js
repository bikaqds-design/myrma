// Pure helpers behind the Refunds tab (P-05d), kept apart from the component so
// they can be tested and so fast refresh keeps working. The database (20260904)
// enforces every rule here again.

/** The recorder is never offered their own approval (owner decision: a second manager). */
export function canApproveRefund(refund, currentUserEmail) {
  return String(refund?.created_by || '').toLowerCase() !== String(currentUserEmail || '').toLowerCase()
}

/**
 * A refund needs a source and a positive amount in whole cents, no more than
 * the source's balance (refunds already waiting on it are checked by the
 * database, which says how much is really left).
 */
export function validateRefund({ source, amount }) {
  if (!source) return { error: 'accounting.rfErrSource' }
  const raw = String(amount ?? '').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) return { error: 'accounting.rfErrAmount' }
  if (Number(raw) > source.balance + 1e-9) return { error: 'accounting.rfErrTooMuch' }
  return { amount: Number(raw) }
}
