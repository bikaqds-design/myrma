// ── whatsapp-webhook Edge Function ────────────────────────────────────────
// Receives incoming events from Meta's WhatsApp Cloud API webhook.
//
// Two event types handled:
//   1. Delivery status updates (sent → delivered → read → failed)
//   2. Incoming customer messages (logged for future CRM use)
//
// Setup in Meta App Dashboard:
//   Webhook URL : https://<project>.supabase.co/functions/v1/whatsapp-webhook
//   Verify Token: value of WHATSAPP_WEBHOOK_VERIFY_TOKEN secret
//   Subscribe to: messages
//
// Required Supabase secret:
//   WHATSAPP_WEBHOOK_VERIFY_TOKEN  — any random string you choose
// ─────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsOriginHeaders } from '../_shared/cors.ts'

interface WAStatus {
  id: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: string
  recipient_id: string
  errors?: Array<{ code: number; title: string; message: string }>
}

interface WAIncomingMessage {
  from: string
  id: string
  timestamp: string
  type: string
  text?: { body: string }
}

interface WAWebhookPayload {
  object: string
  entry: Array<{
    id: string
    changes: Array<{
      field: string
      value: {
        messaging_product: string
        metadata: { display_phone_number: string; phone_number_id: string }
        statuses?: WAStatus[]
        messages?: WAIncomingMessage[]
      }
    }>
  }>
}

serve(async (req: Request) => {
  // Note: this endpoint is called server-to-server by Meta, not from a
  // browser — CORS headers have no real effect here since Meta's HTTP client
  // doesn't enforce them (CORS is a browser mechanism). The actual security
  // boundary is WHATSAPP_WEBHOOK_VERIFY_TOKEN below. Applied for consistency
  // with the other functions, not as a meaningful security fix on its own.
  const CORS = {
    ...corsOriginHeaders(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const verifyToken = Deno.env.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN') ?? ''

  // ── Meta webhook verification (GET) ──────────────────────────────────────
  if (req.method === 'GET') {
    const url       = new URL(req.url)
    const mode      = url.searchParams.get('hub.mode')
    const token     = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')

    if (mode === 'subscribe' && token === verifyToken && challenge) {
      return new Response(challenge, { status: 200 })
    }
    return new Response('Forbidden', { status: 403 })
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  let payload: WAWebhookPayload
  try {
    payload = await req.json()
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  if (payload.object !== 'whatsapp_business_account') {
    // Not a WhatsApp event — return 200 so Meta doesn't retry
    return new Response(JSON.stringify({ received: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue
      const { statuses = [], messages = [] } = change.value

      // ── Delivery status updates ─────────────────────────────────────────
      for (const status of statuses) {
        const updates: Record<string, unknown> = {
          delivery_status: status.status,
          response_data: status,
        }
        const ts = new Date(parseInt(status.timestamp, 10) * 1000).toISOString()
        if (status.status === 'delivered') updates.delivered_at = ts
        if (status.status === 'read')      updates.read_at = ts
        if (status.status === 'failed' && status.errors?.[0]) {
          updates.error_message = `${status.errors[0].code}: ${status.errors[0].title} — ${status.errors[0].message}`
        }

        await supabaseAdmin
          .from('notification_logs')
          .update(updates)
          .eq('whatsapp_message_id', status.id)
          .catch(() => {/* non-fatal */})
      }

      // ── Incoming messages (log for future CRM use) ──────────────────────
      for (const msg of messages) {
        if (msg.type !== 'text') continue
        await supabaseAdmin.from('notification_logs').insert({
          event_type: 'customer.reply',
          provider: 'whatsapp',
          recipient: msg.from,  // the customer's number who sent the reply
          message_content: msg.text?.body ?? '',
          delivery_status: 'delivered',
          whatsapp_message_id: msg.id,
          sent_at: new Date(parseInt(msg.timestamp, 10) * 1000).toISOString(),
          response_data: msg,
        }).catch(() => {/* non-fatal */})
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
