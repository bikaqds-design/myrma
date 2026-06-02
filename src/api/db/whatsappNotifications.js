import { supabase } from '../client.js'

// ── Templates ─────────────────────────────────────────────────────────────

export const whatsappTemplates = {
  async list() {
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

  async get(id) {
    const { data, error } = await supabase
      .from('whatsapp_templates')
      .select('*')
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  async getByEvent(eventType, provider = 'whatsapp') {
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

  async create(template) {
    const { data, error } = await supabase
      .from('whatsapp_templates')
      .insert([
        {
          ...template,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ])
      .select()
    if (error) throw error
    return data?.[0]
  },

  async update(id, template) {
    const { data, error } = await supabase
      .from('whatsapp_templates')
      .update({ ...template, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },

  async delete(id) {
    const { error } = await supabase.from('whatsapp_templates').delete().eq('id', id)
    if (error) throw error
  },
}

// ── Notification Logs ─────────────────────────────────────────────────────

export const notificationLogs = {
  async list({ page = 0, pageSize = 50, provider, status, ticketId, dateFrom, dateTo, search } = {}) {
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
      if (error.code === '42P01') return { missing: true, data: [], count: 0 }
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

  async stats() {
    const { data, error } = await supabase
      .from('notification_logs')
      .select('delivery_status')
    if (error) {
      if (error.code === '42P01') return { sent: 0, delivered: 0, failed: 0, pending: 0, total: 0 }
      throw error
    }
    const counts = { sent: 0, delivered: 0, read: 0, failed: 0, pending: 0, total: 0 }
    for (const row of data ?? []) {
      counts.total++
      if (row.delivery_status in counts) counts[row.delivery_status]++
    }
    return counts
  },

  async retry(logId) {
    const { data: log, error } = await supabase
      .from('notification_logs')
      .select('*')
      .eq('id', logId)
      .single()
    if (error) throw error

    const { error: qErr } = await supabase.from('notification_queue').insert({
      job_type: log.provider,
      event_type: log.event_type,
      payload: {
        to: log.recipient,
        recipientName: log.recipient_name,
        templateId: log.template_id,
        ticketId: log.ticket_id,
        variables: {},
      },
      status: 'pending',
      priority: 3,
      max_retries: 3,
      scheduled_at: new Date().toISOString(),
    })
    if (qErr) throw qErr
  },

  async exportCSV({ provider, status, dateFrom, dateTo } = {}) {
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

// ── Notification Settings ─────────────────────────────────────────────────

export const notificationSettings = {
  async getAll() {
    const { data, error } = await supabase
      .from('notification_settings')
      .select('setting_key, setting_value')
    if (error) {
      if (error.code === '42P01') return { missing: true, data: {} }
      throw error
    }
    const settings = {}
    for (const row of data ?? []) {
      settings[row.setting_key] = row.setting_value
    }
    return { missing: false, data: settings }
  },

  async get(key) {
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

  async set(key, value, updatedBy) {
    const { error } = await supabase.from('notification_settings').upsert(
      {
        setting_key: key,
        setting_value: value,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy ?? null,
      },
      { onConflict: 'setting_key' }
    )
    if (error) throw error
  },

  async setMultiple(settings, updatedBy) {
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

// ── Notification Queue ────────────────────────────────────────────────────

export const notificationQueue = {
  async list({ status, jobType, page = 0, pageSize = 50 } = {}) {
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

  async stats() {
    const { data, error } = await supabase.from('notification_queue').select('status')
    if (error) return { pending: 0, processing: 0, completed: 0, failed: 0 }
    const s = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 }
    for (const r of data ?? []) s[r.status] = (s[r.status] ?? 0) + 1
    return s
  },

  async enqueue(job) {
    const { data, error } = await supabase
      .from('notification_queue')
      .insert([{ ...job, created_at: new Date().toISOString() }])
      .select()
    if (error) throw error
    return data?.[0]
  },

  async cancel(id) {
    const { error } = await supabase
      .from('notification_queue')
      .update({ status: 'cancelled' })
      .eq('id', id)
    if (error) throw error
  },

  async cancelAll(status = 'pending') {
    const { error } = await supabase
      .from('notification_queue')
      .update({ status: 'cancelled' })
      .eq('status', status)
    if (error) throw error
  },
}
