// Email notifications module — distinct from in-app notifications (src/api/db/notifications.js).
// This is exported as `notifications` from supabaseClient.js for backward compatibility.
import { supabase, supabaseUrl, supabaseKey } from './client.js'

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
