/**
 * Dashboard widget catalog and preference resolution.
 *
 * Lives here rather than in Dashboard.jsx because AccountSettings needs the
 * catalog too, and importing it from the page pulled the whole dashboard bundle
 * — charts included — into the settings route.
 *
 * ── The bug this fixes ─────────────────────────────────────────────────────
 *
 * Preferences used to be stored as an array of *enabled* ids, and read with the
 * ten-id `dashboardWidgets` list in AppearanceContext as the fallback:
 *
 *     safeStorage.get(key, dashboardWidgets || WIDGET_CATALOG.map((w) => w.id))
 *
 * That list was written before the CRM widgets existed and was never updated, so
 * six of the sixteen — crm_kpi, pipeline_by_stage, rep_leaderboard,
 * overdue_followups, monthly_trend, technician_performance — could not appear
 * for anyone who had not been to the settings page. Four of them were the entire
 * CRM section: built, translated, querying real tables, and dark.
 *
 * AccountSettings read the *same* key with a *different* fallback (the full
 * catalog), so with no saved preference the settings page showed sixteen widgets
 * ticked while the dashboard rendered ten.
 *
 * ── Why storing the disabled set fixes it ──────────────────────────────────
 *
 * An enabled-list cannot distinguish "the user switched this off" from "this did
 * not exist when they saved", so every widget added later is invisible to
 * everyone with a saved preference. Storing what is *off* inverts that: anything
 * the catalog gains is absent from the off-list and is therefore on. The default
 * becomes self-maintaining, which is the actual defect — the ten-id list was
 * only the symptom.
 *
 * This is the same shape as resolvePermissions() in permissions.ts, which had to
 * stop letting a stored snapshot stand in for the full set for the same reason.
 */

export const WIDGET_CATALOG = [
  { id: 'stat_tickets',           label: 'Ticket KPIs',               desc: 'Hero tiles + status strip',                     size: 'full' },
  { id: 'stat_inventory',         label: 'Inventory Snapshot',         desc: '5 inventory status categories',                 size: 'full' },
  { id: 'sla_health',             label: 'SLA Health',                 desc: 'On-time ticket completion rate gauge',           size: 'half' },
  { id: 'resolution_rate',        label: 'Resolution Rate',            desc: 'Percentage of closed tickets gauge',             size: 'half' },
  { id: 'recent_tickets',         label: 'Recent Tickets',             desc: 'Last 10 RMA tickets with status',               size: 'half' },
  { id: 'overdue_tickets',        label: 'Overdue Tickets',            desc: 'All tickets past their due date',               size: 'half' },
  { id: 'weekly_trend',           label: 'Weekly Trend',               desc: '7-day ticket creation line chart',              size: 'half' },
  { id: 'monthly_trend',          label: 'Monthly Trend (30d)',         desc: '30-day ticket creation bar chart',              size: 'half' },
  { id: 'status_distribution',    label: 'Status Distribution',        desc: 'Donut chart of ticket statuses',                size: 'half' },
  { id: 'priority_distribution',  label: 'Priority Distribution',      desc: 'Donut chart of ticket priorities',              size: 'half' },
  { id: 'technician_performance', label: 'Technician Performance',     desc: 'Top 5 technicians by close rate',               size: 'full' },
  { id: 'top_issues',             label: 'Top Issues',                 desc: 'Ranked list of most common product issues',     size: 'full' },
  { id: 'overdue_followups',      label: 'Overdue Follow-Ups',         desc: 'CRM activities past their due date',            size: 'half' },
  { id: 'crm_kpi',               label: 'CRM KPIs',                   desc: 'Open pipeline value, deals won & leads this month', size: 'full' },
  { id: 'pipeline_by_stage',     label: 'Pipeline by Stage',          desc: 'Open deal count & value per stage bar chart',    size: 'half' },
  { id: 'rep_leaderboard',       label: 'Rep Leaderboard',            desc: 'Top 5 reps by deals won this month',             size: 'half' },
]

export const ALL_WIDGET_IDS = WIDGET_CATALOG.map((w) => w.id)

/**
 * The widget ids the legacy enabled-array could ever have contained.
 *
 * Needed only to migrate an old preference honestly. If a saved array omits an
 * id, that means "switched off" when the id was on offer at the time, and
 * "did not exist yet" when it was not. This is the set that was on offer — the
 * old AppearanceContext default — so anything outside it is treated as new and
 * defaults to on rather than being silently suppressed forever.
 */
const LEGACY_OFFERED_IDS = [
  'stat_tickets',
  'stat_inventory',
  'sla_health',
  'resolution_rate',
  'recent_tickets',
  'overdue_tickets',
  'weekly_trend',
  'status_distribution',
  'priority_distribution',
  'top_issues',
]

const PREFS_VERSION = 2

/** Build the stored shape from the ids a user currently wants visible. */
export function toStoredWidgetPrefs(enabledIds) {
  const enabled = new Set(enabledIds)
  return { v: PREFS_VERSION, off: ALL_WIDGET_IDS.filter((id) => !enabled.has(id)) }
}

/**
 * stored (any shape, including null) -> the ids to render, in catalog order.
 *
 * Accepts three inputs so an existing install keeps working:
 *   - null / undefined / junk -> everything on
 *   - { v: 2, off: [...] }    -> catalog minus off
 *   - [ ...enabled ids ]      -> legacy; see LEGACY_OFFERED_IDS
 */
export function resolveEnabledWidgets(stored) {
  if (Array.isArray(stored)) {
    const enabled = new Set(stored)
    return ALL_WIDGET_IDS.filter((id) => enabled.has(id) || !LEGACY_OFFERED_IDS.includes(id))
  }
  if (stored && typeof stored === 'object' && Array.isArray(stored.off)) {
    const off = new Set(stored.off)
    return ALL_WIDGET_IDS.filter((id) => !off.has(id))
  }
  return [...ALL_WIDGET_IDS]
}
