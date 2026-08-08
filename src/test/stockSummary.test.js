/**
 * stockSummary.test.js — Unit tests for src/lib/stockSummary.ts
 *
 * The reason this file exists is the first describe block: RMA units must
 * never count as sellable stock. That defect shipped undetected because RMA
 * units had no product_id and so matched no product; the moment they gained
 * one (2026-08-05, see src/lib/rmaUnitCreate.ts) every serialized product with
 * an open RMA started overstating Available — the kind of error that gets a
 * unit sold twice. Found in manual QA, WAREHOUSE_R1_TEST_CHECKLIST.md §9.
 */
import { describe, it, expect } from 'vitest'
import {
  summarizeSerializedUnits,
  branchBreakdown,
  rmaBreakdown,
  isMainOrLegacy,
  isBranch,
} from '../lib/stockSummary'

const MAIN = { id: 'wh-main', name: 'Main Warehouse', code: 'MAIN', warehouse_type: 'main', is_system: false }
const BRANCH = { id: 'wh-cairo', name: 'Branch – Cairo', code: 'BR-CAIRO', warehouse_type: 'branch', is_system: false }
const LEGACY = { id: 'wh-legacy', name: 'Legacy', code: null, warehouse_type: null, is_system: false }
const RMA_RECEIVED = { id: 'wh-rec', name: 'RMA - Received', code: 'RMA-RECEIVED', warehouse_type: 'rma', is_system: true }
const RMA_REPAIR = { id: 'wh-rep', name: 'RMA - Under Repair', code: 'RMA-REPAIR', warehouse_type: 'rma', is_system: true }
const SCRAP = { id: 'wh-scrap', name: 'Scrap', code: 'SCRAP', warehouse_type: 'virtual', is_system: true }

const WH = new Map([MAIN, BRANCH, LEGACY, RMA_RECEIVED, RMA_REPAIR, SCRAP].map((w) => [w.id, w]))

const stock = (warehouse_id, reservation_status = 'available') => ({
  status: 'company_stock',
  reservation_status,
  warehouse_id,
})
const rma = (warehouse_id) => ({ status: 'active_rma', reservation_status: 'available', warehouse_id })

describe('summarizeSerializedUnits — RMA units are not sellable', () => {
  it('excludes RMA units from Available even though they read as unreserved', () => {
    // The exact regression: an active_rma unit carries reservation_status
    // 'available' because nothing has reserved it.
    const counts = summarizeSerializedUnits(
      [stock(MAIN.id), stock(MAIN.id), rma(RMA_RECEIVED.id), rma(RMA_REPAIR.id)],
      WH
    )
    expect(counts.available).toBe(2)
    expect(counts.rma.reduce((s, r) => s + r.count, 0)).toBe(2)
  })

  it('still counts RMA units in Physical Total — present, just not sellable', () => {
    const counts = summarizeSerializedUnits([stock(MAIN.id), rma(RMA_RECEIVED.id)], WH)
    expect(counts.available).toBe(1)
    expect(counts.physical_total).toBe(2)
  })

  it('reports zero available for a product whose every unit is on an RMA', () => {
    const counts = summarizeSerializedUnits([rma(RMA_RECEIVED.id), rma(RMA_REPAIR.id)], WH)
    expect(counts.available).toBe(0)
    expect(counts.physical_total).toBe(2)
  })

  it('keeps RMA units out of Main and Branches', () => {
    const counts = summarizeSerializedUnits([stock(MAIN.id), rma(RMA_RECEIVED.id), rma(BRANCH.id)], WH)
    expect(counts.main_qty).toBe(1)
    expect(counts.branches).toEqual([])
  })

  it('excludes RMA units from Reserved and Delivered too', () => {
    const counts = summarizeSerializedUnits(
      [stock(MAIN.id, 'reserved'), stock(MAIN.id, 'delivered'), rma(RMA_RECEIVED.id)],
      WH
    )
    expect(counts.reserved).toBe(1)
    expect(counts.delivered).toBe(1)
    expect(counts.available).toBe(0)
  })

  it('ignores closed units entirely', () => {
    const counts = summarizeSerializedUnits(
      [stock(MAIN.id), { status: 'closed', reservation_status: 'available', warehouse_id: MAIN.id }],
      WH
    )
    expect(counts.available).toBe(1)
    expect(counts.physical_total).toBe(1)
  })
})

