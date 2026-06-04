// ── manage-sessions Edge Function ────────────────────────────────────────────
// Lists and revokes auth sessions for the calling user.
// Uses GoTrue admin API with service role key — user can only manage their own sessions.
//
// Body: { action: 'list' }
//       { action: 'revoke', sessionId: '<uuid>' }
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

serve(async (req: Request) => {
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

  const adminBase = `${supabaseUrl}/auth/v1/admin/users/${user.id}`
  const adminHeaders = {
    'Authorization': `Bearer ${serviceRoleKey}`,
    'apikey': serviceRoleKey,
    'Content-Type': 'application/json',
  }

  let body: Record<string, string> = {}
  try { body = await req.json() } catch { /* empty body ok */ }

  // ── LIST ─────────────────────────────────────────────────────────────────
  if (body.action === 'list') {
    const res = await fetch(`${adminBase}/sessions`, { headers: adminHeaders })
    const text = await res.text()
    console.log(`GoTrue sessions ${res.status}:`, text)
    if (!res.ok) {
      // Always 200 so Supabase SDK gives us data — error info in body
      return json({ sessions: [], error: `GoTrue ${res.status}: ${text}` })
    }
    let data: { sessions?: unknown[] } = {}
    try { data = JSON.parse(text) } catch { return json({ sessions: [], error: `Bad JSON: ${text}` }) }
    return json({ sessions: data.sessions ?? [] })
  }

  // ── REVOKE ───────────────────────────────────────────────────────────────
  if (body.action === 'revoke') {
    const { sessionId } = body
    if (!sessionId) return json({ error: 'sessionId required' })

    const listRes = await fetch(`${adminBase}/sessions`, { headers: adminHeaders })
    const listData = await listRes.json().catch(() => ({ sessions: [] }))
    const belongs = (listData.sessions ?? []).some((s: { id: string }) => s.id === sessionId)
    if (!belongs) return json({ error: 'Session not found or already expired' })

    const delRes = await fetch(`${adminBase}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: adminHeaders,
    })
    if (!delRes.ok) {
      const errText = await delRes.text()
      return json({ error: `GoTrue ${delRes.status}: ${errText}` })
    }
    return json({ success: true })
  }

  return json({ error: 'Unknown action' })
})
