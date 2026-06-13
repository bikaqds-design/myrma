import { supabase } from '../client.js'
import { captureException } from '../../lib/sentry.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface TicketProductItem {
  product_name?: string | null
  serial_number?: string | null
  product_status?: string | null
  warranty_status?: string | null
  issue_description?: string | null
}

export interface RMATicketRow {
  id: string
  rma_number: string
  customer_name: string
  customer_id: string | null
  customer_email: string | null
  customer_phone: string | null
  ticket_status: string
  priority: string
  assigned_technician: string | null
  due_date: string | null
  general_description: string | null
  internal_notes: string | null
  accessories_received: string | null
  attachments: unknown[] | null
  products: TicketProductItem[] | null
  carrier: string | null
  tracking_number: string | null
  shipping_label_url: string | null
  created_date: string
  updated_date: string | null
  created_by: string | null
}

export interface TicketActivityRow {
  id: string
  ticket_id: string
  action_type: string
  details: string | null
  user_email: string | null
  created_date: string
}

export interface TicketCommentRow {
  id: string
  ticket_id: string
  comment_text: string
  user_email: string
  author_name: string
  is_internal: boolean
  parent_comment_id: string | null
  attachments: unknown[]
  is_customer_comment: boolean
  created_date: string
}

export interface PagedResult<T> {
  data: T[]
  count: number
  page: number
  pageSize: number
  totalPages: number
}

// ── RMA Tickets ───────────────────────────────────────────────────────────────

