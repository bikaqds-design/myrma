/**
 * Dashboard widget catalog, layout resolution and preference storage.
 *
 * Lives here rather than in Dashboard.jsx because AccountSettings needs the
 * catalog too, and importing it from the page pulled the whole dashboard bundle
 * — charts included — into the settings route.
 *
 * ── One list, no modules ─────────────────────────────────────────────────────
 *
 * There is no CRM section and no RMA section. The dashboard is one flat grid of
 * widgets in whatever order the user arranged them, and this catalog is one flat
 * list. A widget is a widget; where its data happens to come from is not a
 * category the person looking at it should have to care about.
 *
 * The previous dashboard opened with a "CRM" heading and hid the other twelve
 * widgets inside a collapsed "RMA" disclosure, which meant most of the page was
 * invisible until you found the toggle.
 *
 * ── Each entry declares four things the UI used to hardcode ──────────────────
 *
 *   defaultSize  how wide it starts. Was a `size` field that only ever appeared
 *                as a label in settings — every real width was a hardcoded
 *                col-span in JSX, so the two could and did disagree.
 *   requires     the permissions its data needs. A technician cannot read deals
 *                at all, so a CRM widget would render zeros for them, which
 *                looks like a broken widget rather than a permission boundary.
 *                Widgets they cannot read are never offered.
 *   href         where clicking through goes. Eight of sixteen widgets had a
 *                hand-written onClick and the rest went nowhere.
 *   labelKey     i18n key. Labels were raw English, so the Arabic interface
 *                listed sixteen English widget names.
 */

/** Column spans on the 12-column grid. Three presets keep every row aligned. */
export const WIDGET_SIZES = ['quarter', 'half', 'full']

export const SIZE_COLUMNS = { quarter: 3, half: 6, full: 12 }

/** Tailwind classes per size. Everything is full width below `sm`. */
export const SIZE_CLASS = {
  quarter: 'col-span-12 sm:col-span-6 lg:col-span-3',
  half: 'col-span-12 lg:col-span-6',
  full: 'col-span-12',
}

/**
 * Minimum body height per size, so a chart shrunk to a quarter still renders
 * legibly rather than collapsing. Research on dashboard grids is consistent on
 * this: at small sizes the chart takes priority over its legend.
 */
export const SIZE_MIN_HEIGHT = { quarter: 120, half: 200, full: 240 }

/**
 * Every widget, in the order a fresh account sees them.
 *
 * `requires` is satisfied when the user can do ANY of the listed
 * `section.action` pairs — ticket widgets work for someone who can see only
 * their assigned tickets, not just someone with view_all.
 */
