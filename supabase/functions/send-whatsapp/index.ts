// ── send-whatsapp Edge Function ───────────────────────────────────────────
// Sends a WhatsApp message via Meta Cloud API.
// Called by the browser through supabase.functions.invoke().
// The WHATSAPP_ACCESS_TOKEN is a Supabase secret — never exposed to browsers.
//
// Required Supabase secrets:
//   WHATSAPP_ACCESS_TOKEN        — permanent system-user token from Meta
//   WHATSAPP_PHONE_NUMBER_ID     — phone number ID from WhatsApp Business
//
// Optional:
//   WHATSAPP_API_VERSION         — defaults to "v20.0"
// ─────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsOriginHeaders } from '../_shared/cors.ts'
import { currentAccess, canAct } from '../_shared/access.ts'

interface SendRequest {
  to: string
  recipientName?: string
  templateName?: string
  templateId?: string
  variables: Record<string, string>
  attachmentUrl?: string | null
  ticketId?: string | null
  eventType: string
  language?: string
  freeformText?: string | null
}

interface WAMessage { id: string }
interface WAError  { message: string; code: number; error_data?: unknown }
interface WAResponse {
  messages?: WAMessage[]
  error?: WAError
}

serve(async (req: Request) => {
  const CORS = {
    ...corsOriginHeaders(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // ── Auth ────────────────────────────────────────────────────────────────
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401)

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(
    authHeader.replace('Bearer ', '')
  )
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  // Audit MED-7: getUser() only proved the caller is SOMEONE authenticated,
  // not that they're allowed to send WhatsApp messages — a 'viewer' could
  // burn the org's Meta send quota. Gate to non-viewer staff, matching the
  // rma_is_staff() AND role <> 'viewer' idiom used throughout the RLS layer.
  //
  // BUG-021: that check read `role` alone. Suspending someone does not revoke
  // the session they already hold, so a suspended or expired account with a
  // live JWT kept sending on the company's Meta number. currentAccess() applies
  // the same three conditions the database does.
  const access = await currentAccess(supabaseAdmin, user.email)
  if (!canAct(access)) {
    return json({ error: 'Forbidden: your account cannot send WhatsApp messages' }, 403)
  }

  // ── Config ──────────────────────────────────────────────────────────────
  const accessToken   = Deno.env.get('WHATSAPP_ACCESS_TOKEN')
  const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
  const apiVersion    = Deno.env.get('WHATSAPP_API_VERSION') ?? 'v20.0'
  const apiBase       = `https://graph.facebook.com/${apiVersion}`

  if (!accessToken || !phoneNumberId) {
    return json({
      error: 'WhatsApp is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in Supabase secrets.',
      setup_required: true,
    }, 503)
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  let body: SendRequest
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { to, templateName, variables = {}, attachmentUrl, ticketId, eventType, language = 'en', recipientName, freeformText } = body

  if (!to) return json({ error: 'Field "to" (phone number) is required' }, 400)
  const phone = to.replace(/[^0-9]/g, '')
  if (phone.length < 7) return json({ error: 'Invalid phone number' }, 400)

  if (!templateName && !freeformText) {
    return json({ error: 'Either templateName or freeformText is required' }, 400)
  }

  // ── Build WhatsApp payload ────────────────────────────────────────────────
  let waPayload: Record<string, unknown>
  let logContent = ''

  if (templateName) {
    // Template message — required for initiating conversations
    const components: unknown[] = []

    if (Object.keys(variables).length > 0) {
      components.push({
        type: 'body',
        parameters: Object.values(variables).map((v) => ({ type: 'text', text: String(v ?? '') })),
      })
    }

    if (attachmentUrl) {
      components.push({
        type: 'header',
        parameters: [{
          type: 'document',
          document: {
            link: attachmentUrl,
            filename: `RMA-Ticket${ticketId ? `-${ticketId.slice(0, 8)}` : ''}.pdf`,
          },
        }],
      })
    }

    waPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components: components.length ? components : undefined,
      },
    }
    logContent = `Template: ${templateName}`

  } else {
    // Free-form text (only valid within 24-hour customer-service window)
    waPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { body: freeformText!, preview_url: false },
    }
    logContent = freeformText!.slice(0, 500)

    // If there's also an attachment, send document as a separate message
    if (attachmentUrl) {
      const docPayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'document',
        document: {
          link: attachmentUrl,
          caption: `RMA Ticket${variables.ticket_number ? ` ${variables.ticket_number}` : ''}`,
          filename: `RMA-Ticket.pdf`,
        },
      }
      await fetch(`${apiBase}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(docPayload),
      }).catch(() => {/* attachment failure is non-fatal */})
    }
  }

  // ── Call Meta API ─────────────────────────────────────────────────────────
  const waRes  = await fetch(`${apiBase}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(waPayload),
  })
  const waData: WAResponse = await waRes.json()

  const success   = waRes.ok && !!waData.messages?.[0]?.id
  const messageId = waData.messages?.[0]?.id ?? null

  // ── Audit log ─────────────────────────────────────────────────────────────
  await supabaseAdmin.from('notification_logs').insert({
    user_id: user.id,
    ticket_id: ticketId ?? null,
    event_type: eventType ?? 'manual',
    provider: 'whatsapp',
    recipient: phone,
    recipient_name: recipientName ?? variables.customer_name ?? null,
    message_content: logContent,
    delivery_status: success ? 'sent' : 'failed',
    whatsapp_message_id: messageId,
    sent_at: new Date().toISOString(),
    response_data: waData,
    error_message: success ? null : (waData.error?.message ?? 'Unknown error'),
  })

  if (!success) {
    return json({
      success: false,
      error: waData.error?.message ?? 'WhatsApp API error',
      code: waData.error?.code,
      details: waData,
    }, 502)
  }

  return json({ success: true, message_id: messageId })
})
