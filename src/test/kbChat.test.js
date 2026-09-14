/**
 * kbChat.test.js — the answer engine's client, and the rules the proxy exists
 * to enforce.
 *
 * The single most important property of this feature is not that it answers
 * well. It is that the API key never reaches the browser. A key in a bundle is
 * a published key: anyone who opens developer tools can take it and spend the
 * quota from their own machine. So the first tests here are about where the key
 * is, and the last are about the function refusing to be a free relay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const state = { session: { access_token: 'test-token' }, response: null, lastFetch: null }

vi.mock('../api/client.js', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: state.session } }) } },
  supabaseUrl: 'https://example.supabase.co',
}))

const { askKnowledgeCenter, CHAT_UNAVAILABLE, CHAT_UNAUTHORIZED } = await import('../api/kbChat.js')

/** A streamed newline-delimited response, as the function produces. */
function ndjsonResponse(lines, { status = 200 } = {}) {
  const body = lines.map((l) => JSON.stringify(l) + '\n').join('')
  const encoder = new TextEncoder()
  return {
    ok: status < 400,
    status,
    headers: { get: (h) => (h === 'Content-Type' ? 'application/x-ndjson' : null) },
    body: {
      getReader() {
        let sent = false
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: encoder.encode(body) }
          },
        }
      },
    },
  }
}

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status < 400,
    status,
    headers: { get: (h) => (h === 'Content-Type' ? 'application/json' : null) },
    json: async () => payload,
  }
}

beforeEach(() => {
  state.session = { access_token: 'test-token' }
  state.lastFetch = null
  globalThis.fetch = vi.fn(async (url, opts) => {
    state.lastFetch = { url, opts }
    return state.response
  })
})

