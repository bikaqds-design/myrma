// supabase/functions/kb-chat/index.ts
//
// The Knowledge Center's answer engine.
//
// ═══ Why this exists as a server function ════════════════════════════════════
//
// The obvious implementation calls the model provider straight from the
// browser. That puts the API key in the JavaScript bundle, where anyone who
// opens developer tools can read it, keep it, and spend your quota from their
// own machine. A key in a browser is a published key.
//
// So the key lives here, in the function's environment, and never reaches the
// client. The browser sends a question and its own session token; this decides
// whether that person may ask, finds the relevant passages, and does the
// talking to the model.
//
// ═══ Why retrieval happens here too ══════════════════════════════════════════
//
// It would be simpler to let the browser find the passages and post them up.
// It would also mean the client chooses what the model reads — so a modified
// client could feed it any text at all and have the answer come back wearing
// the company's Knowledge Center badge.
//
// Retrieval runs here, against the database, using THE CALLER'S OWN token. Row
// level security therefore applies exactly as it does everywhere else: a person
// who cannot read a document cannot get an answer drawn from it, and that is
// enforced by the same policy rather than by a second set of rules that has to
// be kept in step.
//
// ═══ What it will not do ═════════════════════════════════════════════════════
//
// It will not answer from the model's own knowledge. The system prompt is
// explicit that only the supplied passages may be used, and that "the documents
// do not say" is a correct and expected answer. A confident invention about a
// motherboard's memory support is worse than no answer — someone will order
// parts on it.
//
// ═══ Configuration ═══════════════════════════════════════════════════════════
//
// Secrets, set with `supabase secrets set`:
//   KB_LLM_API_KEY    required — the provider key
//   KB_LLM_BASE_URL   optional — defaults to NVIDIA's OpenAI-compatible endpoint
//   KB_LLM_MODEL      optional — overridden per-request by rma_config
//
// The model name is deliberately NOT hardcoded. Provider model identifiers
// change, and a wrong one baked into a deployed function is a redeploy to fix;
// read from rma_config it is a dropdown.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsOriginHeaders } from '../_shared/cors.ts'

// BUG-021: this hardcoded '*' while every other function used the shared
// helper, so setting ALLOWED_ORIGINS would have hardened the others and
// silently left this one open. The helper still falls back to '*' until that
// secret is set, so this changes nothing until it is.
const CORS_STATIC = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/** OpenAI-compatible; NVIDIA NIM, Groq, OpenAI and most others speak this. */
const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1'

/** How many documents to pull, and how many passages of them to send. */
const MAX_DOCUMENTS = 6
const MAX_PASSAGES = 8
const PASSAGE_CHARS = 1200

/** Overridden by kb_llm_max_tokens. See the note where it is read. */
const DEFAULT_MAX_TOKENS = 4096

/**
 * A newline, named.
 *
 * The protocol back to the browser is newline-delimited JSON, so this character
 * is load-bearing. Written literally it is invisible in source — and one of
 * them landed inside a single-quoted string during an edit, which single quotes
 * do not permit, and the deploy failed with a parse error pointing at a line
 * that looked perfectly fine.
 */
const NL = String.fromCharCode(10)

type Passage = { docId: string; title: string; product: string; text: string }

/**
 * Words carrying no search value. Needed because the index uses the 'simple'
 * text search configuration, which has NO stop-word list of its own — that is
 * the right choice for datasheets full of part numbers, but it means every
 * word of a question counts.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for',
  'from', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its', 'me', 'much',
  'of', 'on', 'or', 'our', 'that', 'the', 'their', 'there', 'these', 'this',
  'to', 'was', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'you', 'your',
])

/**
 * Turn a natural-language question into a search query.
 *
 * The bug this exists to fix: the whole question used to be handed to
 * websearch_to_tsquery, which ANDs its terms. Asking "what is the brightness
 * and refresh rate of the 24G4E monitor?" therefore required a document to
 * contain "what" AND "is" AND "the" AND "of" — and matched nothing, so the chat
 * reported that nothing had been uploaded about it while the search box found
 * the very same document instantly.
 *
 * Joining with OR means any meaningful term brings a document into the running;
 * the passage scoring afterwards decides what is actually relevant.
 */
export function questionToQuery(question: string): string {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9.+/-]+/i)
    .map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, ''))
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))

  // Everything was a stop word ("what is it?"). Fall back to the raw question
  // rather than an empty query, which would throw.
  if (terms.length === 0) return question.trim()

  // De-duplicated, and capped: a very long question would otherwise build a
  // query slower than the search it is meant to speed up.
  return [...new Set(terms)].slice(0, 24).join(' or ')
}

/**
 * Split a document into overlapping passages.
 *
 * Mirrors chunkText in src/lib/pdfText.js. Duplicated rather than shared
 * because a Deno function and a browser bundle have no common module here —
 * the shapes must be kept in step by hand, which is why both carry this note.
 */
