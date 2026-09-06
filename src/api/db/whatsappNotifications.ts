import { supabase } from '../client.js'
import type { TableResult, PagedResult, CountedResult } from './types.js'
import { assertAffected } from './_assertUpdated.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface WhatsAppTemplateRow {
  id: string
  name: string
  display_name: string
  event_type: string
  provider: string
  language: string
  template_name: string | null
  header_type: 'text' | 'document' | 'image' | null
  header_content: string | null
  body_content: string
  footer_content: string | null
  variables: TemplateVariable[]
  attach_pdf: boolean
  status: 'active' | 'inactive' | 'pending_approval'
  created_at: string
  updated_at: string
  created_by: string | null
}

export interface TemplateVariable {
  key: string
  label: string
  source: string
}

export interface NotificationLogRow {
  id: string
  user_id: string | null
  ticket_id: string | null
  event_type: string
  provider: string
  recipient: string
  recipient_name: string | null
  template_id: string | null
  message_content: string | null
  delivery_status: 'pending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled'
  whatsapp_message_id: string | null
  sent_at: string
  delivered_at: string | null
  read_at: string | null
  response_data: unknown
  error_message: string | null
  retry_count: number
  created_at: string
}

export interface NotificationSettingRow {
  id: string
  setting_key: string
  setting_value: unknown
  updated_at: string
  updated_by: string | null
}

export interface NotificationQueueRow {
  id: string
  job_type: 'whatsapp' | 'email' | 'sms' | 'push'
  event_type: string
  payload: Record<string, unknown>
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  priority: number
  retry_count: number
  max_retries: number
  scheduled_at: string
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  result: unknown
  created_at: string
  created_by: string | null
}

interface LogListOptions {
  page?: number
  pageSize?: number
  provider?: string
  status?: string
  ticketId?: string
  dateFrom?: string
  dateTo?: string
  search?: string
}

interface QueueListOptions {
  status?: string
  jobType?: string
  page?: number
  pageSize?: number
}

interface ExportOptions {
  provider?: string
  status?: string
  dateFrom?: string
  dateTo?: string
}

// ── Templates ─────────────────────────────────────────────────────────────────

