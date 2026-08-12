// Edge Function: public-track
// Public-facing endpoint for the /tracker page. Replaces direct anon DB access.
//
// Handles three actions:
//   - lookup:     find a ticket by RMA number (whitelisted columns only)
//   - comments:   list non-internal comments for a ticket
//   - addComment: post a customer comment
//
// Rate limiting:
//   - In-memory per-IP token bucket (15 reqs / minute per IP).
//   - Survives within a single function instance; cold start resets the bucket.
//     Good enough for casual abuse; harder protection requires a Redis-backed
//     rate limiter (Upstash, etc.) — defer until needed.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsOriginHeaders } from '../_shared/cors.ts'

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
/**
 * Neutralises LIKE metacharacters so the lookup matches one RMA number instead
 * of a pattern.
 *
 * ilike is used for case-insensitivity — customers type "rma-…" — but it also
 * honours % and _, and the input went in raw. That turned the endpoint into an
 * enumeration tool: "RMA-21052026%" returned a real ticket, customer name
 * included, without knowing the number. Since the RMA number is the only secret
 * protecting this data, a date prefix collapsed the guessing space from the full
 * number to a handful of days.
 *
 * Backslash first, or it would double-escape the escapes added after it.
 */
function escapeLikePattern(input: string) {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

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

  const ip = getClientIp(req)
  const rl = checkRateLimit(ip)
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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

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
      const ticketId = (body.ticketId || '').trim()
      if (!ticketId) return json({ error: 'ticketId is required' }, 400)

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

      const payload = {
        ticket_id: c.ticketId,
        comment_text: c.commentText.trim(),
        user_email: c.authorEmail?.trim() || null,
        author_name: c.authorName.trim(),
        is_internal: false,
        is_customer_comment: true,
        parent_comment_id: c.parentCommentId || null,
        attachments: Array.isArray(c.attachments) ? c.attachments : [],
        created_date: new Date().toISOString(),
      }

      let { data, error } = await admin.from('ticket_comments').insert([payload]).select()

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
        const retry = await admin.from('ticket_comments').insert([basic]).select()
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
