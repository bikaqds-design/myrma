// Edge Function: admin-reset-password
// Allows super_admin users to directly set another user's password.
// Uses the service_role key (server-side only — never exposed to the browser).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsOriginHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  const corsHeaders = {
    ...corsOriginHeaders(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Verify the caller's JWT and get their identity
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } }
  })
  const { data: { user: caller }, error: authError } = await callerClient.auth.getUser()
  if (authError || !caller) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Only super_admin may set passwords directly
  const adminClient = createClient(supabaseUrl, serviceKey)
  const { data: roleRow } = await adminClient
    .from('user_roles')
    .select('role')
    .eq('user_email', caller.email)
    .single()

  if (roleRow?.role !== 'super_admin') {
    return new Response(JSON.stringify({ error: 'Forbidden: super_admin only' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Parse the request body
  let targetEmail: string, newPassword: string
  try {
    const body = await req.json()
    targetEmail = body.targetEmail
    newPassword = body.newPassword
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  if (!targetEmail || !newPassword || newPassword.length < 8) {
    return new Response(JSON.stringify({ error: 'targetEmail and newPassword (min 8 chars) are required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Prevent super_admin from locking themselves out
  if (targetEmail === caller.email) {
    return new Response(JSON.stringify({ error: 'Use Account Settings to change your own password' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Look up the target user by email.
  // Audit HIGH-5: the previous code fetched only the first 1,000 users and
  // .find()'d in memory — past 1,000 accounts, existing users were not found,
  // so resets fell into the "create user" branch and failed on a duplicate.
  // Paginate until we find the target (or run out of pages) so lookup is
  // correct regardless of directory size.
  const targetEmailLc = targetEmail.toLowerCase()
  let target: { id: string; email?: string } | undefined
  const PER_PAGE = 1000
  const MAX_PAGES = 100 // hard stop: 100k users — well beyond this app's scale
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data: { users }, error: listError } = await adminClient.auth.admin.listUsers({ page, perPage: PER_PAGE })
    if (listError) {
      return new Response(JSON.stringify({ error: listError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    target = users.find(u => (u.email ?? '').toLowerCase() === targetEmailLc)
    if (target) break
    if (users.length < PER_PAGE) break // last page reached
  }

  if (!target) {
    // User doesn't exist in Supabase Auth yet — create them.
    // This is the adminCreateUser path: brand-new staff accounts are created here.
    const { error: createError } = await adminClient.auth.admin.createUser({
      email: targetEmail,
      password: newPassword,
      email_confirm: true,  // skip the confirmation email; admin is setting this up
    })
    if (createError) {
      return new Response(JSON.stringify({ error: createError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    return new Response(JSON.stringify({ success: true, created: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // User exists — update their password (adminSetPassword path).
  const { error: updateError } = await adminClient.auth.admin.updateUserById(target.id, {
    password: newPassword
  })
  if (updateError) {
    return new Response(JSON.stringify({ error: updateError.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  return new Response(JSON.stringify({ success: true, created: false }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
})
