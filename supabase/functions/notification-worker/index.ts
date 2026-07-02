// ── notification-worker Edge Function ─────────────────────────────────────
// Drains the notification_queue table — picks up to BATCH_SIZE pending jobs,
// dispatches WhatsApp or Email for each, logs results, handles retries with
// exponential backoff.
//
// Trigger modes:
//   1. Immediately after event handler queues a job (fire-and-forget)
//   2. Manual from Admin → Test Center ("Run Worker")
//   3. pg_cron (Pro plan) every 2 minutes — x-trigger-source: pg_cron header
//
// Required Supabase secrets:
//   WHATSAPP_ACCESS_TOKEN      (for WhatsApp jobs)
//   WHATSAPP_PHONE_NUMBER_ID   (for WhatsApp jobs)
// Optional:
//   WORKER_SECRET              — shared secret for cron/external callers
//   WHATSAPP_API_VERSION
// ─────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsOriginHeaders } from '../_shared/cors.ts'

const BATCH_SIZE        = 10
const RATE_LIMIT_MS     = 200   // min ms between messages within one batch

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
    params?: string[]
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
  const CORS = {
    ...corsOriginHeaders(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-secret, x-trigger-source',
  }
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabaseUrl      = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey          = Deno.env.get('SUPABASE_ANON_KEY')!

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  // ── Auth: worker secret OR valid staff JWT OR pg_cron trigger ─────────────
  // Audit MED-7 (+ a more severe gap found while fixing it): the previous
  // x-trigger-source check was `!req.headers.get('x-trigger-source')` — i.e.
  // "reject only if the header is ABSENT." Any value at all (attacker-chosen,
  // not just 'pg_cron') satisfied it, meaning any unauthenticated caller could
  // drain the queue and burn WhatsApp/email send quota. Tightened to an exact
  // match against what the pg_cron migration (20260604_pgcron_notifications.sql)
  // actually sends, so the real cron job is unaffected. This is still a
  // client-supplied string, not a real secret — closing it fully requires the
  // cron job to also send x-worker-secret (Supabase Vault-backed), which
  // needs to be wired up against the live project and is a follow-up, not
  // done here.
  // The Bearer-token branch previously accepted ANY authenticated user
  // (including 'viewer') — added a role check so only non-viewer staff can
  // trigger the worker, closing MED-7 itself.
  const workerSecret    = Deno.env.get('WORKER_SECRET')
  const providedSecret  = req.headers.get('x-worker-secret')
  const authHeader      = req.headers.get('Authorization') ?? ''
  const triggerSource   = req.headers.get('x-trigger-source')

  if (workerSecret && providedSecret === workerSecret) {
    // cron / external caller with correct secret — allowed
  } else if (authHeader.startsWith('Bearer ')) {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (error || !user) return json({ error: 'Unauthorized' }, 401)

    const { data: roleRow } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_email', user.email)
      .single()
    if (!roleRow || roleRow.role === 'viewer') {
      return json({ error: 'Forbidden: viewers cannot trigger the notification worker' }, 403)
    }
  } else if (triggerSource !== 'pg_cron') {
    return json({ error: 'Unauthorized' }, 401)
  }

  // ── WhatsApp config (only needed for WA jobs; checked per-job below) ─────
  const accessToken   = Deno.env.get('WHATSAPP_ACCESS_TOKEN')
  const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
  const apiVersion    = Deno.env.get('WHATSAPP_API_VERSION') ?? 'v20.0'
  const apiBase       = `https://graph.facebook.com/${apiVersion}`

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
      .eq('status', 'pending')

    if (lockErr) continue  // another worker grabbed it

    try {

      // ── Email job ─────────────────────────────────────────────────────────
      if (job.job_type === 'email') {
        const { to, templateName: emailTemplate, variables = {}, ticketId } = job.payload

        if (!to || !emailTemplate) throw new Error('Email job missing required fields (to, templateName)')

        const res = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${anonKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ recipientEmail: to, templateName: emailTemplate, variables }),
        })

        if (!res.ok) {
          const errBody = await res.text()
          throw new Error(`send-email ${res.status}: ${errBody}`)
        }

        await supabaseAdmin.from('notification_logs').insert({
          ticket_id:       ticketId ?? null,
          event_type:      job.event_type,
          provider:        'email',
          recipient:       to,
          message_content: `Template: ${emailTemplate}`,
          delivery_status: 'sent',
          sent_at:         new Date().toISOString(),
          retry_count:     job.retry_count,
        })

        await supabaseAdmin
          .from('notification_queue')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('id', job.id)

        processed++

      // ── WhatsApp job ──────────────────────────────────────────────────────
      } else {
        if (!accessToken || !phoneNumberId) {
          throw new Error('WhatsApp not configured')
        }

        const { to, templateName: payloadTemplateName, variables = {}, params, attachmentUrl, ticketId, language = 'en', recipientName } = job.payload

        // Use the explicitly-ordered `params` array when present — it is
        // JSONB-safe (arrays keep order). Fall back to Object.values(variables)
        // only for legacy jobs queued before the params field existed.
        const bodyParams: string[] =
          Array.isArray(params) && params.length
            ? params.map((v) => String(v ?? ''))
            : Object.values(variables).map((v) => String(v ?? ''))

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

        if (bodyParams.length > 0) {
          components.push({
            type: 'body',
            parameters: bodyParams.map((v) => ({ type: 'text', text: String(v ?? '') })),
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

        await supabaseAdmin.from('notification_logs').insert({
          ticket_id:            ticketId ?? null,
          event_type:           job.event_type,
          provider:             'whatsapp',
          recipient:            phone,
          recipient_name:       recipientName ?? variables.customer_name ?? null,
          template_id:          job.payload.templateId ?? null,
          message_content:      `Template: ${resolvedTemplateName}`,
          delivery_status:      success ? 'sent' : 'failed',
          whatsapp_message_id:  messageId,
          sent_at:              new Date().toISOString(),
          response_data:        waData,
          error_message:        success ? null : (waData.error?.message ?? 'API error'),
          retry_count:          job.retry_count,
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
