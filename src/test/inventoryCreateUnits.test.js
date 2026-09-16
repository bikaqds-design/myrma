/**
 * inventoryCreateUnits.test.js — the insert half of RMA inventory-unit creation.
 *
 * Regression cover for the two defects found in manual QA on 2026-08-05
 * (docs/archive/WAREHOUSE_R1_TEST_CHECKLIST.md §2), where a ticket with one already-tracked
 * serial produced NO units for ANY of its products and reported success:
 *
 *   1. the units went in as a single batch, so one bad row voided the good ones
 *   2. every error was swallowed with `return []`, so the caller could not tell
 *      success from total failure
 *
 * Supabase is mocked at the client boundary — these tests assert the retry and
 * result-shape decisions, not PostgREST behaviour.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  insertCalls: [],
  queryCalls: [],
  /** (rows) => ({ data, error }) — receives the exact array passed to .insert() */
  insertHandler: () => ({ data: [], error: null }),
  /** { data, error } returned by the findTrackedSerials query chain */
  queryResult: { data: [], error: null },
}))

vi.mock('../api/client.js', () => ({
  supabase: {
    from: (table) => ({
      insert: (rows) => {
        mocks.insertCalls.push({ table, rows })
        return { select: () => Promise.resolve(mocks.insertHandler(rows)) }
      },
      select: () => ({
        in: (column, values) => ({
          neq: (neqColumn, neqValue) => {
            mocks.queryCalls.push({ table, column, values, neqColumn, neqValue })
            return Promise.resolve(mocks.queryResult)
          },
        }),
      }),
    }),
  },
}))

const { inventory } = await import('../api/db/inventory')

const PRODUCTS = [
  { product_name: 'test2', serial_number: 'TEST-CB86E9-0022' },
  { product_name: 'Not in catalog', serial_number: 'SN-FRESH' },
]

const DUPLICATE_SERIAL_ERROR = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "inv_units_serial_unique_idx"',
}

/** Echoes back inserted rows as if the DB had assigned ids. */
const rowsWithIds = (rows) => rows.map((r, i) => ({ ...r, id: `${r.serial_number || 'unit'}-${i}` }))

beforeEach(() => {
  mocks.insertCalls.length = 0
  mocks.queryCalls.length = 0
  mocks.insertHandler = (rows) => ({ data: rowsWithIds(rows), error: null })
  mocks.queryResult = { data: [], error: null }
})

describe('createUnitsFromTicket — happy path', () => {
  it('creates every unit in a single batch when nothing conflicts', async () => {
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result.created).toHaveLength(2)
    expect(result.failed).toEqual([])
    expect(result.missing).toBe(false)
    // Fast path: one round trip, not one per unit.
    expect(mocks.insertCalls).toHaveLength(1)
    expect(mocks.insertCalls[0].rows).toHaveLength(2)
  })

  it('inserts nothing and reports no failure when the ticket has no products', async () => {
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', [])
    expect(result).toEqual({ created: [], failed: [], missing: false })
    expect(mocks.insertCalls).toEqual([])
  })

  it('inserts nothing when every product row is empty', async () => {
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', [{ product_name: '', serial_number: '  ' }])
    expect(result.created).toEqual([])
    expect(mocks.insertCalls).toEqual([])
  })
})

