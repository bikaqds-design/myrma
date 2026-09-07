/**
 * Default values for a new ticket, as configured in the Control Panel.
 * (Audit finding BUG-027.)
 *
 * The RMA Configuration screen has always offered "Default Priority", "Default
 * Status" and "Auto Due Date (days)", saved them to `rma_config` under
 * `default_settings`, and shown a success toast. Nothing read the key — that
 * screen was the only reference to it anywhere in the repository — so the
 * ticket form went on using its own hardcoded values and the setting had no
 * effect whatsoever.
 *
 * Of the three dead sections on that screen this is the one worth keeping, so
 * it is honoured here instead of being deleted with the other two.
 *
 * The config key is renamed from `default_settings` to `ticket_defaults`
 * because the old name says nothing about what it defaults. Renaming is free:
 * production held no `default_settings` row at all, so there is no stored value
 * to migrate.
 */

import { TICKET_STATUS, TICKET_STATUS_LIST, PRIORITY_LIST } from './constants'

export const TICKET_DEFAULTS_KEY = 'ticket_defaults'

export const TICKET_DEFAULTS = {
  default_priority: 'Medium',
  default_status: TICKET_STATUS.OPEN,
  auto_due_days: 7,
}

/** Days a due date may be pushed out. One year is already absurd for an RMA. */
const MAX_DUE_DAYS = 365

/**
 * A stored config value, made safe to render and to use.
 *
 * A saved default can name a status or priority this build no longer has —
 * 'New' is the live example, a status that was removed. A `<select>` whose
 * value is not among its options renders blank and then silently saves
 * whichever option the user's next edit lands on, so an unknown value falls
 * back to a known-good one rather than showing an empty control.
 *
 * `auto_due_days` is clamped rather than rejected: it feeds date arithmetic,
 * and a NaN or a negative would produce a due date before the ticket existed.
 */
export function normaliseTicketDefaults(value) {
  const saved = value && typeof value === 'object' ? value : {}
  // Number(null) and Number('') are both 0, which is finite — so a missing
  // value would pass the check below and clamp to 1, quietly making every new
  // ticket due tomorrow. The same trap money.js guards against in toBase().
  const raw = saved.auto_due_days
  const days = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  return {
    default_priority: PRIORITY_LIST.includes(saved.default_priority)
      ? saved.default_priority
      : TICKET_DEFAULTS.default_priority,
    default_status: TICKET_STATUS_LIST.includes(saved.default_status)
      ? saved.default_status
      : TICKET_DEFAULTS.default_status,
    auto_due_days: Number.isFinite(days)
      ? Math.min(Math.max(Math.trunc(days), 1), MAX_DUE_DAYS)
      : TICKET_DEFAULTS.auto_due_days,
  }
}
