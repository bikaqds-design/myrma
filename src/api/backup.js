import { supabase } from './client.js'

// Fields that must never appear in a backup export (H-6)
const EMAIL_SETTINGS_SECRET_FIELDS = ['api_key', 'smtp_password', 'smtp_user', 'webhook_secret']

function redactEmailSettings(rows) {
  return (rows || []).map((row) => {
    const safe = { ...row }
    for (const field of EMAIL_SETTINGS_SECRET_FIELDS) {
      if (field in safe) safe[field] = '[REDACTED — re-enter after restore]'
    }
    return safe
  })
}

export const backup = {
  async exportAll() {
    const [
      products,
      customers,
      tickets,
      comments,
      activity,
      users,
      brandingData,
      emailSettings,
      emailTemplates,
    ] = await Promise.all([
      supabase.from('products').select('*'),
      supabase.from('customers').select('*'),
      supabase.from('rma_tickets').select('*'),
      supabase.from('ticket_comments').select('*'),
      supabase.from('ticket_activity').select('*'),
      supabase.from('user_roles').select('*'),
      supabase.from('branding_settings').select('*'),
      // Select only non-secret columns — api_key / smtp_password never leave the server (H-6)
      supabase
        .from('email_settings')
        .select(
          'id, provider, from_email, from_name, smtp_host, smtp_port, smtp_secure, is_active, updated_by, updated_date'
        ),
      supabase.from('email_templates').select('*'),
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
        emailTemplates: emailTemplates.data || [],
      },
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
      ['activity', data.activity, 'ticket_activity'],
    ]
    const results = await Promise.all(
      targets.map(async ([label, rows, table]) => {
        if (!rows?.length) return { label, skipped: true }
        const { error } = await supabase.from(table).upsert(rows)
        return { label, count: rows.length, error: error?.message || null }
      })
    )
    const failures = results.filter((r) => r.error)
    if (failures.length) {
      const msg = failures.map((f) => `${f.label}: ${f.error}`).join('; ')
      throw new Error(`Import partially failed — ${msg}`)
    }
    return { success: true, results }
  },
}
