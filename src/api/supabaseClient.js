import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseKey)

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
      const { data, error } = await supabase.from('user_activity_log').insert([{ user_email: email, action_type: actionType, action_details: actionDetails }]).select()
      if (error) throw error
      return data?.[0]
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
      const { data, error } = await supabase.from('products').select('*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)').order('created_date', { ascending: false })
      if (error) throw error
      return data || []
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
      const { data, error } = await supabase.from('customers').select('*').order('created_date', { ascending: false })
      if (error) throw error
      return data || []
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
      const { data: tickets } = await supabase.from('rma_tickets').select('id').eq('customer_id', id)
      const ticketIds = (tickets || []).map(t => t.id)
      if (ticketIds.length) {
        await supabase.from('inventory_units').delete().in('rma_ticket_id', ticketIds)
        await supabase.from('ticket_comments').delete().in('ticket_id', ticketIds)
        await supabase.from('ticket_activity').delete().in('ticket_id', ticketIds)
        await supabase.from('rma_tickets').delete().in('id', ticketIds)
      }
      await supabase.from('customer_notes').delete().eq('customer_id', id)
      const { error } = await supabase.from('customers').delete().eq('id', id)
      if (error) throw error
    },
    async bulkDelete(ids) {
      const { data: tickets } = await supabase.from('rma_tickets').select('id').in('customer_id', ids)
      const ticketIds = (tickets || []).map(t => t.id)
      if (ticketIds.length) {
        await supabase.from('inventory_units').delete().in('rma_ticket_id', ticketIds)
        await supabase.from('ticket_comments').delete().in('ticket_id', ticketIds)
        await supabase.from('ticket_activity').delete().in('ticket_id', ticketIds)
        await supabase.from('rma_tickets').delete().in('id', ticketIds)
      }
      await supabase.from('customer_notes').delete().in('customer_id', ids)
      const { error } = await supabase.from('customers').delete().in('id', ids)
      if (error) throw error
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
      const { data, error } = await supabase.from('rma_tickets').select('*').order('created_date', { ascending: false })
      if (error) throw error
      return data || []
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
    }
  },

  auditLog: {
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

  rmaTracker: {
    async getTicketByRmaNumber(rmaNumber) {
      try {
        const { data, error } = await supabase
          .from('rma_tickets')
          .select('id, rma_number, ticket_status, priority, created_date, due_date, general_description, customer_name, products, accessories_received')
          .ilike('rma_number', rmaNumber.trim())
          .single()
        if (error) { if (error.code === 'PGRST116') return null; throw error }
        return data
      } catch { return null }
    },
    async getPublicComments(ticketId) {
      try {
        const { data, error } = await supabase
          .from('ticket_comments')
          .select('*')
          .eq('ticket_id', ticketId)
          .eq('is_internal', false)
          .order('created_date', { ascending: true })
        if (error) { if (error.code === '42P01') return []; throw error }
        return data || []
      } catch { return [] }
    },
    async addComment(ticketId, authorName, authorEmail, commentText, parentCommentId = null, attachments = []) {
      const fullPayload = {
        ticket_id: ticketId,
        comment_text: commentText,
        user_email: authorEmail || null,
        author_name: authorName,
        is_internal: false,
        is_customer_comment: true,
        parent_comment_id: parentCommentId || null,
        attachments: attachments || [],
        created_date: new Date().toISOString(),
      }
      let { data, error } = await supabase.from('ticket_comments').insert([fullPayload]).select()
      // If new columns don't exist yet (migration not run), retry with basic fields only
      if (error && (error.code === '42703' || error.message?.includes('column'))) {
        const basicPayload = {
          ticket_id: ticketId,
          comment_text: commentText,
          user_email: authorEmail || null,
          author_name: authorName,
          is_internal: false,
          created_date: new Date().toISOString(),
        }
        const result = await supabase.from('ticket_comments').insert([basicPayload]).select()
        if (result.error) throw result.error
        return result.data?.[0]
      }
      if (error) throw error
      return data?.[0]
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
        const { data, error } = await supabase
          .from('notifications')
          .select('*')
          .order('created_date', { ascending: false })
          .limit(50)
        if (error) { if (error.code === '42P01') return { missing: true, data: [] }; throw error }
        const visible = (data || []).filter(n =>
          n.target_roles?.includes(role) || n.target_emails?.includes(email)
        )
        return { missing: false, data: visible }
      } catch { return { missing: true, data: [] } }
    },

    async markRead(id, email) {
      try {
        const { data: n } = await supabase.from('notifications').select('read_by').eq('id', id).single()
        if (!n) return
        const current = n.read_by || []
        if (current.includes(email)) return
        await supabase.from('notifications').update({ read_by: [...current, email] }).eq('id', id)
      } catch {}
    },

    async markAllRead(email, role) {
      try {
        const { data } = await supabase
          .from('notifications')
          .select('id, read_by, target_roles, target_emails')
          .order('created_date', { ascending: false })
          .limit(50)
        const unread = (data || []).filter(n =>
          (n.target_roles?.includes(role) || n.target_emails?.includes(email)) &&
          !n.read_by?.includes(email)
        )
        await Promise.all(unread.map(n =>
          supabase.from('notifications').update({ read_by: [...(n.read_by || []), email] }).eq('id', n.id)
        ))
      } catch {}
    }
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
    const response = await fetch('https://ohkynosgscfygtjxbpxq.supabase.co/functions/v1/send-email', {
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
      supabase.from('email_settings').select('*'),
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
        emailSettings: emailSettings.data || [],
        emailTemplates: emailTemplates.data || []
      }
    }
  },
  async importAll(backupData) {
    if (!backupData.data) throw new Error('Invalid backup file')
    const { data } = backupData
    await Promise.all([
      data.products?.length && supabase.from('products').upsert(data.products),
      data.customers?.length && supabase.from('customers').upsert(data.customers),
      data.tickets?.length && supabase.from('rma_tickets').upsert(data.tickets),
      data.comments?.length && supabase.from('ticket_comments').upsert(data.comments),
      data.activity?.length && supabase.from('ticket_activity').upsert(data.activity)
    ])
    return { success: true }
  }
}