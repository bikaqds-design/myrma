/**
 * warehouseDestinations.test.js — Unit tests for src/lib/warehouseDestinations.ts
 *
 * The rule under test: a manual receive / transfer / adjust may never target a
 * protected system location. Units reach SCRAP, RMA-RECEIVED and the rest only
 * through the RMA auto-move / promote flow (Warehouse Module R1, migration
 * 20260764).
 *
 * Found in manual QA 2026-08-05 (WAREHOUSE_R1_TEST_CHECKLIST.md §9): the same
 * filter was inlined in four places and wrong in all four — three omitted
 * !is_system, and ReceiveStockModal had no filter at all. Offering SCRAP in a
 * transfer dropdown lets a user write stock off with no RMA ticket; offering
 * RMA-RECEIVED creates an RMA unit with a NULL rma_ticket_id.
 */
import { describe, it, expect } from 'vitest'
import { destinationWarehouses } from '../lib/warehouseDestinations'

const MAIN = { id: 'wh-main', name: 'Main Warehouse', is_active: true, is_system: false }
const BRANCH = { id: 'wh-cairo', name: 'Branch – Cairo', is_active: true, is_system: false }
const ARCHIVED = { id: 'wh-old', name: 'Old Depot', is_active: false, is_system: false }
const SCRAP = { id: 'wh-scrap', name: 'Scrap', is_active: true, is_system: true }
const RMA_RECEIVED = { id: 'wh-rec', name: 'RMA - Received', is_active: true, is_system: true }
const CREDIT_NOTE = { id: 'wh-cn', name: 'Credit Note Holding', is_active: true, is_system: true }

const ALL = [MAIN, BRANCH, ARCHIVED, SCRAP, RMA_RECEIVED, CREDIT_NOTE]

const ids = (list) => list.map((w) => w.id)

describe('destinationWarehouses — system locations', () => {
  it('excludes every system location', () => {
    expect(ids(destinationWarehouses(ALL))).toEqual(['wh-main', 'wh-cairo'])
  })

  it('excludes SCRAP specifically — writing stock off needs an RMA, not a transfer', () => {
    expect(ids(destinationWarehouses(ALL))).not.toContain('wh-scrap')
  })

  it('excludes RMA-RECEIVED specifically — an RMA unit needs a ticket', () => {
    expect(ids(destinationWarehouses(ALL))).not.toContain('wh-rec')
  })

  it('returns nothing when every warehouse is a system location', () => {
    expect(destinationWarehouses([SCRAP, RMA_RECEIVED, CREDIT_NOTE])).toEqual([])
  })
})

describe('destinationWarehouses — active flag', () => {
  it('excludes archived warehouses', () => {
    expect(ids(destinationWarehouses(ALL))).not.toContain('wh-old')
  })

  it('treats a missing is_active as inactive, matching the filters this replaced', () => {
    expect(destinationWarehouses([{ id: 'wh-x', name: 'No Flag' }])).toEqual([])
  })

  it('excludes an archived system location on both counts', () => {
    expect(destinationWarehouses([{ id: 'wh-y', is_active: false, is_system: true }])).toEqual([])
  })
})

describe('destinationWarehouses — excludeId', () => {
  it('drops the transfer source so a warehouse cannot target itself', () => {
    expect(ids(destinationWarehouses(ALL, { excludeId: MAIN.id }))).toEqual(['wh-cairo'])
  })

  it('keeps every eligible warehouse when no source is given', () => {
    expect(ids(destinationWarehouses(ALL, {}))).toEqual(['wh-main', 'wh-cairo'])
  })

  it('ignores an excludeId that matches nothing', () => {
    expect(ids(destinationWarehouses(ALL, { excludeId: 'wh-nonexistent' }))).toEqual([
      'wh-main',
      'wh-cairo',
    ])
  })

  it('treats a null excludeId as no exclusion', () => {
    expect(ids(destinationWarehouses(ALL, { excludeId: null }))).toEqual(['wh-main', 'wh-cairo'])
  })
})

describe('destinationWarehouses — input handling', () => {
  it('handles an empty, null or undefined list', () => {
    expect(destinationWarehouses([])).toEqual([])
    expect(destinationWarehouses(null)).toEqual([])
    expect(destinationWarehouses(undefined)).toEqual([])
  })

  it('preserves the caller-supplied order', () => {
    expect(ids(destinationWarehouses([BRANCH, MAIN]))).toEqual(['wh-cairo', 'wh-main'])
  })

  it('does not mutate the input array', () => {
    const input = [...ALL]
    destinationWarehouses(input, { excludeId: MAIN.id })
    expect(input).toHaveLength(ALL.length)
  })
})
