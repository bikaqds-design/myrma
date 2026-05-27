import { supabase } from '../client.js'
import { auditInsert, auditFlushQueue } from './audit.js'
import { PRIORITY, CONFIG_KEY, AUTOMATION_ACTION } from '../../lib/constants.js'

export const announcements = {
  async list() {
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
  async listActive() {
    try {
      const now = new Date().toISOString()
      const { data, error } = await supabase
        .from('announcements')
        .select('*')
        .eq('is_active', true)
        .or(`starts_at.is.null,starts_at.lte.${now}`)
        .or(`ends_at.is.null,ends_at.gte.${now}`)
        .order('created_date', { ascending: false })
      if (error) return []
      return data || []
    } catch {
      return []
    }
  },
  async create(ann) {
    const { data, error } = await supabase.from('announcements').insert([ann]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, ann) {
    const { data, error } = await supabase.from('announcements').update(ann).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('announcements').delete().eq('id', id)
    if (error) throw error
  },
}

export const rmaConfig = {
  async getAll() {
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
  async set(configKey, configValue, userEmail) {
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

export const customFields = {
  async list() {
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
  async create(field) {
    const { data, error } = await supabase.from('custom_field_definitions').insert([field]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, field) {
    const { data, error } = await supabase
      .from('custom_field_definitions')
      .update(field)
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('custom_field_definitions').delete().eq('id', id)
    if (error) throw error
  },
}

export const webhooks = {
  async list() {
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
  async create(webhook) {
    const { data, error } = await supabase.from('webhooks').insert([webhook]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, webhook) {
    const { data, error } = await supabase.from('webhooks').update(webhook).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('webhooks').delete().eq('id', id)
    if (error) throw error
  },
  async dispatch(eventType, payload) {
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
          const headers = { 'Content-Type': 'application/json' }

          // H-7: HMAC-SHA256 signature replaces plaintext X-Webhook-Secret.
          // Receiver verifies: HMAC-SHA256(secret, raw_body) === X-Signature-256 value.
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

export const auditLog = {
  async log(userEmail, actionType, details) {
    const entry = {
      user_email: userEmail || 'system',
      action_type: actionType,
      action_details: details || null,
      created_date: new Date().toISOString(),
    }
    await auditInsert(entry) // H-9: retry + queue on failure
  },
  async flushQueue() {
    await auditFlushQueue()
  },
  async listAll(limit = 300) {
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

// ── SLA Policies (stored in rma_config) ────────────────────────────────────
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
  },
  async get() {
    try {
      const { data, error } = await supabase
        .from('rma_config')
        .select('config_value')
        .eq('config_key', CONFIG_KEY.SLA_CONFIG)
        .single()
      if (error) return slaConfig.DEFAULT
      return { ...slaConfig.DEFAULT, ...(data?.config_value || {}) }
    } catch {
      return slaConfig.DEFAULT
    }
  },
  async save(config, userEmail) {
    return rmaConfig.set(CONFIG_KEY.SLA_CONFIG, config, userEmail)
  },
  computeDueDate(priority, config) {
    if (!config?.enabled) return null
    const policy = (config.policies || []).find((p) => p.priority === priority)
    if (!policy) return null
    const d = new Date()
    d.setHours(d.getHours() + policy.hours)
    return d.toISOString().split('T')[0]
  },
}

// ── Automation rule helpers (module-private) ──────────────────────────────────
function evaluateConditions(conditions, ticket) {
  if (!conditions.length) return true
  return conditions.every((c) => {
    const val = String(ticket[c.field] || '').toLowerCase()
    const cv = String(c.value || '').toLowerCase()
    switch (c.op) {
      case 'equals':
        return val === cv
      case 'not_equals':
        return val !== cv
      case 'contains':
        return val.includes(cv)
      case 'starts_with':
        return val.startsWith(cv)
      default:
        return true
    }
  })
}

async function applyActions(actions, ticket) {
  for (const a of actions) {
    try {
      if (a.type === 'change_status') {
        await supabase
          .from('rma_tickets')
          .update({ ticket_status: a.value, updated_date: new Date().toISOString() })
          .eq('id', ticket.id)
      } else if (a.type === 'change_priority') {
        await supabase
          .from('rma_tickets')
          .update({ priority: a.value, updated_date: new Date().toISOString() })
          .eq('id', ticket.id)
      } else if (a.type === 'assign_technician') {
        await supabase
          .from('rma_tickets')
          .update({ assigned_technician: a.value, updated_date: new Date().toISOString() })
          .eq('id', ticket.id)
      } else if (a.type === AUTOMATION_ACTION.CREATE_NOTIFICATION) {
        // Inline supabase call — avoids circular import between system.js and notifications.js
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

// ── Automation Rules (stored in rma_config) ────────────────────────────────
export const automationRules = {
  async list() {
    try {
      const { data, error } = await supabase
        .from('rma_config')
        .select('config_value')
        .eq('config_key', CONFIG_KEY.AUTOMATION_RULES)
        .single()
      if (error) return []
      return data?.config_value || []
    } catch {
      return []
    }
  },
  async save(rules, userEmail) {
    return rmaConfig.set(CONFIG_KEY.AUTOMATION_RULES, rules, userEmail)
  },
  // Run all matching rules against a ticket event. Returns list of applied rule names.
  async evaluate(eventType, ticket, _allTickets = []) {
    try {
      const rules = await automationRules.list()
      const active = rules.filter((r) => r.enabled && r.trigger === eventType)
      const applied = []
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
