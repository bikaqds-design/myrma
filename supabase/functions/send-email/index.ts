import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { recipientEmail, templateName, variables } = await req.json()

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: template, error: templateError } = await supabaseClient
      .from('email_templates')
      .select('*')
      .eq('template_name', templateName)
      .single()

    if (templateError) throw new Error(`Template not found: ${templateName}`)

    const { data: settings, error: settingsError } = await supabaseClient
      .from('email_settings')
      .select('*')
      .single()

    if (settingsError) throw new Error('Email settings not found')
    if (!settings.is_active) throw new Error('Email service not active')
    if (!settings.api_key) throw new Error('API key not configured')

    // Auto-inject company_name from branding so callers don't need to pass it
    let companyName = settings.from_name || 'myRMA'
    try {
      const { data: brandingRow } = await supabaseClient
        .from('branding_settings')
        .select('company_name')
        .single()
      if (brandingRow?.company_name) companyName = brandingRow.company_name
    } catch { /* branding optional */ }

    const allVars: Record<string, string> = { company_name: companyName, ...variables }

    let subject = template.template_subject
    let body = template.template_body

    Object.keys(allVars).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g')
      subject = subject.replace(regex, allVars[key] || '')
      body = body.replace(regex, allVars[key] || '')
    })

    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${settings.from_name} <${settings.from_email}>`,
        to: [recipientEmail],
        subject: subject,
        html: body.replace(/\n/g, '<br>'),
      }),
    })

    if (!resendResponse.ok) {
      const error = await resendResponse.json()
      throw new Error(error.message || 'Failed to send email')
    }

    const result = await resendResponse.json()

    await supabaseClient
      .from('email_queue')
      .insert([{
        recipient_email: recipientEmail,
        template_name: templateName,
        subject: subject,
        body: body,
        status: 'sent',
        sent_date: new Date().toISOString(),
      }])

    return new Response(
      JSON.stringify({ success: true, result }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error:', error)

    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})