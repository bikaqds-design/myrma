import { supabase } from '../client.js'

export const rmaTickets = {
  async list() {
    // Capped at 500 rows — use listPaged() for server-side pagination (H-4)
    const { data, error } = await supabase.from('rma_tickets').select('*').order('created_date', { ascending: false }).limit(500)
    if (error) throw error
    return data || []
  },
  async listPaged(page = 0, pageSize = 50) {
    const from = page * pageSize
    const { data, count, error } = await supabase
      .from('rma_tickets')
      .select('*', { count: 'exact' })
      .order('created_date', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) throw error
    return { data: data || [], count: count || 0, page, pageSize, totalPages: Math.ceil((count || 0) / pageSize) }
  },
  async get(id) {
    const { data, error } = await supabase.from('rma_tickets').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(ticket) {
    const { data, error } = await supabase.from('rma_tickets').insert([ticket]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, ticket) {
    const { data, error } = await supabase.from('rma_tickets').update(ticket).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    await supabase.from('inventory_units').delete().eq('rma_ticket_id', id)
    await supabase.from('ticket_comments').delete().eq('ticket_id', id)
    await supabase.from('ticket_activity').delete().eq('ticket_id', id)
    const { error } = await supabase.from('rma_tickets').delete().eq('id', id)
    if (error) throw error
  }
}

export const ticketActivity = {
  async list(ticketId) {
    const { data, error } = await supabase.from('ticket_activity').select('*').eq('ticket_id', ticketId).order('created_date', { ascending: false })
    if (error) throw error
    return data || []
  },
  async create(activityData) {
    const { data, error } = await supabase.from('ticket_activity').insert([activityData]).select()
    if (error) throw error
    return data?.[0]
  }
}

export const ticketComments = {
  async list(ticketId) {
    try {
      const { data, error } = await supabase.from('ticket_comments').select('*').eq('ticket_id', ticketId).order('created_date', { ascending: true })
      if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
      return { missing: false, data: data || [] }
    } catch { return { missing: true, data: [] } }
  },
  async create(ticketId, commentText, authorEmail, authorName, isInternal = false, parentCommentId = null, attachments = [], isCustomerComment = false) {
    const { data, error } = await supabase.from('ticket_comments').insert([{
      ticket_id: ticketId,
      comment_text: commentText,
      user_email: authorEmail,
      author_name: authorName || authorEmail,
      is_internal: isInternal,
      parent_comment_id: parentCommentId || null,
      attachments: attachments || [],
      is_customer_comment: isCustomerComment,
      created_date: new Date().toISOString(),
    }]).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('ticket_comments').delete().eq('id', id)
    if (error) throw error
  }
}

// Public tracker — all calls go through the public-track Edge Function.
// Anon role has NO direct DB access; the Edge Function uses service_role
// server-side and enforces rate limiting + input validation.
export const rmaTracker = {
  async getTicketByRmaNumber(rmaNumber) {
    try {
      const { data, error } = await supabase.functions.invoke('public-track', {
        body: { action: 'lookup', rmaNumber: rmaNumber.trim() }
      })
      if (error) return null
      if (data?.error) return null
      return data?.ticket || null
    } catch { return null }
  },
  async getPublicComments(ticketId) {
    try {
      const { data, error } = await supabase.functions.invoke('public-track', {
        body: { action: 'comments', ticketId }
      })
      if (error || data?.error) return []
      return data?.comments || []
    } catch { return [] }
  },
  async addComment(ticketId, authorName, authorEmail, commentText, parentCommentId = null, attachments = []) {
    const { data, error } = await supabase.functions.invoke('public-track', {
      body: {
        action: 'addComment',
        comment: {
          ticketId, authorName, authorEmail,
          commentText, parentCommentId,
          attachments: attachments || []
        }
      }
    })
    if (error) throw new Error(error.message || 'Failed to send message')
    if (data?.error) throw new Error(data.error)
    return data?.comment
  }
}

// ── Device Serial History ──────────────────────────────────────────────────
export const serialHistory = {
  async getBySerial(serialNumber) {
    if (!serialNumber?.trim()) return []
    try {
      const { data, error } = await supabase.from('rma_tickets').select('id, rma_number, customer_name, ticket_status, priority, assigned_technician, created_date, due_date, products')
        .order('created_date', { ascending: false })
      if (error) return []
      // Filter client-side: scan products JSONB for matching serial
      return (data || []).filter(t =>
        (t.products || []).some(p => p.serial_number?.toLowerCase() === serialNumber.trim().toLowerCase())
      )
    } catch { return [] }
  }
}