export const rmaTickets = {
  async list(): Promise<RMATicketRow[]> {
    // 5 000-row cap — RMA Tickets filters/sorts client-side so all rows must be
    // in memory. Raised from 500 to cover real-world datasets without truncation.
    const { data, error } = await supabase
      .from('rma_tickets')
      .select('*')
      .order('created_date', { ascending: false })
      .limit(5000)
    if (error) throw error
    return data || []
  },
  async listPaged(page = 0, pageSize = 50): Promise<PagedResult<RMATicketRow>> {
    const from = page * pageSize
    const { data, count, error } = await supabase
      .from('rma_tickets')
      .select('*', { count: 'exact' })
      .order('created_date', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) throw error
    return {
      data: data || [],
      count: count || 0,
      page,
      pageSize,
      totalPages: Math.ceil((count || 0) / pageSize),
    }
  },
  async get(id: string): Promise<RMATicketRow> {
    const { data, error } = await supabase.from('rma_tickets').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(ticket: Partial<RMATicketRow>): Promise<RMATicketRow | undefined> {
    const { data, error } = await supabase.from('rma_tickets').insert([ticket]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, ticket: Partial<RMATicketRow>): Promise<RMATicketRow | undefined> {
    const { data, error } = await supabase.from('rma_tickets').update(ticket).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    // Cascade is enforced by ON DELETE CASCADE FKs on inventory_units,
    // ticket_comments, ticket_activity → rma_tickets (migration 20260528).
    const { error } = await supabase.from('rma_tickets').delete().eq('id', id)
    if (error) throw error
  },
}

// ── Ticket Activity ───────────────────────────────────────────────────────────

export const ticketActivity = {
  async list(ticketId: string): Promise<TicketActivityRow[]> {
    const { data, error } = await supabase
      .from('ticket_activity')
      .select('*')
      .eq('ticket_id', ticketId)
      .order('created_date', { ascending: false })
    if (error) throw error
    return data || []
  },
  async create(activityData: Partial<TicketActivityRow>): Promise<TicketActivityRow | undefined> {
    const { data, error } = await supabase.from('ticket_activity').insert([activityData]).select()
    if (error) throw error
    return data?.[0]
  },
  async log(ticketId: string, actionType: string, details: string | null, userEmail: string | null): Promise<TicketActivityRow | undefined> {
    const { data, error } = await supabase
      .from('ticket_activity')
      .insert([{ ticket_id: ticketId, action_type: actionType, details, user_email: userEmail, created_date: new Date().toISOString() }])
      .select()
    if (error) {
      captureException(error, { context: 'ticketActivity.log', ticketId, actionType })
      return undefined
    }
    return data?.[0]
  },
}

// ── Ticket Comments ───────────────────────────────────────────────────────────

export const ticketComments = {
  async list(ticketId: string): Promise<{ missing: boolean; data: TicketCommentRow[] }> {
    const { data, error } = await supabase
      .from('ticket_comments')
      .select('*')
      .eq('ticket_id', ticketId)
      .order('created_date', { ascending: true })
    if (error) {
      if (error.code === '42P01') return { missing: true, data: [] }
      throw error
    }
    return { missing: false, data: data || [] }
  },
  async create(dto: {
    ticketId: string
    commentText: string
    authorEmail: string
    authorName?: string
    isInternal?: boolean
    parentCommentId?: string | null
    attachments?: unknown[]
    isCustomerComment?: boolean
  }): Promise<TicketCommentRow | undefined> {
    const {
      ticketId,
      commentText,
      authorEmail,
      authorName,
      isInternal = false,
      parentCommentId = null,
      attachments = [],
      isCustomerComment = false,
    } = dto
    const { data, error } = await supabase
      .from('ticket_comments')
      .insert([
        {
          ticket_id: ticketId,
          comment_text: commentText,
          user_email: authorEmail,
          author_name: authorName || authorEmail,
          is_internal: isInternal,
          parent_comment_id: parentCommentId || null,
          attachments: attachments || [],
          is_customer_comment: isCustomerComment,
          created_date: new Date().toISOString(),
        },
      ])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('ticket_comments').delete().eq('id', id)
    if (error) throw error
  },
}

// ── Public Tracker ────────────────────────────────────────────────────────────
// All calls go through the public-track Edge Function.
// Anon role has NO direct DB access; the Edge Function uses service_role
// server-side and enforces rate limiting + input validation.

export const rmaTracker = {
  async getTicketByRmaNumber(rmaNumber: string): Promise<unknown | null> {
    try {
      const { data, error } = await supabase.functions.invoke('public-track', {
        body: { action: 'lookup', rmaNumber: rmaNumber.trim() },
      })
      if (error) return null
      if (data?.error) return null
      return data?.ticket || null
    } catch (err) {
      captureException(err, { context: 'rmaTracker.getTicketByRmaNumber' })
      return null
    }
  },
  async getPublicComments(ticketId: string): Promise<unknown[]> {
    try {
      const { data, error } = await supabase.functions.invoke('public-track', {
        body: { action: 'comments', ticketId },
      })
      if (error || data?.error) return []
      return data?.comments || []
    } catch (err) {
      captureException(err, { context: 'rmaTracker.getPublicComments' })
      return []
    }
  },
  async addComment(
    ticketId: string,
    authorName: string,
    authorEmail: string,
    commentText: string,
    parentCommentId: string | null = null,
    attachments: unknown[] = []
  ): Promise<unknown> {
    const { data, error } = await supabase.functions.invoke('public-track', {
      body: {
        action: 'addComment',
        comment: { ticketId, authorName, authorEmail, commentText, parentCommentId, attachments: attachments || [] },
      },
    })
    if (error) throw new Error(error.message || 'Failed to send message')
    if (data?.error) throw new Error(data.error)
    return data?.comment
  },
}

// ── Device Serial History ─────────────────────────────────────────────────────

export const serialHistory = {
  async getBySerial(serialNumber: string): Promise<Partial<RMATicketRow>[]> {
    if (!serialNumber?.trim()) return []
    const { data, error } = await supabase
      .rpc('rma_search_by_serial', { serial: serialNumber.trim() })
    if (error) {
      captureException(error, { context: 'serialHistory.getBySerial' })
      return []
    }
    return data || []
  },
}

// ── Ticket Resolutions ────────────────────────────────────────────────────────

export interface TicketResolutionRow {
  id: string
  ticket_id: string
  type: 'replacement' | 'exchange' | 'credit_note' | 'refund'
  replacement_product_name: string | null
  replacement_serial: string | null
  amount: number | null
  currency: string | null
  reason: string | null
  reference_number: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export const ticketResolutions = {
  async get(ticketId: string): Promise<TicketResolutionRow | null> {
    const { data, error } = await supabase
      .from('ticket_resolutions')
      .select('*')
      .eq('ticket_id', ticketId)
      .maybeSingle()
    if (error?.code === '42P01') return null
    if (error) throw error
    return data
  },

  async upsert(ticketId: string, payload: Omit<TicketResolutionRow, 'id' | 'ticket_id' | 'created_at' | 'updated_at'>): Promise<TicketResolutionRow> {
    const { data, error } = await supabase
      .from('ticket_resolutions')
      .upsert({ ...payload, ticket_id: ticketId, updated_at: new Date().toISOString() }, { onConflict: 'ticket_id' })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('ticket_resolutions').delete().eq('id', id)
    if (error) throw error
  },
}
