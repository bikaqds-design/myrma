// Edge Function: public-track
// Public-facing endpoint for the /tracker page. Replaces direct anon DB access.
//
// Handles three actions:
//   - lookup:     find a ticket by RMA number (whitelisted columns only)
//   - comments:   list non-internal comments for a ticket
//   - addComment: post a customer comment
//
// The RMA number is the only secret protecting a ticket, so all three actions
// require it. `comments` and `addComment` used to accept a bare ticket id — ids
// appear in staff links (`?ticket=<id>`) — which let anyone read a ticket's
// public thread or post to it without knowing the number. (BUG-023.)
//
// Rate limiting (15 requests / minute per caller):
//   - The count lives in the database, so it survives a cold start and is
//     shared by every instance. This is the limit that actually holds.
//   - An in-memory bucket still runs in front of it, purely to avoid a database
//     round trip on an obvious flood.
//   - The browser also locks itself after 10 failed lookups. That one is a
//     courtesy — clearing site data resets it — and was the only limit that
//     really worked until 2026-09-13. (BUG-067.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { corsOriginHeaders } from '../_shared/cors.ts'
import { provenTicketId, escapeLikePattern } from '../_shared/trackerProof.ts'

// ─── Rate limiter (per-instance, in-memory) ──────────────────────────────────
const RATE_LIMIT_PER_MINUTE = 15
const buckets = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string): { ok: boolean; resetIn?: number } {
  const now = Date.now()
  const bucket = buckets.get(ip)
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + 60_000 })
    return { ok: true }
  }
  if (bucket.count >= RATE_LIMIT_PER_MINUTE) {
    return { ok: false, resetIn: Math.ceil((bucket.resetAt - now) / 1000) }
  }
  bucket.count += 1
  return { ok: true }
}

/**
 * The database key for a caller: a SHA-256 of the address and a secret salt.
 *
 * The salt is what makes this non-reversible. A bare hash of an IP address is
 * theatre — the whole IPv4 space is four billion digests, which is minutes of
 * work — so without a secret the table would be a list of who looked up what.
 * With one it can only say "this same unknown caller again", which is all a
 * rate limiter needs to know. The tracker is public and its users are customers
 * who never agreed to anything, so that distinction is the point.
 *
 * RATE_LIMIT_SALT if set; otherwise the service role key, which is a secret
 * this function already holds. Rotating either rotates the keys, which costs
 * one window of counting and nothing else.
 */
