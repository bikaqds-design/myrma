// Edge Function: send-email
//
// Renders one of the email_templates rows and sends it through Resend.
//
// -- Why there is a caller check ---------------------------------------------
//
// This endpoint used to run for anyone who could reach the URL. A POST with no
// Authorization header at all was served: it read the template, read the API
// key and sent the mail. Both real callers passed only the anon key, which
// ships inside the frontend bundle and is therefore public, so requiring a
// bearer token would have changed nothing -- the check has to be on WHO the
// caller is, not on whether a key was presented.
//
// That made it an open relay on a verified domain. Anyone could send any of the
// six templates to any address as myrma@qdsegypt.com, with the variables under
// their control, which is both a spam channel and a convincing phishing
// channel. The cost lands on the domain sending reputation, so the app own mail
// starts arriving in spam.
//
// Two callers are legitimate, and each proves itself differently:
//
//   notification-worker -- a trusted backend, presents the service role key.
//   The test-email button -- a person, presents their own access token and must
//   be an active admin, which is who the email settings screen is for anyway.
//
// -- Why the variables are escaped -------------------------------------------
//
// The body is sent as HTML. Variables carry customer-supplied free text
// (comment_text, issue_description), so interpolating them raw let a caller put
// arbitrary markup -- including links -- into mail signed by our domain. No
// template contains an anchor or any HTML of its own; they are plain text with
// newlines turned into <br>. So escaping the values changes nothing about how
// the mail renders and closes the injection.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { corsOriginHeaders } from '../_shared/cors.ts'

/** Escape a value being interpolated into the HTML body or the subject. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Decide whether the caller may send. Returns null when allowed, or the reason
 * to refuse.
 */
async function denyReason(
  authHeader: string | null,
  supabaseUrl: string,
  anonKey: string,
  serviceKey: string,
  adminClient: ReturnType<typeof createClient>,
): Promise<{ error: string; status: number } | null> {
  if (!authHeader) return { error: 'Unauthorized', status: 401 }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (serviceKey && token === serviceKey) return null // notification-worker

  // Anything else must be a signed-in person. The anon key is public, so it
  // must NOT pass: getUser() rejects it, which is the point.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { data, error } = await callerClient.auth.getUser()
  const caller = data?.user
  if (error || !caller?.email) return { error: 'Unauthorized', status: 401 }

  const { data: role } = await adminClient
    .from('user_roles')
    .select('role, status')
    .eq('user_email', caller.email)
    .single()

  if (!['super_admin', 'admin'].includes(role?.role ?? '') || role?.status !== 'active') {
    return { error: 'Forbidden: administrators only', status: 403 }
  }
  return null
}

Deno.serve(async (req) => {
  const corsHeaders = {
    ...corsOriginHeaders(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  const supabaseClient = createClient(supabaseUrl, serviceKey)

  const denied = await denyReason(
    req.headers.get('Authorization'),
    supabaseUrl,
    anonKey,
    serviceKey,
    supabaseClient,
  )
  if (denied) {
    return new Response(JSON.stringify({ success: false, error: denied.error }), {
      status: denied.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const { recipientEmail, templateName, variables } = await req.json()

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
      const safe = escapeHtml(allVars[key] || '')
      subject = subject.replace(regex, safe)
      body = body.replace(regex, safe)
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