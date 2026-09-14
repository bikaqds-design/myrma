/**
 * rmaUnitCreate.test.js — the pure core of RMA inventory-unit creation.
 *
 * Covers the two defects found in manual QA on 2026-08-05
 * (WAREHOUSE_R1_TEST_CHECKLIST.md §2): a ticket carrying one already-tracked
 * serial silently produced no units at all. This file tests the decision half
 * (which units to build, which serials would be rejected, how to name a
 * failure); inventory.createUnitsFromTicket.test.js covers the insert half.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeSerial,
  buildTicketUnits,
  serialsToCheck,
  findSerialConflicts,
  describeFailedUnits,
  buildCatalogIndex,
  resolveProductId,
} from '../lib/rmaUnitCreate'

const NOW = '2026-08-05T10:00:00.000Z'

describe('normalizeSerial', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeSerial('  SN-1  ')).toBe('SN-1')
  })

  it('collapses null, undefined and whitespace-only to the empty string', () => {
    // inv_units_serial_unique_idx excludes '' but not '   ', so a
    // whitespace-only serial must normalise to '' or two of them collide.
    expect(normalizeSerial(null)).toBe('')
    expect(normalizeSerial(undefined)).toBe('')
    expect(normalizeSerial('   ')).toBe('')
  })
})

describe('buildTicketUnits', () => {
  it('builds one active_rma row per product, carrying the ticket identity', () => {
    const units = buildTicketUnits('t1', 'RMA-001', [{ product_name: 'Widget', serial_number: 'SN-1', warranty_status: 'In Warranty' }], NOW)
    expect(units).toEqual([
      {
        rma_ticket_id: 't1',
        rma_number: 'RMA-001',
        product_id: null,
        product_name: 'Widget',
        serial_number: 'SN-1',
        warranty_status: 'In Warranty',
        status: 'active_rma',
        created_date: NOW,
      },
    ])
  })

  it('keeps every product on a multi-product ticket', () => {
    const units = buildTicketUnits('t1', 'RMA-001', [
      { product_name: 'test2', serial_number: 'TEST-CB86E9-0022' },
      { product_name: 'Not in catalog' },
    ], NOW)
    expect(units).toHaveLength(2)
    expect(units.map((u) => u.product_name)).toEqual(['test2', 'Not in catalog'])
  })

  it('drops empty product rows left behind by the form', () => {
    const units = buildTicketUnits('t1', 'RMA-001', [{ product_name: '', serial_number: '  ' }, { product_name: 'Widget' }], NOW)
    expect(units.map((u) => u.product_name)).toEqual(['Widget'])
  })

  it('keeps a product that has only a serial', () => {
    expect(buildTicketUnits('t1', 'RMA-001', [{ serial_number: 'SN-1' }], NOW)).toHaveLength(1)
  })

  it('trims serials and defaults missing fields to empty strings', () => {
    const [unit] = buildTicketUnits('t1', 'RMA-001', [{ product_name: 'Widget', serial_number: '  SN-1  ' }], NOW)
    expect(unit.serial_number).toBe('SN-1')
    expect(unit.warranty_status).toBe('')
  })

  it('returns [] for no products', () => {
    expect(buildTicketUnits('t1', 'RMA-001', [], NOW)).toEqual([])
    expect(buildTicketUnits('t1', 'RMA-001', null, NOW)).toEqual([])
    expect(buildTicketUnits('t1', 'RMA-001', undefined, NOW)).toEqual([])
  })
})

describe('serialsToCheck', () => {
  it('returns distinct non-empty trimmed serials', () => {
    const products = [{ serial_number: ' SN-1 ' }, { serial_number: 'SN-1' }, { serial_number: '' }, { product_name: 'No serial' }]
    expect(serialsToCheck(products)).toEqual(['SN-1'])
  })

  it('returns [] when nothing has a serial', () => {
    expect(serialsToCheck([{ product_name: 'Widget' }])).toEqual([])
    expect(serialsToCheck(null)).toEqual([])
  })
})

describe('findSerialConflicts', () => {
  it('flags a serial already held by a live inventory unit', () => {
    // The exact QA repro: catalog product test2, serial already in inventory_units.
    const products = [{ product_name: 'test2', serial_number: 'TEST-CB86E9-0022' }]
    const tracked = [{ id: 'u9', serial_number: 'TEST-CB86E9-0022', status: 'active_rma', rma_number: 'RMA-05082026-0001' }]
    expect(findSerialConflicts(products, tracked)).toEqual([
      { serial: 'TEST-CB86E9-0022', reason: 'already_tracked', rmaNumber: 'RMA-05082026-0001', status: 'active_rma' },
    ])
  })

  it('flags the same serial typed twice on one ticket', () => {
    const products = [{ product_name: 'A', serial_number: 'SN-1' }, { product_name: 'B', serial_number: 'SN-1' }]
    expect(findSerialConflicts(products, [])).toEqual([{ serial: 'SN-1', reason: 'duplicate_in_ticket' }])
  })

  it('reports an in-ticket duplicate once, not once per occurrence', () => {
    const products = [{ serial_number: 'SN-1' }, { serial_number: 'SN-1' }, { serial_number: 'SN-1' }]
    expect(findSerialConflicts(products, [])).toHaveLength(1)
  })

  it('prefers duplicate_in_ticket over already_tracked for the same serial', () => {
    const products = [{ serial_number: 'SN-1' }, { serial_number: 'SN-1' }]
    const tracked = [{ serial_number: 'SN-1', status: 'company_stock' }]
    expect(findSerialConflicts(products, tracked)).toEqual([{ serial: 'SN-1', reason: 'duplicate_in_ticket' }])
  })

  it('does not flag a serial whose only existing unit is closed', () => {
    // findTrackedSerials filters status <> 'closed' before this point, mirroring
    // inv_units_serial_unique_idx — a closed unit may legitimately repeat a serial.
    expect(findSerialConflicts([{ serial_number: 'SN-1' }], [])).toEqual([])
  })

  it('ignores empty and whitespace-only serials entirely', () => {
    const products = [{ product_name: 'A', serial_number: '' }, { product_name: 'B', serial_number: '   ' }, { product_name: 'C' }]
    expect(findSerialConflicts(products, [{ serial_number: '' }])).toEqual([])
  })

  it('matches untrimmed input against untrimmed stored serials', () => {
    const conflicts = findSerialConflicts([{ serial_number: ' SN-1 ' }], [{ serial_number: 'SN-1 ', status: 'company_stock' }])
    expect(conflicts).toEqual([{ serial: 'SN-1', reason: 'already_tracked', rmaNumber: null, status: 'company_stock' }])
  })

  it('returns [] for empty or missing input', () => {
    expect(findSerialConflicts([], [])).toEqual([])
    expect(findSerialConflicts(null, null)).toEqual([])
    expect(findSerialConflicts([{ serial_number: 'SN-1' }], null)).toEqual([])
  })

  it('reports several distinct conflicting serials in form order', () => {
    const products = [{ serial_number: 'SN-B' }, { serial_number: 'SN-A' }]
    const tracked = [{ serial_number: 'SN-A' }, { serial_number: 'SN-B' }]
    expect(findSerialConflicts(products, tracked).map((c) => c.serial)).toEqual(['SN-B', 'SN-A'])
  })
})

describe('describeFailedUnits', () => {
  it('names failures by serial when there is one', () => {
    expect(describeFailedUnits([{ serial_number: 'SN-1', product_name: 'Widget' }])).toBe('SN-1')
  })

  it('falls back to the product name when the serial is blank', () => {
    expect(describeFailedUnits([{ serial_number: '', product_name: 'Widget' }])).toBe('Widget')
  })

  it('falls back to a dash when neither is usable', () => {
    expect(describeFailedUnits([{ serial_number: null, product_name: null }])).toBe('—')
  })

  it('joins several failures with commas', () => {
    expect(describeFailedUnits([{ serial_number: 'SN-1' }, { product_name: 'Widget' }])).toBe('SN-1, Widget')
  })
})

// product_id decides whether a unit is visible to v_product_stock_summary's per-product
// grouping. Without it the unit shows as "Not in catalog" and the product's RMA
// column stays 0 — the defect these tests lock down.
const CATALOG = [
  { id: 'p-widget', product_name: 'Widget' },
  { id: 'p-gadget', product_name: 'Gadget' },
  { id: 'p-dup-a', product_name: 'Twin' },
  { id: 'p-dup-b', product_name: 'Twin' },
]

describe('buildCatalogIndex', () => {
  it('maps a trimmed, lowercased name to its product id', () => {
    expect(buildCatalogIndex(CATALOG).get('widget')).toBe('p-widget')
  })

  it('marks a name shared by two products as ambiguous rather than picking one', () => {
    expect(buildCatalogIndex(CATALOG).get('twin')).toBeNull()
  })

  it('ignores catalog rows with a blank or missing name', () => {
    const index = buildCatalogIndex([{ id: 'p-1', product_name: '   ' }, { id: 'p-2' }])
    expect(index.size).toBe(0)
  })

  it('handles an empty or missing catalog', () => {
    expect(buildCatalogIndex([]).size).toBe(0)
    expect(buildCatalogIndex(null).size).toBe(0)
  })
})

describe('resolveProductId', () => {
  const index = buildCatalogIndex(CATALOG)

  it('prefers the id the form captured over any name match', () => {
    expect(resolveProductId({ product_id: 'p-picked', product_name: 'Widget' }, index)).toBe('p-picked')
  })

  it('falls back to a name match for a typed (not picked) product', () => {
    expect(resolveProductId({ product_name: 'Widget' }, index)).toBe('p-widget')
  })

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(resolveProductId({ product_name: '  wIdGeT ' }, index)).toBe('p-widget')
  })

  it('returns null for a name no catalog product has', () => {
    expect(resolveProductId({ product_name: 'Never Sold This' }, index)).toBeNull()
  })

  it('returns null when the name is ambiguous', () => {
    expect(resolveProductId({ product_name: 'Twin' }, index)).toBeNull()
  })

  it('returns null for a product line with no name at all', () => {
    expect(resolveProductId({ serial_number: 'SN-9' }, index)).toBeNull()
  })
})

describe('buildTicketUnits — catalog linking', () => {
  it('links a typed name to its catalog product', () => {
    const [unit] = buildTicketUnits('t1', 'RMA-001', [{ product_name: 'Widget', serial_number: 'SN-1' }], NOW, CATALOG)
    expect(unit.product_id).toBe('p-widget')
  })

  it('keeps the id the form captured even when the name was edited afterwards', () => {
    const [unit] = buildTicketUnits('t1', 'RMA-001', [{ product_id: 'p-gadget', product_name: 'Widget' }], NOW, CATALOG)
    expect(unit.product_id).toBe('p-gadget')
  })

  it('leaves a genuinely non-catalog product unlinked', () => {
    const [unit] = buildTicketUnits('t1', 'RMA-001', [{ product_name: 'QA-NONCATALOG-WIDGET', serial_number: 'SN-2' }], NOW, CATALOG)
    expect(unit.product_id).toBeNull()
  })

  it('links each line of a mixed ticket independently', () => {
    const units = buildTicketUnits(
      't1',
      'RMA-001',
      [{ product_name: 'Widget', serial_number: 'SN-1' }, { product_name: 'Mystery Box', serial_number: 'SN-2' }],
      NOW,
      CATALOG
    )
    expect(units.map((u) => u.product_id)).toEqual(['p-widget', null])
  })

  it('still builds units when no catalog is supplied', () => {
    const [unit] = buildTicketUnits('t1', 'RMA-001', [{ product_name: 'Widget', serial_number: 'SN-1' }], NOW)
    expect(unit.product_id).toBeNull()
    expect(unit.serial_number).toBe('SN-1')
  })
})
