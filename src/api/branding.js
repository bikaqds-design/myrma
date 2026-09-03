import { supabase } from './client.js'

export const branding = {
  async getBranding() {
    const { data, error } = await supabase.from('branding_settings').select('*').single()
    if (error) {
      if (error.code === 'PGRST116')
        return {
          company_name: 'myCRM',
          logo_url: null,
          primary_color: '#4F46E5',
          secondary_color: '#818CF8',
          accent_color: '#10B981',
        }
      throw error
    }
    return data
  },
  async updateBranding(updates, userEmail) {
    const { data: existing } = await supabase.from('branding_settings').select('*').single()
    if (existing) {
      const { data, error } = await supabase
        .from('branding_settings')
        .update({ ...updates, updated_by: userEmail, updated_date: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
      if (error) throw error
      return data?.[0]
    } else {
      const { data, error } = await supabase
        .from('branding_settings')
        .insert([{ ...updates, updated_by: userEmail, updated_date: new Date().toISOString() }])
        .select()
      if (error) throw error
      return data?.[0]
    }
  },
  /**
   * Upload a favicon and return its public URL.
   *
   * The favicon used to be read with FileReader and stored as a base64 data URI
   * inside the appearance_settings config row. A 1 MB image allowance meant that
   * row could carry megabytes of image, and it is fetched on every app mount for
   * every user before first paint — the real one measured 88,788 characters
   * (UX-DARK-003). Storage serves it once and the browser caches it.
   *
   * Same bucket and prefix as the logo, so branding assets stay together.
   */
  async uploadFavicon(file) {
    const fileExt = file.name.split('.').pop()
    const fileName = `branding/favicon-${Date.now()}.${fileExt}`
    const { error } = await supabase.storage
      .from('rma-attachments')
      .upload(fileName, file, { cacheControl: '31536000', upsert: false })
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return publicUrl
  },
  async uploadLogo(file) {
    const fileExt = file.name.split('.').pop()
    const fileName = `branding/logo-${Date.now()}.${fileExt}`
    const { error } = await supabase.storage
      .from('rma-attachments')
      .upload(fileName, file, { cacheControl: '3600', upsert: false })
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return publicUrl
  },
}