function chunk(text: string, size = PASSAGE_CHARS, overlap = 200): string[] {
  const clean = (text || '').trim()
  if (!clean) return []
  if (clean.length <= size) return [clean]
  const out: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length)
    if (end < clean.length) {
      const window = clean.slice(start, end)
      const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '))
      if (breakAt > size * 0.5) end = start + breakAt + 1
    }
    out.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return out.filter(Boolean)
}

/**
 * Rank passages by how many of the question's terms they contain.
 *
 * Deliberately crude. Proper semantic retrieval needs an embedding model, which
 * is a second provider dependency and a second thing to pay for; datasheet
 * questions are overwhelmingly keyword-shaped ("TDP", "DDR5", a part number),
 * and term overlap answers those well. If the corpus grows past a few hundred
 * documents this is the piece to replace.
 */
function scorePassage(passage: string, terms: string[]): number {
  const hay = passage.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (!term) continue
    let from = 0
    // Count occurrences, but with diminishing returns: a passage that says
    // "DDR5" nine times is not nine times more relevant than one that says it
    // twice, and without this a specification table beats real prose.
    let hits = 0
    for (;;) {
      const at = hay.indexOf(term, from)
      if (at === -1) break
      hits++
      from = at + term.length
      if (hits >= 4) break
    }
    score += hits > 0 ? 1 + Math.log(hits) : 0
  }
  return score
}

