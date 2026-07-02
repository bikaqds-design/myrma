// Origin allowlist for browser-invoked Edge Functions (audit HIGH-4 residual —
// every function previously hardcoded 'Access-Control-Allow-Origin': '*').
//
// Set the ALLOWED_ORIGINS secret (comma-separated, e.g.
// "https://app.example.com,https://staging.example.com") in the Supabase
// project to restrict which origins may read these functions' responses from
// a browser. Falls back to '*' if the secret is unset, so nothing breaks
// until it's configured — this is opt-in hardening, not a breaking change.
//
// Standard "reflect if allowed" pattern: the Origin header is echoed back
// only when it's on the allowlist (required — the browser rejects a literal
// wildcard when the request carries credentials/auth headers on some
// configurations, and reflecting an unlisted origin would defeat the point).
// An unlisted origin gets NO Access-Control-Allow-Origin header at all,
// which makes the browser block reading the response — the correct failure
// mode, as opposed to echoing a value that falsely grants access.
export function corsOriginHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  const origin = req.headers.get('Origin') ?? ''
  const headers: Record<string, string> = { Vary: 'Origin' }

  if (allowed.length === 0) {
    headers['Access-Control-Allow-Origin'] = '*'
  } else if (allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  // else: no Access-Control-Allow-Origin header — browser blocks the response

  return headers
}
