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

    if (templateError) throw new Error('Template not found')

    const { data: settings, error: settingsError } = await supabaseClient
      .from('email_settings')
      .select('*')
      .single()

    if (settingsError) throw new Error('Email settings not found')
    if (!settings.is_active) throw new Error('Email service not active')
    if (!settings.api_key) throw new Error('API key not configured')

    let subject = template.template_subject
    let body = template.template_body

    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g')
      subject = subject.replace(regex, variables[key] || '')
      body = body.replace(regex, variables[key] || '')
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
      JSON.stringify({ success: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})