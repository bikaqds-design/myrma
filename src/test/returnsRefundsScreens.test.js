// P-05d: the pure helpers behind the Returns section and the Refunds tab, and
// the API wiring to the P-05 RPCs.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { returnableByLine, validateReturnLines } from '../pages/SalesDocuments/_returns.js'
import { canApproveRefund, validateRefund } from '../pages/Accounting/_refunds.js'

const delivery = {
  id: 'D1',
  delivery_lines: [
    { id: 'DL1', qty: 2, product_name: 'Router' },
    { id: 'DL2', qty: 10, product_name: 'Cable' },
  ],
}

describe('returnableByLine', () => {
  it('counts confirmed and draft returns of this delivery, not cancelled ones or other deliveries', () => {
    const rows = returnableByLine(delivery, [
      { delivery_id: 'D1', status: 'confirmed', customer_return_lines: [{ delivery_line_id: 'DL2', qty: 3, unit_ids: [] }] },
      { delivery_id: 'D1', status: 'draft', customer_return_lines: [{ delivery_line_id: 'DL1', qty: 1, unit_ids: ['U1'] }] },
      { delivery_id: 'D1', status: 'cancelled', customer_return_lines: [{ delivery_line_id: 'DL2', qty: 5, unit_ids: [] }] },
      { delivery_id: 'D2', status: 'confirmed', customer_return_lines: [{ delivery_line_id: 'DL2', qty: 5, unit_ids: [] }] },
    ])
    expect(rows.map((r) => [r.line.id, r.delivered, r.back, r.left])).toEqual([['DL1', 2, 1, 1], ['DL2', 10, 3, 7]])
    expect([...rows[0].usedUnits]).toEqual(['U1'])
  })
})

describe('validateReturnLines', () => {
  const base = { warehouseId: 'W1' }
  it('sends ticked units and typed quantities, skipping empty lines', () => {
    expect(validateReturnLines([
      { ...base, lineId: 'DL1', serialized: true, unitIds: ['U2'] },
      { ...base, lineId: 'DL2', serialized: false, qty: '4', left: 7 },
      { ...base, lineId: 'DL3', serialized: false, qty: '', left: 7 },
    ])).toEqual({ lines: [
      { delivery_line_id: 'DL1', unit_ids: ['U2'], warehouse_id: 'W1' },
      { delivery_line_id: 'DL2', qty: 4, warehouse_id: 'W1' },
    ] })
  })
  it('names the line that is wrong: more than left, not a whole number, no warehouse', () => {
    expect(validateReturnLines([{ ...base, lineId: 'DL2', qty: '8', left: 7 }])).toEqual({ error: 'salesDocuments.rtnQtyInvalidLine', lineId: 'DL2' })
    expect(validateReturnLines([{ ...base, lineId: 'DL2', qty: '1.5', left: 7 }])).toEqual({ error: 'salesDocuments.rtnQtyInvalidLine', lineId: 'DL2' })
    expect(validateReturnLines([{ lineId: 'DL1', serialized: true, unitIds: ['U1'], warehouseId: '' }])).toEqual({ error: 'salesDocuments.rtnWarehouseMissing', lineId: 'DL1' })
  })
  it('refuses a return with nothing in it', () => {
    expect(validateReturnLines([{ ...base, lineId: 'DL2', qty: '0', left: 7 }])).toEqual({ error: 'salesDocuments.rtnNothing' })
  })
})

describe('refund helpers', () => {
  it('the recorder is never offered their own approval, whatever the case of the email', () => {
    expect(canApproveRefund({ created_by: 'Mgr1@x' }, 'mgr1@X')).toBe(false)
    expect(canApproveRefund({ created_by: 'mgr1@x' }, 'mgr2@x')).toBe(true)
  })
  it('a source and a positive amount in whole cents, within its balance', () => {
    const source = { balance: 200 }
    expect(validateRefund({ source: null, amount: '10' })).toEqual({ error: 'accounting.rfErrSource' })
    expect(validateRefund({ source, amount: '0' })).toEqual({ error: 'accounting.rfErrAmount' })
    expect(validateRefund({ source, amount: '1.005' })).toEqual({ error: 'accounting.rfErrAmount' })
    expect(validateRefund({ source, amount: '1e2' })).toEqual({ error: 'accounting.rfErrAmount' })
    expect(validateRefund({ source, amount: '200.01' })).toEqual({ error: 'accounting.rfErrTooMuch' })
    expect(validateRefund({ source, amount: '200' })).toEqual({ amount: 200 })
  })
})

describe('API wiring', () => {
  it('returns and refunds go through their RPCs only', () => {
    const rtn = readFileSync('src/api/db/customerReturns.ts', 'utf8')
    for (const rpc of ['create_customer_return', 'confirm_customer_return', 'cancel_customer_return', 'create_credit_note_from_return']) {
      expect(rtn).toContain(`supabase.rpc('${rpc}'`)
    }
    const rf = readFileSync('src/api/db/customerRefunds.ts', 'utf8')
    for (const rpc of ['record_customer_refund', 'approve_customer_refund', 'reject_customer_refund']) {
      expect(rf).toContain(`supabase.rpc('${rpc}'`)
    }
    for (const src of [rtn, rf]) expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/)
  })
})
