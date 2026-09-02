// Edge Function: admin-delete-user
//
// Removes a user for good: the role row AND the Supabase Auth account.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// "Delete permanently" used to call
//
//     supabase.from('user_roles').delete().eq('user_email', email)
//
// which removes the role and nothing else. The person's auth account and
// password survived. They would hit an access-denied screen, so it looked like
// it had worked — but the login still existed, and anyone re-adding a role for
// that address would let them straight back in. Deleting an auth user needs the
// service_role key, which is why this could never have been done from the
// browser and why it quietly wasn't.
//
// ── The order matters ────────────────────────────────────────────────────────
//
// The role row goes FIRST. user_roles carries rma_protect_last_super_admin,
// which refuses to remove the final active super_admin. Deleting the auth
// account first would mean that veto arrives after the login is already gone —
// locking the business out of its own system. Role first, then auth: if the
// trigger objects, nothing has been destroyed.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsOriginHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  const corsHeaders = {
    ...corsOriginHeaders(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: callerData, error: authError } = await callerClient.auth.getUser()
  const caller = callerData?.user
  if (authError || !caller) return json({ error: 'Unauthorized' }, 401)

  const adminClient = createClient(supabaseUrl, serviceKey)

  const { data: callerRole } = await adminClient
    .from('user_roles')
    .select('role, status')
    .eq('user_email', caller.email)
    .single()

  if (callerRole?.role !== 'super_admin' || callerRole?.status !== 'active') {
    return json({ error: 'Forbidden: super_admin only' }, 403)
  }

  let emails: string[]
  try {
    const body = await req.json()
    // One shape for one user and for many, so the bulk path cannot drift from
    // the single path and end up with different guards.
    emails = (Array.isArray(body.emails) ? body.emails : [body.email])
      .filter(Boolean)
      .map((e: string) => String(e).trim().toLowerCase())
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  if (emails.length === 0) return json({ error: 'No user was named' }, 400)
  if (emails.length > 50) return json({ error: 'Too many users in one request (max 50)' }, 400)

  // Deleting your own account would end the session performing the deletion and
  // could remove the last administrator. The screen also hides it, but the
  // check belongs here too: the screen is not the security boundary.
  if (emails.includes((caller.email ?? '').toLowerCase())) {
    return json({ error: 'You cannot delete your own account' }, 400)
  }

  const results: Array<{ email: string; deleted: boolean; error?: string }> = []

  for (const email of emails) {
    // Role row first — rma_protect_last_super_admin gets its veto before the
    // login is destroyed.
    const { error: roleError } = await adminClient
      .from('user_roles')
      .delete()
      .eq('user_email', email)

    if (roleError) {
      results.push({ email, deleted: false, error: roleError.message })
      continue
    }

    let target: { id: string } | undefined
    const PER_PAGE = 1000
    for (let page = 1; page <= 100; page++) {
      const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: PER_PAGE })
      if (error) break
      const users = data.users ?? []
      target = users.find((u: { email?: string }) => (u.email ?? '').toLowerCase() === email)
      if (target || users.length < PER_PAGE) break
    }

    if (!target) {
      // No auth account to remove — the role row was the whole of them. Still a
      // successful delete, and saying so beats an error nobody can act on.
      results.push({ email, deleted: true })
      continue
    }

    const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(target.id)
    if (authDeleteError) {
      results.push({ email, deleted: false, error: authDeleteError.message })
      continue
    }

    results.push({ email, deleted: true })
  }

  const deleted = results.filter((r) => r.deleted).length
  const failed = results.filter((r) => !r.deleted)

  return json({
    success: failed.length === 0,
    deleted,
    failed,
    results,
  })
})
