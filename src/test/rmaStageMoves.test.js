/**
 * rmaStageMoves.test.js — Unit tests for src/lib/rmaStageMoves.ts's buildRmaMoves.
 *
 * buildRmaMoves is the pure matching/mapping core of the Warehouse Module R1
 * auto-move feature: given a ticket's inventory_units rows and its products
 * JSONB, decide which system RMA location each active_rma unit should move
 * to. dispatchRmaStageMoves (the async orchestration half) is not tested here
 * — it's a thin DB call, exercised by the SQL hardening suite instead.
 */
import { describe, it, expect } from 'vitest'
import { buildRmaMoves } from '../lib/rmaStageMoves'

function unit(overrides = {}) {
  return {
    id: 'unit-1',
    status: 'active_rma',
    serial_number: null,
    product_name: null,
    ...overrides,
  }
}

describe('buildRmaMoves', () => {
  it('maps a serial-matched unit to the location for its product_status', () => {
    const units = [unit({ id: 'u1', serial_number: 'SN-1' })]
    const products = [{ serial_number: 'SN-1', product_status: 'Under Repair' }]
    expect(buildRmaMoves(units, products)).toEqual([{ unit_id: 'u1', to_code: 'RMA-REPAIR' }])
  })

  it('falls back to product_name matching when there is no serial match', () => {
    const units = [unit({ id: 'u1', serial_number: null, product_name: 'Widget' })]
    const products = [{ product_name: 'Widget', product_status: 'Repaired' }]
    expect(buildRmaMoves(units, products)).toEqual([{ unit_id: 'u1', to_code: 'RMA-REPAIRED' }])
  })

  it('prefers a serial match over a name match when both exist', () => {
    const units = [unit({ id: 'u1', serial_number: 'SN-1', product_name: 'Widget' })]
    const products = [
      { product_name: 'Widget', product_status: 'Repaired' },
      { serial_number: 'SN-1', product_name: 'Widget', product_status: "Can't Repair" },
    ]
    expect(buildRmaMoves(units, products)).toEqual([{ unit_id: 'u1', to_code: 'RMA-CANTREPAIR' }])
  })

  it('maps both Replacement and Credit Note to RMA-STOCK', () => {
    const units = [
      unit({ id: 'u1', serial_number: 'SN-1' }),
      unit({ id: 'u2', serial_number: 'SN-2' }),
    ]
    const products = [
      { serial_number: 'SN-1', product_status: 'Replacement' },
      { serial_number: 'SN-2', product_status: 'Credit Note' },
    ]
    expect(buildRmaMoves(units, products)).toEqual([
      { unit_id: 'u1', to_code: 'RMA-STOCK' },
      { unit_id: 'u2', to_code: 'RMA-STOCK' },
    ])
  })

  it('falls back to RMA-RECEIVED for empty/unrecognized product_status', () => {
    const units = [unit({ id: 'u1', serial_number: 'SN-1' })]
    const products = [{ serial_number: 'SN-1', product_status: '' }]
    expect(buildRmaMoves(units, products)).toEqual([{ unit_id: 'u1', to_code: 'RMA-RECEIVED' }])
  })

  it('falls back to RMA-RECEIVED when no ticket product matches at all', () => {
    const units = [unit({ id: 'u1', serial_number: 'SN-UNMATCHED' })]
    const products = [{ serial_number: 'SN-OTHER', product_status: 'Under Repair' }]
    expect(buildRmaMoves(units, products)).toEqual([{ unit_id: 'u1', to_code: 'RMA-RECEIVED' }])
  })

  it('skips a unit whose serial is ambiguous (multiple ticket products share it)', () => {
    const units = [unit({ id: 'u1', serial_number: 'SN-DUP' })]
    const products = [
      { serial_number: 'SN-DUP', product_status: 'Under Repair' },
      { serial_number: 'SN-DUP', product_status: 'Repaired' },
    ]
    expect(buildRmaMoves(units, products)).toEqual([])
  })

  it('skips a unit whose name is ambiguous with no serial to disambiguate', () => {
    const units = [unit({ id: 'u1', serial_number: null, product_name: 'Widget' })]
    const products = [
      { product_name: 'Widget', product_status: 'Under Repair' },
      { product_name: 'Widget', product_status: 'Repaired' },
    ]
    expect(buildRmaMoves(units, products)).toEqual([])
  })

  it('ignores units that are not active_rma', () => {
    const units = [unit({ id: 'u1', status: 'company_stock', serial_number: 'SN-1' })]
    const products = [{ serial_number: 'SN-1', product_status: 'Under Repair' }]
    expect(buildRmaMoves(units, products)).toEqual([])
  })

  it('returns an empty array for no units or no products', () => {
    expect(buildRmaMoves([], [])).toEqual([])
    expect(buildRmaMoves([unit({ id: 'u1' })], [])).toEqual([{ unit_id: 'u1', to_code: 'RMA-RECEIVED' }])
    expect(buildRmaMoves([], [{ serial_number: 'SN-1', product_status: 'Repaired' }])).toEqual([])
  })
})
