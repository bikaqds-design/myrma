// ── notification-worker Edge Function ─────────────────────────────────────
// Drains the notification_queue table — picks up to BATCH_SIZE pending jobs,
// dispatches WhatsApp or Email for each, logs results, handles retries with
// exponential backoff.
//
// Trigger modes:
//   1. Immediately after event handler queues a job (fire-and-forget)
//   2. Manual from Admin → Test Center ("Run Worker")
//   3. pg_cron every 2 minutes — must present x-worker-secret (see BUG-022)
//
// Required Supabase secrets:
//   WHATSAPP_ACCESS_TOKEN      (for WhatsApp jobs)
//   WHATSAPP_PHONE_NUMBER_ID   (for WhatsApp jobs)
// Optional:
//   WORKER_SECRET              — shared secret for cron/external callers
//   WHATSAPP_API_VERSION
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { corsOriginHeaders } from '../_shared/cors.ts'
import { currentAccess, canAct } from '../_shared/access.ts'

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

Deno.serve(async (req: Request) => {
  const CORS = {
    ...corsOriginHeaders(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-secret, x-trigger-source',
  }
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabaseUrl      = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  // ── Auth: worker secret, or a current non-viewer staff JWT ────────────────
  //
  // BUG-022. There used to be a third way in: a caller with no Authorization
  // header at all was admitted if they sent `x-trigger-source: pg_cron`. A
  // header any client can type is not a credential, and the comment that used
  // to sit here said as much while leaving it in place.
  //
  // It was reachable, not theoretical. The Functions gateway accepts the JWT in
  // EITHER `Authorization` or `apikey`, and the anon key ships in the browser
  // bundle, so:
  //
  //   apikey: <anon key>            satisfies the gateway
  //   (no Authorization header)     skips the Bearer branch below
  //   x-trigger-source: pg_cron     satisfied the old third branch
  //
  // — and the queue drained, spending WhatsApp and Resend quota, for anyone who
  // had read the bundle. Removing the branch is the whole fix: every caller now
  // has to prove something.
  //
  // Deliberately not tested against the live project: the only way to confirm
  // it end to end is to let it actually drain, which would send real messages
  // from the 341-job backlog.
  //
  // The real cron job is unaffected by the removal, because it is not working
  // today either — it sends no Authorization header and every run has been
  // rejected by the gateway with 401 since June (BUG-005). Re-enabling it means
  // giving it x-worker-secret; see
  // supabase/manual/20260854_wire_cron_worker_secret.sql, which must not be run
  // until that backlog has been dealt with.
  //
  // x-trigger-source survives as a LABEL — it records which entry point woke
  // the worker, which is worth having in the logs — and grants nothing.
  const workerSecret    = Deno.env.get('WORKER_SECRET')
  const providedSecret  = req.headers.get('x-worker-secret')
  const authHeader      = req.headers.get('Authorization') ?? ''
  const triggerSource   = req.headers.get('x-trigger-source') ?? 'unknown'

  if (workerSecret && providedSecret === workerSecret) {
    // A machine caller holding the shared secret: cron, or an external
    // scheduler. This requires WORKER_SECRET to be SET — with it unset the
    // branch can never match and a cron job presenting only a header is
    // refused, which is the right direction to fail.
  } else if (authHeader.startsWith('Bearer ')) {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (error || !user) return json({ error: 'Unauthorized' }, 401)

    // BUG-021: this read `role` alone, so a suspended or expired account with a
    // still-valid JWT could keep draining the queue and spending send quota.
    const access = await currentAccess(supabaseAdmin, user.email)
    if (!canAct(access)) {
      return json({ error: 'Forbidden: your account cannot trigger the notification worker' }, 403)
    }
  } else {
    // One message for both "no credential" and "wrong secret": telling an
    // anonymous caller which of the two they got wrong is free reconnaissance.
    return json({ error: 'Unauthorized' }, 401)
  }

  console.log(`[notification-worker] triggered by ${triggerSource}`)

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
            // The service role key, not the anon key: send-email now identifies
            // its caller, and the anon key is public.
            'Authorization': `Bearer ${serviceRoleKey}`,
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

  return json({ processed, failed, total: (jobs as QueueJob[]).length, source: triggerSource })
})
