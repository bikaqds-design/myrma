import { supabase } from '../client.js'
import type { TableResult } from './types.js'
import { auditInsert, auditFlushQueue } from './audit.js'
import { PRIORITY, CONFIG_KEY, AUTOMATION_ACTION } from '../../lib/constants.js'
import { assertUpdated, assertAffected } from './_assertUpdated.js'
import { captureException } from '../../lib/sentry.js'
import { addHoursLocalISO } from '../../lib/dates'
import { fetchAllRows } from './_paging.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface AnnouncementRow {
  id: string
  title: string
  message: string
  type: string | null
  color: string | null
  is_active: boolean | null
  start_date: string | null
  end_date: string | null
  target_roles: string[] | null
  created_date: string
  created_by: string | null
}

export interface RmaConfigRow {
  id: string
  config_key: string
  config_value: unknown
  updated_by: string | null
  updated_date: string | null
}

export interface CustomFieldRow {
  id: string
  field_name: string
  field_label: string
  field_type: string
  entity_type: string
  is_required: boolean
  sort_order: number
  options: unknown[] | null
  created_date: string
}

export interface WebhookRow {
  id: string
  name: string
  url: string
  events: string[] | null
  /** Whether a signing secret is configured. The secret itself is not readable
   *  by any client role (migration 20260825, BUG-009) — only the dispatch
   *  Edge Function can read it, using the service role. */
  has_secret: boolean
  is_active: boolean
  last_triggered_at: string | null
  created_date: string
  created_by: string | null
}

export interface SlaPolicy {
  priority: string
  hours: number
}

export interface SlaConfig {
  enabled: boolean
  policies: SlaPolicy[]
}

export interface AutomationCondition {
  field: string
  op: string
  value: string
}

export interface AutomationAction {
  type: string
  value: string
  title?: string
}

export interface AutomationRule {
  name: string
  enabled: boolean
  trigger: string
  conditions: AutomationCondition[]
  actions: AutomationAction[]
}

// ── Announcements ─────────────────────────────────────────────────────────────

