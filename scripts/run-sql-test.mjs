#!/usr/bin/env node
/**
 * Run one supabase/tests/*.sql reference script against the staging project.
 *
 *   node scripts/run-sql-test.mjs supabase/tests/server_audit_log.sql BL02_TEST_DONE
 *
 * The scripts print PASS/FAIL lines with RAISE NOTICE and end with a
 * deliberate RAISE EXCEPTION carrying a marker, which is what forces the
 * rollback. This runner wraps the script in a transaction, prints every
 * NOTICE, treats the marker as success of the harness (not of the checks) and
 * exits non-zero if any line starts with FAIL or the script died before the
 * marker.
 *
 * Reads the connection parameters from .env.staging (git-ignored):
 * SUPABASE_DB_HOST / _PORT / _USER / _PASSWORD / _NAME, passed to pg as
 * discrete fields so a password with special characters needs no URL-encoding.
 * Refuses to run against anything but the staging project ref.
 */
import { readFile } from 'node:fs/promises'
import pg from 'pg'

const STAGING_USER_SUFFIX = 'jiuuylvqsuzzxpptjcnm'

const [file, marker] = process.argv.slice(2)
if (!file || !marker) {
  console.error('usage: node scripts/run-sql-test.mjs <sql file> <end marker>')
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

let pass = 0
let fail = 0
client.on('notice', (msg) => {
  const text = msg.message
  if (text.startsWith('PASS')) pass++
  if (text.startsWith('FAIL')) fail++
  console.log(text)
})

await client.connect()
await client.query('begin')
let reachedMarker = false
try {
  await client.query(await readFile(file, 'utf8'))
} catch (err) {
  if (err.message.includes(marker)) {
    reachedMarker = true
    // Some scripts also carry every PASS/FAIL line in the marker's message (for
    // runners that do not show notices). Count those too: a runner that read
    // only notices reported such a script as passing while two checks failed.
    for (const line of err.message.split(/\r?\n/)) {
      const t = line.trim()
      if (t.startsWith('PASS')) pass++
      if (t.startsWith('FAIL')) { fail++; console.log(t) }
    }
  }
  else console.error(`SCRIPT DIED BEFORE THE MARKER: ${err.message}`)
}
await client.query('rollback')
await client.end()

console.log(`\n${pass} passed, ${fail} failed${reachedMarker ? '' : ', script did not finish'}`)
process.exit(fail === 0 && reachedMarker && pass > 0 ? 0 : 1)
