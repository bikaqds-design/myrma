// countryChartTemplates.test.js — A-02 (20260908): the three country charts are
// complete and well-formed (read from the migration itself), the apply/import
// functions keep their guards, and the screen's CSV helpers read a file the way
// the import expects.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { CHART_COUNTRIES, CHART_IMPORT_MAX, POSTING_ROLES, parseChartCsv, summarizeImport } from '../pages/Accounting/_ledger'

const sql = readFileSync('supabase/migrations/20260908_country_chart_templates.sql', 'utf8')

// ('EG', '1130', 'Bank – current account', 'البنك – حساب جاري', 'asset', '1100', true, 'cash'),
const q = "'((?:[^']|'')*)'"
const ROW = new RegExp(`^\\s*\\(${q}, ${q}, ${q}, ${q}, ${q}, (NULL|${q}), (true|false), (NULL|${q})\\)`, 'gm')
const rows = [...sql.matchAll(ROW)].map((m) => ({
  country: m[1],
  code: m[2],
  name: m[3].replace(/''/g, "'"),
  name_ar: m[4],
  type: m[5],
  parent: m[6] === 'NULL' ? null : m[7],
  postable: m[8] === 'true',
  role: m[9] === 'NULL' ? null : m[10],
}))
const TYPE_BY_DIGIT = { 1: 'asset', 2: 'liability', 3: 'equity', 4: 'income', 5: 'expense', 6: 'expense', 7: 'expense' }

describe('country chart templates (migration seed)', () => {
  it('seeds Egypt, the UAE and Saudi Arabia, and nothing else', () => {
    expect([...new Set(rows.map((r) => r.country))].sort()).toEqual([...CHART_COUNTRIES].sort())
    const count = (c) => rows.filter((r) => r.country === c).length
    expect([count('EG'), count('AE'), count('SA')]).toEqual([95, 92, 95])
  })

  for (const country of ['EG', 'AE', 'SA']) {
    describe(country, () => {
      const chart = rows.filter((r) => r.country === country)
      const byCode = new Map(chart.map((r) => [r.code, r]))

      it('gives every posting role exactly one postable account', () => {
        const roles = chart.filter((r) => r.role).map((r) => r.role).sort()
        expect(roles).toEqual([...POSTING_ROLES].sort())
        for (const r of chart.filter((x) => x.role)) expect(r.postable, r.code).toBe(true)
      })

      it('has unique codes, Arabic names, and parents that are headers of the same type', () => {
        expect(byCode.size).toBe(chart.length)
        for (const r of chart) {
          expect(r.name_ar.trim(), r.code).not.toBe('')
          if (!r.parent) continue
          const p = byCode.get(r.parent)
          expect(p, `${r.code} → ${r.parent}`).toBeTruthy()
          expect(p.postable, r.parent).toBe(false)
          expect(p.type, r.code).toBe(r.type)
        }
      })

      it('types every account by its first digit (1 assets … 5–7 expenses)', () => {
        for (const r of chart) expect(r.type, r.code).toBe(TYPE_BY_DIGIT[r.code[0]])
      })
    })
  }

  it('carries each country’s own accounts', () => {
    const has = (c, name) => rows.some((r) => r.country === c && r.name === name)
    expect(has('EG', 'Legal reserve') && has('EG', 'Stamp duty payable') && has('EG', 'Salary tax payable')).toBe(true)
    expect(has('SA', 'Zakat payable') && has('SA', 'GOSI payable') && has('SA', 'Zakat expense')).toBe(true)
    expect(has('AE', 'Corporate tax payable') && has('AE', 'Provision for end-of-service gratuity')).toBe(true)
  })
})

describe('apply and import (migration functions)', () => {
  const fn = (name) => sql.slice(sql.indexOf(`FUNCTION public.${name}(`), sql.indexOf('END $fn$', sql.indexOf(`FUNCTION public.${name}(`)))
  it('only an administrator may apply or import, fail-closed', () => {
    for (const f of ['rma_apply_chart_template', 'rma_import_chart_accounts']) {
      expect(fn(f)).toMatch(/IF NOT COALESCE\(public\.rma_is_admin\(\), false\) THEN/)
    }
  })
  it('a template is applied only while nothing has been posted', () => {
    expect(fn('rma_apply_chart_template')).toMatch(/IF EXISTS \(SELECT 1 FROM public\.journal_lines\) THEN\s+RAISE/)
  })
  it('an import creates or renames — never retypes or re-parents an existing account', () => {
    const body = fn('rma_import_chart_accounts')
    expect(body).toMatch(/UPDATE public\.gl_accounts SET name = v_name, name_ar = COALESCE\(v_name_ar, name_ar\) WHERE code = v_code;/)
    expect(body).toMatch(/jsonb_array_length\(p_rows\) > 2000/)
  })
  it('templates are not client-writable and anon runs neither function', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.gl_chart_templates FROM authenticated;/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.rma_apply_chart_template\(text\) FROM PUBLIC, anon;/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.rma_import_chart_accounts\(jsonb\) FROM PUBLIC, anon;/)
  })
  it('the screen goes through the two functions only', () => {
    const api = readFileSync('src/api/db/ledger.ts', 'utf8')
    expect(api).toContain("rpc('rma_apply_chart_template'")
    expect(api).toContain("rpc('rma_import_chart_accounts'")
    expect(api).not.toMatch(/from\('gl_chart_templates'\)\.(insert|update|upsert|delete)/)
  })
})

describe('parseChartCsv', () => {
  it('reads named columns in any order, quoted commas included, and a BOM', () => {
    const csv = '\uFEFFType,Code,Name,name_ar,Parent,header\r\nexpense,6190,"Training, staff",تدريب,6000,\r\nexpense,8000,Other,,,yes\r\n\r\n'
    expect(parseChartCsv(csv)).toEqual({
      rows: [
        { code: '6190', name: 'Training, staff', name_ar: 'تدريب', type: 'expense', parent_code: '6000' },
        { code: '8000', name: 'Other', type: 'expense', header: 'yes' },
      ],
    })
  })
  it('keeps a row with a blank code or name for the database to report', () => {
    expect(parseChartCsv('code,name\n,No code\n1234,').rows).toEqual([
      { code: '', name: 'No code' },
      { code: '1234', name: '' },
    ])
  })
  it('refuses a file with no rows, without code/name columns, or too long', () => {
    expect(parseChartCsv('code,name\n')).toEqual({ error: 'accounting.glImportErrEmpty' })
    expect(parseChartCsv('number,title\n1,x')).toEqual({ error: 'accounting.glImportErrColumns' })
    const big = 'code,name\n' + Array.from({ length: CHART_IMPORT_MAX + 1 }, (_, i) => `${i},x`).join('\n')
    expect(parseChartCsv(big)).toEqual({ error: 'accounting.glImportErrTooMany' })
  })
})

describe('summarizeImport', () => {
  it('counts outcomes and keeps the failed rows', () => {
    const bad = { code: '1250', status: 'error', message: 'bad type' }
    expect(summarizeImport([{ code: '1', status: 'created' }, { code: '2', status: 'updated' }, bad])).toEqual({
      created: 1,
      updated: 1,
      errors: [bad],
    })
  })
})