Deno.serve(async (req: Request) => {
  // Per-request closures, because the allowed origin depends on THIS request's
  // Origin header. This is the pattern the other functions already use; kb-chat
  // held CORS at module scope, which is why it could only ever be a wildcard.
  const CORS = { ...CORS_STATIC, ...corsOriginHeaders(req) }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const apiKey = Deno.env.get('KB_LLM_API_KEY')
  if (!apiKey) {
    // Said plainly rather than as a 500: the most likely cause by far is that
    // the secret was never set, and "something went wrong" would send someone
    // hunting through logs for a one-line fix.
    return json(
      { error: 'not_configured', message: 'KB_LLM_API_KEY is not set on this function.' },
      503
    )
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    // The caller's own token, so every query below is subject to the same row
    // level security as the rest of the application.
    { global: { headers: { Authorization: authHeader } } }
  )

  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData?.user) return json({ error: 'unauthorized' }, 401)

  let body: { question?: string; history?: { role: string; content: string }[] }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad_request', message: 'Expected a JSON body.' }, 400)
  }

  const question = (body.question ?? '').trim()
  if (!question) return json({ error: 'bad_request', message: 'A question is required.' }, 400)
  if (question.length > 2000) {
    return json({ error: 'bad_request', message: 'Question is too long.' }, 400)
  }

  // ── Configuration that is not secret ──────────────────────────────────────
  const { data: config } = await supabase
    .from('rma_config')
    .select('config_key, config_value')
    .in('config_key', ['kb_llm_model', 'kb_llm_base_url', 'kb_llm_max_tokens', 'kb_llm_thinking'])

  const configured = (key: string): string | null => {
    const row = config?.find((r: { config_key: string }) => r.config_key === key)
    const v = row?.config_value
    if (typeof v === 'string') return v
    return v == null ? null : String(v)
  }

  const baseUrl = configured('kb_llm_base_url') || Deno.env.get('KB_LLM_BASE_URL') || DEFAULT_BASE_URL

  // Configurable, and generous by default, because reasoning models spend this
  // budget THINKING before they write anything the user sees. A tight cap that
  // is ample for a normal model returns an empty answer from a reasoning one —
  // the reasoning consumes the whole allowance and the reply is truncated to
  // nothing. NVIDIA's own sample for Nemotron uses 16384.
  // Reasoning models think at length before emitting a visible word, and those
  // tokens are neither streamed nor useful here: quoting a figure out of a
  // datasheet passage is not a reasoning problem. Left on, a 550B model spends
  // minutes deliberating over a number that is written in front of it.
  //
  // Off by default, and a config toggle rather than a constant because a harder
  // question — comparing two products, say — may genuinely want it.
  const thinking = String(configured('kb_llm_thinking') ?? 'false') === 'true'

  const maxTokens = Math.min(
    Math.max(Number(configured('kb_llm_max_tokens')) || DEFAULT_MAX_TOKENS, 256),
    32768
  )
  const model = configured('kb_llm_model') || Deno.env.get('KB_LLM_MODEL')
  if (!model) {
    return json(
      {
        error: 'not_configured',
        message:
          'No model is configured. Set kb_llm_model in System Setup, or KB_LLM_MODEL on the function.',
      },
      503
    )
  }

  // ── Retrieval ─────────────────────────────────────────────────────────────
  // RLS applies: a person who cannot read a document cannot be answered from it.
  const { data: docs, error: searchError } = await supabase
    .from('product_documents')
    .select('id, title, extracted_text, product:products(product_name, sku)')
    .textSearch('search_vector', questionToQuery(question), { type: 'websearch', config: 'simple' })
    .eq('extraction_status', 'ok')
    .limit(MAX_DOCUMENTS)

  if (searchError) {
    // Logged, not returned. The database's own error text names tables, columns
    // and query internals, and the chat panel prints `message` verbatim under
    // its heading. (Audit finding BUG-064.)
    console.error('[kb-chat] search failed:', searchError.code, searchError.message)
    return json({ error: 'search_failed', message: 'Searching the documents failed. Please try again.' }, 500)
  }

  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9.+-]+/i)
    .filter((w) => w.length > 2)

  const passages: (Passage & { score: number })[] = []
  for (const d of docs ?? []) {
    const product = d.product
      ? `${d.product.product_name}${d.product.sku ? ` (${d.product.sku})` : ''}`
      : ''
    for (const text of chunk(d.extracted_text ?? '')) {
      passages.push({
        docId: d.id,
        title: d.title,
        product,
        text,
        score: scorePassage(text, terms),
      })
    }
  }
  passages.sort((a, b) => b.score - a.score)
  const chosen = passages.filter((p) => p.score > 0).slice(0, MAX_PASSAGES)

  // Nothing relevant found. Answered here rather than by the model, because the
  // model would happily invent something plausible from an empty context, and
  // the honest answer costs nothing and takes no time.
  if (chosen.length === 0) {
    return json({
      answer:
        'I could not find anything about that in the uploaded documents. Try different wording, or check that a datasheet covering it has been uploaded — scanned documents cannot be searched inside.',
      sources: [],
      grounded: false,
    })
  }

  const context = chosen
    .map(
      (p, i) =>
        `[${i + 1}] ${p.title}${p.product ? ` — ${p.product}` : ''}\n${p.text}`
    )
    .join('\n\n---\n\n')

  const system = [
    'You answer questions about products using ONLY the document passages provided below.',
    '',
    'Rules you must follow:',
    '- Use only the passages. Do not use anything else you know about these products.',
    '- If the passages do not contain the answer, say so plainly. "The documents do not say" is a correct and useful answer.',
    '- Never guess a specification. Someone may order parts based on your answer.',
    '- Cite the passages you used by their bracketed number, like [1] or [2].',
    '- Be brief. A specification question deserves the specification, not an essay.',
    '',
    'Passages:',
    '',
    context,
  ].join('\n')

  // A short slice of history so follow-ups work ("and its TDP?"), bounded so a
  // long conversation cannot grow the request without limit.
  const history = (body.history ?? [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))

  // The sources travel ahead of the answer, as one JSON line, so the client can
  // show what is being read from while the answer is still arriving.
  const sources = chosen.map((p, i) => ({
    n: i + 1,
    id: p.docId,
    title: p.title,
    product: p.product,
  }))

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      // Emitted BEFORE the provider is contacted, not after. An earlier version
      // awaited the upstream fetch first and only then built this stream, so
      // "sources first" was true within the stream and false in wall-clock
      // time: they took fifteen seconds to appear because they were waiting on
      // the model to accept the request. Retrieval is a database query and its
      // result should be on screen in about a second.
      controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'sources', sources })}${NL}`))

      const fail = (message: string) => {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', message })}${NL}`))
        controller.close()
      }

      let upstream: Response
      try {
        upstream = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              ...history,
              { role: 'user', content: question },
            ],
            temperature: 0.2,
            max_tokens: maxTokens,
            stream: true,
            // NVIDIA's flag for its reasoning models. Sent only when thinking is
            // wanted: providers that do not know the field generally ignore it,
            // but not sending it at all is the safer default.
            ...(thinking ? { chat_template_kwargs: { enable_thinking: true } } : {}),
          }),
        })
      } catch (err) {
        console.error('[kb-chat] provider unreachable:', err)
        return fail('Could not reach the model provider.')
      }

      if (!upstream.ok || !upstream.body) {
        // BUG-021: the provider's response body was passed straight to the
        // browser. It can carry request ids, quota details and account
        // identifiers; the person who needs it is whoever reads the function
        // logs, not the person who asked a question.
        const detail = await upstream.text().catch(() => '')
        console.error(`[kb-chat] provider ${upstream.status}: ${detail.slice(0, 400)}`)
        return fail(`The assistant is unavailable (provider returned ${upstream.status}).`)
      }

      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(NL)
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') continue
            try {
              const parsed = JSON.parse(payload)
              const delta = parsed?.choices?.[0]?.delta?.content
              if (delta) {
                controller.enqueue(
                  encoder.encode(`${JSON.stringify({ type: 'delta', text: delta })}${NL}`)
                )
              }
            } catch {
              // A malformed chunk is not worth ending the answer over.
            }
          }
        }
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'done' })}${NL}`))
      } catch (err) {
        // The raw exception text went to the browser, which printed it under the
        // chat's error heading. Log it; tell the person what happened, not how.
        // (Audit finding BUG-064.)
        console.error('[kb-chat] stream failed:', err)
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: 'error', message: 'The answer stopped unexpectedly. Please try again.' })}${NL}`
          )
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { ...CORS, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' },
  })
})
