// ── manage-sessions Edge Function ────────────────────────────────────────────
// Lists and revokes the CALLING USER's own auth sessions.
//
// Body: { action: 'list' }
//       { action: 'revoke', sessionId: '<uuid>' }
//
// ── What changed, and why (audit finding BUG-049) ────────────────────────────
//
// The header comment above documented both actions from the beginning. Only
// `list` existed, and it did not list: it decoded the caller's own JWT and
// returned that one session in an array, so Account Settings → Security always
// showed exactly one device however many were signed in. The live database held
// 7 sessions across 2 users at the time this was fixed. `revoke` answered
// "Unknown action", 400.
//
// Sessions live in `auth.sessions`, which PostgREST does not expose — that is
// why the original settled for the JWT. Both actions now go through SECURITY
// DEFINER functions added in 20260837, which reach that table and scope every
// row to `auth.uid()` inside the database.
//
// The client here is built with the ANON key and the caller's own
// Authorization header, not the service-role key, so `auth.uid()` resolves to
// the caller and the ownership rule applies to this function like it does to
// anyone else. A service-role client would make every session in the
// installation reachable and leave this file's request parsing as the only
// thing standing between a user and someone else's devices.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsOriginHeaders } from '../_shared/cors.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// CORS and json() are per-request closures, not module-level — Deno can
// interleave concurrent requests within one isolate, so a shared mutable
// CORS constant would risk one request's response carrying another's Origin.
serve(async (req: Request) => {
  const CORS = {
    ...corsOriginHeaders(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401)

  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await caller.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  // Which of the listed sessions is this one. Read from the caller's own token
  // rather than guessed from recency — two sessions can be seconds apart, and
  // marking the wrong one "this device" invites revoking the wrong device.
  let currentSessionId: string | null = null
  try {
    const payload = JSON.parse(atob(authHeader.replace('Bearer ', '').split('.')[1]))
    currentSessionId = (payload.session_id as string) ?? null
  } catch { /* a token without session_id still lists; nothing is marked current */ }

  let body: Record<string, string> = {}
  try { body = await req.json() } catch { /* empty body ok */ }

  // ── LIST ─────────────────────────────────────────────────────────────────
  if (body.action === 'list') {
    const { data: rows, error } = await caller.rpc('rma_list_my_sessions')
    if (error) return json({ error: error.message }, 400)

    const sessions = (rows ?? []).map((s: Record<string, unknown>) => ({
      id: s.id,
      created_at: s.created_at,
      updated_at: s.refreshed_at ?? s.created_at,
      not_after: s.not_after,
      factor_id: s.aal === 'aal2' ? 'aal2' : null,
      user_agent: s.user_agent ?? null,
      ip: s.ip ?? null,
      is_current: s.id === currentSessionId,
    }))

    const { data: activityRows } = await caller
      .from('user_activity')
      .select('id, action, created_at, details')
      .eq('user_email', user.email)
      .in('action', ['login', 'logout'])
      .order('created_at', { ascending: false })
      .limit(10)

    return json({ sessions, currentSessionId, activity: activityRows ?? [] })
  }

  // ── REVOKE ───────────────────────────────────────────────────────────────
  if (body.action === 'revoke') {
    const sessionId = body.sessionId ?? ''
    // Checked here only to give a clear error; the function refuses a
    // non-owned id regardless of what shape it is.
    if (!UUID_RE.test(sessionId)) return json({ error: 'A valid sessionId is required' }, 400)

    const { data: revoked, error } = await caller.rpc('rma_revoke_my_session', { p_session_id: sessionId })
    if (error) return json({ error: error.message }, 400)

    // False means the id matched no session of THIS user — either already gone
    // or someone else's. Both answer 404: the caller learns nothing about
    // whether a session it does not own exists.
    if (!revoked) return json({ error: 'Session not found' }, 404)

    return json({ revoked: true, wasCurrent: sessionId === currentSessionId })
  }

  return json({ error: 'Unknown action' }, 400)
})
