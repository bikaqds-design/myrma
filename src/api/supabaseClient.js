import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseKey)

// Helper: invoke the admin-reset-password Edge Function (handles set + create-if-missing).
// The Edge Function validates the caller's JWT and confirms super_admin role server-side.
async function invokeAdminUserOp(targetEmail, newPassword) {
  const { data, error } = await supabase.functions.invoke('admin-reset-password', {
    body: { targetEmail, newPassword }
  })
  if (error) throw new Error(error.message || 'Admin user operation failed')
  if (data?.error) throw new Error(data.error)
  return data
}

export const auth = {
  async signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) throw error
    return data
  },
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  },
  async signOut() {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  },
  async getCurrentUser() {
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error) return null
    return user
  },
  async resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/`
    })
    if (error) throw error
  },
  async updatePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) throw error
  },
  // Super-admin direct password set. Runs server-side via Edge Function with JWT validation.
  // The function creates a new auth user if one doesn't exist for the email.
  async adminSetPassword(targetEmail, newPassword) {
    return invokeAdminUserOp(targetEmail, newPassword)
  },
  // Create a Supabase Auth account for a new user (super_admin only).
  // Runs server-side via the same Edge Function (treats missing user as create).
  async adminCreateUser(email, password) {
    return invokeAdminUserOp(email, password)
  },
  async updateProfile(metadata) {
    const { data, error } = await supabase.auth.updateUser({ data: metadata })
    if (error) throw error
    return data
  },
  async signOutAll() {
    const { error } = await supabase.auth.signOut({ scope: 'global' })
    if (error) throw error
  },
  onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange(callback)
  }
}

// ─── Audit log helpers (H-9) ─────────────────────────────────────────────────
// Resilient fire-and-log: retry once, then queue to localStorage.
// Queued entries are flushed on next successful write or app start.
const AUDIT_QUEUE_KEY = 'mrma_audit_queue'
const AUDIT_QUEUE_MAX = 50

function _auditEnqueue(entry) {
  try {
    const q = JSON.parse(localStorage.getItem(AUDIT_QUEUE_KEY) || '[]')
    q.push(entry)
    if (q.length > AUDIT_QUEUE_MAX) q.splice(0, q.length - AUDIT_QUEUE_MAX)
    localStorage.setItem(AUDIT_QUEUE_KEY, JSON.stringify(q))
  } catch {}
}

async function auditFlushQueue() {
  try {
    const q = JSON.parse(localStorage.getItem(AUDIT_QUEUE_KEY) || '[]')
    if (!q.length) return
    const { error } = await supabase.from('user_activity_log').insert(q)
    if (!error) localStorage.removeItem(AUDIT_QUEUE_KEY)
  } catch {}
}

async function auditInsert(entry) {
  const doInsert = () => supabase.from('user_activity_log').insert([entry])
  const { error } = await doInsert()
  if (!error) { auditFlushQueue().catch(() => {}); return }
  // First attempt failed — retry once after 600ms
  await new Promise(r => setTimeout(r, 600))
  const { error: retryErr } = await doInsert()
  if (!retryErr) { auditFlushQueue().catch(() => {}); return }
  // Both failed — queue for next session and surface to console
  console.error('[auditLog] Failed to write audit event (queued):', entry.action_type, retryErr?.message)
  _auditEnqueue(entry)
}
// ─────────────────────────────────────────────────────────────────────────────

export const db = {

  userRoles: {
    async getUserRole(email) {
      try {
        const { data, error } = await supabase.from('user_roles').select('*').eq('user_email', email).single()
        if (error) { if (error.code === 'PGRST116') return null; throw error }
        return data
      } catch { return null }
    },
    async listAllRoles() {
      const { data, error } = await supabase.from('user_roles').select('*').order('created_date', { ascending: false })
      if (error) throw error
      return data || []
    },
    async createRole(email, role) {
      const { data, error } = await supabase.from('user_roles').insert([{ user_email: email, role }]).select()
      if (error) throw error
      return data?.[0]
    },
    async updateRole(email, role) {
      const { data, error } = await supabase.from('user_roles').update({ role }).eq('user_email', email).select()
      if (error) throw error
      return data?.[0]
    },
    async updateUserStatus(email, status, reason, suspendedBy) {
      const updates = { status }
      if (status === 'suspended' || status === 'locked') {
        updates.suspended_reason = reason
        updates.suspended_by = suspendedBy
        updates.suspended_date = new Date().toISOString()
      } else if (status === 'active') {
        updates.suspended_reason = null
        updates.suspended_by = null
        updates.suspended_date = null
      }
      const { data, error } = await supabase.from('user_roles').update(updates).eq('user_email', email).select()
      if (error) throw error
      return data?.[0]
    },
    async updateUserPermissions(email, permissions) {
      const { data, error } = await supabase.from('user_roles').update({ permissions }).eq('user_email', email).select()
      if (error) throw error
      return data?.[0]
    },
    async updateUserNotes(email, notes) {
      const { data, error } = await supabase.from('user_roles').update({ notes }).eq('user_email', email).select()
      if (error) throw error
      return data?.[0]
    },
    async deleteUser(email) {
      const { error } = await supabase.from('user_roles').delete().eq('user_email', email)
      if (error) throw error
    },
    async getCustomRoles() {
      try {
        const { data, error } = await supabase.from('custom_roles').select('*').order('created_date', { ascending: false })
        if (error) throw error
        return data || []
      } catch { return [] }
    },
    async createCustomRole(roleName, roleDescription, permissions, createdBy) {
      const { data, error } = await supabase.from('custom_roles').insert([{ role_name: roleName, role_description: roleDescription, permissions, created_by: createdBy }]).select()
      if (error) throw error
      return data?.[0]
    },
    async deleteCustomRole(roleId) {
      const { error } = await supabase.from('custom_roles').delete().eq('id', roleId)
      if (error) throw error
    }
  },

  userActivity: {
    async list(email) {
      try {
        const { data, error } = await supabase.from('user_activity_log').select('*').eq('user_email', email).order('created_date', { ascending: false }).limit(50)
        if (error) throw error
        return data || []
      } catch { return [] }
    },
    async create(email, actionType, actionDetails) {
      // H-9: use resilient auditInsert (retry + queue) instead of bare insert
      await auditInsert({
        user_email: email,
        action_type: actionType,
        action_details: actionDetails,
        created_date: new Date().toISOString(),
      })
    }
  },

  brands: {
    async list() {
      const { data, error } = await supabase.from('brands').select('*').order('brand_name', { ascending: true })
      if (error) throw error
      return data || []
    },
    async create(brand) {
      const { data, error } = await supabase.from('brands').insert([brand]).select()
      if (error) throw error
      return data?.[0]
    },
    async update(id, brand) {
      const { data, error } = await supabase.from('brands').update(brand).eq('id', id).select()
      if (error) throw error
      return data?.[0]
    },
    async delete(id) {
      const { error } = await supabase.from('brands').delete().eq('id', id)
      if (error) throw error
    }
  },

  categories: {
    async list() {
      const { data, error } = await supabase.from('categories').select('*, brand:brands(id, brand_name)').order('category_name', { ascending: true })
      if (error) throw error
      return data || []
    },
    async listByBrand(brandId) {
      const { data, error } = await supabase.from('categories').select('*').eq('brand_id', brandId).order('category_name', { ascending: true })
      if (error) throw error
      return data || []
    },
    async create(category) {
      const { data, error } = await supabase.from('categories').insert([category]).select()
      if (error) throw error
      return data?.[0]
    },
    async update(id, category) {
      const { data, error } = await supabase.from('categories').update(category).eq('id', id).select()
      if (error) throw error
      return data?.[0]
    },
    async delete(id) {
      const { error } = await supabase.from('categories').delete().eq('id', id)
      if (error) throw error
    }
  },

  subcategories: {
    async list() {
      const { data, error } = await supabase.from('subcategories').select('*, category:categories(id, category_name, brand_id)').order('subcategory_name', { ascending: true })
      if (error) throw error
      return data || []
    },
    async listByCategory(categoryId) {
      const { data, error } = await supabase.from('subcategories').select('*').eq('category_id', categoryId).order('subcategory_name', { ascending: true })
      if (error) throw error
      return data || []
    },
    async create(subcategory) {
      const { data, error } = await supabase.from('subcategories').insert([subcategory]).select()
      if (error) throw error
      return data?.[0]
    },
    async update(id, subcategory) {
      const { data, error } = await supabase.from('subcategories').update(subcategory).eq('id', id).select()
      if (error) throw error
      return data?.[0]
    },
    async delete(id) {
      const { error } = await supabase.from('subcategories').delete().eq('id', id)
      if (error) throw error
    }
  },

  products: {
    async list() {
      // Capped at 500 rows — use listPaged() for server-side pagination (H-4)
      const { data, error } = await supabase.from('products').select('*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)').order('created_date', { ascending: false }).limit(500)
      if (error) throw error
      return data || []
    },
    async listPaged(page = 0, pageSize = 50) {
      const from = page * pageSize
      const { data, count, error } = await supabase
        .from('products')
        .select('*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)', { count: 'exact' })
        .order('created_date', { ascending: false })
        .range(from, from + pageSize - 1)
      if (error) throw error
      return { data: data || [], count: count || 0, page, pageSize, totalPages: Math.ceil((count || 0) / pageSize) }
    },
    async get(id) {
      const { data, error } = await supabase.from('products').select('*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)').eq('id', id).single()
      if (error) throw error
      return data
    },
    async create(product) {
      const { data, error } = await supabase.from('products').insert([product]).select()
      if (error) throw error
      return data?.[0]
    },
    async bulkCreate(products) {
      const { data, error } = await supabase.from('products').insert(products).select()
      if (error) throw error
      return data || []
    },
    async update(id, product) {
      const { data, error } = await supabase.from('products').update(product).eq('id', id).select()
      if (error) throw error
      return data?.[0]
    },
    async delete(id) {
      const { error } = await supabase.from('products').delete().eq('id', id)
      if (error) throw error
    },
    async bulkDelete(ids) {
      const { error } = await supabase.from('products').delete().in('id', ids)
      if (error) throw error
    },
    async bulkUpdateStatus(ids, status) {
      const { error } = await supabase.from('products').update({ status, updated_date: new Date().toISOString() }).in('id', ids)
      if (error) throw error
    },
    async search(query) {
      const safe = query.replace(/[%_\\]/g, '\\$&').replace(/[(),"]/g, '')
      const { data, error } = await supabase.from('products').select('*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)').or(`product_name.ilike.%${safe}%,sku.ilike.%${safe}%,product_description.ilike.%${safe}%`).order('created_date', { ascending: false })
      if (error) throw error
      return data || []
    },
    async getRelatedTickets(productId) {
      const { data, error } = await supabase.from('rma_tickets').select('*').eq('product_id', productId).order('created_date', { ascending: false })
      if (error) throw error
      return data || []
    }
  },

  customers: {
    async list() {
      // Capped at 500 rows — use listPaged() for server-side pagination (H-4)
      const { data, error } = await supabase.from('customers').select('*').order('created_date', { ascending: false }).limit(500)
      if (error) throw error
      return data || []
    },
    async listPaged(page = 0, pageSize = 50) {
      const from = page * pageSize
      const { data, count, error } = await supabase
        .from('customers')
        .select('*', { count: 'exact' })
        .order('created_date', { ascending: false })
        .range(from, from + pageSize - 1)
      if (error) throw error
      return { data: data || [], count: count || 0, page, pageSize, totalPages: Math.ceil((count || 0) / pageSize) }
    },
    async get(id) {
      const { data, error } = await supabase.from('customers').select('*').eq('id', id).single()
      if (error) throw error
      return data
    },
    async create(customer) {
      const { data, error } = await supabase.from('customers').insert([customer]).select()
      if (error) throw error
      return data?.[0]
    },
    async bulkCreate(customers) {
      const { data, error } = await supabase.from('customers').insert(customers).select()
      if (error) throw error
      return data || []
    },
    async update(id, customer) {
      const { data, error } = await supabase.from('customers').update(customer).eq('id', id).select()
      if (error) throw error
      return data?.[0]
    },
    async delete(id) {
      // Atomic cascade delete via server-side RPC (H-8 fix).
      // delete_customer_cascade runs in a single transaction — no partial state possible.
      const { error } = await supabase.rpc('delete_customer_cascade', { p_customer_id: id })
      if (error) {
        if (error.code === 'PGRST202') throw new Error('delete_customer_cascade RPC not found. Run supabase/migrations/20260524_customer_cascade_delete.sql first.')
        throw error
      }
    },
    async bulkDelete(ids) {
      // Atomic cascade bulk delete via server-side RPC (H-8 fix).
      // delete_customers_cascade runs in a single transaction — no partial state possible.
      const { error } = await supabase.rpc('delete_customers_cascade', { p_customer_ids: ids })
      if (error) {
        if (error.code === 'PGRST202') throw new Error('delete_customers_cascade RPC not found. Run supabase/migrations/20260524_customer_cascade_delete.sql first.')
        throw error
      }
    },
    async bulkUpdateStatus(ids, status) {
      const { error } = await supabase.from('customers').update({ customer_status: status, updated_date: new Date().toISOString() }).in('id', ids)
      if (error) throw error
    },
    async getRelatedTickets(customerId) {
      const { data, error } = await supabase.from('rma_tickets').select('*').eq('customer_id', customerId).order('created_date', { ascending: false })
      if (error) throw error
      return data || []
    },
    async uploadPhoto(file, customerId) {
      const fileExt = file.name.split('.').pop()
      const fileName = `customers/customer-${customerId}-${Date.now()}.${fileExt}`
      const { error: uploadError } = await supabase.storage.from('rma-attachments').upload(fileName, file, { upsert: true })
      if (uploadError) throw uploadError
      const { data } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
      return data.publicUrl
    }
  },

  customerNotes: {
    async list(customerId) {
      const { data, error } = await supabase.from('customer_notes').select('*').eq('customer_id', customerId).order('created_date', { ascending: false })
      if (error) throw error
      return data || []
    },
    async create(note) {
      const { data, error } = await supabase.from('customer_notes').insert([note]).select()
      if (error) throw error
      return data?.[0]
    },
    async update(id, note) {
      const { data, error } = await supabase.from('customer_notes').update(note).eq('id', id).select()
      if (error) throw error
      return data?.[0]
    },
    async delete(id) {
      const { error } = await supabase.from('customer_notes').delete().eq('id', id)
      if (error) throw error
    }
  },

  rmaTickets: {
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
  },

  ticketActivity: {
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
  },

  announcements: {
    async list() {
      try {
        const { data, error } = await supabase.from('announcements').select('*').order('created_date', { ascending: false })
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },
    async listActive() {
      try {
        const now = new Date().toISOString()
        const { data, error } = await supabase.from('announcements').select('*')
          .eq('is_active', true)
          .or(`starts_at.is.null,starts_at.lte.${now}`)
          .or(`ends_at.is.null,ends_at.gte.${now}`)
          .order('created_date', { ascending: false })
        if (error) return []
        return data || []
      } catch { return [] }
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
    }
  },

  rmaConfig: {
    async getAll() {
      try {
        const { data, error } = await supabase.from('rma_config').select('*')
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },
    async set(configKey, configValue, userEmail) {
      const { data, error } = await supabase.from('rma_config')
        .upsert({ config_key: configKey, config_value: configValue, updated_by: userEmail, updated_date: new Date().toISOString() }, { onConflict: 'config_key' })
        .select()
      if (error) throw error
      return data?.[0]
    }
  },

  customFields: {
    async list() {
      try {
        const { data, error } = await supabase.from('custom_field_definitions').select('*').order('sort_order', { ascending: true })
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },
    async create(field) {
      const { data, error } = await supabase.from('custom_field_definitions').insert([field]).select()
      if (error) throw error
      return data?.[0]
    },
    async update(id, field) {
      const { data, error } = await supabase.from('custom_field_definitions').update(field).eq('id', id).select()
      if (error) throw error
      return data?.[0]
    },
    async delete(id) {
      const { error } = await supabase.from('custom_field_definitions').delete().eq('id', id)
      if (error) throw error
    }
  },

  webhooks: {
    async list() {
      try {
        const { data, error } = await supabase.from('webhooks').select('*').order('created_date', { ascending: false })
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
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
        const result = await db.webhooks.list()
        if (result.missing) return
        const active = (result.data || []).filter(h => h.is_active && (!h.events?.length || h.events.includes(eventType)))
        if (!active.length) return

        await Promise.allSettled(active.map(async h => {
          const body = JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), data: payload })
          const headers = { 'Content-Type': 'application/json' }

          // H-7: HMAC-SHA256 signature replaces plaintext X-Webhook-Secret.
          // Receiver verifies: HMAC-SHA256(secret, raw_body) === X-Signature-256 value.
          if (h.secret_key) {
            try {
              const enc = new TextEncoder()
              const cryptoKey = await crypto.subtle.importKey(
                'raw', enc.encode(h.secret_key),
                { name: 'HMAC', hash: 'SHA-256' },
                false, ['sign']
              )
              const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(body))
              const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
              headers['X-Signature-256'] = `sha256=${hex}`
            } catch { /* crypto unavailable — send unsigned */ }
          }

          return fetch(h.url, { method: 'POST', headers, body }).catch(() => {})
        }))
      } catch {}
    }
  },

  auditLog: {
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
        const { data, error } = await supabase.from('user_activity_log').select('*').order('created_date', { ascending: false }).limit(limit)
        if (error) throw error
        return data || []
      } catch { return [] }
    }
  },

  ticketComments: {
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
  },

  // Public tracker — all calls go through the public-track Edge Function.
  // Anon role has NO direct DB access; the Edge Function uses service_role
  // server-side and enforces rate limiting + input validation.
  rmaTracker: {
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
  },

  inventory: {
    async createUnitsFromTicket(ticketId, rmaNumber, products) {
      if (!products?.length) return []
      const units = products.filter(p => p.product_name || p.serial_number).map(p => ({
        rma_ticket_id: ticketId,
        rma_number: rmaNumber,
        product_name: p.product_name || '',
        serial_number: p.serial_number || '',
        warranty_status: p.warranty_status || '',
        status: 'active_rma',
        created_date: new Date().toISOString(),
      }))
      if (!units.length) return []
      const { data, error } = await supabase.from('inventory_units').insert(units).select()
      if (error) { if (error.code === '42P01') return []; return [] }
      return data || []
    },

    async listUnits() {
      try {
        const { data, error } = await supabase.from('inventory_units').select('*').order('created_date', { ascending: false })
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },

    async resolveUnits(ids, resolutionType, notes) {
      const status = resolutionType === 'return_to_customer' ? 'closed' : 'company_stock'
      const { data, error } = await supabase.from('inventory_units')
        .update({ status, resolution_type: resolutionType, resolved_date: new Date().toISOString(), notes: notes || null })
        .in('id', ids).select()
      if (error) throw error
      return data || []
    },

    async listBatches() {
      try {
        const { data, error } = await supabase.from('manufacturer_batches').select('*').order('created_date', { ascending: false })
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },

    async createBatch(unitIds, manufacturerName, userEmail) {
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const { count } = await supabase.from('manufacturer_batches').select('*', { count: 'exact', head: true })
      const batchNumber = `BATCH-${dateStr}-${String((count || 0) + 1).padStart(3, '0')}`
      const { data: batch, error: batchErr } = await supabase.from('manufacturer_batches').insert([{
        batch_number: batchNumber,
        manufacturer_name: manufacturerName,
        status: 'draft',
        unit_count: unitIds.length,
        created_date: new Date().toISOString(),
        created_by: userEmail,
      }]).select()
      if (batchErr) throw batchErr
      const batchId = batch[0].id
      await supabase.from('inventory_units').update({ manufacturer_batch_id: batchId }).in('id', unitIds)
      return batch[0]
    },

    async markBatchSent(batchId, sentDate, trackingNumber) {
      const { data, error } = await supabase.from('manufacturer_batches')
        .update({ status: 'sent', sent_date: sentDate, tracking_number: trackingNumber })
        .eq('id', batchId).select()
      if (error) throw error
      await supabase.from('inventory_units').update({ status: 'sent_to_manufacturer' }).eq('manufacturer_batch_id', batchId)
      return data?.[0]
    },

    async markBatchResolved(batchId, resolutionType, resolutionDate, notes) {
      const { data, error } = await supabase.from('manufacturer_batches')
        .update({ status: 'resolved', resolution_type: resolutionType, resolution_date: resolutionDate, resolution_notes: notes })
        .eq('id', batchId).select()
      if (error) throw error
      await supabase.from('inventory_units').update({ status: 'closed' }).eq('manufacturer_batch_id', batchId)
      return data?.[0]
    },

    async getStats() {
      try {
        const { data, error } = await supabase.from('inventory_units').select('status')
        if (error) { if (error.code === '42P01') return null; return null }
        const counts = { active_rma: 0, company_stock: 0, sent_to_manufacturer: 0, closed: 0 }
        data.forEach(u => { if (counts[u.status] !== undefined) counts[u.status]++ })
        return { ...counts, total: data.length }
      } catch { return null }
    },
    async transferUnits(unitIds, warehouseId) {
      if (!unitIds.length) throw new Error('No unit IDs provided')
      const { error } = await supabase.from('inventory_units')
        .update({ warehouse_id: warehouseId || null })
        .in('id', unitIds)
      if (error) throw error
    }
  },

  warehouses: {
    async list() {
      try {
        const { data, error } = await supabase.from('warehouses').select('*').order('name', { ascending: true })
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },
    async create(warehouse) {
      const { data, error } = await supabase.from('warehouses').insert([warehouse]).select()
      if (error) throw error
      return data?.[0]
    },
    async update(id, warehouse) {
      const { data, error } = await supabase.from('warehouses').update(warehouse).eq('id', id).select()
      if (error) throw error
      return data?.[0]
    },
    async delete(id) {
      const { error } = await supabase.from('warehouses').delete().eq('id', id)
      if (error) throw error
    }
  },

  notifications: {
    async create({ type, title, message, entityType, entityId, entityRef, createdBy, targetRoles = [], targetEmails = [] }) {
      try {
        const { data, error } = await supabase.from('notifications').insert([{
          type, title, message,
          entity_type: entityType || null,
          entity_id: entityId || null,
          entity_ref: entityRef || null,
          created_by: createdBy || null,
          created_date: new Date().toISOString(),
          target_roles: targetRoles,
          target_emails: targetEmails,
          read_by: []
        }]).select()
        if (error) { if (error.code === '42P01') return null; return null }
        return data?.[0]
      } catch { return null }
    },

    async listForUser(email, role) {
      try {
        // RLS policy user_read_targeted already filters by target_roles/target_emails server-side.
        // No client-side filter needed — what comes back is exactly what this user should see (H-5 fix).
        const { data, error } = await supabase
          .from('notifications')
          .select('*')
          .order('created_date', { ascending: false })
          .limit(50)
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },

    async markRead(id, email) {
      try {
        // Reuse mark_notifications_read RPC — single atomic UPDATE, no read-then-write (H-5 fix)
        await supabase.rpc('mark_notifications_read', { p_email: email, p_ids: [id] })
      } catch {}
    },

    async markAllRead(email, role) {
      try {
        // Fetch unread IDs only — single SELECT, filter client-side for role/email targeting
        const { data } = await supabase
          .from('notifications')
          .select('id, read_by, target_roles, target_emails')
          .order('created_date', { ascending: false })
          .limit(50)
        const ids = (data || [])
          .filter(n =>
            (n.target_roles?.includes(role) || n.target_emails?.includes(email)) &&
            !n.read_by?.includes(email)
          )
          .map(n => n.id)
        if (!ids.length) return
        // Single batched UPDATE via RPC — replaces N individual updates (H-2 fix)
        await supabase.rpc('mark_notifications_read', { p_email: email, p_ids: ids })
      } catch {}
    }
  },

  // ── Time Tracking ──────────────────────────────────────────────────────────
  timeEntries: {
    async list(ticketId) {
      try {
        const { data, error } = await supabase.from('time_entries').select('*').eq('ticket_id', ticketId).order('created_date', { ascending: false })
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },
    async listAll() {
      try {
        const { data, error } = await supabase.from('time_entries').select('*, ticket:rma_tickets(rma_number, customer_name)').order('created_date', { ascending: false })
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },
    async create(entry) {
      const { data, error } = await supabase.from('time_entries').insert([{ ...entry, created_date: new Date().toISOString() }]).select()
      if (error) throw error
      return data?.[0]
    },
    async update(id, updates) {
      const { data, error } = await supabase.from('time_entries').update(updates).eq('id', id).select()
      if (error) throw error
      return data?.[0]
    },
    async delete(id) {
      const { error } = await supabase.from('time_entries').delete().eq('id', id)
      if (error) throw error
    },
    async getTotalMinutes(ticketId) {
      try {
        const { data, error } = await supabase.from('time_entries').select('duration_min').eq('ticket_id', ticketId).not('duration_min', 'is', null)
        if (error) return 0
        return (data || []).reduce((sum, e) => sum + (e.duration_min || 0), 0)
      } catch { return 0 }
    }
  },

  // ── Parts / Components Inventory ───────────────────────────────────────────
  parts: {
    async list() {
      try {
        const { data, error } = await supabase.from('parts').select('*').order('part_name', { ascending: true })
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },
    async get(id) {
      const { data, error } = await supabase.from('parts').select('*').eq('id', id).single()
      if (error) throw error
      return data
    },
    async create(part) {
      const { data, error } = await supabase.from('parts').insert([{ ...part, created_date: new Date().toISOString(), updated_date: new Date().toISOString() }]).select()
      if (error) throw error
      return data?.[0]
    },
    async update(id, part) {
      const { data, error } = await supabase.from('parts').update({ ...part, updated_date: new Date().toISOString() }).eq('id', id).select()
      if (error) throw error
      return data?.[0]
    },
    async delete(id) {
      const { error } = await supabase.from('parts').delete().eq('id', id)
      if (error) throw error
    },
    async adjustQuantity(id, delta) {
      // Atomic RPC — no read-modify-write race condition (H-3 fix)
      const { data, error } = await supabase.rpc('adjust_part_quantity', { p_id: id, p_delta: delta })
      if (error) throw error
      return data?.[0]
    }
  },

  ticketParts: {
    async list(ticketId) {
      try {
        const { data, error } = await supabase.from('ticket_parts').select('*, part:parts(part_name, part_number)').eq('ticket_id', ticketId).order('created_date', { ascending: true })
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },
    async add(ticketId, partId, quantity, unitCost, notes, addedBy) {
      // Deduct from parts inventory
      await db.parts.adjustQuantity(partId, -quantity)
      const { data, error } = await supabase.from('ticket_parts').insert([{
        ticket_id: ticketId, part_id: partId,
        quantity, unit_cost: unitCost,
        notes: notes || null, added_by: addedBy || null,
        created_date: new Date().toISOString()
      }]).select('*, part:parts(part_name, part_number)')
      if (error) throw error
      return data?.[0]
    },
    async remove(id, partId, quantity) {
      // Restore quantity to inventory
      await db.parts.adjustQuantity(partId, quantity)
      const { error } = await supabase.from('ticket_parts').delete().eq('id', id)
      if (error) throw error
    }
  },

  // ── Invoices / Quotes ──────────────────────────────────────────────────────
  invoices: {
    async list() {
      try {
        const { data, error } = await supabase.from('invoices').select('*').order('created_date', { ascending: false })
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        return { missing: false, data: data || [] }
      } catch { return { missing: true, data: [] } }
    },
    async get(id) {
      const { data, error } = await supabase.from('invoices').select('*').eq('id', id).single()
      if (error) throw error
      return data
    },
    async create(invoice) {
      const now = new Date().toISOString()
      const { data, error } = await supabase.from('invoices').insert([{ ...invoice, created_date: now, updated_date: now }]).select()
      if (error) throw error
      return data?.[0]
    },
    async update(id, updates) {
      const { data, error } = await supabase.from('invoices').update({ ...updates, updated_date: new Date().toISOString() }).eq('id', id).select()
      if (error) throw error
      return data?.[0]
    },
    async delete(id) {
      const { error } = await supabase.from('invoices').delete().eq('id', id)
      if (error) throw error
    },
    async generateNumber(existingInvoices = []) {
      const now = new Date()
      const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-`
      const serials = existingInvoices.map(i => i.invoice_number).filter(n => n?.startsWith(prefix))
        .map(n => parseInt(n.replace(prefix, ''), 10)).filter(n => !isNaN(n))
      const next = serials.length > 0 ? Math.max(...serials) + 1 : 1
      return `${prefix}${String(next).padStart(4, '0')}`
    }
  },

  // ── SLA Policies (stored in rma_config) ────────────────────────────────────
  slaConfig: {
    DEFAULT: {
      enabled: false,
      pauseOnHold: true,
      policies: [
        { priority: 'Critical', hours: 24 },
        { priority: 'High',     hours: 48 },
        { priority: 'Medium',   hours: 72 },
        { priority: 'Low',      hours: 168 },
      ]
    },
    async get() {
      try {
        const { data, error } = await supabase.from('rma_config').select('config_value').eq('config_key', 'sla_config').single()
        if (error) return db.slaConfig.DEFAULT
        return { ...db.slaConfig.DEFAULT, ...(data?.config_value || {}) }
      } catch { return db.slaConfig.DEFAULT }
    },
    async save(config, userEmail) {
      return db.rmaConfig.set('sla_config', config, userEmail)
    },
    computeDueDate(priority, config) {
      if (!config?.enabled) return null
      const policy = (config.policies || []).find(p => p.priority === priority)
      if (!policy) return null
      const d = new Date()
      d.setHours(d.getHours() + policy.hours)
      return d.toISOString().split('T')[0]
    }
  },

  // ── Automation Rules (stored in rma_config) ────────────────────────────────
  automationRules: {
    async list() {
      try {
        const { data, error } = await supabase.from('rma_config').select('config_value').eq('config_key', 'automation_rules').single()
        if (error) return []
        return data?.config_value || []
      } catch { return [] }
    },
    async save(rules, userEmail) {
      return db.rmaConfig.set('automation_rules', rules, userEmail)
    },
    // Run all matching rules against a ticket event. Returns list of applied rule names.
    async evaluate(eventType, ticket, allTickets = []) {
      try {
        const rules = await db.automationRules.list()
        const active = rules.filter(r => r.enabled && r.trigger === eventType)
        const applied = []
        for (const rule of active) {
          if (!evaluateConditions(rule.conditions || [], ticket)) continue
          await applyActions(rule.actions || [], ticket)
          applied.push(rule.name)
        }
        return applied
      } catch { return [] }
    }
  },

  // ── Device Serial History ──────────────────────────────────────────────────
  serialHistory: {
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
}

