/**
 * dashboardWidgets.test.js — catalog, permission filtering and layout resolution.
 *
 * The behaviour these lock down, in order of how badly each has burned this
 * project before:
 *
 *   1. A widget added to the catalog must appear for people who already have
 *      saved preferences. The enabled-list storage failed this and hid the
 *      entire CRM section from everyone who had opened the settings page.
 *   2. A widget must not be offered to someone whose role cannot read its data,
 *      or it renders zeros and reads as broken.
 *   3. Every stored shape this has ever used must still resolve.
 */
import { describe, it, expect } from 'vitest'
import {
  WIDGET_CATALOG,
  ALL_WIDGET_IDS,
  DEFAULT_ENABLED_IDS,
  WIDGET_SIZES,
  SIZE_COLUMNS,
  SIZE_CLASS,
  resolveDashboardLayout,
  resolveWidgetSettings,
  toStoredWidgetPrefs,
  isWidgetPermitted,
  permittedCatalog,
} from '../lib/dashboardWidgets'

/** Sees everything. */
const canAll = () => true
/** Sees nothing. */
const canNone = () => false
/** A technician: tickets and inventory, no CRM. */
const canTechnician = (section, action) =>
  (section === 'rma_tickets' && ['view_all', 'view_assigned'].includes(action)) ||
  (section === 'inventory' && action === 'view')

