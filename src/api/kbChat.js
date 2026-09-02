import { supabase, supabaseUrl } from './client.js'

/**
 * Talking to the Knowledge Center's answer engine.
 *
 * Goes through the kb-chat Edge Function rather than to the model provider
 * directly. The reason is not architectural tidiness: calling the provider from
 * here would put the API key in this bundle, where anyone who opens developer
 * tools can read it and spend the quota from their own machine.
 *
 * The function is given the user's own session token and does its own retrieval
 * under that identity, so a person cannot be answered from a document they are
 * not allowed to read.
 */

export const CHAT_NOT_CONFIGURED = 'not_configured'
export const CHAT_UNAUTHORIZED = 'unauthorized'
export const CHAT_PROVIDER_ERROR = 'provider_error'
export const CHAT_UNAVAILABLE = 'unavailable'

/**
 * Ask a question and receive the answer as it is written.
 *
 * Streaming rather than a single response because retrieval plus generation
 * takes several seconds, and a blank screen for five seconds reads as broken
 * where the same wait with words appearing does not.
 *
 * Calls `onSources` once with what is being read from, then `onDelta` for each
 * fragment. Returns the complete answer, or throws an Error carrying a `code`
 * from the constants above so the caller can say something specific.
 */
export async function askKnowledgeCenter({ question, history = [], signal, onSources, onDelta }) {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData?.session?.access_token
  if (!token) {
    const err = new Error('Not signed in')
    err.code = CHAT_UNAUTHORIZED
    throw err
  }

  let response
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/kb-chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history }),
      signal,
    })
  } catch (err) {
    // An aborted request is the user changing their mind, not a failure.
    if (err.name === 'AbortError') throw err
    const wrapped = new Error('Could not reach the answer engine')
    wrapped.code = CHAT_UNAVAILABLE
    throw wrapped
  }

  // The function has not been deployed. Worth its own code, because the fix is
  // a deployment and not anything the person asking can do.
  if (response.status === 404) {
    const err = new Error('The kb-chat function is not deployed')
    err.code = CHAT_UNAVAILABLE
    throw err
  }

  const contentType = response.headers.get('Content-Type') ?? ''

  // Errors and the "nothing found" case come back as plain JSON rather than a
  // stream.
  if (!contentType.includes('x-ndjson')) {
    let payload = {}
    try {
      payload = await response.json()
    } catch {
      /* fall through to the generic error below */
    }

    if (response.ok && payload.answer) {
      onSources?.(payload.sources ?? [])
      onDelta?.(payload.answer)
      return payload.answer
    }

    const err = new Error(payload.message || 'The answer engine returned an error')
    err.code = payload.error || CHAT_PROVIDER_ERROR
    err.status = response.status
    throw err
  }

  // ── The stream ────────────────────────────────────────────────────────────
  // Newline-delimited JSON, one object per line. Chosen over Server-Sent Events
  // because it needs no special client and a half-received line is trivially
  // detectable — it simply has not ended yet.
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    // The last element is whatever arrived after the final newline: an
    // incomplete line, which must wait for the rest rather than be parsed.
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'sources') onSources?.(event.sources ?? [])
      else if (event.type === 'delta') {
        answer += event.text
        onDelta?.(event.text)
      } else if (event.type === 'error') {
        const err = new Error(event.message || 'The answer stopped unexpectedly')
        err.code = CHAT_PROVIDER_ERROR
        throw err
      }
    }
  }

  return answer
}
