import { supabase } from './client.js'

export const branding = {
  async getBranding() {
    const { data, error } = await supabase.from('branding_settings').select('*').single()
    if (error) {
      if (error.code === 'PGRST116')
        return {
          company_name: 'myRMA',
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
