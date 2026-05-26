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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ─── Whitelisted column selection ────────────────────────────────────────────
const TICKET_PUBLIC_COLUMNS =
  'id, rma_number, ticket_status, priority, created_date, due_date, general_description, customer_name, products, accessories_received'

// ─── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
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
        .ilike('rma_number', rmaNumber)
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
        .select('*')
        .eq('ticket_id', ticketId)
        .eq('is_internal', false)
        .order('created_date', { ascending: true })

      if (error) {
        // Table may not exist in fresh deployments
        if (error.code === '42P01') return json({ comments: [] }, 200)
        console.error('comments error:', error)
        return json({ error: 'Comments fetch failed' }, 500)
      }
      return json({ comments: data || [] }, 200)
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
