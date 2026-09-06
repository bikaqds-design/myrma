import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsOriginHeaders } from '../_shared/cors.ts'
import { currentAccess, canAct } from '../_shared/access.ts'

serve(async (req) => {
  const corsHeaders = {
    ...corsOriginHeaders(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // ── Who may use this ───────────────────────────────────────────────────────
  // BUG-021: this function checked only that the caller was SOMEBODY
  // authenticated. It had no role check and no status check at all, so any
  // signed-in identity — a viewer, or a suspended account still holding a live
  // JWT — could spend the organisation's paid LLM quota at will.
  //
  // Gated to current, non-viewer staff, the same line the RLS layer draws for
  // anything that spends money or leaves the building.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseClient = createClient(
    supabaseUrl,
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  )

  const { data: { user }, error: authError } = await supabaseClient.auth.getUser()
  if (authError || !user) return json({ error: 'Unauthorized' }, 401)

  const adminClient = createClient(
    supabaseUrl,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )
  const access = await currentAccess(adminClient, user.email)
  if (!canAct(access)) {
    return json({ error: 'Forbidden: your account cannot use the assistant' }, 403)
  }

  try {
    const { context_type, data } = await req.json()

    const nvidiaKey = Deno.env.get('NVIDIA_API_KEY')
    if (!nvidiaKey) {
      console.error('[ai-assist] NVIDIA_API_KEY is not configured')
      return json({ error: 'The assistant is not configured.' }, 503)
    }

    const { systemPrompt, userPrompt } = buildPrompt(context_type, data)

    const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${nvidiaKey}`,
      },
      body: JSON.stringify({
        model: 'meta/llama-3.3-70b-instruct',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 300,
      }),
    })

    if (!resp.ok) {
      // BUG-021: the provider's body was handed to the browser verbatim. It can
      // carry request ids and account details, and the person who needs it is
      // whoever reads the function logs.
      const errText = await resp.text().catch(() => '')
      console.error(`[ai-assist] provider ${resp.status}: ${errText.slice(0, 400)}`)
      return json({ error: `The assistant is unavailable (provider returned ${resp.status}).` }, 502)
    }

    const nvidiaResult = await resp.json()
    const raw = nvidiaResult.choices?.[0]?.message?.content
    if (!raw) throw new Error('Empty response from NVIDIA')

    const parsed = JSON.parse(raw)

    return json(parsed)
  } catch (err) {
    // BUG-021: every failure here returned HTTP 200 with an `error` field, so a
    // caller could not tell success from failure by status, and the message was
    // whatever the underlying error happened to say — including the provider's.
    console.error('[ai-assist]', err)
    return json({ error: 'The assistant could not complete that request.' }, 500)
  }
})

function buildPrompt(contextType: string, data: Record<string, unknown>): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are an AI assistant embedded in myRMA, a repair and RMA management system for repair shops and service centers.
Always respond with valid JSON in this exact format: {"summary": "...", "suggestion": "..."}
- summary: 2-3 concise sentences describing the current situation
- suggestion: one specific actionable next step starting with a verb
- Be direct and professional. No markdown, no extra keys, only valid JSON.`

  let userPrompt = ''

  switch (contextType) {
    case 'ticket': {
      const t = data as Record<string, unknown>
      const products = (t.products as Record<string, unknown>[]) ?? []
      const comments = (t.comments as Record<string, unknown>[]) ?? []
      const lastComment = comments.length > 0
        ? String((comments[comments.length - 1] as Record<string, unknown>).body ?? (comments[comments.length - 1] as Record<string, unknown>).content ?? '')
        : 'None'
      userPrompt = `Analyze this RMA ticket and suggest what to do next:
RMA Number: ${t.rma_number}
Customer: ${t.customer_name}
Status: ${t.ticket_status}
Priority: ${t.priority}
Assigned Technician: ${t.assigned_technician || 'Unassigned'}
Created: ${t.created_date}
Due Date: ${t.due_date || 'Not set'}
Description: ${t.general_description || 'No description provided'}
Products: ${products.length > 0 ? products.map((p) => `${p.product_name} (SN: ${p.serial_number || 'N/A'})`).join(', ') : 'None listed'}
Comments: ${comments.length} total. Last: ${lastComment}`
      break
    }
    case 'customer': {
      const c = data as Record<string, unknown>
      userPrompt = `Analyze this customer profile and suggest a useful action:
Customer: ${c.contact_person}
Company: ${c.company_name || 'N/A'}
Type: ${c.customer_type || 'N/A'}
Email: ${c.email || 'N/A'}
Total RMA tickets: ${c.ticket_count ?? 0}
Open tickets: ${c.open_ticket_count ?? 0}
Resolved tickets: ${c.resolved_count ?? 0}
Last ticket date: ${c.last_ticket_date || 'N/A'}
Customer since: ${c.created_date || 'N/A'}`
      break
    }
    case 'dashboard': {
      const d = data as Record<string, unknown>
      userPrompt = `Analyze this RMA operations dashboard and give a key operational insight:
Period: ${d.range}
Open tickets: ${d.open}
In Progress: ${d.in_progress}
Pending: ${d.pending}
Overdue: ${d.overdue}
Resolved this period: ${d.resolved}
Total tickets this period: ${d.total}
SLA on-time rate: ${d.sla_percent}%
Resolution rate: ${d.resolution_rate}%`
      break
    }
    default:
      userPrompt = `Analyze this data: ${JSON.stringify(data)}`
  }

  return { systemPrompt, userPrompt }
}