describe('createUnitsFromTicket — defect 1: one bad row must not void the good ones', () => {
  it('keeps the valid unit when a duplicate serial fails the batch', async () => {
    mocks.insertHandler = (rows) => {
      if (rows.length > 1) return { data: null, error: DUPLICATE_SERIAL_ERROR }
      if (rows[0].serial_number === 'TEST-CB86E9-0022') return { data: null, error: DUPLICATE_SERIAL_ERROR }
      return { data: rowsWithIds(rows), error: null }
    }

    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)

    expect(result.created).toHaveLength(1)
    expect(result.created[0].serial_number).toBe('SN-FRESH')
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({
      product_name: 'test2',
      serial_number: 'TEST-CB86E9-0022',
      code: '23505',
    })
    expect(result.missing).toBe(false)
    // 1 failed batch + 1 retry per unit
    expect(mocks.insertCalls).toHaveLength(3)
  })

  it('retries each unit exactly once, one row at a time', async () => {
    mocks.insertHandler = (rows) =>
      rows.length > 1 ? { data: null, error: DUPLICATE_SERIAL_ERROR } : { data: rowsWithIds(rows), error: null }

    await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)

    const retries = mocks.insertCalls.slice(1)
    expect(retries).toHaveLength(2)
    expect(retries.every((c) => c.rows.length === 1)).toBe(true)
    expect(retries.map((c) => c.rows[0].serial_number)).toEqual(['TEST-CB86E9-0022', 'SN-FRESH'])
  })

  it('recovers every unit when the batch failed for a reason no individual row repeats', async () => {
    let firstCall = true
    mocks.insertHandler = (rows) => {
      if (firstCall) {
        firstCall = false
        return { data: null, error: { code: '23505', message: 'duplicate key' } }
      }
      return { data: rowsWithIds(rows), error: null }
    }

    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result.created).toHaveLength(2)
    expect(result.failed).toEqual([])
  })

  it('reports every unit as failed when they all conflict', async () => {
    mocks.insertHandler = () => ({ data: null, error: DUPLICATE_SERIAL_ERROR })
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result.created).toEqual([])
    expect(result.failed).toHaveLength(2)
    expect(result.missing).toBe(false)
  })
})

describe('createUnitsFromTicket — defect 2: failures must be visible to the caller', () => {
  it('returns the failure rather than an empty array the caller reads as success', async () => {
    mocks.insertHandler = () => ({ data: null, error: DUPLICATE_SERIAL_ERROR })
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    // The old contract returned [] here, indistinguishable from "nothing to do".
    expect(result.failed.length).toBeGreaterThan(0)
    expect(result.failed[0].message).toContain('inv_units_serial_unique_idx')
  })

  it('carries the DB error code and message through for diagnosis', async () => {
    mocks.insertHandler = (rows) =>
      rows.length > 1
        ? { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }
        : { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }

    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result.failed[0].code).toBe('42501')
    expect(result.failed[0].message).toMatch(/row-level security/)
  })

  it('normalises a missing error code to null rather than undefined', async () => {
    mocks.insertHandler = () => ({ data: null, error: { message: 'network error' } })
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result.failed[0].code).toBeNull()
  })

  it('flags an absent inventory_units table as missing, not as a failure', async () => {
    // Optional-table deployments must not produce a user-facing error toast.
    mocks.insertHandler = () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } })
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result).toEqual({ created: [], failed: [], missing: true })
    // and it must not fall through to a pointless per-row retry
    expect(mocks.insertCalls).toHaveLength(1)
  })
})

describe('findTrackedSerials', () => {
  it('queries only non-closed units, mirroring the partial unique index', async () => {
    mocks.queryResult = { data: [{ id: 'u1', serial_number: 'SN-1', status: 'company_stock' }], error: null }
    const rows = await inventory.findTrackedSerials(['SN-1'])

    expect(rows).toHaveLength(1)
    expect(mocks.queryCalls[0]).toMatchObject({
      table: 'inventory_units',
      column: 'serial_number',
      values: ['SN-1'],
      neqColumn: 'status',
      neqValue: 'closed',
    })
  })

  it('skips the query entirely for an empty serial list', async () => {
    expect(await inventory.findTrackedSerials([])).toEqual([])
    expect(mocks.queryCalls).toEqual([])
  })

  it('returns [] when the table is absent so a save is never blocked', async () => {
    mocks.queryResult = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
    expect(await inventory.findTrackedSerials(['SN-1'])).toEqual([])
  })

  it('throws on any other error so the caller can decide', async () => {
    mocks.queryResult = { data: null, error: { code: '42501', message: 'permission denied' } }
    await expect(inventory.findTrackedSerials(['SN-1'])).rejects.toMatchObject({ code: '42501' })
  })
})
