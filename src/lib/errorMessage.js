import i18next from 'i18next'

/**
 * Turns a thrown error into something a person can act on.
 *
 * Forty call sites passed the raw error straight to a toast, which put whatever Postgres
 * or PostgREST said straight on screen — constraint names, RLS refusals, JWT
 * internals (UX-GLOBAL-005). A user reading
 * "duplicate key value violates unique constraint \\"customers_email_key\\""
 * learns nothing they can do something about, and it leaks schema detail.
 *
 * Uses the i18n instance directly rather than a `t` passed in, so it works from
 * plain modules and event handlers, not only from components.
 *
 * ── What is deliberately NOT translated ─────────────────────────────────────
 *
 * Errors the application raised on purpose. Anything from a Postgres
 * `RAISE EXCEPTION` (code P0001) or an Edge Function is already written for a
 * human by whoever wrote that guard — "You cannot delete your own account",
 * "That address already has a pending invitation". Replacing those with a
 * generic sentence would lose the only useful part. Only the database's own
 * machine-generated errors are mapped.
 */

/** Postgres error codes worth explaining, per class. */
const BY_CODE = {
  '23505': 'duplicate', // unique_violation
  '23503': 'inUse', // foreign_key_violation
  '23502': 'missingRequired', // not_null_violation
  '23514': 'notAllowed', // check_violation
  '22P02': 'badValue', // invalid_text_representation
  '22001': 'tooLong', // string_data_right_truncation
  '42501': 'noPermission', // insufficient_privilege
  '40001': 'conflict', // serialization_failure
  PGRST301: 'sessionExpired',
  PGRST116: 'notFound',
}

/** Patterns for errors that carry no usable code. */
const BY_PATTERN = [
  [/row-level security|violates row-level security/i, 'noPermission'],
  [/jwt|token .*expired|invalid claim/i, 'sessionExpired'],
  [/failed to fetch|network ?error|load failed/i, 'network'],
  [/rate limit/i, 'rateLimited'],
]

export function toUserMessage(err) {
  // The i18next singleton, not the app's ./i18n module. Importing that module
  // runs its init() as a side effect, which breaks any test that mocks
  // react-i18next — and a message formatter has no business booting i18n.
  // The app configures this same singleton at startup.
  const t = (k) => i18next.t(`errors.${k}`)
  if (!err) return t('generic')

  const raw = typeof err === 'string' ? err : err.message || ''
  const code = err.code || err.status

  // An error the app raised on purpose already reads as a sentence. Postgres
  // uses P0001 for RAISE EXCEPTION; Edge Functions return plain prose.
  if (code === 'P0001') return raw || t('generic')

  const key = BY_CODE[String(code)]
  if (key) return t(key)

  for (const [pattern, k] of BY_PATTERN) {
    if (pattern.test(raw)) return t(k)
  }

  // Anything still containing database vocabulary is machine output, not copy.
  if (/constraint|relation|column|violates|pg_|duplicate key|syntax error/i.test(raw)) {
    return t('generic')
  }

  return raw || t('generic')
}