export const WIDGET_CATALOG = [
  {
    id: 'stat_tickets',
    labelKey: 'dashboard.widgets.stat_tickets.label',
    descKey: 'dashboard.widgets.stat_tickets.desc',
    defaultSize: 'full',
    requires: ['rma_tickets.view_all', 'rma_tickets.view_assigned'],
    href: '/rma-tickets',
  },
  {
    id: 'crm_kpi',
    labelKey: 'dashboard.widgets.crm_kpi.label',
    descKey: 'dashboard.widgets.crm_kpi.desc',
    defaultSize: 'full',
    requires: ['deals.view_all', 'deals.view'],
    href: '/pipeline',
  },
  {
    id: 'stat_inventory',
    labelKey: 'dashboard.widgets.stat_inventory.label',
    descKey: 'dashboard.widgets.stat_inventory.desc',
    defaultSize: 'full',
    requires: ['inventory.view'],
    href: '/inventory',
  },
  {
    id: 'sla_health',
    labelKey: 'dashboard.widgets.sla_health.label',
    descKey: 'dashboard.widgets.sla_health.desc',
    defaultSize: 'quarter',
    requires: ['rma_tickets.view_all', 'rma_tickets.view_assigned'],
    href: '/reports',
  },
  {
    id: 'resolution_rate',
    labelKey: 'dashboard.widgets.resolution_rate.label',
    descKey: 'dashboard.widgets.resolution_rate.desc',
    defaultSize: 'quarter',
    requires: ['rma_tickets.view_all', 'rma_tickets.view_assigned'],
    href: '/reports',
  },
  {
    id: 'overdue_tickets',
    labelKey: 'dashboard.widgets.overdue_tickets.label',
    descKey: 'dashboard.widgets.overdue_tickets.desc',
    defaultSize: 'quarter',
    requires: ['rma_tickets.view_all', 'rma_tickets.view_assigned'],
    href: '/rma-tickets?overdue=true',
  },
  {
    id: 'overdue_followups',
    labelKey: 'dashboard.widgets.overdue_followups.label',
    descKey: 'dashboard.widgets.overdue_followups.desc',
    defaultSize: 'quarter',
    requires: ['activities.view_all', 'activities.view'],
    href: '/activities?tab=overdue',
  },
  {
    id: 'pipeline_by_stage',
    labelKey: 'dashboard.widgets.pipeline_by_stage.label',
    descKey: 'dashboard.widgets.pipeline_by_stage.desc',
    defaultSize: 'half',
    requires: ['deals.view_all', 'deals.view'],
    href: '/pipeline',
  },
  {
    id: 'rep_leaderboard',
    labelKey: 'dashboard.widgets.rep_leaderboard.label',
    descKey: 'dashboard.widgets.rep_leaderboard.desc',
    defaultSize: 'half',
    requires: ['deals.view_all', 'deals.view'],
    href: '/pipeline',
  },
  {
    id: 'recent_tickets',
    labelKey: 'dashboard.widgets.recent_tickets.label',
    descKey: 'dashboard.widgets.recent_tickets.desc',
    defaultSize: 'half',
    requires: ['rma_tickets.view_all', 'rma_tickets.view_assigned'],
    href: '/rma-tickets',
  },
  {
    id: 'weekly_trend',
    labelKey: 'dashboard.widgets.weekly_trend.label',
    descKey: 'dashboard.widgets.weekly_trend.desc',
    defaultSize: 'half',
    requires: ['rma_tickets.view_all', 'rma_tickets.view_assigned'],
    href: '/reports',
  },
  {
    id: 'monthly_trend',
    labelKey: 'dashboard.widgets.monthly_trend.label',
    descKey: 'dashboard.widgets.monthly_trend.desc',
    defaultSize: 'half',
    requires: ['rma_tickets.view_all', 'rma_tickets.view_assigned'],
    href: '/reports',
  },
  {
    id: 'technician_performance',
    labelKey: 'dashboard.widgets.technician_performance.label',
    descKey: 'dashboard.widgets.technician_performance.desc',
    defaultSize: 'half',
    requires: ['rma_tickets.view_all', 'rma_tickets.view_assigned'],
    href: '/reports',
  },
  {
    id: 'top_issues',
    labelKey: 'dashboard.widgets.top_issues.label',
    descKey: 'dashboard.widgets.top_issues.desc',
    defaultSize: 'half',
    requires: ['rma_tickets.view_all', 'rma_tickets.view_assigned'],
    href: '/reports',
  },
  {
    id: 'status_distribution',
    labelKey: 'dashboard.widgets.status_distribution.label',
    descKey: 'dashboard.widgets.status_distribution.desc',
    defaultSize: 'quarter',
    requires: ['rma_tickets.view_all', 'rma_tickets.view_assigned'],
    href: '/rma-tickets',
    defaultOff: true,
  },
  {
    id: 'priority_distribution',
    labelKey: 'dashboard.widgets.priority_distribution.label',
    descKey: 'dashboard.widgets.priority_distribution.desc',
    defaultSize: 'quarter',
    requires: ['rma_tickets.view_all', 'rma_tickets.view_assigned'],
    href: '/rma-tickets',
    defaultOff: true,
  },
]

export const ALL_WIDGET_IDS = WIDGET_CATALOG.map((w) => w.id)

const BY_ID = Object.fromEntries(WIDGET_CATALOG.map((w) => [w.id, w]))

export function getWidget(id) {
  return BY_ID[id] || null
}

/**
 * Widgets that start switched off.
 *
 * The two ticket donuts. With a handful of tickets across three statuses they
 * say less than the status strip above them already does. Off rather than
 * deleted — someone running real ticket volume can turn them back on, and
 * removing a widget people may be using is not a call to make for them.
 */
const DEFAULT_OFF_IDS = WIDGET_CATALOG.filter((w) => w.defaultOff).map((w) => w.id)

export const DEFAULT_ENABLED_IDS = ALL_WIDGET_IDS.filter((id) => !DEFAULT_OFF_IDS.includes(id))

/**
 * Can this user see the data behind a widget?
 *
 * `can` is a two-argument predicate — (section, action) => boolean — so this
 * module never has to import the permission layer, and the tests can drive it
 * without building a whole permission map.
 */
export function isWidgetPermitted(widget, can) {
  if (!widget?.requires?.length) return true
  if (typeof can !== 'function') return true
  return widget.requires.some((entry) => {
    const [section, action] = entry.split('.')
    return can(section, action)
  })
}

