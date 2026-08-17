import { describe, it, expect } from 'vitest'
import {
  ALL_WIDGET_IDS,
  DEFAULT_ENABLED_IDS,
  WIDGET_CATALOG,
  resolveEnabledWidgets,
  toStoredWidgetPrefs,
} from '../lib/dashboardWidgets'

// The two ticket donuts, off by default since the CRM layout landed.
const DEFAULT_OFF = ['status_distribution', 'priority_distribution']

// The four CRM widgets that the old ten-id default silently hid, plus the two
// other latecomers. These are the ids the bug made unreachable.
const LATECOMERS = [
  'monthly_trend',
  'technician_performance',
  'overdue_followups',
  'crm_kpi',
  'pipeline_by_stage',
  'rep_leaderboard',
]

// The exact array AppearanceContext used to hand the Dashboard as its fallback.
const OLD_DEFAULT = [
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

describe('dashboard widget catalog', () => {
  it('has unique ids', () => {
    expect(new Set(ALL_WIDGET_IDS).size).toBe(ALL_WIDGET_IDS.length)
  })

  it('every catalog entry has an id, label and size', () => {
    for (const w of WIDGET_CATALOG) {
      expect(w.id, JSON.stringify(w)).toBeTruthy()
      expect(w.label, w.id).toBeTruthy()
      expect(['half', 'full'], w.id).toContain(w.size)
    }
  })

  it('still contains the six widgets the old default omitted', () => {
    for (const id of LATECOMERS) expect(ALL_WIDGET_IDS).toContain(id)
  })
})

describe('resolveEnabledWidgets', () => {
  it('with no stored preference, enables everything except the defaultOff widgets', () => {
    expect(resolveEnabledWidgets(null)).toEqual(DEFAULT_ENABLED_IDS)
    expect(resolveEnabledWidgets(undefined)).toEqual(DEFAULT_ENABLED_IDS)
    for (const id of DEFAULT_OFF) expect(resolveEnabledWidgets(null)).not.toContain(id)
  })

  it('ignores junk rather than blanking the dashboard', () => {
    expect(resolveEnabledWidgets('nonsense')).toEqual(DEFAULT_ENABLED_IDS)
    expect(resolveEnabledWidgets(42)).toEqual(DEFAULT_ENABLED_IDS)
    expect(resolveEnabledWidgets({})).toEqual(DEFAULT_ENABLED_IDS)
  })

  it('an explicit v2 preference outranks defaultOff in both directions', () => {
    // asked for -> shown, even though it is off by default
    expect(resolveEnabledWidgets({ v: 2, off: [] })).toEqual(ALL_WIDGET_IDS)
    // switched off -> hidden, even though it is on by default
    expect(resolveEnabledWidgets({ v: 2, off: ['crm_kpi'] })).not.toContain('crm_kpi')
  })

  it('honours the v2 off-list', () => {
    const out = resolveEnabledWidgets({ v: 2, off: ['sla_health', 'top_issues'] })
    expect(out).not.toContain('sla_health')
    expect(out).not.toContain('top_issues')
    expect(out).toContain('crm_kpi')
    expect(out).toHaveLength(ALL_WIDGET_IDS.length - 2)
  })

  it('v2 can turn everything off', () => {
    expect(resolveEnabledWidgets({ v: 2, off: [...ALL_WIDGET_IDS] })).toEqual([])
  })

  it('returns ids in catalog order, not stored order', () => {
    const out = resolveEnabledWidgets({ v: 2, off: [] })
    expect(out).toEqual(ALL_WIDGET_IDS)
  })

  it('never hides a defaultOff widget from someone who explicitly kept it', () => {
    const legacyWithDonuts = ['stat_tickets', 'status_distribution']
    expect(resolveEnabledWidgets(legacyWithDonuts)).toContain('status_distribution')
  })

  // ── the regression this module exists for ────────────────────────────────
  it('shows the CRM widgets to someone whose saved preference predates them', () => {
    // Exactly what an existing user had stored: the old ten, nothing else.
    const out = resolveEnabledWidgets(OLD_DEFAULT)
    for (const id of LATECOMERS) {
      expect(out, `${id} should be visible — it did not exist when the pref was saved`).toContain(id)
    }
  })

  it('still respects a legacy switch-off of a widget that did exist', () => {
    const withoutSla = OLD_DEFAULT.filter((id) => id !== 'sla_health')
    const out = resolveEnabledWidgets(withoutSla)
    expect(out).not.toContain('sla_health')
    // ...while the latecomers remain on.
    expect(out).toContain('crm_kpi')
  })

  it('treats a legacy empty array as "only the old ten were off"', () => {
    // Not the same as "everything off" — that is what the v2 shape is for, and
    // why disableAllWidgets must not write a bare [].
    const out = resolveEnabledWidgets([])
    expect(out).toEqual(LATECOMERS.filter((id) => ALL_WIDGET_IDS.includes(id)))
  })
})

describe('toStoredWidgetPrefs', () => {
  it('round-trips through resolveEnabledWidgets', () => {
    const wanted = ['crm_kpi', 'pipeline_by_stage', 'overdue_tickets']
    expect(resolveEnabledWidgets(toStoredWidgetPrefs(wanted))).toEqual(
      ALL_WIDGET_IDS.filter((id) => wanted.includes(id))
    )
  })

  it('records everything as off when nothing is enabled', () => {
    expect(toStoredWidgetPrefs([]).off).toEqual(ALL_WIDGET_IDS)
    expect(resolveEnabledWidgets(toStoredWidgetPrefs([]))).toEqual([])
  })

  it('records nothing as off when everything is enabled', () => {
    expect(toStoredWidgetPrefs(ALL_WIDGET_IDS).off).toEqual([])
  })
})