// ── Automation rule helpers (module-private) ──────────────────────────────────
function evaluateConditions(conditions, ticket) {
  if (!conditions.length) return true
  return conditions.every(c => {
    const val = String(ticket[c.field] || '').toLowerCase()
    const cv  = String(c.value || '').toLowerCase()
    switch (c.op) {
      case 'equals':      return val === cv
      case 'not_equals':  return val !== cv
      case 'contains':    return val.includes(cv)
      case 'starts_with': return val.startsWith(cv)
      default: return true
    }
  })
}
async function applyActions(actions, ticket) {
  for (const a of actions) {
    try {
      if (a.type === 'change_status') {
        await supabase.from('rma_tickets').update({ ticket_status: a.value, updated_date: new Date().toISOString() }).eq('id', ticket.id)
      } else if (a.type === 'change_priority') {
        await supabase.from('rma_tickets').update({ priority: a.value, updated_date: new Date().toISOString() }).eq('id', ticket.id)
      } else if (a.type === 'assign_technician') {
        await supabase.from('rma_tickets').update({ assigned_technician: a.value, updated_date: new Date().toISOString() }).eq('id', ticket.id)
      } else if (a.type === 'create_notification') {
        await db.notifications.create({ type: 'custom_alert', title: a.title || 'Automation', message: a.value, createdBy: 'system', targetRoles: ['admin', 'super_admin'] })
      }
    } catch {}
  }
}

