// Edge Function: admin-reset-password
// Allows super_admin users to directly set another user's password.
// Uses the service_role key (server-side only — never exposed to the browser).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
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

  if (!targetEmail || !newPassword || newPassword.length < 6) {
    return new Response(JSON.stringify({ error: 'targetEmail and newPassword (min 6 chars) are required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Prevent super_admin from locking themselves out
  if (targetEmail === caller.email) {
    return new Response(JSON.stringify({ error: 'Use Account Settings to change your own password' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Look up the target user by email
  const { data: { users }, error: listError } = await adminClient.auth.admin.listUsers({ perPage: 1000 })
  if (listError) {
    return new Response(JSON.stringify({ error: listError.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const target = users.find(u => u.email === targetEmail)
  if (!target) {
    return new Response(JSON.stringify({ error: `No auth user found for ${targetEmail}` }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Set the new password via admin API
  const { error: updateError } = await adminClient.auth.admin.updateUserById(target.id, {
    password: newPassword
  })
  if (updateError) {
    return new Response(JSON.stringify({ error: updateError.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
})
