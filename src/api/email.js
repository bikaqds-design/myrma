// Email notifications module — distinct from in-app notifications (src/api/db/notifications.js).
// This is exported as `notifications` from supabaseClient.js for backward compatibility.
import { supabase, supabaseUrl } from './client.js'

/**
 * The email_settings columns an administrator's browser may read. `api_key` is
 * deliberately absent — see getEmailSettings. Keep in step with the column grant
 * in supabase/migrations/20260842_email_api_key_server_side.sql.
 */
const EMAIL_SETTINGS_COLUMNS =
  'id, provider, from_email, from_name, is_active, updated_by, updated_date, has_api_key'

export const notifications = {
  async getPreferences(userEmail) {
    const { data, error } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_email', userEmail)
      .single()
    if (error) {
      if (error.code === 'PGRST116')
        return {
          ticket_created: true,
          ticket_assigned: true,
          ticket_status_changed: true,
          ticket_priority_changed: true,
          comment_added: true,
          ticket_due_soon: true,
          ticket_overdue: true,
          daily_summary: false,
        }
      throw error
    }
    return data
  },
  async updatePreferences(userEmail, preferences) {
    const { data: existing } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_email', userEmail)
      .single()
    if (existing) {
      const { data, error } = await supabase
        .from('notification_preferences')
        .update({ ...preferences, updated_date: new Date().toISOString() })
        .eq('user_email', userEmail)
        .select()
      if (error) throw error
      return data?.[0]
    } else {
      const { data, error } = await supabase
        .from('notification_preferences')
        .insert([{ user_email: userEmail, ...preferences }])
        .select()
      if (error) throw error
      return data?.[0]
    }
  },
  async getTemplates() {
    try {
      const { data, error } = await supabase
        .from('email_templates')
        .select('*')
        .eq('is_active', true)
        .order('template_name', { ascending: true })
      if (error) throw error
      return data || []
    } catch {
      return []
    }
  },
  async getTemplate(templateName) {
    const { data, error } = await supabase
      .from('email_templates')
      .select('*')
      .eq('template_name', templateName)
      .single()
    if (error) throw error
    return data
  },
  async updateTemplate(templateName, updates, userEmail) {
    const { data, error } = await supabase
      .from('email_templates')
      .update({ ...updates, updated_date: new Date().toISOString(), updated_by: userEmail })
      .eq('template_name', templateName)
      .select()
    if (error) throw error
    return data?.[0]
  },
  /**
   * Email provider settings, without the provider's API key. (Audit finding BUG-059.)
   *
   * This used to `select('*')` and hand the Resend key to the settings form, so
   * the live key sat in every administrator's browser. Migration 20260842
   * revokes the column, after which `select('*')` is refused outright — so the
   * columns are named, and `has_api_key` reports whether a key is saved.
   *
   * `api_key` is returned as '' on purpose: it is the form field for typing a
   * NEW key, and an empty field on save means "keep the saved one".
   */
  async getEmailSettings() {
    const { data, error } = await supabase.from('email_settings').select(EMAIL_SETTINGS_COLUMNS).single()
    if (error) {
      if (error.code === 'PGRST116')
        return {
          provider: 'resend',
          api_key: '',
          has_api_key: false,
          from_email: 'noreply@yourdomain.com',
          from_name: 'myCRM System',
          is_active: false,
        }
      throw error
    }
    return { ...data, api_key: '' }
  },
  /**
   * Saves only the fields the form edits.
   *
   * It used to spread the whole settings object into the write. That now fails
   * twice over: `has_api_key` is a generated column and cannot be written, and
   * spreading an empty `api_key` would ERASE the saved key — which the form cannot
   * see, so it cannot know it is sending a blank. The key is written only when one
   * was actually typed.
   *
   * Every write names its returned columns: a bare `.select()` after a write is
   * `RETURNING *`, which includes the revoked column and is refused (the BUG-009
   * regression, not repeated here).
   */
  async updateEmailSettings(settings, userEmail) {
    const payload = {
      provider: settings.provider,
      from_email: settings.from_email,
      from_name: settings.from_name,
      is_active: settings.is_active,
    }
    const newKey = typeof settings.api_key === 'string' ? settings.api_key.trim() : ''
    if (newKey) payload.api_key = newKey

    const { data: existing } = await supabase.from('email_settings').select('id').single()
    if (existing) {
      const { data, error } = await supabase
        .from('email_settings')
        .update({ ...payload, updated_by: userEmail, updated_date: new Date().toISOString() })
        .eq('id', existing.id)
        .select(EMAIL_SETTINGS_COLUMNS)
      if (error) throw error
      return data?.[0]
    } else {
      const { data, error } = await supabase
        .from('email_settings')
        .insert([{ ...payload, updated_by: userEmail }])
        .select(EMAIL_SETTINGS_COLUMNS)
      if (error) throw error
      return data?.[0]
    }
  },
  /**
   * Sends one templated email.
   *
   * Presents the signed-in person's own access token, not the anon key.
   * send-email identifies its caller and requires an active administrator; the
   * anon key ships in this bundle, so sending it proved nothing about who was
   * asking and left the endpoint callable by anyone who read the JavaScript.
   */
  async sendEmail(recipientEmail, templateName, variables) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) throw new Error('You must be signed in to send email')

    const response = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ recipientEmail, templateName, variables }),
    })
    const result = await response.json()
    if (!result.success) throw new Error(result.error || 'Failed to send email')
    return result
  },
  async sendTestEmail(recipientEmail, templateName, variables) {
    return this.sendEmail(recipientEmail, templateName, variables)
  },
}