describe('the key never leaves the server', () => {
  it('calls the Edge Function, not a model provider', async () => {
    state.response = ndjsonResponse([{ type: 'delta', text: 'ok' }, { type: 'done' }])
    await askKnowledgeCenter({ question: 'anything' })
    expect(state.lastFetch.url).toContain('/functions/v1/kb-chat')
    // The two things that would mean the browser is talking to a provider.
    expect(state.lastFetch.url).not.toMatch(/nvidia|openai|groq/i)
    // The WHOLE request, not just the headers. An earlier version of this
    // assertion checked headers only, and a mutation that put the key in the
    // JSON body sailed straight past it — which is precisely the leak this
    // design exists to prevent.
    const whole = JSON.stringify({
      url: state.lastFetch.url,
      headers: state.lastFetch.opts.headers,
      body: state.lastFetch.opts.body,
    })
    expect(whole).not.toMatch(/sk-|nvapi|api[_-]?key/i)
  })

  it('sends only the question and the conversation, nothing else', async () => {
    state.response = ndjsonResponse([{ type: 'done' }])
    await askKnowledgeCenter({ question: 'q', history: [{ role: 'user', content: 'earlier' }] })
    expect(Object.keys(JSON.parse(state.lastFetch.opts.body)).sort()).toEqual(['history', 'question'])
  })

  it('sends the user’s own session token, so the function can apply their permissions', async () => {
    state.response = ndjsonResponse([{ type: 'done' }])
    await askKnowledgeCenter({ question: 'anything' })
    expect(state.lastFetch.opts.headers.Authorization).toBe('Bearer test-token')
  })

  it('refuses to ask at all when nobody is signed in', async () => {
    state.session = null
    await expect(askKnowledgeCenter({ question: 'x' })).rejects.toMatchObject({
      code: CHAT_UNAUTHORIZED,
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('reading the stream', () => {
  it('assembles the answer from its fragments', async () => {
    state.response = ndjsonResponse([
      { type: 'sources', sources: [{ n: 1, title: 'B660M Manual' }] },
      { type: 'delta', text: 'It supports ' },
      { type: 'delta', text: 'DDR4 only.' },
      { type: 'done' },
    ])
    const deltas = []
    let sources = null
    const answer = await askKnowledgeCenter({
      question: 'memory?',
      onSources: (s) => (sources = s),
      onDelta: (d) => deltas.push(d),
    })
    expect(answer).toBe('It supports DDR4 only.')
    expect(deltas).toEqual(['It supports ', 'DDR4 only.'])
    expect(sources[0].title).toBe('B660M Manual')
  })

  // Sources arrive first on purpose: someone who can see it is reading the
  // wrong datasheet stops reading before the answer finishes.
  it('reports sources before any answer text', async () => {
    state.response = ndjsonResponse([
      { type: 'sources', sources: [{ n: 1, title: 'A' }] },
      { type: 'delta', text: 'hello' },
      { type: 'done' },
    ])
    const order = []
    await askKnowledgeCenter({
      question: 'q',
      onSources: () => order.push('sources'),
      onDelta: () => order.push('delta'),
    })
    expect(order[0]).toBe('sources')
  })

  it('surfaces an error raised mid-stream instead of returning a half answer', async () => {
    state.response = ndjsonResponse([
      { type: 'delta', text: 'partial' },
      { type: 'error', message: 'upstream died' },
    ])
    await expect(askKnowledgeCenter({ question: 'q' })).rejects.toThrow('upstream died')
  })

  it('ignores a malformed line rather than abandoning the answer', async () => {
    const encoder = new TextEncoder()
    const body =
      'not json\n' +
      JSON.stringify({ type: 'delta', text: 'still here' }) +
      '\n' +
      JSON.stringify({ type: 'done' }) +
      '\n'
    state.response = {
      ok: true,
      status: 200,
      headers: { get: () => 'application/x-ndjson' },
      body: {
        getReader() {
          let sent = false
          return {
            read: async () => {
              if (sent) return { done: true }
              sent = true
              return { done: false, value: encoder.encode(body) }
            },
          }
        },
      },
    }
    expect(await askKnowledgeCenter({ question: 'q' })).toBe('still here')
  })
})

describe('the non-streamed replies', () => {
  // "Nothing relevant found" comes back as plain JSON, and must not be treated
  // as a failure — it is the correct answer to a question the documents do not
  // cover.
  it('accepts a plain JSON answer', async () => {
    state.response = jsonResponse({ answer: 'I could not find anything.', sources: [], grounded: false })
    const answer = await askKnowledgeCenter({ question: 'q' })
    expect(answer).toBe('I could not find anything.')
  })

  it('reports a missing deployment distinctly, since the fix is a deployment', async () => {
    state.response = jsonResponse({}, { status: 404 })
    await expect(askKnowledgeCenter({ question: 'q' })).rejects.toMatchObject({
      code: CHAT_UNAVAILABLE,
    })
  })

  it('passes the provider’s own message through', async () => {
    state.response = jsonResponse(
      { error: 'provider_error', message: 'model not found' },
      { status: 502 }
    )
    // "Model not found" and "quota exceeded" need completely different
    // responses from a person; collapsing both into "the AI failed" wastes an
    // afternoon.
    await expect(askKnowledgeCenter({ question: 'q' })).rejects.toThrow('model not found')
  })
})

describe('the Edge Function itself', () => {
  const fn = readFileSync('supabase/functions/kb-chat/index.ts', 'utf8')

  it('reads the key from the environment and never from the request', () => {
    expect(fn).toContain("Deno.env.get('KB_LLM_API_KEY')")
    expect(fn).not.toMatch(/body\.\s*apiKey|body\.key/)
  })

  it('refuses an unauthenticated caller before spending anything', () => {
    expect(fn).toContain("if (!authHeader) return json({ error: 'unauthorized' }, 401)")
    // And the guard must sit above the provider call, or an anonymous request
    // still costs a request.
    expect(fn.indexOf('unauthorized')).toBeLessThan(fn.indexOf('chat/completions'))
  })

  // The whole reason retrieval is server-side: a modified client could
  // otherwise feed the model any text and have the answer wear the company's
  // badge.
  it('retrieves under the caller’s own token, so RLS applies', () => {
    expect(fn).toContain('global: { headers: { Authorization: authHeader } }')
    expect(fn).toContain("from('product_documents')")
  })

  it('only ever reads documents whose text was actually extracted', () => {
    expect(fn).toContain("eq('extraction_status', 'ok')")
  })

  it('tells the model to answer only from the passages', () => {
    expect(fn).toContain('Use only the passages')
    expect(fn).toContain('Never guess a specification')
  })

  // Answered without calling the model at all: an empty context is exactly
  // where a model invents something plausible.
  it('answers "not found" itself rather than asking the model with no context', () => {
    expect(fn).toContain('if (chosen.length === 0)')
    expect(fn.indexOf('if (chosen.length === 0)')).toBeLessThan(fn.indexOf('chat/completions'))
  })

  it('bounds the question and the history it forwards', () => {
    expect(fn).toContain('question.length > 2000')
    expect(fn).toContain('.slice(-6)')
  })
})

describe('the configuration migration keeps the key out of the database', () => {
  const sql = readFileSync('supabase/migrations/20260802_kb_chat_config.sql', 'utf8')

  it('stores only the model and the endpoint', () => {
    expect(sql).toContain('kb_llm_model')
    expect(sql).toContain('kb_llm_base_url')
    expect(sql).not.toContain('kb_llm_api_key')
  })

  // rma_config is readable by every staff member and travels in backups, so a
  // key pasted here would be exposed twice over.
  it('refuses to apply if something key-shaped is already in config', () => {
    expect(sql).toContain("config_key LIKE 'kb_llm%'")
    expect(sql).toContain('length(config_value #>> ')
  })
})

/**
 * The verification script has to actually check the thing it claims.
 *
 * Its most important assertion is that no API key is in the database. A check
 * that looked only for a config key literally named "api_key" would pass with a
 * key sitting under kb_llm_model, so it also tests the VALUES.
 */
describe('the verification script checks for a leaked key by value, not just by name', () => {
  const sql = readFileSync('supabase/manual/20260846_verify_kb_chat.sql', 'utf8')

  it('looks for key-shaped values, not only key-shaped names', () => {
    expect(sql).toContain("config_value #>> '{}' ~ '^(sk-|nvapi-|gsk_)'")
    expect(sql).toContain('NO API KEY IS STORED IN THE DATABASE')
  })

  it('confirms documents are staff-only', () => {
    expect(sql).toContain("NOT has_table_privilege('anon', 'public.product_documents', 'SELECT')")
  })

  // A document marked searchable with nothing to search never appears in
  // results, and nothing on screen would explain why.
  it('catches a document that claims to be searchable but holds no text', () => {
    expect(sql).toContain("extraction_status = 'ok'")
    expect(sql).toContain('length(trim(extracted_text)) = 0')
  })

  it('is a single statement, so the editor shows all of it', () => {
    const stripped = sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''")
    expect(stripped.split(';').filter((c) => c.trim().length > 0)).toHaveLength(1)
  })
})

/**
 * The token budget.
 *
 * Caught from a screenshot of NVIDIA's own console: the model chosen is a
 * REASONING model, and their sample uses max_tokens 16384. This function was
 * written with 800 — ample for an ordinary model, and enough to produce an
 * EMPTY answer from a reasoning one, because the reasoning consumes the whole
 * allowance before a word of the reply is written.
 */
describe('the answer length budget suits a reasoning model', () => {
  const fn = readFileSync('supabase/functions/kb-chat/index.ts', 'utf8')

  it('is no longer the 800 that would silently truncate a thinking model', () => {
    expect(fn).not.toContain('max_tokens: 800')
    expect(fn).toContain('max_tokens: maxTokens')
  })

  it('defaults generously', () => {
    expect(fn).toContain('const DEFAULT_MAX_TOKENS = 4096')
  })

  it('is configurable without redeploying the function', () => {
    expect(fn).toContain('kb_llm_max_tokens')
  })

  // Clamped so a typo in a settings box cannot send an absurd request, or one
  // so small it can never answer.
  it('clamps whatever is configured to a sane range', () => {
    expect(fn).toContain('Math.max(Number(configured(\'kb_llm_max_tokens\')) || DEFAULT_MAX_TOKENS, 256)')
    expect(fn).toContain('32768')
  })
})

describe('the settings panel refuses to store a key', () => {
  const panel = readFileSync('src/pages/cp/setup/AiSettings.jsx', 'utf8')

  // The migration guards the database; this guards the moment someone would
  // actually do it — pasting a key into the model box.
  it('detects a key pasted into the model field and blocks the save', () => {
    expect(panel).toMatch(/\/\^\(nvapi-\|sk-\|gsk_\)\//)
    expect(panel).toContain('|| looksLikeKey')
  })

  it('offers no field for the key at all', () => {
    expect(panel).not.toMatch(/api[_-]?key.*<Input|<Input.*api[_-]?key/i)
    expect(panel).toContain('aiKeyWhyNotHere')
  })
})

/**
 * Latency, and why it was two minutes.
 *
 * The first real question took over two minutes to answer. The cause was not
 * retrieval — it was the model: a 550B reasoning model thinks at length before
 * emitting a visible word, and those tokens are neither streamed nor useful
 * for quoting a figure that is written in the passage in front of it.
 */
describe('thinking is off unless asked for', () => {
  const fn = readFileSync('supabase/functions/kb-chat/index.ts', 'utf8')

  it('defaults to not thinking', () => {
    expect(fn).toContain("String(configured('kb_llm_thinking') ?? 'false') === 'true'")
  })

  // Sent only when wanted. Providers that do not know the field generally
  // ignore it, but not sending it at all is the safer default.
  it('sends the provider flag only when thinking is enabled', () => {
    expect(fn).toContain('...(thinking ? { chat_template_kwargs: { enable_thinking: true } } : {})')
  })

  it('leaves it configurable, since a harder question may want it', () => {
    expect(fn).toContain("'kb_llm_thinking'")
  })
})

describe('source chips are one per document', () => {
  const chat = readFileSync('src/pages/_KnowledgeChat.jsx', 'utf8')

  // Three passages from one datasheet produced three identical chips, which
  // reads as a bug rather than as thoroughness.
  it('collapses repeated documents', () => {
    expect(chat).toContain('dedupeSources')
    expect(chat).toContain('byDoc.set(s.id')
  })

  // Found in testing: the first version showed only the LOWEST number, so an
  // answer citing [4] pointed at a chip labelled [1] and the reader had nothing
  // to check it against. Worse than the repeated chips it replaced, because it
  // looked correct.
  it('shows every passage number, not just the lowest', () => {
    expect(chat).toContain('formatCitations')
    expect(chat).not.toContain('Math.min(existing.n, s.n)')
  })

  it('renders a contiguous run as a range and gaps as a list', () => {
    const format = (nums) => {
      if (nums.length === 1) return String(nums[0])
      const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)
      return contiguous ? `${nums[0]}–${nums[nums.length - 1]}` : nums.join(', ')
    }
    expect(format([1, 2, 3, 4, 5])).toBe('1–5')
    expect(format([1, 3, 7])).toBe('1, 3, 7')
    expect(format([2])).toBe('2')
  })
})

/**
 * Turning a question into a search query.
 *
 * The bug this covers was found by asking a real question about a real
 * datasheet: the chat replied "I could not find anything about that in the
 * uploaded documents" while the search box found the very same document
 * instantly on one of the words in that question.
 *
 * The cause was that the whole question went to websearch_to_tsquery, which
 * ANDs its terms — and the index uses the 'simple' configuration, which has no
 * stop-word list, so "what", "is", "the" and "of" were all REQUIRED. Nothing
 * could ever match, and the failure looked exactly like a document that had
 * not been read.
 */
describe('a question becomes a query that can actually match', () => {
  const fn = readFileSync('supabase/functions/kb-chat/index.ts', 'utf8')

  it('no longer passes the raw question to full-text search', () => {
    expect(fn).not.toContain("textSearch('search_vector', question,")
    expect(fn).toContain('questionToQuery(question)')
  })

  it('drops the filler words that the simple configuration would treat as required', () => {
    expect(fn).toContain('const STOP_WORDS')
    for (const w of ['what', 'is', 'the', 'of']) {
      expect(fn).toContain(`'${w}'`)
    }
  })

  // OR, not AND: any meaningful term brings a document into the running, and
  // the passage scoring afterwards decides what is actually relevant.
  it('joins the surviving terms with OR', () => {
    expect(fn).toContain("join(' or ')")
  })

  // "what is it?" is all stop words. An empty tsquery throws, which would turn
  // a vague question into a server error.
  it('falls back to the raw question when every word is a stop word', () => {
    expect(fn).toContain('if (terms.length === 0) return question.trim()')
  })

  it('caps the number of terms so a rambling question cannot build a huge query', () => {
    expect(fn).toContain('.slice(0, 24)')
  })
})

/**
 * The reference implementation, so the term extraction is tested as behaviour
 * and not only as text. Mirrors questionToQuery in the function.
 */
describe('term extraction, by example', () => {
  const STOP = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for',
    'from', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its', 'me', 'much',
    'of', 'on', 'or', 'our', 'that', 'the', 'their', 'there', 'these', 'this',
    'to', 'was', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
    'with', 'you', 'your',
  ])
  const toQuery = (q) => {
    const terms = q
      .toLowerCase()
      .split(/[^a-z0-9.+/-]+/i)
      .map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, ''))
      .filter((w) => w.length >= 2 && !STOP.has(w))
    if (terms.length === 0) return q.trim()
    return [...new Set(terms)].slice(0, 24).join(' or ')
  }

  it('keeps only the words that identify something', () => {
    expect(toQuery('what is the brightness and refresh rate of the 24G4E monitor?')).toBe(
      'brightness or refresh or rate or 24g4e or monitor'
    )
  })

  // Part numbers are the most valuable search terms in a datasheet library and
  // must survive tokenisation intact.
  it('preserves part numbers and units', () => {
    expect(toQuery('TDP of ASX6000PNP-512GT-C?')).toBe('tdp or asx6000pnp-512gt-c')
    expect(toQuery('is it PCIe 4.0 or M.2 2280')).toContain('4.0')
    expect(toQuery('is it PCIe 4.0 or M.2 2280')).toContain('m.2')
  })

  it('de-duplicates repeated words', () => {
    expect(toQuery('monitor monitor monitor brightness')).toBe('monitor or brightness')
  })

  it('does not produce an empty query from an all-stop-word question', () => {
    expect(toQuery('what is it?')).toBe('what is it?')
    expect(toQuery('   ')).toBe('')
  })
})

/**
 * Sources must reach the screen before the provider is contacted.
 *
 * Measured: they took fifteen seconds to appear. The cause was ordering — the
 * function awaited the upstream connection and only then built the response
 * stream, so "sources first" was true within the stream and false in
 * wall-clock time. Retrieval is a database query; its result belongs on screen
 * in about a second.
 */
describe('sources are not gated behind the model', () => {
  const fn = readFileSync('supabase/functions/kb-chat/index.ts', 'utf8')

  it('enqueues the sources before the provider fetch', () => {
    const sourcesAt = fn.indexOf("type: 'sources'")
    const fetchAt = fn.indexOf('chat/completions')
    expect(sourcesAt).toBeGreaterThan(-1)
    expect(sourcesAt).toBeLessThan(fetchAt)
  })

  it('does the provider fetch inside the stream, not before building it', () => {
    const streamAt = fn.indexOf('new ReadableStream')
    expect(streamAt).toBeLessThan(fn.indexOf('chat/completions'))
  })

  // A provider failure now happens after the stream has opened, so it has to
  // arrive as a stream event rather than an HTTP error the client never sees.
  it('reports a provider failure through the stream once it has opened', () => {
    expect(fn).toContain('Could not reach the model provider')
    expect(fn).toContain('provider returned ${upstream.status}')
    expect(fn).toContain("type: 'error'")
  })

  /**
   * BUG-021. The provider's own response body used to be forwarded to the
   * browser, as `Provider returned ${status}: ${detail.slice(0, 400)}`. That
   * body can carry request ids, quota figures and account identifiers, and the
   * person who needs them is whoever reads the function logs — not whoever
   * asked a question in the Knowledge Center.
   *
   * The status code still reaches the user, because "the provider said 429" is
   * actionable and leaks nothing. The body is logged instead.
   */
  it('logs the provider response body rather than streaming it to the client', () => {
    expect(fn).toContain('console.error(`[kb-chat] provider ${upstream.status}')
    // No fail() message may interpolate the provider's body.
    expect(fn).not.toMatch(/fail\(`[^`]*\$\{detail/)
  })
})

describe('the search filters', () => {
  const explorer = readFileSync('src/pages/_KnowledgeExplorer.jsx', 'utf8')
  const page = readFileSync('src/pages/KnowledgeCenter.jsx', 'utf8')

  // BUG-066: the explorer used to build its tree from every product and
  // document loaded into the browser. What it filters and counts is now pinned
  // request by request in knowledgeLists.test.js, and the placement rules in
  // supabase/tests/knowledge_explorer_views.sql. These keep the screen from
  // drifting back to whole-library reads.
  it('reads folders, pages and counts from the database, not a tree built in the browser', () => {
    expect(explorer).toContain('db.knowledgeLists.browsePage(')
    expect(explorer).toContain('db.knowledgeLists.documentsPage(')
    expect(explorer).toContain('db.knowledgeLists.folderStats(')
    expect(explorer).not.toContain('buildTree(')
    expect(explorer).not.toContain('db.products.list(')
  })

  it('checks the library is provisioned without reading it', () => {
    expect(page).toContain('db.knowledgeLists.isProvisioned()')
    expect(page).not.toContain('listAll(')
  })
})
