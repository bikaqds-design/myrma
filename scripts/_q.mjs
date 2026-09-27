import { readFile } from 'node:fs/promises'
import pg from 'pg'
const env = {}
for (const line of (await readFile('.env.staging', 'utf8')).replace(/^﻿/, '').split(/\r?\n/)) { const m = line.match(/^([A-Za-z_]+)=(.*)$/); if (m) env[m[1]] = m[2] }
const c = new pg.Client({ host: env.SUPABASE_DB_HOST, port: env.SUPABASE_DB_PORT, user: env.SUPABASE_DB_USER, password: env.SUPABASE_DB_PASSWORD, database: env.SUPABASE_DB_NAME, ssl: { rejectUnauthorized: false } })
await c.connect()
const r = await c.query(process.argv[2])
console.log(r.rows.map(x => Object.values(x).join(' | ')).join('\n'))
await c.end()
