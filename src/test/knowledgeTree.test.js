/**
 * knowledgeTree.test.js -- the Knowledge Center's folder tree.
 *
 * The properties worth pinning:
 *
 *  - every product appears exactly once, even when its category/subcategory
 *    disagrees with its brand -- appearing twice would double every roll-up
 *    above it, appearing nowhere would hide its documents from browsing while
 *    search could still find them;
 *  - a document whose product does not exist in the catalogue must not vanish;
 *  - roll-up totals (count, bytes, most-recent modified) must match a brute
 *    force sum over the whole subtree, not just the direct children.
 */
import { describe, it, expect } from 'vitest'
import { buildTree, pathTo, descendantDocuments, descendantProductIds, formatBytes, ROOT_ID } from '../lib/knowledgeTree'

const BRAND_AOC = { id: 'b-aoc', brand_name: 'AOC' }
const BRAND_XPG = { id: 'b-xpg', brand_name: 'XPG' }

const CAT_MONITOR = { id: 'c-monitor', brand_id: 'b-aoc', category_name: 'Gaming Monitor' }
const CAT_SSD = { id: 'c-ssd', brand_id: 'b-xpg', category_name: 'PCIe SSD' }

const SUB_27IN = { id: 's-27', category_id: 'c-monitor', subcategory_name: '27"' }

const PRODUCT_MONITOR = {
  id: 'p-monitor',
  sku: 'PRD-072',
  product_name: '24G4E',
  brand_id: 'b-aoc',
  category_id: 'c-monitor',
  subcategory_id: 's-27',
}
const PRODUCT_SSD = {
  id: 'p-ssd',
  sku: 'PRD-392',
  product_name: '512GB SX6000',
  brand_id: 'b-xpg',
  category_id: 'c-ssd',
  subcategory_id: null,
}

function findByName(node, name) {
  return node.folders.find((f) => f.name === name)
}

describe('placement', () => {
  it('nests a product under brand > category > subcategory when everything agrees', () => {
    const { root } = buildTree({
      brands: [BRAND_AOC],
      categories: [CAT_MONITOR],
      subcategories: [SUB_27IN],
      products: [PRODUCT_MONITOR],
    })
    const brand = findByName(root, 'AOC')
    const category = findByName(brand, 'Gaming Monitor')
    const sub = findByName(category, '27"')
    expect(findByName(sub, '24G4E')?.id).toBe('p-monitor')
  })

  it('places a product with no category directly under its brand', () => {
    const { root } = buildTree({
      brands: [BRAND_AOC],
      products: [{ ...PRODUCT_MONITOR, category_id: null, subcategory_id: null }],
    })
    const brand = findByName(root, 'AOC')
    expect(findByName(brand, '24G4E')?.id).toBe('p-monitor')
  })

  /**
   * The case placement is shaped around: a product's category_id points at a
   * category belonging to a DIFFERENT brand than the product's own brand_id.
   * Descending into that category would put the product under the wrong
   * brand's subtree. It must land under its own brand instead, one level up.
   */
  it('falls back to the brand when the category belongs to a different brand', () => {
    const { root } = buildTree({
      brands: [BRAND_AOC, BRAND_XPG],
      categories: [CAT_SSD], // belongs to XPG
      products: [{ ...PRODUCT_MONITOR, category_id: 'c-ssd' }], // but brand is AOC
    })
    const aoc = findByName(root, 'AOC')
    const xpg = findByName(root, 'XPG')
    expect(findByName(aoc, '24G4E')?.id).toBe('p-monitor')
    expect(findByName(xpg, '24G4E')).toBeUndefined()
  })

  it('falls back to the category when the subcategory belongs to a different category', () => {
    const otherCategory = { id: 'c-other', brand_id: 'b-aoc', category_name: 'Other' }
    const foreignSub = { id: 's-foreign', category_id: 'c-other', subcategory_name: 'Foreign' }
    const { root } = buildTree({
      brands: [BRAND_AOC],
      categories: [CAT_MONITOR, otherCategory],
      subcategories: [foreignSub],
      products: [{ ...PRODUCT_MONITOR, subcategory_id: 's-foreign' }],
    })
    const category = findByName(findByName(root, 'AOC'), 'Gaming Monitor')
    expect(findByName(category, '24G4E')?.id).toBe('p-monitor')
  })

  it('every product appears exactly once regardless of how many links disagree', () => {
    const { byId } = buildTree({
      brands: [BRAND_AOC, BRAND_XPG],
      categories: [CAT_MONITOR, CAT_SSD],
      subcategories: [SUB_27IN],
      products: [
        PRODUCT_MONITOR,
        PRODUCT_SSD,
        { ...PRODUCT_MONITOR, id: 'p-mismatched', category_id: 'c-ssd', subcategory_id: 's-27' },
      ],
    })
    const productNodeCount = [...byId.values()].filter((n) => n.kind === 'product').length
    expect(productNodeCount).toBe(3)
  })
})

