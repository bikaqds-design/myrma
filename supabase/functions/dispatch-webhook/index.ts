// Edge Function: dispatch-webhook
//
// Delivers outbound webhooks server-side. (Audit finding BUG-009.)
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// Dispatch used to run in the browser: `webhooks.dispatch()` in
// src/api/db/system.ts read every webhook row — signing secret included — and
// called `fetch(h.url)` from the page. Two things were wrong with that, and the
// first one meant the feature had never worked at all:
//
//   1. The Content-Security-Policy served by Vercel allows connections only to
//      Supabase and Sentry:
//
//        connect-src 'self' https://*.supabase.co wss://*.supabase.co
//                    https://*.sentry.io https://*.ingest.sentry.io
//
//      Every webhook URL is therefore blocked before the request leaves the
//      page, and `dispatch` swallowed the resulting error. `SELECT
//      count(last_triggered_at) FROM webhooks` was 0: nothing had ever been
//      delivered in production.
//
//   2. Signing secrets were read into every administrator's browser, which is
//      the one place they must never be. That half is closed in the database by
//      migration 20260825; this function is the only thing that can read
//      `secret_key` now, via the service role.
//
// Calling a Supabase Function is allowed by that same CSP, which is why this
// shape works where the direct fetch could not. Delivery also completes
// server-side: once the browser has made the call, closing the tab no longer
// aborts the outbound request.
//
// ── One signature scheme ─────────────────────────────────────────────────────
//
// There were three, which meant no receiver could verify all of them: dispatch
// sent an HMAC as `X-Signature-256`, the Control Panel's Test button sent the
// secret in plaintext as `X-Webhook-Secret`, and the (now deleted) second
// webhooks screen used `X-myRMA-Secret`. Only the HMAC survives. A plaintext
// secret in a header is not a signature — it proves nothing about the body, and
// it hands the secret to anyone who can see the request.
//
//   X-Signature-256: sha256=<hex HMAC-SHA256 of the exact request body>
//
// Verify by recomputing over the raw body before parsing it.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { corsOriginHeaders } from '../_shared/cors.ts'
import { currentAccess, canAct } from '../_shared/access.ts'

const DELIVERY_TIMEOUT_MS = 10_000
const MAX_WEBHOOKS_PER_EVENT = 20

interface DeliveryResult {
  id: string
  name: string
  ok: boolean
  status: number | null
  error: string | null
}

/**
 * Refuse URLs that point back inside our own infrastructure.
 *
 * Webhook URLs are administrator-supplied, and this function will POST to
 * whatever they name using the service role's network position — so without a
 * check it is a server-side request forgery primitive: an admin (or anyone who
 * compromises one admin account) could aim it at a cloud metadata endpoint or
 * an internal host and read the response status back through this API.
 *
 * This blocks the obvious cases by hostname. It cannot defeat DNS rebinding —
 * a name that resolves to a private address only when fetched — which would
 * need resolution-time checking that Deno's fetch does not expose. Recorded as
 * a known limit rather than implied to be complete.
 */
function urlProblem(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'not a valid URL'
  }
  if (u.protocol !== 'https:') return 'must use https'

  const host = u.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return 'points at a local host'
  }
  // IPv4 literals in private / loopback / link-local ranges. 169.254.169.254 is
  // the cloud metadata address and is covered by the link-local rule.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    ) {
      return 'points at a private address'
    }
  }
  return null
}

/** HMAC-SHA256 of `body` under `secret`, hex encoded. */
async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

Deno.serve(async (req: Request) => {
  const cors = corsOriginHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        ...cors,
        // supabase-js always sends x-client-info and apikey; omitting them here
        // makes the browser fail the preflight and the call never leaves the
        // page — which is how the first version of this function broke the
        // Test button. Same list every other function in this project uses.
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    })
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(supabaseUrl, serviceKey)

  // ── Who is calling ────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Unauthorized' }, 401)

  const { data: userData } = await admin.auth.getUser(token)
  const email = userData?.user?.email
  if (!email) return json({ error: 'Unauthorized' }, 401)

  const access = await currentAccess(admin, email)
  if (!canAct(access)) return json({ error: 'Forbidden' }, 403)

  let body: { event?: string; payload?: unknown; webhookId?: string; test?: boolean }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  // ── Which webhooks ────────────────────────────────────────────────────────
  // Two callers: the app firing a real event, and the Control Panel testing one
  // hook. Testing reaches a URL of the caller's choosing, so it is limited to
  // administrators — the role the Integrations screen is gated to anyway.
  const isTest = body.test === true
  if (isTest && !['admin', 'super_admin'].includes(access!.role)) {
    return json({ error: 'Only an administrator may send a test delivery' }, 403)
  }
  if (!isTest && !body.event) return json({ error: 'event is required' }, 400)
  if (isTest && !body.webhookId) return json({ error: 'webhookId is required for a test' }, 400)

  let query = admin
    .from('webhooks')
    .select('id, name, url, events, is_active, secret_key')
    .eq('is_active', true)
    .limit(MAX_WEBHOOKS_PER_EVENT)

  if (isTest) query = query.eq('id', body.webhookId)

  const { data: rows, error: readErr } = await query
  if (readErr) {
    console.error('dispatch-webhook: failed to read webhooks', readErr.message)
    return json({ error: 'Could not read webhook configuration' }, 500)
  }

  // `events` empty or null means "every event", matching the previous behaviour.
  const targets = (rows ?? []).filter((h) => {
    if (isTest) return true
    const list: unknown = h.events
    if (!Array.isArray(list) || list.length === 0) return true
    return list.includes(body.event)
  })

  if (targets.length === 0) return json({ delivered: 0, results: [] })

  // ── Deliver ───────────────────────────────────────────────────────────────
  const requestBody = JSON.stringify({
    event: isTest ? 'webhook.test' : body.event,
    timestamp: new Date().toISOString(),
    data: isTest ? { message: 'Test delivery from the myCRM Control Panel' } : (body.payload ?? null),
  })

  const results: DeliveryResult[] = await Promise.all(
    targets.map(async (h): Promise<DeliveryResult> => {
      const base = { id: h.id as string, name: h.name as string }

      const problem = urlProblem(h.url as string)
      if (problem) return { ...base, ok: false, status: null, error: `Refused: the URL ${problem}` }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'myCRM-webhooks/1',
      }
      if (h.secret_key) {
        headers['X-Signature-256'] = `sha256=${await sign(h.secret_key as string, requestBody)}`
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
      try {
        const res = await fetch(h.url as string, {
          method: 'POST',
          headers,
          body: requestBody,
          signal: controller.signal,
          redirect: 'manual', // a redirect could land somewhere the URL check cleared
        })
        return { ...base, ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` }
      } catch (e) {
        const msg = e instanceof Error && e.name === 'AbortError'
          ? `No response within ${DELIVERY_TIMEOUT_MS / 1000}s`
          : 'Could not reach the endpoint'
        return { ...base, ok: false, status: null, error: msg }
      } finally {
        clearTimeout(timer)
      }
    }),
  )

  const deliveredIds = results.filter((r) => r.ok).map((r) => r.id)
  if (deliveredIds.length) {
    await admin
      .from('webhooks')
      .update({ last_triggered_at: new Date().toISOString() })
      .in('id', deliveredIds)
  }

  // Nothing secret is returned: ids, names, status codes and a reason. The
  // Control Panel needs the reason to be useful, and none of it reveals the key.
  return json({ delivered: deliveredIds.length, results })
})
