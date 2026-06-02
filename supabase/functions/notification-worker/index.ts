// ── notification-worker Edge Function ─────────────────────────────────────
// Drains the notification_queue table — picks up to BATCH_SIZE pending jobs,
// calls WhatsApp API for each, logs results, handles retries with exponential
// backoff.
//
// Trigger modes:
//   1. Immediately after event handler queues a job (best-effort, fire-and-forget)
//   2. Manual from Admin → Test Center ("Run Worker")
//   3. pg_cron (Pro plan) — recommended for production:
//      SELECT cron.schedule('notification-worker', '*/2 * * * *',
//        $$SELECT net.http_post(
//            url := 'https://<project>.supabase.co/functions/v1/notification-worker',
//            headers := '{"x-worker-secret":"<WORKER_SECRET>"}'::jsonb
//          )$$);
//
// Required Supabase secrets:
//   WHATSAPP_ACCESS_TOKEN
//   WHATSAPP_PHONE_NUMBER_ID
// Optional:
//   WORKER_SECRET    — shared secret for cron/external callers
//   WHATSAPP_API_VERSION
// ─────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-secret, x-trigger-source',
}
const BATCH_SIZE        = 10
const RATE_LIMIT_MS     = 200   // min ms between messages within one batch
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

interface QueueJob {
  id: string
  job_type: string
  event_type: string
  payload: {
    to: string
    recipientName?: string
    templateId?: string
    templateName?: string
    variables?: Record<string, string>
    attachmentUrl?: string | null
    ticketId?: string | null
    language?: string
  }
  retry_count: number
  max_retries: number
}

interface WAResponse {
  messages?: Array<{ id: string }>
  error?: { message: string; code: number }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // ── Auth: worker secret OR valid JWT ─────────────────────────────────────
  const workerSecret = Deno.env.get('WORKER_SECRET')
  const providedSecret = req.headers.get('x-worker-secret')
  const authHeader = req.headers.get('Authorization') ?? ''

  if (workerSecret && providedSecret === workerSecret) {
    // cron / external caller with correct secret — allowed
  } else if (authHeader.startsWith('Bearer ')) {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (error || !user) return json({ error: 'Unauthorized' }, 401)
  } else if (!req.headers.get('x-trigger-source')) {
    // Allow internal trigger from event handler (no auth header required)
    return json({ error: 'Unauthorized' }, 401)
  }

  // ── Config ───────────────────────────────────────────────────────────────
  const accessToken   = Deno.env.get('WHATSAPP_ACCESS_TOKEN')
  const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
  const apiVersion    = Deno.env.get('WHATSAPP_API_VERSION') ?? 'v20.0'
  const apiBase       = `https://graph.facebook.com/${apiVersion}`

  if (!accessToken || !phoneNumberId) {
    return json({ processed: 0, skipped: 0, error: 'WhatsApp not configured' })
  }

  // ── Fetch pending jobs ────────────────────────────────────────────────────
  const now = new Date().toISOString()
  const { data: jobs, error: fetchErr } = await supabaseAdmin
    .from('notification_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (fetchErr || !jobs?.length) {
    return json({ processed: 0, skipped: 0, message: 'No pending jobs' })
  }

  let processed = 0
  let failed = 0

  for (const job of jobs as QueueJob[]) {
    // Mark processing — prevents double-processing in concurrent invocations
    const { error: lockErr } = await supabaseAdmin
      .from('notification_queue')
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'pending')   // guard: only update if still pending

    if (lockErr) continue  // another worker grabbed it

    try {
      const { to, templateName: payloadTemplateName, variables = {}, attachmentUrl, ticketId, language = 'en', recipientName } = job.payload

      // Resolve template name if only templateId provided
      let resolvedTemplateName = payloadTemplateName
      if (!resolvedTemplateName && job.payload.templateId) {
        const { data: tmpl } = await supabaseAdmin
          .from('whatsapp_templates')
          .select('template_name')
          .eq('id', job.payload.templateId)
          .single()
        resolvedTemplateName = tmpl?.template_name
      }

      if (!resolvedTemplateName) throw new Error('No template_name resolved for job')

      const phone = to.replace(/[^0-9]/g, '')
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
          parameters: [{ type: 'document', document: { link: attachmentUrl, filename: 'RMA-Ticket.pdf' } }],
        })
      }

      const waPayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'template',
        template: {
          name: resolvedTemplateName,
          language: { code: language },
          components: components.length ? components : undefined,
        },
      }

      const waRes  = await fetch(`${apiBase}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(waPayload),
      })
      const waData: WAResponse = await waRes.json()

      const success   = waRes.ok && !!waData.messages?.[0]?.id
      const messageId = waData.messages?.[0]?.id ?? null

      // Log
      await supabaseAdmin.from('notification_logs').insert({
        ticket_id: ticketId ?? null,
        event_type: job.event_type,
        provider: 'whatsapp',
        recipient: phone,
        recipient_name: recipientName ?? variables.customer_name ?? null,
        template_id: job.payload.templateId ?? null,
        message_content: `Template: ${resolvedTemplateName}`,
        delivery_status: success ? 'sent' : 'failed',
        whatsapp_message_id: messageId,
        sent_at: new Date().toISOString(),
        response_data: waData,
        error_message: success ? null : (waData.error?.message ?? 'API error'),
        retry_count: job.retry_count,
      })

      if (success) {
        await supabaseAdmin
          .from('notification_queue')
          .update({ status: 'completed', completed_at: new Date().toISOString(), result: { message_id: messageId } })
          .eq('id', job.id)
        processed++
      } else {
        throw new Error(waData.error?.message ?? 'WhatsApp API returned error')
      }

    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      const newRetry = job.retry_count + 1

      if (newRetry >= job.max_retries) {
        await supabaseAdmin
          .from('notification_queue')
          .update({ status: 'failed', error_message: msg, retry_count: newRetry })
          .eq('id', job.id)
      } else {
        // Exponential backoff: 5m → 10m → 20m
        const delayMs = 300_000 * Math.pow(2, newRetry - 1)
        const scheduledAt = new Date(Date.now() + delayMs).toISOString()
        await supabaseAdmin
          .from('notification_queue')
          .update({ status: 'pending', error_message: msg, retry_count: newRetry, scheduled_at: scheduledAt })
          .eq('id', job.id)
      }
    }

    // Rate limiting
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS))
  }

  return json({ processed, failed, total: (jobs as QueueJob[]).length })
})
