// ── manage-sessions Edge Function ────────────────────────────────────────────
// Lists and revokes auth sessions for the calling user.
// Uses GoTrue admin API with service role key — user can only manage their own sessions.
//
// Body: { action: 'list' }
//       { action: 'revoke', sessionId: '<uuid>' }
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsOriginHeaders } from '../_shared/cors.ts'

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

  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Validate caller JWT
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401)

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(
    authHeader.replace('Bearer ', '')
  )
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  // Decode current session from the caller's JWT (no admin API needed)
  const token = authHeader.replace('Bearer ', '')
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(atob(token.split('.')[1]))
  } catch { return json({ error: 'Failed to decode token' }, 400) }

  let body: Record<string, string> = {}
  try { body = await req.json() } catch { /* empty body ok */ }

  // ── LIST ─────────────────────────────────────────────────────────────────
  if (body.action === 'list') {
    // Return current session decoded from JWT + recent login history from user_activity
    const currentSession = {
      id: payload.session_id as string,
      created_at: new Date((payload.iat as number) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
      not_after: new Date((payload.exp as number) * 1000).toISOString(),
      factor_id: payload.aal === 'aal2' ? 'aal2' : null,
      is_current: true,
    }

    // Fetch recent login events to show session history
    const { data: activityRows } = await supabaseAdmin
      .from('user_activity')
      .select('id, action, created_at, details')
      .eq('user_email', user.email)
      .in('action', ['login', 'logout'])
      .order('created_at', { ascending: false })
      .limit(10)

    return json({ sessions: [currentSession], currentSessionId: payload.session_id, activity: activityRows ?? [] })
  }

  return json({ error: 'Unknown action' }, 400)
})