const ALLOWED_ATTACHMENT_TYPES = ['image/jpeg','image/png','image/gif','image/webp','application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain','text/csv']
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024 // 25 MB
const MAX_AVATAR_SIZE = 5 * 1024 * 1024 // 5 MB

function validateAttachment(file) {
  if (file.size > MAX_ATTACHMENT_SIZE) throw new Error(`File too large (max 25 MB): ${file.name}`)
  if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) throw new Error(`File type not allowed: ${file.type}`)
}

export const storage = {
  async uploadFile(file, rmaNumber) {
    validateAttachment(file)
    const fileExt = file.name.split('.').pop()
    const fileName = `${rmaNumber}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const { data: { publicUrl } } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { name: file.name, url: publicUrl, path: fileName, size: file.size, type: file.type }
  },
  async deleteFile(path) {
    const { error } = await supabase.storage.from('rma-attachments').remove([path])
    if (error) throw error
  },
  async uploadProductImage(file, productSku) {
    const fileExt = file.name.split('.').pop()
    const fileName = `products/${productSku}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const { data: { publicUrl } } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { url: publicUrl, path: fileName }
  },
  async uploadAvatar(file, userId) {
    if (file.size > MAX_AVATAR_SIZE) throw new Error('Avatar too large (max 5 MB)')
    if (!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)) throw new Error('Avatar must be an image (JPEG, PNG, WebP, or GIF)')
    const fileExt = file.name.split('.').pop()
    const fileName = `avatars/${userId}/avatar.${fileExt}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file, { upsert: true })
    if (error) throw error
    const { data: { publicUrl } } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return publicUrl
  },
  async uploadBrandLogo(file, brandName) {
    const fileExt = file.name.split('.').pop()
    const fileName = `brands/${brandName.toLowerCase()}/${Date.now()}.${fileExt}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file, { cacheControl: '3600', upsert: false })
    if (error) throw error
    const { data: { publicUrl } } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return publicUrl
  },
  async uploadCommentAttachment(file, ticketId) {
    validateAttachment(file)
    const fileExt = file.name.split('.').pop()
    const fileName = `comments/${ticketId}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const { data: { publicUrl } } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { name: file.name, url: publicUrl, path: fileName, size: file.size, type: file.type }
  },
  async uploadCustomerAttachment(file, folderId) {
    validateAttachment(file)
    const fileExt = file.name.split('.').pop()
    const fileName = `customers/${folderId}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const { data: { publicUrl } } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { name: file.name, url: publicUrl, path: fileName, size: file.size, type: file.type }
  }
}

