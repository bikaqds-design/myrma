import { supabase } from '../client.js'
import type { TableResult } from './types.js'
import { auditInsert, auditFlushQueue } from './audit.js'
import { PRIORITY, CONFIG_KEY, AUTOMATION_ACTION } from '../../lib/constants.js'
import { assertUpdated } from './_assertUpdated.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface AnnouncementRow {
  id: string
  title: string
  message: string
  type: string | null
  color: string | null
  is_active: boolean | null
  starts_at: string | null
  ends_at: string | null
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
  secret_key: string | null
  is_active: boolean
  created_date: string
  created_by: string | null
}

export interface SlaPolicy {
  priority: string
  hours: number
}

export interface SlaConfig {
  enabled: boolean
  pauseOnHold: boolean
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
      const { data, error } = await supabase
        .from('announcements')
        .select('*')
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async listActive(): Promise<AnnouncementRow[]> {
    // S9-1: filter client-side instead of via chained server-side .or()/.eq().
    // The announcements table is optional and not all deployments have the
    // is_active / starts_at / ends_at columns — filtering on a missing column
    // returns HTTP 400. A plain select tolerates whatever columns exist, and we
    // apply the active-window logic in JS (missing column → treated as "always on").
    try {
      const { data, error } = await supabase
        .from('announcements')
        .select('*')
        .order('created_date', { ascending: false })
      if (error) return []
      const now = Date.now()
      return (data || []).filter((a) => {
        if (a.is_active === false) return false
        const starts = a.starts_at ? new Date(a.starts_at).getTime() : null
        const ends = a.ends_at ? new Date(a.ends_at).getTime() : null
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
    const { error } = await supabase.from('announcements').delete().eq('id', id)
    if (error) throw error
  },
}

// ── RMA Config ────────────────────────────────────────────────────────────────

export const rmaConfig = {
  async getAll(): Promise<TableResult<RmaConfigRow[]>> {
    try {
      const { data, error } = await supabase.from('rma_config').select('*')
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
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
      const { data, error } = await supabase
        .from('custom_field_definitions')
        .select('*')
        .order('sort_order', { ascending: true })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
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
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('custom_field_definitions').delete().eq('id', id)
    if (error) throw error
  },
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

export const webhooks = {
  async list(): Promise<TableResult<WebhookRow[]>> {
    try {
      const { data, error } = await supabase
        .from('webhooks')
        .select('*')
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async create(webhook: Partial<WebhookRow>): Promise<WebhookRow | undefined> {
    const { data, error } = await supabase.from('webhooks').insert([webhook]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, webhook: Partial<WebhookRow>): Promise<WebhookRow | undefined> {
    const { data, error } = await supabase.from('webhooks').update(webhook).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Webhook')
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('webhooks').delete().eq('id', id)
    if (error) throw error
  },
  async dispatch(eventType: string, payload: unknown): Promise<void> {
    try {
      const result = await webhooks.list()
      if (result.missing) return
      const active = (result.data || []).filter(
        (h) => h.is_active && (!h.events?.length || h.events.includes(eventType))
      )
      if (!active.length) return

      await Promise.allSettled(
        active.map(async (h) => {
          const body = JSON.stringify({
            event: eventType,
            timestamp: new Date().toISOString(),
            data: payload,
          })
          const headers: Record<string, string> = { 'Content-Type': 'application/json' }

          // H-7: HMAC-SHA256 signature replaces plaintext X-Webhook-Secret.
          if (h.secret_key) {
            try {
              const enc = new TextEncoder()
              const cryptoKey = await crypto.subtle.importKey(
                'raw',
                enc.encode(h.secret_key),
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['sign']
              )
              const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(body))
              const hex = Array.from(new Uint8Array(sig))
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('')
              headers['X-Signature-256'] = `sha256=${hex}`
            } catch {
              /* crypto unavailable — send unsigned */
            }
          }

          return fetch(h.url, { method: 'POST', headers, body }).catch(() => {})
        })
      )
    } catch {}
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
    pauseOnHold: true,
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
    const d = new Date()
    d.setHours(d.getHours() + policy.hours)
    return d.toISOString().split('T')[0]
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
  for (const a of actions) {
    try {
      if (a.type === 'change_status') {
        await supabase
          .from('rma_tickets')
          .update({ ticket_status: a.value, updated_date: new Date().toISOString() })
          .eq('id', ticket.id as string)
      } else if (a.type === 'change_priority') {
        await supabase
          .from('rma_tickets')
          .update({ priority: a.value, updated_date: new Date().toISOString() })
          .eq('id', ticket.id as string)
      } else if (a.type === 'assign_technician') {
        await supabase
          .from('rma_tickets')
          .update({ assigned_technician: a.value, updated_date: new Date().toISOString() })
          .eq('id', ticket.id as string)
      } else if (a.type === AUTOMATION_ACTION.CREATE_NOTIFICATION) {
        await supabase
          .from('notifications')
          .insert([
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
          .catch(() => {})
      }
    } catch {}
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
    const { data, error } = await supabase
      .from('currencies')
      .select('*')
      .eq('is_active', true)
      .order('code')
    if (error) {
      // 42P01 undefined_table: the migration has not been applied yet. An empty
      // list degrades the picker to base-currency-only rather than breaking the
      // whole purchasing form.
      if (error.code === '42P01' || error.code === 'PGRST205') return []
      throw error
    }
    return data || []
  },
}
