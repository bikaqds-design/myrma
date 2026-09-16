// @vitest-environment node
/**
 * sessionsEndOnAccessLoss.test.js — ending sessions is the database's job.
 *
 * Suspension used to revoke sessions from the browser, after the status write,
 * best-effort, and only for 'suspended'/'locked'. 20260870 moved it into a
 * trigger on user_roles plus a 15-minute sweep. The behaviour was proven by a
 * rolled-back probe on production (see AUDIT_REPORT BUG-049). What is pinned
 * here is what that probe cannot guard: that the rules stay as written, and
 * that the browser path does not quietly come back half-done.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260870_revoke_sessions_on_access_loss.sql', 'utf8')
const users = readFileSync('src/api/db/users.ts', 'utf8')

/** SQL with `-- …` comments removed, so a rule is asserted on code, never on prose about it. */
const code = (text) => text.replace(/--[^\n]*/g, '')

/** The trigger function's code, without its comments. */
const triggerBody = (() => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.rma_user_roles_end_sessions_on_access_loss()')
  const end = sql.indexOf('$fn$;', start)
  return code(sql.slice(start, end))
})()

describe('the trigger', () => {
  it('fires after status, expiry and email changes, and on delete', () => {
    expect(sql).toMatch(/AFTER UPDATE OF status, access_expires_at, user_email OR DELETE ON public\.user_roles/)
  })

  it('ends sessions for every status that grants nothing', () => {
    expect(triggerBody).toContain("NEW.status IN ('suspended', 'locked', 'deactivated')")
  })

  it('never ends sessions for pending — an invitee signs in while pending', () => {
    expect(triggerBody).not.toContain("'pending'")
  })

  it('ends sessions for an expiry already in the past, a changed email and a deleted row', () => {
    expect(triggerBody).toMatch(/NEW\.access_expires_at <= now\(\)/)
    expect(triggerBody).toMatch(/NEW\.user_email IS DISTINCT FROM OLD\.user_email[\s\S]{0,120}OLD\.user_email/)
    expect(triggerBody).toMatch(/TG_OP = 'DELETE'[\s\S]{0,120}OLD\.user_email/)
  })
})

describe('the sweep', () => {
  it('runs every 15 minutes and skips pending users and logins without a role row', () => {
    expect(sql).toContain("'end-sessions-without-access',\n    '*/15 * * * *'")
    const sweep = sql.slice(sql.indexOf('FUNCTION public.rma_end_sessions_without_access()'))
    expect(sweep).toContain("<> 'pending'")
    expect(sweep).toMatch(/USING auth\.users u, public\.user_roles ur/)
    expect(sweep).toContain('NOT public.rma_access_is_current(ur.status, ur.access_expires_at)')
  })
})

describe('no client can end someone else’s sessions through the new functions', () => {
  it('revokes EXECUTE from anon and authenticated, and refuses to finish otherwise', () => {
    for (const fn of ['rma_end_sessions_for_email(text)', 'rma_end_sessions_without_access()']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM anon, authenticated`)
    }
    expect(sql).toMatch(/has_function_privilege\('authenticated', 'public\.rma_end_sessions_for_email\(text\)'/)
  })
})

describe('the browser no longer does it', () => {
  it('updateUserStatus does not call a revoke RPC — the trigger does it in the same transaction', () => {
    const fn = users.slice(users.indexOf('async updateUserStatus('), users.indexOf('async setUserExpiration('))
    expect(fn).not.toMatch(/rpc\(/)
  })
})