describe('catalog', () => {
  it('is one flat list with no grouping field', () => {
    for (const w of WIDGET_CATALOG) {
      expect(w).not.toHaveProperty('group')
      expect(w).not.toHaveProperty('section')
      expect(w).not.toHaveProperty('module')
    }
  })

  it('gives every widget an id, i18n keys, a valid default size and a link', () => {
    for (const w of WIDGET_CATALOG) {
      expect(w.id, 'id').toBeTruthy()
      expect(w.labelKey, `${w.id} labelKey`).toMatch(/^dashboard\.widgets\./)
      expect(w.descKey, `${w.id} descKey`).toMatch(/^dashboard\.widgets\./)
      expect(WIDGET_SIZES, `${w.id} defaultSize`).toContain(w.defaultSize)
      expect(w.href, `${w.id} href`).toMatch(/^\//)
    }
  })

  it('declares required permissions in section.action form', () => {
    for (const w of WIDGET_CATALOG) {
      expect(Array.isArray(w.requires), `${w.id} requires`).toBe(true)
      for (const entry of w.requires) expect(entry, `${w.id}`).toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })

  it('has no duplicate ids', () => {
    expect(ALL_WIDGET_IDS.length).toBe(new Set(ALL_WIDGET_IDS).size)
  })

  it('maps every size to a column count and a class', () => {
    for (const s of WIDGET_SIZES) {
      expect(SIZE_COLUMNS[s]).toBeGreaterThan(0)
      expect(SIZE_CLASS[s]).toContain('col-span')
    }
  })
})

describe('permission filtering', () => {
  it('offers a technician no CRM widget', () => {
    const ids = permittedCatalog(canTechnician).map((w) => w.id)
    expect(ids).not.toContain('crm_kpi')
    expect(ids).not.toContain('pipeline_by_stage')
    expect(ids).not.toContain('rep_leaderboard')
    expect(ids).toContain('stat_tickets')
    expect(ids).toContain('stat_inventory')
  })

  // A technician sees their assigned tickets only. Requiring view_all would
  // have hidden every ticket widget from the people who use them most.
  it('accepts any one of the required permissions', () => {
    const onlyAssigned = (s, a) => s === 'rma_tickets' && a === 'view_assigned'
    const stat = WIDGET_CATALOG.find((w) => w.id === 'stat_tickets')
    expect(isWidgetPermitted(stat, onlyAssigned)).toBe(true)
  })

  it('offers nothing to a session that can read nothing', () => {
    expect(permittedCatalog(canNone)).toEqual([])
    expect(resolveDashboardLayout(null, canNone)).toEqual([])
  })

  it('filters nothing when no predicate is supplied', () => {
    expect(resolveDashboardLayout(null).length).toBe(DEFAULT_ENABLED_IDS.length)
  })
})

describe('resolveDashboardLayout', () => {
  it('returns the default set for a user with no preference', () => {
    const ids = resolveDashboardLayout(null, canAll).map((w) => w.id)
    expect(ids).toEqual(DEFAULT_ENABLED_IDS)
  })

  it('treats junk as no preference', () => {
    for (const junk of [undefined, 0, 'nonsense', { v: 99 }]) {
      expect(resolveDashboardLayout(junk, canAll).map((w) => w.id)).toEqual(DEFAULT_ENABLED_IDS)
    }
  })

  it('honours an explicit off-list, including turning a defaultOff widget on', () => {
    const layout = resolveDashboardLayout({ v: 3, off: ['stat_tickets'] }, canAll)
    const ids = layout.map((w) => w.id)
    expect(ids).not.toContain('stat_tickets')
    // status_distribution is defaultOff, but an explicit preference outranks it
    expect(ids).toContain('status_distribution')
  })

  it('applies saved order, then appends anything it does not mention', () => {
    const stored = { v: 3, off: [], order: ['top_issues', 'sla_health'] }
    const ids = resolveDashboardLayout(stored, canAll).map((w) => w.id)
    expect(ids[0]).toBe('top_issues')
    expect(ids[1]).toBe('sla_health')
    expect(ids.length).toBe(ALL_WIDGET_IDS.length)
  })

  it('ignores an unknown id left in a saved order', () => {
    const stored = { v: 3, off: [], order: ['deleted_widget', 'sla_health'] }
    const ids = resolveDashboardLayout(stored, canAll).map((w) => w.id)
    expect(ids).not.toContain('deleted_widget')
    expect(ids[0]).toBe('sla_health')
  })

  it('applies a saved size and falls back to the default otherwise', () => {
    const stored = { v: 3, off: [], size: { sla_health: 'full', top_issues: 'nonsense' } }
    const layout = resolveDashboardLayout(stored, canAll)
    expect(layout.find((w) => w.id === 'sla_health').size).toBe('full')
    // an invalid stored size must not render as undefined
    const top = layout.find((w) => w.id === 'top_issues')
    expect(top.size).toBe(top.defaultSize)
  })

  // The defect this storage shape exists to prevent.
  it('shows a widget added after the user saved their preferences', () => {
    const savedBeforeCrmExisted = { v: 2, off: ['weekly_trend'] }
    const ids = resolveDashboardLayout(savedBeforeCrmExisted, canAll).map((w) => w.id)
    expect(ids).toContain('crm_kpi')
    expect(ids).toContain('pipeline_by_stage')
    expect(ids).not.toContain('weekly_trend')
  })

  describe('v1 enabled-array migration', () => {
    it('keeps an id the user actually switched off, off', () => {
      const v1 = ['stat_tickets', 'sla_health'] // omits recent_tickets, which existed then
      const ids = resolveDashboardLayout(v1, canAll).map((w) => w.id)
      expect(ids).not.toContain('recent_tickets')
    })

    it('turns on an id that did not exist when they saved', () => {
      const v1 = ['stat_tickets', 'sla_health']
      const ids = resolveDashboardLayout(v1, canAll).map((w) => w.id)
      // crm_kpi post-dates the v1 array, so its absence is not a choice
      expect(ids).toContain('crm_kpi')
      expect(ids).toContain('monthly_trend')
    })
  })
})

describe('toStoredWidgetPrefs', () => {
  it('round-trips through resolve unchanged', () => {
    const original = resolveDashboardLayout({ v: 3, off: ['top_issues'], size: { sla_health: 'full' }, order: ['sla_health'] }, canAll)
    const round = resolveDashboardLayout(toStoredWidgetPrefs(original), canAll)
    expect(round.map((w) => w.id)).toEqual(original.map((w) => w.id))
    expect(round.map((w) => w.size)).toEqual(original.map((w) => w.size))
  })

  it('records everything absent from the layout as off', () => {
    const stored = toStoredWidgetPrefs([{ id: 'sla_health', size: 'half' }])
    expect(stored.off).toContain('stat_tickets')
    expect(stored.off).not.toContain('sla_health')
  })

  // Storing only the differences keeps the payload small and lets a change to a
  // widget's default reach users who never overrode it.
  it('stores only sizes that differ from the default', () => {
    const entry = WIDGET_CATALOG.find((w) => w.id === 'sla_health')
    const stored = toStoredWidgetPrefs([
      { id: 'sla_health', size: entry.defaultSize },
      { id: 'top_issues', size: 'full' },
    ])
    expect(stored.size).not.toHaveProperty('sla_health')
    expect(stored.size.top_issues).toBe('full')
  })

  it('records the order', () => {
    const stored = toStoredWidgetPrefs([{ id: 'top_issues' }, { id: 'sla_health' }])
    expect(stored.order).toEqual(['top_issues', 'sla_health'])
  })
})

describe('resolveWidgetSettings', () => {
  it('lists enabled widgets first, then the rest, all marked', () => {
    const rows = resolveWidgetSettings({ v: 3, off: ['sla_health'] }, canAll)
    expect(rows.length).toBe(ALL_WIDGET_IDS.length)
    const sla = rows.find((r) => r.id === 'sla_health')
    expect(sla.enabled).toBe(false)
    expect(rows[0].enabled).toBe(true)
    // the disabled ones are at the end
    expect(rows[rows.length - 1].enabled).toBe(false)
  })

  it('never lists a widget the role cannot read, even switched off', () => {
    const ids = resolveWidgetSettings({ v: 3, off: [] }, canTechnician).map((r) => r.id)
    expect(ids).not.toContain('crm_kpi')
  })
})