describe('documents', () => {
  it('attaches a document to its product', () => {
    const doc = { id: 'd1', product_id: 'p-monitor', title: 'Leaflet', file_size: 100 }
    const { byId } = buildTree({
      brands: [BRAND_AOC],
      categories: [CAT_MONITOR],
      products: [PRODUCT_MONITOR],
      documents: [doc],
    })
    expect(byId.get('p-monitor').documents).toHaveLength(1)
  })

  /**
   * A document can be created after its product is deleted, or arrive from a
   * catalogue snapshot that has not caught up. It must still be reachable --
   * search can already find it, so the tree must not disagree.
   */
  it('keeps a document whose product does not exist in the catalogue, under the root', () => {
    const doc = { id: 'd-orphan', product_id: 'does-not-exist', title: 'Orphaned' }
    const { root, orphanCount } = buildTree({ documents: [doc] })
    expect(orphanCount).toBe(1)
    expect(root.documents).toHaveLength(1)
  })
})

describe('roll-up totals', () => {
  it('sums document count and bytes up through every ancestor', () => {
    const docs = [
      { id: 'd1', product_id: 'p-monitor', file_size: 1000, updated_at: '2026-01-01' },
      { id: 'd2', product_id: 'p-monitor', file_size: 2000, updated_at: '2026-03-01' },
      { id: 'd3', product_id: 'p-ssd', file_size: 500, updated_at: '2026-02-01' },
    ]
    const { root, byId } = buildTree({
      brands: [BRAND_AOC, BRAND_XPG],
      categories: [CAT_MONITOR, CAT_SSD],
      products: [PRODUCT_MONITOR, PRODUCT_SSD],
      documents: docs,
    })
    expect(byId.get('p-monitor').docCount).toBe(2)
    expect(byId.get('p-monitor').docBytes).toBe(3000)
    expect(byId.get('c-monitor').docCount).toBe(2)
    expect(byId.get('b-aoc').docCount).toBe(2)
    expect(root.docCount).toBe(3)
    expect(root.docBytes).toBe(3500)
  })

  it('the root modified date is the latest across the whole tree, not just direct children', () => {
    const docs = [
      { id: 'd1', product_id: 'p-monitor', updated_at: '2026-01-01' },
      { id: 'd2', product_id: 'p-ssd', updated_at: '2026-06-15' },
    ]
    const { root } = buildTree({
      brands: [BRAND_AOC, BRAND_XPG],
      categories: [CAT_MONITOR, CAT_SSD],
      products: [PRODUCT_MONITOR, PRODUCT_SSD],
      documents: docs,
    })
    expect(root.modified).toBe('2026-06-15')
  })

  it('a folder with no documents anywhere beneath it rolls up to zero, not null-crashing', () => {
    const { root } = buildTree({ brands: [BRAND_AOC] })
    const brand = findByName(root, 'AOC')
    expect(brand.docCount).toBe(0)
    expect(brand.docBytes).toBe(0)
    expect(brand.modified).toBeNull()
  })
})

describe('sorting', () => {
  it('sorts folders before documents are considered, and each group alphabetically', () => {
    const { root } = buildTree({
      brands: [BRAND_XPG, BRAND_AOC], // deliberately out of order
    })
    expect(root.folders.map((f) => f.name)).toEqual(['AOC', 'XPG'])
  })

  it('sorts brand, then category, then subcategory, then product by kind rank', () => {
    const { root } = buildTree({
      brands: [BRAND_AOC],
      categories: [CAT_MONITOR],
      subcategories: [SUB_27IN],
      products: [{ ...PRODUCT_MONITOR, category_id: null, subcategory_id: null }],
    })
    // Under AOC: the category folder and the reassigned product both sit as
    // direct children, category should sort before product by kind.
    const brand = findByName(root, 'AOC')
    expect(brand.folders.map((f) => f.kind)).toEqual(['category', 'product'])
  })
})

describe('pathTo', () => {
  it('returns the full ancestor chain from the root to the node', () => {
    const { byId } = buildTree({
      brands: [BRAND_AOC],
      categories: [CAT_MONITOR],
      subcategories: [SUB_27IN],
      products: [PRODUCT_MONITOR],
    })
    const path = pathTo(byId, 'p-monitor')
    expect(path.map((n) => n.id)).toEqual([ROOT_ID, 'b-aoc', 'c-monitor', 's-27', 'p-monitor'])
  })

  it('returns an empty array for an id not in the tree', () => {
    const { byId } = buildTree({})
    expect(pathTo(byId, 'missing')).toEqual([])
  })
})

describe('descendantDocuments / descendantProductIds', () => {
  it('collects documents from every level beneath a folder, not just direct children', () => {
    const docs = [
      { id: 'd1', product_id: 'p-monitor' },
      { id: 'd2', product_id: 'p-ssd' },
    ]
    const { byId } = buildTree({
      brands: [BRAND_AOC, BRAND_XPG],
      categories: [CAT_MONITOR, CAT_SSD],
      products: [PRODUCT_MONITOR, PRODUCT_SSD],
      documents: docs,
    })
    expect(descendantDocuments(byId.get('b-aoc'))).toHaveLength(1)
    expect(descendantDocuments(byId.get(ROOT_ID))).toHaveLength(2)
  })

  it('collects every product id beneath a folder', () => {
    const { byId } = buildTree({
      brands: [BRAND_AOC],
      categories: [CAT_MONITOR],
      products: [PRODUCT_MONITOR],
    })
    const ids = descendantProductIds(byId.get('b-aoc'))
    expect(ids).toEqual(new Set(['p-monitor']))
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [500, '500 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [1097002, '1.0 MB'],
    [150 * 1024 * 1024, '150 MB'],
  ])('formats %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it('handles null and undefined without throwing', () => {
    expect(formatBytes(null)).toBe('')
    expect(formatBytes(undefined)).toBe('')
  })
})