/** The catalog, minus anything this user has no permission to read. */
export function permittedCatalog(can) {
  return WIDGET_CATALOG.filter((w) => isWidgetPermitted(w, can))
}

// ── Stored preferences ────────────────────────────────────────────────────────
//
// v3: { v: 3, off: string[], size: { [id]: size }, order: string[] }
//
// `off` rather than a list of enabled ids, and the reason matters. An
// enabled-list cannot tell "the user switched this off" apart from "this did
// not exist when they saved", so every widget added later stays invisible to
// everyone with a saved preference. That is exactly what happened: the CRM
// widgets shipped and nobody who had ever opened settings could see them.
// Storing what is OFF inverts it — anything the catalog gains is absent from the
// off-list and is therefore on. The default maintains itself.
//
// `order` and `size` are sparse on purpose. An id missing from `order` falls to
// the end in catalog order; an id missing from `size` uses its defaultSize. So a
// new widget needs no migration to appear in a sensible place at a sensible
// width.

const PREFS_VERSION = 3

/** Ids the pre-CRM enabled-array could ever have contained. See resolve below. */
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

/** Build the stored shape from a resolved layout. */
export function toStoredWidgetPrefs(layout) {
  const enabled = new Set(layout.map((w) => w.id))
  const size = {}
  for (const w of layout) {
    const entry = BY_ID[w.id]
    if (entry && w.size && w.size !== entry.defaultSize) size[w.id] = w.size
  }
  return {
    v: PREFS_VERSION,
    off: ALL_WIDGET_IDS.filter((id) => !enabled.has(id)),
    size,
    order: layout.map((w) => w.id),
  }
}

/**
 * Read whatever is stored and produce the layout to render.
 *
 * Accepts every shape this has ever had, so an existing install keeps working:
 *
 *   null / junk            every widget except the defaultOff ones
 *   [ ...enabled ids ]     v1. An id absent from the array means "off" when it
 *                          was on offer at the time and "did not exist yet"
 *                          when it was not — hence LEGACY_OFFERED_IDS. Anything
 *                          outside that set is treated as new and defaults on,
 *                          rather than being suppressed forever.
 *   { v: 2, off: [] }      off-list, no order or size
 *   { v: 3, off, size, order }
 *
 * Returns [{ id, size, ...catalog entry }] in display order, filtered by
 * permission. `can` is optional; without it nothing is filtered.
 */
export function resolveDashboardLayout(stored, can) {
  let offIds
  if (Array.isArray(stored)) {
    const enabled = new Set(stored)
    offIds = new Set(
      ALL_WIDGET_IDS.filter(
        (id) => !enabled.has(id) && (LEGACY_OFFERED_IDS.includes(id) || DEFAULT_OFF_IDS.includes(id))
      )
    )
  } else if (stored && typeof stored === 'object' && Array.isArray(stored.off)) {
    offIds = new Set(stored.off)
  } else {
    offIds = new Set(DEFAULT_OFF_IDS)
  }

  const sizes = (stored && typeof stored === 'object' && stored.size) || {}
  const savedOrder = (stored && typeof stored === 'object' && Array.isArray(stored.order))
    ? stored.order
    : []

  // Saved order first, then anything it does not mention, in catalog order — so
  // a newly added widget appears at the end rather than vanishing.
  const seen = new Set()
  const ordered = []
  for (const id of savedOrder) {
    if (BY_ID[id] && !seen.has(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }
  for (const id of ALL_WIDGET_IDS) {
    if (!seen.has(id)) ordered.push(id)
  }

  return ordered
    .filter((id) => !offIds.has(id))
    .map((id) => BY_ID[id])
    .filter((w) => isWidgetPermitted(w, can))
    .map((w) => ({
      ...w,
      size: WIDGET_SIZES.includes(sizes[w.id]) ? sizes[w.id] : w.defaultSize,
    }))
}

/**
 * The same resolution, but keeping the disabled ones and marking them.
 *
 * Account Settings needs every widget the user is allowed to have, whether it
 * is currently on or off, in the order they arranged them.
 */
export function resolveWidgetSettings(stored, can) {
  const enabled = resolveDashboardLayout(stored, can)
  const enabledIds = new Set(enabled.map((w) => w.id))
  const sizes = (stored && typeof stored === 'object' && stored.size) || {}

  const disabled = permittedCatalog(can)
    .filter((w) => !enabledIds.has(w.id))
    .map((w) => ({
      ...w,
      size: WIDGET_SIZES.includes(sizes[w.id]) ? sizes[w.id] : w.defaultSize,
      enabled: false,
    }))

  return [...enabled.map((w) => ({ ...w, enabled: true })), ...disabled]
}
