// serverPermissionCatalog.test.js — W6 / S-01 (20260914). The database enforces
// the permission matrix: permission_catalog lists each action it checks, the
// roles that have it by default and the functions that check it first. Those
// defaults must be what the app shows (ROLE_DEFAULT_PERMISSIONS), or an admin's
// editor would say one thing and the server do another. The database behaviour
// is proved by supabase/tests/permission_catalog.sql (23 checks, rolled back).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { ROLE_DEFAULT_PERMISSIONS, canDo } from '../lib/permissions'
import { permissionSchema } from '../lib/permissionCatalog'
import { permissionOverrides } from '../pages/UserManagement/_utils'
import en from '../locales/en.json'
import ar from '../locales/ar.json'

const sql = readFileSync('supabase/migrations/20260914_permission_catalog.sql', 'utf8').replace(/\r\n/g, '\n')
const rows = [...sql.matchAll(/\('(\w+)', '(\w+)', '([^']+)', '\{([^}]*)\}',\s*'\{([^}]*)\}'\)/g)].map((m) => ({
  section: m[1],
  action: m[2],
  label: m[3],
  roles: m[4] ? m[4].split(',') : [],
  functions: m[5].split(','),
}))
const ROLES_CHECKED = ['manager', 'accountant', 'technician', 'viewer', 'sales_rep']

describe('20260914 — the catalog', () => {
  it('reads all nineteen actions from the migration', () => {
    expect(rows).toHaveLength(19)
    expect(new Set(rows.map((r) => `${r.section}.${r.action}`)).size).toBe(19)
  })

  it('each role has by default exactly what the app shows it', () => {
    for (const r of rows) {
      for (const role of ROLES_CHECKED) {
        expect(canDo(role, ROLE_DEFAULT_PERMISSIONS[role], r.section, r.action), `${role} ${r.section}.${r.action}`)
          .toBe(r.roles.includes(role))
      }
    }
  })

  it('every catalogued action is in the permission editor, labelled in both languages', () => {
    const schema = permissionSchema()
    for (const r of rows) {
      expect(schema[r.section], r.section).toContain(r.action)
      expect(en.userManagement[`action_${r.action}`], r.action).toBeTruthy()
      expect(ar.userManagement[`action_${r.action}`], r.action).toBeTruthy()
    }
  })

  it('the editor warns when a grant is beyond the role guard', () => {
    const roles = readFileSync('src/pages/UserManagement/RolesTab.jsx', 'utf8')
    for (const r of rows) expect(roles, `${r.section}.${r.action}`).toContain(`'${r.section}.${r.action}':`)
  })

  it('every catalogued function is one a migration defines, and none is listed twice', () => {
    const all = readdirSync('supabase/migrations').map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n')
    const fns = rows.flatMap((r) => r.functions)
    expect(new Set(fns).size).toBe(fns.length)
    for (const f of fns) expect(all, f).toMatch(new RegExp(`FUNCTION public\\.${f}\\(`))
  })
})

describe('20260914 — how it is enforced', () => {
  it('an override counts only as a real boolean; a custom role uses its own map; admins always pass', () => {
    const f = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.rma_has_permission'), sql.indexOf('CREATE OR REPLACE FUNCTION public.rma_require_permission'))
    expect(f).toContain("jsonb_typeof(me.permissions -> p_section -> p_action) = 'boolean'")
    expect(f).toContain('me.custom_defaults IS NOT NULL')
    expect(f).toContain('WHEN COALESCE(public.rma_is_admin(), false) THEN true')
    expect(f).toContain('public.rma_access_is_current(ur.status, ur.access_expires_at)')
    expect(f).toContain('), false)\n  END')
  })

  it('refuses with 42501 and leaves a call with no login to the function\'s own guard', () => {
    const f = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.rma_require_permission'))
    expect(f).toContain("USING ERRCODE = 'insufficient_privilege'")
    expect(f).toContain('IF public.rma_current_user_email() IS NULL THEN\n    RETURN;')
    expect(f).toContain("RAISE EXCEPTION 'Unknown permission %.%'")
  })

  it('only the definer functions can run the check; nobody writes the catalog', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.rma_require_permission(text, text) FROM PUBLIC, anon, authenticated;')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.rma_has_permission(text, text) FROM PUBLIC, anon;')
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.permission_catalog FROM authenticated;')
  })

  it('inserts the check once per function, first in its body, and refuses otherwise', () => {
    expect(sql).toContain("E'\\nBEGIN\\n  ' || v_call || E'\\n'")
    expect(sql).toContain("Refusing to apply: % is missing or overloaded")
    expect(sql).toContain("Refusing to apply: % does not read as expected")
    expect(sql).toContain("Refusing to finish: % do not check their permission")
  })
})

describe('permissionOverrides — the editor stores only what differs from the role', () => {
  const baseline = { sales: { post: true, void: true }, inventory: { transfer: true } }

  it('nothing different: null, so the user follows the role', () => {
    expect(permissionOverrides({ sales: { post: true, void: true }, inventory: { transfer: true } }, baseline)).toBeNull()
  })

  it('keeps a removal and a grant, drops the rest', () => {
    expect(permissionOverrides({ sales: { post: true, void: false, cancel: true }, inventory: { transfer: true } }, baseline))
      .toEqual({ sales: { void: false, cancel: true } })
  })

  it('a key missing from the role counts as off', () => {
    expect(permissionOverrides({ accounting: { refund: false } }, baseline)).toBeNull()
    expect(permissionOverrides({ accounting: { refund: true } }, baseline)).toEqual({ accounting: { refund: true } })
  })
})