export const branding = {
  async getBranding() {
    try {
      const { data, error } = await supabase.from('branding_settings').select('*').single()
      if (error) {
        if (error.code === 'PGRST116') return { company_name: 'myRMA', logo_url: null, primary_color: '#4F46E5', secondary_color: '#818CF8', accent_color: '#10B981' }
        throw error
      }
      return data
    } catch (err) { throw err }
  },
  async updateBranding(updates, userEmail) {
    const { data: existing } = await supabase.from('branding_settings').select('*').single()
    if (existing) {
      const { data, error } = await supabase.from('branding_settings').update({ ...updates, updated_by: userEmail, updated_date: new Date().toISOString() }).eq('id', existing.id).select()
      if (error) throw error
      return data?.[0]
    } else {
      const { data, error } = await supabase.from('branding_settings').insert([{ ...updates, updated_by: userEmail, updated_date: new Date().toISOString() }]).select()
      if (error) throw error
      return data?.[0]
    }
  },
  async uploadLogo(file) {
    const fileExt = file.name.split('.').pop()
    const fileName = `branding/logo-${Date.now()}.${fileExt}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file, { cacheControl: '3600', upsert: false })
    if (error) throw error
    const { data: { publicUrl } } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return publicUrl
  }
}

export const notifications = {
  async getPreferences(userEmail) {
    try {
      const { data, error } = await supabase.from('notification_preferences').select('*').eq('user_email', userEmail).single()
      if (error) {
        if (error.code === 'PGRST116') return { ticket_created: true, ticket_assigned: true, ticket_status_changed: true, ticket_priority_changed: true, comment_added: true, ticket_due_soon: true, ticket_overdue: true, daily_summary: false }
        throw error
      }
      return data
    } catch (err) { throw err }
  },
  async updatePreferences(userEmail, preferences) {
    const { data: existing } = await supabase.from('notification_preferences').select('*').eq('user_email', userEmail).single()
    if (existing) {
      const { data, error } = await supabase.from('notification_preferences').update({ ...preferences, updated_date: new Date().toISOString() }).eq('user_email', userEmail).select()
      if (error) throw error
      return data?.[0]
    } else {
      const { data, error } = await supabase.from('notification_preferences').insert([{ user_email: userEmail, ...preferences }]).select()
      if (error) throw error
      return data?.[0]
    }
  },
  async getTemplates() {
    try {
      const { data, error } = await supabase.from('email_templates').select('*').eq('is_active', true).order('template_name', { ascending: true })
      if (error) throw error
      return data || []
    } catch { return [] }
  },
  async getTemplate(templateName) {
    const { data, error } = await supabase.from('email_templates').select('*').eq('template_name', templateName).single()
    if (error) throw error
    return data
  },
  async updateTemplate(templateName, updates, userEmail) {
    const { data, error } = await supabase.from('email_templates').update({ ...updates, updated_date: new Date().toISOString(), updated_by: userEmail }).eq('template_name', templateName).select()
    if (error) throw error
    return data?.[0]
  },
  async getEmailSettings() {
    try {
      const { data, error } = await supabase.from('email_settings').select('*').single()
      if (error) {
        if (error.code === 'PGRST116') return { provider: 'resend', api_key: '', from_email: 'noreply@yourdomain.com', from_name: 'myRMA System', is_active: false }
        throw error
      }
      return data
    } catch (err) { throw err }
  },
  async updateEmailSettings(settings, userEmail) {
    const { data: existing } = await supabase.from('email_settings').select('*').single()
    if (existing) {
      const { data, error } = await supabase.from('email_settings').update({ ...settings, updated_by: userEmail, updated_date: new Date().toISOString() }).eq('id', existing.id).select()
      if (error) throw error
      return data?.[0]
    } else {
      const { data, error } = await supabase.from('email_settings').insert([{ ...settings, updated_by: userEmail }]).select()
      if (error) throw error
      return data?.[0]
    }
  },
  async sendEmail(recipientEmail, templateName, variables) {
    const response = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
      body: JSON.stringify({ recipientEmail, templateName, variables })
    })
    const result = await response.json()
    if (!result.success) throw new Error(result.error || 'Failed to send email')
    return result
  },
  async sendTestEmail(recipientEmail, templateName, variables) {
    return this.sendEmail(recipientEmail, templateName, variables)
  }
}

// Fields that must never appear in a backup export (H-6)
const EMAIL_SETTINGS_SECRET_FIELDS = ['api_key', 'smtp_password', 'smtp_user', 'webhook_secret']

function redactEmailSettings(rows) {
  return (rows || []).map(row => {
    const safe = { ...row }
    for (const field of EMAIL_SETTINGS_SECRET_FIELDS) {
      if (field in safe) safe[field] = '[REDACTED — re-enter after restore]'
    }
    return safe
  })
}

export const backup = {
  async exportAll() {
    const [products, customers, tickets, comments, activity, users, brandingData, emailSettings, emailTemplates] = await Promise.all([
      supabase.from('products').select('*'),
      supabase.from('customers').select('*'),
      supabase.from('rma_tickets').select('*'),
      supabase.from('ticket_comments').select('*'),
      supabase.from('ticket_activity').select('*'),
      supabase.from('user_roles').select('*'),
      supabase.from('branding_settings').select('*'),
      // Select only non-secret columns — api_key / smtp_password never leave the server (H-6)
      supabase.from('email_settings').select('id, provider, from_email, from_name, smtp_host, smtp_port, smtp_secure, is_active, updated_by, updated_date'),
      supabase.from('email_templates').select('*')
    ])
    return {
      version: '1.0',
      exported_date: new Date().toISOString(),
      data: {
        products: products.data || [],
        customers: customers.data || [],
        tickets: tickets.data || [],
        comments: comments.data || [],
        activity: activity.data || [],
        users: users.data || [],
        branding: brandingData.data || [],
        // Secrets are excluded from the SELECT above; redactEmailSettings is a
        // belt-and-braces guard in case the schema grows new secret columns (H-6)
        emailSettings: redactEmailSettings(emailSettings.data),
        emailTemplates: emailTemplates.data || []
      }
    }
  },
  async importAll(backupData) {
    if (!backupData.data) throw new Error('Invalid backup file')
    const { data } = backupData
    const targets = [
      ['products', data.products, 'products'],
      ['customers', data.customers, 'customers'],
      ['tickets', data.tickets, 'rma_tickets'],
      ['comments', data.comments, 'ticket_comments'],
      ['activity', data.activity, 'ticket_activity']
    ]
    const results = await Promise.all(
      targets.map(async ([label, rows, table]) => {
        if (!rows?.length) return { label, skipped: true }
        const { error } = await supabase.from(table).upsert(rows)
        return { label, count: rows.length, error: error?.message || null }
      })
    )
    const failures = results.filter(r => r.error)
    if (failures.length) {
      const msg = failures.map(f => `${f.label}: ${f.error}`).join('; ')
      throw new Error(`Import partially failed — ${msg}`)
    }
    return { success: true, results }
  }
}