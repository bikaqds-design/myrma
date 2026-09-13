// Edge Function: admin-invite-user
//
// Invites someone to the system with a role chosen up front, and revokes an
// invitation that has not been accepted. Uses the service_role key, which must
// never reach the browser — hence an Edge Function rather than a client call.
//
// ── Why the role is written before the person accepts ────────────────────────
//
// The role is recorded in user_roles the moment the invitation is sent, with
// status 'pending'. That status grants nothing: rma_access_is_current() only
// returns true for 'active', so a pending row is inert until the invitation is
// accepted. Writing it up front means the answer to "what will this person be
// able to do" is decided and visible before the email goes out, rather than
// being remembered and applied afterwards.
//
// ── Why an invitation rather than setting a password for someone ─────────────
//
// The existing admin flow has the administrator type a password for the new
// user and then tell them what it is, out of band. That hands a working
// credential to a chat app. An invitation lets the person set their own.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { corsOriginHeaders } from '../_shared/cors.ts'

/** Roles that may be granted. Mirrors ROLES in src/lib/constants.ts. */
const VALID_ROLES = [
  'super_admin',
  'admin',
  'manager',
  'technician',
  'viewer',
  'sales_rep',
  'accountant',
]

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

  // Identify the caller from their own JWT, never from the request body.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const {
    data: { user: caller },
    error: authError,
  } = await callerClient.auth.getUser()
  if (authError || !caller) return json({ error: 'Unauthorized' }, 401)

  const adminClient = createClient(supabaseUrl, serviceKey)

  // Granting system access is a super_admin act, matching admin-reset-password.
  const { data: callerRole } = await adminClient
    .from('user_roles')
    .select('role, status')
    .eq('user_email', caller.email)
    .single()

  if (callerRole?.role !== 'super_admin' || callerRole?.status !== 'active') {
    return json({ error: 'Forbidden: super_admin only' }, 403)
  }

  let action: string, email: string, role: string, redirectTo: string
  try {
    const body = await req.json()
    action = body.action ?? 'invite'
    email = String(body.email ?? '').trim().toLowerCase()
    role = String(body.role ?? '')
    redirectTo = String(body.redirectTo ?? '')
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  if (!email || !email.includes('@')) return json({ error: 'A valid email is required' }, 400)

  // ── Revoke ────────────────────────────────────────────────────────────────
  // Only an invitation that has NOT been accepted may be revoked here. Removing
  // an active user is a different act with different consequences, and it has
  // its own screen; conflating them would let a mis-click delete a colleague.
  if (action === 'revoke') {
    const { data: row } = await adminClient
      .from('user_roles')
      .select('status')
      .eq('user_email', email)
      .single()

    if (!row) return json({ error: 'No invitation found for that address' }, 404)
    if (row.status !== 'pending') {
      return json({ error: 'That user has already accepted; remove them from the users list instead' }, 400)
    }

    const target = await findUserByEmail(adminClient, email)
    if (target) {
      const { error: delErr } = await adminClient.auth.admin.deleteUser(target.id)
      if (delErr) return json({ error: delErr.message }, 500)
    }
    const { error: roleErr } = await adminClient.from('user_roles').delete().eq('user_email', email)
    if (roleErr) return json({ error: roleErr.message }, 500)

    return json({ success: true, revoked: true, email })
  }

  // ── Invite ────────────────────────────────────────────────────────────────
  if (!VALID_ROLES.includes(role)) {
    return json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` }, 400)
  }

  // Someone who already has a role row is already in the system — inviting them
  // again would either fail on the unique email or silently reset what they
  // have. Say so instead.
  const { data: existingRole } = await adminClient
    .from('user_roles')
    .select('status')
    .eq('user_email', email)
    .single()

  if (existingRole) {
    return json(
      {
        error:
          existingRole.status === 'pending'
            ? 'That address already has a pending invitation'
            : 'That address is already a user of the system',
      },
      409
    )
  }

  if (await findUserByEmail(adminClient, email)) {
    return json({ error: 'That address already has an account but no role; assign a role instead' }, 409)
  }

  const { error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
    redirectTo: redirectTo || undefined,
    data: { invited_by: caller.email, invited_role: role },
  })
  if (inviteError) return json({ error: inviteError.message }, 500)

  // The role row goes in AFTER the invitation is accepted by GoTrue, so a
  // failed send never leaves a role behind for someone who was never contacted.
  const { error: roleError } = await adminClient.from('user_roles').insert({
    user_email: email,
    role,
    status: 'pending',
    role_type: 'preset',
  })

  if (roleError) {
    // The invitation went out but the role did not land. Undo the invitation
    // rather than leaving someone able to accept with no role at all.
    const created = await findUserByEmail(adminClient, email)
    if (created) await adminClient.auth.admin.deleteUser(created.id)
    return json({ error: `Invitation sent but role could not be saved: ${roleError.message}` }, 500)
  }

  return json({ success: true, invited: true, email, role })
})

/**
 * Find an auth user by email, paging through the directory.
 *
 * listUsers returns one page; the first version of admin-reset-password read
 * only the first 1,000 and searched in memory, so past that size existing users
 * were reported missing. Same trap, same fix.
 */
async function findUserByEmail(
  adminClient: ReturnType<typeof createClient>,
  email: string
): Promise<{ id: string } | undefined> {
  const PER_PAGE = 1000
  const MAX_PAGES = 100
  for (let page = 1; page <= MAX_PAGES; page++) {
    const {
      data: { users },
      error,
    } = await adminClient.auth.admin.listUsers({ page, perPage: PER_PAGE })
    if (error) return undefined
    const hit = users.find((u) => (u.email ?? '').toLowerCase() === email)
    if (hit) return hit
    if (users.length < PER_PAGE) return undefined
  }
  return undefined
}
