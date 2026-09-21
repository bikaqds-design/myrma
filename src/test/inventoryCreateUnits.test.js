/**
 * inventoryCreateUnits.test.js — RMA inventory-unit creation.
 *
 * Two layers of history are pinned here.
 *
 * Manual QA on 2026-08-05 (docs/archive/WAREHOUSE_R1_TEST_CHECKLIST.md §2) found
 * that a ticket with one already-tracked serial produced NO units for ANY of
 * its products and reported success:
 *
 *   1. the units went in as a single batch, so one bad row voided the good ones
 *   2. every error was swallowed with `return []`, so the caller could not tell
 *      success from total failure
 *
 * BL-03 (20260877) then removed the client INSERT on inventory_units entirely:
 * creation is the rma_create_units_from_ticket RPC, which inserts each unit in
 * its own subtransaction and reports the failures. So the contracts below are
 * now about how the client reads that RPC's answer, not about retrying inserts.
 * The behaviour of the RPC itself is proven against a real database in
 * supabase/tests/lock_inventory_unit_writes.sql.
 *
 * Supabase is mocked at the client boundary. The mock has NO `insert`, so any
 * attempt to write the table from the browser throws and fails these tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpcCalls: [],
  queryCalls: [],
  /** (name, args) => ({ data, error }) */
  rpcHandler: () => ({ data: { created: [], failed: [] }, error: null }),
  /** the rma_products_by_name_keys catalog lookup that runs first for unlinked products */
  catalogRows: [],
  /** { data, error } returned by the findTrackedSerials query chain */
  queryResult: { data: [], error: null },
}))

vi.mock('../api/client.js', () => ({
  supabase: {
    rpc: (name, args) => {
      mocks.rpcCalls.push({ name, args })
      if (name === 'rma_products_by_name_keys') return Promise.resolve({ data: mocks.catalogRows, error: null })
      return Promise.resolve(mocks.rpcHandler(name, args))
    },
    from: (table) => ({
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

const DUPLICATE_SERIAL = {
  index: 0,
  product_name: 'test2',
  serial_number: 'TEST-CB86E9-0022',
  code: '23505',
  message: 'duplicate key value violates unique constraint "inv_units_serial_unique_idx"',
}

/** Only the calls that create units (the catalog lookup is not one of them). */
const createCalls = () => mocks.rpcCalls.filter((c) => c.name === 'rma_create_units_from_ticket')

/** Echoes the sent units back as if the database had created them. */
const createdFrom = (units) => units.map((u, i) => ({ ...u, id: `${u.serial_number || 'unit'}-${i}` }))

beforeEach(() => {
  mocks.rpcCalls.length = 0
  mocks.catalogRows = []
  mocks.queryCalls.length = 0
  mocks.rpcHandler = (name, args) => ({ data: { created: createdFrom(args.p_units), failed: [] }, error: null })
  mocks.queryResult = { data: [], error: null }
})

describe('createUnitsFromTicket — happy path', () => {
  it('creates every unit with one call to the RPC', async () => {
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result.created).toHaveLength(2)
    expect(result.failed).toEqual([])
    expect(result.missing).toBe(false)
    expect(createCalls()).toHaveLength(1)
    expect(createCalls()[0].args.p_ticket_id).toBe('t1')
    expect(createCalls()[0].args.p_units).toHaveLength(2)
  })

  it('does not call the database when the ticket has no products', async () => {
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', [])
    expect(result).toEqual({ created: [], failed: [], missing: false })
    expect(mocks.rpcCalls).toEqual([])
  })

  it('does not call the database when every product row is empty', async () => {
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', [{ product_name: '', serial_number: '  ' }])
    expect(result.created).toEqual([])
    expect(mocks.rpcCalls).toEqual([])
  })
})

describe('createUnitsFromTicket — defect 1: one bad row must not void the good ones', () => {
  it('keeps the valid unit when the RPC reports a duplicate serial for the other', async () => {
    mocks.rpcHandler = (name, args) => ({
      data: { created: createdFrom([args.p_units[1]]), failed: [DUPLICATE_SERIAL] },
      error: null,
    })

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
    // One round trip however many units fail; there is no per-row retry loop.
    expect(createCalls()).toHaveLength(1)
  })

  it('reports every unit as failed when the RPC says they all conflict', async () => {
    mocks.rpcHandler = () => ({
      data: { created: [], failed: [DUPLICATE_SERIAL, { ...DUPLICATE_SERIAL, serial_number: 'SN-FRESH' }] },
      error: null,
    })
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result.created).toEqual([])
    expect(result.failed).toHaveLength(2)
  })
})

describe('createUnitsFromTicket — defect 2: failures must be visible to the caller', () => {
  it('reports every unit as failed when the whole call errors', async () => {
    mocks.rpcHandler = () => ({ data: null, error: { code: '42501', message: 'permission denied for function' } })
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    // The old contract returned [] here, indistinguishable from "nothing to do".
    expect(result.created).toEqual([])
    expect(result.failed).toHaveLength(2)
    expect(result.failed.map((f) => f.serial_number)).toEqual(['TEST-CB86E9-0022', 'SN-FRESH'])
    expect(result.failed[0].code).toBe('42501')
    expect(result.failed[0].message).toMatch(/permission denied/)
  })

  it('carries a refusal from the RPC (viewer, unknown ticket) through with its message', async () => {
    mocks.rpcHandler = () => ({ data: null, error: { code: 'P0001', message: 'Not authorized to create RMA units' } })
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result.failed[0]).toMatchObject({ code: 'P0001', message: 'Not authorized to create RMA units' })
  })

  it('normalises a missing error code to null rather than undefined', async () => {
    mocks.rpcHandler = () => ({ data: null, error: { message: 'network error' } })
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result.failed[0].code).toBeNull()
  })

  it('fills in blanks when the RPC omits a field of a failure', async () => {
    mocks.rpcHandler = () => ({ data: { created: [], failed: [{ message: 'boom' }] }, error: null })
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result.failed[0]).toEqual({ product_name: '', serial_number: '', message: 'boom', code: null })
  })

  it('flags an absent inventory_units table as missing, not as a failure', async () => {
    // Optional-table deployments must not produce a user-facing error toast.
    mocks.rpcHandler = () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } })
    const result = await inventory.createUnitsFromTicket('t1', 'RMA-001', PRODUCTS)
    expect(result).toEqual({ created: [], failed: [], missing: true })
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