describe('summarizeSerializedUnits — reservation split', () => {
  it('splits company stock across available / reserved / delivered', () => {
    const counts = summarizeSerializedUnits(
      [stock(MAIN.id), stock(MAIN.id, 'reserved'), stock(MAIN.id, 'delivered'), stock(MAIN.id)],
      WH
    )
    expect(counts).toMatchObject({ available: 2, reserved: 1, delivered: 1 })
  })

  it('returns all-zero counts for a product with no units', () => {
    expect(summarizeSerializedUnits([], WH)).toMatchObject({
      available: 0,
      reserved: 0,
      delivered: 0,
      main_qty: 0,
      physical_total: 0,
      branches: [],
      rma: [],
    })
  })
})

describe('summarizeSerializedUnits — SCRAP', () => {
  it('drops scrapped company stock from Physical Total', () => {
    const counts = summarizeSerializedUnits([stock(MAIN.id), stock(SCRAP.id)], WH)
    expect(counts.physical_total).toBe(1)
  })

  it('drops scrapped RMA units from Physical Total', () => {
    const counts = summarizeSerializedUnits([stock(MAIN.id), rma(SCRAP.id)], WH)
    expect(counts.physical_total).toBe(1)
    expect(counts.rma.find((r) => r.code === 'SCRAP')?.count).toBe(1)
  })
})

describe('summarizeSerializedUnits — locations', () => {
  it('counts warehouses with no type as Main (legacy rows)', () => {
    expect(summarizeSerializedUnits([stock(LEGACY.id)], WH).main_qty).toBe(1)
  })

  it('counts a unit with no warehouse at all as Main', () => {
    expect(summarizeSerializedUnits([stock(null)], WH).main_qty).toBe(1)
  })

  it('groups branch stock per branch and keeps it out of Main', () => {
    const counts = summarizeSerializedUnits([stock(BRANCH.id), stock(BRANCH.id), stock(MAIN.id)], WH)
    expect(counts.main_qty).toBe(1)
    expect(counts.branches).toEqual([
      { warehouse_id: BRANCH.id, name: 'Branch – Cairo', code: 'BR-CAIRO', qty: 2 },
    ])
  })

  it('groups RMA units by system location', () => {
    const counts = summarizeSerializedUnits([rma(RMA_RECEIVED.id), rma(RMA_RECEIVED.id), rma(RMA_REPAIR.id)], WH)
    expect(counts.rma).toEqual([
      { warehouse_id: RMA_RECEIVED.id, code: 'RMA-RECEIVED', name: 'RMA - Received', count: 2 },
      { warehouse_id: RMA_REPAIR.id, code: 'RMA-REPAIR', name: 'RMA - Under Repair', count: 1 },
    ])
  })
})

describe('rmaBreakdown', () => {
  it('skips units parked outside a system location', () => {
    expect(rmaBreakdown([rma(MAIN.id), rma(null)], WH)).toEqual([])
  })

  it('skips units whose warehouse is unknown to the lookup', () => {
    expect(rmaBreakdown([rma('wh-nonexistent')], WH)).toEqual([])
  })
})

describe('branchBreakdown', () => {
  it('ignores main, legacy and system locations', () => {
    const rows = [MAIN.id, LEGACY.id, RMA_RECEIVED.id].map((warehouse_id) => ({ warehouse_id, qty: 1 }))
    expect(branchBreakdown(rows, WH)).toEqual([])
  })

  it('sums quantities per branch rather than counting rows', () => {
    const rows = [
      { warehouse_id: BRANCH.id, qty: 3 },
      { warehouse_id: BRANCH.id, qty: 2 },
    ]
    expect(branchBreakdown(rows, WH)).toEqual([
      { warehouse_id: BRANCH.id, name: 'Branch – Cairo', code: 'BR-CAIRO', qty: 5 },
    ])
  })
})

describe('warehouse predicates', () => {
  it('treats missing and untyped warehouses as main', () => {
    expect(isMainOrLegacy(undefined)).toBe(true)
    expect(isMainOrLegacy(LEGACY)).toBe(true)
    expect(isMainOrLegacy(MAIN)).toBe(true)
    expect(isMainOrLegacy(BRANCH)).toBe(false)
  })

  it('identifies branches', () => {
    expect(isBranch(BRANCH)).toBe(true)
    expect(isBranch(MAIN)).toBe(false)
    expect(isBranch(undefined)).toBe(false)
  })
})