export const announcements = {
  async list(): Promise<TableResult<AnnouncementRow[]>> {
    try {
      const data = await fetchAllRows<AnnouncementRow>((from, to) =>
        supabase.from('announcements').select('*').order('created_date', { ascending: false }).order('id', { ascending: true }).range(from, to)
      )
      return { missing: false, data }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async listActive(): Promise<AnnouncementRow[]> {
    // S9-1: filter client-side instead of via chained server-side .or()/.eq().
    // The announcements table is optional and not all deployments have the
    // is_active / start_date / end_date columns — filtering on a missing column
    // returns HTTP 400. A plain select tolerates whatever columns exist, and we
    // apply the active-window logic in JS (missing column → treated as "always on").
    //
    // These were `starts_at` / `ends_at` until 2026-09-06, and no such columns
    // exist — the table has `start_date` / `end_date` (BUG-046). Both reads were
    // therefore always undefined, so the scheduling window was never enforced:
    // an announcement whose end date had passed still showed, and one dated to
    // start next week showed immediately. The admin screen wrote the same wrong
    // names, so every create failed outright with "column starts_at ... does not
    // exist" — which is why the table held zero rows and nobody had noticed.
    try {
      let data: AnnouncementRow[]
      try {
        data = await fetchAllRows<AnnouncementRow>((from, to) =>
          supabase.from('announcements').select('*').order('created_date', { ascending: false }).order('id', { ascending: true }).range(from, to)
        )
      } catch {
        return []
      }
      const now = Date.now()
      return data.filter((a) => {
        if (a.is_active === false) return false
        const starts = a.start_date ? new Date(a.start_date).getTime() : null
        const ends = a.end_date ? new Date(a.end_date).getTime() : null
        if (starts !== null && !Number.isNaN(starts) && starts > now) return false
        if (ends !== null && !Number.isNaN(ends) && ends < now) return false
        return true
      })
    } catch {
      return []
    }
  },
  async create(ann: Partial<AnnouncementRow>): Promise<AnnouncementRow | undefined> {
    const { data, error } = await supabase.from('announcements').insert([ann]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, ann: Partial<AnnouncementRow>): Promise<AnnouncementRow | undefined> {
    const { data, error } = await supabase.from('announcements').update(ann).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Announcement')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('announcements').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Announcement')
  },
}

// ── RMA Config ────────────────────────────────────────────────────────────────

export const rmaConfig = {
  async getAll(): Promise<TableResult<RmaConfigRow[]>> {
    try {
      const data = await fetchAllRows<RmaConfigRow>((from, to) =>
        supabase.from('rma_config').select('*').order('id', { ascending: true }).range(from, to)
      )
      return { missing: false, data }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async set(configKey: string, configValue: unknown, userEmail?: string): Promise<RmaConfigRow | undefined> {
    const { data, error } = await supabase
      .from('rma_config')
      .upsert(
        {
          config_key: configKey,
          config_value: configValue,
          updated_by: userEmail,
          updated_date: new Date().toISOString(),
        },
        { onConflict: 'config_key' }
      )
      .select()
    if (error) throw error
    return data?.[0]
  },
}

// ── Custom Fields ─────────────────────────────────────────────────────────────

export const customFields = {
  async list(): Promise<TableResult<CustomFieldRow[]>> {
    try {
      const data = await fetchAllRows<CustomFieldRow>((from, to) =>
        supabase.from('custom_field_definitions').select('*').order('sort_order', { ascending: true }).order('id', { ascending: true }).range(from, to)
      )
      return { missing: false, data }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async create(field: Partial<CustomFieldRow>): Promise<CustomFieldRow | undefined> {
    const { data, error } = await supabase.from('custom_field_definitions').insert([field]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, field: Partial<CustomFieldRow>): Promise<CustomFieldRow | undefined> {
    const { data, error } = await supabase
      .from('custom_field_definitions')
      .update(field)
      .eq('id', id)
      .select()
    if (error) throw error
    return assertUpdated(data, 'Custom field')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('custom_field_definitions').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Custom field')
  },
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

export const webhooks = {
  async list(): Promise<TableResult<WebhookRow[]>> {
    try {
      // Explicit columns, not '*'. `authenticated` no longer holds a
      // table-wide SELECT on webhooks — it has a column grant that omits
      // secret_key — so `select('*')` is refused by Postgres with "permission
      // denied for column secret_key" rather than quietly dropping it.
      const data = await fetchAllRows<WebhookRow>((from, to) =>
        supabase
          .from('webhooks')
          .select(
            'id, name, url, events, is_active, last_triggered_at, created_by, created_date, has_secret',
          )
          .order('created_date', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to)
      )
      return { missing: false, data }
    } catch {
      return { missing: true, data: [] }
    }
  },
  // The `.select()` on these two names its columns for the same reason list()
  // does, and it is not cosmetic: PostgREST compiles `.select()` into
  // `INSERT/UPDATE ... RETURNING`, and RETURNING is checked against SELECT
  // privileges. Since `authenticated` no longer holds a table-wide SELECT on
  // webhooks (migration 20260825), a bare `.select()` asks for every column
  // including secret_key and is refused with "permission denied for table
  // webhooks" — which is exactly how creating a webhook broke when the column
  // grant landed, caught by clicking the button rather than by any unit test.
  async create(webhook: Partial<WebhookRow>): Promise<WebhookRow | undefined> {
    const { data, error } = await supabase
      .from('webhooks')
      .insert([webhook])
      .select('id, name, url, events, is_active, last_triggered_at, created_by, created_date, has_secret')
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, webhook: Partial<WebhookRow>): Promise<WebhookRow | undefined> {
    const { data, error } = await supabase
      .from('webhooks')
      .update(webhook)
      .eq('id', id)
      .select('id, name, url, events, is_active, last_triggered_at, created_by, created_date, has_secret')
    if (error) throw error
    return assertUpdated(data, 'Webhook')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('webhooks').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Webhook')
  },
  /**
   * Fire an outbound webhook event.
   *
   * This used to read every webhook row — signing secret included — and call
   * `fetch(h.url)` from the browser. That could never work in production: the
   * Content-Security-Policy served by Vercel restricts `connect-src` to
   * Supabase and Sentry, so the request was blocked before it left the page and
   * the error was swallowed. Nothing had ever been delivered (BUG-009).
   *
   * Delivery now happens in the dispatch-webhook Edge Function, which the CSP
   * does allow. The secret stays server-side, signing is HMAC-SHA256 under one
   * scheme, and the outbound request finishes even if the tab closes straight
   * after this call.
   *
   * Still fire-and-forget from the caller's point of view: a webhook failing to
   * reach a third party must not fail the user's ticket save.
   */
  async dispatch(eventType: string, payload: unknown): Promise<void> {
    try {
      const { error } = await supabase.functions.invoke('dispatch-webhook', {
        body: { event: eventType, payload },
      })
      if (error) captureException(error, { context: 'webhooks.dispatch', eventType })
    } catch (err) {
      captureException(err, { context: 'webhooks.dispatch', eventType })
    }
  },

  /**
   * Send a single test delivery, used by the Control Panel's Test button.
   * Returns the per-webhook result so the screen can say what actually
   * happened rather than claiming success. Administrators only, enforced in
   * the function.
   */
  async test(webhookId: string): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const { data, error } = await supabase.functions.invoke('dispatch-webhook', {
      body: { webhookId, test: true },
    })
    if (error) throw error
    const first = (data as { results?: Array<{ ok: boolean; status: number | null; error: string | null }> } | null)
      ?.results?.[0]
    return first ?? { ok: false, status: null, error: 'No result returned' }
  },
}

// ── Audit Log ─────────────────────────────────────────────────────────────────

export const auditLog = {
  async log(userEmail: string, actionType: string, details?: string): Promise<void> {
    const entry = {
      user_email: userEmail || 'system',
      action_type: actionType,
      action_details: details || null,
      created_date: new Date().toISOString(),
    }
    await auditInsert(entry) // H-9: retry + queue on failure
  },
  async flushQueue(): Promise<void> {
    await auditFlushQueue()
  },
  async listAll(limit = 300): Promise<unknown[]> {
    try {
      const { data, error } = await supabase
        .from('user_activity_log')
        .select('*')
        .order('created_date', { ascending: false })
        .limit(limit)
      if (error) throw error
      return data || []
    } catch {
      return []
    }
  },
}

// ── SLA Policies ──────────────────────────────────────────────────────────────

export const slaConfig = {
  DEFAULT: {
    enabled: false,
    // `pauseOnHold` used to live here and be editable in SLA Policies. Nothing
    // consumed it — computeDueDate reads only `enabled` and `policies` — so it
    // was a setting that promised the SLA clock could stop. Removed with the
    // toggle (BUG-027); a stored value on an existing config row is simply
    // ignored.
    policies: [
      { priority: PRIORITY.CRITICAL, hours: 24 },
      { priority: PRIORITY.HIGH, hours: 48 },
      { priority: PRIORITY.MEDIUM, hours: 72 },
      { priority: PRIORITY.LOW, hours: 168 },
    ],
  } as SlaConfig,
  async get(): Promise<SlaConfig> {
    try {
      const { data, error } = await supabase
        .from('rma_config')
        .select('config_value')
        .eq('config_key', CONFIG_KEY.SLA_CONFIG)
        .single()
      if (error) return slaConfig.DEFAULT
      return { ...slaConfig.DEFAULT, ...((data?.config_value as Partial<SlaConfig>) || {}) }
    } catch {
      return slaConfig.DEFAULT
    }
  },
  async save(config: SlaConfig, userEmail?: string): Promise<RmaConfigRow | undefined> {
    return rmaConfig.set(CONFIG_KEY.SLA_CONFIG, config, userEmail)
  },
  computeDueDate(priority: string, config: SlaConfig): string | null {
    if (!config?.enabled) return null
    const policy = (config.policies || []).find((p) => p.priority === priority)
    if (!policy) return null
    // Local calendar, not UTC — see BUG-038. The old form did local
    // arithmetic and then formatted with toISOString(), so an SLA computed in
    // the small hours of a Cairo morning landed a day early.
    return addHoursLocalISO(policy.hours)
  },
}

// ── Automation Rules ──────────────────────────────────────────────────────────

function evaluateConditions(conditions: AutomationCondition[], ticket: Record<string, unknown>): boolean {
  if (!conditions.length) return true
  return conditions.every((c) => {
    const val = String(ticket[c.field] || '').toLowerCase()
    const cv = String(c.value || '').toLowerCase()
    switch (c.op) {
      case 'equals':      return val === cv
      case 'not_equals':  return val !== cv
      case 'contains':    return val.includes(cv)
      case 'starts_with': return val.startsWith(cv)
      default:            return true
    }
  })
}

async function applyActions(actions: AutomationAction[], ticket: Record<string, unknown>): Promise<void> {
  // Automation runs after the user's own save has succeeded, so a failure here
  // must not surface as an error on their action. It must not vanish either:
  // every write used to ignore its result, and a rule the current user's role
  // was not allowed to apply "ran" and changed nothing, with no trace. (BUG-074.)
  const report = (action: string, detail: unknown) =>
    captureException(new Error(`Automation action "${action}" did not apply to ticket ${String(ticket.id)}`), {
      context: 'automationRules:applyActions',
      detail,
    })

  const updateTicket = async (action: string, fields: Record<string, unknown>) => {
    const { data, error } = await supabase
      .from('rma_tickets')
      .update({ ...fields, updated_date: new Date().toISOString() })
      .eq('id', ticket.id as string)
      .select('id')
    if (error) return report(action, error.message)
    if (!data?.length) report(action, 'no row changed — the ticket is gone or this user may not change it')
  }

  for (const a of actions) {
    try {
      if (a.type === 'change_status') {
        await updateTicket(a.type, { ticket_status: a.value })
      } else if (a.type === 'change_priority') {
        await updateTicket(a.type, { priority: a.value })
      } else if (a.type === 'assign_technician') {
        await updateTicket(a.type, { assigned_technician: a.value })
      } else if (a.type === AUTOMATION_ACTION.CREATE_NOTIFICATION) {
        // This used to end in a `.catch(...)` call. A Supabase query builder has
        // `then` but no `catch`, so the call threw a TypeError before sending
        // anything, the surrounding catch swallowed it, and this action never
        // created a single notification. No `.select()`: the creator may not be
        // able to read a notification aimed at admins (BUG-079).
        const { error } = await supabase.from('notifications').insert([
          {
            type: 'custom_alert',
            title: a.title || 'Automation',
            message: a.value,
            entity_type: null,
            entity_id: null,
            entity_ref: null,
            created_by: 'system',
            created_date: new Date().toISOString(),
            target_roles: ['admin', 'super_admin'],
            target_emails: [],
            read_by: [],
          },
        ])
        if (error) report(a.type, error.message)
      }
    } catch (err) {
      report(a.type, err instanceof Error ? err.message : String(err))
    }
  }
}

export const automationRules = {
  async list(): Promise<AutomationRule[]> {
    try {
      const { data, error } = await supabase
        .from('rma_config')
        .select('config_value')
        .eq('config_key', CONFIG_KEY.AUTOMATION_RULES)
        .single()
      if (error) return []
      return (data?.config_value as AutomationRule[]) || []
    } catch {
      return []
    }
  },
  async save(rules: AutomationRule[], userEmail?: string): Promise<RmaConfigRow | undefined> {
    return rmaConfig.set(CONFIG_KEY.AUTOMATION_RULES, rules, userEmail)
  },
  async evaluate(eventType: string, ticket: Record<string, unknown>, _allTickets: unknown[] = []): Promise<string[]> {
    try {
      const rules = await automationRules.list()
      const active = rules.filter((r) => r.enabled && r.trigger === eventType)
      const applied: string[] = []
      for (const rule of active) {
        if (!evaluateConditions(rule.conditions || [], ticket)) continue
        await applyActions(rule.actions || [], ticket)
        applied.push(rule.name)
      }
      return applied
    } catch {
      return []
    }
  },
}

// ── Currencies ────────────────────────────────────────────────────────────────

export interface CurrencyRow {
  code: string
  name: string
  symbol: string
  decimals: number
  is_active: boolean
}

/**
 * The currencies this installation can transact in.
 *
 * Read-mostly reference data seeded by 20260791. Sales documents are always in
 * the base currency; this exists so a purchase can be raised in the vendor's.
 */
export const currencies = {
  async listActive(): Promise<CurrencyRow[]> {
    try {
      return await fetchAllRows<CurrencyRow>((from, to) =>
        supabase.from('currencies').select('*').eq('is_active', true).order('code').range(from, to)
      )
    } catch (error) {
      // 42P01 undefined_table: the migration has not been applied yet. An empty
      // list degrades the picker to base-currency-only rather than breaking the
      // whole purchasing form.
      const code = (error as { code?: string })?.code
      if (code === '42P01' || code === 'PGRST205') return []
      throw error
    }
  },
}

// ── Data integrity ────────────────────────────────────────────────────────────

export interface IntegrityIssueGroup {
  check_name: string
  severity: 'high' | 'medium' | 'low'
  issue_count: number
}

export interface IntegrityIssue {
  check_name: string
  severity: 'high' | 'medium' | 'low'
  entity: string
  entity_id: string
  reference: string
  detail: string
}

/**
 * Standing checks over invariants the data can violate. (Audit finding BUG-041.)
 *
 * Read-only, and deliberately so. The known violations belong mostly to the
 * fixture data whose purge the owner deferred, and rewriting financial rows
 * automatically would turn a reporting problem into a data-loss one. The point
 * is that a NEW violation in real trading data becomes visible instead of
 * waiting to be discovered in a customer statement nobody believes.
 */
// ── Control Panel home + Data Cleanup (BUG-066) ───────────────────────────────
// Both screens loaded every ticket, customer, user and deal to count them.

export interface ControlPanelStats {
  open_tickets: number
  overdue: number
  customers: number
  users: number
  open_deals: number
  open_deal_value: number
  mis_staged: number
}

export interface DuplicateCustomerRow {
  group_key: string
  group_size: number
  group_newest: string | null
  id: string
  company_name: string | null
  contact_person: string | null
  email: string | null
  mobile: string | null
  created_date: string | null
}

export const controlPanel = {
  async stats(now: Date = new Date()): Promise<ControlPanelStats> {
    const { data, error } = await supabase.rpc('rma_control_panel_stats', { p_now: now.toISOString() })
    if (error) throw error
    const s = (data ?? {}) as Partial<ControlPanelStats>
    return {
      open_tickets: Number(s.open_tickets) || 0,
      overdue: Number(s.overdue) || 0,
      customers: Number(s.customers) || 0,
      users: Number(s.users) || 0,
      open_deals: Number(s.open_deals) || 0,
      open_deal_value: Number(s.open_deal_value) || 0,
      mis_staged: Number(s.mis_staged) || 0,
    }
  },
}

export const dataCleanup = {
  /** Stale ticket counts before the two cut-offs, orphan customers, duplicate groups. */
  async summary(completedBefore: string, cancelledBefore: string): Promise<{
    stale_completed: number
    stale_cancelled: number
    orphans: number
    duplicate_groups: number
  }> {
    const { data, error } = await supabase.rpc('rma_data_cleanup_summary', {
      p_completed_before: completedBefore,
      p_cancelled_before: cancelledBefore,
    })
    if (error) throw error
    const s = (data ?? {}) as Record<string, unknown>
    return {
      stale_completed: Number(s.stale_completed) || 0,
      stale_cancelled: Number(s.stale_cancelled) || 0,
      orphans: Number(s.orphans) || 0,
      duplicate_groups: Number(s.duplicate_groups) || 0,
    }
  },

  /** Every customer no ticket refers to by id or display name, newest first. */
  async orphanCustomers(): Promise<Array<Record<string, unknown>>> {
    return fetchAllRows<Record<string, unknown>>((from, to) =>
      supabase
        .rpc('rma_orphan_customers')
        .order('created_date', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .range(from, to)
    )
  },

  /** Every customer sharing a display name with another, grouped, newest group first. */
  async duplicateGroups(): Promise<DuplicateCustomerRow[][]> {
    const rows = await fetchAllRows<DuplicateCustomerRow>((from, to) =>
      supabase
        .rpc('rma_duplicate_customers')
        .order('group_newest', { ascending: false, nullsFirst: false })
        .order('group_key', { ascending: true })
        .order('created_date', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .range(from, to)
    )
    const groups: DuplicateCustomerRow[][] = []
    for (const r of rows) {
      const last = groups[groups.length - 1]
      if (last && last[0].group_key === r.group_key) last.push(r)
      else groups.push([r])
    }
    return groups
  },
}

export const dataIntegrity = {
  async summary(): Promise<IntegrityIssueGroup[]> {
    const { data, error } = await supabase.rpc('rma_data_integrity_summary')
    if (error) {
      // 42883 undefined_function / PGRST202 no such RPC: the migration has not
      // reached this environment. An empty list renders "nothing to report",
      // which is honest — there is nothing this build can report.
      if (error.code === '42883' || error.code === 'PGRST202') return []
      throw error
    }
    return (data || []) as IntegrityIssueGroup[]
  },
  async issues(checkName?: string): Promise<IntegrityIssue[]> {
    const { data, error } = await supabase.rpc('rma_data_integrity_issues')
    if (error) {
      if (error.code === '42883' || error.code === 'PGRST202') return []
      throw error
    }
    const rows = (data || []) as IntegrityIssue[]
    return checkName ? rows.filter((r) => r.check_name === checkName) : rows
  },
}
