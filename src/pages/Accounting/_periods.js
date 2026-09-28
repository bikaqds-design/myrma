// Month-end close (A-03, 20260910): which months the Periods tab shows and
// what each person may do with each. The database enforces every rule; these
// only decide which buttons to offer.

import { ROLES } from '../../lib/constants'

export const REOPEN_REASON_MIN = 10
export const PERIOD_MONTHS_SHOWN = 12

const pad = (n) => String(n).padStart(2, '0')
/** 'YYYY-MM-01' for the month of a Date (local calendar). */
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`

/**
 * The current month and the PERIOD_MONTHS_SHOWN before it, plus any older
 * month that has a period row, newest first.
 */
export function monthsToShow(periods, today = new Date(), count = PERIOD_MONTHS_SHOWN) {
  const keys = new Set()
  for (let i = 0; i <= count; i++) keys.add(monthKey(new Date(today.getFullYear(), today.getMonth() - i, 1)))
  for (const p of periods || []) keys.add(String(p.period_start).slice(0, 10))
  return [...keys].sort().reverse()
}

export const isFinanceRole = (role) => [ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.ACCOUNTANT].includes(role)
export const isAdminRole = (role) => [ROLES.ADMIN, ROLES.SUPER_ADMIN].includes(role)

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase()

/**
 * The actions to offer on one month:
 *   soft_close · close · reopen (a soft-closed month) · request_reopen ·
 *   approve · reject (an administrator) · withdraw (the one who asked) ·
 *   waiting (a request someone else must decide).
 * `canClose` is the user's own accounting.close_period (20260914): the
 * closing, reopening and request actions check it in the database.
 */
export function periodActions({ month, status, today = new Date(), role, me, pending, canClose = true }) {
  const finance = isFinanceRole(role) && canClose
  const admin = isAdminRole(role)
  const ended = month < monthKey(today)
  const out = []
  if (status === 'open' && ended && finance) out.push('soft_close')
  if (status === 'soft_closed' && finance) out.push('close', 'reopen')
  if (status === 'closed' && !pending && finance) out.push('request_reopen')
  if (status === 'closed' && pending) {
    const mine = same(pending.requested_by, me)
    if (admin && !mine) out.push('approve', 'reject')
    else if (mine) out.push('withdraw')
    if (!admin || mine) out.push('waiting')
  }
  return out
}

/** null when the reason will be accepted, else the message key. */
export function validateReopenReason(reason) {
  return String(reason || '').trim().length >= REOPEN_REASON_MIN ? null : 'accounting.pcReasonTooShort'
}
