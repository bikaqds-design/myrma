// The first-run setup wizard (B-03c over 20260922; owner decisions 2026-10-01:
// shown at first login, every System Setup preference included, the core
// required and the rest optional). Pure rules here; the page is index.jsx.

export const SETUP_KEY = 'setup_wizard'

// id, required, the Control Panel section that keeps it afterwards
export const STEPS = [
  { id: 'welcome' },
  { id: 'company', required: true, section: 'system-setup' },
  { id: 'country', required: true, section: 'system-setup' },
  { id: 'regional', section: 'system-setup' },
  { id: 'numbering', section: 'system-setup' },
  { id: 'chart', required: true, section: 'chart-of-accounts' },
  { id: 'users', section: 'users' },
  { id: 'email', section: 'email' },
  { id: 'opening' },
  { id: 'ai', section: 'system-setup' },
  { id: 'finish' },
]

/** The stored progress, whatever shape the row has (missing = a new company). */
export function readState(value) {
  const v = value && typeof value === 'object' ? value : {}
  return {
    status: ['in_progress', 'skipped', 'finished'].includes(v.status) ? v.status : 'in_progress',
    stepsDone: Array.isArray(v.steps_done) ? v.steps_done.filter((s) => typeof s === 'string') : [],
    chartConfirmed: v.chart_confirmed === true,
    finishedAt: v.finished_at ?? null,
    finishedBy: v.finished_by ?? null,
  }
}

/** The row to store back. */
export function writeState(state, patch = {}) {
  const s = { ...state, ...patch }
  return {
    status: s.status,
    steps_done: [...new Set(s.stepsDone)],
    chart_confirmed: !!s.chartConfirmed,
    ...(s.finishedAt ? { finished_at: s.finishedAt } : {}),
    ...(s.finishedBy ? { finished_by: s.finishedBy } : {}),
  }
}

const filled = (v) => (typeof v === 'string' ? v.trim() !== '' : v != null && v !== '')

/**
 * Whether a step is done. The required ones are judged from what is actually
 * saved (and, for country and currency, confirmed on the step, since a new
 * database may already carry a default); the optional ones when marked done.
 */
export function stepDone(id, { config = {}, state }) {
  switch (id) {
    case 'welcome': return true
    case 'finish': return state.status === 'finished'
    case 'company': return filled(config.legal_name)
    case 'country': return filled(config.default_country) && filled(config.default_currency) && state.stepsDone.includes('country')
    case 'chart': return filled(config.chart_template) || state.chartConfirmed
    default: return state.stepsDone.includes(id)
  }
}

/** The required steps still to do (the wizard cannot be finished until none). */
export function missingRequired(ctx) {
  return STEPS.filter((s) => s.required && !stepDone(s.id, ctx)).map((s) => s.id)
}

/** Whether the app should open on the wizard for this administrator. */
export function shouldOpenWizard({ isAdmin, loaded, value }) {
  if (!isAdmin || !loaded) return false
  return readState(value).status === 'in_progress'
}

/** The country's own currency, to suggest as the base. */
export function suggestedCurrency(countries, code) {
  return (countries || []).find((c) => c.code === code)?.currency_code || null
}