export const whatsappTemplates = {
  async list(): Promise<TableResult<WhatsAppTemplateRow[]>> {
    const { data, error } = await supabase
      .from('whatsapp_templates')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) {
      if (error.code === '42P01') return { missing: true, data: [] }
      throw error
    }
    return { missing: false, data: data ?? [] }
  },

  async get(id: string): Promise<WhatsAppTemplateRow> {
    const { data, error } = await supabase
      .from('whatsapp_templates')
      .select('*')
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  async getByEvent(eventType: string, provider = 'whatsapp'): Promise<WhatsAppTemplateRow[]> {
    const { data, error } = await supabase
      .from('whatsapp_templates')
      .select('*')
      .eq('event_type', eventType)
      .eq('provider', provider)
      .eq('status', 'active')
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return data ?? []
  },

  async create(template: Partial<WhatsAppTemplateRow>): Promise<WhatsAppTemplateRow | undefined> {
    const { data, error } = await supabase
      .from('whatsapp_templates')
      .insert([{ ...template, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }])
      .select()
    if (error) throw error
    return data?.[0]
  },

  async update(id: string, template: Partial<WhatsAppTemplateRow>): Promise<WhatsAppTemplateRow | undefined> {
    const { data, error } = await supabase
      .from('whatsapp_templates')
      .update({ ...template, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },

  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('whatsapp_templates').delete().eq('id', id)
    if (error) throw error
  },
}

// ── Notification Logs ─────────────────────────────────────────────────────────

export const notificationLogs = {
  async list({
    page = 0, pageSize = 50, provider, status, ticketId, dateFrom, dateTo, search,
  }: LogListOptions = {}): Promise<PagedResult<NotificationLogRow>> {
    let query = supabase
      .from('notification_logs')
      .select('*, whatsapp_templates(display_name)', { count: 'exact' })
      .order('sent_at', { ascending: false })

    if (provider) query = query.eq('provider', provider)
    if (status)   query = query.eq('delivery_status', status)
    if (ticketId) query = query.eq('ticket_id', ticketId)
    if (dateFrom) query = query.gte('sent_at', dateFrom)
    if (dateTo)   query = query.lte('sent_at', dateTo)
    if (search)   query = query.or(
      `recipient.ilike.%${search}%,recipient_name.ilike.%${search}%,event_type.ilike.%${search}%`
    )
    query = query.range(page * pageSize, page * pageSize + pageSize - 1)

    const { data, count, error } = await query
    if (error) {
      if (error.code === '42P01') return { missing: true, data: [], count: 0, page, pageSize, totalPages: 0 }
      throw error
    }
    return {
      missing: false,
      data: data ?? [],
      count: count ?? 0,
      page,
      pageSize,
      totalPages: Math.ceil((count ?? 0) / pageSize),
    }
  },

  async stats(): Promise<{ sent: number; delivered: number; read: number; failed: number; pending: number; total: number }> {
    const { data, error } = await supabase.from('notification_logs').select('delivery_status')
    if (error) {
      if (error.code === '42P01') return { sent: 0, delivered: 0, read: 0, failed: 0, pending: 0, total: 0 }
      throw error
    }
    const counts = { sent: 0, delivered: 0, read: 0, failed: 0, pending: 0, total: 0 }
    for (const row of data ?? []) {
      counts.total++
      const s = row.delivery_status as keyof typeof counts
      if (s in counts) counts[s]++
    }
    return counts
  },

  async retry(logId: string): Promise<void> {
    const { data: log, error } = await supabase
      .from('notification_logs')
      .select('*')
      .eq('id', logId)
      .single()
    if (error) throw error

    const { error: qErr } = await supabase.from('notification_queue').insert({
      job_type: log.provider,
      event_type: log.event_type,
      payload: { to: log.recipient, recipientName: log.recipient_name, templateId: log.template_id, ticketId: log.ticket_id, variables: {} },
      status: 'pending',
      priority: 3,
      max_retries: 3,
      scheduled_at: new Date().toISOString(),
    })
    if (qErr) throw qErr
  },

  async exportCSV({ provider, status, dateFrom, dateTo }: ExportOptions = {}): Promise<Partial<NotificationLogRow>[]> {
    let query = supabase
      .from('notification_logs')
      .select('id,event_type,provider,recipient,recipient_name,delivery_status,sent_at,delivered_at,error_message,retry_count')
      .order('sent_at', { ascending: false })
      .limit(10000)

    if (provider) query = query.eq('provider', provider)
    if (status)   query = query.eq('delivery_status', status)
    if (dateFrom) query = query.gte('sent_at', dateFrom)
    if (dateTo)   query = query.lte('sent_at', dateTo)

    const { data, error } = await query
    if (error) throw error
    return data ?? []
  },
}

// ── Notification Settings ─────────────────────────────────────────────────────

export const notificationSettings = {
  async getAll(): Promise<TableResult<Record<string, unknown>>> {
    const { data, error } = await supabase
      .from('notification_settings')
      .select('setting_key, setting_value')
    if (error) {
      if (error.code === '42P01') return { missing: true, data: {} }
      throw error
    }
    const settings: Record<string, unknown> = {}
    for (const row of data ?? []) {
      settings[row.setting_key] = row.setting_value
    }
    return { missing: false, data: settings }
  },

  async get(key: string): Promise<unknown | null> {
    const { data, error } = await supabase
      .from('notification_settings')
      .select('setting_value')
      .eq('setting_key', key)
      .single()
    if (error) {
      if (error.code === 'PGRST116' || error.code === '42P01') return null
      throw error
    }
    return data?.setting_value ?? null
  },

  async set(key: string, value: unknown, updatedBy?: string | null): Promise<void> {
    const { error } = await supabase.from('notification_settings').upsert(
      { setting_key: key, setting_value: value, updated_at: new Date().toISOString(), updated_by: updatedBy ?? null },
      { onConflict: 'setting_key' }
    )
    if (error) throw error
  },

  async setMultiple(settings: Record<string, unknown>, updatedBy?: string | null): Promise<void> {
    const rows = Object.entries(settings).map(([key, value]) => ({
      setting_key: key,
      setting_value: value,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy ?? null,
    }))
    const { error } = await supabase
      .from('notification_settings')
      .upsert(rows, { onConflict: 'setting_key' })
    if (error) throw error
  },
}

// ── Notification Queue ────────────────────────────────────────────────────────

export const notificationQueue = {
  async list({ status, jobType, page = 0, pageSize = 50 }: QueueListOptions = {}): Promise<CountedResult<NotificationQueueRow>> {
    let query = supabase
      .from('notification_queue')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })

    if (status)  query = query.eq('status', status)
    if (jobType) query = query.eq('job_type', jobType)
    query = query.range(page * pageSize, page * pageSize + pageSize - 1)

    const { data, count, error } = await query
    if (error) {
      if (error.code === '42P01') return { missing: true, data: [], count: 0 }
      throw error
    }
    return { missing: false, data: data ?? [], count: count ?? 0 }
  },

  async stats(): Promise<{ pending: number; processing: number; completed: number; failed: number; cancelled: number }> {
    const { data, error } = await supabase.from('notification_queue').select('status')
    if (error) return { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 }
    const s = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 }
    for (const r of data ?? []) {
      const k = r.status as keyof typeof s
      if (k in s) s[k]++
    }
    return s
  },

  async enqueue(job: Partial<NotificationQueueRow>): Promise<NotificationQueueRow | undefined> {
    const { data, error } = await supabase
      .from('notification_queue')
      .insert([{ ...job, created_at: new Date().toISOString() }])
      .select()
    if (error) throw error
    return data?.[0]
  },

  async cancel(id: string): Promise<void> {
    const { data, error } = await supabase.from('notification_queue').update({ status: 'cancelled' }).eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Queued notification')
  },

  async cancelAll(status = 'pending'): Promise<void> {
    const { error } = await supabase.from('notification_queue').update({ status: 'cancelled' }).eq('status', status)
    if (error) throw error
  },
}
