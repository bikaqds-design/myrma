/**
 * permissionScreens.test.js — the screens follow the permissions the database
 * enforces (S-01 part 2, over 20260914).
 *
 * The database refuses an action a user's permissions switch off; these checks
 * pin that the screens stop offering it too, so a manager with "void" switched
 * off is not shown a Void button that can only fail.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { approvalPermission, canDo, resolvePermissions } from '../lib/permissions'
import { periodActions } from '../pages/Accounting/_periods'

const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(jsx?|tsx?)$/.test(name) ? [p] : []
  })
}

describe('approvals ask for what the database checks', () => {
  it('each document type maps to the permission its approval function checks', () => {
    expect(approvalPermission('sales_order')).toEqual(['sales', 'approve'])
    expect(approvalPermission('credit_note')).toEqual(['sales', 'issue_credit'])
    expect(approvalPermission('invoice')).toEqual(['sales', 'post'])
    expect(approvalPermission('quotation')).toEqual(['sales', 'post'])
    expect(approvalPermission('purchase_order')).toEqual(['purchasing', 'approve'])
    expect(approvalPermission('vendor_invoice')).toEqual(['purchasing', 'approve'])
  })

  it('a manager with sales-order approval switched off is not offered it', () => {
    const perms = resolvePermissions('manager', { sales: { approve: false } })
    expect(canDo('manager', perms, ...approvalPermission('sales_order'))).toBe(false)
    expect(canDo('manager', perms, ...approvalPermission('invoice'))).toBe(true)
  })

  it('both approval screens use the shared mapping', () => {
    for (const f of ['src/components/ActivityChatter.jsx', 'src/pages/Activities/index.jsx']) {
      expect(read(f)).toContain('canDo(currentUserRole, currentUserPermissions, ...approvalPermission(docType))')
    }
  })
})

describe('month-end close', () => {
  it('an accountant with close_period switched off is offered no close or reopen', () => {
    const base = { month: '2026-08-01', today: new Date(2026, 8, 15), role: 'accountant', me: 'a@x' }
    expect(periodActions({ ...base, status: 'open' })).toEqual(['soft_close'])
    expect(periodActions({ ...base, status: 'open', canClose: false })).toEqual([])
    expect(periodActions({ ...base, status: 'soft_closed', canClose: false })).toEqual([])
    expect(periodActions({ ...base, status: 'closed', canClose: false })).toEqual([])
  })
})

describe('wiring', () => {
  it('voiding and issuing credit follow their own permissions on the document page', () => {
    const s = read('src/pages/SalesDocuments/SalesDocumentDetail.jsx')
    expect(s).toContain("const canVoidDoc      = canDo(currentUserRole, currentUserPermissions, 'sales', 'void')")
    expect(s).toContain("const canIssueCredit  = canDo(currentUserRole, currentUserPermissions, 'sales', 'issue_credit')")
    expect(s.match(/<Button disabled=\{!canVoidDoc\}/g)).toHaveLength(2)
    expect(s).not.toContain('disabled={!canPostDoc} size="sm" onClick={handleIssueCN}')
  })

  it('stock actions use the user\'s own permission, not the role alone', () => {
    const s = read('src/pages/Inventory/index.jsx')
    expect(s).toContain("const canReceiveStock = isManagerOrAbove && canDo('receive')")
    expect(s).toContain('{canReceiveStock && (')
    for (const f of ['src/pages/Inventory/StockBreakdownModal.jsx', 'src/pages/Inventory/BranchesDrawer.jsx', 'src/pages/Inventory/OverviewTab.jsx']) {
      const src = read(f)
      const transfers = (src.match(/t\('inventory\.(actionTransfer|bulkTransfer)'\)/g) || []).length
      const adjusts = (src.match(/t\('inventory\.(actionAdjust|bulkAdjust)'\)/g) || []).length
      expect((src.match(/\{canTransfer && \(/g) || []).length, f).toBe(transfers)
      expect((src.match(/\{canAdjust && \(/g) || []).length, f).toBe(adjusts)
    }
  })

  it('every action the database enforces is checked by some screen', () => {
    const sql = read('supabase/migrations/20260914_permission_catalog.sql')
    const actions = [...sql.matchAll(/^\s*\('(\w+)', '(\w+)', '[^']*', '\{/gm)].map((m) => [m[1], m[2]])
    expect(actions.length).toBe(19)
    const code = [...sources('src/pages'), ...sources('src/components'), 'src/lib/permissions.ts'].map(read).join('\n')
    const missing = actions.filter(([section, action]) =>
      !code.includes(`'${section}', '${action}'`)
      && !(section === 'inventory' && code.includes(`canDo('${action}')`)))
    expect(missing).toEqual([])
  })
})