async function rateLimitKey(ip: string): Promise<string> {
  const salt = Deno.env.get('RATE_LIMIT_SALT') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const bytes = new TextEncoder().encode(`${salt}:${ip}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * The limit that holds across instances.
 *
 * Fails OPEN. If the database cannot be reached the public tracker keeps
 * working on the in-memory bucket alone, which is where it stood before this
 * existed. Failing closed would mean a database hiccup returns 429 to every
 * customer checking a repair — turning a degraded dependency into an outage of
 * the one page that exists to save them a phone call.
 */
async function checkRateLimitDurable(
  admin: ReturnType<typeof createClient>,
  ip: string
): Promise<{ ok: boolean; resetIn?: number }> {
  try {
    const { data, error } = await admin.rpc('rma_public_track_hit', {
      p_ip_hash: await rateLimitKey(ip),
      p_limit: RATE_LIMIT_PER_MINUTE,
      p_window_seconds: 60,
    })
    if (error) {
      console.error('public-track: rate limit unavailable, allowing', error.message)
      return { ok: true }
    }
    const row = Array.isArray(data) ? data[0] : data
    if (row && row.allowed === false) {
      return { ok: false, resetIn: row.reset_in ?? 60 }
    }
    return { ok: true }
  } catch (err) {
    console.error('public-track: rate limit threw, allowing', err)
    return { ok: true }
  }
}

function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

// ─── Whitelisted column selection ────────────────────────────────────────────
const TICKET_PUBLIC_COLUMNS =
  'id, rma_number, ticket_status, priority, created_date, due_date, general_description, customer_name, products, accessories_received'

// The comments query used select('*'), which returned every column of every
// non-internal comment to an unauthenticated caller — including user_email, the
// staff address that posted it. 14 public comments in the live data carry one.
// The drawer's "Internal (staff only)" toggle defaults to off, so an ordinary
// staff reply is public by default and leaked the responder's address to anyone
// who looked up that RMA number.
//
// Everything the tracker actually renders is kept: author_name is the display
// name it shows, parent_comment_id drives its reply threading (and doubles as
// its schema probe), attachments and is_customer_comment drive the file list
// and the team/customer styling. What goes is user_email, plus is_internal
// (redundant — the query already filters on it) and updated_date (unused).
const COMMENT_PUBLIC_COLUMNS =
  'id, ticket_id, created_date, comment_text, author_name, is_customer_comment, attachments, parent_comment_id'

/** Id of the ticket with this RMA number (case-insensitive, literal), or null. */
function ticketIdLookup(admin: ReturnType<typeof createClient>) {
  return async (rmaNumber: string): Promise<string | null> => {
    const { data, error } = await admin
      .from('rma_tickets')
      .select('id')
      .ilike('rma_number', escapeLikePattern(rmaNumber))
      .maybeSingle()
    if (error || !data) return null
    return data.id as string
  }
}

/**
 * Dropping user_email from the select is not enough on its own: the ticket
 * drawer stores the staff member's email address *as* author_name
 * (TicketDrawer passes `authorName: userEmail`), and the tracker renders
 * author_name as the visible author. So a customer tracking their repair saw
 * "bika.qds@gmail.com" above every reply.
 *
 * Masking here rather than only in the drawer is deliberate. A client-side fix
 * would protect comments written from now on and leave the ones already in the
 * table exposed — 14 of them at the time of writing. Doing it at the boundary
 * covers the history too, and keeps the rule where it belongs: this function is
 * the only thing standing between an unauthenticated caller and the table.
 *
 * The customer's own name is left alone — it is theirs, they typed it, and the
 * thread is unreadable without it. Only the team side is collapsed to the label
 * the UI already shows beside those replies.
 */

function maskStaffIdentity(c: Record<string, unknown>) {
  if (c?.is_customer_comment) return c
  return { ...c, author_name: 'Support Team' }
}

// ─── Handler ─────────────────────────────────────────────────────────────────
// corsHeaders and json() are defined per-request (not module-level) — Deno's
// request runtime can interleave concurrent requests within one isolate, so a
// shared mutable corsHeaders would risk one request's response carrying
// another request's Origin. A closure captured fresh per invocation avoids
// that race while keeping every json(...) call site below unchanged.
/**
 * Whitelist a customer-supplied attachment list. (Audit finding BUG-023.)
 *
 * `attachments` was stored as whatever JSON arrived: `Array.isArray(c.attachments)
 * ? c.attachments : []`. Staff then render each entry as `<a href={att.url}>`
 * with the attacker's own `name` as the link text (TicketDrawer.jsx:989), so an
 * anonymous poster could put `javascript:` or a lookalike host behind text
 * reading "invoice.pdf" — inside the staff interface, on a ticket staff trust.
 *
 * Only the five fields the UI actually reads survive, and `url` must sit on
 * this project's own storage origin. Anything else is dropped rather than
 * rejected, so a malformed entry cannot block a genuine comment.
 */
function sanitiseAttachments(input: unknown, storageOrigin: string): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return []
  const out: Array<Record<string, unknown>> = []

  for (const raw of input.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>

    const url = typeof a.url === 'string' ? a.url : ''
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue // not a URL at all — and this is what rejects `javascript:alert(1)`
    }
    // Origin check, not a substring test: "https://evil.com/?x=<project>.supabase.co"
    // contains the expected text but is not the expected host.
    if (parsed.origin !== storageOrigin) continue
    if (parsed.protocol !== 'https:') continue

    out.push({
      name: typeof a.name === 'string' ? a.name.slice(0, 200) : 'attachment',
      url: parsed.toString(),
      path: typeof a.path === 'string' ? a.path.slice(0, 400) : null,
      size: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : null,
      type: typeof a.type === 'string' ? a.type.slice(0, 100) : null,
    })
  }
  return out
}

/** A plausible email, or null. Stored as-is before, unchecked (BUG-023). */
function sanitiseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().slice(0, 320)
  if (!v) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null
}


Deno.serve(async (req) => {
  const corsHeaders = {
    ...corsOriginHeaders(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Two gates, cheapest first. The in-memory one turns a flood that happens to
  // hit a warm instance away without a database round trip; the durable one is
  // what a caller cannot escape by waiting for a cold start.
  const ip = getClientIp(req)
  const memoryRl = checkRateLimit(ip)
  if (!memoryRl.ok) {
    return json({ error: 'Too many requests', resetIn: memoryRl.resetIn }, 429)
  }
  const rl = await checkRateLimitDurable(admin, ip)
  if (!rl.ok) {
    return json({ error: 'Too many requests', resetIn: rl.resetIn }, 429)
  }

  // Parse body
  let body: { action?: string; rmaNumber?: string; ticketId?: string; comment?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  switch (body.action) {
    case 'lookup': {
      const rmaNumber = (body.rmaNumber || '').trim()
      if (!rmaNumber) return json({ error: 'rmaNumber is required' }, 400)
      if (rmaNumber.length > 64) return json({ error: 'rmaNumber too long' }, 400)

      const { data, error } = await admin
        .from('rma_tickets')
        .select(TICKET_PUBLIC_COLUMNS)
        .ilike('rma_number', escapeLikePattern(rmaNumber))
        .maybeSingle()

      if (error) {
        console.error('lookup error:', error)
        return json({ error: 'Lookup failed' }, 500)
      }
      if (!data) return json({ ticket: null }, 200)
      return json({ ticket: data }, 200)
    }

    case 'comments': {
      if (!body.ticketId || !body.rmaNumber) return json({ error: 'ticketId and rmaNumber are required' }, 400)
      const ticketId = await provenTicketId(ticketIdLookup(admin), body.rmaNumber, body.ticketId)
      if (!ticketId) return json({ error: 'Ticket not found' }, 404)

      const { data, error } = await admin
        .from('ticket_comments')
        .select(COMMENT_PUBLIC_COLUMNS)
        .eq('ticket_id', ticketId)
        .eq('is_internal', false)
        .order('created_date', { ascending: true })

      if (error) {
        // Table may not exist in fresh deployments
        if (error.code === '42P01') return json({ comments: [] }, 200)
        console.error('comments error:', error)
        return json({ error: 'Comments fetch failed' }, 500)
      }
      return json({ comments: (data || []).map(maskStaffIdentity) }, 200)
    }

    case 'addComment': {
      const c = body.comment as {
        ticketId?: string
        rmaNumber?: string
        authorName?: string
        authorEmail?: string | null
        commentText?: string
        parentCommentId?: string | null
        attachments?: unknown[]
      }
      if (!c?.ticketId || !c?.commentText?.trim() || !c?.authorName?.trim()) {
        return json({ error: 'ticketId, authorName, commentText are required' }, 400)
      }
      if (c.commentText.length > 5000) return json({ error: 'comment too long (max 5000 chars)' }, 400)
      if (c.authorName.length > 120) return json({ error: 'authorName too long' }, 400)
      if (!c.rmaNumber) return json({ error: 'rmaNumber is required' }, 400)

      // Knowing a ticket's id is not enough to post to it: the caller must also
      // hold its RMA number (BUG-023).
      const provenId = await provenTicketId(ticketIdLookup(admin), c.rmaNumber, c.ticketId)
      if (!provenId) return json({ error: 'Ticket not found' }, 404)

      // A reply must belong to the same ticket. `parent_comment_id` was passed
      // straight through, so a comment on ticket A could be threaded under a
      // comment on ticket B (BUG-023).
      let parentId: string | null = null
      if (c.parentCommentId) {
        const { data: parent } = await admin
          .from('ticket_comments')
          .select('id, ticket_id')
          .eq('id', c.parentCommentId)
          .maybeSingle()
        if (!parent || parent.ticket_id !== provenId) {
          return json({ error: 'parentCommentId does not belong to this ticket' }, 400)
        }
        parentId = parent.id as string
      }

      const storageOrigin = new URL(supabaseUrl).origin

      const payload = {
        ticket_id: provenId,
        comment_text: c.commentText.trim(),
        user_email: sanitiseEmail(c.authorEmail),
        author_name: c.authorName.trim(),
        is_internal: false,
        is_customer_comment: true,
        parent_comment_id: parentId,
        attachments: sanitiseAttachments(c.attachments, storageOrigin),
        created_date: new Date().toISOString(),
      }

      let { data, error } = await admin.from('ticket_comments').insert([payload]).select(COMMENT_PUBLIC_COLUMNS)

      // Schema fallback: drop the new columns if they don't exist yet
      if (error && (error.code === '42703' || error.message?.includes('column'))) {
        const basic = {
          ticket_id: payload.ticket_id,
          comment_text: payload.comment_text,
          user_email: payload.user_email,
          author_name: payload.author_name,
          is_internal: false,
          created_date: payload.created_date,
        }
        const retry = await admin.from('ticket_comments').insert([basic]).select('id, ticket_id, created_date, comment_text, author_name')
        if (retry.error) {
          console.error('addComment error:', retry.error)
          return json({ error: 'Add comment failed' }, 500)
        }
        return json({ comment: retry.data?.[0] }, 200)
      }

      if (error) {
        console.error('addComment error:', error)
        return json({ error: 'Add comment failed' }, 500)
      }
      return json({ comment: data?.[0] }, 200)
    }

    default:
      return json({ error: `Unknown action: ${body.action}` }, 400)
  }
})
