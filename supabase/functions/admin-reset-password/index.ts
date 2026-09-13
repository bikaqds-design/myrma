// Edge Function: admin-reset-password
// Allows super_admin users to directly set another user's password, and to
// create a brand-new staff account. Uses the service_role key (server-side
// only — never exposed to the browser).
//
// ── What the 2026-09-03 audit found here (BUG-018) ───────────────────────────
//
// Three separate defects, all in the same function:
//
// 1. The caller check read only `role`, not `status`. rma_access_is_current()
//    is what the database uses everywhere else, and it treats anything other
//    than an active, unexpired row as no access at all. Because suspending a
//    user does not revoke their existing session (BUG-049), a super_admin who
//    had been suspended or whose access had expired could keep using a live JWT
//    to reset ANY user's password — including an active administrator's — and
//    so let themselves back in. admin-invite-user already checked status; this
//    one did not.
//
// 2. The self-lockout guard compared `targetEmail === caller.email` verbatim.
//    Email is case-insensitive in practice, so "Admin@x.com" sailed past a
//    guard meant to stop the caller changing their own password here.
//
// 3. Creating a user was half an operation. This function created the auth
//    account and the BROWSER then inserted the user_roles row as a second,
//    unrelated request. If that second call failed — a dropped connection, a
//    closed tab — the account existed with no role. The live database has one
//    such account today: a real address that has signed in and can authenticate
//    but has no role, so every query it makes is refused and it sees only the
//    access-denied screen.
//
// ── Compatibility, deliberately ──────────────────────────────────────────────
//
// `role` is OPTIONAL on the create path even though it should always be sent.
// That is what makes the deployment order safe rather than a choice between two
// bad windows:
//
//   this function + OLD browser   role absent -> behaves exactly as before, and
//                                 the old browser still writes the role itself
//   this function + NEW browser   role present -> both rows are written here,
//                                 atomically, and the browser writes nothing
//
// So this can be deployed on its own, ahead of the front end, without breaking
// "Add User" and without a window where accounts are created role-less by a
// browser that has not caught up. The response reports `roleCreated` so the
// caller knows which of the two happened.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { corsOriginHeaders } from '../_shared/cors.ts'

/**
 * Mirrors validatePasswordStrength() in src/pages/UserManagement/_utils.js.
 *
 * Kept identical on purpose: a server rule stricter than the browser's would
 * reject passwords the Add User screen had already accepted and offered to
 * copy, which reads as the feature being broken. This is the boundary; the
 * browser copy is the courtesy.
 */
function passwordProblem(pw: string): string | null {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters'
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter'
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter'
  if (!/[0-9]/.test(pw)) return 'Password must contain a number'
  return null
}

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
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Identify the caller from their own JWT, never from the request body.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user: caller }, error: authError } = await callerClient.auth.getUser()
  if (authError || !caller) return json({ error: 'Unauthorized' }, 401)

  const adminClient = createClient(supabaseUrl, serviceKey)
  const callerEmailLc = (caller.email ?? '').toLowerCase()

  // ── The caller must be a super_admin whose access is current ───────────────
  // Same three conditions as rma_access_is_current() in the database: the role,
  // an active status, and an expiry that has not passed. Looked up on the
  // lower-cased address because user_roles is keyed by email and a case
  // mismatch here would silently deny a legitimate administrator.
  const { data: callerRole } = await adminClient
    .from('user_roles')
    .select('role, status, access_expires_at')
    .eq('user_email', callerEmailLc)
    .single()

  const accessExpired =
    !!callerRole?.access_expires_at &&
    new Date(callerRole.access_expires_at as string) <= new Date()

  if (
    callerRole?.role !== 'super_admin' ||
    (callerRole?.status ?? 'active') !== 'active' ||
    accessExpired
  ) {
    return json({ error: 'Forbidden: super_admin only' }, 403)
  }

  // ── Body ───────────────────────────────────────────────────────────────────
  let targetEmail: string, newPassword: string, role: string | undefined
  try {
    const body = await req.json()
    targetEmail = body.targetEmail
    newPassword = body.newPassword
    role        = body.role || undefined
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  if (!targetEmail || !newPassword) {
    return json({ error: 'targetEmail and newPassword are required' }, 400)
  }

  const pwProblem = passwordProblem(newPassword)
  if (pwProblem) return json({ error: pwProblem }, 400)

  // Compared lower-cased: the previous verbatim comparison let a differently
  // cased spelling of the caller's own address through a guard meant to stop it.
  const targetEmailLc = targetEmail.toLowerCase()
  if (targetEmailLc === callerEmailLc) {
    return json({ error: 'Use Account Settings to change your own password' }, 400)
  }

  // ── Find the target ────────────────────────────────────────────────────────
  // Audit HIGH-5: the previous code fetched only the first 1,000 users and
  // .find()'d in memory — past 1,000 accounts, existing users were not found,
  // so resets fell into the "create user" branch and failed on a duplicate.
  let target: { id: string; email?: string } | undefined
  const PER_PAGE = 1000
  const MAX_PAGES = 100 // hard stop: 100k users — well beyond this app's scale
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data: { users }, error: listError } =
      await adminClient.auth.admin.listUsers({ page, perPage: PER_PAGE })
    if (listError) return json({ error: listError.message }, 500)
    target = users.find((u) => (u.email ?? '').toLowerCase() === targetEmailLc)
    if (target) break
    if (users.length < PER_PAGE) break // last page reached
  }

  // ── Existing user: set the password ────────────────────────────────────────
  if (target) {
    const { error: updateError } = await adminClient.auth.admin.updateUserById(target.id, {
      password: newPassword,
    })
    if (updateError) return json({ error: updateError.message }, 500)
    return json({ success: true, created: false, roleCreated: false })
  }

  // ── New user: create the account, and the role with it ─────────────────────
  // Stored lower-cased so the auth address and the user_roles key cannot drift
  // apart — that mismatch is what makes an account authenticate but resolve to
  // no role.
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: targetEmailLc,
    password: newPassword,
    email_confirm: true, // an administrator is setting this up; skip the email
  })
  if (createError) return json({ error: createError.message }, 500)

  if (!role) {
    // An older browser will write the role itself in a follow-up request. Say
    // so plainly rather than reporting a complete success.
    return json({ success: true, created: true, roleCreated: false })
  }

  const { error: roleError } = await adminClient
    .from('user_roles')
    .insert([{ user_email: targetEmailLc, role }])

  if (roleError) {
    // Undo the half-made account rather than leave one that can sign in and do
    // nothing. The role is not validated against a list here on purpose: the
    // chk_user_role constraint and the custom_roles table are the authority,
    // and duplicating that list would go stale the first time a custom role is
    // added.
    const { error: cleanupError } =
      await adminClient.auth.admin.deleteUser(created.user.id)

    return json({
      error: `Could not assign the role, so the account was not created: ${roleError.message}`,
      ...(cleanupError
        ? {
            warning:
              `The auth account for ${targetEmailLc} could NOT be removed either ` +
              `(${cleanupError.message}). Delete it by hand — it currently has no role.`,
          }
        : {}),
    }, 400)
  }

  return json({ success: true, created: true, roleCreated: true })
})
