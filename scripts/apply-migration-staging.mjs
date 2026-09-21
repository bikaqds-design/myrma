#!/usr/bin/env node
/**
 * Apply one migration file to the STAGING project inside a transaction.
 *
 *   node scripts/apply-migration-staging.mjs supabase/migrations/20260876_x.sql
 *
 * Staging only: refuses to run unless .env.staging points at the staging
 * project. Production migrations go through the owner's explicit OK and are
 * never applied by this script.
 */
import { readFile } from 'node:fs/promises'
import pg from 'pg'

const STAGING_USER_SUFFIX = 'jiuuylvqsuzzxpptjcnm'

const [file] = process.argv.slice(2)
if (!file) {
  console.error('usage: node scripts/apply-migration-staging.mjs <migration.sql>')
  process.exit(2)
}

const env = {}
for (const line of (await readFile('.env.staging', 'utf8')).replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2]
}
if (!env.SUPABASE_DB_USER?.endsWith(STAGING_USER_SUFFIX)) {
  console.error('Refusing to run: .env.staging does not point at the staging project.')
  process.exit(2)
}

const client = new pg.Client({
  host: env.SUPABASE_DB_HOST,
  port: Number(env.SUPABASE_DB_PORT),
  user: env.SUPABASE_DB_USER,
  password: env.SUPABASE_DB_PASSWORD,
  database: env.SUPABASE_DB_NAME,
  ssl: { rejectUnauthorized: false },
})
await client.connect()
await client.query('begin')
try {
  await client.query(await readFile(file, 'utf8'))
  await client.query('commit')
  console.log(`applied ${file}`)
} catch (err) {
  await client.query('rollback')
  console.error(`FAILED, rolled back: ${err.message}`)
  process.exitCode = 1
}
await client.end()
