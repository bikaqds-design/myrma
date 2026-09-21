#!/usr/bin/env node
/**
 * Provision a Supabase project from the baseline files.
 *
 * WHY THIS EXISTS
 *
 * Every SaaS tenant gets its own Supabase project (see docs/SAAS_UPGRADE_PLAN.md).
 * A tenant project must therefore be creatable from source, repeatably, with no
 * Docker and no dashboard clicking:
 *
 *   supabase/migrations/00000000_baseline_schema.sql         -- structure
 *   supabase/migrations/00000001_baseline_reference_data.sql -- currencies, countries, rma_config
 *   supabase/migrations/00000002_baseline_seed_data.sql      -- sequences, system warehouses, templates
 *
 * The historical migrations (20260524…) must NOT be replayed afterwards: the
 * baseline already reflects their end state, and re-running them would re-apply
 * ALTERs against a schema that has them. This script therefore applies exactly
 * the baseline files, in order, and nothing else.
 *
 * ALL of them run in ONE transaction: a failure in the last file rolls the
 * whole project back to empty, so a re-run starts clean. (The schema file is
 * not re-runnable -- its ADD CONSTRAINT and CREATE POLICY statements are
 * unguarded -- so applying it file-by-file left a half-provisioned project
 * that only a schema drop could recover.)
 *
 * --no-seed skips 00000002 (rows the app assumes exist). Use it when the
 * project will be filled from a BACKUP: the restore upserts on primary key
 * only, so a backup row with the same natural key under a different id
 * (a warehouse code, a pipeline name, a template name) is a unique violation
 * and the whole restore rolls back. After such a restore run
 *   SELECT public.rma_reconcile_document_sequences();
 * as an administrator: a backup cannot carry the document counters.
 *
 * USAGE
 *
 *   node scripts/provision-project.mjs --db-url "postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres"
 *   SUPABASE_DB_URL="postgresql://…" node scripts/provision-project.mjs
 *
 * Add --dry-run to connect and report the target's current state without writing.
 *
 * SAFETY
 *
 * Refuses to run against a database that already has application tables unless
 * --force is passed, so it cannot be pointed at production by accident. The
 * files run in one transaction: a failure leaves nothing half-applied.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = path.join(HERE, '..', 'supabase', 'migrations')
const SEED_FILE = '00000002_baseline_seed_data.sql'
const ALL_FILES = ['00000000_baseline_schema.sql', '00000001_baseline_reference_data.sql', SEED_FILE]

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const hasFlag = (name) => process.argv.includes(`--${name}`)
const FILES = hasFlag('no-seed') ? ALL_FILES.filter((f) => f !== SEED_FILE) : ALL_FILES

const dbUrl = arg('db-url') || process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error(
    'No connection string. Pass --db-url "postgresql://…" or set SUPABASE_DB_URL.\n' +
      'Find it in the Supabase dashboard: Project Settings → Database → Connection string (URI).'
  )
  process.exit(1)
}

/** Counts that say whether a database is empty, freshly provisioned, or in use. */
const FINGERPRINT = `
  select
    (select count(*) from pg_tables where schemaname = 'public') as tables,
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public') as functions,
    (select count(*) from pg_policies where schemaname = 'public') as policies,
    (select count(*) from pg_views where schemaname = 'public') as views
`

async function fingerprint(client) {
  const { rows } = await client.query(FINGERPRINT)
  return rows[0]
}

async function main() {
  const client = new pg.Client({
    connectionString: dbUrl,
    // Supabase terminates TLS with a certificate this client does not have in
    // its trust store; the connection is still encrypted.
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()

  const before = await fingerprint(client)
  console.log(
    `Target before: ${before.tables} tables, ${before.functions} functions, ` +
      `${before.policies} policies, ${before.views} views`
  )

  if (hasFlag('dry-run')) {
    await client.end()
    return
  }

  if (Number(before.tables) > 0 && !hasFlag('force')) {
    await client.end()
    console.error(
      `\nRefusing to run: the target already has ${before.tables} tables in public.\n` +
        'Provisioning is for a NEW project. Pass --force only if you are certain.'
    )
    process.exit(1)
  }

  await client.query('begin')
  for (const file of FILES) {
    const sql = await readFile(path.join(MIGRATIONS, file), 'utf8')
    process.stdout.write(`Applying ${file} … `)
    try {
      await client.query(sql)
      console.log('ok')
    } catch (err) {
      await client.query('rollback')
      console.log('failed')
      console.error(err.message)
      console.error('\nEverything was rolled back; the target is as it was. Fix the cause and re-run.')
      await client.end()
      process.exit(1)
    }
  }
  await client.query('commit')

  const after = await fingerprint(client)
  console.log(
    `Target after:  ${after.tables} tables, ${after.functions} functions, ` +
      `${after.policies} policies, ${after.views} views`
  )

  // The baseline header records what it emits; a wildly different count means
  // the file and the target have drifted apart and the result is not trustworthy.
  const EXPECTED_MIN_TABLES = 60
  if (Number(after.tables) < EXPECTED_MIN_TABLES) {
    console.error(
      `\nOnly ${after.tables} tables after provisioning; the baseline expects at least ${EXPECTED_MIN_TABLES}. Investigate before using this project.`
    )
    await client.end()
    process.exit(1)
  }

  await client.end()
  console.log('\nProvisioned. Next: create the first admin with supabase/manual/BOOTSTRAP_first_admin.sql.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
