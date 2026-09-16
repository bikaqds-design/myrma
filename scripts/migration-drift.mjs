// No `#!/usr/bin/env node` line: on a Windows checkout (CRLF) Vitest fails to
// import a module that starts with one ("Invalid or unexpected token"), which
// broke src/test/migrationDrift.test.js locally while CI on Linux stayed green.
// Run it as `node scripts/migration-drift.mjs`.
/**
 * migration-drift.mjs — does production's migration ledger match the files?
 * (Audit finding BUG-014.)
 *
 * The ledger drifted twice: once to a single row for 156 files, and again to
 * forty-three rows recorded under generated timestamps, because a migration
 * applied through the dashboard or MCP `apply_migration` is not recorded under
 * its file's version. Either way `supabase db push` stops telling the truth
 * about what is applied, and nothing noticed, because nothing compared them.
 *
 * Reports three kinds of drift, each of which fails the run:
 *   - a file whose version production has not recorded (not applied, or
 *     applied under the wrong version);
 *   - a version production has recorded with no file (a change made outside
 *     the migrations, or a row left under a generated timestamp);
 *   - two files sharing one version — `version` is the ledger's primary key,
 *     so only one of them could ever be recorded (the original BUG-014 cause).
 *
 * Reads production through `rma_applied_migration_versions()` (20260868) with
 * the anon key the integration tier already uses. With no URL or key in the
 * environment — a fork, or a local run — it says so and exits 0: there is
 * nothing to compare against. With them present, failing to read production
 * is an ERROR, not a skip; a check that turns itself off when it breaks is
 * worse than no check.
 */
import { readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The version a migration file is recorded under: everything before the first underscore. */
export function versionOf(fileName) {
  const m = /^(\d+)_.+\.sql$/.exec(fileName)
  return m ? m[1] : null
}

/**
 * Compare migration file names with the versions production has applied.
 * Pure, so the rules are unit-tested without a database.
 */
export function compareMigrations(fileNames, appliedVersions) {
  const byVersion = new Map()
  const unversioned = []
  for (const name of fileNames) {
    if (!name.endsWith('.sql')) continue
    const v = versionOf(name)
    if (!v) {
      unversioned.push(name)
      continue
    }
    byVersion.set(v, [...(byVersion.get(v) ?? []), name])
  }

  const applied = new Set(appliedVersions)
  const unapplied = [...byVersion.entries()]
    .filter(([v]) => !applied.has(v))
    .map(([, names]) => names[0])
    .sort()
  const unknown = [...applied].filter((v) => !byVersion.has(v)).sort()
  const duplicates = [...byVersion.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([v, names]) => ({ version: v, files: [...names].sort() }))
    .sort((a, b) => a.version.localeCompare(b.version))

  return {
    unapplied,
    unknown,
    duplicates,
    unversioned: unversioned.sort(),
    ok: !unapplied.length && !unknown.length && !duplicates.length && !unversioned.length,
  }
}

/** Human-readable report; one line per problem so a CI log is scannable. */
export function formatReport(result, { files, applied }) {
  const lines = [`Migration files: ${files}. Versions applied in production: ${applied}.`]
  if (result.ok) {
    lines.push('No drift: every file is applied under its own version, and every applied version has a file.')
    return lines.join('\n')
  }
  for (const f of result.unapplied)
    lines.push(`NOT APPLIED  ${f}  — production has no row for this version (unapplied, or recorded under another version)`)
  for (const v of result.unknown)
    lines.push(`NO FILE      ${v}  — production has this version but no migration file carries it`)
  for (const d of result.duplicates)
    lines.push(`DUPLICATE    ${d.version}  — ${d.files.join(', ')} share one version; only one can be recorded`)
  for (const f of result.unversioned)
    lines.push(`BAD NAME     ${f}  — not <digits>_<name>.sql, so it has no version`)
  return lines.join('\n')
}

async function main() {
  const url = process.env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) {
    // A `::warning::` line becomes an annotation on the run's summary page, so
    // a skip is visible without opening the log. If these secrets were ever
    // removed from the repository, a quiet green skip would look exactly like
    // "no drift" for as long as nobody looked.
    const msg = 'Migration drift check SKIPPED: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set (a fork or a local run). Nothing was compared.'
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg)
    return 0
  }

  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql'))

  let applied
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/rma_applied_migration_versions`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
    applied = JSON.parse(body)
    if (!Array.isArray(applied)) throw new Error(`expected an array of versions, got: ${body.slice(0, 200)}`)
  } catch (err) {
    console.error(`Could not read production's migration versions: ${err.message}`)
    console.error('This is a failure, not a skip — the check would otherwise go quiet exactly when it breaks.')
    return 1
  }

  const result = compareMigrations(files, applied)
  const report = formatReport(result, { files: files.length, applied: applied.length })
  if (result.ok) {
    console.log(report)
    return 0
  }
  console.error(report)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code))
}
